// --- Files tab (sidebar) ---
// The agent files (main.js get-memories), the files opened by dropping them on
// the sidebar (files-drop.js; main.js get-opened-files) and the pinned ones,
// in the sections files-list.js decides. A file opens in the main area's
// editor, a tab for each (editor-tabs.js), or in a window of its own (main.js
// openFileWindow). Ctrl/Cmd+click and Shift+click select several rows, to open
// them together. A project's group can be pinned above the others, in an order
// of the user's; a file pinned with its star stays in its project's group,
// ahead of the others. The files with unsaved changes (file-drafts.js), wherever
// they were edited, are listed first, and the sidebar's tab shows a dot. A file
// open in any editor (a project's Files tab, a session's panel, this one) is
// listed too, until it is closed, from here or there.
//
// Depends on globals: memoryContent, memoryViewer, placeholder, EditorTabs,
// terminalArea, planViewer, statsViewer, settingsViewer, processViewer,
// activeTab (app.js); buildFilesSections, filesSectionsEmpty, loadFilesFilter,
// saveFilesFilter, pinnedDropIndex, pinnedShownStep,
// selectionAfterClick (files-list.js); storedEditorTabs, closeFileInEditors
// (editor-tabs.js); projectEditorStorageKey (project-files-view.js);
// fileTabsKey, filePanelState (file-panel.js); openSessions,
// cachedProjectTreeAll, searchInput (app.js); formatDate
// (utils.js); ICONS (icons.js); starIconSvg (sidebar.js); fileIconHtml
// (file-icons.js); showContextMenu (projects-view.js); openUnsupportedFile
// (file-actions.js).

let cachedMemoryData = { global: { files: [] }, projects: [] };
let cachedOpenedFiles = { opened: [], pinned: [], pinnedProjects: [] };
// The rows selected to be opened together, and the last one clicked.
let filesSelection = new Set();
let filesSelectionAnchor = null;
// The open files the list was last drawn with.
let filesDrawnOpen = '';
let filesOpenSyncTimer = null;
let filesFilter = loadFilesFilter(localStorage);
// The paths the search in the field found, or null without a search.
let filesMatchIds = null;
let currentMemoryFilePath = null;
let filesOpenRequest = 0;
let filesEditorTabs = null;
// The files with unsaved changes: [{ filePath, updatedAt, exists }].
let cachedDrafts = [];
let draftsReloadTimer = null;
const memoryCollapsedState = new Map();
const filesFilterSelect = document.getElementById('files-filter-select');
const PINNED_FILE_TYPE = 'application/x-switchboard-pinned-file';
const PINNED_PROJECT_TYPE = 'application/x-switchboard-pinned-files-project';

const BRAIN_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>';
const FILES_ICONS = {
  x: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  up: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>`,
  down: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  here: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>`,
  folder: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
};

function fileBaseName(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || String(filePath || '');
}

function isAgentFilePath(filePath) {
  const data = cachedMemoryData;
  return [...data.global.files, ...data.projects.flatMap(p => p.files)].some(f => f.filePath === filePath);
}

// --- Loading and drawing ---

/** Load both lists and draw the tab. A new visit starts without a search. */
async function loadFiles({ keepSearch = false } = {}) {
  if (!keepSearch) filesMatchIds = null;
  const [memories, opened] = await Promise.all([
    window.api.getMemories().catch(() => null),
    window.api.getOpenedFiles().catch(() => null),
  ]);
  if (memories) cachedMemoryData = memories;
  if (opened) cachedOpenedFiles = opened;
  renderFiles(filesMatchIds);
}

/** The opened and pinned files as main.js returned them after a change. */
function applyOpenedFiles(state) {
  if (!state || !Array.isArray(state.opened) || !Array.isArray(state.pinned)) return;
  cachedOpenedFiles = { opened: state.opened, pinned: state.pinned, pinnedProjects: state.pinnedProjects || [] };
  if (activeTab === 'memory') renderFiles(filesMatchIds);
}

function setFilesFilter(value) {
  saveFilesFilter(localStorage, value);
  filesFilter = loadFilesFilter(localStorage);
  syncFilesFilterSelect();
  if (activeTab === 'memory') renderFiles(filesMatchIds);
}

