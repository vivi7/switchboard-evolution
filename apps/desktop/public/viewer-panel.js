/**
 * viewer-panel.js — Unified viewer component for CodeMirror-based panels.
 *
 * A single component used by plan viewer, memory viewer, and file panel.
 * Manages toolbar, editor, preview area, and all interactions.
 * Watches files for external changes and reloads automatically.
 *
 * Toolbar buttons are shown/hidden automatically based on file type:
 *   - Preview: shown for markdown, HTML and JSON/JSONC files (JSON opens as a tree)
 *   - Images, PDFs and PowerPoint: read-only previews with text editing controls hidden
 *   - Wrap: shown for text (defaults on for markdown, off for others)
 *   - Save: shown if onSave is provided
 *   - Open in default app: always shown
 *   - Share: macOS share menu, shown while a file is open
 *   - Reveal in Finder/Explorer: shown while a file is open
 *   - Smaller / larger text: always shown for text, just before Preview
 *   - Open in a window of its own: shown if onPopOut is provided
 *   - Close: shown if onClose is provided
 *   - Copy path/content: shown if opted in
 *
 * With `autosaveMs`, an edit is saved that long after the typing stops
 * (the Note's pad); Save and Cmd/Ctrl+S still work as everywhere else.
 *
 * The editor is the app's one editor (createCodeEditor, codemirror-bundle.js).
 * Its find bar (Cmd/Ctrl+F, replace with ⌥⌘F or Ctrl+H), go to line (Ctrl+G)
 * and go to symbol (Cmd/Ctrl+Shift+O) open from the toolbar too, from its
 * Find button, and when no field has the focus (the last viewer used); in a
 * Markdown or JSON preview Cmd/Ctrl+F searches the rendered text. The title
 * shows a dot while there are unsaved changes; a viewer asked to show another
 * file in their place asks about them first (confirmLeave). A change on disk
 * while there are none reloads the text in place, keeping the cursor; with
 * unsaved changes it asks (Reload, Keep Mine, Compare) instead of losing them.
 *
 * Unsaved text is never held by the editor alone: a moment after the typing
 * pauses, and when the window closes, it goes into the file's draft
 * (file-drafts.js), which any viewer opening the file puts back, after a
 * restart too. Viewers of the same file, in this window or another, show the
 * same unsaved text. A save, or Don't Save, drops the draft.
 *
 * Depends on: viewer-toolbar.js, codemirror-bundle.js
 */

// The text size of every editor and Markdown preview, as steps of one pixel
// from their own size. One value for all of them, remembered, and followed by
// every open editor, in this window and in the others.
const VIEWER_FONT_STEP_KEY = 'viewerFontStep';
const VIEWER_FONT_STEP_MIN = -4;
const VIEWER_FONT_STEP_MAX = 12;
const VIEWER_FONT_STEP_EVENT = 'viewer-font-step';

function clampViewerFontStep(step) {
  const n = Math.round(Number(step));
  return Number.isFinite(n) ? Math.min(VIEWER_FONT_STEP_MAX, Math.max(VIEWER_FONT_STEP_MIN, n)) : 0;
}

function readViewerFontStep() {
  try { return clampViewerFontStep(localStorage.getItem(VIEWER_FONT_STEP_KEY) || 0); } catch { return 0; }
}

function setViewerFontStep(step) {
  const value = clampViewerFontStep(step);
  try { localStorage.setItem(VIEWER_FONT_STEP_KEY, String(value)); } catch {}
  window.dispatchEvent(new CustomEvent(VIEWER_FONT_STEP_EVENT, { detail: value }));
}

const IS_MAC_VIEWER = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Which of the editor's keys `e` is, as its find bar takes them
 * (codemirror-bundle.js, editor/find.mjs): find, replace, next, previous,
 * gotoLine, symbol; null for any other key.
 */
function viewerFindKey(e) {
  const key = (e.key || '').toLowerCase();
  const mod = IS_MAC_VIEWER ? e.metaKey : e.ctrlKey;
  const replace = IS_MAC_VIEWER
    ? e.metaKey && e.altKey && !e.ctrlKey && e.code === 'KeyF'
    : e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && key === 'h';
  if (replace) return 'replace';
  if (mod && !e.altKey && !e.shiftKey && key === 'f') return 'find';
  if (key === 'f3' || (IS_MAC_VIEWER && e.metaKey && !e.altKey && !e.ctrlKey && e.code === 'KeyG')) return e.shiftKey ? 'previous' : 'next';
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'g') return 'gotoLine';
  if (mod && e.shiftKey && !e.altKey && key === 'o') return 'symbol';
  return null;
}

function isTypingTarget(el) {
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));
}

// Every viewer of this window, and the one used last: Cmd/Ctrl+F pressed where
// no field has the focus (a row of the sidebar, the page) opens its find bar.
const viewerPanels = new Set();
let lastViewerPanel = null;

// How long after the last edit the draft is written, and the longest it waits
// while the typing goes on.
const VIEWER_DRAFT_DELAY_MS = 300;
const VIEWER_DRAFT_MAX_WAIT_MS = 2000;
// Told to the window when a file's draft is written or dropped (editor-tabs.js, files-view.js).
const VIEWER_DRAFTS_EVENT = 'viewer-drafts-changed';

/**
 * A file's unsaved text was kept, or dropped: this window's viewers of it follow
 * (but `from`, which did it), and whoever lists the drafts is told.
 */
function shareViewerDraft(change, from = null) {
  for (const panel of viewerPanels) if (panel !== from) panel._draftChangedElsewhere(change);
  window.dispatchEvent(new CustomEvent(VIEWER_DRAFTS_EVENT, { detail: change }));
}

/** Whether two texts differ in their line breaks at most. */
function sameViewerText(a, b) {
  return window.cmNormalizeEol ? window.cmNormalizeEol(a, '\n') === window.cmNormalizeEol(b, '\n') : a === b;
}

// One subscription for every viewer of this window: a file changed on disk, its
// unsaved text changed in another window, and the window closing.
let viewerEventsBound = false;

