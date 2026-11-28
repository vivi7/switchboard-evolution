// project-files-search.js — the Search view of the Files tab, as VS Code's:
// a query with Match Case, Match Whole Word and Use Regular Expression, a
// Replace field, files to include and to exclude, and the results by file.
// A match opens in the tab's editor with its text selected; matches and files
// can be dismissed, replaced one at a time, by file, or all at once.
//
// The search runs in the main process (project-search.js, in a worker) over
// the folder of the tab's current root. Each root keeps its own search; a
// root seen for the first time starts with the query last used in the project.
//
// Depends on project-files-view.js (filesState, filesUi, FICONS,
// openFileInProjectEditor, projectEditors, setFilesSideView, filesKeyHint),
// projects-view.js (PICONS, showContextMenu, showProjectTab, projectViewer),
// file-icons.js (fileIconHtml), text-search.js (TextSearch) and utils.js.

const FILES_SEARCH_DEBOUNCE_MS = 300;
const FILES_SEARCH_PAGE = 2500; // match rows drawn at once; "Show more" draws the next ones
const SEARCH_OPTION_KEYS = ['query', 'replace', 'matchCase', 'wholeWord', 'isRegex', 'preserveCase', 'include', 'exclude', 'showReplace', 'showDetails'];
// Preserve Case, as the editor's find bar draws it (editor/find.mjs).
const PRESERVE_CASE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.6 11.5h-1.2l-.7-2H1.2l-.7 2H-.6L2 3.8h1.1zM3.4 8.4 2.5 5.6l-1 2.8zM7 3.8h2.7c1.6 0 2.4.7 2.4 1.9 0 .8-.4 1.3-1.1 1.6.9.2 1.4.9 1.4 1.8 0 1.5-1 2.4-2.7 2.4H7zm1.1 3.2h1.4c.9 0 1.4-.4 1.4-1.1s-.5-1.1-1.4-1.1H8.1zm0 3.5h1.6c1 0 1.6-.5 1.6-1.3s-.6-1.2-1.6-1.2H8.1z"/><path d="M13 13h3v1h-3z"/></svg>';

const SICONS = {
  caseSensitive: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 12.5h-1.2l-.9-2.6H2.3l-.9 2.6H.2L3.2 4h1.3zm-2.5-3.6L3.9 5.6 2.7 8.9zM14.5 12.5h-1.1v-.8c-.5.6-1 1-1.9 1-1.1 0-1.9-.7-1.9-1.8 0-1.1.8-1.8 2.3-1.9l1.5-.1v-.4c0-.7-.4-1.1-1.2-1.1-.6 0-1.1.2-1.6.6l-.5-.8c.6-.5 1.3-.8 2.2-.8 1.4 0 2.2.7 2.2 2zm-1.1-2.7-1.3.1c-.9.1-1.3.4-1.3.9 0 .6.4.9 1 .9.9 0 1.6-.6 1.6-1.4z"/></svg>`,
  wholeWord: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor"><path d="M0 11h1v2h14v-2h1v3H0z"/><path d="M6.8 10.5h-1v-.6c-.4.5-.9.7-1.6.7-1 0-1.6-.6-1.6-1.4 0-.9.7-1.5 2-1.6l1.2-.1v-.3c0-.6-.3-.9-1-.9-.5 0-.9.2-1.3.5l-.4-.7c.5-.4 1.1-.6 1.8-.6 1.2 0 1.9.6 1.9 1.7zm-1-2.3-1 .1c-.7.1-1.1.3-1.1.8 0 .4.3.7.8.7.8 0 1.3-.5 1.3-1.2zM9 10.5H8V3h1v3.6c.4-.5.9-.8 1.6-.8 1.2 0 2 1 2 2.4 0 1.5-.8 2.5-2.1 2.5-.6 0-1.1-.3-1.5-.8zm0-1.9c0 .7.5 1.3 1.3 1.3s1.3-.6 1.3-1.6-.4-1.6-1.2-1.6S9 7.3 9 8.1z"/></svg>`,
  regex: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 1.5h1v2.3l2-1.2.5.9-2 1.1 2 1.1-.5.9-2-1.2v2.3h-1V5.4l-2 1.2-.5-.9 2-1.1-2-1.1.5-.9 2 1.2zM2 11h3v3H2z"/></svg>`,
  replaceAll: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor"><path d="M11.6 2.7 10.5 1.6l.7-.7 2.3 2.3-2.3 2.3-.7-.7 1.1-1.1H9.5a2 2 0 0 0-2 2v.5h-1v-.5a3 3 0 0 1 3-3zM1 9h6v1H1zm0 2h6v1H1zm0 2h6v1H1zm8-4h6v6H9zm1 1v4h4v-4z"/></svg>`,
  replaceOne: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor"><path d="M11.6 2.7 10.5 1.6l.7-.7 2.3 2.3-2.3 2.3-.7-.7 1.1-1.1H9.5a2 2 0 0 0-2 2v.5h-1v-.5a3 3 0 0 1 3-3zM3 9h4v1H3zm6 0h4v5H9zm1 1v3h2v-3zM3 11h4v1H3zm0 2h4v1H3z"/></svg>`,
};