function syncFilesFilterSelect() {
  if (!filesFilterSelect) return;
  filesFilterSelect.value = filesFilter;
  filesFilterSelect.classList.toggle('is-on', filesFilter !== 'all');
}

if (filesFilterSelect) {
  syncFilesFilterSelect();
  filesFilterSelect.addEventListener('change', () => setFilesFilter(filesFilterSelect.value));
}

function filesEmptyText(matchIds) {
  if (matchIds) return 'No files match the search.';
  if (filesFilter === 'agents') return 'No agent files found.';
  if (filesFilter === 'opened') return 'No opened files. Open one in a project, or drop a file on the sidebar.';
  return 'No files yet. Drop a file on the sidebar to open it.';
}

// --- The open files ---

/** Where the editors remember what they have open: the projects', the sessions', this tab's. */
function openEditorSources() {
  const sources = [];
  for (const project of cachedProjectTreeAll?.projects || []) {
    for (const projectWindow of [false, true]) {
      sources.push({ key: projectEditorStorageKey(project.id, projectWindow), projectId: project.id });
    }
  }
  // The sessions loaded in this window: those of earlier days keep their tabs unseen.
  for (const sessionId of new Set([...openSessions.keys(), ...filePanelState.keys()])) {
    sources.push({ key: fileTabsKey(sessionId), projectId: null });
  }
  sources.push({ key: FILES_TABS_KEY, projectId: null });
  return sources;
}

/** Every file with a tab somewhere, once, with the project whose Files tab holds it. */
function openEditorFiles() {
  const byPath = new Map();
  for (const { key, projectId } of openEditorSources()) {
    for (const { path, data } of storedEditorTabs(key)) {
      if (!byPath.has(path)) byPath.set(path, { filePath: path, projectId: data?.projectId ?? projectId });
    }
  }
  return [...byPath.values()];
}

function openFilesSignature(files) {
  return files.map(file => `${file.projectId}\t${file.filePath}`).sort().join('\n');
}

/** Draw the list again, once, when what is open is no longer what it shows. */
function syncFilesOpenList() {
  clearTimeout(filesOpenSyncTimer);
  filesOpenSyncTimer = setTimeout(() => {
    if (activeTab === 'memory' && openFilesSignature(openEditorFiles()) !== filesDrawnOpen) renderFiles(filesMatchIds);
  }, 0);
}

/**
 * Close a file the list holds as open: in every editor, then off the dropped
 * ones. Off that list a pinned file is unpinned too, so it asks first.
 */
async function closeListedFile(filePath, { confirmed = false } = {}) {
  if (!(await closeFileInEditors(filePath, openEditorSources().map(source => source.key)))) return;
  if (cachedOpenedFiles.opened.some(f => f.filePath === filePath)) await removeFileFromList(filePath, { confirmed });
  renderFiles(filesMatchIds);
}

