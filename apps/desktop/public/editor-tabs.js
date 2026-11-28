// editor-tabs.js — several files open at once in one editor: a bar of tabs over
// one ViewerPanel (viewer-panel.js) for each file, so a file keeps its unsaved
// text, cursor and undo history while another is shown. The open files are
// remembered, and a tab brought back by a restart reads its file when it is
// first shown; its unsaved text comes from the file's draft.
//
// Used by the project page's Files tab (project-files-view.js), the sidebar's
// Files tab (files-view.js) and a session's file panel (file-panel.js). The
// host reads the files; this keeps the tabs. The sidebar's Files tab lists
// what every editor has open, from what they remember, and closes it there.
//
// Depends on globals: viewer-panel.js, fileIconHtml (file-icons.js),
// bindScrollingTabs (projects-view.js), cachedProjectTreeAll (app.js).

/**
 * What each open file's tab says, in the order given ({ filePath, project }).
 * A name only one file has is enough. Files of one name get the folders before
 * it, back to where their paths differ. When they belong to different
 * projects, the project's name comes first, and folders only tell apart the
 * files one project has more than once.
 */
function editorTabLabels(files) {
  const parts = files.map(f => String(f.filePath).split(/[\\/]/).filter(Boolean));
  const projectOf = i => files[i].project || '';
  const nameOf = i => parts[i][parts[i].length - 1] || String(files[i].filePath);
  // The shortest end of path i that no other path of `among` ends with.
  const ending = (i, among) => {
    for (let n = 1; n < parts[i].length; n++) {
      const tail = parts[i].slice(-n).join('/');
      if (among.every(j => j === i || parts[j].slice(-n).join('/') !== tail)) return tail;
    }
    return parts[i].join('/') || nameOf(i);
  };
  const withProject = (i, rest) => (projectOf(i) ? `${projectOf(i)} · ${rest}` : rest);

  const byName = new Map();
  files.forEach((_file, i) => {
    if (!byName.has(nameOf(i))) byName.set(nameOf(i), []);
    byName.get(nameOf(i)).push(i);
  });
  const labels = [];
  for (const group of byName.values()) {
    if (new Set(group.map(projectOf)).size < 2) {
      for (const i of group) labels[i] = ending(i, group);
      continue;
    }
    for (const i of group) {
      labels[i] = projectOf(i)
        ? withProject(i, ending(i, group.filter(j => projectOf(j) === projectOf(i))))
        : ending(i, group);
    }
    // Two projects of one name: the folders tell their files apart.
    const said = group.map(i => labels[i]);
    group.forEach((i, at) => {
      if (said.indexOf(said[at]) !== said.lastIndexOf(said[at])) labels[i] = withProject(i, ending(i, group));
    });
  }
  return labels;
}

/** The name of the project whose folders hold `filePath`, the deepest folder deciding; '' for none. */
function editorProjectName(filePath) {
  const tree = typeof cachedProjectTreeAll !== 'undefined' ? cachedProjectTreeAll : null;
  let name = '';
  let depth = 0;
  for (const project of tree?.projects || []) {
    for (const root of [project.root, ...(project.folders || []).map(folder => folder?.path)]) {
      if (!root || root.length <= depth) continue;
      if (filePath.startsWith(root + '/') || filePath.startsWith(root + '\\')) {
        name = project.name;
        depth = root.length;
      }
    }
  }
  return name;
}

function editorFileName(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || String(filePath || '');
}

/** The files remembered under `storageKey`: [{ path, data, used }]. */
function storedEditorTabs(storageKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return (Array.isArray(saved?.files) ? saved.files : []).filter(file => typeof file?.path === 'string' && file.path);
  } catch { return []; }
}

/** Told to the window when what an editor has open changes (files-view.js). */
function announceEditorTabs() {
  if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent('editor-tabs-changed'));
}

/**
 * Close `filePath` wherever it has a tab: in every editor of this window, after
 * Save / Don't Save / Cancel when it has unsaved changes, and in what the
 * editors not made yet, or in another window, remember under `storageKeys`.
 * False when the user keeps it open.
 */
