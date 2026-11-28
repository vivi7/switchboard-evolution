/**
 * file-panel.js — Renderer-side file/diff side panel for Switchboard.
 *
 * Manages a collapsible panel to the right of the terminal that shows
 * files and diffs received from the MCP bridge.
 *
 * For files: each session has its own open files in tabs (editor-tabs.js),
 * each with its ViewerPanel, remembered across restarts.
 * For diffs: uses its own MergeView rendering with accept/reject, in the files'
 * place until it is answered or closed.
 *
 * Globals expected: window.api, window.ViewerPanel, window.EditorTabs,
 *   window.createMergeViewer, window.createUnifiedMergeViewer,
 *   window.createViewerToolbar, openSessions (from app.js)
 */

// ── Per-Session State ───────────────────────────────────────────────

const filePanelState = new Map();

// ── DOM References ──────────────────────────────────────────────────

let filePanelEl = null;
let filePanelContentEl = null;  // container for ViewerPanel or diff content
let filePanelResizeHandle = null;
let terminalSplitEl = null;
let currentPanelSessionId = null;
let filePanelWorkspaceEl = null;

// Project browser DOM
let projectBrowserEl = null;
let projectBrowserTreeEl = null;
let projectBrowserRootEl = null;
let projectBrowserToggleEl = null;

// Holds every session's file tabs; only the shown session's are seen
let fileViewerEl = null;

// Diff-specific DOM
let diffToolbarEl = null;
let diffBodyEl = null;
let diffActionsEl = null;
let diffToggleBtn = null;

const PANEL_WIDTH_KEY = 'filePanelWidth';
const DEFAULT_PANEL_WIDTH = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10) || 450;
const MIN_PANEL_WIDTH = 280;
const DEFAULT_BROWSER_PANEL_WIDTH = 620;

const DIFF_MODE_KEY = 'filePanelDiffMode';
let diffMode = localStorage.getItem(DIFF_MODE_KEY) || 'side-by-side';

// ── Initialization ──────────────────────────────────────────────────

function initFilePanel() {
  const terminalArea = document.getElementById('terminal-area');
  const terminalsEl = document.getElementById('terminals');
  if (!terminalArea || !terminalsEl) return;

  // Create the split container
  terminalSplitEl = document.createElement('div');
  terminalSplitEl.id = 'terminal-split';

  terminalArea.removeChild(terminalsEl);
  terminalSplitEl.appendChild(terminalsEl);

  // Create resize handle
  filePanelResizeHandle = document.createElement('div');
  filePanelResizeHandle.id = 'file-panel-resize-handle';
  terminalSplitEl.appendChild(filePanelResizeHandle);

  // Create the file panel
  filePanelEl = document.createElement('div');
  filePanelEl.id = 'file-panel';

  // Content container — holds either ViewerPanel or diff UI
  filePanelContentEl = document.createElement('div');
  filePanelContentEl.id = 'file-panel-content';
  filePanelEl.appendChild(filePanelContentEl);

  createProjectBrowser();

  filePanelWorkspaceEl = document.createElement('div');
  filePanelWorkspaceEl.id = 'file-panel-workspace';
  filePanelContentEl.appendChild(filePanelWorkspaceEl);

  // ── File tabs ──
  fileViewerEl = document.createElement('div');
  fileViewerEl.id = 'file-panel-viewer';
  fileViewerEl.style.display = 'none';
  filePanelWorkspaceEl.appendChild(fileViewerEl);

  // ── Diff-specific UI ──
  const diffContainer = document.createElement('div');
  diffContainer.id = 'file-panel-diff';
  diffContainer.style.display = 'none';
  filePanelWorkspaceEl.appendChild(diffContainer);

  // Diff toolbar
  diffToolbarEl = document.createElement('div');
  diffToolbarEl.className = 'viewer-toolbar';

  const diffInfo = document.createElement('div');
  diffInfo.className = 'viewer-toolbar-info';
  diffInfo.innerHTML = '<span class="viewer-toolbar-title" id="diff-title"></span><span class="viewer-toolbar-path" id="diff-path"></span>';
  diffToolbarEl.appendChild(diffInfo);

  const diffControls = document.createElement('div');
  diffControls.className = 'viewer-toolbar-controls';

  diffToggleBtn = document.createElement('button');
  diffToggleBtn.className = 'fp-toolbar-btn';
  diffToggleBtn.textContent = diffMode === 'inline' ? 'Side-by-Side' : 'Inline';
  diffToggleBtn.title = diffMode === 'inline' ? 'Switch to side-by-side diff' : 'Switch to inline diff';
  diffToggleBtn.addEventListener('click', handleDiffModeToggle);
  diffControls.appendChild(diffToggleBtn);

  const diffSaveBtn = document.createElement('button');
  diffSaveBtn.className = 'fp-toolbar-btn fp-save-btn fp-icon-btn';
  diffSaveBtn.title = 'Save changes';
  diffSaveBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M433.941 129.941l-83.882-83.882A48 48 0 0 0 316.118 32H48C21.49 32 0 53.49 0 80v352c0 26.51 21.49 48 48 48h352c26.51 0 48-21.49 48-48V163.882a48 48 0 0 0-14.059-33.941zM272 80v80H144V80h128zm122 352H54a6 6 0 0 1-6-6V86a6 6 0 0 1 6-6h42v104c0 13.255 10.745 24 24 24h176c13.255 0 24-10.745 24-24V83.882l78.243 78.243a6 6 0 0 1 1.757 4.243V426a6 6 0 0 1-6 6zM224 232c-48.523 0-88 39.477-88 88s39.477 88 88 88 88-39.477 88-88-39.477-88-88-88zm0 128c-22.056 0-40-17.944-40-40s17.944-40 40-40 40 17.944 40 40-17.944 40-40 40z"></path></svg>';
  diffSaveBtn.addEventListener('click', handleDiffSave);
  diffControls.appendChild(diffSaveBtn);

  const diffCloseBtn = document.createElement('button');
  diffCloseBtn.className = 'fp-toolbar-btn fp-close-btn fp-icon-btn';
  diffCloseBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M400 145.49 366.51 112 256 222.51 145.49 112 112 145.49 222.51 256 112 366.51 145.49 400 256 289.49 366.51 400 400 366.51 289.49 256 400 145.49z"></path></svg>';
  diffCloseBtn.title = 'Close diff';
  diffCloseBtn.addEventListener('click', handleClose);
  diffControls.appendChild(diffCloseBtn);

  diffToolbarEl.appendChild(diffControls);
  diffContainer.appendChild(diffToolbarEl);

  diffBodyEl = document.createElement('div');
  diffBodyEl.id = 'file-panel-body';
  diffContainer.appendChild(diffBodyEl);

  diffActionsEl = document.createElement('div');
  diffActionsEl.id = 'file-panel-actions';
  diffActionsEl.style.display = 'none';
  diffContainer.appendChild(diffActionsEl);

  terminalSplitEl.appendChild(filePanelEl);
  terminalArea.appendChild(terminalSplitEl);

  wireIpcListeners();
  setupPanelResizeHandle();
  addMcpToggle();
  addProjectBrowserToggle();
}