/** Draw the tab, narrowed to `matchIds` (the paths a search found) when given. */
function renderFiles(matchIds = null) {
  filesMatchIds = matchIds;
  const open = openEditorFiles();
  filesDrawnOpen = openFilesSignature(open);
  const sections = buildFilesSections({
    agents: cachedMemoryData, opened: cachedOpenedFiles, filter: filesFilter, matchIds,
    open, projects: cachedProjectTreeAll?.projects || [], query: matchIds ? searchInput.value : '',
  });
  memoryContent.innerHTML = '';
  // A search shows what it found; otherwise the unsaved files come first.
  const unsaved = matchIds ? [] : cachedDrafts;
  if (filesSectionsEmpty(sections) && !unsaved.length) {
    filesSelection.clear();
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = filesEmptyText(matchIds);
    memoryContent.appendChild(empty);
    return;
  }
  const openedPaths = new Set(cachedOpenedFiles.opened.map(f => f.filePath));
  if (unsaved.length) {
    const rows = unsaved.map(buildUnsavedItem);
    memoryContent.appendChild(buildMemoryGroup('__unsaved__', 'Unsaved changes', rows, { className: 'files-unsaved-group' }));
  }
  // "Opened files" lists open files in its groups; the other filters under Opened only.
  const openView = sections.filter === 'opened';
  const openPaths = new Set(open.map(f => f.filePath));
  const isOpen = (filePath) => openPaths.has(filePath) || openedPaths.has(filePath);
  let sortables = 0;
  // The rows of one group: its pinned ones are ordered among themselves.
  const groupRows = (files, { listed = (filePath) => openView && isOpen(filePath) } = {}) => {
    const pins = { type: `${PINNED_FILE_TYPE}-${sortables++}`, paths: files.map(f => f.filePath).filter(isPinnedFilePath) };
    return files.map(file => buildFileItem(file, {
      agent: isAgentFilePath(file.filePath), opened: openedPaths.has(file.filePath),
      pinned: isPinnedFilePath(file.filePath), listed: listed(file.filePath), pins,
    }));
  };
  if (sections.pinned.length) {
    memoryContent.appendChild(buildMemoryGroup('__pinned__', 'Pinned', groupRows(sections.pinned), { className: 'files-pinned-group' }));
  }
  const shownPinned = sections.pinnedGroups.map(g => g.pinKey);
  const appendProjectGroup = (group, pinned) => {
    const project = group.pinKey ? { key: group.pinKey, pinned, shownPinned } : null;
    memoryContent.appendChild(buildMemoryGroup(group.key, group.label, groupRows(group.files), { project }));
  };
  for (const group of sections.pinnedGroups) appendProjectGroup(group, true);
  if (sections.opened.length) {
    const rows = groupRows(sections.opened, { listed: () => true });
    memoryContent.appendChild(buildMemoryGroup('__opened__', 'Opened', rows));
  }
  for (const group of sections.groups) appendProjectGroup(group, false);
  drawFilesSelection();
  if (currentMemoryFilePath) markActiveFile(currentMemoryFilePath);
}

/** A section of the tab. `project` is given for a project's group, which can be pinned. */
function buildMemoryGroup(key, label, rows, { className = '', project = null } = {}) {
  const group = document.createElement('div');
  group.className = 'project-group' + (className ? ` ${className}` : '') + (project?.pinned ? ' files-pinned-project' : '');
  const isCollapsed = memoryCollapsedState.get(key) === true; // default expanded
  if (isCollapsed) group.classList.add('collapsed');

  // Header
  const header = document.createElement('div');
  header.className = 'project-header';

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.innerHTML = '&#9660;';
  header.appendChild(arrow);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'project-name';
  nameSpan.textContent = label;
  header.appendChild(nameSpan);

  if (project) {
    const pin = fileRowButton(`files-pin-btn files-project-pin${project.pinned ? ' on' : ''}`,
      project.pinned ? 'Unpin project' : 'Pin project to the top', starIconSvg(project.pinned, 13),
      () => toggleProjectPinned(project.key, !project.pinned));
    pin.setAttribute('aria-pressed', String(project.pinned));
    header.appendChild(pin);
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showProjectGroupMenu(project, { x: e.clientX, y: e.clientY });
    });
    if (project.pinned) {
      bindPinnedDrag(group, project.key, {
        handle: header, type: PINNED_PROJECT_TYPE, ids: () => cachedOpenedFiles.pinnedProjects, move: moveProjectPinned,
      });
    }
  }

  const countBadge = document.createElement('span');
  countBadge.className = 'memory-file-count';
  countBadge.textContent = rows.length;
  header.appendChild(countBadge);

  header.addEventListener('click', () => {
    const nowCollapsed = !group.classList.contains('collapsed');
    group.classList.toggle('collapsed');
    memoryCollapsedState.set(key, nowCollapsed);
  });

  group.appendChild(header);

  // Files list
  const filesList = document.createElement('div');
  filesList.className = 'project-sessions';
  for (const row of rows) filesList.appendChild(row);
  group.appendChild(filesList);

  return group;
}

function showProjectGroupMenu({ key, pinned, shownPinned }, position) {
  const items = [
    { label: pinned ? 'Unpin project' : 'Pin project to the top', icon: starIconSvg(!pinned, 14), onClick: () => toggleProjectPinned(key, !pinned) },
  ];
  if (pinned) {
    const all = cachedOpenedFiles.pinnedProjects;
    const up = pinnedShownStep(all, shownPinned, key, -1);
    const down = pinnedShownStep(all, shownPinned, key, 1);
    items.push(
      { label: 'Move up', icon: FILES_ICONS.up(14), disabled: up === null, onClick: () => moveProjectPinned(key, up) },
      { label: 'Move down', icon: FILES_ICONS.down(14), disabled: down === null, onClick: () => moveProjectPinned(key, down) },
    );
  }
  showContextMenu(items, position);
}