function filesSearchState(project, root) {
  const state = filesState(project, root);
  if (!state.search) {
    const last = filesUi(project).lastSearch || {};
    state.search = {
      query: '', replace: '', matchCase: false, wholeWord: false, isRegex: false, preserveCase: false,
      include: '', exclude: '', showReplace: false, showDetails: false,
      ...last,
      results: null, error: '', notice: '', running: false, request: 0,
      collapsed: new Set(), shown: FILES_SEARCH_PAGE, timer: null,
    };
    // The query carried over from another folder runs here as soon as the view opens.
    state.search.pending = !!state.search.query;
  }
  return state.search;
}

function searchOptionsOf(s) {
  return { query: s.query, isRegex: s.isRegex, matchCase: s.matchCase, wholeWord: s.wholeWord, preserveCase: !!s.preserveCase, include: s.include, exclude: s.exclude };
}

function rememberSearch(project, s) {
  const last = {};
  for (const key of SEARCH_OPTION_KEYS) last[key] = s[key];
  filesUi(project).lastSearch = last;
}

/** Open the Search view of the Files tab (Find in Folder… gives a folder to include). */
function openFilesSearch(project, { root = null, include = null, replace = false } = {}) {
  const ui = filesUi(project);
  if (root) ui.root = root;
  const s = filesSearchState(project, root || currentFilesRoot(project));
  if (include !== null) {
    s.include = include;
    if (include) s.showDetails = true;
    s.pending = !!s.query;
  }
  if (replace) s.showReplace = true;
  ui.view = 'search';
  s.focusOnRender = true;
  showProjectTab(project, 'files');
}

function focusFilesSearch(body) {
  const input = body.querySelector('.ws-search-input');
  if (!input) return;
  input.focus();
  input.select();
}

function filesSearchHeadHandlers(project, root, body) {
  const s = filesSearchState(project, root);
  const container = () => body.querySelector('#ws-search');
  return {
    'search-refresh': () => runFilesSearch(project, root, container()),
    'search-clear': () => {
      s.query = '';
      s.results = null;
      s.error = '';
      s.notice = '';
      s.request += 1;
      s.running = false;
      rememberSearch(project, s);
      renderFilesSearch(project, root, container());
      focusFilesSearch(body);
    },
    'search-collapse': () => {
      const files = s.results?.files || [];
      // Collapse all, or expand all when everything is collapsed already.
      const all = files.length && files.every(f => s.collapsed.has(f.path));
      s.collapsed = all ? new Set() : new Set(files.map(f => f.path));
      paintSearchResults(project, root, container());
    },
  };
}

