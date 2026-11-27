// note-panel.js — a project's notes pad: note.md in the project folder, made
// the first time it is opened (the Note button in a project's header and the
// Note row of its menu).
//
// It opens in a panel floating over the app, moved by its bar and resized
// from its corner, which opens again where it was left and at the size it
// had. Its pop-out button moves it to a window of its own (main.js
// openProjectWindow, tab 'note'), where the same editor fills the window.
// The editor is the file editor's (ViewerPanel), with the same buttons; the
// note saves itself a second after the typing stops, and Save or Cmd/Ctrl+S
// still save at once.
//
// One floating note at a time: opening another project's note saves the one
// open and shows the new one in its place. Depends on viewer-panel.js and on
// PROJECT_WINDOW (project-window.js).

const NOTE_FILE = 'note.md';
const NOTE_AUTOSAVE_MS = 1000;
const NOTE_BOUNDS_KEY = 'notePanelBounds';
const NOTE_MIN_SIZE = { width: 320, height: 220 };
const NOTE_DEFAULT_SIZE = { width: 480, height: 440 };
// Room kept at the bottom for the status bar when the panel is first placed.
const NOTE_BOTTOM_GAP = 40;

let notePanel = null; // the floating panel: { el, host, panel, projectId, request }
let noteWindowEditor = null; // the editor of a note window: { host, panel, projectId }

/** The options of a note's editor; the same editor as the Files tab, which saves by itself. */
function noteEditorOptions(extra = {}) {
  return {
    copyPath: true,
    copyContent: true,
    language: 'auto',
    storageKey: 'notePreviewMode',
    autosaveMs: NOTE_AUTOSAVE_MS,
    onSave: saveProjectNote,
    // This editor stays the note's: a linked file opens in a window of its own.
    openLinked: (filePath) => openFileInWindow(filePath),
    ...extra,
  };
}

async function saveProjectNote(filePath, content) {
  let result;
  try { result = await window.api.saveFileForPanel(filePath, content); } catch (err) { result = { ok: false, error: err.message }; }
  if (!result || result.error || result.ok === false) {
    alert(result?.error || 'Could not save the note.');
    return { ok: false };
  }
  return { ok: true };
}

/** note.md of the project, made when it is not there yet: its path, its text and how to show it. */
async function readProjectNote(project) {
  let created;
  try { created = await window.api.createProjectFile(project.id, NOTE_FILE); } catch (err) { created = { error: err.message }; }
  if (!created?.ok || !created.filePath) return { ok: false, error: created?.error || 'Could not create note.md.' };
  let read;
  try { read = await window.api.readFileForPanel(created.filePath); } catch (err) { read = { ok: false, error: err.message }; }
  if (!read?.ok) return { ok: false, error: read?.error || 'Could not read note.md.' };
  return { ok: true, filePath: created.filePath, content: read.content || '', read };
}

function noteTitle(project) {
  return `${project.name} · Note`;
}

// --- The floating panel ---

function readNoteBounds() {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTE_BOUNDS_KEY) || 'null');
    if (saved && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(saved[k]))) return saved;
  } catch {}
  return null;
}

function saveNoteBounds(bounds) {
  try { localStorage.setItem(NOTE_BOUNDS_KEY, JSON.stringify(bounds)); } catch {}
}

/** `bounds` made to fit the window: never smaller than the minimum, never past an edge. */
function fitNoteBounds(bounds) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.round(Math.min(vw, Math.max(NOTE_MIN_SIZE.width, bounds.width)));
  const height = Math.round(Math.min(vh, Math.max(NOTE_MIN_SIZE.height, bounds.height)));
  const x = Math.round(Math.min(Math.max(0, bounds.x), Math.max(0, vw - width)));
  const y = Math.round(Math.min(Math.max(0, bounds.y), Math.max(0, vh - height)));
  return { x, y, width, height };
}

/** Where the panel opens: where it was left, or at first in the bottom right corner. */
function initialNoteBounds() {
  const saved = readNoteBounds();
  if (saved) return fitNoteBounds(saved);
  const { width, height } = NOTE_DEFAULT_SIZE;
  return fitNoteBounds({ x: window.innerWidth - width - 24, y: window.innerHeight - height - NOTE_BOTTOM_GAP, width, height });
}

function placeNotePanel(bounds) {
  const { el } = notePanel;
  el.style.left = `${bounds.x}px`;
  el.style.top = `${bounds.y}px`;
  el.style.width = `${bounds.width}px`;
  el.style.height = `${bounds.height}px`;
}