function fileRowIcon(file, agent) {
  const icon = document.createElement('span');
  // Agent files keep their icons: a clock for schedule-*.md, a brain for the rest.
  if (agent) {
    const isSchedule = file.filename.startsWith('schedule-');
    icon.className = isSchedule ? 'memory-schedule-icon' : 'memory-brain-icon';
    icon.innerHTML = isSchedule ? ICONS.schedule(15) : BRAIN_ICON;
  } else {
    icon.className = 'memory-file-icon';
    icon.innerHTML = typeof fileIconHtml === 'function' ? fileIconHtml(file.filename) : '';
  }
  return icon;
}

function fileRowButton(className, title, html, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `session-move-btn ${className}`;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = html;
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

/** A row of the tab, as the agent files' rows have always looked. */
function buildFileItem(file, { agent, opened, pinned, listed = false, pins = null }) {
  const item = document.createElement('div');
  item.className = 'session-item memory-item' + (pinned ? ' is-pinned' : '');
  item.dataset.filepath = file.filePath;
  const missing = file.exists === false;
  if (missing) item.classList.add('is-missing');

  const row = document.createElement('div');
  row.className = 'session-row';
  row.appendChild(fileRowIcon(file, agent));

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-summary';
  if (file.projectName) {
    const projectEl = document.createElement('span');
    projectEl.className = 'files-row-project';
    projectEl.textContent = file.projectName;
    projectEl.title = file.projectName;
    const separator = document.createElement('span');
    separator.className = 'files-row-project-separator';
    separator.textContent = ' · ';
    titleEl.append(projectEl, separator, file.filename);
  } else {
    titleEl.textContent = file.filename;
  }

  const pathEl = document.createElement('div');
  pathEl.className = 'session-id';
  pathEl.textContent = file.displayPath || '';
  pathEl.title = file.filePath;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = missing ? 'File not found' : (file.modified ? formatDate(new Date(file.modified)) : '');

  info.appendChild(titleEl);
  info.appendChild(pathEl);
  info.appendChild(metaEl);
  row.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'session-actions';
  const pin = fileRowButton(`files-pin-btn${pinned ? ' on' : ''}`, pinned ? 'Unpin' : 'Pin to the top',
    starIconSvg(pinned, 14), () => toggleFilePinned(file.filePath, !pinned));
  pin.setAttribute('aria-pressed', String(pinned));
  actions.appendChild(pin);
  if (listed) {
    actions.appendChild(fileRowButton('files-remove-btn', 'Close', FILES_ICONS.x(14),
      () => closeListedFile(file.filePath)));
  } else if (opened) {
    actions.appendChild(fileRowButton('files-remove-btn', 'Remove from list', FILES_ICONS.x(14),
      () => removeFileFromList(file.filePath)));
  }
  row.appendChild(actions);
  item.appendChild(row);

  item.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) { selectFileRow(item, e.shiftKey); return; }
    clearFilesSelection();
    filesSelectionAnchor = file.filePath;
    if (missing) { offerRemoveMissing(file, { opened, pinned, listed }); return; }
    openFileHere(file.filePath);
  });
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const position = { x: e.clientX, y: e.clientY };
    if (filesSelection.size > 1 && filesSelection.has(file.filePath)) showSelectionMenu(position);
    else showFileMenu(file, { agent, opened, pinned, missing, listed, pins }, position);
  });
  if (pinned && pins) {
    bindPinnedDrag(item, file.filePath, {
      type: pins.type, ids: () => cachedOpenedFiles.pinned.map(f => f.filePath), move: moveFilePinned,
    });
  }
  return item;
}

/** A file with unsaved changes: opening it shows them, also when the file itself is gone. */
function buildUnsavedItem(draft) {
  const file = {
    filePath: draft.filePath, filename: fileBaseName(draft.filePath),
    displayPath: draft.filePath, modified: draft.updatedAt, exists: true,
  };
  const item = buildFileItem(file, {
    agent: isAgentFilePath(draft.filePath), opened: false,
    pinned: isPinnedFilePath(draft.filePath),
  });
  if (!draft.exists) item.querySelector('.session-meta').textContent = 'File not found · changes kept';
  return item;
}