function searchToggleHtml(opt, label, icon, on) {
  return `<button type="button" class="ws-search-opt${on ? ' on' : ''}" data-opt="${opt}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" aria-pressed="${on}">${icon}</button>`;
}

function renderFilesSearch(project, root, container) {
  if (!container) return;
  const s = filesSearchState(project, root);
  const mac = window.api.platform === 'darwin';
  const key = (m, o) => (mac ? m : o);
  container.innerHTML = `
    <div class="ws-search-form">
      <button type="button" class="ws-search-replace-toggle" aria-expanded="${s.showReplace}" title="Toggle Replace" aria-label="Toggle Replace">${s.showReplace ? PICONS.chevronDown(12) : PICONS.chevronRight(12)}</button>
      <div class="ws-search-fields">
        <div class="ws-search-box">
          <input type="text" class="ws-search-input" placeholder="Search" aria-label="Search" spellcheck="false" autocomplete="off" value="${escapeHtml(s.query)}">
          <span class="ws-search-opts">
            ${searchToggleHtml('matchCase', `Match Case (${key('⌥⌘C', 'Alt+C')})`, SICONS.caseSensitive(14), s.matchCase)}
            ${searchToggleHtml('wholeWord', `Match Whole Word (${key('⌥⌘W', 'Alt+W')})`, SICONS.wholeWord(14), s.wholeWord)}
            ${searchToggleHtml('isRegex', `Use Regular Expression (${key('⌥⌘R', 'Alt+R')})`, SICONS.regex(14), s.isRegex)}
          </span>
        </div>
        <div class="ws-search-box ws-replace-box"${s.showReplace ? '' : ' hidden'}>
          <input type="text" class="ws-replace-input" placeholder="Replace" aria-label="Replace" spellcheck="false" autocomplete="off" value="${escapeHtml(s.replace)}">
          <span class="ws-search-opts">${searchToggleHtml('preserveCase', `Preserve Case (${key('⌥⌘P', 'Alt+P')})`, PRESERVE_CASE_ICON, !!s.preserveCase)}</span>
          <button type="button" class="ws-search-opt ws-replace-all" title="Replace All (${key('⌥⌘↩', 'Ctrl+Alt+Enter')})" aria-label="Replace All">${SICONS.replaceAll(14)}</button>
        </div>
        <div class="ws-search-details-row">
          <button type="button" class="ws-search-details-toggle${s.showDetails ? ' on' : ''}" aria-expanded="${s.showDetails}" title="Toggle Search Details" aria-label="Toggle Search Details">${FICONS.more(13)}</button>
        </div>
        <div class="ws-search-details"${s.showDetails ? '' : ' hidden'}>
          <label class="ws-search-label">files to include<input type="text" class="ws-search-include" spellcheck="false" autocomplete="off" placeholder="e.g. *.ts, src/**/include" value="${escapeHtml(s.include)}"></label>
          <label class="ws-search-label">files to exclude<input type="text" class="ws-search-exclude" spellcheck="false" autocomplete="off" placeholder="e.g. *.min.js, dist" value="${escapeHtml(s.exclude)}"></label>
        </div>
      </div>
    </div>
    <div class="ws-search-summary" aria-live="polite"></div>
    <div class="ws-search-results" role="tree" aria-label="Search results"></div>`;

  const input = container.querySelector('.ws-search-input');
  const replaceInput = container.querySelector('.ws-replace-input');
  const schedule = (delay = FILES_SEARCH_DEBOUNCE_MS) => {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => runFilesSearch(project, root, container), delay);
  };
  const setOption = (opt) => {
    s[opt] = !s[opt];
    container.querySelectorAll(`.ws-search-opt[data-opt="${opt}"]`).forEach(b => { b.classList.toggle('on', s[opt]); b.setAttribute('aria-pressed', String(s[opt])); });
    rememberSearch(project, s);
    schedule(0);
  };
  const toggleReplace = (show = !s.showReplace) => {
    s.showReplace = show;
    rememberSearch(project, s);
    renderFilesSearch(project, root, container);
    container.querySelector(show ? '.ws-replace-input' : '.ws-search-input')?.focus();
  };
  input.addEventListener('input', () => { s.query = input.value; rememberSearch(project, s); schedule(); });
  replaceInput.addEventListener('input', () => { s.replace = replaceInput.value; rememberSearch(project, s); paintSearchResults(project, root, container); });
  for (const [cls, field] of [['.ws-search-include', 'include'], ['.ws-search-exclude', 'exclude']]) {
    const el = container.querySelector(cls);
    el.addEventListener('input', () => { s[field] = el.value; rememberSearch(project, s); schedule(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); schedule(0); } });
  }
  container.querySelectorAll('.ws-search-opt[data-opt]').forEach(b => { b.onclick = () => setOption(b.dataset.opt); });
  container.querySelector('.ws-search-replace-toggle').onclick = () => toggleReplace();
  container.querySelector('.ws-search-details-toggle').onclick = () => {
    s.showDetails = !s.showDetails;
    rememberSearch(project, s);
    renderFilesSearch(project, root, container);
    if (s.showDetails) container.querySelector('.ws-search-include')?.focus();
  };
  container.querySelector('.ws-replace-all').onclick = () => replaceAllResults(project, root, container);

  // The find widget's shortcuts, in any of the fields.
  container.querySelector('.ws-search-form').addEventListener('keydown', (e) => {
    const mod = mac ? e.metaKey : false;
    const alt = e.altKey;
    const code = e.code;
    if (alt && (mac ? mod : !e.ctrlKey) && code === 'KeyC') { e.preventDefault(); setOption('matchCase'); return; }
    if (alt && (mac ? mod : !e.ctrlKey) && code === 'KeyW') { e.preventDefault(); setOption('wholeWord'); return; }
    if (alt && (mac ? mod : !e.ctrlKey) && code === 'KeyR') { e.preventDefault(); setOption('isRegex'); return; }
    if (alt && (mac ? mod : !e.ctrlKey) && code === 'KeyP') { e.preventDefault(); setOption('preserveCase'); return; }
    if (alt && (mac ? e.metaKey : e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); replaceAllResults(project, root, container); return; }
    if (e.key === 'Enter' && e.target === input) { e.preventDefault(); schedule(0); return; }
    if (e.key === 'ArrowDown' && (e.target === input || e.target === replaceInput)) {
      const first = container.querySelector('.ws-search-results [tabindex="0"]');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });

  paintSearchResults(project, root, container);
  if (s.focusOnRender) {
    s.focusOnRender = false;
    (s.showReplace && s.query ? replaceInput : input).focus();
    if (!s.showReplace || !s.query) input.select();
  }
  if (s.pending) {
    s.pending = false;
    runFilesSearch(project, root, container);
  }
}