function bindViewerEvents() {
  if (viewerEventsBound) return;
  viewerEventsBound = true;
  window.api.onFileChanged?.((changedPath) => {
    for (const panel of [...viewerPanels]) panel._onFileChanged(changedPath);
  });
  window.api.onDraftChanged?.((change) => {
    for (const panel of [...viewerPanels]) panel._draftChangedElsewhere(change);
    window.dispatchEvent(new CustomEvent(VIEWER_DRAFTS_EVENT, { detail: change }));
  });
  // What is typed goes into the drafts before the window does. One that cannot
  // be written holds the window until main has asked (will-prevent-unload).
  window.addEventListener('beforeunload', (event) => {
    let kept = true;
    for (const panel of viewerPanels) if (!panel._flushDraft()) kept = false;
    if (kept) return;
    event.preventDefault();
    event.returnValue = false;
  });
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  const action = viewerFindKey(e);
  if (!action || isTypingTarget(e.target)) return;
  for (const panel of viewerPanels) if (panel.container.contains(e.target)) return;
  const shown = [...viewerPanels].filter(panel => panel.isShown());
  const panel = shown.includes(lastViewerPanel) ? lastViewerPanel : shown[shown.length - 1];
  if (panel && panel.runFindKey(action, e)) e.preventDefault();
});

class ViewerPanel {
  /**
   * @param {HTMLElement} container - Parent element to render into
   * @param {Object} opts
   * @param {Function}  opts.onSave       - async (filePath, content) => result
   * @param {Function}  opts.onClose      - () => void
   * @param {Function}  opts.onPopOut     - () => void, opens the file in a window of its own
   * @param {number}    opts.autosaveMs   - save this long after the last edit (off when not given)
   * @param {boolean}   opts.copyPath     - Show copy-path button
   * @param {boolean}   opts.copyContent  - Show copy-content button
   * @param {string}    opts.language     - 'markdown' or 'auto' (default 'markdown')
   * @param {string}    opts.storageKey   - localStorage key for preview mode persistence
   * @param {Function}  opts.openFile     - async (filePath, { line, column }) => false | ViewerPanel | void, how
   *                                        the host opens another file (Go to Definition): the panel it opened it
   *                                        in when not this one; false (or none) and this viewer opens it
   * @param {Object}    opts.history      - { back: [], forward: [] }, Go Back's places, shared by a host's tabs
   * @param {Function}  opts.onDirtyChange - (dirty) => void, as unsaved changes come and go
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    // Where Go to Definition came from, for Go Back and Go Forward: { filePath, line, column }.
    this._history = opts.history || { back: [], forward: [] };

    // The draft: whether one is kept for the file shown, its text, and the
    // file's text the edits started from.
    this._draftTimer = null;
    this._draftDue = 0;
    this._draftStored = false;
    this._draftContent = null;
    this._base = null;
    // The text being put in the editor comes from disk or a draft, not the keyboard.
    this._applyingShared = false;
    this._discarded = false;
    // Unsaved text shown for a file that is no longer on disk.
    this._missing = false;
    this._dirtyShown = false;

    // State
    this.filePath = '';
    this.editorView = null;
    this.previewMode = opts.storageKey ? localStorage.getItem(opts.storageKey) === 'true' : false;
    this.wrapMode = false;
    this._watchedPath = null;
    this._saving = false;
    // The text as last read from or written to disk: what an edit differs from.
    this._savedContent = null;
    this._autosaveTimer = null;
    this.previewType = 'text';
    this._objectUrl = null;
    this._openVersion = 0;
    // Expanded nodes in the JSON reader, kept across reloads of the same file.
    this._jsonState = { open: null };

    // Create toolbar — always include preview, wrap, save; visibility managed in open()
    this.toolbar = window.createViewerToolbar({
      copyPath: !!opts.copyPath,
      copyContent: !!opts.copyContent,
      preview: true,
      wrap: true,
      find: true,
      gotoLine: true,
      save: !!opts.onSave,
      openExternal: true,
      share: window.api.platform === 'darwin',
      reveal: true,
      fontSize: true,
      popOut: !!opts.onPopOut,
      close: !!opts.onClose,
    });
    container.insertBefore(this.toolbar.el, container.firstChild);

    // Hide preview initially (shown in open() if markdown)
    if (this.toolbar.previewBtn) this.toolbar.previewBtn.style.display = 'none';

    // Create editor area
    this.editorEl = document.createElement('div');
    this.editorEl.className = 'viewer-panel-editor';
    container.appendChild(this.editorEl);

    // Where the find bar of the preview sits: over the top of the preview.
    this.previewFindHost = document.createElement('div');
    this.previewFindHost.className = 'viewer-find-anchor';
    container.appendChild(this.previewFindHost);
    this._previewFindBar = null;

    // Create preview area
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'markdown-preview';
    this.previewEl.style.display = 'none';
    // A click in the preview gives it the focus, so that its keys (Cmd/Ctrl+F) reach this panel.
    this.previewEl.tabIndex = -1;
    container.appendChild(this.previewEl);

    // Wire toolbar events
    this._wireEvents();

    this._applyFontStep(readViewerFontStep());
    this._onFontStep = (e) => this._applyFontStep(e.detail);
    window.addEventListener(VIEWER_FONT_STEP_EVENT, this._onFontStep);
    // Another window changed it (localStorage is shared by the app's windows).
    this._onStorage = (e) => {
      if (e.key === VIEWER_FONT_STEP_KEY) this._applyFontStep(readViewerFontStep());
    };
    window.addEventListener('storage', this._onStorage);

    // Listen for Cmd/Ctrl+S from CM editors
    container.addEventListener('cm-save', () => this._save());

    // The editor's keys from the toolbar and the preview; this panel as the last one used.
    container.addEventListener('keydown', (e) => this._onKeyDown(e));
    container.addEventListener('focusin', () => { lastViewerPanel = this; });
    viewerPanels.add(this);

    bindViewerEvents();
  }

  /** The file changed on disk (main process). */
  _onFileChanged(changedPath) {
    if (changedPath === this._watchedPath && !this._saving) this._reloadFromDisk();
  }