// --- Files with unsaved changes ---

async function loadDrafts() {
  const drafts = await window.api.listDrafts().catch(() => null);
  if (!Array.isArray(drafts)) return;
  const paths = list => list.map(d => d.filePath).join('\n');
  const changed = paths(drafts) !== paths(cachedDrafts);
  cachedDrafts = drafts;
  const tab = document.querySelector('.sidebar-tab[data-tab="memory"]');
  tab?.classList.toggle('has-unsaved', drafts.length > 0);
  if (changed && activeTab === 'memory') renderFiles(filesMatchIds);
}

// A project window has no sidebar to list them in (project-window.js).
if (window.api.listDrafts && !(typeof PROJECT_WINDOW !== 'undefined' && PROJECT_WINDOW)) {
  window.addEventListener('viewer-drafts-changed', () => {
    clearTimeout(draftsReloadTimer);
    draftsReloadTimer = setTimeout(loadDrafts, 500);
  });
  // The scripts after this one declare what drawing the list needs.
  setTimeout(loadDrafts, 0);
  // Files opened or closed in this window's editors, or in a project's window.
  window.addEventListener('editor-tabs-changed', syncFilesOpenList);
  window.addEventListener('storage', (event) => {
    if (event.key?.startsWith('editorTabs:')) syncFilesOpenList();
  });
}

async function offerRemoveMissing(file, { opened, pinned, listed }) {
  if (!opened && !pinned) return;
  const what = !opened ? 'Unpin it?'
    : pinned ? 'It is pinned. Are you sure you want to remove it from the list?'
    : 'Remove it from the list?';
  if (!confirm(`${file.filename} is no longer at\n${file.filePath}\n\n${what}`)) return;
  if (listed) await closeListedFile(file.filePath, { confirmed: true });
  else if (opened) await removeFileFromList(file.filePath, { confirmed: true });
  if (!opened) await toggleFilePinned(file.filePath, false);
}

function showFileMenu(file, { opened, pinned, missing, listed, pins }, position) {
  const revealLabel = window.api.platform === 'darwin' ? 'Reveal in Finder'
    : window.api.platform === 'win32' ? 'Show in Explorer' : 'Show in folder';
  const items = [
    { label: 'Open here', icon: FILES_ICONS.here(14), disabled: missing, onClick: () => openFileHere(file.filePath) },
    { label: 'Open in new window', icon: ICONS.popOut(14), disabled: missing, onClick: () => openFileInWindow(file.filePath) },
    { sep: true },
    { label: pinned ? 'Unpin' : 'Pin to the top', icon: starIconSvg(!pinned, 14), onClick: () => toggleFilePinned(file.filePath, !pinned) },
  ];
  if (pinned && pins) {
    const all = cachedOpenedFiles.pinned.map(f => f.filePath);
    const up = pinnedShownStep(all, pins.paths, file.filePath, -1);
    const down = pinnedShownStep(all, pins.paths, file.filePath, 1);
    items.push(
      { label: 'Move up', icon: FILES_ICONS.up(14), disabled: up === null, onClick: () => moveFilePinned(file.filePath, up) },
      { label: 'Move down', icon: FILES_ICONS.down(14), disabled: down === null, onClick: () => moveFilePinned(file.filePath, down) },
    );
  }
  items.push({ sep: true }, { label: revealLabel, icon: ICONS.folderOpen(14), disabled: missing, onClick: () => window.api.revealFile(file.filePath) });
  if (listed) items.push({ label: 'Close', icon: FILES_ICONS.x(14), onClick: () => closeListedFile(file.filePath) });
  else if (opened) items.push({ label: 'Remove from list', icon: FILES_ICONS.x(14), danger: true, onClick: () => removeFileFromList(file.filePath) });
  showContextMenu(items, position);
}

// --- Several files at once ---

/** The paths in the order their rows show, each once. */
function shownFilePaths(within = memoryContent) {
  return [...new Set([...within.querySelectorAll('.memory-item')].map(el => el.dataset.filepath))];
}