async function runFilesSearch(project, root, container) {
  const s = filesSearchState(project, root);
  clearTimeout(s.timer);
  const request = ++s.request;
  s.notice = '';
  if (!s.query) {
    s.results = null;
    s.error = '';
    s.running = false;
    paintSearchResults(project, root, container);
    return;
  }
  // A bad pattern is reported at once, without asking the main process.
  try { TextSearch.buildSearchRegExp(searchOptionsOf(s)); } catch (err) {
    s.results = null;
    s.error = err.message;
    s.running = false;
    paintSearchResults(project, root, container);
    return;
  }
  s.running = true;
  paintSearchSummary(s, container);
  let result;
  try { result = await window.api.searchProjectFiles(root, searchOptionsOf(s)); } catch (err) { result = { ok: false, error: err.message }; }
  if (request !== s.request || result?.cancelled) return;
  s.running = false;
  s.shown = FILES_SEARCH_PAGE;
  if (!result?.ok) {
    s.results = null;
    s.error = result?.error || 'The search failed.';
  } else {
    s.results = result;
    s.error = '';
  }
  // Painted into whichever copy of the view is on screen now.
  const live = container?.isConnected ? container : projectViewer?.querySelector(`#ws-search[data-root="${CSS.escape(root)}"]`);
  if (live) paintSearchResults(project, root, live);
}