async function closeFileInEditors(filePath, storageKeys) {
  for (const tabs of [...editorTabsInstances]) {
    const tab = tabs.find(filePath);
    if (tab && !(await tabs.close(tab))) return false;
  }
  const here = new Set([...editorTabsInstances].map(tabs => tabs.storageKey));
  for (const key of storageKeys) {
    const files = storedEditorTabs(key);
    const kept = files.filter(file => file.path !== filePath);
    if (here.has(key) || kept.length === files.length) continue;
    if (kept.length) localStorage.setItem(key, JSON.stringify({ files: kept }));
    else localStorage.removeItem(key);
  }
  announceEditorTabs();
  return true;
}

const editorTabsInstances = new Set();
let editorTabsCount = 0;
let editorTabsDraftsBound = false;

/** A draft written or dropped anywhere: the dot of a tab not read yet follows. */
function bindEditorTabsDrafts() {
  if (editorTabsDraftsBound) return;
  editorTabsDraftsBound = true;
  // A project window's file closed from the main window's list: its tab goes
  // too, unless it holds unsaved changes.
  window.addEventListener('storage', (event) => {
    if (!event.key?.startsWith('editorTabs:project-window:')) return;
    for (const tabs of editorTabsInstances) {
      if (tabs.storageKey !== event.key) continue;
      const kept = new Set(storedEditorTabs(event.key).map(file => file.path));
      for (const tab of [...tabs.tabs]) if (!kept.has(tab.path) && !tabs.isDirty(tab)) tabs.remove(tab);
    }
  });
  window.addEventListener('viewer-drafts-changed', (event) => {
    const { filePath, state } = event.detail || {};
    for (const tabs of editorTabsInstances) {
      const tab = tabs.find(filePath);
      if (!tab || tab.kept === (state === 'dirty')) continue;
      tab.kept = state === 'dirty';
      if (!tab.loaded) tabs.render();
    }
  });
}

class EditorTabs {
  /**
   * @param {HTMLElement} host - Filled with the bar and the editors
   * @param {Object}   opts
   * @param {string}   opts.storageKey  - localStorage key under which the open files are remembered
   * @param {Function} opts.createPanel - (element, tab, panelOptions) => ViewerPanel
   * @param {Function} opts.onSelect    - (tab) => void: the user picked a tab; the host reads its file
   *                                      when it has not yet, then calls activate (default)
   * @param {Function} opts.projectName - (tab) => string, for the labels of files of one name
   * @param {Function} opts.onActivate  - (tab | null) => void, the shown tab changed
   * @param {Function} opts.onEmpty     - () => void, the last tab went
   * @param {Function} opts.onRemove    - (tab) => void, a tab went
   */
  constructor(host, opts = {}) {
    this.opts = opts;
    this.id = ++editorTabsCount;
    this.storageKey = opts.storageKey || null;
    // Go Back and Go Forward step through the files of all the tabs.
    this.history = { back: [], forward: [] };
    this.tabs = []; // { path, data, used, loaded, kept, panel, element, scroll }
    this.active = null;
    this._used = 0;

    this.el = document.createElement('div');
    this.el.className = 'editor-tabs';
    this.bar = document.createElement('div');
    this.bar.className = 'editor-tab-bar';
    this.bar.setAttribute('role', 'tablist');
    this.bar.setAttribute('aria-label', 'Open files');
    this.body = document.createElement('div');
    this.body.className = 'editor-tab-body';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'ws-editor-empty';
    this.emptyEl.textContent = 'Pick a file to read or edit it here.';
    this.body.appendChild(this.emptyEl);
    this.el.appendChild(this.bar);
    this.el.appendChild(this.body);
    host.appendChild(this.el);

    this._restore();
    editorTabsInstances.add(this);
    bindEditorTabsDrafts();
    this.render();
  }

  find(filePath) {
    return this.tabs.find(tab => tab.path === filePath) || null;
  }

  /** The tab used last, or null. */
  lastUsed() {
    return [...this.tabs].sort((a, b) => b.used - a.used)[0] || null;
  }