function currentNoteBounds() {
  const { el } = notePanel;
  return { x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
}

/**
 * Follow the pointer from `start` until it is released, calling `move` with
 * how far it went; then keep where the panel ended up.
 */
function trackNotePointer(event, handle, move) {
  event.preventDefault();
  const from = { x: event.clientX, y: event.clientY };
  const start = currentNoteBounds();
  notePanel.el.classList.add('note-float--moving');
  handle.setPointerCapture(event.pointerId);
  const onMove = (e) => placeNotePanel(fitNoteBounds(move(start, e.clientX - from.x, e.clientY - from.y)));
  const onEnd = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    notePanel.el.classList.remove('note-float--moving');
    saveNoteBounds(currentNoteBounds());
    notePanel.panel.editorView?.requestMeasure();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
}

function ensureNotePanel() {
  if (notePanel) return notePanel;
  const el = document.createElement('div');
  el.className = 'note-float';
  el.setAttribute('role', 'dialog');
  el.hidden = true;
  const host = document.createElement('div');
  host.className = 'note-float-body';
  const grip = document.createElement('div');
  grip.className = 'note-float-resize';
  grip.title = 'Drag to resize';
  el.append(host, grip);
  document.body.appendChild(el);

  const panel = new ViewerPanel(host, noteEditorOptions({
    onClose: () => closeProjectNote(),
    onPopOut: () => popOutProjectNote(),
  }));
  notePanel = { el, host, panel, projectId: null, request: 0 };

  // The bar moves the panel, except where it has a button or text to select.
  const bar = panel.toolbar.el;
  bar.classList.add('note-float-bar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, a, .viewer-toolbar-path')) return;
    trackNotePointer(e, bar, (start, dx, dy) => ({ ...start, x: start.x + dx, y: start.y + dy }));
  });
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // Growing stops at the window's edge rather than pushing the panel back.
    trackNotePointer(e, grip, (start, dx, dy) => ({
      ...start,
      width: Math.min(start.width + dx, window.innerWidth - start.x),
      height: Math.min(start.height + dy, window.innerHeight - start.y),
    }));
  });
  // A smaller window keeps the panel inside it, without forgetting where it was put.
  window.addEventListener('resize', () => {
    if (!el.hidden) placeNotePanel(fitNoteBounds(readNoteBounds() || currentNoteBounds()));
  });
  // Typing in the last second before the window goes: write it out.
  window.addEventListener('beforeunload', () => { if (notePanel.projectId) notePanel.panel.flush(); });
  return notePanel;
}

/** Open the project's note in the floating panel, or bring its window forward when it has one. */
async function openProjectNote(project) {
  if (!project) return;
  // Already in a window of its own: the same file edited in two places would fight.
  try {
    if (await window.api.focusProjectWindow(project.id, 'note')) return;
  } catch {}
  const np = ensureNotePanel();
  const request = ++np.request;
  if (np.projectId === project.id && !np.el.hidden) {
    np.panel.editorView?.focus();
    return;
  }
  if (np.projectId) await np.panel.flush();
  const note = await readProjectNote(project);
  if (request !== np.request) return;
  if (!note.ok) {
    alert(note.error);
    return;
  }
  np.projectId = project.id;
  np.el.setAttribute('aria-label', noteTitle(project));
  np.panel.open(noteTitle(project), note.filePath, note.content, note.read);
  const wasHidden = np.el.hidden;
  np.el.hidden = false;
  if (wasHidden) placeNotePanel(initialNoteBounds());
  np.panel.editorView?.requestMeasure();
  if (!np.panel.previewMode) np.panel.editorView?.focus();
}

/** Save what is typed and close the panel; it opens again where it is now. */
async function closeProjectNote() {
  const np = notePanel;
  if (!np || np.el.hidden) return;
  np.request++;
  await np.panel.flush();
  saveNoteBounds(currentNoteBounds());
  np.el.hidden = true;
  np.panel.destroy();
  np.projectId = null;
}

/** Move the note to a window of its own. */
async function popOutProjectNote() {
  const projectId = notePanel?.projectId;
  if (!projectId) return;
  await closeProjectNote();
  window.api.openProjectWindow(projectId, 'note');
}

// --- The note in a window of its own (PROJECT_WINDOW.tab === 'note') ---

/**
 * The window's body: the note's editor, filling it. Kept across the
 * re-renders every project change triggers, so typing is never lost.
 */
function renderNoteWindow(project, body) {
  if (noteWindowEditor && noteWindowEditor.projectId === project.id) {
    if (noteWindowEditor.host.parentElement !== body) body.replaceChildren(noteWindowEditor.host);
    return;
  }
  const host = document.createElement('div');
  host.className = 'note-window-body';
  const panel = new ViewerPanel(host, noteEditorOptions());
  noteWindowEditor = { host, panel, projectId: project.id };
  body.replaceChildren(host);
  window.addEventListener('beforeunload', () => panel.flush());
  readProjectNote(project).then((note) => {
    if (!note.ok) {
      const error = document.createElement('div');
      error.className = 'note-window-error';
      error.textContent = note.error;
      host.appendChild(error);
      return;
    }
    panel.open(noteTitle(project), note.filePath, note.content, note.read);
    if (!panel.previewMode) panel.editorView?.focus();
  });
}