// ── Handlers ────────────────────────────────────────────────────────

/** The ✕ of the diff shown, or of the file shown (its tab). */
function handleClose() {
  if (!currentPanelSessionId) return;
  const state = getSessionState(currentPanelSessionId);
  const tab = state.currentTab;

  if (tab?.type === 'diff') {
    if (!tab.resolved) window.api.mcpDiffResponse(currentPanelSessionId, tab.diffId, 'reject', null);
    leaveDiffTab(currentPanelSessionId, state);
    return;
  }
  const file = tab && state.editors?.find(tab.filePath);
  if (file) {
    state.editors.close(file);
    return;
  }
  closeEmptyPanel(currentPanelSessionId, state);
}

/** A diff editor's text with its file's line breaks (CRLF stays CRLF). */
function diffEditorText(view) {
  return window.cmGetText ? window.cmGetText(view) : view.state.doc.toString();
}

async function handleDiffSave() {
  const state = currentPanelSessionId ? getSessionState(currentPanelSessionId) : null;
  const tab = state?.currentTab;
  if (!tab || tab.type !== 'diff' || !tab.editorView || !tab.filePath) return;

  let content;
  if (tab._diffMode === 'inline') {
    content = diffEditorText(tab.editorView);
  } else if (tab.editorView.b) {
    content = diffEditorText(tab.editorView.b);
  }
  if (content == null) return;

  const result = await window.api.saveFileForPanel(tab.filePath, content);
  if (result.ok) {
    const btn = diffToolbarEl.querySelector('.fp-save-btn');
    if (btn) flashButtonText(btn, 'Saved!');
  }
}

function handleDiffModeToggle() {
  diffMode = diffMode === 'inline' ? 'side-by-side' : 'inline';
  localStorage.setItem(DIFF_MODE_KEY, diffMode);
  diffToggleBtn.textContent = diffMode === 'inline' ? 'Side-by-Side' : 'Inline';
  diffToggleBtn.title = diffMode === 'inline' ? 'Switch to side-by-side diff' : 'Switch to inline diff';

  if (currentPanelSessionId) {
    const state = getSessionState(currentPanelSessionId);
    const tab = state.currentTab;
    if (tab && tab.type === 'diff') {
      if (tab.editorView) { tab.editorView.destroy(); tab.editorView = null; }
      renderTabContent(currentPanelSessionId, tab);
    }
  }
}

// ── IPC Wiring ──────────────────────────────────────────────────────

function wireIpcListeners() {
  window.api.onMcpOpenDiff((sessionId, diffId, data) => {
    openDiffTab(sessionId, diffId, data);
  });

  window.api.onMcpOpenFile((sessionId, data) => {
    openFileTab(sessionId, data);
  });

  window.api.onMcpCloseAllDiffs((sessionId) => {
    closeAllDiffs(sessionId);
  });

  window.api.onMcpCloseTab((sessionId, diffId) => {
    closeDiffByDiffId(sessionId, diffId);
  });

  // Answered on a paired phone: nothing is left to decide here. A diff the
  // window answered itself is already resolved and stays as it is.
  window.api.onMcpDiffResolved((sessionId, diffId) => {
    const tab = filePanelState.get(sessionId)?.currentTab;
    if (tab && !tab.resolved) closeDiffByDiffId(sessionId, diffId);
  });
}

// ── Session State Helpers ───────────────────────────────────────────