  _wireEvents() {
    const { toolbar, opts } = this;

    if (toolbar.previewBtn) {
      toolbar.previewBtn.addEventListener('click', () => this._togglePreview());
    }

    if (toolbar.wrapBtn) {
      toolbar.wrapBtn.addEventListener('click', () => this._toggleWrap());
    }

    if (toolbar.findBtn) {
      toolbar.findBtn.addEventListener('click', () => this.openFind());
    }

    if (toolbar.gotoLineBtn) {
      toolbar.gotoLineBtn.addEventListener('click', () => {
        if (this.previewMode) this._setPreview(false);
        if (this.editorView && window.cmOpenGotoLine) {
          window.cmOpenGotoLine(this.editorView);
        }
      });
    }

    if (toolbar.saveBtn && opts.onSave) {
      toolbar.saveBtn.addEventListener('click', () => this._save());
    }

    if (toolbar.openExternalBtn) {
      toolbar.openExternalBtn.addEventListener('click', () => this._openExternally());
    }

    if (toolbar.shareBtn) {
      toolbar.shareBtn.addEventListener('click', () => this._share());
    }

    if (toolbar.revealBtn) {
      toolbar.revealBtn.addEventListener('click', () => {
        if (this.filePath) window.api.revealFile(this.filePath);
      });
    }

    if (toolbar.fontSmallerBtn) {
      toolbar.fontSmallerBtn.addEventListener('click', () => setViewerFontStep(readViewerFontStep() - 1));
    }

    if (toolbar.fontLargerBtn) {
      toolbar.fontLargerBtn.addEventListener('click', () => setViewerFontStep(readViewerFontStep() + 1));
    }

    if (toolbar.popOutBtn && opts.onPopOut) {
      toolbar.popOutBtn.addEventListener('click', () => opts.onPopOut());
    }

    if (toolbar.closeBtn && opts.onClose) {
      toolbar.closeBtn.addEventListener('click', async () => {
        if (await this.confirmLeave()) opts.onClose();
      });
    }

    if (toolbar.copyPathBtn) {
      toolbar.copyPathBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(this.filePath);
        toolbar.flashCopyPath();
      });
    }

    if (toolbar.copyContentBtn) {
      toolbar.copyContentBtn.addEventListener('click', () => {
        const content = this.getContent();
        navigator.clipboard.writeText(content);
        toolbar.flashCopyContent();
      });
    }
  }

  /** Size the editor's text and the preview's: a step of one pixel from their own size. */
  _applyFontStep(step) {
    const value = clampViewerFontStep(step);
    this.container.style.setProperty('--viewer-font-step', String(value));
    const { fontSmallerBtn, fontLargerBtn } = this.toolbar;
    if (fontSmallerBtn) fontSmallerBtn.disabled = value <= VIEWER_FONT_STEP_MIN;
    if (fontLargerBtn) fontLargerBtn.disabled = value >= VIEWER_FONT_STEP_MAX;
    // CodeMirror measures its lines again for the new size.
    if (this.editorView) this.editorView.requestMeasure();
  }

  /**
   * Open a file in the viewer. `preview.fresh`: the text given replaces what is
   * typed (a save that changed the file). `preview.missing`: the file is gone
   * and `content` is what its kept draft started from.
   */
  open(title, filePath, content = '', preview = {}) {
    // What was typed in the file shown is kept before it goes.
    if (!preview.fresh) this._flushDraft();
    clearTimeout(this._draftTimer);
    this._draftStored = false;
    this._draftContent = null;
    this._discarded = false;
    this._base = null;
    this._missing = !!preview.missing;
    this._hideNotice();
    this._unwatchFile();
    this._clearPreview();
    this._hideConflict();
    this._openVersion++;
    lastViewerPanel = this;

    const previousPath = this.filePath;
    this.filePath = filePath;
    if (previousPath !== filePath) this._jsonState = { open: null };
    this.previewUrl = preview.previewUrl || '';
    this.previewType = preview.previewType || (/\.html?$/i.test(filePath) ? 'html' : 'text');
    this.toolbar.setTitle(title);
    this.toolbar.setPath(filePath);
    if (this.toolbar.shareBtn) this.toolbar.shareBtn.style.display = filePath ? '' : 'none';
    if (this.toolbar.revealBtn) this.toolbar.revealBtn.style.display = filePath ? '' : 'none';

    const isMd = this._isMarkdown(filePath);
    const isJson = this._isJson(filePath);
    const isMedia = this._isMedia();
    const isHtml = this.previewType === 'html';

    // Show/hide preview button based on file type
    if (this.toolbar.previewBtn) {
      this.toolbar.previewBtn.style.display = !isMedia && (isMd || isHtml || isJson) ? '' : 'none';
    }
    for (const key of ['wrapBtn', 'findBtn', 'gotoLineBtn', 'saveBtn', 'copyContentBtn', 'fontSmallerBtn', 'fontLargerBtn']) {
      if (this.toolbar[key]) this.toolbar[key].style.display = isMedia ? 'none' : '';
    }

    // Save preview preference before resetting
    // JSON opens in the reader unless this viewer was last switched to editing it.
    const jsonKey = this._jsonPreviewKey();
    const wantPreview = isHtml || (isMd && this.opts.storageKey && localStorage.getItem(this.opts.storageKey) === 'true')
      || (isJson && (!jsonKey || localStorage.getItem(jsonKey) !== 'false'));

    // Reset to edit mode before updating content (without touching localStorage)
    this.editorEl.style.display = isMedia ? 'none' : '';
    this.previewMode = false;
    this.toolbar.setPreviewMode(false);
    if (this.toolbar.previewBtn) {
      this.toolbar.previewBtn.title = this._previewLabel();
      this.toolbar.previewBtn.setAttribute('aria-label', this.toolbar.previewBtn.title);
      this.toolbar.previewBtn.setAttribute('aria-pressed', 'false');
    }

    // Recreate when changing files so language, undo history and search state
    // cannot leak from the previous file into this one.
    if (this.editorView && (previousPath !== filePath || isMedia)) {
      this._destroyEditor();
    }
    this.wrapMode = isMd;
    if (isMedia) {
      const bytes = Uint8Array.from(atob(preview.base64 || ''), char => char.charCodeAt(0));
      if (this.previewType === 'pptx') this._presentationBytes = bytes;
      else this._objectUrl = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType }));
      this.previewMode = true;
      this._renderPreview();
      this._watchFile(filePath);
      return;
    }

    // Create or update editor
    clearTimeout(this._autosaveTimer);
    this._savedContent = content;
    if (!this.editorView) {
      this._createEditor(content, filePath);
    } else {
      this._setEditorText(content);
    }
    // What an edit differs from: the text as the editor gives it back (its
    // line breaks made one kind), so a file of mixed line breaks is not
    // "changed" before anything is typed.
    this._savedContent = this.getContent();
    this._base = this._savedContent;
    this._updateDirty();
    if (!preview.fresh) this._restoreDraft();
    if (this._missing) this._showNotice('This file is no longer on disk. Save writes it again.');

    // Set wrap default based on file type
    this.wrapMode = isMd;
    this.toolbar.setWrapMode(this.wrapMode);
    if (this.editorView && this.editorView._wrapCompartment) {
      this.editorView.dispatch({
        effects: this.editorView._wrapCompartment.reconfigure(
          this.wrapMode ? window.CMEditorView.lineWrapping : []
        ),
      });
    }

    // Re-apply preview preference
    if (wantPreview) {
      this._setPreview(true);
    }

    // Watch for external changes
    this._watchFile(filePath);
    if (preview.line) this.goToLocation(preview.line, preview.column);
  }

  // ── Go to Definition, Go Back, Go Forward ───────────────────────────

  /** What the editor calls to open another file here and to step back and forth. */
  _editorHooks() {
    return {
      openLocation: (filePath, at = {}) => this._openLocation(filePath, at),
      remember: () => this._remember(),
      back: () => this._step(this._history.back, this._history.forward),
      forward: () => this._step(this._history.forward, this._history.back),
    };
  }

  /** Where the cursor is now: { filePath, line, column } (1-based). */
  _here() {
    if (!this.editorView || !this.filePath) return null;
    const state = this.editorView.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { filePath: this.filePath, line: line.number, column: head - line.from + 1 };
  }

  /** Before a jump: here goes on the Back list, and Forward is forgotten. */
  _remember() {
    const here = this._here();
    if (!here) return;
    const { back, forward } = this._history;
    const last = back[back.length - 1];
    if (!last || last.filePath !== here.filePath || last.line !== here.line) back.push(here);
    if (back.length > 50) back.shift();
    forward.length = 0;
  }

  _step(from, to) {
    const place = from.pop();
    if (!place) return false;
    const here = this._here();
    if (here) to.push(here);
    this._openLocation(place.filePath, place);
    return true;
  }

  /** Open `filePath` at { line, column }: the host's way when it has one, else in this viewer. */
  async _openLocation(filePath, { line, column } = {}) {
    if (filePath === this.filePath) {
      this.goToLocation(line || 1, column || 1);
      this.editorView?.focus();
      return this.editorView;
    }
    if (this.opts.openFile) {
      const opened = await this.opts.openFile(filePath, { line, column });
      if (opened !== false) {
        // Shown here, or in the panel (a tab) the host answers with.
        const panel = opened?.filePath !== undefined ? opened : this;
        if (panel.filePath !== filePath) return null;
        // The keys (Go Back, F12 again) go on in the file just opened.
        panel.editorView?.focus();
        return panel.editorView;
      }
    }
    return this.openHere(filePath, { line, column });
  }

  /** Open `filePath` in this viewer, at { line, column }, after Save / Don't Save for unsaved changes. */
  async openHere(filePath, { line, column } = {}) {
    if (!(await this.confirmLeave())) return null;
    let result;
    try { result = await window.api.readFileForPanel(filePath); } catch (err) { result = { ok: false, error: err.message }; }
    if (!result?.ok || typeof result.content !== 'string') {
      alert(result?.error || `Could not open ${filePath}`);
      return null;
    }
    this.open(filePath.split(/[\\/]/).pop(), filePath, result.content, { line, column });
    this.editorView?.focus();
    return this.editorView;
  }

  goToLocation(line, column = 1) {
    if (!this.editorView || !Number.isSafeInteger(line) || line < 1) return;
    const doc = this.editorView.state.doc;
    const target = doc.line(Math.min(line, doc.lines));
    const offset = Number.isSafeInteger(column) ? Math.max(0, Math.min(column - 1, target.length)) : 0;
    if (this.previewMode) this._setPreview(false);
    this.editorView.dispatch({ selection: { anchor: target.from + offset }, scrollIntoView: true });
  }

  /** Select `length` characters at a 1-based line and 0-based column, centred in view (a search match). */
  selectRange(line, column, length) {
    if (!this.editorView || !Number.isSafeInteger(line) || line < 1) return;
    if (this.previewMode) this._setPreview(false);
    const doc = this.editorView.state.doc;
    const target = doc.line(Math.min(line, doc.lines));
    const from = target.from + Math.max(0, Math.min(Number(column) || 0, target.length));
    const to = Math.min(target.to, from + Math.max(0, Number(length) || 0));
    const effects = window.CMEditorView?.scrollIntoView ? [window.CMEditorView.scrollIntoView(from, { y: 'center' })] : [];
    this.editorView.dispatch({ selection: { anchor: from, head: to }, effects, scrollIntoView: !effects.length });
  }

  _createEditor(content, filePath) {
    const onChange = () => this._edited();
    if (window.createCodeEditor) {
      this.editorView = window.createCodeEditor(this.editorEl, {
        doc: content,
        filename: filePath,
        language: this.opts.language === 'auto' ? 'auto' : 'markdown',
        wrap: this.wrapMode,
        onChange,
        // A file on disk: its language server and Go to Definition, which opens other files here.
        file: /^(\/|[A-Za-z]:[\\/])/.test(filePath || '') ? filePath : null,
        hooks: this._editorHooks(),
      });
    } else if (this.opts.language === 'auto') {
      this.editorView = window.createEditableViewer(
        this.editorEl, content, filePath, { wrap: this.wrapMode, onChange },
      );
    } else {
      this.editorView = window.createPlanEditor(this.editorEl, { onChange });
      if (content) {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
        });
      }
    }
  }

  /** The text differs from what is on disk. */
  isDirty() {
    return !!this.editorView && !!this.filePath && this._savedContent !== null
      && (this._missing || this.getContent() !== this._savedContent);
  }

  /** The editor's text replaced with `content`, changing only what differs (the cursor stays). */
  _setEditorText(content) {
    if (!this.editorView) return;
    if (window.cmSetText) window.cmSetText(this.editorView, content);
    else this.editorView.dispatch({ changes: { from: 0, to: this.editorView.state.doc.length, insert: content } });
  }

  /** The title's dot follows whether there are unsaved changes. */
  _updateDirty() {
    const dirty = this.isDirty();
    if (this.toolbar.setDirty) this.toolbar.setDirty(dirty);
    if (dirty === this._dirtyShown) return;
    this._dirtyShown = dirty;
    this.opts.onDirtyChange?.(dirty);
  }

  /**
   * Before this viewer shows another file or closes: with unsaved changes,
   * ask whether to save them (Save, Don't Save, Cancel). Resolves to false
   * when the user cancels, true when it can go on. An autosaving viewer saves.
   */
  async confirmLeave() {
    if (!this.isDirty()) return true;
    if (this.opts.autosaveMs) { await this.flush(); return true; }
    if (!this.opts.onSave || !window.api.confirmUnsavedChanges) return true;
    const name = this.toolbar.titleEl.textContent || this.filePath.split(/[\\/]/).pop();
    const choice = await window.api.confirmUnsavedChanges(name);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      await this._save({ quiet: true });
      return !this.isDirty();
    }
    this.discardDraft();
    return true;
  }

  /** Whether this viewer is on screen with a text or a preview in it. */
  isShown() {
    return this.container.isConnected && this.container.getClientRects().length > 0 && !!this.filePath;
  }

  /** Cmd/Ctrl+F: the find bar of the editor, or of the preview while a Markdown or JSON preview is shown. */
  openFind({ replace = false } = {}) {
    if (this._isMedia()) return false;
    if (this.previewMode) {
      if (!replace && this._canFindInPreview()) {
        this._previewFind().open();
        return true;
      }
      this._setPreview(false);
    }
    if (!this.editorView || !window.cmOpenSearch) return false;
    return window.cmOpenSearch(this.editorView, { replace });
  }

  _canFindInPreview() {
    return this.previewMode && !this._isMedia() && this.previewType !== 'html' && !!window.cmCreatePreviewFind;
  }

  _previewFind() {
    if (!this._previewFindBar) {
      this._previewFindBar = window.cmCreatePreviewFind(this.previewFindHost, this.previewEl, {
        onReplaceInSource: () => this.openFind({ replace: true }),
      });
    }
    return this._previewFindBar;
  }

  /** One of the editor's keys (viewerFindKey), pressed outside its text: true when it did something. */
  runFindKey(action, event) {
    if (this.previewMode) {
      if (action === 'find' || action === 'replace') return this.openFind({ replace: action === 'replace' });
      if ((action === 'next' || action === 'previous') && this._canFindInPreview()) {
        this._previewFind().findNext(action === 'next' ? 1 : -1);
        return true;
      }
      if (action === 'gotoLine' || action === 'symbol') this._setPreview(false);
      else return false;
    }
    if (!this.editorView) return false;
    if (action === 'find' || action === 'replace') return this.openFind({ replace: action === 'replace' });
    return !!(window.cmRunEditorKeys && window.cmRunEditorKeys(this.editorView, event));
  }

  /** Keys on the toolbar or the preview (the editor and its bars take their own). */
  _onKeyDown(e) {
    if (e.defaultPrevented) return;
    if (this.editorView && this.editorView.dom.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.terminal-search-bar, .cm-symbol-picker, .viewer-conflict-bar')) return;
    if (isTypingTarget(e.target)) return;
    const mod = IS_MAC_VIEWER ? e.metaKey : e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key || '').toLowerCase() === 's' && this.editorView) {
      e.preventDefault();
      this._save();
      return;
    }
    const action = viewerFindKey(e);
    if (action && this.runFindKey(action, e)) e.preventDefault();
  }

  /** After an edit: keep the draft; with autosave, save once the typing has stopped. */
  _edited() {
    this._updateDirty();
    if (this._applyingShared) return;
    this._discarded = false;
    if (this._draftsOn()) {
      clearTimeout(this._draftTimer);
      this._draftDue ||= Date.now() + VIEWER_DRAFT_MAX_WAIT_MS;
      const wait = Math.max(0, Math.min(VIEWER_DRAFT_DELAY_MS, this._draftDue - Date.now()));
      this._draftTimer = setTimeout(() => this._flushDraft(), wait);
    }
    if (!this.opts.autosaveMs || !this.opts.onSave) return;
    clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => {
      if (this.isDirty()) this._save({ quiet: true });
    }, this.opts.autosaveMs);
  }

  /** Save now what is not saved yet (closing, moving to a window): resolves when it is written. */
  async flush() {
    clearTimeout(this._autosaveTimer);
    if (this.isDirty()) await this._save({ quiet: true });
  }

  // ── Drafts: unsaved text kept until it is saved or dropped ─────────

  _draftsOn() {
    return !!(this.opts.onSave && window.api.setDraft && this.editorView && this.filePath) && !this._isMedia();
  }

  /** The unsaved text kept for this file, put back in the editor. */
  _restoreDraft() {
    if (!this._draftsOn()) return;
    const draft = window.api.getDraft?.(this.filePath);
    if (typeof draft?.content !== 'string') return;
    const disk = this._savedContent;
    this._draftStored = true;
    if (!this._missing && sameViewerText(draft.content, disk)) {
      this._dropDraft();
      return;
    }
    this._applyShared(draft.content);
    this._draftContent = this.getContent();
    this._base = typeof draft.base === 'string' ? draft.base : disk;
    this._updateDirty();
    // The file moved on since the edits began: asked, as for a change on disk.
    if (!this._missing && !sameViewerText(this._base, disk)) this._showConflict(disk);
    if (this.opts.autosaveMs) this._edited();
  }

  /** Write what is unsaved to the draft now, or drop the draft when nothing is. False when it could not be written. */
  _flushDraft() {
    clearTimeout(this._draftTimer);
    this._draftDue = 0;
    if (this._discarded || !this._draftsOn() || this._savedContent === null) return true;
    if (!this.isDirty()) {
      this._dropDraft();
      return true;
    }
    const content = this.getContent();
    if (this._draftStored && content === this._draftContent) return true;
    const draft = { content, base: this._base ?? this._savedContent };
    const result = window.api.setDraft(this.filePath, draft);
    if (!result?.ok) {
      this._draftContent = null;
      this._showNotice(`Switchboard could not keep a copy of your unsaved changes (${result?.error || 'unknown error'}). Save the file.`);
      return false;
    }
    if (!this._missing) this._hideNotice();
    this._draftStored = true;
    this._draftContent = content;
    this._shareDraft({ filePath: this.filePath, state: 'dirty', ...draft });
    return true;
  }

  _dropDraft() {
    if (!this._draftStored) return;
    this._draftStored = false;
    this._draftContent = null;
    const change = { filePath: this.filePath, state: 'clean', content: this._savedContent };
    window.api.removeDraft?.(this.filePath, change);
    this._shareDraft(change);
  }

  /** Don't Save: the draft goes, and is not written again unless something more is typed. */
  discardDraft() {
    clearTimeout(this._draftTimer);
    this._discarded = true;
    this._dropDraft();
  }

  /** The other viewers of the file in this window follow (main tells the other windows). */
  _shareDraft(change) {
    shareViewerDraft(change, this);
  }

  /** The file's unsaved text changed, or went, in another viewer: this one follows. */
  _draftChangedElsewhere({ filePath, state, content, base } = {}) {
    if (filePath !== this.filePath || typeof content !== 'string' || !this._draftsOn()) return;
    clearTimeout(this._draftTimer);
    this._applyShared(content);
    this._draftStored = state === 'dirty';
    if (state === 'dirty') {
      this._draftContent = this.getContent();
      this._base = base ?? this._base;
    } else {
      this._draftContent = null;
      this._savedContent = this.getContent();
      this._base = this._savedContent;
      this._missing = false;
      this._hideConflict();
      this._hideNotice();
    }
    this._updateDirty();
    if (this.previewMode) this._renderPreview();
  }

  /** Put text in the editor that was not typed here: no draft, no autosave for it. */
  _applyShared(content) {
    this._applyingShared = true;
    try { this._setEditorText(content); } finally { this._applyingShared = false; }
  }

  _showNotice(text) {
    if (!this.noticeEl) {
      const bar = document.createElement('div');
      bar.className = 'viewer-conflict-bar viewer-notice-bar';
      bar.setAttribute('role', 'alert');
      this.toolbar.el.after(bar);
      this.noticeEl = bar;
    }
    this.noticeEl.textContent = text;
    this.noticeEl.hidden = false;
  }

  _hideNotice() {
    if (this.noticeEl) this.noticeEl.hidden = true;
  }

  _togglePreview() {
    if (this._isMedia() || (!this._isMarkdown(this.filePath) && !this._isJson(this.filePath) && this.previewType !== 'html')) return;
    if (this.previewMode && this._previewFindBar) this._previewFindBar.close({ focus: false });
    this.previewMode = !this.previewMode;
    if (this.previewMode) this._renderPreview();
    else this._clearPreview();
    this.editorEl.style.display = this.previewMode ? 'none' : '';
    this.toolbar.setPreviewMode(this.previewMode);
    const label = this._previewLabel();
    this.toolbar.previewBtn.title = label;
    this.toolbar.previewBtn.setAttribute('aria-label', label);
    this.toolbar.previewBtn.setAttribute('aria-pressed', String(this.previewMode));
    if (this._isMarkdown(this.filePath) && this.opts.storageKey) {
      localStorage.setItem(this.opts.storageKey, String(this.previewMode));
    } else if (this._isJson(this.filePath) && this._jsonPreviewKey()) {
      localStorage.setItem(this._jsonPreviewKey(), String(this.previewMode));
    }
  }

  _isMedia() {
    return ['image', 'pdf', 'pptx'].includes(this.previewType);
  }

  _renderPreview() {
    this.previewEl.replaceChildren();
    if (this.previewType === 'pptx') {
      this.previewEl.className = 'viewer-media-preview';
      this.previewEl.style.display = 'block';
      const frame = document.createElement('iframe');
      frame.className = 'viewer-preview-frame';
      frame.title = `PowerPoint preview: ${this.filePath.split(/[\\/]/).pop()}`;
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.referrerPolicy = 'no-referrer';
      const bytes = this._presentationBytes;
      const version = this._openVersion;
      this._presentationBytes = null;
      frame.addEventListener('load', () => {
        if (version !== this._openVersion || !frame.contentWindow) return;
        // The sandbox has an opaque origin, so postMessage needs '*'. The
        // destination is this exact frame, and only deck bytes are shared.
        frame.contentWindow.postMessage({ type: 'switchboard-pptx', buffer: bytes.buffer }, '*', [bytes.buffer]);
      }, { once: true });
      frame.src = this.previewUrl;
      this.previewEl.appendChild(frame);
    } else if (this.previewType === 'image') {
      this.previewEl.className = 'viewer-media-preview viewer-media-preview--image';
      this.previewEl.style.display = 'flex';
      const img = document.createElement('img');
      img.alt = this.filePath.split(/[\\/]/).pop();
      img.onerror = () => {
        const error = document.createElement('div');
        error.className = 'viewer-preview-error';
        error.textContent = 'This image could not be displayed. The file may be damaged or use an unsupported image format.';
        this.previewEl.replaceChildren(error);
      };
      img.src = this._objectUrl;
      this.previewEl.appendChild(img);
    } else if (this.previewType === 'pdf' || this.previewType === 'html') {
      this.previewEl.className = 'viewer-media-preview';
      this.previewEl.style.display = 'block';
      const frame = document.createElement('iframe');
      frame.className = 'viewer-preview-frame';
      frame.title = `${this.previewType === 'pdf' ? 'PDF' : 'HTML'} preview: ${this.filePath.split(/[\\/]/).pop()}`;
      if (this.previewType === 'pdf') {
        // Chromium's built-in PDF viewer provides zoom, page navigation and print.
        frame.src = this._objectUrl;
      } else {
        // Scripts run with an opaque origin: no parent DOM, app APIs or
        // shared storage. Never combine allow-scripts with allow-same-origin.
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.referrerPolicy = 'no-referrer';
        const doc = new DOMParser().parseFromString(this.getContent(), 'text/html');
        const policy = doc.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        // Only the current asset scope can be fetched. No file:// reads or
        // connections to local app services; CDN scripts/images still work.
        const assetOrigin = /^switchboard-preview:\/\/[a-f0-9]+\//.exec(this.previewUrl)?.[0] || '';
        policy.content = `default-src 'none'; script-src 'unsafe-inline' ${assetOrigin} https: http:; img-src ${assetOrigin} data: blob: https: http:; style-src 'unsafe-inline' ${assetOrigin} https: http:; font-src ${assetOrigin} data: https: http:; connect-src ${assetOrigin || "'none'"}; base-uri ${assetOrigin || "'none'"}; form-action 'none'`;
        if (assetOrigin) {
          const base = doc.createElement('base');
          base.href = this.previewUrl;
          doc.head.prepend(base);
        }
        doc.head.prepend(policy);
        frame.srcdoc = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
      }
      this.previewEl.appendChild(frame);
    } else if (this._isJson(this.filePath)) {
      this.previewEl.className = 'json-reader';
      this.previewEl.style.display = 'block';
      this._renderJson();
    } else {
      this.previewEl.className = 'markdown-preview';
      this.previewEl.style.display = 'block';
      this.previewEl.innerHTML = window.marked.parse(this.getContent());
    }
    // The text was drawn again: an open find bar searches it again.
    if (this._previewFindBar) this._previewFindBar.refresh();
  }

  /** The tree from the live buffer, or where the file breaks and a way to get there. */
  _renderJson() {
    const parsed = window.JsonReader.parseJsonForReader(this.getContent(), { comments: /\.jsonc$/i.test(this.filePath) });
    if (parsed.ok) {
      window.JsonReader.renderTree(this.previewEl, parsed.root, this._jsonState);
      return;
    }
    const error = document.createElement('div');
    error.className = 'json-reader-error';
    const message = document.createElement('div');
    message.textContent = `This file is not valid JSON: ${parsed.message} (line ${parsed.line}, column ${parsed.column}).`;
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'json-reader-jump';
    jump.textContent = 'Show in editor';
    jump.addEventListener('click', () => {
      // Going to fix one broken file is not a choice to stop reading JSON as a tree.
      const key = this._jsonPreviewKey();
      const saved = key ? localStorage.getItem(key) : null;
      this.goToLocation(parsed.line, parsed.column);
      if (key) {
        if (saved === null) localStorage.removeItem(key);
        else localStorage.setItem(key, saved);
      }
    });
    error.appendChild(message);
    error.appendChild(jump);
    this.previewEl.appendChild(error);
  }

  _clearPreview() {
    if (this._previewFindBar) this._previewFindBar.close({ focus: false });
    this.previewEl.replaceChildren();
    this.previewEl.style.display = 'none';
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = null;
    this._presentationBytes = null;
  }

  _setPreview(show) {
    if (this.previewMode === show) return;
    this._togglePreview();
  }

  _toggleWrap() {
    if (!this.editorView || !this.editorView._wrapCompartment) return;
    this.wrapMode = !this.wrapMode;
    this.editorView.dispatch({
      effects: this.editorView._wrapCompartment.reconfigure(
        this.wrapMode ? window.CMEditorView.lineWrapping : []
      ),
    });
    this.toolbar.setWrapMode(this.wrapMode);
  }

  async _save({ quiet = false } = {}) {
    if (!this.opts.onSave || !this.filePath || this._isMedia()) return;
    clearTimeout(this._autosaveTimer);
    this._saving = true;
    const content = this.getContent();
    const filePath = this.filePath;
    const version = this._openVersion;
    const kept = this._draftStored;
    try {
      const result = await (this._missing
        ? this.opts.onSave(filePath, content, { create: true })
        : this.opts.onSave(filePath, content));
      if (result && result.ok !== false) {
        if (this.filePath === filePath) {
          // A host that opened other text while saving (the project's brief) set what is saved.
          if (version === this._openVersion && typeof this._savedContent === 'string') {
            this._savedContent = content;
            this._missing = false;
            this._hideNotice();
          }
          this._base = this._savedContent;
          // What was on disk has been replaced: the question about it is answered.
          this._hideConflict();
        }
        this._updateDirty();
        this._settleDraft(filePath, kept);
        // An autosave says nothing: the button flashing every few seconds would only distract.
        if (!quiet) this.toolbar.flashSave();
      }
    } finally {
      setTimeout(() => { this._saving = false; }, 500);
    }
  }

  /** After a save: nothing is kept for what is on disk; text typed meanwhile stays kept. */
  _settleDraft(filePath, kept) {
    if (this.filePath !== filePath) {
      if (kept) window.api.removeDraft?.(filePath);
      return;
    }
    if (kept) this._draftStored = true;
    this._draftContent = null;
    this._flushDraft();
  }

  // Opens the file as saved on disk; unsaved edits stay in this editor.
  async _openExternally() {
    if (!this.filePath) return;
    try {
      const opened = await window.api.openFileExternally(this.filePath, null);
      if (!opened?.ok) throw new Error(opened?.error || 'Could not open the file in its default application.');
    } catch (error) {
      alert(error.message || 'Could not open the file in its default application.');
    }
  }

  // Shares the file as saved on disk; unsaved edits stay in this editor.
  async _share() {
    if (!this.filePath) return;
    try {
      const shared = await window.api.shareFile(this.filePath);
      if (!shared?.ok) throw new Error(shared?.error || 'Could not share the file.');
    } catch (error) {
      alert(error.message || 'Could not share the file.');
    }
  }

  // Keep the current buffer when its file (or an ancestor folder) is renamed.
  async relocate(title, filePath) {
    const dirty = this.isDirty();
    const saved = this._savedContent;
    const base = this._base;
    // The draft went with the file (file-drafts.js follow); it is written again below.
    clearTimeout(this._draftTimer);
    this._draftStored = false;
    this._draftContent = null;
    this._unwatchFile();
    const version = ++this._openVersion;
    this.filePath = filePath;
    this.toolbar.setTitle(title);
    this.toolbar.setPath(filePath);
    let result;
    try { result = await window.api.readFileForPanel(filePath); } catch {}
    if (version !== this._openVersion) return null;
    if (result?.ok) {
      // A new extension must not discard an editable buffer by switching it
      // to a binary preview. Reopening later uses the new file type normally.
      const preview = this.editorView && ['image', 'pdf', 'pptx'].includes(result.previewType)
        ? { ...result, previewType: 'text' } : result;
      this.open(title, filePath, this.editorView ? this.getContent() : result.content, { ...preview, fresh: true });
      if (dirty && this.editorView) {
        this._savedContent = saved;
        this._base = base;
        this._updateDirty();
      }
    } else {
      this._watchFile(filePath);
    }
    if (dirty) this._flushDraft();
    return result;
  }

  /** The editor's text, with the file's line breaks (CRLF stays CRLF). */
  getContent() {
    if (!this.editorView) return '';
    return window.cmGetText ? window.cmGetText(this.editorView) : this.editorView.state.doc.toString();
  }

  /** Empty the viewer. Unsaved text stays in its draft, unless `discard` (the file went to the Trash). */
  destroy({ discard = false } = {}) {
    if (discard) this.discardDraft();
    else this._flushDraft();
    clearTimeout(this._draftTimer);
    this._draftStored = false;
    this._draftContent = null;
    this._base = null;
    this._missing = false;
    this._hideNotice();
    this._unwatchFile();
    clearTimeout(this._autosaveTimer);
    this._hideConflict();
    this._savedContent = null;
    this._openVersion++;
    this._destroyEditor();
    this._clearPreview();
    this.filePath = '';
    this.previewMode = false;
    this._jsonState = { open: null };
    this._updateDirty();
  }

  /** Gone for good (a closed tab): the viewer is emptied and stops listening. */
  dispose(options) {
    this.destroy(options);
    viewerPanels.delete(this);
    if (lastViewerPanel === this) lastViewerPanel = null;
    window.removeEventListener?.(VIEWER_FONT_STEP_EVENT, this._onFontStep);
    window.removeEventListener?.('storage', this._onStorage);
  }

  _destroyEditor() {
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }
    // Clear stale search/goto-line/symbol bar references so they get recreated with the new editor
    delete this.editorEl._cmSearchBar;
    delete this.editorEl._cmGotoLine;
    delete this.editorEl._cmSymbolPicker;
    this.editorEl.innerHTML = '';
  }

  // ── File Watching ──────────────────────────────────────────────────

  _watchFile(filePath) {
    if (!filePath || !window.api.watchFile) return;
    this._watchedPath = filePath;
    window.api.watchFile(filePath);
  }

  _unwatchFile() {
    if (this._watchedPath && window.api.unwatchFile) {
      window.api.unwatchFile(this._watchedPath);
      this._watchedPath = null;
    }
  }

  async _reloadFromDisk() {
    if (!this.filePath || !window.api.readFileForPanel) return;
    const version = this._openVersion;
    const result = await window.api.readFileForPanel(this.filePath);
    if (version !== this._openVersion) return;
    if (!result.ok) return;
    if (this._isMedia()) {
      this.open(this.toolbar.titleEl.textContent, this.filePath, result.content, result);
      return;
    }

    const newContent = result.content;
    const wasMissing = this._missing;
    this._missing = false;
    if (wasMissing) this._hideNotice();
    if (sameViewerText(newContent, this.getContent())) {
      // On disk is what the editor has (the save just made, or the same edit).
      this._savedContent = this.getContent();
      this._base = this._savedContent;
      this._hideConflict();
      this._updateDirty();
      this._dropDraft();
      return;
    }
    if (this.isDirty()) {
      // Unsaved changes are never overwritten: ask.
      this._showConflict(newContent);
      return;
    }
    this._applyDiskContent(newContent);
  }

  /** The file as it is on disk in the editor (only what changed), as the text an edit differs from. */
  _applyDiskContent(content) {
    this._hideConflict();
    clearTimeout(this._draftTimer);
    this._applyShared(content);
    this._savedContent = this.getContent();
    this._base = this._savedContent;
    this._updateDirty();
    this._dropDraft();
    if (this.previewMode) this._renderPreview();
  }

  // ── The file changed on disk while there are unsaved changes ──────

  _showConflict(diskContent) {
    this._diskContent = diskContent;
    if (!this.conflictEl) {
      const bar = document.createElement('div');
      bar.className = 'viewer-conflict-bar';
      bar.setAttribute('role', 'alert');
      bar.innerHTML = `
        <span class="viewer-conflict-text">This file changed on disk, and you have unsaved changes.</span>
        <button type="button" class="viewer-conflict-btn" data-act="reload" title="Take the file as it is on disk; your changes are lost">Reload</button>
        <button type="button" class="viewer-conflict-btn" data-act="keep" title="Keep your changes; saving writes them over the file">Keep Mine</button>
        <button type="button" class="viewer-conflict-btn" data-act="compare" title="See the file on disk next to your changes">Compare</button>`;
      bar.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'reload') this._applyDiskContent(this._diskContent);
        else if (act === 'keep') this._keepMine();
        else if (act === 'compare') this._toggleCompare();
      });
      this.toolbar.el.after(bar);
      this.conflictEl = bar;
    }
    this.conflictEl.hidden = false;
    if (this._compareView) this._toggleCompare(true);
  }

  /** Keep Mine: the edits now start from the file as it is on disk. */
  _keepMine() {
    this._base = this._diskContent;
    this._draftContent = null;
    this._hideConflict();
    this._flushDraft();
  }

  _hideConflict() {
    this._closeCompare();
    if (this.conflictEl) this.conflictEl.hidden = true;
  }

  /** Compare: the file on disk (as the original) and the editor's text, in one column; again to go back. */
  _toggleCompare(refresh = false) {
    if (this._compareView && !refresh) { this._closeCompare(); return; }
    this._closeCompare();
    if (!window.createUnifiedMergeViewer) return;
    if (this.previewMode) this._setPreview(false);
    const host = document.createElement('div');
    host.className = 'viewer-panel-editor viewer-compare';
    this.editorEl.after(host);
    this.editorEl.style.display = 'none';
    this._compareHost = host;
    this._compareView = window.createUnifiedMergeViewer(host, this._diskContent || '', this.getContent(), this.filePath, { readOnly: true });
    const button = this.conflictEl && this.conflictEl.querySelector('[data-act="compare"]');
    if (button) button.textContent = 'Back to Editor';
    const text = this.conflictEl && this.conflictEl.querySelector('.viewer-conflict-text');
    if (text) text.textContent = 'Red is the file on disk, green your unsaved changes.';
  }

  _closeCompare() {
    if (!this._compareView) return;
    this._compareView.destroy();
    this._compareView = null;
    this._compareHost.remove();
    this._compareHost = null;
    if (!this.previewMode && !this._isMedia()) this.editorEl.style.display = '';
    const button = this.conflictEl && this.conflictEl.querySelector('[data-act="compare"]');
    if (button) button.textContent = 'Compare';
    const text = this.conflictEl && this.conflictEl.querySelector('.viewer-conflict-text');
    if (text) text.textContent = 'This file changed on disk, and you have unsaved changes.';
  }

  _isMarkdown(filePath) {
    if (!filePath) return this.opts.language === 'markdown';
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'md' || ext === 'mdx';
  }

  _isJson(filePath) {
    return !!filePath && /\.jsonc?$/i.test(filePath);
  }

  // Remembered apart from markdown's, so switching one does not switch the other.
  _jsonPreviewKey() {
    return this.opts.storageKey ? `${this.opts.storageKey}:json` : null;
  }

  _previewLabel() {
    if (this.previewMode) return 'Back to editor';
    if (this.previewType === 'html') return 'Preview HTML';
    if (this._isJson(this.filePath)) return 'Read JSON as a tree';
    return 'Toggle markdown preview';
  }
}

window.ViewerPanel = ViewerPanel;