  /** The file's tab, made after the shown one when it has none yet. Not shown until activate. */
  add(filePath, data = {}) {
    let tab = this.find(filePath);
    if (tab) {
      Object.assign(tab.data, data);
    } else {
      tab = { path: filePath, data: { ...data }, used: 0, loaded: false, kept: false, panel: null, element: null };
      const at = this.tabs.indexOf(this.active);
      this.tabs.splice(at < 0 ? this.tabs.length : at + 1, 0, tab);
    }
    this._persist();
    return tab;
  }

  /** The tab's viewer, made when first needed. */
  panelFor(tab) {
    if (tab.panel) return tab.panel;
    tab.element = document.createElement('div');
    tab.element.className = 'ws-editor-panel editor-tab-panel';
    tab.element.hidden = this.active !== tab;
    if (this.active === tab) this.emptyEl.hidden = true;
    this.body.appendChild(tab.element);
    tab.panel = this.opts.createPanel(tab.element, tab, {
      history: this.history,
      onDirtyChange: () => this.render(),
    });
    return tab.panel;
  }

  /** Put the file's text (or preview) in the tab's viewer, under its name. */
  fill(tab, content, preview = {}) {
    const panel = this.panelFor(tab);
    panel.open(editorFileName(tab.path), tab.path, content, preview);
    tab.loaded = true;
    tab.kept = panel.isDirty();
    return panel;
  }

  activate(tab) {
    if (!this.tabs.includes(tab)) return;
    if (this.active && this.active !== tab) this._saveScroll(this.active);
    const changed = this.active !== tab;
    this.active = tab;
    tab.used = ++this._used;
    for (const other of this.tabs) if (other.element) other.element.hidden = other !== tab;
    this.emptyEl.hidden = !!tab.element;
    if (changed) this._restoreScroll(tab);
    tab.panel?.editorView?.requestMeasure?.();
    this._persist();
    this.render();
    this.opts.onActivate?.(tab);
  }

  /** The user picked a tab. */
  async select(tab) {
    if (this.opts.onSelect) await this.opts.onSelect(tab);
    else this.activate(tab);
  }

  isDirty(tab) {
    return tab.loaded && tab.panel ? tab.panel.isDirty() : tab.kept;
  }

  /** Close a tab, after Save / Don't Save / Cancel when it has unsaved changes. */
  async close(tab) {
    // Unsaved text of a tab not read yet: read first, so the question can be answered.
    if (tab.kept && !tab.loaded) {
      await this.select(tab);
      if (!tab.loaded) return false;
    }
    if (tab.panel && tab.panel.isDirty()) {
      this.activate(tab);
      if (!(await tab.panel.confirmLeave())) return false;
    }
    this.remove(tab);
    return true;
  }

  /** Take a tab away without asking. Its unsaved text stays in the draft, unless `discard`. */
  remove(tab, { discard = false } = {}) {
    const at = this.tabs.indexOf(tab);
    if (at < 0) return;
    this.tabs.splice(at, 1);
    tab.panel?.dispose({ discard });
    tab.element?.remove();
    const wasActive = this.active === tab;
    if (wasActive) {
      this.active = null;
      this.emptyEl.hidden = false;
    }
    this._persist();
    this.render();
    this.opts.onRemove?.(tab);
    if (!this.tabs.length) {
      this.opts.onActivate?.(null);
      this.opts.onEmpty?.();
    } else if (wasActive) {
      this.select(this.tabs[Math.min(at, this.tabs.length - 1)]);
    }
  }

  /** The tab's file was renamed or moved: the tab follows, with what is typed in it. */
  async relocate(tab, filePath, data = {}) {
    tab.path = filePath;
    Object.assign(tab.data, data);
    this._persist();
    if (tab.loaded) await tab.panel.relocate(editorFileName(filePath), filePath);
    this.render();
  }

  /** Every viewer and the bar go; what is unsaved stays in the drafts. */
  destroy() {
    for (const tab of this.tabs) {
      tab.panel?.dispose();
      tab.element?.remove();
    }
    this.tabs = [];
    this.active = null;
    editorTabsInstances.delete(this);
    this.el.remove();
  }