function selectFileRow(row, range) {
  // A file can show in its project and under Opened: a range stays in the group clicked when it can.
  const group = row.closest('.project-group');
  const inGroup = range && group && shownFilePaths(group).includes(filesSelectionAnchor);
  const next = selectionAfterClick({
    selected: filesSelection, order: shownFilePaths(inGroup ? group : memoryContent),
    anchor: filesSelectionAnchor, clicked: row.dataset.filepath, range,
  });
  filesSelection = next.selected;
  filesSelectionAnchor = next.anchor;
  drawFilesSelection();
}

function clearFilesSelection() {
  if (!filesSelection.size) return;
  filesSelection = new Set();
  drawFilesSelection();
}

/** Mark the selected rows, and the bar over the list that opens them. */
function drawFilesSelection() {
  const shown = new Set(shownFilePaths());
  filesSelection = new Set([...filesSelection].filter(filePath => shown.has(filePath)));
  memoryContent.querySelectorAll('.memory-item').forEach((el) => {
    el.classList.toggle('is-selected', filesSelection.has(el.dataset.filepath));
  });
  memoryContent.querySelector('.files-selection-bar')?.remove();
  if (!filesSelection.size) return;
  const bar = document.createElement('div');
  bar.className = 'files-selection-bar';
  const count = document.createElement('span');
  count.textContent = `${filesSelection.size} selected`;
  const button = (className, label, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  };
  bar.appendChild(count);
  bar.appendChild(button('files-selection-open', 'Open', () => openSelectedFiles('here')));
  bar.appendChild(button('files-selection-clear', 'Clear', clearFilesSelection));
  memoryContent.prepend(bar);
}

function showSelectionMenu(position) {
  const count = filesSelection.size;
  showContextMenu([
    { label: `Open ${count} files here`, icon: FILES_ICONS.here(14), onClick: () => openSelectedFiles('here') },
    { label: `Open ${count} files in new windows`, icon: ICONS.popOut(14), onClick: () => openSelectedFiles('window') },
    { sep: true },
    { label: 'Clear selection', icon: FILES_ICONS.x(14), onClick: clearFilesSelection },
  ], position);
}

/** Every selected file still there, in the order of the rows, in tabs or in windows. */
async function openSelectedFiles(target) {
  const missing = new Set([...memoryContent.querySelectorAll('.memory-item.is-missing')].map(el => el.dataset.filepath));
  const paths = shownFilePaths().filter(filePath => filesSelection.has(filePath) && !missing.has(filePath));
  clearFilesSelection();
  await openSeveral(paths, target);
}

/** Each in a tab, the first one in front; or each in a window of its own. */
async function openSeveral(paths, target) {
  if (target === 'window') {
    for (const filePath of paths) await openFileInWindow(filePath);
    return;
  }
  for (const filePath of paths) await openFileHere(filePath);
  if (paths.length > 1) await openFileHere(paths[0]);
}

// --- Pinned files and projects: order by dragging ---

/**
 * A pinned row, or a pinned project's group (dragged by its header), moved by
 * dragging it onto another of its kind.
 */
function bindPinnedDrag(item, id, { handle = item, type, ids, move }) {
  handle.draggable = true;
  handle.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData(type, id);
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('is-dragging');
  });
  handle.addEventListener('dragend', () => {
    item.classList.remove('is-dragging');
    clearPinnedDropMarks();
  });
  const accepts = (e) => Array.from(e.dataTransfer?.types || []).includes(type);
  const lowerHalf = (e) => {
    const rect = item.getBoundingClientRect();
    return e.clientY > rect.top + rect.height / 2;
  };
  item.addEventListener('dragover', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearPinnedDropMarks(item);
    const after = lowerHalf(e);
    item.classList.toggle('drop-after', after);
    item.classList.toggle('drop-before', !after);
  });
  item.addEventListener('dragleave', (e) => {
    if (!item.contains(e.relatedTarget)) item.classList.remove('drop-before', 'drop-after');
  });
  item.addEventListener('drop', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const from = e.dataTransfer.getData(type);
    const after = lowerHalf(e);
    clearPinnedDropMarks();
    const index = pinnedDropIndex(ids(), from, id, after);
    if (index !== null) move(from, index);
  });
}

function clearPinnedDropMarks(except) {
  memoryContent.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
    if (el !== except) el.classList.remove('drop-before', 'drop-after');
  });
}