function getSessionState(sessionId) {
  if (!filePanelState.has(sessionId)) {
    filePanelState.set(sessionId, {
      currentTab: null,
      panelVisible: false,
      panelWidth: DEFAULT_PANEL_WIDTH,
      mcpActive: false,
      explorerVisible: false,
      projectPath: '',
      expandedPaths: new Set(),
      directoryCache: new Map(),
      loadingDirectories: new Set(),
      selectedPath: '',
      browserError: '',
      browserGeneration: 0,
      editors: null,       // the session's file tabs (EditorTabs), made when first needed
      editorHost: null,
    });
  }
  return filePanelState.get(sessionId);
}

function setSessionMcpActive(sessionId, active) {
  const state = getSessionState(sessionId);
  state.mcpActive = active;
  if (currentPanelSessionId === sessionId) updateMcpIndicator();
}

function rekeyFilePanelState(oldId, newId) {
  const state = filePanelState.get(oldId);
  if (state) {
    const replaced = filePanelState.get(newId);
    if (replaced && replaced !== state) {
      replaced.editors?.destroy();
      replaced.editorHost?.remove();
    }
    filePanelState.delete(oldId);
    filePanelState.set(newId, state);
    state.editors?.setStorageKey(fileTabsKey(newId));
  }
  if (currentPanelSessionId === newId) {
    updateProjectBrowserToggle();
    const currentState = getSessionState(newId);
    if (currentState.panelVisible && (currentState.currentTab || currentState.explorerVisible)) {
      showPanel(currentState);
      renderPanel(newId);
    }
  }
}

function sessionIdForState(state, fallbackId) {
  if (filePanelState.get(fallbackId) === state) return fallbackId;
  for (const [sessionId, candidate] of filePanelState) {
    if (candidate === state) return sessionId;
  }
  return null;
}

// ── Tab Operations ──────────────────────────────────────────────────