  setStorageKey(storageKey) {
    if (this.storageKey) localStorage.removeItem(this.storageKey);
    this.storageKey = storageKey;
    this._persist();
  }

  render() {
    const scrolled = this.bar.scrollLeft || 0;
    const labels = editorTabLabels(this.tabs.map(tab => ({ filePath: tab.path, project: this.opts.projectName?.(tab) || '' })));
    this.bar.replaceChildren(...this.tabs.map((tab, i) => this._tabElement(tab, labels[i])));
    this.bar.hidden = !this.tabs.length;
    // As the project's tabs: the open one kept in sight, arrows over the end that has more.
    if (typeof bindScrollingTabs === 'function' && this.bar.parentElement) {
      bindScrollingTabs(this.bar, `.editor-tab.editor-tabs-${this.id}.active`, scrolled);
    }
  }

  _tabElement(tab, label) {
    const active = this.active === tab;
    const dirty = this.isDirty(tab);
    const element = document.createElement('div');
    element.className = `editor-tab editor-tabs-${this.id}${active ? ' active' : ''}${dirty ? ' dirty' : ''}`;
    element.setAttribute('role', 'tab');
    element.setAttribute('aria-selected', String(active));
    element.tabIndex = 0;
    element.title = dirty ? `${tab.path}\nUnsaved changes` : tab.path;

    const icon = document.createElement('span');
    icon.className = 'editor-tab-icon';
    if (typeof fileIconHtml === 'function') icon.innerHTML = fileIconHtml(editorFileName(tab.path));
    const text = document.createElement('span');
    text.className = 'editor-tab-label';
    text.textContent = label;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'editor-tab-close';
    close.title = dirty ? 'Close (unsaved changes)' : 'Close';
    close.setAttribute('aria-label', `Close ${label}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      this.close(tab);
    });
    element.appendChild(icon);
    element.appendChild(text);
    element.appendChild(close);

    element.addEventListener('click', () => this.select(tab));
    // The middle button closes, and does not start the browser's scrolling.
    element.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault(); });
    element.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      this.close(tab);
    });
    element.addEventListener('keydown', (event) => {
      if (event.target !== element) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.select(tab); }
      else if (event.key === 'Delete') { event.preventDefault(); this.close(tab); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); element.previousElementSibling?.focus(); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); element.nextElementSibling?.focus(); }
    });
    return element;
  }

  // A hidden editor can lose its scroll position: kept while another tab shows.
  _scrollers(tab) {
    return [tab.panel?.editorView?.scrollDOM, tab.panel?.previewEl].filter(Boolean);
  }

  _saveScroll(tab) {
    tab.scroll = this._scrollers(tab).map(el => [el.scrollTop, el.scrollLeft]);
  }

  _restoreScroll(tab) {
    if (!tab.scroll) return;
    this._scrollers(tab).forEach((el, i) => {
      if (!tab.scroll[i]) return;
      [el.scrollTop, el.scrollLeft] = tab.scroll[i];
    });
  }

  _persist() {
    if (!this.storageKey) return;
    try {
      if (!this.tabs.length) localStorage.removeItem(this.storageKey);
      else localStorage.setItem(this.storageKey, JSON.stringify({ files: this.tabs.map(({ path, data, used }) => ({ path, data, used })) }));
    } catch {}
    announceEditorTabs();
  }

  _restore() {
    if (!this.storageKey) return;
    for (const file of storedEditorTabs(this.storageKey)) {
      if (this.find(file.path)) continue;
      const used = Number(file.used) || 0;
      this._used = Math.max(this._used, used);
      this.tabs.push({
        path: file.path, data: { ...file.data }, used, loaded: false,
        kept: !!window.api.getDraft?.(file.path), panel: null, element: null,
      });
    }
  }
}

window.EditorTabs = EditorTabs;
window.editorTabLabels = editorTabLabels;
window.storedEditorTabs = storedEditorTabs;
window.closeFileInEditors = closeFileInEditors;