// --- Changes to the list ---

async function toggleFilePinned(filePath, pinned) {
  try { applyOpenedFiles(await window.api.setFilePinned(filePath, pinned)); }
  catch (err) { alert(err.message || 'Could not change the pin.'); }
}

async function moveFilePinned(filePath, toIndex) {
  if (toIndex === null || toIndex === undefined) return;
  try { applyOpenedFiles(await window.api.movePinnedFile(filePath, toIndex)); }
  catch (err) { alert(err.message || 'Could not move the file.'); }
}

function isPinnedFilePath(filePath) {
  return cachedOpenedFiles.pinned.some(f => f.filePath === filePath);
}

async function toggleProjectPinned(key, pinned) {
  try { applyOpenedFiles(await window.api.setFilesProjectPinned(key, pinned)); }
  catch (err) { alert(err.message || 'Could not change the pin.'); }
}

async function moveProjectPinned(key, toIndex) {
  if (toIndex === null || toIndex === undefined) return;
  try { applyOpenedFiles(await window.api.movePinnedFilesProject(key, toIndex)); }
  catch (err) { alert(err.message || 'Could not move the project.'); }
}

/**
 * As if the file had never been opened in the app. The file itself stays where
 * it is. A pinned file is unpinned too, so it asks first, unless the caller
 * already did (`confirmed`).
 */
async function removeFileFromList(filePath, { confirmed = false } = {}) {
  if (!confirmed && isPinnedFilePath(filePath)
    && !confirm(`“${fileBaseName(filePath)}” is pinned. Are you sure you want to remove it from the list?\n\nIt is unpinned too. The file itself stays on disk.`)) return;
  try { applyOpenedFiles(await window.api.removeOpenedFile(filePath)); }
  catch (err) { alert(err.message || 'Could not remove the file from the list.'); }
}

// --- Opening a file ---

/** Every row of the file marked; returns the one to scroll to: one in sight, else the first. */
function markActiveFile(filePath) {
  memoryContent.querySelectorAll('.memory-item.active').forEach(el => el.classList.remove('active'));
  const rows = [...memoryContent.querySelectorAll(`.memory-item[data-filepath="${CSS.escape(filePath)}"]`)];
  for (const row of rows) row.classList.add('active');
  const view = memoryContent.getBoundingClientRect();
  return rows.find((row) => {
    const rect = row.getBoundingClientRect();
    return rect.height > 0 && rect.top >= view.top && rect.bottom <= view.bottom;
  }) || rows[0] || null;
}

const FILES_TABS_KEY = 'editorTabs:files';

/** The files open when the app last closed, back in the main area when nothing else is in it. */
function restoreFilesEditor() {
  if (placeholder.style.display === 'none' || !localStorage.getItem(FILES_TABS_KEY)) return;
  const tab = ensureFilesEditor().lastUsed();
  if (tab) openFileHere(tab.path);
}

function ensureFilesEditor() {
  if (filesEditorTabs) return filesEditorTabs;
  filesEditorTabs = new EditorTabs(memoryViewer, {
    storageKey: FILES_TABS_KEY,
    createPanel: (element, tab, shared) => new ViewerPanel(element, {
      ...shared,
      copyPath: true, copyContent: true, language: 'auto', storageKey: 'markdownPreviewMode',
      onSave: (filePath, content, options) => saveFilesViewFile(filePath, content, options),
      onPopOut: () => popOutCurrentFile(tab.panel),
      // Go to Definition into another file: in a tab of its own.
      openFile: (filePath, at) => openFileHere(filePath, at),
    }),
    onSelect: (tab) => openFileHere(tab.path),
    projectName: (tab) => editorProjectName(tab.path),
    onActivate: (tab) => {
      currentMemoryFilePath = tab?.path || null;
      if (tab) markActiveFile(tab.path);
      else memoryContent.querySelectorAll('.memory-item.active').forEach(el => el.classList.remove('active'));
    },
    // The last file closed: nothing left to show here.
    onEmpty: () => {
      if (memoryViewer.style.display === 'none') return;
      memoryViewer.style.display = 'none';
      placeholder.style.display = '';
    },
  });
  return filesEditorTabs;
}