function searchCounts(results) {
  const files = results?.files || [];
  return { files: files.length, matches: files.reduce((n, f) => n + f.matches.length, 0) };
}

function paintSearchSummary(s, container) {
  const el = container?.querySelector('.ws-search-summary');
  if (!el) return;
  el.classList.toggle('is-error', !!s.error);
  if (s.running) { el.textContent = 'Searching…'; return; }
  if (s.error) { el.textContent = s.error; return; }
  if (!s.results) { el.textContent = s.notice || ''; return; }
  const { files, matches } = searchCounts(s.results);
  let text = matches
    ? `${matches} result${matches === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`
    : 'No results found. Review your settings for configured exclusions and check your gitignore files.';
  if (s.results.limitHit) text += s.results.timedOut ? ' — the search stopped early, narrow it to see the rest' : ' — more results than shown, narrow the search';
  if (s.notice) text = `${s.notice} ${text}`;
  el.textContent = text;
}

/** The match line as the results show it: a little before, the match, the rest. */
function searchMatchHtml(s, match) {
  let before = match.before.replace(/^\s+/, '');
  if (match.before.length >= 60 && before === match.before) before = '…' + before;
  const after = match.after;
  let middle = `<mark>${escapeHtml(match.text)}</mark>`;
  if (s.showReplace) {
    let value = s.replace;
    try {
      value = TextSearch.replacementFor(searchOptionsOf(s), match.text, s.replace, { line: match.before + match.text + match.after, column: match.before.length });
    } catch {}
    middle = `<del>${escapeHtml(match.text)}</del>${value ? `<ins>${escapeHtml(value)}</ins>` : ''}`;
  }
  return `<span class="ws-search-before">${escapeHtml(before)}</span>${middle}<span class="ws-search-after">${escapeHtml(after)}</span>`;
}

function searchActionButton(act, label, icon) {
  return `<button type="button" class="ws-ghost ws-search-act" data-act="${act}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`;
}