function openDiffTab(sessionId, diffId, data) {
  const state = getSessionState(sessionId);

  // A diff shown before goes; the files stay open behind this one.
  destroyCurrentTab(state);

  state.currentTab = {
    type: 'diff',
    label: data.tabName || basename(data.oldFilePath),
    filePath: data.oldFilePath,
    diffId,
    oldContent: data.oldContent,
    newContent: data.newContent,
    resolved: false,
    editorView: null,
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

/** Show a file just read, in its tab. Unsaved changes in that tab stay. */
function openFileTab(sessionId, data) {
  const state = getSessionState(sessionId);

  destroyCurrentTab(state);

  const editors = fileEditors(sessionId, state);
  const tab = editors.add(data.filePath);
  showingFile(state, tab.path);
  state.panelVisible = true;

  if (!tab.loaded) {
    // Put in the editor when the session is shown.
    tab.pending = data;
  } else if (!tab.panel.isDirty()) {
    editors.fill(tab, data.content, data);
  } else if (data.line) {
    tab.panel.goToLocation(data.line, data.column);
  }

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

// ── File Tabs ───────────────────────────────────────────────────────

function fileTabsKey(sessionId) {
  return `filePanelTabs:${sessionId}`;
}

/** `currentTab` is the file at `filePath`; the same object while it stays that one. */
function showingFile(state, filePath) {
  if (state.currentTab?.type !== 'file' || state.currentTab.filePath !== filePath) {
    state.currentTab = { type: 'file', filePath };
  }
}

/** The session's file tabs, with those it had open when the app last closed. */
function fileEditors(sessionId, state) {
  if (state.editors) return state.editors;
  const idNow = () => sessionIdForState(state, sessionId);
  state.editorHost = document.createElement('div');
  state.editorHost.className = 'file-panel-session';
  state.editorHost.style.display = 'none';
  fileViewerEl.appendChild(state.editorHost);
  state.editors = new window.EditorTabs(state.editorHost, {
    storageKey: fileTabsKey(sessionId),
    createPanel: (element, tab, shared) => new window.ViewerPanel(element, {
      ...shared,
      language: 'auto',
      storageKey: 'markdownPreviewMode',
      onSave: (filePath, content, options) => window.api.saveFileForPanel(filePath, content, options),
      onClose: () => state.editors.close(tab),
      // Go to Definition into another file: in a tab of its own.
      openFile: (filePath, at) => openFileInPanel(idNow(), filePath, at),
    }),
    onSelect: (tab) => selectFileTab(state, tab),
    projectName: (tab) => editorProjectName(tab.path),
    onActivate: (tab) => {
      if (!tab || state.currentTab?.type === 'diff') return;
      showingFile(state, tab.path);
      selectBrowserFile(idNow(), state, tab.path);
    },
    onRemove: (tab) => {
      if (state.selectedPath && projectEntryPath(state.projectPath, state.selectedPath) === tab.path) {
        state.selectedPath = '';
        renderProjectBrowser(idNow());
      }
    },
    // The last file closed: the explorer stays, if it is open.
    onEmpty: () => {
      if (state.currentTab?.type !== 'diff') closeEmptyPanel(idNow(), state);
    },
  });
  return state.editors;
}

/** The explorer marks the file shown, when it is one of the session's project. */
function selectBrowserFile(sessionId, state, filePath) {
  const root = state.projectPath;
  if (!root || !(filePath.startsWith(`${root}/`) || filePath.startsWith(`${root}\\`))) return;
  const relativePath = filePath.slice(root.length + 1).split('\\').join('/');
  if (state.selectedPath === relativePath) return;
  state.selectedPath = relativePath;
  renderProjectBrowser(sessionId);
}

function closeEmptyPanel(sessionId, state) {
  state.currentTab = null;
  state.panelVisible = state.explorerVisible;
  if (currentPanelSessionId !== sessionId) return;
  if (state.panelVisible) {
    showPanel(state);
    renderPanel(sessionId);
  } else {
    hidePanel();
  }
}

/** The files open when the app last closed come back with their session. */
function restoreFileTabs(sessionId, state) {
  if (state.editors || !fileViewerEl || !localStorage.getItem(fileTabsKey(sessionId))) return;
  const tab = fileEditors(sessionId, state).lastUsed();
  if (!tab || state.currentTab) return;
  showingFile(state, tab.path);
  state.panelVisible = true;
}

/** Read a tab's file into it. One that cannot be read, with nothing unsaved kept, goes. */
async function loadFileTab(editors, tab, { quiet = false } = {}) {
  let result = tab.pending;
  if (!result) {
    try { result = await window.api.readFileForPanel(tab.path); } catch (err) { result = { ok: false, error: err.message }; }
  }
  if (!editors.tabs.includes(tab) || tab.loaded) return;
  // A newer read may have come while this one ran (openFileTab).
  result = tab.pending || result;
  tab.pending = null;
  // `pending` data (the CLI's openFile) has no `ok`.
  if (result && result.ok !== false) {
    editors.fill(tab, result.content, { ...result, filePath: tab.path });
    return;
  }
  // Unsaved text of a file that is gone is still shown, to be saved again.
  const draft = window.api.getDraft?.(tab.path);
  if (draft) {
    editors.fill(tab, draft.base, { missing: true });
    return;
  }
  editors.remove(tab);
  if (!quiet) alert(result?.error || 'Unable to open the file.');
}

/** A tab picked, or brought back after a restart: read when needed, then shown. */
async function selectFileTab(state, tab, options) {
  const editors = state.editors;
  if (state.currentTab?.type !== 'diff') showingFile(state, tab.path);
  if (!tab.loaded) {
    tab.loading ||= loadFileTab(editors, tab, options).finally(() => { tab.loading = null; });
    await tab.loading;
  }
  // Another file was asked for while this one was read.
  if (!tab.loaded || (state.currentTab?.type === 'file' && state.currentTab.filePath !== tab.path)) return;
  editors.activate(tab);
}

function showFileTab(sessionId, state) {
  const editors = fileEditors(sessionId, state);
  const tab = editors.find(state.currentTab.filePath);
  if (!tab) return;
  if (!tab.loaded) selectFileTab(state, tab, { quiet: true });
  else if (editors.active !== tab) editors.activate(tab);
  else tab.panel.editorView?.requestMeasure?.();
}

function destroyCurrentTab(state) {
  const tab = state.currentTab;
  if (tab?.type !== 'diff' || !tab.editorView) return;
  tab.editorView.destroy();
  tab.editorView = null;
  // Clear stale search/goto-line bar references
  if (diffBodyEl) {
    delete diffBodyEl._cmSearchBar;
    delete diffBodyEl._cmGotoLine;
  }
}

async function openFileInPanel(sessionId, filePath, location = {}) {
  const state = getSessionState(sessionId);
  if (state.currentTab?.type === 'diff' && !state.currentTab.resolved) {
    alert('Resolve or close the current diff before opening a file.');
    return null;
  }
  const request = state.fileOpenRequest = (state.fileOpenRequest || 0) + 1;
  // A file already open keeps its tab, with whatever is typed in it.
  const open = state.editors?.find(filePath);
  if (open?.loaded) {
    destroyCurrentTab(state);
    showingFile(state, filePath);
    state.panelVisible = true;
    state.editors.activate(open);
    if (currentPanelSessionId === sessionId) {
      showPanel(state);
      renderPanel(sessionId);
    }
    if (location.line) open.panel.goToLocation(location.line, location.column);
    open.panel.editorView?.focus?.();
    return open.panel;
  }
  const previousTab = state.currentTab;
  let result;
  try { result = await window.api.readFileForPanel(filePath); } catch (err) { result = { ok: false, error: err.message }; }
  const effectiveSessionId = sessionIdForState(state, sessionId);
  if (!effectiveSessionId || currentPanelSessionId !== effectiveSessionId || state.fileOpenRequest !== request || state.currentTab !== previousTab) return null;
  const draft = result?.ok ? null : window.api.getDraft?.(filePath);
  if (draft) {
    result = { ok: true, content: draft.base, missing: true };
  } else {
    if (await openUnsupportedFile(result, filePath)) return null;
    if (!result?.ok) { alert(result?.error || 'Unable to open the file.'); return null; }
  }
  openFileTab(effectiveSessionId, { ...result, filePath, line: location.line, column: location.column });
  const tab = state.editors.find(filePath);
  if (!tab) return null;
  await selectFileTab(state, tab);
  return tab.panel;
}

async function openProjectFile(sessionId, relativePath) {
  const state = getSessionState(sessionId);
  if (!state.projectPath) return;
  if (state.currentTab?.type === 'diff' && !state.currentTab.resolved) {
    state.browserError = 'Resolve or close the current diff before previewing another file';
    renderProjectBrowser(sessionId);
    return;
  }
  const requestedRoot = state.projectPath;

  state.selectedPath = relativePath;
  state.browserError = '';
  renderProjectBrowser(sessionId);

  // A file already open keeps its tab, with whatever is typed in it.
  const open = state.editors?.find(projectEntryPath(requestedRoot, relativePath));
  if (open?.loaded) {
    await openFileInPanel(sessionId, open.path);
    return;
  }

  const result = await window.api.readProjectFile(requestedRoot, relativePath);
  if (state.projectPath !== requestedRoot || state.selectedPath !== relativePath) return;
  const effectiveSessionId = sessionIdForState(state, sessionId);
  if (!effectiveSessionId) return;
  if (await openUnsupportedFile(result, projectEntryPath(requestedRoot, relativePath), requestedRoot)) return;
  if (!result.ok) {
    state.selectedPath = '';
    state.browserError = result.error || 'Unable to preview file';
    if (currentPanelSessionId === effectiveSessionId) renderProjectBrowser(effectiveSessionId);
    return;
  }

  openFileTab(effectiveSessionId, result);
}

function closeAllDiffs(sessionId) {
  const state = filePanelState.get(sessionId);
  if (state?.currentTab?.type === 'diff') leaveDiffTab(sessionId, state);
}

function closeDiffByDiffId(sessionId, diffId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab) return;
  if (state.currentTab.type !== 'diff' || state.currentTab.diffId !== diffId) return;

  state.currentTab.resolved = true;
  leaveDiffTab(sessionId, state);
}

/** The diff goes; the file shown before it, if any, is back. */
function leaveDiffTab(sessionId, state) {
  destroyCurrentTab(state);
  const file = state.editors?.active || state.editors?.lastUsed();
  state.currentTab = file ? { type: 'file', filePath: file.path } : null;
  state.panelVisible = state.explorerVisible || !!state.currentTab;
  if (currentPanelSessionId === sessionId) {
    if (state.panelVisible) renderPanel(sessionId);
    else hidePanel();
  }
}

// ── Panel Show/Hide ─────────────────────────────────────────────────

function showPanel(state) {
  if (!filePanelEl) return;
  filePanelEl.classList.add('open');
  filePanelEl.style.width = (state.panelWidth || DEFAULT_PANEL_WIDTH) + 'px';
  filePanelResizeHandle.style.display = 'block';
  refitActiveTerminal();
}

function hidePanel() {
  if (!filePanelEl) return;
  filePanelEl.classList.remove('open');
  filePanelEl.style.width = '0';
  filePanelResizeHandle.style.display = 'none';
  refitActiveTerminal();
}

function switchPanel(sessionId) {
  currentPanelSessionId = sessionId;
  updateMcpIndicator();
  updateProjectBrowserToggle();

  if (!sessionId) {
    hidePanel();
    return;
  }

  const state = getSessionState(sessionId);
  restoreFileTabs(sessionId, state);

  if (state.panelVisible && (state.currentTab || state.explorerVisible)) {
    showPanel(state);
    renderPanel(sessionId);
  } else {
    hidePanel();
  }
}

function updateMcpIndicator() {
  if (!mcpIndicatorEl) return;
  if (!currentPanelSessionId) {
    mcpIndicatorEl.style.display = 'none';
    return;
  }
  const state = filePanelState.get(currentPanelSessionId);
  mcpIndicatorEl.style.display = (state && state.mcpActive) ? '' : 'none';
}

function updateProjectBrowserToggle() {
  if (!projectBrowserToggleEl) return;
  const state = currentPanelSessionId ? filePanelState.get(currentPanelSessionId) : null;
  projectBrowserToggleEl.classList.toggle('active', !!state?.explorerVisible);
  projectBrowserToggleEl.setAttribute('aria-pressed', state?.explorerVisible ? 'true' : 'false');
}

// ── Panel Rendering ─────────────────────────────────────────────────

function renderPanel(sessionId) {
  if (!filePanelEl || currentPanelSessionId !== sessionId) return;

  const state = getSessionState(sessionId);
  if (!state) return;

  renderProjectBrowser(sessionId);
  renderTabContent(sessionId, state.currentTab);
}

function renderTabContent(sessionId, tab) {
  const diffContainer = document.getElementById('file-panel-diff');
  const state = getSessionState(sessionId);

  for (const other of filePanelState.values()) {
    if (other.editorHost) other.editorHost.style.display = other === state && tab?.type === 'file' ? 'flex' : 'none';
  }

  if (!tab) {
    filePanelContentEl.classList.add('browser-only');
    filePanelWorkspaceEl.style.display = 'none';
    fileViewerEl.style.display = 'none';
    diffContainer.style.display = 'none';
    return;
  }

  filePanelContentEl.classList.remove('browser-only');
  filePanelWorkspaceEl.style.display = 'flex';

  if (tab.type === 'file') {
    diffContainer.style.display = 'none';
    fileViewerEl.style.display = 'flex';
    showFileTab(sessionId, state);
    // Made above when it was not there yet.
    state.editorHost.style.display = 'flex';
  } else {
    // Diff mode
    fileViewerEl.style.display = 'none';
    diffContainer.style.display = 'flex';
    renderDiffContent(sessionId, tab);
  }
}

function renderDiffContent(sessionId, tab) {
  diffBodyEl.innerHTML = '';

  // Update diff toolbar info
  const titleEl = diffToolbarEl.querySelector('#diff-title');
  const pathEl = diffToolbarEl.querySelector('#diff-path');
  if (titleEl) titleEl.textContent = tab.label;
  if (pathEl) pathEl.textContent = tab.filePath || '';

  if (!tab.editorView) {
    if (diffMode === 'inline') {
      tab.editorView = window.createUnifiedMergeViewer(
        diffBodyEl, tab.oldContent, tab.newContent, tab.filePath,
      );
      tab._diffMode = 'inline';
    } else {
      tab.editorView = window.createMergeViewer(
        diffBodyEl, tab.oldContent, tab.newContent, tab.filePath,
      );
      tab._diffMode = 'side-by-side';
    }
    tab.editorView.dom.addEventListener('click', () => tab.editorView.dom.focus());
  } else {
    diffBodyEl.appendChild(tab.editorView.dom);
  }

  // Accept/reject buttons
  if (!tab.resolved) {
    diffActionsEl.style.display = 'flex';
    diffActionsEl.innerHTML = '';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'file-panel-accept-btn';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => handleDiffAction(sessionId, tab, 'accept'));

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'file-panel-reject-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => handleDiffAction(sessionId, tab, 'reject'));

    diffActionsEl.appendChild(acceptBtn);
    diffActionsEl.appendChild(rejectBtn);
  } else {
    diffActionsEl.style.display = 'none';
  }
}

// ── Diff Actions ────────────────────────────────────────────────────

async function handleDiffAction(sessionId, tab, action) {
  if (tab.resolved) return;
  tab.resolved = true;

  let answered;
  if (action === 'accept') {
    let editedContent = null;
    if (tab.editorView) {
      if (tab._diffMode === 'inline') {
        editedContent = diffEditorText(tab.editorView);
      } else if (tab.editorView.b) {
        editedContent = diffEditorText(tab.editorView.b);
      }
    }

    if (editedContent && editedContent !== tab.newContent) {
      answered = window.api.mcpDiffResponse(sessionId, tab.diffId, 'accept-edited', editedContent);
    } else {
      answered = window.api.mcpDiffResponse(sessionId, tab.diffId, 'accept', null);
    }
  } else {
    answered = window.api.mcpDiffResponse(sessionId, tab.diffId, 'reject', null);
  }

  diffActionsEl.style.display = 'none';
  // The first answer wins; a paired phone may have given it a moment earlier.
  if (await answered === false) {
    closeDiffByDiffId(sessionId, tab.diffId);
    alert('This change was already answered on a paired phone, so your answer was not used.');
  }
}

// ── IDE Emulation Indicator ─────────────────────────────────────────

let mcpIndicatorEl = null;

function addMcpToggle() {
  const controls = document.getElementById('terminal-header-controls');
  if (!controls) return;

  mcpIndicatorEl = document.createElement('span');
  mcpIndicatorEl.className = 'mcp-toggle enabled';
  mcpIndicatorEl.title = 'IDE Emulation is active. Go to Global Settings to disable.';
  mcpIndicatorEl.textContent = 'IDE Emulation';
  mcpIndicatorEl.style.display = 'none';

  const stopBtn = document.getElementById('terminal-stop-btn');
  if (stopBtn) {
    controls.insertBefore(mcpIndicatorEl, stopBtn);
  } else {
    controls.appendChild(mcpIndicatorEl);
  }
}

function addProjectBrowserToggle() {
  const controls = document.getElementById('terminal-header-controls');
  if (!controls) return;

  projectBrowserToggleEl = document.createElement('button');
  projectBrowserToggleEl.id = 'project-files-btn';
  projectBrowserToggleEl.title = 'Browse project files';
  projectBrowserToggleEl.setAttribute('aria-label', 'Browse project files');
  projectBrowserToggleEl.setAttribute('aria-pressed', 'false');
  // A folder opened in the app (action-icons.js: folderSearch).
  projectBrowserToggleEl.innerHTML = ICONS.folderSearch(16);
  projectBrowserToggleEl.addEventListener('click', toggleProjectBrowser);

  const stopBtn = document.getElementById('terminal-stop-btn');
  controls.insertBefore(projectBrowserToggleEl, mcpIndicatorEl || stopBtn || null);
}

function toggleProjectBrowser() {
  if (!currentPanelSessionId) return;
  const state = getSessionState(currentPanelSessionId);
  state.explorerVisible = !state.explorerVisible;

  if (state.explorerVisible) {
    state.panelVisible = true;
    state.panelWidth = Math.max(state.panelWidth || 0, DEFAULT_BROWSER_PANEL_WIDTH);
    syncProjectPath(currentPanelSessionId, state);
    showPanel(state);
    if (state.currentTab) renderProjectBrowser(currentPanelSessionId);
    else renderPanel(currentPanelSessionId);
  } else if (!state.currentTab) {
    state.panelVisible = false;
    hidePanel();
  } else {
    renderProjectBrowser(currentPanelSessionId);
  }

  updateProjectBrowserToggle();
}

function createProjectBrowser() {
  projectBrowserEl = document.createElement('div');
  projectBrowserEl.id = 'project-file-browser';
  projectBrowserEl.style.display = 'none';

  const header = document.createElement('div');
  header.id = 'project-file-browser-header';

  projectBrowserRootEl = document.createElement('span');
  projectBrowserRootEl.id = 'project-file-browser-root';
  header.appendChild(projectBrowserRootEl);

  const refreshBtn = document.createElement('button');
  refreshBtn.id = 'project-file-browser-refresh';
  refreshBtn.title = 'Refresh project files';
  refreshBtn.setAttribute('aria-label', 'Refresh project files');
  refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 9m16 6-2 2.5A7 7 0 0 1 5.5 15"/></svg>';
  refreshBtn.addEventListener('click', () => {
    if (!currentPanelSessionId) return;
    const state = getSessionState(currentPanelSessionId);
    state.directoryCache.clear();
    state.loadingDirectories.clear();
    state.browserError = '';
    state.browserGeneration++;
    renderProjectBrowser(currentPanelSessionId);
  });
  header.appendChild(refreshBtn);

  projectBrowserTreeEl = document.createElement('div');
  projectBrowserTreeEl.id = 'project-file-browser-tree';

  projectBrowserEl.appendChild(header);
  projectBrowserEl.appendChild(projectBrowserTreeEl);
  filePanelContentEl.appendChild(projectBrowserEl);
}

function getProjectPathForSession(sessionId) {
  let session = null;
  if (typeof openSessions !== 'undefined') session = openSessions.get(sessionId)?.session;
  if (!session && typeof sessionMap !== 'undefined') session = sessionMap.get(sessionId);
  if (!session && typeof pendingSessions !== 'undefined') session = pendingSessions.get(sessionId)?.session;
  return session?.projectPath || '';
}

function syncProjectPath(sessionId, state) {
  const projectPath = getProjectPathForSession(sessionId);
  if (state.projectPath === projectPath) return;
  state.projectPath = projectPath;
  state.expandedPaths.clear();
  state.directoryCache.clear();
  state.loadingDirectories.clear();
  state.selectedPath = '';
  state.browserError = '';
  state.browserGeneration++;
}

function renderProjectBrowser(sessionId) {
  if (!projectBrowserEl || currentPanelSessionId !== sessionId) return;
  const state = getSessionState(sessionId);
  syncProjectPath(sessionId, state);

  projectBrowserEl.style.display = state.explorerVisible ? 'flex' : 'none';
  if (!state.explorerVisible) return;

  projectBrowserRootEl.textContent = state.projectPath ? basename(state.projectPath) : 'Project files';
  projectBrowserRootEl.title = state.projectPath || 'No project folder is available for this session';
  projectBrowserTreeEl.innerHTML = '';

  if (!state.projectPath) {
    appendBrowserMessage('No project folder available', 'empty');
    return;
  }

  if (state.browserError) appendBrowserMessage(state.browserError, 'error');

  const rootEntries = state.directoryCache.get('');
  if (!rootEntries) {
    appendBrowserMessage('Loading files…', 'loading');
    loadProjectDirectory(sessionId, state, '');
    return;
  }

  if (!rootEntries.length) {
    appendBrowserMessage('This project folder is empty', 'empty');
    return;
  }
  appendTreeEntries(sessionId, state, projectBrowserTreeEl, rootEntries, 0);
}

function appendBrowserMessage(message, kind) {
  const el = document.createElement('div');
  el.className = `project-file-browser-message ${kind}`;
  el.textContent = message;
  projectBrowserTreeEl.appendChild(el);
}

function loadProjectDirectory(sessionId, state, relativePath) {
  if (state.loadingDirectories.has(relativePath)) return;
  const requestedRoot = state.projectPath;
  const requestedGeneration = state.browserGeneration;
  state.loadingDirectories.add(relativePath);

  window.api.listProjectDirectory(requestedRoot, relativePath).then(result => {
    if (state.projectPath !== requestedRoot || state.browserGeneration !== requestedGeneration) return;
    if (result.ok) {
      state.directoryCache.set(relativePath, result.entries || []);
    } else {
      state.browserError = result.error || 'Unable to list project files';
      state.expandedPaths.delete(relativePath);
    }
  }).catch(err => {
    if (state.projectPath !== requestedRoot || state.browserGeneration !== requestedGeneration) return;
    state.browserError = err?.message || 'Unable to list project files';
    state.expandedPaths.delete(relativePath);
  }).finally(() => {
    if (state.projectPath !== requestedRoot || state.browserGeneration !== requestedGeneration) return;
    state.loadingDirectories.delete(relativePath);
    const effectiveSessionId = sessionIdForState(state, sessionId);
    if (effectiveSessionId && currentPanelSessionId === effectiveSessionId) {
      renderProjectBrowser(effectiveSessionId);
    }
  });
}

function canManageBrowserEntry(root, relativePath) {
  const change = { projectPath: root, relativePath, filePath: projectEntryPath(root, relativePath) };
  return ![...filePanelState.values()].some(state => state.currentTab?.type === 'diff' &&
    !state.currentTab.resolved && remapFileActionPath(state.currentTab.filePath, change) === null);
}

async function applyBrowserFileAction(change) {
  for (const [sessionId, state] of filePanelState) {
    state.directoryCache.clear();
    state.loadingDirectories.clear();
    state.browserError = '';
    state.browserGeneration++;
    state.selectedPath = remapFileActionRelative(state.projectPath, state.selectedPath, change) || '';
    state.expandedPaths = new Set([...state.expandedPaths].map(rel => remapFileActionRelative(state.projectPath, rel, change)).filter(Boolean));

    for (const tab of [...(state.editors?.tabs || [])]) {
      const next = remapFileActionPath(tab.path, change);
      if (next === tab.path) continue;
      // To the Trash: the tab goes, and its unsaved edits with it, as the question said.
      if (!next) { state.editors.remove(tab, { discard: true }); continue; }
      if (state.currentTab?.type === 'file' && state.currentTab.filePath === tab.path) {
        state.currentTab = { type: 'file', filePath: next };
      }
      tab.pending = null;
      await state.editors.relocate(tab, next);
    }

    const diff = state.currentTab;
    if (diff?.type !== 'diff') continue;
    const next = remapFileActionPath(diff.filePath, change);
    if (next === diff.filePath) continue;
    if (!next) {
      leaveDiffTab(sessionId, state);
    } else {
      diff.filePath = next;
      diff.label = basename(next);
      if (sessionId === currentPanelSessionId) renderDiffContent(sessionId, diff);
    }
  }
  if (currentPanelSessionId) {
    renderProjectBrowser(currentPanelSessionId);
    const state = filePanelState.get(currentPanelSessionId);
    if (!state?.currentTab) {
      renderTabContent(currentPanelSessionId, null);
      if (!state?.panelVisible) hidePanel();
    }
  }
}

function appendTreeEntries(sessionId, state, container, entries, depth) {
  for (const entry of entries) {
    const row = document.createElement('button');
    row.className = 'project-file-tree-row';
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.path = entry.relativePath;
    bindFileEntryMenu(row, state.projectPath, entry, () => openProjectFile(sessionId, entry.relativePath));

    if (entry.type === 'directory') {
      const expanded = state.expandedPaths.has(entry.relativePath);
      row.classList.add('directory');
      row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      row.innerHTML = `<span class="project-file-tree-chevron">${expanded ? '⌄' : '›'}</span><span class="project-file-tree-icon">${expanded ? '📂' : '📁'}</span><span class="project-file-tree-name"></span>`;
      row.querySelector('.project-file-tree-name').textContent = entry.name;
      row.addEventListener('click', () => {
        if (expanded) state.expandedPaths.delete(entry.relativePath);
        else state.expandedPaths.add(entry.relativePath);
        renderProjectBrowser(sessionId);
        if (!expanded && !state.directoryCache.has(entry.relativePath)) {
          loadProjectDirectory(sessionId, state, entry.relativePath);
        }
      });
      container.appendChild(row);

      if (expanded) {
        const childEntries = state.directoryCache.get(entry.relativePath);
        if (childEntries) {
          appendTreeEntries(sessionId, state, container, childEntries, depth + 1);
        } else {
          const loading = document.createElement('div');
          loading.className = 'project-file-tree-loading';
          loading.style.paddingLeft = `${12 + (depth + 1) * 14}px`;
          loading.textContent = 'Loading…';
          container.appendChild(loading);
        }
      }
      continue;
    }

    row.classList.add('file');
    row.classList.toggle('selected', state.selectedPath === entry.relativePath);
    row.classList.toggle('preview-unavailable', entry.type !== 'file');
    row.title = entry.viewable ? entry.relativePath : entry.type === 'file' ? entry.relativePath + '\nOpen in default application' : 'This item cannot be opened';
    row.innerHTML = '<span class="project-file-tree-spacer"></span><span class="project-file-tree-icon">📄</span><span class="project-file-tree-name"></span>';
    row.querySelector('.project-file-tree-name').textContent = entry.name;
    if (entry.type === 'file') row.addEventListener('click', () => openProjectFile(sessionId, entry.relativePath));
    container.appendChild(row);
  }
}

// ── Resize Handle ───────────────────────────────────────────────────

function setupPanelResizeHandle() {
  if (!filePanelResizeHandle) return;

  let startX = 0;
  let startWidth = 0;

  function onMouseDown(e) {
    e.preventDefault();
    startX = e.clientX;
    startWidth = filePanelEl.offsetWidth;
    filePanelResizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    const delta = startX - e.clientX;
    const newWidth = Math.max(MIN_PANEL_WIDTH, startWidth + delta);
    filePanelEl.style.width = newWidth + 'px';
  }

  function onMouseUp() {
    filePanelResizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    const w = filePanelEl.offsetWidth;
    localStorage.setItem(PANEL_WIDTH_KEY, w);
    if (currentPanelSessionId) {
      const state = getSessionState(currentPanelSessionId);
      state.panelWidth = w;
    }

    refitActiveTerminal();
  }

  filePanelResizeHandle.addEventListener('mousedown', onMouseDown);
}

// ── Terminal Refit ──────────────────────────────────────────────────

function refitActiveTerminal() {
  requestAnimationFrame(() => {
    if (typeof openSessions !== 'undefined' && currentPanelSessionId) {
      const entry = openSessions.get(currentPanelSessionId);
      if (entry && entry.fitAddon) {
        try { entry.fitAddon.fit(); } catch {}
      }
    }
  });
}

// ── Utility ─────────────────────────────────────────────────────────

function basename(filePath) {
  if (!filePath) return 'untitled';
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'untitled';
}