/** The main area's editor in sight. */
function showFilesViewer() {
  if (typeof hideProjectChrome === 'function') hideProjectChrome();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  processViewer.style.display = 'none';
  // The message history sits over this viewer when it stays shown (and takes its Cmd+F).
  jsonlViewer.style.display = 'none';
  memoryViewer.style.display = 'flex';
}

/**
 * Show the file in the main area's editor, whatever its kind (text, image,
 * PDF…), in its own tab, at { line, column } when given. Resolves to the tab's
 * viewer, or null when the file cannot be shown.
 */
async function openFileHere(filePath, { line, column } = {}) {
  const tabs = ensureFilesEditor();
  const request = ++filesOpenRequest;
  let tab = tabs.find(filePath);
  // A file already open keeps its tab, with whatever is typed in it.
  if (!tab?.loaded) {
    let result;
    try { result = await window.api.readFileForPanel(filePath); } catch (err) { result = { ok: false, error: err.message }; }
    if (request !== filesOpenRequest) return null;
    tab = tabs.find(filePath);
    // Unsaved text of a file that is gone is still shown, to be saved again.
    const draft = result?.ok ? null : window.api.getDraft?.(filePath);
    if (!result?.ok && !draft) {
      if (tab && !tab.loaded) tabs.remove(tab);
      if (await openUnsupportedFile(result, filePath)) return null;
      alert(result?.error || 'Unable to open the file.');
      return null;
    }
    tab = tabs.add(filePath);
    if (!tab.loaded) tabs.fill(tab, draft ? draft.base : result.content || '', draft ? { missing: true } : result);
  }

  showFilesViewer();
  tabs.activate(tab);
  markActiveFile(filePath)?.scrollIntoView({ block: 'nearest' });
  if (line) tab.panel.goToLocation(line, column);
  return tab.panel;
}

/** After a file action of an explorer: the tabs follow a rename or a move, and close what went to the Trash. */
async function applyFilesViewFileAction(change) {
  const tabs = ensureFilesEditor();
  for (const tab of [...tabs.tabs]) {
    const next = remapFileActionPath(tab.path, change);
    if (next === tab.path) continue;
    if (next) await tabs.relocate(tab, next);
    else tabs.remove(tab, { discard: true });
  }
}

function openFileInWindow(filePath) {
  return window.api.openFileWindow(filePath).then((opened) => {
    if (!opened) alert(`Could not open ${fileBaseName(filePath)} in a window: it is no longer there.`);
  }).catch(err => alert(err.message || 'Could not open the window.'));
}

/** The editor's pop-out: what it shows, saved first, in a window of its own. */
async function popOutCurrentFile(panel) {
  const filePath = panel?.filePath;
  if (!filePath) return;
  if (panel.isDirty()) await panel.flush();
  openFileInWindow(filePath);
}

/** The editor's Save: agent files as before (save-memory), any other file as the file panel does. */
function saveFilesViewFile(filePath, content, options) {
  return !options?.create && isAgentFilePath(filePath) && /\.md$/i.test(filePath)
    ? window.api.saveMemory(filePath, content)
    : window.api.saveFileForPanel(filePath, content, options);
}

/**
 * Files dropped on the sidebar (files-drop.js): into the list, then each in a
 * tab of the Files tab's editor (`here`) or in a window of its own (`window`).
 */
async function openDroppedFiles(paths, target) {
  if (!paths.length) return;
  let result;
  try { result = await window.api.addOpenedFiles(paths); } catch (err) { alert(err.message || 'Could not open the files.'); return; }
  if (!result) return;
  applyOpenedFiles(result);
  if (result.rejected?.length) {
    const lines = result.rejected.map(r => `${fileBaseName(r.filePath)}: ${r.reason}`);
    alert(`${lines.length === 1 ? 'This item' : 'These items'} could not be opened:\n\n${lines.join('\n')}`);
  }
  const files = result.added || [];
  if (!files.length) return;

  // Open here: the Files tab, with the file in sight.
  if (target !== 'window') {
    if (filesFilter === 'agents') setFilesFilter('all');
    if (activeTab !== 'memory') document.querySelector('.sidebar-tab[data-tab="memory"]')?.click();
    else renderFiles(filesMatchIds);
  }
  await openSeveral(files, target);
}