function paintSearchResults(project, root, container) {
  if (!container) return;
  const s = filesSearchState(project, root);
  paintSearchSummary(s, container);
  const list = container.querySelector('.ws-search-results');
  if (!list) return;
  const focusedKey = list.contains(document.activeElement) ? document.activeElement?.dataset?.key : null;
  list.replaceChildren();
  const files = s.results?.files || [];
  let drawn = 0;
  for (const file of files) {
    if (drawn >= s.shown) break;
    const collapsed = s.collapsed.has(file.path);
    const name = pathBasename(file.path);
    const dir = parentRelative(file.path);
    const row = document.createElement('div');
    row.className = 'ws-search-file';
    row.tabIndex = 0;
    row.dataset.key = `f:${file.path}`;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(!collapsed));
    row.title = file.path;
    row.innerHTML = `<span class="ws-file-twistie">${collapsed ? PICONS.chevronRight(12) : PICONS.chevronDown(12)}</span>${fileIconHtml(name)}<span class="ws-search-file-name">${escapeHtml(name)}</span><span class="ws-search-file-dir">${escapeHtml(dir)}</span><span class="ws-search-acts">${s.showReplace ? searchActionButton('replace-file', 'Replace All in File', SICONS.replaceAll(14)) : ''}${searchActionButton('dismiss-file', 'Dismiss', PICONS.x(12))}</span><span class="ws-search-count">${file.matches.length}</span>`;
    const toggle = () => {
      if (s.collapsed.has(file.path)) s.collapsed.delete(file.path); else s.collapsed.add(file.path);
      paintSearchResults(project, root, container);
      list.querySelector(`[data-key="${CSS.escape(`f:${file.path}`)}"]`)?.focus();
    };
    row.onclick = (e) => {
      const act = e.target.closest('.ws-search-act')?.dataset.act;
      if (act === 'dismiss-file') { dismissSearchFile(project, root, container, file); return; }
      if (act === 'replace-file') { replaceSearchMatches(project, root, container, [{ path: file.path, matches: file.matches }]); return; }
      toggle();
    };
    row.onkeydown = (e) => searchResultKey(e, row, { open: toggle, dismiss: () => dismissSearchFile(project, root, container, file), toggle });
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu([
        ...(s.showReplace ? [{ label: 'Replace All in File', icon: SICONS.replaceAll(14), onClick: () => replaceSearchMatches(project, root, container, [{ path: file.path, matches: file.matches }]) }] : []),
        { label: 'Dismiss', icon: PICONS.x(13), onClick: () => dismissSearchFile(project, root, container, file) },
        { sep: true },
        { label: 'Copy Path', onClick: () => window.api.writeClipboard(projectEntryPath(root, file.path)) },
        { label: 'Copy Relative Path', onClick: () => window.api.writeClipboard(file.path) },
      ], { x: e.clientX, y: e.clientY });
    };
    list.appendChild(row);
    if (collapsed) continue;
    for (const match of file.matches) {
      if (drawn >= s.shown) break;
      drawn += 1;
      const item = document.createElement('div');
      item.className = 'ws-search-match';
      item.tabIndex = 0;
      item.dataset.key = `m:${file.path}:${match.line}:${match.column}`;
      item.setAttribute('role', 'treeitem');
      item.title = `${file.path}:${match.line}:${match.column + 1}`;
      item.innerHTML = `<span class="ws-search-line">${searchMatchHtml(s, match)}</span><span class="ws-search-acts">${s.showReplace ? searchActionButton('replace', 'Replace', SICONS.replaceOne(14)) : ''}${searchActionButton('dismiss', 'Dismiss', PICONS.x(12))}</span>`;
      const open = () => openSearchMatch(project, root, file, match, item);
      item.onclick = (e) => {
        const act = e.target.closest('.ws-search-act')?.dataset.act;
        if (act === 'dismiss') { dismissSearchMatch(project, root, container, file, match); return; }
        if (act === 'replace') { replaceSearchMatches(project, root, container, [{ path: file.path, matches: [match] }]); return; }
        open();
      };
      item.onkeydown = (e) => searchResultKey(e, item, { open, dismiss: () => dismissSearchMatch(project, root, container, file, match) });
      list.appendChild(item);
    }
  }
  const total = searchCounts(s.results).matches;
  if (drawn < total && drawn >= s.shown) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ws-search-more';
    more.textContent = `Show ${Math.min(FILES_SEARCH_PAGE, total - drawn)} more results`;
    more.onclick = () => { s.shown += FILES_SEARCH_PAGE; paintSearchResults(project, root, container); };
    list.appendChild(more);
  }
  if (focusedKey) list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
}

function searchResultKey(e, row, { open, dismiss, toggle }) {
  const move = (el) => { if (el) { e.preventDefault(); el.focus(); } };
  if (e.key === 'ArrowDown') return move(row.nextElementSibling?.matches('[tabindex="0"]') ? row.nextElementSibling : null);
  if (e.key === 'ArrowUp') {
    const prev = row.previousElementSibling;
    if (prev) return move(prev);
    e.preventDefault();
    row.closest('.ws-search')?.querySelector('.ws-search-input')?.focus();
    return;
  }
  if (toggle && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); toggle(); return; }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); return; }
  if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); dismiss(); }
}

async function openSearchMatch(project, root, file, match, row) {
  row?.closest('.ws-search-results')?.querySelectorAll('.ws-search-match.selected').forEach(el => el.classList.remove('selected'));
  row?.classList.add('selected');
  await openFileInProjectEditor(project, file.path, { root });
  const ed = projectEditors.get(project.id);
  if (ed?.root === root && ed.rel === file.path) ed.panel.selectRange(match.line, match.column, match.length);
}

function dismissSearchMatch(project, root, container, file, match) {
  const s = filesSearchState(project, root);
  file.matches = file.matches.filter(m => m !== match);
  if (!file.matches.length) s.results.files = s.results.files.filter(f => f !== file);
  paintSearchResults(project, root, container);
}

function dismissSearchFile(project, root, container, file) {
  const s = filesSearchState(project, root);
  s.results.files = s.results.files.filter(f => f !== file);
  paintSearchResults(project, root, container);
}

async function replaceSearchMatches(project, root, container, files) {
  const s = filesSearchState(project, root);
  const options = { ...searchOptionsOf(s), replace: s.replace, files: files.map(f => ({ path: f.path, matches: f.matches.map(({ line, column, length, text }) => ({ line, column, length, text })) })) };
  let result;
  try { result = await window.api.replaceInProjectFiles(root, options); } catch (err) { result = { ok: false, error: err.message }; }
  if (!result?.ok) { alert(result?.error || 'Could not replace.'); return; }
  const skipped = result.skipped?.length ? ` ${result.skipped.length} skipped (${result.skipped.map(x => `${x.path}: ${x.reason}`).slice(0, 3).join('; ')}).` : '';
  await runFilesSearch(project, root, container);
  s.notice = `Replaced ${result.replaced} occurrence${result.replaced === 1 ? '' : 's'} in ${result.files} file${result.files === 1 ? '' : 's'}.${skipped}`;
  const live = container?.isConnected ? container : projectViewer?.querySelector(`#ws-search[data-root="${CSS.escape(root)}"]`);
  paintSearchSummary(s, live);
}

async function replaceAllResults(project, root, container) {
  const s = filesSearchState(project, root);
  if (!s.showReplace) { s.showReplace = true; renderFilesSearch(project, root, container); return; }
  const files = s.results?.files || [];
  const { files: fileCount, matches } = searchCounts(s.results);
  if (!matches) return;
  const what = s.replace ? `with “${s.replace}”` : 'with nothing (they will be deleted)';
  if (!confirm(`Replace ${matches} occurrence${matches === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'} ${what}?`)) return;
  await replaceSearchMatches(project, root, container, files);
}

// ⇧⌘F / Ctrl+Shift+F opens the Search view while the Files tab is on screen,
// ⇧⌘H / Ctrl+Shift+H with Replace, and ⇧⌘E / Ctrl+Shift+E goes back to the Explorer.
document.addEventListener('keydown', (e) => {
  const mod = window.api?.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  if (!mod || !e.shiftKey || e.altKey || !['KeyF', 'KeyH', 'KeyE'].includes(e.code)) return;
  const body = projectViewer?.querySelector('.ws-body--files');
  if (!body?.isConnected || !body.offsetParent) return;
  const project = selectedProject();
  if (!project) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'KeyE') { setFilesSideView(project, body, 'explorer'); body.querySelector('#ws-files-list .ws-file-row')?.focus(); return; }
  const root = currentFilesRoot(project);
  const s = filesSearchState(project, root);
  if (e.code === 'KeyH') s.showReplace = true;
  // The editor's selection, as VS Code takes it, when it is on one line.
  const view = projectEditors.get(project.id)?.panel?.editorView;
  if (view && document.activeElement && view.dom.contains(document.activeElement)) {
    const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    if (sel && !sel.includes('\n')) { s.query = sel; s.pending = true; }
  }
  s.focusOnRender = true;
  if (filesSideView(project) === 'search') {
    renderFilesSearch(project, root, body.querySelector('#ws-search'));
  } else {
    setFilesSideView(project, body, 'search');
  }
}, true);
