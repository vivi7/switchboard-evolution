// --- Projects tab (v2) ---
// A project is a piece of work with a folder on disk (main: projects.js).
// The Projects tab is not another session tree. The sidebar lists projects,
// nothing else. Selecting one opens its workspace in the main area:
//
//   Overview  — header, then tracks as cards beside the plan, todos
//               and folders. Settings is a second tab of the same page.
//   Session   — opening one of its sessions keeps you in the project: the
//               header and tabs stay, and the Session tab shows the terminal
//               (or the messages, or a task log) under them.
//
// The chevron before a project row opens a drawer under it with the
// project's sessions, grouped by time, track or state, plus its plan and
// todo counts.
//
// Right-click works on a project, a track and a session.
//
// Depends on globals from app.js: projectsContent, cachedProjectTree,
// cachedProjectTreeAll, showArchived, searchMatchIds, searchInput,
// activeSessionId, activePtyIds, attentionSessions, responseReadySessions,
// sessionBusyState, sessionMap, pendingSessions, openSessions, activeTab,
// gridViewActive, visibleSessionCount, loadProjects, refreshSidebar, launchNewSession,
// openSession, pollActiveSessions, placeholder, terminalArea, memoryViewer,
// memoryPanel, hideAllViewers, showSession, fitAndScroll,
// resolveDefaultSessionOptions
// Depends on sidebar.js: isSessionRunning
// Depends on task-runner.js: showTaskPopover, tasksByPath, updateTaskButton,
// activeTaskView
// Depends on dialogs.js: showNewSessionDialog, launchTerminalSession, forkSession
// Depends on schedules.js: schedulesForProject, showProjectScheduleMenu,
// showScheduleDialog, scheduleChipHtml
// Depends on utils.js / icons.js: escapeHtml, formatDate, cleanDisplayName, ICONS

let openProjectPopover = null;
let openCtxMenu = null;

const projectsUi = {
  selectedProjectId: sessionStorage.getItem('projects.selected') || null,
  // Each project owns its runtime-only navigation state. Nothing here is
  // persisted: projects start on their Overview tab after an app restart.
  // sessionId is the session the Session tab shows; it outlives a switch to
  // another tab so the Session tab can bring it back.
  navigationByProject: new Map(), // projectId → { tab, sessionId }
  trackByProject: (() => { try { return JSON.parse(sessionStorage.getItem('projects.track') || '{}'); } catch { return {}; } })(),
  // How every drawer groups its sessions: 'time', 'track' or 'state'. One
  // choice for all projects, set from the combo beside the search field.
  groupMode: (() => { try { return localStorage.getItem('projects.groupMode') || 'time'; } catch { return 'time'; } })(),
  // projectId → true while its sessions drawer is open in the sidebar. Kept
  // across a reload of the window, not across a restart: drawers start closed.
  expandedProjects: (() => { try { return JSON.parse(sessionStorage.getItem('projects.expanded') || '{}'); } catch { return {}; } })(),
  // While a search runs, drawers with matching sessions open by themselves.
  // A chevron click during the search wins over that: projectId → open.
  searchDrawerOverride: new Map(),
  // The "No project" row: open, and which of its folders the user folded or unfolded.
  otherOpen: sessionStorage.getItem('projects.otherOpen') === '1',
  otherFolders: {}, // projectPath → true (open) / false (closed)
  expandedLists: {},
  // True while the Session tab is on screen: the terminal sits under the page header.
  working: false,
  doneOpen: false,
  snoozedOpen: false,
  // `${projectId}:${trackKey}` → true while a done track's card is expanded.
  // Done cards collapse to their heading; this is the user peeking inside.
  doneCardsOpen: {},
  // Ids of the projects the list last showed as snoozed. The session poll
  // compares against it to notice a snoozed project raising its hand.
  snoozedKey: '',
  // 'pane:<projectId>' or 'card:<projectId>:<trackKey>' → true while its archived list is open
  archivedOpen: (() => { try { return JSON.parse(sessionStorage.getItem('projects.archivedOpen') || '{}'); } catch { return {}; } })(),
  files: new Map(), // `${projectId}:${name}` → { content, at }
  git: new Map(), // projectId → { at, byPath } from get-project-git-status
};

// Last completed assistant turns are loaded lazily when an overview row is
// hovered. The event clock changes at the end of every turn, so it also makes a
// natural cache key without polling or rereading a transcript on mouse moves.
const sessionHoverPreviewCache = new Map(); // sessionId -> { eventTime, text }
let sessionHoverPreviewEl = null;
let sessionHoverPreviewRow = null;
let sessionHoverPreviewTimer = null;
let sessionHoverPreviewRequest = 0;

function sessionIsBusy(sessionId) {
  return typeof sessionBusyState !== 'undefined' && sessionBusyState.get(sessionId) === true;
}

function ensureSessionHoverPreview() {
  if (sessionHoverPreviewEl) return sessionHoverPreviewEl;
  const el = document.createElement('div');
  el.className = 'session-turn-preview';
  el.setAttribute('role', 'tooltip');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="session-turn-preview-label">Last AI message</div>'
    + '<div class="session-turn-preview-body"><div class="session-turn-preview-text"></div></div>'
    + '<div class="session-turn-preview-more" hidden>\u2026 message continues</div>';
  document.body.appendChild(el);
  sessionHoverPreviewEl = el;
  return el;
}

function positionSessionHoverPreview(row) {
  const el = ensureSessionHoverPreview();
  const rowRect = row.getBoundingClientRect();
  const margin = 12;
  const gap = 5;
  const maxWidth = Math.min(620, window.innerWidth - margin * 2);
  const width = Math.min(maxWidth, Math.max(360, rowRect.width + 80));
  el.style.width = width + 'px';

  // Keep the preview visually attached to the row instead of sending the eye
  // across the page to a side-aligned tooltip.
  const left = Math.max(margin, Math.min(rowRect.left, window.innerWidth - width - margin));
  el.style.left = Math.round(left) + 'px';

  const height = el.offsetHeight;
  let top = rowRect.bottom + gap;
  if (top + height > window.innerHeight - margin) top = rowRect.top - height - gap;
  top = Math.max(margin, top);
  el.style.top = Math.round(top) + 'px';
}

function hideSessionHoverPreview(sessionId = null) {
  if (sessionId && sessionHoverPreviewRow?.dataset.sessionId !== sessionId) return;
  if (sessionHoverPreviewTimer) clearTimeout(sessionHoverPreviewTimer);
  sessionHoverPreviewTimer = null;
  sessionHoverPreviewRow = null;
  sessionHoverPreviewRequest++;
  if (!sessionHoverPreviewEl) return;
  sessionHoverPreviewEl.classList.remove('visible');
  sessionHoverPreviewEl.setAttribute('aria-hidden', 'true');
}

async function showSessionHoverPreview(row, session) {
  const id = session.sessionId;
  if (sessionIsBusy(id) || !row.matches(':hover')) return;

  const eventTime = sessionEventTime(session);
  let cached = sessionHoverPreviewCache.get(id);
  const request = ++sessionHoverPreviewRequest;
  if (!cached || cached.eventTime !== eventTime) {
    let result;
    try { result = await window.api.getSessionLastMessage(id); } catch { return; }
    if (request !== sessionHoverPreviewRequest) return;
    if (result?.error) return;
    cached = { eventTime, text: result?.text || '', truncated: !!result?.truncated };
    sessionHoverPreviewCache.set(id, cached);
  }

  if (!cached.text || sessionIsBusy(id) || !row.matches(':hover')) return;
  const el = ensureSessionHoverPreview();
  const textEl = el.querySelector('.session-turn-preview-text');
  textEl.innerHTML = typeof renderJsonlText === 'function'
    ? renderJsonlText(cached.text)
    : escapeHtml(cached.text);
  sessionHoverPreviewRow = row;
  el.classList.add('visible');
  el.setAttribute('aria-hidden', 'false');
  // Two ways the preview can be short of the real message: the reader capped
  // the text, or it is taller than the box and CSS clipped it. Both used to
  // end mid-sentence with nothing to show for it. Measuring needs the box
  // laid out, so it happens after .visible.
  const clipped = textEl.scrollHeight > textEl.clientHeight + 1;
  el.querySelector('.session-turn-preview-body').classList.toggle('clipped', clipped);
  el.querySelector('.session-turn-preview-more').hidden = !(clipped || cached.truncated);
  positionSessionHoverPreview(row);
}

function attachSessionHoverPreview(row, session) {
  row.addEventListener('mouseenter', () => {
    hideSessionHoverPreview();
    if (sessionIsBusy(session.sessionId)) return;
    sessionHoverPreviewRow = row;
    sessionHoverPreviewTimer = setTimeout(() => {
      sessionHoverPreviewTimer = null;
      showSessionHoverPreview(row, session);
    }, 350);
  });
  row.addEventListener('mouseleave', () => hideSessionHoverPreview(session.sessionId));
}

function saveProjectsUi() {
  if (projectsUi.selectedProjectId) sessionStorage.setItem('projects.selected', projectsUi.selectedProjectId);
  else sessionStorage.removeItem('projects.selected');
  // Tab selection belongs to each project and intentionally resets on restart.
  sessionStorage.removeItem('projects.tab');
  sessionStorage.setItem('projects.track', JSON.stringify(projectsUi.trackByProject));
  try { localStorage.setItem('projects.groupMode', projectsUi.groupMode); } catch {}
  sessionStorage.setItem('projects.archivedOpen', JSON.stringify(projectsUi.archivedOpen));
  sessionStorage.setItem('projects.expanded', JSON.stringify(projectsUi.expandedProjects));
  if (projectsUi.otherOpen) sessionStorage.setItem('projects.otherOpen', '1'); else sessionStorage.removeItem('projects.otherOpen');
}

const PROJECT_WORKSPACE_TABS = new Set(['overview', 'session', 'plan', 'todos', 'files', 'git', 'knowledge', 'env', 'settings']);
// The two tabs drawn from the project's plan data (get-project-plan): the phases and the todos.
const PLAN_TABS = new Set(['plan', 'todos']);

function projectTab(projectOrId = projectsUi.selectedProjectId) {
  const projectId = typeof projectOrId === 'string' ? projectOrId : projectOrId?.id;
  return projectNavigation(projectId).tab;
}

function setProjectTab(projectOrId, tab) {
  const projectId = typeof projectOrId === 'string' ? projectOrId : projectOrId?.id;
  if (!projectId || !PROJECT_WORKSPACE_TABS.has(tab)) return;
  projectNavigation(projectId).tab = tab;
}

function projectNavigation(projectOrId = projectsUi.selectedProjectId) {
  const projectId = typeof projectOrId === 'string' ? projectOrId : projectOrId?.id;
  if (!projectId) return { tab: 'overview', sessionId: null };
  if (!projectsUi.navigationByProject.has(projectId)) {
    projectsUi.navigationByProject.set(projectId, { tab: 'overview', sessionId: null });
  }
  return projectsUi.navigationByProject.get(projectId);
}

/**
 * The page is about to show a tab other than Session. The session stays
 * remembered, so the Session tab can bring it back.
 */
function rememberProjectOverview(projectOrId) {
  const state = projectNavigation(projectOrId);
  if (state.tab === 'session') state.tab = 'overview';
}

function rememberProjectSession(projectOrId, sessionId) {
  if (!sessionId) return;
  const state = projectNavigation(projectOrId);
  state.tab = 'session';
  state.sessionId = sessionId;
}

/** Keep remembered sessions valid when a newly launched/forked CLI gets its real id. */
function rekeyProjectSessionState(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  for (const state of projectsUi.navigationByProject.values()) {
    if (state.sessionId === oldId) state.sessionId = newId;
  }
}

/** A destroyed terminal cannot be restored as a project's selected session. */
function forgetProjectSessionState(sessionId) {
  for (const state of projectsUi.navigationByProject.values()) {
    if (state.sessionId !== sessionId) continue;
    if (state.tab === 'session') state.tab = 'overview';
    state.sessionId = null;
  }
}

/**
 * The session the project's Session tab would show, or null when the tab has
 * nothing to show: no remembered session, or one whose terminal is gone.
 */
function projectTabSession(project) {
  const state = projectNavigation(project);
  if (!state.sessionId || typeof openSessions === 'undefined') return null;
  const entry = openSessions.get(state.sessionId);
  if (!entry) return null;
  const session = sessionMap.get(state.sessionId) || entry.session;
  if (projectForSession(session)?.project?.id !== project.id) return null;
  return session;
}

const projectViewer = document.getElementById('project-viewer');
const mainEl = document.getElementById('main');

// --- Icons (stroke SVG, 24 grid) ---

/** The system's file manager, as the menus name it. */
function fileManagerName() {
  const platform = typeof window !== 'undefined' && window.api ? window.api.platform : '';
  return platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'Explorer' : 'File Manager';
}

const PICONS = {
  refresh: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17"/></svg>`,
  camera: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>`,
  plus: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  chevronDown: (s = 11) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  chevronRight: (s = 11) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`,
  // Expand all / Collapse all (chevrons apart, chevrons together).
  expandAll: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>`,
  collapseAll: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/></svg>`,
  back: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
  dots: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`,
  play: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.8a1 1 0 0 1 1.52-.85l8 5.2a1 1 0 0 1 0 1.7l-8 5.2A1 1 0 0 1 4 13.2V2.8Z"/></svg>`,
  folder: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
  file: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>`,
  branch: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
  // A sticky note with a folded corner: the project's note.md.
  note: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/><path d="M7 8h10"/><path d="M7 12h6"/></svg>`,
  pencil: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  check: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  trash: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>`,
  // Before Merge in a pull request's row: Copy the address, Open here (a panel), Open in a window, Open in the browser.
  link: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  panel: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M6.5 6.5h.01"/><path d="M9 6.5h.01"/></svg>`,
  popOut: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M21 3l-9 9"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg>`,
  globe: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  // The project's Overview (Lucide layout-dashboard). Opening a folder or a
  // window has its own icons (ICONS.folderOpen, ICONS.popOut).
  dashboard: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>`,
  fork: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M21 3l-7.5 7.5a5 5 0 0 0-1.5 3.5v7"/><path d="M3 3l7.5 7.5a5 5 0 0 1 1.5 3.5v1"/></svg>`,
  messages: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/></svg>`,
  // The app's own archive glyph, so this view matches the Sessions tab.
  archive: (s = 14) => ICONS.archive(s),
  list: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h7"/></svg>`,
  tree: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/></svg>`,
  clock: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/></svg>`,
  terminal: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>`,
  search: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  x: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  // --- Git Graph tab additions ---
  tag: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.6 2.6a2 2 0 0 0-1.4-.6H4a2 2 0 0 0-2 2v7.2c0 .5.2 1 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>`,
  merge: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v3a6 6 0 0 0 6 6h3"/></svg>`,
  cherryPick: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="18" r="3"/><circle cx="17" cy="15" r="3"/><path d="M8 15V7a4 4 0 0 1 4-4"/><path d="M17 12V9a3 3 0 0 0-3-3"/></svg>`,
  stash: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h18"/><path d="M5 8V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/><rect x="3" y="8" width="18" height="12" rx="1"/><path d="M9 13h6"/></svg>`,
  rebase: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12"/><path d="M4 12h7"/><path d="M4 18h12"/><path d="m17 9 3 3-3 3"/></svg>`,
  revert: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 7"/></svg>`,
  reset: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 4v5h5"/></svg>`,
  fetch: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg>`,
  push: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 19h16"/></svg>`,
  pull: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><path d="m8 9 4 4 4-4"/><circle cx="12" cy="19" r="2"/></svg>`,
  avatarPlaceholder: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>`,
  gear: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V19a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>`,
};

function cliIcon(session, size = 14) {
  if (session.type === 'terminal') return ICONS.terminal(size);
  return harnessIcon(session.runtime, size);
}

// --- Tree helpers ---

function currentProjectTree() {
  return (searchMatchIds !== null || showArchived) ? cachedProjectTreeAll : cachedProjectTree;
}

function findTreeProject(id) {
  if (!id) return null;
  for (const tree of [cachedProjectTree, cachedProjectTreeAll]) {
    const found = (tree?.projects || []).find(p => p.id === id);
    if (found) return found;
  }
  return null;
}

function selectedProject() {
  return findTreeProject(projectsUi.selectedProjectId);
}

/**
 * Archived sessions of a project, or of one of its tracks ('general' for
 * none). They come from the full tree, since the working tree leaves them out.
 */
function archivedSessionsOf(project, trackKey = null) {
  const full = (cachedProjectTreeAll?.projects || []).find(p => p.id === project.id) || project;
  let list;
  if (trackKey === null) list = [...(full.sessions || []), ...(full.tracks || []).flatMap(t => t.sessions || [])];
  else if (trackKey === 'general') list = full.sessions || [];
  else list = (full.tracks || []).find(t => t.id === trackKey)?.sessions || [];
  return list.filter(s => s.archived).sort((a, b) => sessionEventTime(b) - sessionEventTime(a));
}

/** The closed-by-default "Archived · N" section: a hairline, a toggle line, and the dimmed rows when open. */
function buildArchivedSection(project, sessions, key, { showTrack, rowClass }) {
  const wrap = document.createElement('div');
  wrap.className = 'archived-sec';
  const open = !!projectsUi.archivedOpen[key];
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'archived-toggle' + (open ? ' open' : '');
  toggle.innerHTML = `${PICONS.chevronRight(9)}<span>Archived</span><b>${sessions.length}</b>`;
  toggle.onclick = () => {
    if (open) delete projectsUi.archivedOpen[key]; else projectsUi.archivedOpen[key] = true;
    saveProjectsUi();
    refreshProjectViews({ reason: 'sessions' });
  };
  wrap.appendChild(toggle);
  if (open) for (const s of sessions) wrap.appendChild(buildSessionRow(project, s, { showTrack, className: rowClass }));
  return wrap;
}

function projectSessionsAll(project) {
  const all = [...(project.sessions || [])];
  for (const track of project.tracks || []) all.push(...(track.sessions || []));
  return all;
}

function pathBasename(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function isPathInside(child, root) {
  if (!child || !root) return false;
  if (child === root) return true;
  return child.startsWith(root + '/') || child.startsWith(root + '\\');
}

/**
 * Label for a Folder (Sessions tab) whose path sits under a project's root:
 * "<project name> · <relative path>". Null for every other folder.
 */
function projectRootLabel(projectPath) {
  for (const project of cachedProjectTreeAll?.projects || []) {
    if (!isPathInside(projectPath, project.root)) continue;
    if (projectPath === project.root) return project.name;
    return `${project.name} · ${projectPath.slice(project.root.length + 1)}`;
  }
  return null;
}

/** 'in-place' or 'worktree' for a folder some project attached, else null. */
function projectFolderMode(projectPath) {
  for (const project of cachedProjectTreeAll?.projects || []) {
    const folder = (project.folders || []).find(f => f.path === projectPath);
    if (folder) return folder.mode;
  }
  return null;
}

/** The branch a project's worktrees use, for labels. */
function projectBranchName(project) {
  return project.sharedBranch === false ? null : (project.branchName || project.slug);
}

/** Project a session belongs to: explicit id first, then its folder's location. */
function projectForSession(session) {
  if (!session) return null;
  if (session.projectId) {
    const explicit = findTreeProject(session.projectId);
    if (explicit) return { project: explicit, byCwd: false };
  }
  for (const project of cachedProjectTreeAll?.projects || []) {
    if (isPathInside(session.projectPath, project.root)) return { project, byCwd: true };
  }
  return null;
}

// Both trees must reference the same session objects as the Sessions tab, so
// a pin, rename or exit changes every view at once.
function dedupTree(tree) {
  for (const project of tree?.projects || []) {
    const lists = [project.sessions, ...(project.tracks || []).map(t => t.sessions)];
    for (const list of lists) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (sessionMap.has(s.sessionId)) {
          Object.assign(sessionMap.get(s.sessionId), s);
          list[i] = sessionMap.get(s.sessionId);
        } else {
          sessionMap.set(s.sessionId, s);
        }
      }
    }
  }
}

/** A just-launched session has no transcript yet; show it under its project now. */
function injectPendingIntoTree(session) {
  if (!session?.projectId) return;
  for (const tree of [cachedProjectTree, cachedProjectTreeAll]) {
    const project = (tree?.projects || []).find(p => p.id === session.projectId);
    if (!project) continue;
    const track = session.trackId ? (project.tracks || []).find(t => t.id === session.trackId) : null;
    const list = track ? track.sessions : project.sessions;
    if (!list.some(s => s.sessionId === session.sessionId)) list.unshift(session);
  }
}

function removeSessionFromTrees(sessionId) {
  for (const tree of [cachedProjectTree, cachedProjectTreeAll]) {
    for (const project of tree?.projects || []) {
      project.sessions = project.sessions.filter(s => s.sessionId !== sessionId);
      for (const track of project.tracks || []) {
        track.sessions = track.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
  }
}

/** Every path the task runner should know about for the tree's projects. */
function treeTaskPaths(tree) {
  const paths = new Set();
  for (const project of tree?.projects || []) {
    paths.add(project.root);
    for (const folder of project.folders || []) paths.add(folder.path);
  }
  return [...paths];
}

/** The launch target a project's or track's New session button hands to the popover. */
function launchTargetFor(project, track = null) {
  return {
    projectPath: track?.cwd || project.defaultCwd || project.root,
    projectId: project.id,
    trackId: track?.id || null,
    projectName: project.name,
  };
}

/**
 * A stand-in "project" for the task runner that carries every task from every
 * attached folder plus the project root. Each task remembers the folder it
 * came from so start/stop/log target the right one.
 */
function taskPseudoProject(project) {
  const paths = [project.root, ...(project.folders || []).map(f => f.path)];
  const unique = [...new Set(paths)];
  const contributing = unique.filter(p => (tasksByPath.get(p)?.tasks || []).length);
  const multi = contributing.length > 1;
  const tasks = [];
  let taskError = null;
  let hasTaskFile = false;
  for (const p of unique) {
    const entry = tasksByPath.get(p);
    if (!entry) continue;
    if (entry.error && !taskError) taskError = `${pathBasename(p)}: ${entry.error}`;
    if (entry.hasTaskFile) hasTaskFile = true;
    for (const task of entry.tasks || []) {
      tasks.push({ ...task, projectPath: p, groupLabel: multi ? pathBasename(p) : null });
    }
  }
  return { id: project.id, projectPath: project.root, projectPaths: unique, tasks, taskError, hasTaskFile };
}

function runningTasksFor(project) {
  return taskPseudoProject(project).tasks.filter(t => t.run?.running).length;
}

/** The header's Schedules button: a count of the project's scheduled tasks, tinted while any is on. */
function scheduleButtonHtml(project, id, small = false) {
  const schedules = typeof schedulesForProject === 'function' ? schedulesForProject(project) : [];
  const on = schedules.filter(s => s.enabled).length;
  const cls = schedules.length ? (on ? ' has-schedules' : ' has-schedules all-off') : '';
  return `<button type="button" class="ws-btn${small ? ' ws-btn--sm' : ''} ws-schedule-btn${cls}" id="${id}" title="${schedules.length ? `${schedules.length} scheduled task${schedules.length === 1 ? '' : 's'}` : 'New scheduled task'}">${PICONS.clock(small ? 11 : 12)}<span>Schedules</span><span class="ws-badge" ${schedules.length ? '' : 'style="display:none"'}>${schedules.length || ''}</span></button>`;
}

/** A track's +: straight to its CLI when it has one, else the shared Project View menu. */
async function launchFromTrack(project, track, anchor) {
  const target = launchTargetFor(project, track);
  if (track?.cli) {
    const options = await resolveDefaultSessionOptions(target);
    options.runtime = track.cli;
    launchNewSession(target, options);
    return;
  }
  showNewSessionMenu(project, track, anchor);
}

// --- Identity ---

function projectHue(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  return h % 360;
}

function projectInitials(name) {
  // Only words that start with a letter or digit count, so "Organization & SSO"
  // is OS and not O&. Hyphens and underscores separate words too.
  const words = String(name || '').trim().split(/[\s_-]+/).filter(w => /^[\p{L}\p{N}]/u.test(w));
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** The project's square: its own picture, else its initials on its own colour. */
function markHtml(project, size = 28, extraClass = '') {
  // Not draggable: a drag on the row moves the project, not its picture.
  if (project.iconUrl) {
    return `<span class="proj-mark proj-mark--icon ${extraClass}" style="width:${size}px;height:${size}px;"><img src="${escapeAttr(project.iconUrl)}" alt="" draggable="false"></span>`;
  }
  const h = projectHue(project.id);
  const fontSize = Math.round(size * 0.4);
  return `<span class="proj-mark ${extraClass}" style="width:${size}px;height:${size}px;font-size:${fontSize}px;background:hsla(${h},70%,60%,0.18);color:hsl(${h},80%,72%);">${escapeHtml(projectInitials(project.name))}</span>`;
}

/**
 * The sidebar's square, as a button: a click picks the project's picture, and
 * a camera shows in its corner under the pointer.
 */
function markButtonHtml(project, size = 28) {
  return `<button type="button" class="proj-mark-btn" title="Change the project's icon" aria-label="Change the icon of ${escapeAttr(project.name)}">${markHtml(project, size)}<span class="proj-mark-camera" aria-hidden="true">${PICONS.camera(10)}</span></button>`;
}

/**
 * One color per track, spread around the wheel from the project's own hue so
 * two tracks in a project never share one. General is grey.
 */
function trackColors(project, track) {
  if (!track) return { fg: '#9090a8', bg: 'rgba(255,255,255,0.08)' };
  const index = Math.max(0, (project.tracks || []).findIndex(t => t.id === track.id));
  const h = Math.round((projectHue(project.id) + 40 + index * 137.5) % 360);
  return { fg: `hsl(${h},78%,72%)`, bg: `hsla(${h},70%,60%,0.16)` };
}

function trackTagHtml(project, track) {
  const c = trackColors(project, track);
  return `<span class="pane-tag" style="color:${c.fg};background:${c.bg}">${escapeHtml(track ? track.name : 'General')}</span>`;
}

function cliLabel(session) {
  if (session.type === 'terminal') return 'Terminal';
  return harnessLabel(session.runtime);
}

function sessionTitle(session) {
  return cleanDisplayName(session.name || session.aiTitle || session.summary) || 'New session';
}

/** Archive or unarchive a session. Archiving a live session stops it first. */
async function toggleArchiveSession(session) {
  const newVal = session.archived ? 0 : 1;
  if (newVal && activePtyIds.has(session.sessionId)) { await window.api.stopSession(session.sessionId); pollActiveSessions(); }
  await window.api.archiveSession(session.sessionId, newVal);
  if (newVal) forgetTerminalHistory(session.sessionId);
  session.archived = newVal;
  loadProjects();
}

/** The J row: title over one meta line (dot, track label, CLI, age, size). */
function buildSessionRow(project, session, { showTrack = true, className = 'pane-session', hoverPreview = false } = {}) {
  const row = document.createElement('div');
  const id = session.sessionId;
  // The same state classes the Sessions tab uses, so the two rows read alike.
  const stateClasses = [
    isSessionRunning(id) ? 'running' : '',
    typeof attentionSessions !== 'undefined' && attentionSessions.has(id) ? 'needs-attention' : '',
    typeof responseReadySessions !== 'undefined' && responseReadySessions.has(id) ? 'response-ready' : '',
    typeof sessionBusyState !== 'undefined' && sessionBusyState.get(id) === true ? 'cli-busy' : '',
    typeof sessionSubagentState !== 'undefined' && sessionSubagentState.get(id) === true ? 'subagent-busy' : '',
  ].filter(Boolean).join(' ');
  row.className = className + (id === activeSessionId ? ' here' : '') + (stateClasses ? ' ' + stateClasses : '');
  row.dataset.sessionId = id;
  const state = sessionState(session);
  const track = session.trackId ? (project.tracks || []).find(t => t.id === session.trackId) : null;
  const parts = [];
  parts.push(`<span class="session-status-dot pane-dot${state === 'running' ? ' running' : ''}${state === 'attention' ? ' needs-attention' : ''}"></span>`);
  if (!track && session.formerTrackName) {
    parts.push(`<span class="pane-tag" title="Previously in a deleted track">Formerly: ${escapeHtml(session.formerTrackName)}</span>`);
  } else if (showTrack) parts.push(trackTagHtml(project, track));
  // Started by a scheduled task: which one, and when it fired.
  if (session.scheduleId && typeof scheduleChipHtml === 'function') parts.push(scheduleChipHtml(session));
  // The CLI mark, same as the status bar: the logo says which CLI, no word needed.
  parts.push(`<span class="pane-cli-icon${session.runtime && session.runtime !== 'claude' && session.type !== 'terminal' ? ' is-' + session.runtime : ''}${session.type === 'terminal' ? ' is-terminal' : ''}" title="${escapeHtml(cliLabel(session))}">${cliIcon(session, 12)}</span>`);
  // The last message's time, the same as the Sessions tab. A session with no
  // transcript yet shows when it started.
  parts.push(`<span>${escapeHtml(formatDate(new Date(session.modified || sessionEventTime(session))))}</span>`);
  if (session.messageCount) parts.push(`<span class="pane-sep">·</span><span>${session.messageCount} msgs</span>`);
  row.innerHTML = `<span class="pane-title">${escapeHtml(sessionTitle(session))}</span><span class="pane-meta">${parts.join('')}</span>`;
  // A floating button, shown on hover: dismiss a session that never started
  // (nothing to archive), otherwise archive or unarchive.
  const dismissible = typeof isDismissibleSession === 'function' && isDismissibleSession(id);
  if (dismissible || session.type !== 'terminal') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pane-row-archive';
    btn.title = dismissible ? 'Dismiss' : (session.archived ? 'Unarchive' : 'Archive');
    btn.innerHTML = dismissible ? PICONS.x(12) : PICONS.archive(12);
    btn.onclick = (e) => { e.stopPropagation(); if (dismissible) dismissSession(id); else toggleArchiveSession(session); };
    row.appendChild(btn);
  }
  // Fork, just right of archive, as on the Sessions tab.
  if (!dismissible && session.type !== 'terminal' && cliCanFork(session.runtime)) {
    const fork = document.createElement('button');
    fork.type = 'button';
    fork.className = 'pane-row-fork';
    fork.title = 'Fork session';
    fork.setAttribute('aria-label', fork.title);
    fork.innerHTML = PICONS.fork(12);
    fork.onclick = (e) => { e.stopPropagation(); if (hoverPreview) hideSessionHoverPreview(id); forkSessionInPlace(session); };
    row.appendChild(fork);
    row.classList.add('has-fork');
  }
  // The star, at the right of the title's line, as on the Sessions tab.
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'pane-pin';
  paintPaneStar(pin, session);
  pin.onclick = (e) => { e.stopPropagation(); if (hoverPreview) hideSessionHoverPreview(id); toggleSessionStar(session); };
  row.appendChild(pin);
  // Under the star and the archive button: what the live session uses (app.js).
  const ram = sessionMemoryElement(id);
  row.appendChild(ram);
  paintSessionMemory(ram);
  row.onclick = () => { if (hoverPreview) hideSessionHoverPreview(id); openSession(session); };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (hoverPreview) hideSessionHoverPreview(id);
    showContextMenu(sessionMenuItems(session), { x: e.clientX, y: e.clientY });
  };
  if (hoverPreview) attachSessionHoverPreview(row, session);
  return row;
}

/** A row's star: outlined, or filled in the session's own tint when pinned. */
function paintPaneStar(pin, session) {
  const pinned = !!session.starred;
  pin.classList.toggle('pinned', pinned);
  pin.title = pinned ? 'Unstar session' : 'Star session';
  pin.setAttribute('aria-label', pin.title);
  pin.setAttribute('aria-pressed', String(pinned));
  pin.style.color = pinned ? sessionStarColor(session) : '';
  pin.innerHTML = starIconSvg(pinned, 13);
}

// --- Status ---

function sessionState(session) {
  const id = session.sessionId;
  if (attentionSessions.has(id)) return 'attention';
  if (isSessionRunning(id)) return 'running';
  return '';
}

/**
 * What a session is doing, for the roll-up dot: 'running' while the CLI is
 * working, 'ready' when it has finished and nobody has looked, 'attention'
 * when it wants an answer, 'idle' for a live session doing none of those.
 */
function sessionActivity(session) {
  const id = session.sessionId;
  const alive = isSessionRunning(id);
  // Unread is a reminder, so it must not hide live work or a request for input.
  if (attentionSessions.has(id)) return 'attention';
  if (alive && sessionBusyState.get(id) === true) return 'running';
  // The main agent waits while a subagent works: work all the same.
  if (alive && typeof sessionSubagentState !== 'undefined' && sessionSubagentState.get(id) === true) return 'subagent';
  if (responseReadySessions.has(id)) return 'ready';
  return alive ? 'idle' : '';
}

const GROUP_STATE_ORDER = ['attention', 'running', 'subagent', 'ready', 'idle'];
const GROUP_STATE_LABEL = { running: 'Working', subagent: 'A subagent is working', ready: 'Finished, not read yet', attention: 'Needs you', idle: 'Open', woke: 'Back from snooze' };
// Every class a project dot can carry: the session states plus the woke marker.
const PROJECT_DOT_STATES = [...GROUP_STATE_ORDER, 'woke'];

/**
 * The dot on a project row. A project back from snooze shows violet ahead of
 * everything else: opening it clears the marker at once, and the session
 * state shows from then on. The marker comes from the stored wake time, so
 * it survives a restart.
 */
function projectDotState(project) {
  if (projectWokeAt(project, Date.now())) return 'woke';
  return groupState(projectSessionsAll(project));
}

/** The strongest state among these sessions: needs-you beats working beats unread. */
function groupState(sessions) {
  let best = '';
  for (const s of sessions) {
    const st = sessionActivity(s);
    if (st === 'attention') return 'attention';
    if (st && (!best || GROUP_STATE_ORDER.indexOf(st) < GROUP_STATE_ORDER.indexOf(best))) best = st;
  }
  return best;
}

function stateDot(state, extraClass = '') {
  const label = GROUP_STATE_LABEL[state] || '';
  return `<span class="proj-dot ${state} ${extraClass}"${label ? ` title="${label}"` : ''}></span>`;
}

function applyProjectDotState(dot, state) {
  for (const name of PROJECT_DOT_STATES) dot.classList.toggle(name, state === name);
  if (GROUP_STATE_LABEL[state]) dot.title = GROUP_STATE_LABEL[state]; else dot.removeAttribute('title');
}

function updateProjectHeaderStatus(project) {
  // The dot has a slot of its own: the title line also holds the header's buttons.
  const titleLine = projectViewer?.querySelector('.ws-title-status') || projectViewer?.querySelector('.ws-title-line');
  if (!titleLine) return;
  const state = groupState(projectSessionsAll(project));
  const dot = titleLine.querySelector('.proj-dot--lg');
  if (!state) dot?.remove();
  else if (dot) applyProjectDotState(dot, state);
  else titleLine.insertAdjacentHTML('beforeend', stateDot(state, 'proj-dot--lg'));
  const tabDot = projectViewer.querySelector('.ws-tab[data-tab="session"] .proj-dot');
  if (tabDot) applyProjectDotState(tabDot, sessionTabState(project));
}

/** The dot on the Session tab: what the session it shows is doing. */
function sessionTabState(project) {
  const session = projectTabSession(project);
  return session ? sessionActivity(session) : '';
}

/** Roll running / attention up onto every project row, card and session row. */
function updateProjectStatusDots() {
  const applyState = (el, state) => {
    const dot = el.querySelector(':scope > .proj-dot, :scope > .proj-status > .proj-dot, :scope > .proj-side > .proj-status > .proj-dot, :scope > .tcard-h > .proj-dot');
    if (!dot) return;
    applyProjectDotState(dot, state);
  };
  const project = selectedProject();
  if (project) updateProjectHeaderStatus(project);
  const apply = (el, sessions) => applyState(el, groupState(sessions));
  document.querySelectorAll('.proj-row[data-project-id]').forEach(row => {
    const project = findTreeProject(row.dataset.projectId);
    if (!project) return;
    const state = projectDotState(project);
    applyState(row, state);
    syncProjectSide(row, project, state);
    applyProjectSubline(row, project);
  });
  document.querySelectorAll('.tcard[data-track-key]').forEach(el => {
    const project = findTreeProject(el.dataset.projectId);
    if (!project) return;
    const key = el.dataset.trackKey;
    const sessions = key === 'general' ? project.sessions : (project.tracks.find(t => t.id === key)?.sessions || []);
    apply(el, sessions);
  });
  document.querySelectorAll('.pane-session[data-session-id], .tcard-session[data-session-id]').forEach(el => {
    const session = sessionMap.get(el.dataset.sessionId);
    // A pin from the phone, or from another row of the same session.
    const pin = el.querySelector('.pane-pin');
    if (session && pin && pin.getAttribute('aria-pressed') !== String(!!session.starred)) paintPaneStar(pin, session);
    const dot = el.querySelector('.session-status-dot');
    if (!session || !dot) return;
    const state = sessionState(session);
    dot.classList.toggle('running', state === 'running');
    dot.classList.toggle('needs-attention', state === 'attention');
  });
  // The Time and State groupings move a session between sections when it
  // starts or stops. Drawers whose rows did not change stay as they are.
  refreshProjectDrawers();
  // A session that starts needing input wakes its snoozed project, and a
  // snoozed project has no row while the shelf is closed, so the dots cannot
  // carry that change. Compare the snoozed set instead.
  if (projectSnoozedKey(currentProjectTree()?.projects || []) !== projectsUi.snoozedKey) renderProjectList();
}

// --- Sidebar: the project list ---

/** A project sorts by the latest event among its sessions; a project with none uses its own activity time. */
function projectSortTime(project) {
  let best = 0;
  for (const s of projectSessionsAll(project)) best = Math.max(best, sessionEventTime(s));
  // Coming back from a snooze is an event. Without this a woken project
  // returns to a spot buried under everything that moved while it was away,
  // leaving the violet dot to carry the whole signal. The wake time is a real
  // timestamp, so it decays like any other event, and opening the project
  // clears it back to its natural position along with the dot.
  const woke = projectWokeAt(project, Date.now());
  if (woke) best = Math.max(best, Date.parse(woke));
  if (best) return best;
  const t = new Date(project.lastActivity || project.modified || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * The numbers on a project row's second line, in order: plan phases done of
 * all, todos open of all, tracks, sessions. A long dash stands for none, so
 * there is still something to point at; "…" means the plan files are still
 * being read.
 */
function projectRowStats(project) {
  const loaded = fileContent(project, 'plan-tracker.md') !== null && fileContent(project, 'todos.md') !== null;
  const counts = loaded ? projectDrawerStats(project) : null;
  const tracks = (project.tracks || []).length;
  const sessions = projectSessionsAll(project).length;
  const ratio = (part, whole) => (!counts ? '…' : whole ? `${part}/${whole}` : '—');
  return [
    { key: 'plan', label: 'Plan', value: ratio(counts?.planDone, counts?.planTotal) },
    { key: 'todos', label: 'Todos', value: ratio(counts?.todosOpen, counts?.todosTotal) },
    { key: 'tracks', label: 'Tracks', value: tracks ? String(tracks) : '—' },
    { key: 'sessions', label: 'Sessions', value: sessions ? String(sessions) : '—' },
  ];
}

/** What follows the numbers: needs input, a snooze, or the latest activity. */
function projectSublineTail(project) {
  const state = groupState(projectSessionsAll(project));
  if (state === 'attention') return 'needs input';
  if (projectSnoozed(project, Date.now())) return `wakes ${snoozeWakeDescription(project.snoozedUntil)}`;
  if (projectWokeAt(project, Date.now())) return `woke ${formatDate(new Date(project.snoozedUntil))}`;
  if (projectSortTime(project)) return formatDate(new Date(projectSortTime(project)));
  return '';
}

/** The second line in words, for screen readers and tooltips. */
function projectSubline(project) {
  const parts = projectRowStats(project).map(stat => `${stat.label} ${stat.value}`);
  const tail = projectSublineTail(project);
  if (tail) parts.push(tail);
  return parts.join(' · ');
}

/**
 * The second line as shown: only the numbers, each widening to show its
 * word ("Plan 100/154") while the pointer is on it.
 */
function projectSublineHtml(project) {
  const parts = projectRowStats(project).map(stat =>
    `<span class="proj-stat" data-stat="${stat.key}"><span class="proj-stat-label">${stat.label}&nbsp;</span>${escapeHtml(stat.value)}</span>`);
  const tail = projectSublineTail(project);
  if (tail) parts.push(`<span class="proj-stat-tail">${escapeHtml(tail)}</span>`);
  return parts.join('<span class="proj-stat-sep"> · </span>');
}

/** Put the current second line on a row, leaving it alone when nothing changed. */
function applyProjectSubline(row, project) {
  const subline = row.querySelector('.proj-sub');
  if (!subline) return;
  const html = projectSublineHtml(project);
  if (subline.innerHTML !== html) subline.innerHTML = html;
  subline.setAttribute('aria-label', projectSubline(project));
}

/** A separate badge for task processes, alongside the session status. */
function updateProjectTaskIndicator(row, project) {
  const badge = row.querySelector('.proj-task-indicator');
  if (!badge) return;
  const count = runningTasksFor(project);
  badge.style.display = count ? '' : 'none';
  badge.title = `${count} task${count === 1 ? '' : 's'} running`;
  badge.setAttribute('aria-label', badge.title);
  badge.querySelector('.proj-task-running-count').textContent = count || '';
  if (typeof syncProjectSide === 'function') syncProjectSide(row, project);
}

/** Task events can affect several projects when they share an attached folder. */
function updateProjectTaskIndicators(projectPath) {
  document.querySelectorAll('.proj-row[data-project-id]').forEach(row => {
    const project = findTreeProject(row.dataset.projectId);
    if (!project || (project.root !== projectPath && !(project.folders || []).some(f => f.path === projectPath))) return;
    updateProjectTaskIndicator(row, project);
  });
}

/** A project row's star, after the name: dim until the row is under the pointer, gold when starred. */
function projectStarHtml(project) {
  const starred = !!project.starred;
  const label = starred ? 'Unstar project' : 'Star project';
  return `<button type="button" class="proj-star${starred ? ' starred' : ''}" title="${label}" aria-label="${starred ? 'Unstar' : 'Star'} ${escapeHtml(project.name)}" aria-pressed="${starred}">${starIconSvg(starred, 12)}</button>`;
}

/**
 * The sections of the Projects tab. Starred holds the starred projects at
 * work, above Active, in the order they were dragged into (pinned-order.js;
 * one starred since comes after them, newest first); Active is newest first. A snoozed or finished project
 * stays on its shelf, starred ones first there: the shelf reads as "what
 * comes back first", Done newest first.
 */
function projectListGroups(projects, { isSnoozed, sortTime }) {
  const starred = [], active = [], snoozed = [], done = [];
  for (const p of projects) {
    if (p.status === 'done') done.push(p);
    else if (isSnoozed(p)) snoozed.push(p);
    else (p.starred ? starred : active).push(p);
  }
  const byEvent = (a, b) => sortTime(b) - sortTime(a);
  const starFirst = (a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
  starred.sort(PinnedOrder.compareByRank(p => p.starRank, byEvent));
  active.sort(byEvent);
  done.sort((a, b) => starFirst(a, b) || byEvent(a, b));
  snoozed.sort((a, b) => starFirst(a, b) || Date.parse(a.snoozedUntil) - Date.parse(b.snoozedUntil));
  return { starred, active, snoozed, done };
}

/** Star a project, or take its star off: the row moves at once, then main keeps it. */
async function toggleProjectStar(project) {
  const starred = !project.starred;
  project.starred = starred;
  renderProjectList();
  const result = await window.api.updateProject(project.id, { starred });
  if (result?.error) {
    project.starred = !starred;
    renderProjectList();
    alert(result.error);
    return;
  }
  loadProjects();
}

// --- Order by dragging: the Starred section, and each drawer's Pinned group ---

// The row being dragged ({ group, id }), so only the rows of its own group take it.
let orderDrag = null;
const ORDER_DRAG_TYPE = 'application/x-switchboard-order';

/** Make a row one of `group`'s, dragged among them by its `id` (bindOrderDrag). */
function markOrderRow(row, group, id) {
  row.dataset.orderGroup = group;
  row.dataset.orderId = id;
  row.setAttribute('draggable', 'true');
}

function clearOrderDropMarks(except) {
  document.querySelectorAll('[data-order-group].drop-before, [data-order-group].drop-after').forEach((el) => {
    if (el !== except) el.classList.remove('drop-before', 'drop-after');
  });
}

/**
 * Let a marked row (markOrderRow) be dropped on the other rows of its group:
 * before one, or after it on its lower half. `onOrder` gets the group's ids in
 * their new order, read from the rows on screen. A row not marked loses the
 * handlers, as morphdom keeps a row that left the Starred section.
 */
function bindOrderDrag(row, onOrder) {
  if (!row.dataset.orderGroup) {
    row.ondragstart = row.ondragend = row.ondragover = row.ondragleave = row.ondrop = null;
    return;
  }
  const lowerHalf = (e) => {
    const rect = row.getBoundingClientRect();
    return e.clientY > rect.top + rect.height / 2;
  };
  const accepts = () => !!orderDrag && orderDrag.group === row.dataset.orderGroup;
  row.ondragstart = (e) => {
    orderDrag = { group: row.dataset.orderGroup, id: row.dataset.orderId };
    e.dataTransfer.setData(ORDER_DRAG_TYPE, orderDrag.id);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('is-dragging');
  };
  row.ondragend = () => {
    orderDrag = null;
    row.classList.remove('is-dragging');
    clearOrderDropMarks();
  };
  row.ondragover = (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearOrderDropMarks(row);
    const after = lowerHalf(e);
    row.classList.toggle('drop-after', after);
    row.classList.toggle('drop-before', !after);
  };
  row.ondragleave = (e) => {
    if (!row.contains(e.relatedTarget)) row.classList.remove('drop-before', 'drop-after');
  };
  row.ondrop = (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.stopPropagation();
    const { group, id: fromId } = orderDrag;
    const after = lowerHalf(e);
    clearOrderDropMarks();
    const ids = [...document.querySelectorAll('[data-order-group]')]
      .filter(el => el.dataset.orderGroup === group)
      .map(el => el.dataset.orderId);
    const index = PinnedOrder.dropIndex(ids, fromId, row.dataset.orderId, after);
    if (index !== null) onOrder(PinnedOrder.moveId(ids, fromId, index), group);
  };
}

/** Both trees' copies of a project: the sidebar's and the one with the archived. */
function treeCopiesOf(projectId) {
  return [cachedProjectTree, cachedProjectTreeAll]
    .map(tree => (tree?.projects || []).find(p => p.id === projectId))
    .filter(Boolean);
}

/** The Starred section in a new order: it shows at once, then main keeps it. */
async function setStarredOrder(ids) {
  ids.forEach((id, rank) => { for (const project of treeCopiesOf(id)) project.starRank = rank; });
  renderProjectList();
  const result = await window.api.setStarredOrder(ids);
  if (result?.error) alert(result.error);
  loadProjects();
}

/** A project's pinned sessions in a new order: its drawer shows it at once, then main keeps it. */
async function setPinnedOrder(ids, group) {
  const projectId = group.slice('pinned:'.length);
  const rankOf = new Map(ids.map((id, rank) => [id, rank]));
  for (const project of treeCopiesOf(projectId)) {
    for (const session of projectSessionsAll(project)) if (rankOf.has(session.sessionId)) session.pinRank = rankOf.get(session.sessionId);
  }
  refreshProjectDrawer(projectId);
  const result = await window.api.setPinnedOrder(ids);
  if (result?.error) alert(result.error);
  loadProjects();
}

function buildProjectRow(project) {
  const row = document.createElement('div');
  const expanded = projectDrawerOpen(project);
  row.className = 'proj-row' + (project.id === projectsUi.selectedProjectId ? ' selected' : '') + (project.status === 'done' ? ' done' : '') + (isProjectSnoozed(project) ? ' snoozed' : '') + (expanded ? ' expanded' : '');
  row.id = 'proj-' + project.id;
  row.dataset.projectId = project.id;
  row.title = project.root;
  const sessions = projectSessionsAll(project);
  const state = projectDotState(project);
  const runningCount = sessions.filter(s => isSessionRunning(s.sessionId)).length;
  // Only the chevron opens the drawer; the rest of the row opens the project.
  const toggleLabel = expanded ? 'Hide sessions' : 'Show sessions';
  row.innerHTML = `<button type="button" class="proj-expand" aria-expanded="${expanded}" aria-controls="proj-drawer-${escapeHtml(project.id)}" aria-label="${toggleLabel}" title="${toggleLabel}">${PICONS.chevronRight(11)}</button>` +
    markButtonHtml(project, 28) +
    `<span class="proj-text"><span class="proj-name-line"><span class="proj-name">${escapeHtml(project.name)}</span>${projectStarHtml(project)}</span><span class="proj-sub" aria-label="${escapeHtml(projectSubline(project))}">${projectSublineHtml(project)}</span></span>` +
    // At the right, the + for a new session, and under it the sessions at
    // work with their dot; the + is centred when there is nothing under it.
    `<span class="proj-side"><button type="button" class="proj-new" title="New session in the project" aria-label="New session in ${escapeHtml(project.name)}">${PICONS.plus(12)}</button>` +
    `<span class="proj-status"><span class="proj-task-indicator" role="img">${PICONS.play(10)}<span class="proj-task-running-count"></span></span>${stateDot(state)}${runningCount ? `<span class="proj-count">${runningCount}</span>` : ''}</span></span>` +
    (searchMatchIds !== null ? `<button type="button" class="proj-exclude-btn" title="Leave out of this search" aria-label="Leave out of this search">${PICONS.x(11)}</button>` : '');
  updateProjectTaskIndicator(row, project);
  syncProjectSide(row, project, state);
  return row;
}

// The dot states a project row shows; the others leave it out.
const PROJECT_ROW_DOT_STATES = new Set(['running', 'subagent', 'ready', 'attention', 'idle', 'woke']);

/** Whether the row has a status under its +: then the + moves up to make room. */
function syncProjectSide(row, project, state = projectDotState(project)) {
  const side = row.querySelector('.proj-side');
  if (!side) return;
  const shown = PROJECT_ROW_DOT_STATES.has(state) || !!row.querySelector('.proj-count') || runningTasksFor(project) > 0;
  side.classList.toggle('has-status', shown);
}

/**
 * A session listed under its project in the search results: the pane's row,
 * with an X that leaves it out of this search in place of archive.
 */
function buildSearchSessionRow(project, session) {
  const row = buildSessionRow(project, session, { className: 'pane-session proj-search-session' });
  row.id = `proj-search-${project.id}-${session.sessionId}`;
  row.dataset.projectId = project.id;
  row.querySelector('.pane-row-archive')?.remove();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pane-row-archive proj-search-exclude';
  btn.title = 'Leave out of this search';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = PICONS.x(12);
  row.appendChild(btn);
  return row;
}

function renderProjectList() {
  if (!projectsContent) return;
  const tree = currentProjectTree();
  let projects = tree?.projects || [];

  // While searching: the projects found, each with the sessions listed under it.
  let found = null;
  // A chevron click only overrides the search's own choice while it runs.
  if (searchMatchIds === null) projectsUi.searchDrawerOverride.clear();
  if (searchMatchIds !== null) {
    found = new Map(projectSearchResults(projects, {
      query: searchInput.value || '',
      matchIds: searchMatchIds,
      excludedProjects: searchExcluded.projects,
      excludedSessions: searchExcluded.sessions,
      sessionsOf: projectSessionsAll,
      isRunning: isSessionRunning,
    }).map(r => [r.project.id, r.sessions]));
    projects = projects.filter(p => found.has(p.id));
  }
  // What the search shows, for the bar's count and Stop: only rendered rows.
  const shown = [];
  // A row, then its drawer when open, then (while searching) the sessions
  // found in it. The drawer is an empty shell here: renderProjectDrawer fills
  // it after the morph (see below).
  const appendProject = (project, { ordered = false } = {}) => {
    const row = buildProjectRow(project);
    // The Starred section is ordered by dragging its rows, outside a search (which shows only some).
    if (ordered && !found) markOrderRow(row, 'starred', project.id);
    list.appendChild(row);
    if (projectDrawerOpen(project)) {
      const drawer = document.createElement('div');
      drawer.className = 'proj-drawer';
      drawer.id = 'proj-drawer-' + project.id;
      drawer.dataset.projectId = project.id;
      list.appendChild(drawer);
    }
    if (!found) return;
    for (const session of found.get(project.id)) {
      list.appendChild(buildSearchSessionRow(project, session));
      shown.push(session);
    }
  };

  const list = document.createElement('div');

  const toolbar = document.createElement('div');
  toolbar.className = 'proj-toolbar';
  toolbar.id = 'proj-toolbar';
  toolbar.innerHTML = `<button type="button" class="proj-new-btn" id="proj-new-btn">${PICONS.plus(12)}<span>New project</span></button>`;
  list.appendChild(toolbar);

  const { starred, active, snoozed, done } = projectListGroups(projects, { isSnoozed: isProjectSnoozed, sortTime: projectSortTime });

  if (!projects.length) {
    const empty = document.createElement('div');
    empty.className = 'projects-empty';
    empty.id = 'projects-empty';
    empty.innerHTML = `<div class="projects-empty-text">${searchMatchIds !== null ? 'No project matches.' : 'No projects yet. A project is a folder that holds a brief, a plan, and the sessions that work on it.'}</div>`;
    list.appendChild(empty);
  }

  if (starred.length) {
    const label = document.createElement('div');
    label.className = 'proj-section';
    label.id = 'proj-sec-starred';
    label.textContent = 'Starred';
    list.appendChild(label);
    for (const project of starred) appendProject(project, { ordered: true });
  }

  if (active.length) {
    const label = document.createElement('div');
    label.className = 'proj-section';
    label.id = 'proj-sec-active';
    label.textContent = 'Active';
    list.appendChild(label);
    for (const project of active) appendProject(project);
  }

  if (snoozed.length) {
    const label = document.createElement('div');
    label.className = 'proj-section proj-section--toggle' + (projectsUi.snoozedOpen ? ' open' : '');
    label.id = 'proj-sec-snoozed';
    label.innerHTML = `${PICONS.chevronRight(9)}<span>Snoozed · ${snoozed.length}</span>`;
    list.appendChild(label);
    if (projectsUi.snoozedOpen) for (const project of snoozed) appendProject(project);
  }

  if (done.length) {
    const label = document.createElement('div');
    label.className = 'proj-section proj-section--toggle' + (projectsUi.doneOpen ? ' open' : '');
    label.id = 'proj-sec-done';
    label.innerHTML = `${PICONS.chevronRight(9)}<span>Done · ${done.length}</span>`;
    list.appendChild(label);
    if (projectsUi.doneOpen) for (const project of done) appendProject(project);
  }

  // Sessions no project claims, under one row at the foot, by folder.
  const otherGroups = sessionsWithoutProject();
  const otherCount = otherGroups.reduce((n, group) => n + group.sessions.length, 0);
  if (otherCount) {
    const open = otherSessionsOpen();
    const label = document.createElement('div');
    label.className = 'proj-section proj-section--toggle proj-section--other' + (open ? ' open' : '');
    label.id = 'proj-sec-other';
    label.title = 'Sessions that belong to no project, by folder';
    label.setAttribute('role', 'button');
    label.setAttribute('aria-expanded', String(open));
    label.innerHTML = `${PICONS.chevronRight(9)}<span>No project · ${otherCount}</span>`;
    list.appendChild(label);
    if (open) {
      const drawer = document.createElement('div');
      drawer.className = 'proj-drawer proj-drawer--other';
      drawer.id = 'proj-drawer-other';
      list.appendChild(drawer);
      // A search lists every match under it, so they count as shown too.
      if (found) for (const group of otherGroups) shown.push(...group.sessions);
    }
  }

  projectsUi.searchShown = shown;
  // morphdom leaves an existing drawer alone. Its session rows carry their
  // click handlers as properties and have no ids, so morphing them would
  // reuse rows by position and leave a row opening the session that used to
  // sit there.
  morphdom(projectsContent, list, {
    childrenOnly: true,
    getNodeKey(node) { return node.id || undefined; },
    onBeforeElUpdated(fromEl) { return !fromEl.classList?.contains('proj-drawer'); },
  });
  bindProjectList();
  refreshProjectDrawers();
  // Every row shows plan and todo counts: read those two files once per project.
  for (const project of projects) loadProjectCounts(project);
  // Every project, not the search's subset: a wake outside the filter still changes the shelf count.
  const all = tree?.projects || [];
  projectsUi.snoozedKey = projectSnoozedKey(all);
  armProjectWakeTimer(all);
}

function bindProjectList() {
  const newBtn = projectsContent.querySelector('#proj-new-btn');
  if (newBtn) newBtn.onclick = () => showNewProjectDialog();
  const doneToggle = projectsContent.querySelector('#proj-sec-done');
  if (doneToggle) doneToggle.onclick = () => { projectsUi.doneOpen = !projectsUi.doneOpen; renderProjectList(); };
  const snoozedToggle = projectsContent.querySelector('#proj-sec-snoozed');
  if (snoozedToggle) snoozedToggle.onclick = () => { projectsUi.snoozedOpen = !projectsUi.snoozedOpen; renderProjectList(); };
  const otherToggle = projectsContent.querySelector('#proj-sec-other');
  if (otherToggle) otherToggle.onclick = () => toggleOtherSessions();
  projectsContent.querySelectorAll('.proj-row').forEach(row => {
    const project = findTreeProject(row.dataset.projectId);
    if (!project) return;
    const exclude = row.querySelector('.proj-exclude-btn');
    if (exclude) exclude.onclick = (e) => { e.stopPropagation(); leaveOutOfSearch({ projectId: project.id }); };
    row.onclick = () => selectProject(project.id);
    row.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(projectMenuItems(project), { x: e.clientX, y: e.clientY }); };
    const toggle = row.querySelector('.proj-expand');
    if (toggle) toggle.onclick = (e) => { e.stopPropagation(); toggleProjectDrawer(project.id); };
    const mark = row.querySelector('.proj-mark-btn');
    if (mark) mark.onclick = (e) => { e.stopPropagation(); chooseProjectIcon(findTreeProject(project.id) || project); };
    const star = row.querySelector('.proj-star');
    if (star) star.onclick = (e) => { e.stopPropagation(); toggleProjectStar(project); };
    const plus = row.querySelector('.proj-new');
    if (plus) plus.onclick = (e) => { e.stopPropagation(); showNewSessionMenu(findTreeProject(project.id) || project, null, e.currentTarget); };
    bindOrderDrag(row, setStarredOrder);
  });
  // Bound here rather than on the built rows: morphdom keeps the live nodes.
  projectsContent.querySelectorAll('.proj-search-session').forEach(row => {
    const project = findTreeProject(row.dataset.projectId);
    const session = project && projectSessionsAll(project).find(s => s.sessionId === row.dataset.sessionId);
    if (!session) return;
    row.onclick = () => openSession(session);
    row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showContextMenu(sessionMenuItems(session), { x: e.clientX, y: e.clientY }); };
    const exclude = row.querySelector('.proj-search-exclude');
    if (exclude) exclude.onclick = (e) => { e.stopPropagation(); leaveOutOfSearch({ sessionId: session.sessionId }); };
  });
}

// --- Sidebar: a project's sessions drawer ---

/** The project's sessions that match the sidebar search, active and archived. */
function projectSearchMatches(project) {
  if (searchMatchIds === null) return [];
  const full = (cachedProjectTreeAll?.projects || []).find(p => p.id === project.id) || project;
  return projectSessionsAll(full)
    .filter(s => searchMatchIds.has(s.sessionId))
    .sort((a, b) => sessionEventTime(b) - sessionEventTime(a));
}

/**
 * Whether a project's drawer is open: the chevron decides. While a search
 * runs, the matches are listed under each project row with their X and the
 * search bar's Stop, so drawers stay closed unless the chevron opens one
 * during that search.
 */
function projectDrawerOpen(project) {
  if (searchMatchIds !== null) return projectsUi.searchDrawerOverride.get(project.id) === true;
  return !!projectsUi.expandedProjects[project.id];
}

/** Open or close the sessions drawer under a project row. */
function toggleProjectDrawer(projectId) {
  const project = findTreeProject(projectId);
  const open = project ? projectDrawerOpen(project) : !!projectsUi.expandedProjects[projectId];
  if (open) delete projectsUi.expandedProjects[projectId];
  else projectsUi.expandedProjects[projectId] = true;
  if (searchMatchIds !== null) projectsUi.searchDrawerOverride.set(projectId, !open);
  saveProjectsUi();
  renderProjectList();
}

/** Plan phases done of all, todos open of all: the counts on a project row. */
function projectDrawerStats(project) {
  const plan = parsePlan(fileContent(project, 'plan-tracker.md'));
  const todos = parseTodos(fileContent(project, 'todos.md'));
  return {
    planDone: plan.done,
    planTotal: plan.phases.length,
    todosOpen: todos.filter(t => !t.done).length,
    todosTotal: todos.length,
  };
}

/**
 * The drawer under a project row: the project's sessions, grouped the way
 * the combo beside the search field says. The plan and todo counts are on
 * the row itself, and so is the + for a new session in the project. In the
 * Track view every heading keeps its own +, for a session in that track.
 */
function buildProjectDrawer(project) {
  const wrap = document.createElement('div');
  wrap.appendChild(buildSessionPaneList(project));
  return wrap;
}

/**
 * Put freshly built content in a drawer. Skipped when nothing visible
 * changed: a running session refreshes the list every few seconds and the
 * rows must not flicker under the pointer.
 */
function replaceDrawerContent(el, next) {
  if (el.innerHTML === next.innerHTML) return false;
  el.replaceChildren(...next.childNodes);
  return true;
}

const projectCountsLoading = new Set();

/**
 * Plan and todo counts come from the project folder: read plan-tracker.md and
 * todos.md once, then show them on the row and in its drawer. Later changes
 * arrive through onProjectPlanChanged.
 */
function loadProjectCounts(project) {
  const unread = fileContent(project, 'plan-tracker.md') === null || fileContent(project, 'todos.md') === null;
  if (!unread || projectCountsLoading.has(project.id)) return;
  projectCountsLoading.add(project.id);
  loadProjectFiles(project, { names: ['plan-tracker.md', 'todos.md'] })
    .finally(() => projectCountsLoading.delete(project.id))
    .then(() => refreshProjectCounts(project.id));
}

/** Show a project's plan and todo counts again on its row (and redraw its drawer). */
function refreshProjectCounts(projectId) {
  const project = findTreeProject(projectId);
  const row = project && document.getElementById('proj-' + projectId);
  if (row) applyProjectSubline(row, project);
  refreshProjectDrawer(projectId);
}

function renderProjectDrawer(project, el) {
  loadProjectCounts(project);
  replaceDrawerContent(el, buildProjectDrawer(project));
}

/** Redraw one project's drawer, if it is open. */
function refreshProjectDrawer(projectId) {
  if (!projectsContent || !projectId) return;
  const el = document.getElementById('proj-drawer-' + projectId);
  const project = findTreeProject(projectId);
  if (el && project) renderProjectDrawer(project, el);
}

/** Redraw every open drawer, the "No project" one included. */
function refreshProjectDrawers() {
  if (!projectsContent) return;
  projectsContent.querySelectorAll('.proj-drawer[data-project-id]').forEach(el => {
    const project = findTreeProject(el.dataset.projectId);
    if (project) renderProjectDrawer(project, el);
  });
  const other = document.getElementById('proj-drawer-other');
  if (other) replaceDrawerContent(other, buildOtherSessionsDrawer());
}

// --- Sidebar: sessions that belong to no project ---

/** A stand-in project for session rows outside every project: no tracks, so no track tag. */
const NO_PROJECT = { id: null, tracks: [], sessions: [] };

/**
 * The sessions no project claims, grouped by folder like the Sessions tab:
 * folders by their latest session, sessions newest first. The Sessions tab's
 * own folder list is the source, so archived sessions follow its Archive
 * switch, and a search narrows the list to its matches.
 */
function sessionsWithoutProject() {
  const searching = searchMatchIds !== null;
  const folders = (searching || showArchived) ? cachedAllProjects : cachedProjects;
  const groups = [];
  for (const folder of folders || []) {
    const sessions = (folder.sessions || [])
      .filter(s => !projectForSession(s) && (!searching || (searchMatchIds.has(s.sessionId) && !searchExcluded.sessions.has(s.sessionId))))
      .sort((a, b) => sessionEventTime(b) - sessionEventTime(a));
    if (sessions.length) groups.push({ folder, sessions });
  }
  return groups.sort((a, b) => sessionEventTime(b.sessions[0]) - sessionEventTime(a.sessions[0]));
}

/** The "No project" row is open by its own toggle, or while a search finds sessions under it. */
function otherSessionsOpen() {
  if (searchMatchIds !== null) {
    const override = projectsUi.searchDrawerOverride.get('other');
    return override !== undefined ? override : true;
  }
  return projectsUi.otherOpen;
}

function toggleOtherSessions() {
  const open = otherSessionsOpen();
  projectsUi.otherOpen = !open;
  if (searchMatchIds !== null) projectsUi.searchDrawerOverride.set('other', !open);
  saveProjectsUi();
  renderProjectList();
}

/**
 * A folder starts open unless its newest session is older than the Sessions
 * tab's age limit, the same rule that folds a stale folder there. A search
 * opens every folder with a match.
 */
function otherFolderOpen(folder, sessions) {
  if (searchMatchIds !== null) return true;
  const chosen = projectsUi.otherFolders[folder.projectPath];
  if (chosen !== undefined) return chosen;
  const newest = sessionEventTime(sessions[0]);
  return !newest || Date.now() - newest <= sessionMaxAgeDays * 86400000;
}

function buildOtherSessionsDrawer() {
  const wrap = document.createElement('div');
  const scroll = document.createElement('div');
  scroll.className = 'pane-scroll';
  const searching = searchMatchIds !== null;
  for (const { folder, sessions } of sessionsWithoutProject()) {
    const open = otherFolderOpen(folder, sessions);
    const head = document.createElement('div');
    head.className = 'pane-sec pane-sec--folder' + (open ? ' open' : '');
    head.title = folder.projectPath;
    head.innerHTML = `${PICONS.chevronRight(9)}<span class="pane-sec-title">${escapeHtml(shortProjectPath(folder.projectPath))}</span><span class="pane-sec-count">${sessions.length}</span>` +
      `<span class="ws-flex"></span><button type="button" class="pane-icon-btn pane-sec-plus" title="New session in this folder" aria-label="New session in this folder">${PICONS.plus(11)}</button>`;
    head.onclick = () => {
      projectsUi.otherFolders[folder.projectPath] = !open;
      refreshProjectDrawers();
    };
    head.querySelector('.pane-sec-plus').onclick = (e) => { e.stopPropagation(); showNewSessionPopover(folder, e.currentTarget); };
    scroll.appendChild(head);
    if (!open) continue;

    const key = `other:${folder.projectPath}`;
    const limit = searching || projectsUi.expandedLists[key] ? Infinity : visibleSessionCount;
    for (const s of sessions.slice(0, limit)) scroll.appendChild(buildSessionRow(NO_PROJECT, s, {
      showTrack: false,
      className: s.archived ? 'pane-session pane-session--archived' : 'pane-session',
    }));
    if (sessions.length > limit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'pane-more';
      more.textContent = `+ ${sessions.length - limit} older`;
      more.onclick = () => { projectsUi.expandedLists[key] = true; refreshProjectDrawers(); };
      scroll.appendChild(more);
    }
  }
  wrap.appendChild(scroll);
  return wrap;
}

/**
 * Cmd+Shift+[ / ] in the Projects tab: the rows the user sees around the
 * session on screen. With a session open, its project's drawer (or the same
 * grouping when the drawer is closed); for a session outside every project,
 * the "No project" list; otherwise the page's track cards.
 */
function projectsTabNavRows() {
  if (projectsUi.working) return workingSessionNavRows();
  const active = activeSessionId ? sessionMap.get(activeSessionId) : null;
  if (active && !projectForSession(active) && projectViewer.style.display === 'none') {
    const other = document.getElementById('proj-drawer-other');
    return other ? [...other.querySelectorAll('.pane-session[data-session-id]')] : [];
  }
  return [...projectViewer.querySelectorAll('.pane-session[data-session-id], .tcard-session[data-session-id]')];
}

function workingSessionNavRows() {
  const project = selectedProject();
  if (!project) return [];
  const drawer = document.getElementById('proj-drawer-' + project.id);
  if (drawer) return [...drawer.querySelectorAll('.pane-session[data-session-id]')];
  return groupSessions(project, paneGroupMode(project))
    .flatMap(group => group.sessions)
    .map(session => ({ dataset: { sessionId: session.sessionId } }));
}

function selectProject(id, { tab } = {}) {
  // Moving to another project drops the session that was open: it belongs to
  // the project you left, so it must not stay focused in the one you opened.
  const active = activeSessionId ? sessionMap.get(activeSessionId) : null;
  if (active && projectForSession(active)?.project?.id !== id) {
    setActiveSession(null);
    document.querySelectorAll('.terminal-container.visible').forEach(el => el.classList.remove('visible'));
    document.querySelectorAll('.session-item.active, .pane-session.here').forEach(el => el.classList.remove('active', 'here'));
    if (typeof terminalHeader !== 'undefined') terminalHeader.style.display = 'none';
  }
  projectsUi.selectedProjectId = id;
  // Opening a project that woke ends the snooze for good: the "woke" note
  // goes and the columns clear. Until then the note marks what came back.
  const opened = findTreeProject(id);
  if (opened && projectWokeAt(opened, Date.now())) {
    opened.snoozedUntil = null;
    opened.snoozedAt = null;
    window.api.updateProject(id, { snoozedUntil: null }).catch(() => {});
    updateProjectStatusDots(); // the violet dot goes as soon as the project is opened
  }
  if (tab) {
    setProjectTab(id, tab);
    rememberProjectOverview(id);
  }
  saveProjectsUi();
  projectsContent.querySelectorAll('.proj-row').forEach(r => r.classList.toggle('selected', r.dataset.projectId === id));
  showRememberedProjectView();
}

// --- Main area: which project view to show ---

/** Hide every piece of project chrome. Called by hideAllViewers and the other openers. */
function hideProjectChrome() {
  if (projectViewer) projectViewer.style.display = 'none';
  leaveWorking();
}

/** Restore this project's own last view without relaunching a closed session. */
function showRememberedProjectView() {
  const project = selectedProject();
  if (project) {
    const state = projectNavigation(project);
    if (state.tab === 'session' && !gridViewActive && projectTabSession(project)) {
      showSession(state.sessionId);
      return;
    }
    showProjectOverview();
    return;
  }
  hideAllViewers();
  placeholder.style.display = '';
}

/** The main area for the Projects tab: that project's remembered view. */
function showProjectHome() {
  showRememberedProjectView();
}

/** Called when the user leaves the Projects tab, or the Sessions tab, which shows a project's page around its sessions. */
function leaveProjectViews() {
  if (projectViewer) projectViewer.style.display = 'none';
  leaveWorking();
}

/**
 * Re-render whatever project view is on screen (after loadProjects).
 *
 * A running session writes its transcript constantly and every write reaches
 * the renderer as projects-changed, so `reason: 'sessions'` means "only the
 * sessions moved". That patches the page in place instead of rebuilding it:
 * a full rebuild throws away the Plan tab, an open Add-todo field and any
 * inline edit several times a minute. A real project change (rename, attach,
 * brief or plan write) still re-renders the page.
 */
function refreshProjectViews({ reason = 'project' } = {}) {
  renderProjectList();
  // The Sessions tab shows a project's page too, around a session of the project (onSessionShown).
  if (activeTab !== 'projects' && activeTab !== 'sessions') return;
  if (projectsUi.working) {
    const session = activeSessionId ? sessionMap.get(activeSessionId) : null;
    const info = projectForSession(session);
    // A stopped or closed session leaves the page header and the Session tab
    // in place, the way the Sessions tab keeps its list. The area under the
    // tabs shows whatever that tab would show: the placeholder, or the
    // terminal behind its exit banner.
    const project = info?.project || selectedProject();
    if (project) {
      if (reason === 'sessions') applySessionStatus(project);
      else renderOverview();
      ensureWorkingTerminalVisible(project);
    } else leaveWorking();
  } else if (projectViewer && projectViewer.style.display !== 'none') {
    const project = selectedProject();
    if (!project) { projectViewer.style.display = 'none'; placeholder.style.display = ''; }
    else if (reason === 'sessions' || editingInPage()) applySessionStatus(project);
    else {
      // A save re-renders the page; keep the field the user is in.
      const active = document.activeElement;
      const focusId = active && projectViewer.contains(active) ? active.id : null;
      renderOverview();
      const again = focusId ? projectViewer.querySelector('#' + CSS.escape(focusId)) : null;
      if (again && again !== document.activeElement) again.focus();
    }
  }
  updateProjectStatusDots();
}

/**
 * Project refreshes rebuild the page header, not the terminal. Keep the live
 * terminal as an explicit invariant anyway: another viewer can leave the
 * terminal area hidden, and a class lost during a surrounding re-render
 * otherwise produces a blank Session tab until the row is clicked again.
 */
function ensureWorkingTerminalVisible(project, { refit = false } = {}) {
  if (!projectsUi.working || gridViewActive || activeTaskView || !activeSessionId) return;
  // The transcript occupies the same content pane as the terminal.
  if (jsonlViewer.style.display !== 'none') return;
  const entry = openSessions.get(activeSessionId);
  const session = sessionMap.get(activeSessionId) || entry?.session;
  const rememberedHere = projectNavigation(project).tab === 'session' &&
    projectNavigation(project).sessionId === activeSessionId;
  if (!entry || (projectForSession(session)?.project?.id !== project.id && !rememberedHere)) return;

  let repaired = false;
  if (!mainEl.classList.contains('project-working')) {
    mainEl.classList.add('project-working');
    repaired = true;
  }
  if (projectViewer.style.display === 'none') {
    projectViewer.style.display = 'flex';
    renderOverview();
    repaired = true;
  }
  if (terminalArea.style.display === 'none') {
    terminalArea.style.display = '';
    repaired = true;
  }
  if (!entry.element.classList.contains('visible')) {
    document.querySelectorAll('.terminal-container.visible').forEach(el => el.classList.remove('visible'));
    entry.element.classList.add('visible');
    repaired = true;
  }
  placeholder.style.display = 'none';
  const header = document.getElementById('terminal-header');
  if (header && header.style.display === 'none') header.style.display = '';
  // A repair can change the terminal's available geometry even when none of
  // its visibility classes changed. Refit on that path so xterm's canvas
  // cannot remain sized for the pre-project layout and look blank.
  if (repaired || refit) fitAndScroll(entry);
}

/**
 * True while the user is typing a todo on the page. Neither input carries an
 * id, so the focus restore above cannot bring them back; nothing may rebuild
 * the page under them.
 */
function editingInPage() {
  const active = document.activeElement;
  if (!active || !projectViewer?.contains(active)) return false;
  return active.classList.contains('ws-todo-input') || active.classList.contains('ws-todo-edit');
}

/** The session ids and states a track card is currently showing. */
function cardSessionKey(sessions) {
  return sessions.map(s => s.sessionId + ':' + sessionState(s)).join('|');
}

/**
 * Patch the project page for a session change: the header dot and task badge,
 * and any track card whose sessions moved. Everything else — the tracks
 * section, the side cards, the Plan tab, the Files tab — is left alone, in the
 * same spirit as applyGitStatus. updateProjectStatusDots does the dots
 * themselves right after this.
 */
function applySessionStatus(project) {
  if (!projectViewer) return;
  updateProjectHeaderStatus(project);

  const running = runningTasksFor(project);
  const badge = projectViewer.querySelector('#ws-tasks .project-task-count');
  if (badge) {
    badge.textContent = running || '';
    badge.style.display = running ? '' : 'none';
  }

  // The Worktrees tab counts the sessions running in each worktree.
  if (projectTab(project) === 'git' && typeof projectGitView === 'function' && projectGitView(project) === 'worktrees' &&
    typeof applyWorktreeSessionCounts === 'function') applyWorktreeSessionCounts(project);
  // Only the Overview tab shows sessions; the others do not care.
  if (projectTab(project) !== 'overview') return;
  for (const card of projectViewer.querySelectorAll('.tcard[data-track-key]')) {
    const key = card.dataset.trackKey;
    const track = key === 'general' ? null : (project.tracks || []).find(t => t.id === key);
    if (key !== 'general' && !track) continue;
    const next = cardSessionKey(sessionsOfTrack(project, key));
    if (next === card.dataset.sessionKey) continue;
    card.replaceWith(buildTrackCard(project, track));
  }
}

// --- Session hook: keep the project around the terminal ---

/**
 * Called at the end of showSession(). Opens the project's Session tab, or
 * leaves it. From the Sessions tab too: a project's session opens under its
 * project's header and tabs, and the sidebar stays on its list.
 */
function onSessionShown(sessionId) {
  if (activeTab !== 'projects' && activeTab !== 'sessions') return;
  if (gridViewActive) { leaveWorking(); return; }
  const session = sessionMap.get(sessionId);
  const info = projectForSession(session);
  if (!info) { leaveWorking(); return; }
  enterWorking(info.project, session);
}

/** Messages use the working layout too, including sessions with no live PTY. */
function onMessagesShown(session) {
  if (activeTab !== 'projects' && activeTab !== 'sessions') return;
  const info = projectForSession(session);
  if (info) enterWorking(info.project, session);
}

/** Called by showTaskLog. A task log opens on the Session tab, under the project's header. */
function onTaskLogShown() {
  if (activeTab !== 'projects') return;
  const project = selectedProject();
  if (!project) return;
  enterWorking(project, null);
}

/**
 * Show the Session tab: the page header and tabs stay, and the terminal (or
 * the messages, or a task log) fills the area under them.
 */
function enterWorking(project, session) {
  if (projectsUi.selectedProjectId !== project.id) {
    projectsUi.selectedProjectId = project.id;
    projectsContent.querySelectorAll('.proj-row').forEach(r => r.classList.toggle('selected', r.dataset.projectId === project.id));
  }
  if (session) {
    projectsUi.trackByProject[project.id] = session.trackId || 'general';
    rememberProjectSession(project, session.sessionId);
  } else {
    projectNavigation(project).tab = 'session';
  }
  saveProjectsUi();
  const wasWorking = projectsUi.working;
  projectsUi.working = true;
  mainEl.classList.add('project-working');
  if (projectViewer) {
    projectViewer.style.display = 'flex';
    renderOverview();
    syncWorkingHeaderHeight();
  }
  // The drawers mark the session on screen.
  refreshProjectDrawers();
  if (!wasWorking) requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

/**
 * The terminal starts under the page header and tabs, whose height depends
 * on the folder chips. Measured, not guessed: a stale value would hide the
 * first terminal rows or leave a gap.
 */
let workingHeaderHeight = 0;
function syncWorkingHeaderHeight() {
  if (!projectsUi.working || !projectViewer || projectViewer.style.display === 'none') return false;
  const height = Math.round(projectViewer.getBoundingClientRect().height);
  if (!height || height === workingHeaderHeight) return false;
  workingHeaderHeight = height;
  mainEl.style.setProperty('--ws-head-h', height + 'px');
  return true;
}

if (projectViewer && typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    // The terminal follows the header; refit it when the header grows or shrinks.
    if (syncWorkingHeaderHeight()) window.dispatchEvent(new Event('resize'));
  }).observe(projectViewer);
}

function leaveWorking() {
  if (!projectsUi.working) return;
  projectsUi.working = false;
  mainEl.classList.remove('project-working');
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

/**
 * Open a tab of the selected project's page. The Session tab brings back the
 * session it remembers; any other tab leaves the session running behind it.
 */
function showProjectTab(project, tab) {
  if (tab === 'session') {
    const session = projectTabSession(project);
    if (session) { showSession(session.sessionId); return; }
    // The Session tab can stay on screen for a task log with no session behind it.
    if (projectsUi.working) return;
    tab = 'overview';
  }
  setProjectTab(project, tab);
  if (projectsUi.working || !projectViewer || projectViewer.style.display === 'none') showProjectOverview();
  else renderOverview();
}

// --- Overview page ---

function showProjectOverview() {
  const project = selectedProject();
  if (!project) return;
  rememberProjectOverview(project);
  leaveWorking();
  hideAllViewers();
  terminalArea.style.display = 'none';
  placeholder.style.display = 'none';
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  projectViewer.style.display = 'flex';
  renderOverview();
}

// --- Folder git state. A worktree's branch is fixed when it is attached; an
// in-place folder is on whatever is checked out right now, so that is read
// live and cached briefly. ---
const GIT_STATUS_TTL_MS = 30000;

function folderGit(project, folder) {
  return projectsUi.git.get(project.id)?.byPath?.[folder.path] || null;
}

function folderBranch(project, folder) {
  if (folder.mode === 'worktree') return folder.branch || '';
  const g = folderGit(project, folder);
  return g?.git ? g.branch : '';
}

function folderChipLabel(project, folder) {
  const branch = folderBranch(project, folder);
  return branch ? `${pathBasename(folder.path)} · ${branch}` : pathBasename(folder.path);
}

/** The header chip's label: the folder's name, then its branch in bold. */
function folderChipLabelHtml(project, folder) {
  const branch = folderBranch(project, folder);
  const name = `<span class="ws-chip-name">${escapeHtml(pathBasename(folder.path))}</span>`;
  return branch ? `${name}<span class="ws-chip-sep"> · </span><b class="ws-chip-branch">${escapeHtml(branch)}</b>` : name;
}

/** Folders card: "worktree · main", "in place · main · modified", or "in place". */
function folderModeText(project, folder) {
  const g = folderGit(project, folder);
  const dirty = g?.git && g.dirty ? ' · modified' : '';
  if (folder.mode === 'worktree') return `worktree · ${folder.branch || ''}${dirty}`;
  return g?.git ? `in place · ${g.branch}${dirty}` : 'in place';
}

/** Settings row: branch and dirty marker, then where the folder came from or lives. */
function folderSettingsText(project, folder) {
  const g = folderGit(project, folder);
  const dirty = g?.git && g.dirty ? ' · modified' : '';
  if (folder.mode === 'worktree') return `on ${folder.branch || ''}${dirty} · from ${folder.sourcePath || ''}`;
  return g?.git ? `on ${g.branch}${dirty} · ${folder.path}` : folder.path;
}

function folderChipHtml(project, folder) {
  const isWorktree = folder.mode === 'worktree';
  const icon = isWorktree ? PICONS.branch(12) : PICONS.folder(12);
  return `<span class="ws-chip mono ${isWorktree ? 'ws-chip--worktree' : ''}" data-path="${escapeHtml(folder.path)}" title="${escapeHtml(folder.path)}">${icon}<span class="ws-chip-label">${folderChipLabelHtml(project, folder)}</span></span>`;
}

/** Fetch git state for the project's folders unless the cache is fresh and covers every folder. Resolves true when something changed. */
async function loadProjectGit(project, { force = false } = {}) {
  const cached = projectsUi.git.get(project.id);
  const covers = !!cached && (project.folders || []).every(f => f.path in (cached.byPath || {}));
  if (!force && covers && Date.now() - cached.at < GIT_STATUS_TTL_MS) return false;
  let result = null;
  try { result = await window.api.getProjectGitStatus(project.id, { force }); } catch {}
  if (!result?.ok) return false;
  const changed = JSON.stringify(cached?.byPath || null) !== JSON.stringify(result.byPath);
  projectsUi.git.set(project.id, { at: Date.now(), byPath: result.byPath });
  return changed;
}

/** Patch the folder chips and rows in place, so a refresh never disturbs a field being edited. */
function applyGitStatus(project) {
  for (const folder of project.folders || []) {
    const sel = `[data-path="${CSS.escape(folder.path)}"]`;
    projectViewer.querySelectorAll(`.ws-chip${sel} .ws-chip-label`).forEach(el => { el.innerHTML = folderChipLabelHtml(project, folder); });
    projectViewer.querySelectorAll(`.ws-frow${sel}[data-detail="mode"] .ws-card-meta`).forEach(el => { el.textContent = folderModeText(project, folder); });
    projectViewer.querySelectorAll(`.ws-frow${sel}[data-detail="settings"] .ws-frow-detail`).forEach(el => { el.textContent = folderSettingsText(project, folder); });
  }
}

function renderOverview() {
  const project = selectedProject();
  if (!project || !projectViewer) return;
  hideSessionHoverPreview();
  // The Session tab is the terminal under this header; outside the working
  // layout there is nothing to put under it.
  if (projectTab(project) === 'session' && !projectsUi.working) setProjectTab(project, 'overview');
  const tabName = projectTab(project);
  const tabSession = projectTabSession(project);
  const showSessionTab = tabName === 'session' || !!tabSession;
  const running = runningTasksFor(project);
  const sessions = projectSessionsAll(project);
  const state = groupState(sessions);

  const header = PROJECT_WINDOW ? projectWindowHeaderHtml(project, tabName) : `
    <div class="ws-header">
      <div class="ws-title-row">
        ${markHtml(project, 38, 'proj-mark--lg')}
        <div class="ws-title-text">
          <div class="ws-title-line">
            <span class="ws-title">${escapeHtml(project.name)}</span>
            ${projectStatusChip(project)}
            <span class="ws-title-status">${state ? stateDot(state, 'proj-dot--lg') : ''}</span>
            <span class="ws-flex"></span>
            <div class="ws-actions">
              <button type="button" class="ws-btn" id="ws-note" title="The project's notes (note.md), in a panel over the app">${PICONS.note(12)}<span>Note</span></button>
              <button type="button" class="ws-btn project-task-btn" id="ws-tasks" data-project-id="${project.id}" data-project-path="${escapeHtml(project.root)}" data-project-paths="${escapeHtml(taskPseudoProject(project).projectPaths.join('\n'))}">${PICONS.play(12)}<span>Tasks</span><span class="project-task-count ws-badge" ${running ? '' : 'style="display:none"'}>${running || ''}</span></button>
              ${scheduleButtonHtml(project, 'ws-schedules')}
              <button type="button" class="ws-btn ws-btn--primary" id="ws-new">${PICONS.plus(12)}<span>New session</span>${PICONS.chevronDown(11)}</button>
              <button type="button" class="ws-btn ws-btn--icon" id="ws-more" title="More">${PICONS.dots(14)}</button>
            </div>
          </div>
          <div class="ws-chips">
            <button type="button" class="ws-chip ws-chip--add" id="ws-add-folder">${PICONS.plus(10)}<span>folder</span></button>
            ${(project.folders || []).map(f => folderChipHtml(project, f)).join('')}
          </div>
        </div>
      </div>
      <div class="ws-tabs">
        ${tabWithWindow('overview', `<button type="button" class="ws-tab ${tabName === 'overview' ? 'active' : ''}" data-tab="overview">Overview</button>`)}
        ${showSessionTab ? `<button type="button" class="ws-tab ws-tab--session ${tabName === 'session' ? 'active' : ''}" data-tab="session" title="${escapeHtml(tabSession ? sessionTitle(tabSession) : 'The open session')}">Session${stateDot(sessionTabState(project), 'ws-tab-dot')}</button>` : ''}
        ${tabWithWindow('plan', `<button type="button" class="ws-tab ${tabName === 'plan' ? 'active' : ''}" data-tab="plan" title="Phases from plan-tracker.md, with the sessions that worked on them">Plan <span class="ws-tab-meta" id="ws-tab-plan-meta"></span></button>`)}
        ${tabWithWindow('todos', `<button type="button" class="ws-tab ${tabName === 'todos' ? 'active' : ''}" data-tab="todos" title="The todos from todos.md, with the sessions that worked on them">Todos <span class="ws-tab-meta" id="ws-tab-todos-meta"></span></button>`)}
        ${tabWithWindow('files', `<button type="button" class="ws-tab ${tabName === 'files' ? 'active' : ''}" data-tab="files" title="The project folder: brief, plan, todos and anything else the project keeps">Files</button>`)}
        ${tabWithWindow('git', `<button type="button" class="ws-tab ${tabName === 'git' ? 'active' : ''}" data-tab="git" title="Working changes, the commit graph with its actions (branch, merge, rebase, stash and more), the worktrees, the pull requests and GitHub Actions">Git</button>`)}
        ${tabWithWindow('knowledge', `<button type="button" class="ws-tab ${tabName === 'knowledge' ? 'active' : ''}" data-tab="knowledge" title="The attached folders as code graphs (codebase-memory-mcp): architecture, search, call traces, the impact of a change, Cypher queries and more">Node Knowledge</button>`)}
        ${tabWithWindow('env', `<button type="button" class="ws-tab ${tabName === 'env' ? 'active' : ''}" data-tab="env" title="The local.env.sh of the project folder and of each attached folder, which a session sources before it starts">Env</button>`)}
        ${tabWithWindow('settings', `<button type="button" class="ws-tab ${tabName === 'settings' ? 'active' : ''}" data-tab="settings">Settings</button>`)}
      </div>
    </div>`;
  // The tab bar keeps where it was scrolled to when the page is drawn again.
  const tabsScroll = projectViewer.querySelector('.ws-tabs')?.scrollLeft || 0;
  projectViewer.innerHTML = `${header}
    <div class="ws-body" id="ws-body"></div>`;
  bindWorkspaceTabs(projectViewer.querySelector('.ws-tabs'), tabsScroll);

  const body = projectViewer.querySelector('#ws-body');
  // The Session tab's content is the terminal area, laid out under the header by CSS.
  if (PROJECT_WINDOW && PROJECT_WINDOW.tab === 'note') renderNoteWindow(project, body);
  else if (tabName === 'session') body.replaceChildren();
  else if (tabName === 'settings') renderSettings(project, body);
  else if (tabName === 'files') renderFilesTab(project, body);
  else if (PLAN_TABS.has(tabName)) renderPlanTab(project, body, tabName);
  else if (tabName === 'git' && PROJECT_WINDOW && PROJECT_WINDOW.compare) renderGitCompareWindow(project, body);
  else if (tabName === 'git' && PROJECT_WINDOW && PROJECT_WINDOW.file) renderGitFileWindow(project, body);
  else if (tabName === 'git') renderProjectGitWorkspace(project, body);
  else if (tabName === 'knowledge') renderKnowledgeTab(project, body);
  else if (tabName === 'env') renderEnvTab(project, body);
  else renderOverviewBody(project, body);

  if (PROJECT_WINDOW) {
    setupWindowPin(projectViewer.querySelector('#tool-window-pin'));
    projectViewer.querySelectorAll('[data-window-tab]').forEach(btn => {
      btn.onclick = () => switchProjectWindowTab(project, btn.dataset.windowTab);
    });
  } else {
    projectViewer.querySelectorAll('.ws-tab:not([disabled])').forEach(tab => {
      tab.onclick = () => showProjectTab(project, tab.dataset.tab);
    });
    projectViewer.querySelectorAll('.ws-tab-window').forEach(btn => {
      btn.onclick = () => window.api.openProjectWindow(project.id, btn.dataset.windowTab);
    });
    projectViewer.querySelector('#ws-new').onclick = (e) => showNewSessionMenu(project, null, e.currentTarget);
    projectViewer.querySelector('#ws-more').onclick = (e) => showContextMenu(projectMenuItems(project, { fromPage: true }), { anchor: e.currentTarget });
    projectViewer.querySelector('#ws-note').onclick = () => openProjectNote(project);
    projectViewer.querySelector('#ws-tasks').onclick = (e) => showTaskPopover(taskPseudoProject(project), e.currentTarget);
    projectViewer.querySelector('#ws-schedules').onclick = (e) => showProjectScheduleMenu(project, e.currentTarget);
    projectViewer.querySelector('#ws-add-folder').onclick = () => attachFolderAsk(project);
  }
  loadProjectFiles(project).then(() => { if (selectedProject()?.id === project.id) renderPlanMeta(project); });
  loadProjectGit(project).then(changed => { if (changed && selectedProject()?.id === project.id) applyGitStatus(project); });
}

// --- A tab of the project in a window of its own (project-window.js) ---
// Every tab but Session, whose terminal stays in the main window.
const PROJECT_WINDOW_TAB_LABELS = { overview: 'Overview', plan: 'Plan', todos: 'Todos', files: 'Files', git: 'Git', knowledge: 'Node Knowledge', env: 'Env', settings: 'Settings' };
const PROJECT_WINDOW_TAB_ORDER = ['overview', 'plan', 'todos', 'files', 'git', 'knowledge', 'env', 'settings'];

/**
 * A tab chosen in a tab's window: the window moves to it (main.js keeps it
 * under its new tab, to open it there again at the next start). When that
 * tab already has a window of its own, main.js brings that one forward and
 * this window stays as it is.
 */
async function switchProjectWindowTab(project, tab) {
  if (!PROJECT_WINDOW || PROJECT_WINDOW.tab === tab || !PROJECT_WINDOW_TAB_LABELS[tab]) return;
  let result;
  try { result = await window.api.switchProjectWindowTab(tab); } catch { return; }
  if (!result?.switched) return;
  PROJECT_WINDOW.tab = tab;
  // A reload of the window shows the tab it is on now.
  try {
    const url = new URL(location.href);
    url.searchParams.set('tab', tab);
    history.replaceState(null, '', url.href);
  } catch {}
  setProjectTab(project, tab);
  renderOverview();
}

/** A tab of the strip with the button beside it that opens the tab in a window of its own. */
function tabWithWindow(tab, tabButton) {
  const label = PROJECT_WINDOW_TAB_LABELS[tab];
  return `<span class="ws-tab-group">${tabButton}<button type="button" class="ws-tab-window" data-window-tab="${tab}" title="Open ${label} in a window of its own" aria-label="Open ${label} in a window of its own">${ICONS.popOut(12)}</button></span>`;
}

/** The header of a project window: the project, the tab it shows and the pin. */
function projectWindowHeaderHtml(project, tabName) {
  const note = PROJECT_WINDOW.tab === 'note';
  const label = PROJECT_WINDOW.compare ? 'Compare'
    : PROJECT_WINDOW.file ? (pathBasename(PROJECT_WINDOW.file.path) || PROJECT_WINDOW.file.path)
      : note ? 'Note'
        : (PROJECT_WINDOW_TAB_LABELS[tabName] || 'Overview');
  document.title = `${project.name} · ${label}`;
  const state = groupState(projectSessionsAll(project));
  // A tab's window shows the other tabs too, to move to one of them in place.
  // A comparison, a file and the note show only what they were opened for.
  const tabs = !note && !PROJECT_WINDOW.compare && !PROJECT_WINDOW.file;
  const tabStrip = tabs ? `
        <nav class="ws-window-tabs" aria-label="Tabs of ${escapeHtml(project.name)}">
          ${PROJECT_WINDOW_TAB_ORDER.map(tab => `<button type="button" class="ws-window-tab-btn${tab === tabName ? ' active' : ''}" data-window-tab="${tab}"${tab === tabName ? ' aria-current="page"' : ''}>${escapeHtml(PROJECT_WINDOW_TAB_LABELS[tab])}</button>`).join('')}
        </nav>` : '';
  return `
    <div class="ws-header ws-header--window">
      <div class="ws-title-row">
        ${markHtml(project, 26)}
        <div class="ws-title-line">
          <span class="ws-title">${escapeHtml(project.name)}</span>
          ${tabs ? '' : `<span class="ws-window-tab">${escapeHtml(label)}</span>`}
          <span class="ws-title-status">${state ? stateDot(state, 'proj-dot--lg') : ''}</span>
        </div>${tabStrip}
        <span class="ws-flex"></span>
        <button type="button" id="tool-window-pin" class="tool-window-btn" aria-pressed="false"></button>
      </div>
    </div>`;
}

// --- The project page's tab bar: it scrolls sideways in a narrow window ---

let workspaceTabsObserver = null;

/**
 * When the window is too narrow for every tab, the bar scrolls sideways (its
 * scrollbar hidden, as the app's other tab rows): a trackpad swipe or the
 * mouse wheel moves it, a fade shows on the side that has more tabs, and the
 * open tab is kept in sight, as the page is drawn again or the window gets
 * narrower. `scrollLeft` is where the bar was before the page was drawn again.
 */
function bindWorkspaceTabs(tabs, scrollLeft = 0) {
  workspaceTabsObserver?.disconnect();
  workspaceTabsObserver = null;
  if (!tabs) return;
  const sync = () => {
    const max = tabs.scrollWidth - tabs.clientWidth;
    tabs.classList.toggle('more-left', tabs.scrollLeft > 1);
    tabs.classList.toggle('more-right', tabs.scrollLeft < max - 1);
  };
  // The open tab in sight, clear of the fade at that side.
  const reveal = () => {
    const active = tabs.querySelector('.ws-tab.active');
    if (!active) return;
    const item = active.closest('.ws-tab-group') || active;
    const bar = tabs.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    if (rect.left < bar.left) tabs.scrollLeft -= bar.left - rect.left + 28;
    else if (rect.right > bar.right) tabs.scrollLeft += rect.right - bar.right + 28;
  };
  tabs.scrollLeft = scrollLeft;
  reveal();
  tabs.onscroll = sync;
  // A wheel that only turns up and down moves the bar sideways; a sideways swipe scrolls it as it is.
  tabs.onwheel = (e) => {
    if (tabs.scrollWidth <= tabs.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    e.preventDefault();
    tabs.scrollLeft += e.deltaY;
  };
  if (typeof ResizeObserver !== 'undefined') {
    // A window made narrower keeps the open tab in sight, and so does a tab
    // that grows (the plan and todo counts arrive after the page is drawn).
    workspaceTabsObserver = new ResizeObserver(() => { reveal(); sync(); });
    workspaceTabsObserver.observe(tabs);
    for (const item of tabs.children) workspaceTabsObserver.observe(item);
  }
  sync();
}

/** A Compare window's page (main.js openGitCompareWindow): the comparison of its commits, filling the window. */
function renderGitCompareWindow(project, body) {
  const { repo, hashes, labels, subjects } = PROJECT_WINDOW.compare;
  gitGraphRenderCompareView(body, { projectId: project.id, repoPath: repo, hashes, labels: labels || [], subjects: subjects || [] });
}

/** A file window's page (main.js openGitFileWindow): one file of the Git History, filling the window. */
function renderGitFileWindow(project, body) {
  gitGraphRenderFileWindow(body, project.id, PROJECT_WINDOW.file);
}

/** A project window's page, once the projects are loaded: its project on its tab. */
function showProjectWindow() {
  activeTab = 'projects';
  const note = placeholder.querySelector('p');
  if (note) note.textContent = 'This project is not in Switchboard any more.';
  const project = findTreeProject(PROJECT_WINDOW.projectId);
  if (!project) {
    document.title = 'Project not found';
    placeholder.style.display = '';
    return;
  }
  projectsUi.selectedProjectId = project.id;
  setProjectTab(project, PROJECT_WINDOW_TAB_LABELS[PROJECT_WINDOW.tab] ? PROJECT_WINDOW.tab : 'overview');
  showProjectOverview();
}

/** The notes after the Plan and Todos tabs: phases done of all, and the open todos. */
function renderPlanMeta(project) {
  const planMeta = projectViewer?.querySelector('#ws-tab-plan-meta');
  const plan = parsePlan(fileContent(project, 'plan-tracker.md'));
  if (planMeta) planMeta.textContent = plan.phases.length ? `${plan.done}/${plan.phases.length}` : '';
  const todosMeta = projectViewer?.querySelector('#ws-tab-todos-meta');
  const open = parseTodos(fileContent(project, 'todos.md')).filter(t => !t.done).length;
  if (todosMeta) todosMeta.textContent = open ? String(open) : '';
}

function renderOverviewBody(project, body) {
  const tracks = project.tracks || [];
  body.innerHTML = `
    <div class="ws-grid">
      <div class="ws-main">
        <div class="ws-section-head"><span class="ws-section-title">Tracks</span><span class="ws-flex"></span><button type="button" class="ws-ghost" id="ws-new-track">${PICONS.plus(12)}<span>New track</span></button></div>
        <div class="ws-cards" id="ws-cards"></div>
      </div>
      <div class="ws-side" id="ws-side"></div>
    </div>`;
  const cards = body.querySelector('#ws-cards');
  cards.appendChild(buildTrackCard(project, null));
  // Finished tracks sit below the live ones, each keeping its own order.
  const byDoneLast = [...tracks.filter(t => t.status !== 'done'), ...tracks.filter(t => t.status === 'done')];
  for (const track of byDoneLast) cards.appendChild(buildTrackCard(project, track));
  if (!tracks.length && !project.sessions.length) {
    const hint = document.createElement('div');
    hint.className = 'ws-hint';
    hint.textContent = 'Start a session from the header, or add tracks for the lines of work in this project.';
    cards.appendChild(hint);
  }
  body.querySelector('#ws-new-track').onclick = () => promptNewTrack(project);
  renderSideCards(project, body.querySelector('#ws-side'));
  loadProjectFiles(project).then(() => {
    if (selectedProject()?.id !== project.id || projectTab(project) !== 'overview') return;
    if (editingInPage()) return;
    const side = projectViewer.querySelector('#ws-side');
    if (side) renderSideCards(project, side);
  });
}

function sessionsOfTrack(project, trackKey) {
  const list = trackKey === 'general' || !trackKey ? project.sessions : (project.tracks.find(t => t.id === trackKey)?.sessions || []);
  return list.filter(s => !s.archived).sort((a, b) => sessionEventTime(b) - sessionEventTime(a));
}

function buildCardSessionRow(project, session) {
  return buildSessionRow(project, session, { showTrack: false, className: 'pane-session tcard-session', hoverPreview: true });
}

function buildTrackCard(project, track) {
  const key = track ? track.id : 'general';
  const sessions = sessionsOfTrack(project, key);
  const done = track?.status === 'done';
  // A done track is finished work: just its heading, unless the user opens it.
  const doneKey = `${project.id}:${key}`;
  const collapsed = done && !projectsUi.doneCardsOpen[doneKey];
  const card = document.createElement('div');
  card.className = 'tcard' + (track ? '' : ' tcard--general') + (done ? ' tcard--done' : '') + (collapsed ? ' tcard--collapsed' : '');
  card.dataset.trackKey = key;
  card.dataset.projectId = project.id;
  // What this card is showing, so a session-only refresh can tell whether it
  // has to be rebuilt at all (applySessionStatus).
  card.dataset.sessionKey = cardSessionKey(sessions);
  const state = groupState(sessions);
  const cwdLabel = track?.cwd ? (isPathInside(track.cwd, project.root) ? (track.cwd === project.root ? 'project folder' : track.cwd.slice(project.root.length + 1)) : pathBasename(track.cwd)) : (project.defaultCwd ? pathBasename(project.defaultCwd) : 'project folder');
  const head = document.createElement('div');
  head.className = 'tcard-h';
  const colors = trackColors(project, track);
  head.innerHTML = (done ? `<span class="tcard-chevron">${collapsed ? PICONS.chevronRight(10) : PICONS.chevronDown(10)}</span>` : '') +
    stateDot(state) +
    `<span class="tcard-name" style="color:${colors.fg}">${escapeHtml(track ? track.name : 'General')}${done ? '<span class="project-done-chip">done</span>' : ''}</span>` +
    `<span class="tcard-meta mono">${track ? escapeHtml(cwdLabel) : 'sessions not in a track'}</span>` +
    (collapsed && sessions.length ? `<span class="tcard-meta">${sessions.length} session${sessions.length === 1 ? '' : 's'}</span>` : '') +
    `<span class="ws-flex"></span>` +
    (track?.cli ? `<span class="ws-chip ws-chip--cli ${track.cli}" title="${escapeHtml(harnessLabel(track.cli))}">${harnessIcon(track.cli, 12)}</span>` : '') +
    `<button type="button" class="ws-ghost ws-ghost--sm tcard-new">${PICONS.plus(11)}<span>New session</span></button>` +
    (track ? `<button type="button" class="tcard-more" title="Track menu">${PICONS.dots(13)}</button>` : '');
  card.appendChild(head);

  if (done) {
    // The heading toggles the card open; its buttons keep their own jobs.
    head.classList.add('tcard-h--toggle');
    head.onclick = (e) => {
      if (e.target.closest('button')) return;
      if (collapsed) projectsUi.doneCardsOpen[doneKey] = true; else delete projectsUi.doneCardsOpen[doneKey];
      card.replaceWith(buildTrackCard(project, track));
    };
  }
  head.querySelector('.tcard-new').onclick = (e) => launchFromTrack(project, track, e.currentTarget);
  const moreBtn = head.querySelector('.tcard-more');
  if (moreBtn) moreBtn.onclick = (e) => { e.stopPropagation(); showContextMenu(trackMenuItems(project, track), { anchor: e.currentTarget }); };
  if (track) card.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(trackMenuItems(project, track), { x: e.clientX, y: e.clientY }); };
  if (collapsed) return card;

  const shown = sessions.slice(0, visibleSessionCount);
  for (const s of shown) card.appendChild(buildCardSessionRow(project, s));
  if (!sessions.length) {
    const none = document.createElement('div');
    none.className = 'tcard-empty';
    none.textContent = track ? 'No sessions yet.' : 'Nothing here. Sessions started from the header land here.';
    card.appendChild(none);
  }

  const foot = document.createElement('div');
  foot.className = 'tcard-f';
  foot.innerHTML =
    (sessions.length > shown.length ? `<button type="button" class="ws-ghost ws-ghost--muted tcard-more-sessions">+ ${sessions.length - shown.length} more</button>` : '') +
    `<span class="ws-flex"></span>`;
  card.appendChild(foot);
  // Archived sessions of this track sit under the foot, closed until asked for.
  const archived = archivedSessionsOf(project, key);
  if (archived.length) {
    const archKey = `card:${project.id}:${key}`;
    const open = !!projectsUi.archivedOpen[archKey];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-ghost ws-ghost--muted tcard-archived' + (open ? ' open' : '');
    btn.innerHTML = `${PICONS.archive(11)}<span>${archived.length} archived</span>`;
    btn.onclick = () => {
      if (open) delete projectsUi.archivedOpen[archKey]; else projectsUi.archivedOpen[archKey] = true;
      saveProjectsUi();
      // A sessions-only refresh just patches status; the card has to be rebuilt.
      refreshProjectViews();
    };
    foot.appendChild(btn);
    if (open) {
      const list = document.createElement('div');
      list.className = 'tcard-archived-list';
      for (const s of archived) list.appendChild(buildSessionRow(project, s, { showTrack: false, className: 'pane-session tcard-session pane-session--archived', hoverPreview: true }));
      card.appendChild(list);
    }
  }

  // Nothing left to show in the foot once New session moved up to the head.
  if (!foot.querySelector('button')) foot.remove();
  const more = foot.querySelector('.tcard-more-sessions');
  if (more) more.onclick = () => showTrackInDrawer(project, key);
  return card;
}

/**
 * Show a track's full session list: the project's drawer in the sidebar,
 * grouped by track, with that track's list expanded. Asking for the list is
 * the one thing besides the chevron that opens a drawer.
 */
function showTrackInDrawer(project, key) {
  projectsUi.trackByProject[project.id] = key;
  projectsUi.expandedLists[`${project.id}:track:${key}`] = true;
  projectsUi.expandedProjects[project.id] = true;
  saveProjectsUi();
  setSessionGroupMode('track');
  renderProjectList();
  refreshProjectDrawer(project.id);
  const drawer = document.getElementById('proj-drawer-' + project.id);
  const head = drawer && [...drawer.querySelectorAll('.pane-sec')][trackGroupIndex(project, key)];
  (head || drawer)?.scrollIntoView({ block: 'nearest' });
}

/**
 * Open the drawer that holds a session and bring its row into sight: when the
 * app starts again on the session that was open, the sidebar shows it at a
 * glance instead of only marking its project. A long group's "+ N more" opens
 * too when the session is past it; outside every project, the "No project"
 * drawer and the session's folder open.
 */
function revealSessionInProjects(sessionId) {
  const session = sessionMap.get(sessionId);
  if (!session || !projectsContent) return false;
  const found = projectForSession(session);
  if (found) {
    const project = found.project;
    projectsUi.expandedProjects[project.id] = true;
    const mode = paneGroupMode(project);
    const limit = mode === 'track' ? visibleSessionCount : PANE_GROUP_LIMIT;
    const group = groupSessions(project, mode).find(g => g.sessions.some(s => s.sessionId === sessionId));
    const index = group ? group.sessions.findIndex(s => s.sessionId === sessionId) : -1;
    if (group && !group.unlimited && index >= limit) projectsUi.expandedLists[`${project.id}:${mode}:${group.key}`] = true;
  } else {
    projectsUi.otherOpen = true;
    if (session.projectPath) projectsUi.otherFolders[session.projectPath] = true;
    const folder = sessionsWithoutProject().find(g => g.folder.projectPath === session.projectPath);
    const index = folder ? folder.sessions.findIndex(s => s.sessionId === sessionId) : -1;
    if (index >= visibleSessionCount) projectsUi.expandedLists[`other:${session.projectPath}`] = true;
  }
  saveProjectsUi();
  renderProjectList();
  if (found) refreshProjectDrawer(found.project.id); else refreshProjectDrawers();
  const row = projectsContent.querySelector(`.pane-session[data-session-id="${CSS.escape(sessionId)}"]`);
  row?.scrollIntoView({ block: 'nearest' });
  return !!row;
}

/** Where a track's group sits in the drawer's Track view: tracks in order, then General. */
function trackGroupIndex(project, key) {
  return groupSessions(project, 'track').findIndex(group => group.key === key);
}

// --- Side cards: plan, todos, recent files, folders ---

function fileKey(project, name) { return `${project.id}:${name}`; }
function fileContent(project, name) { return projectsUi.files.get(fileKey(project, name))?.content ?? null; }

async function loadProjectFiles(project, { force = false, names = ['CLAUDE.md', 'plan.md', 'plan-tracker.md', 'todos.md'] } = {}) {
  await Promise.all(names.map(async name => {
    const key = fileKey(project, name);
    const cached = projectsUi.files.get(key);
    if (!force && cached && Date.now() - cached.at < 5000) return;
    let content = '';
    try { content = await window.api.readMemory(project.root + '/' + name); } catch {}
    projectsUi.files.set(key, { content: typeof content === 'string' ? content : '', at: Date.now() });
  }));
}


// parsePlan and parseTodos come from plan-parser.js, shared with main so the
// page, the file watcher and the tests read a tracker the same way. Ticks and
// additions go through main (set-plan-item / append-plan-item), which writes
// one line and tells its watcher the page did it.

function planKindFor(name) {
  return name === 'todos.md' ? 'todos' : 'plan';
}

/**
 * Double-click editing for a checkbox line. The text span becomes an input;
 * Enter saves through edit-plan-item, Escape or leaving the field puts the
 * text back. Only the checkbox ever changes the tick.
 */
function editItemInline(project, kind, item, textEl, afterSave) {
  if (textEl.parentElement?.querySelector('.ws-todo-edit')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ws-input ws-todo-edit';
  input.value = item.text;
  input.spellcheck = false;
  let finished = false;
  const restore = () => { if (finished) return; finished = true; input.replaceWith(textEl); };
  input.onkeydown = async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); restore(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text || text === item.text) { restore(); return; }
    input.disabled = true;
    const result = await window.api.editPlanItem(project.id, kind, item.line, text);
    if (result?.error) { alert(result.error); input.disabled = false; input.focus(); return; }
    finished = true;
    item.text = text;
    textEl.textContent = text;
    input.replaceWith(textEl);
    afterSave?.();
  };
  input.onblur = () => { if (!input.disabled) restore(); };
  textEl.replaceWith(input);
  input.focus();
  input.select();
}

async function toggleFileLine(project, name, lineNo, done) {
  const result = await window.api.setPlanItem(project.id, planKindFor(name), lineNo, done);
  if (result?.error) { alert(result.error); return false; }
  await loadProjectFiles(project, { force: true });
  return true;
}

async function appendTodo(project, text) {
  const result = await window.api.appendPlanItem(project.id, 'todos', text);
  if (result?.error) { alert(result.error); return false; }
  await loadProjectFiles(project, { force: true });
  return true;
}

/** Open one of the project's own files on the Files tab, in the page's editor. */
function openProjectFileInEditor(project, name) {
  filesUi(project).root = project.root;
  const state = filesState(project, project.root);
  state.selected = name;
  // A nested file only has a row in the tree once its folders are open.
  const sep = name.includes('/') ? '/' : '\\';
  const parts = name.split(sep);
  for (let i = 1; i < parts.length; i++) state.expanded.add(parts.slice(0, i).join(sep));
  showProjectTab(project, 'files');
}

// --- Plan and Todos tabs: phases from plan-tracker.md, the todos, and who worked on what ---
//
// Data comes from main (get-project-plan): the parsed tracker and todos plus
// the plan_links rows that say which session started or ticked an item. The
// two tabs share it: Plan shows the phases, Todos the todos. A phase or a
// todo can start a session with the item as its first prompt; the session is
// filed in the project (and a chosen track) and linked to the item.

const planTabState = new Map(); // projectId → { data, error, expanded: Set<phase line>, showDone }

function planState(project) {
  let state = planTabState.get(project.id);
  if (!state) {
    state = { data: null, error: null, expanded: new Set(), showDone: false };
    planTabState.set(project.id, state);
  }
  return state;
}

async function loadProjectPlan(project) {
  const state = planState(project);
  let result;
  try { result = await window.api.getProjectPlan(project.id); } catch (err) { result = { error: err.message }; }
  state.data = result?.ok ? result : null;
  state.error = result?.ok ? null : (result?.error || 'Could not read the plan');
  return state;
}

function linksFor(data, kind, text) {
  return (data?.links || []).filter(l => l.file === kind && l.itemText === text);
}

/** Sessions linked to an item that are still known, most recent first. */
function linkedSessions(data, kind, text) {
  const seen = new Set();
  const out = [];
  for (const link of linksFor(data, kind, text).slice().reverse()) {
    if (seen.has(link.sessionId)) continue;
    seen.add(link.sessionId);
    const session = sessionMap.get(link.sessionId);
    if (session) out.push({ session, link });
  }
  return out;
}

function phasePrompt(data, phase) {
  const lines = [`Work on this phase of the plan. The tracker is ${data.trackerPath}` + (data.hasPlan ? ` and the plan itself is ${data.planPath}.` : '.'), '', `Phase: ${phase.title}`];
  const open = phase.items.filter(it => !it.done);
  if (open.length) { lines.push('', 'Open items:'); for (const it of open) lines.push(`- ${it.text}`); }
  lines.push('', 'When an item is finished, tick it in the tracker. Tick the phase heading once the whole phase is done.');
  return lines.join('\n');
}

function todoPrompt(data, item) {
  return `Work on this todo from ${data.todosPath}:\n\n${item.text}\n\nWhen it is done, tick it in todos.md.`;
}

/** One row per CLI that launches with a first prompt, filed under the item. */
function startItemRows(project, track, prompt, planItem) {
  const target = launchTargetFor(project, track);
  const launch = async (runtime) => {
    const options = await resolveDefaultSessionOptions(target);
    options.runtime = runtime;
    options.initialPrompt = prompt;
    options.planItem = planItem;
    launchNewSession(target, options);
  };
  return LAUNCH_CLIS.map(cli => ({ label: harnessLabel(cli), icon: harnessIcon(cli, 14, cliIconClass(cli)), onClick: () => launch(cli) }));
}

function showStartItemMenu(project, kind, itemText, prompt, anchor) {
  const planItem = { file: kind, itemText };
  const items = [{ head: 'Start a session on this' }, ...startItemRows(project, null, prompt, planItem)];
  const tracks = (project.tracks || []).filter(t => t.status !== 'done');
  if (tracks.length) {
    items.push({ sep: true }, { head: 'In a track' });
    for (const t of tracks) items.push({ label: t.name, icon: PICONS.list(13), submenu: startItemRows(project, t, prompt, planItem) });
  }
  showContextMenu(items, { anchor });
}

function linkedBadge(project, data, kind, text) {
  const linked = linkedSessions(data, kind, text);
  if (!linked.length) return null;
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'ws-plan-links';
  badge.title = linked.map(({ session }) => sessionTitle(session)).join('\n');
  badge.textContent = `${linked.length} session${linked.length === 1 ? '' : 's'}`;
  badge.onclick = (e) => {
    e.stopPropagation();
    if (linked.length === 1) { openSession(linked[0].session); return; }
    showContextMenu([{ head: 'Sessions that worked on this' }, ...linked.map(({ session, link }) => ({
      label: sessionTitle(session), icon: cliIcon(session, 13),
      hint: `${link.kind === 'started' ? 'started' : 'ticked'} · ${formatDate(new Date(link.at))}`,
      onClick: () => openSession(session),
    }))], { anchor: e.currentTarget });
  };
  return badge;
}

/**
 * What the Plan tab ('plan') or the Todos tab ('todos') draws from, so a
 * refetch that changed nothing there draws nothing.
 */
function planSignature(state, tab) {
  const data = state.data;
  if (!data) return 'error:' + (state.error || '');
  const file = tab === 'todos' ? 'todos' : 'plan';
  return JSON.stringify([
    file === 'plan'
      ? (data.plan?.phases || []).map(p => [p.line, p.title, p.done, (p.items || []).map(i => [i.line, i.text, i.done])])
      : (data.todos || []).map(t => [t.line, t.text, t.done]),
    (data.links || []).filter(l => l.file === file).map(l => [l.itemText, l.sessionId, l.kind]),
  ]);
}

/** The Plan tab ('plan', the phases) or the Todos tab ('todos'). */
function renderPlanTab(project, body, tab) {
  const state = planState(project);
  // Only the first look at a project has nothing to show. A refresh keeps what
  // is on screen — a running session writes constantly, and blanking the tab
  // each time made the todos flicker away and took any open field with them.
  if (state.data || state.error) renderPlanBody(project, body, state, tab);
  else body.innerHTML = `<div class="ws-plan"><div class="ws-card-text muted">${tab === 'todos' ? 'Loading the todos…' : 'Loading the plan…'}</div></div>`;
  const before = planSignature(state, tab);
  loadProjectPlan(project).then(() => {
    if (selectedProject()?.id !== project.id || projectTab(project) !== tab) return;
    if (!projectViewer.contains(body)) return;
    // Redraw only when what the tab shows actually moved, so a field being
    // typed into survives a refresh that changed nothing. A field that is open
    // holds the redraw off entirely; the next refresh picks it up.
    if (editingInPage()) return;
    if (planSignature(state, tab) !== before || (!state.data && !state.error)) renderPlanBody(project, body, state, tab);
    renderPlanMeta(project);
  });
}

function renderPlanBody(project, body, state, tab) {
  if (tab === 'todos') renderTodosBody(project, body, state);
  else renderPhasesBody(project, body, state);
}

/** The Plan tab: the phases of plan-tracker.md, with plan.md and the tracker a click away. */
function renderPhasesBody(project, body, state) {
  const data = state.data;
  const plan = data?.plan || { phases: [], done: 0, total: 0, next: null };
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;

  body.innerHTML = `
    <div class="ws-plan">
      <div class="ws-card ws-plan-card">
        <div class="ws-card-h">
          <span class="ws-card-title">Plan</span>
          <span class="ws-card-meta">${plan.total ? `${plan.done} of ${plan.total} phases` : ''}</span>
          <span class="ws-flex"></span>
          <button type="button" class="ws-ghost ws-ghost--sm" id="plan-open-plan" title="The plan as written">plan.md</button>
          <button type="button" class="ws-ghost ws-ghost--sm" id="plan-open-tracker" title="The phases Switchboard reads">plan-tracker.md</button>
        </div>
        ${plan.total ? `<div class="ws-progress"><div class="ws-progress-fill" style="width:${pct}%"></div></div>` : ''}
        <div class="ws-phases" id="ws-phases"></div>
      </div>
    </div>`;

  body.querySelector('#plan-open-plan').onclick = () => openProjectFileInEditor(project, 'plan.md');
  body.querySelector('#plan-open-tracker').onclick = () => openProjectFileInEditor(project, 'plan-tracker.md');

  const phasesEl = body.querySelector('#ws-phases');
  if (state.error) {
    phasesEl.innerHTML = `<div class="ws-card-text muted">${escapeHtml(state.error)}</div>`;
  } else if (!plan.total) {
    phasesEl.innerHTML = `<div class="ws-card-text muted">${data?.hasPlan
      ? 'plan.md is written, but plan-tracker.md has no phases yet. Ask a session to keep the tracker up to date, or add phases to it as "## Phase 1: …" headings with "- [ ]" items.'
      : 'No plan yet. Ask a session for one: it writes plan.md and keeps the phases in plan-tracker.md.'}</div>`;
  } else {
    plan.phases.forEach((phase, index) => phasesEl.appendChild(buildPhaseRow(project, state, phase, index)));
  }
}

/** The Todos tab: the lines of todos.md, open first, the done ones on request. */
function renderTodosBody(project, body, state) {
  const data = state.data;
  const todos = data?.todos || [];
  const open = todos.filter(t => !t.done);
  const doneTodos = todos.filter(t => t.done);

  body.innerHTML = `
    <div class="ws-plan">
      <div class="ws-card ws-plan-card">
        <div class="ws-card-h">
          <span class="ws-card-title">Todos</span>
          <span class="ws-card-meta">${open.length ? `${open.length} open` : ''}${doneTodos.length ? ` · ${doneTodos.length} done` : ''}</span>
          <span class="ws-flex"></span>
          ${doneTodos.length ? `<button type="button" class="ws-ghost ws-ghost--sm ws-ghost--muted" id="plan-todo-done">${state.showDone ? 'Hide done' : `Show ${doneTodos.length} done`}</button>` : ''}
          <button type="button" class="ws-ghost ws-ghost--sm" id="plan-open-todos" title="The todos as written">todos.md</button>
          <button type="button" class="ws-ghost ws-ghost--sm" id="plan-todo-add">${PICONS.plus(11)}<span>Add</span></button>
        </div>
        <div class="ws-todos" id="ws-plan-todos"></div>
      </div>
    </div>`;

  body.querySelector('#plan-open-todos').onclick = () => openProjectFileInEditor(project, 'todos.md');

  const todosEl = body.querySelector('#ws-plan-todos');
  if (state.error) {
    todosEl.innerHTML = `<div class="ws-card-text muted">${escapeHtml(state.error)}</div>`;
  } else {
    const shown = state.showDone ? todos : open;
    if (!shown.length) {
      todosEl.innerHTML = `<div class="ws-card-text muted">${todos.length ? 'Everything is done.' : 'Nothing open. Any session can add to todos.md, or add one here.'}</div>`;
    }
    for (const item of shown) todosEl.appendChild(buildTodoRow(project, state, item));
  }

  const toggleDone = body.querySelector('#plan-todo-done');
  if (toggleDone) toggleDone.onclick = () => { state.showDone = !state.showDone; renderTodosBody(project, body, state); };
  body.querySelector('#plan-todo-add').onclick = () => {
    if (todosEl.querySelector('.ws-todo-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ws-input ws-todo-input';
    input.placeholder = 'What needs doing?';
    input.onkeydown = async (e) => {
      if (e.key === 'Escape') { input.remove(); return; }
      if (e.key !== 'Enter') return;
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      if (await appendTodo(project, text)) { await loadProjectPlan(project); renderTodosBody(project, body, state); }
      else input.disabled = false;
    };
    todosEl.prepend(input);
    input.focus();
  };
}

function buildPhaseRow(project, state, phase, index) {
  const data = state.data;
  const plan = data.plan;
  const isNext = plan.next && plan.next.line === phase.line;
  const hasItems = phase.items.length > 0;
  // The next phase opens by default; the user can still fold it.
  if (!state.collapsed) state.collapsed = new Set();
  const expanded = hasItems && ((isNext && !state.collapsed.has(phase.line)) || state.expanded.has(phase.line));

  const row = document.createElement('div');
  row.className = 'ws-phase' + (phase.done ? ' done' : '') + (isNext ? ' next' : '') + (expanded ? ' expanded' : '');

  const head = document.createElement('div');
  head.className = 'ws-phase-head';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'ws-phase-box';
  box.checked = !!phase.done;
  box.title = phase.done ? 'Mark the phase as not done' : 'Mark the whole phase as done';
  box.onclick = (e) => e.stopPropagation();
  box.onchange = async () => {
    box.disabled = true;
    const result = await window.api.setPlanItem(project.id, 'plan', phase.line, box.checked);
    if (result?.error) { alert(result.error); box.disabled = false; box.checked = !box.checked; return; }
    await reloadPlanAndRender(project, state);
  };
  const title = document.createElement('span');
  title.className = 'ws-phase-title';
  title.textContent = phase.title;
  const meta = document.createElement('span');
  meta.className = 'ws-phase-meta';
  meta.textContent = hasItems ? `${phase.ticked}/${phase.items.length}` : (isNext ? 'next' : '');
  head.append(box, title, meta);
  const linked = linkedBadge(project, data, 'plan', phase.title);
  if (linked) head.appendChild(linked);
  head.appendChild(Object.assign(document.createElement('span'), { className: 'ws-flex' }));
  if (!phase.done) {
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'ws-ghost ws-ghost--sm ws-phase-start';
    start.innerHTML = `${PICONS.play(11)}<span>Start</span>`;
    start.title = `Start a session on "${phase.title}"`;
    start.onclick = (e) => { e.stopPropagation(); showStartItemMenu(project, 'plan', phase.title, phasePrompt(data, phase), e.currentTarget); };
    head.appendChild(start);
  }
  if (hasItems) {
    const chevron = document.createElement('span');
    chevron.className = 'ws-phase-chevron';
    chevron.innerHTML = expanded ? PICONS.chevronDown(11) : PICONS.chevronRight(11);
    head.appendChild(chevron);
    head.onclick = () => {
      const open = !row.classList.contains('expanded');
      row.classList.toggle('expanded', open);
      chevron.innerHTML = open ? PICONS.chevronDown(11) : PICONS.chevronRight(11);
      if (open) { state.expanded.add(phase.line); state.collapsed.delete(phase.line); }
      else { state.expanded.delete(phase.line); state.collapsed.add(phase.line); }
    };
  }
  row.appendChild(head);

  if (hasItems) {
    const list = document.createElement('div');
    list.className = 'ws-phase-items';
    for (const item of phase.items) {
      const line = document.createElement('div');
      line.className = 'ws-todo ws-phase-item' + (item.done ? ' done' : '');
      const itemBox = document.createElement('input');
      itemBox.type = 'checkbox';
      itemBox.checked = item.done;
      itemBox.onchange = async () => {
        itemBox.disabled = true;
        const result = await window.api.setPlanItem(project.id, 'plan', item.line, itemBox.checked);
        if (result?.error) { alert(result.error); itemBox.disabled = false; itemBox.checked = !itemBox.checked; return; }
        await reloadPlanAndRender(project, state);
      };
      const text = document.createElement('span');
      text.className = 'ws-todo-text';
      text.title = 'Double-click to edit';
      text.textContent = item.text;
      text.ondblclick = () => editItemInline(project, 'plan', item, text, () => loadProjectPlan(project));
      line.append(itemBox, text);
      const itemLinked = linkedBadge(project, data, 'plan', item.text);
      if (itemLinked) line.appendChild(itemLinked);
      if (!item.done) {
        const startItem = document.createElement('button');
        startItem.type = 'button';
        startItem.className = 'ws-item-start';
        startItem.title = 'Start a session on this item';
        startItem.innerHTML = PICONS.play(10);
        startItem.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const prompt = `Work on this item from phase "${phase.title}" of the plan. The tracker is ${data.trackerPath}.\n\n${item.text}\n\nWhen it is done, tick it in the tracker.`;
          showStartItemMenu(project, 'plan', item.text, prompt, e.currentTarget);
        };
        line.appendChild(startItem);
      }
      list.appendChild(line);
    }
    row.appendChild(list);
  }
  return row;
}

function buildTodoRow(project, state, item) {
  const data = state.data;
  const line = document.createElement('div');
  line.className = 'ws-todo' + (item.done ? ' done' : '');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = item.done;
  box.title = item.done ? 'Mark open' : 'Mark done';
  box.onchange = async () => {
    box.disabled = true;
    const result = await window.api.setPlanItem(project.id, 'todos', item.line, box.checked);
    if (result?.error) { alert(result.error); box.disabled = false; box.checked = !box.checked; return; }
    await loadProjectFiles(project, { force: true });
    await reloadPlanAndRender(project, state);
  };
  const text = document.createElement('span');
  text.className = 'ws-todo-text';
  text.title = 'Double-click to edit';
  text.textContent = item.text;
  text.ondblclick = () => editItemInline(project, 'todos', item, text, () => loadProjectFiles(project, { force: true }));
  line.append(box, text);
  const linked = linkedBadge(project, data, 'todos', item.text);
  if (linked) line.appendChild(linked);
  if (!item.done) {
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'ws-item-start';
    start.title = 'Start a session on this todo';
    start.innerHTML = PICONS.play(10);
    start.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showStartItemMenu(project, 'todos', item.text, todoPrompt(data, item), e.currentTarget);
    };
    line.appendChild(start);
  }
  return line;
}

async function reloadPlanAndRender(project, state) {
  await loadProjectPlan(project);
  await loadProjectFiles(project, { force: true });
  const body = projectViewer?.querySelector('#ws-body');
  const tab = projectTab(project);
  if (!body || selectedProject()?.id !== project.id || !PLAN_TABS.has(tab)) return;
  renderPlanBody(project, body, state, tab);
  renderPlanMeta(project);
}

// A session ticked something, or a file changed on disk: refresh what shows it.
window.api.onProjectPlanChanged?.((projectId) => {
  const project = findTreeProject(projectId);
  if (!project) return;
  // The cached plan is kept: renderPlanTab refetches and only redraws when
  // what its tab shows actually moved, so the tab never blanks.
  loadProjectFiles(project, { force: true }).then(() => {
    // The row and the drawer count plan phases and todos for any project, selected or not.
    refreshProjectCounts(projectId);
    if (selectedProject()?.id !== projectId || (activeTab !== 'projects' && activeTab !== 'sessions')) return;
    if (projectsUi.working) { renderPlanMeta(project); return; }
    if (projectViewer && projectViewer.style.display !== 'none') {
      if (editingInPage()) return;
      const tab = projectTab(project);
      if (PLAN_TABS.has(tab)) renderPlanTab(project, projectViewer.querySelector('#ws-body'), tab);
      else renderOverview();
    }
  });
});

// --- Files tab: project-files-view.js ---

/** True when plan.md holds more than its heading and the template comment. */
function hasPlanText(content) {
  if (!content) return false;
  const stripped = content.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
    .filter(line => line.trim() && !/^#\s/.test(line.trim()));
  return stripped.length > 0;
}

function bindAddedFilesCard(project, side) {
  const dropZone = side.querySelector('#ws-added-files-drop');
  if (!dropZone) return;
  let dragDepth = 0;
  const setOver = (over) => dropZone.classList.toggle('is-over', over);

  dropZone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth++;
    setOver(true);
  });
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  });
  dropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setOver(false);
  });
  dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    setOver(false);
    const sourcePaths = Array.from(event.dataTransfer.files || []).map(file => {
      try { return window.api.getPathForFile(file); } catch { return ''; }
    }).filter(Boolean);
    if (!sourcePaths.length) return;

    dropZone.classList.add('is-busy');
    const label = dropZone.querySelector('.ws-added-drop-label');
    if (label) label.textContent = `Adding ${sourcePaths.length} file${sourcePaths.length === 1 ? '' : 's'}…`;
    let result;
    try { result = await window.api.addProjectFiles(project.id, sourcePaths); }
    catch (err) { result = { error: err.message }; }
    if (!result?.ok) {
      dropZone.classList.remove('is-busy');
      if (label) label.textContent = 'Drop files here';
      alert(result?.error || 'Could not add the files.');
      return;
    }

    project.addedFiles = result.files || [];
    project.addedFilesPath = result.dirPath || project.addedFilesPath;
    filesState(project, project.root).cache.clear();
    renderSideCards(project, side);
    if (result.errors?.length) alert(`Some items could not be added:\n\n${result.errors.join('\n')}`);
  });

  const open = side.querySelector('#ws-added-files-open');
  if (open) open.onclick = async () => {
    const result = await window.api.openPath(project.addedFilesPath);
    if (result?.error) alert(result.error);
  };
}

// Recent Files on the Overview. The side cards redraw several times while a
// page loads, so one listing is reused for a few seconds.
const recentFilesByProject = new Map(); // projectId → { at, files, error, pending }

function loadRecentFiles(project) {
  const entry = recentFilesByProject.get(project.id);
  if (entry?.pending) return entry.pending;
  if (entry && Date.now() - entry.at < FILES_LIST_TTL_MS) return Promise.resolve(entry);
  const pending = Promise.resolve()
    .then(() => window.api.listRecentProjectFiles(project.id))
    .then(result => ({ at: Date.now(), files: result?.ok ? result.files : [], error: result?.ok ? null : (result?.error || 'Could not list the files.') }))
    .catch(err => ({ at: Date.now(), files: [], error: err.message }))
    .then(next => { recentFilesByProject.set(project.id, next); return next; });
  recentFilesByProject.set(project.id, { at: 0, files: entry?.files ?? null, error: null, pending });
  return pending;
}

function recentFilesHtml(project) {
  const entry = recentFilesByProject.get(project.id);
  if (!entry || entry.files === null) return '<div class="ws-card-text muted">Looking for files…</div>';
  if (entry.error) return `<div class="ws-card-text muted">${escapeHtml(entry.error)}</div>`;
  if (!entry.files.length) return '<div class="ws-card-text muted">Nothing yet besides the brief. Files you or a session add to the project folder show up here.</div>';
  return entry.files.map(file => {
    const dir = file.relativePath.slice(0, file.relativePath.length - file.name.length).replace(/[\\/]$/, '');
    return `<button type="button" class="ws-frow ws-recent-file" data-rel="${escapeHtml(file.relativePath)}" title="${escapeHtml(file.relativePath)}">` +
      `<span class="ws-frow-icon">${PICONS.file(13)}</span>` +
      `<span class="ws-recent-file-name">${escapeHtml(file.name)}</span>` +
      (dir ? `<span class="ws-recent-file-dir">${escapeHtml(dir)}</span>` : '') +
      `<span class="ws-flex"></span><span class="ws-card-meta">${escapeHtml(formatDate(new Date(file.added)))}</span>` +
      `</button>`;
  }).join('');
}

function bindRecentFilesCard(project, side) {
  const list = side.querySelector('#ws-recent-files');
  if (!list) return;
  side.querySelector('#ws-recent-files-all').onclick = () => { setProjectTab(project, 'files'); renderOverview(); };
  const bindRows = () => list.querySelectorAll('.ws-recent-file').forEach(row => {
    row.onclick = () => openProjectFileInEditor(project, row.dataset.rel);
  });
  bindRows();
  loadRecentFiles(project).then(() => {
    if (!list.isConnected || selectedProject()?.id !== project.id) return;
    const html = recentFilesHtml(project);
    if (list._html === html) return;
    list._html = html;
    list.innerHTML = html;
    bindRows();
  });
}

function renderSideCards(project, side) {
  const plan = parsePlan(fileContent(project, 'plan-tracker.md'));
  const planWritten = hasPlanText(fileContent(project, 'plan.md'));
  const todos = parseTodos(fileContent(project, 'todos.md'));
  const open = todos.filter(t => !t.done);
  const doneTodos = todos.length - open.length;
  const pct = plan.phases.length ? Math.round((plan.done / plan.phases.length) * 100) : 0;
  const addedFiles = project.addedFiles || [];

  side.innerHTML = `
    <div class="ws-card">
      <div class="ws-card-h"><span class="ws-card-title">Plan</span><span class="ws-card-meta">${plan.phases.length ? `${plan.done} of ${plan.phases.length} phases` : ''}</span><span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-plan-tracker" title="plan-tracker.md: the phases Switchboard reads">Tracker</button><button type="button" class="ws-ghost ws-ghost--sm" id="ws-plan-open" title="plan.md: the plan as written">Open</button></div>
      ${plan.phases.length ? `
        <div class="ws-progress"><div class="ws-progress-fill" style="width:${pct}%"></div></div>
        <div class="ws-card-row">${plan.next ? `${stateDot('', 'proj-dot--next')}<span class="ws-card-strong">Next: ${escapeHtml(plan.next.title)}</span>` : `${stateDot('', 'proj-dot--done')}<span class="ws-card-strong">Every phase is done</span>`}</div>`
        : `<div class="ws-card-text muted">${planWritten ? 'A plan is written, but plan-tracker.md has no phases yet. Ask a session to keep the tracker up to date.' : 'No plan yet. Ask a session for one: it writes plan.md and keeps the phases in plan-tracker.md.'}</div>`}
    </div>
    <div class="ws-card">
      <div class="ws-card-h"><span class="ws-card-title">Todos</span><span class="ws-card-meta">${open.length ? `${open.length} open` : ''}${doneTodos ? ` · ${doneTodos} done` : ''}</span><span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-todo-add">${PICONS.plus(11)}<span>Add</span></button></div>
      <div id="ws-todos">${open.length ? open.slice(0, 8).map(t => `<div class="ws-todo" data-line="${t.line}"><input type="checkbox" data-line="${t.line}" title="Mark done"><span class="ws-todo-text" title="Double-click to edit">${escapeHtml(t.text)}</span><button type="button" class="ws-item-start" data-line="${t.line}" title="Start a session on this todo">${PICONS.play(10)}</button></div>`).join('') : '<div class="ws-card-text muted">Nothing open. Any session can add to todos.md.</div>'}${open.length > 8 ? `<button type="button" class="ws-ghost ws-ghost--muted" id="ws-todo-more">+ ${open.length - 8} more</button>` : ''}</div>
      <div class="ws-card-hint">Any session can add here. Try "add a todo: …" in a session of this project.</div>
    </div>
    <div class="ws-card ws-recent-files-card">
      <div class="ws-card-h"><span class="ws-card-title">Recent Files</span><span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-recent-files-all" title="Every file in the project folder">All files</button></div>
      <div class="ws-recent-list" id="ws-recent-files">${recentFilesHtml(project)}</div>
    </div>
    <div class="ws-card">
      <div class="ws-card-h"><span class="ws-card-title">Attached Folders</span><span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-folders-add">${PICONS.plus(11)}<span>Attach</span></button></div>
      ${(project.folders || []).length ? (project.folders || []).map(f => `
        <div class="ws-frow" data-path="${escapeHtml(f.path)}" data-detail="mode" title="${escapeHtml(f.path)}">
          <span class="ws-frow-icon ${f.mode === 'worktree' ? 'is-worktree' : ''}">${f.mode === 'worktree' ? PICONS.branch(13) : PICONS.folder(13)}</span>
          <span class="ws-frow-name">${escapeHtml(pathBasename(f.path))}</span>
          <span class="ws-card-meta mono ws-frow-detail">${escapeHtml(folderModeText(project, f))}</span>
          <button type="button" class="ws-ghost ws-ghost--sm ws-frow-x" title="Detach from the project" aria-label="${escapeHtml(`Detach ${pathBasename(f.path)}`)}">${PICONS.x(12)}</button>
        </div>`).join('') : '<div class="ws-card-text muted">No folders attached. Sessions run in the project folder.</div>'}
    </div>
    <div class="ws-card kn-side-card" id="ws-kn-card" hidden></div>
    <div class="ws-card ws-added-files-card">
      <div class="ws-card-h"><span class="ws-card-title">Added Files</span><span class="ws-card-meta">${addedFiles.length ? `${addedFiles.length} file${addedFiles.length === 1 ? '' : 's'}` : ''}</span><span class="ws-flex"></span>${addedFiles.length ? '<button type="button" class="ws-ghost ws-ghost--sm" id="ws-added-files-open">Open</button>' : ''}</div>
      <div class="ws-added-drop" id="ws-added-files-drop">
        <span class="ws-added-drop-icon">${PICONS.plus(14)}</span>
        <span><span class="ws-added-drop-label">Drop files here</span><span class="ws-added-drop-hint">Copied into added-files/ in the project folder</span></span>
      </div>
      ${addedFiles.length ? `<div class="ws-added-list">${addedFiles.map(file => `
        <div class="ws-added-file" title="${escapeHtml(file.relativePath)}">
          <span class="ws-frow-icon">${PICONS.file(13)}</span>
          <span class="ws-added-file-name">${escapeHtml(file.name)}</span>
        </div>`).join('')}</div>` : ''}
    </div>`;

  side.querySelector('#ws-plan-open').onclick = () => openProjectFileInEditor(project, 'plan.md');
  side.querySelector('#ws-plan-tracker').onclick = () => openProjectFileInEditor(project, 'plan-tracker.md');
  side.querySelector('#ws-folders-add').onclick = () => attachFolderAsk(project);
  side.querySelectorAll('.ws-frow-x').forEach(btn => {
    btn.onclick = () => {
      const folder = (project.folders || []).find(f => f.path === btn.closest('.ws-frow').dataset.path);
      if (folder) detachFolderFlow(project, folder);
    };
  });
  bindAddedFilesCard(project, side);
  bindRecentFilesCard(project, side);
  // The Code graph card, for projects with the graph on (project-knowledge-links.js).
  if (typeof knRenderSideCard === 'function') knRenderSideCard(project, side.querySelector('#ws-kn-card')).catch(() => {});
  side.querySelectorAll('.ws-todo input').forEach(box => {
    box.onchange = async () => {
      box.disabled = true;
      if (await toggleFileLine(project, 'todos.md', Number(box.dataset.line), box.checked)) renderSideCards(project, side);
      else box.disabled = false;
    };
  });
  // Double-click the text to edit it in place; a single click does nothing.
  side.querySelectorAll('.ws-todo .ws-todo-text').forEach(span => {
    span.ondblclick = () => {
      const item = open.find(t => t.line === Number(span.parentElement.dataset.line));
      if (item) editItemInline(project, 'todos', item, span, () => loadProjectFiles(project, { force: true }));
    };
  });
  // Same Start as the Plan tab: the todo becomes the session's first prompt.
  side.querySelectorAll('.ws-todo .ws-item-start').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const item = open.find(t => t.line === Number(btn.dataset.line));
      if (!item) return;
      const todosPath = project.root + '/todos.md';
      showStartItemMenu(project, 'todos', item.text, todoPrompt({ todosPath }, item), btn);
    };
  });
  const more = side.querySelector('#ws-todo-more');
  if (more) more.onclick = () => openProjectFileInEditor(project, 'todos.md');
  side.querySelector('#ws-todo-add').onclick = () => {
    const list = side.querySelector('#ws-todos');
    if (list.querySelector('.ws-todo-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ws-input ws-todo-input';
    input.placeholder = 'What needs doing?';
    input.onkeydown = async (e) => {
      if (e.key === 'Escape') { input.remove(); return; }
      if (e.key !== 'Enter') return;
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      if (await appendTodo(project, text)) renderSideCards(project, side);
    };
    list.prepend(input);
    input.focus();
  };
}

// --- Settings tab ---

/** A picked image, made into the project's picture (project-icon.js). */
async function chooseProjectIcon(project) {
  const file = await pickProjectIconFile();
  if (!file) return;
  let png;
  try { png = await makeProjectIcon(file); } catch (err) { alert(err.message); return; }
  await saveProjectIcon(project, png);
}

/** Keep the picture, or with null go back to the initials, and draw the page again. */
async function saveProjectIcon(project, png) {
  const result = await window.api.setProjectIcon(project.id, png);
  if (result?.error) { alert(result.error); return; }
  for (const copy of treeCopiesOf(project.id)) {
    copy.icon = result.project.icon;
    copy.iconUrl = result.project.iconUrl;
  }
  renderOverview();
  loadProjects();
}

function renderSettings(project, body) {
  const shared = project.sharedBranch !== false;
  body.innerHTML = `
    <div class="ws-settings ws-rows">
      <div class="ws-sec">Project</div>
      <div class="ws-card">
        <div class="ws-row">
          <div class="ws-row-k"><b>Name</b></div>
          <div class="ws-row-v"><input type="text" class="ws-input" id="ws-set-name" value="${escapeHtml(project.name)}" spellcheck="false"><span class="ws-saved" id="ws-set-name-saved">${PICONS.check(11)}<span>Saved</span></span></div>
        </div>
        <div class="ws-row">
          <div class="ws-row-k"><b>Icon</b><span>A PNG, JPG or SVG in place of the initials, cropped to a square.</span></div>
          <div class="ws-row-v">
            ${markHtml(project, 38, 'proj-mark--lg')}
            <button type="button" class="ws-ghost ws-ghost--sm" id="ws-set-icon">${PICONS.plus(11)}<span>${project.iconUrl ? 'Change image…' : 'Choose image…'}</span></button>
            ${project.iconUrl ? `<button type="button" class="ws-ghost ws-ghost--sm" id="ws-set-icon-remove" title="Show the initials again">${PICONS.x(11)}<span>Remove</span></button>` : ''}
          </div>
        </div>
        <div class="ws-row">
          <div class="ws-row-k"><b>Project folder</b><span>The brief, plan and todos live here.</span></div>
          <div class="ws-row-v"><span class="mono ws-path ws-path--clip" title="${escapeHtml(project.root)}">${escapeHtml(shortPathLabel(project.root))}</span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-set-open" title="Open in ${escapeHtml(fileManagerName())}">${ICONS.folderOpen(12)}<span>Open</span></button></div>
        </div>
        <div class="ws-row">
          <div class="ws-row-k"><b>Sessions start in</b><span>A track can pick its own.</span></div>
          <div class="ws-row-v" id="ws-set-cwd"></div>
        </div>
      </div>

      <div class="ws-sec"><span>Folders</span><button type="button" class="ws-ghost ws-ghost--sm ws-ghost--accent" id="ws-set-attach">${PICONS.plus(11)}<span>Attach folder…</span></button></div>
      <div class="ws-card">
        <div id="ws-set-folders"></div>
        <div class="ws-row" id="ws-set-branch-row">
          <div class="ws-row-k"><b>Worktree branch</b><span id="ws-set-branch-help"></span></div>
          <div class="ws-row-v">
            <input type="text" class="ws-input mono" id="ws-set-branch" value="${escapeHtml(project.branchName || '')}" placeholder="${escapeHtml(project.slug)}" spellcheck="false" title="Enter or click away to save">
            <span class="ws-saved" id="ws-set-branch-saved">${PICONS.check(11)}<span>Saved</span></span>
            <label class="ws-check ws-check--switch"><input type="checkbox" class="ws-switch-input" id="ws-set-shared" ${shared ? 'checked' : ''}><span class="ws-switch"></span>Same in every repo</label>
          </div>
        </div>
      </div>

      <div class="ws-sec"><span>Tracks</span><button type="button" class="ws-ghost ws-ghost--sm ws-ghost--accent" id="ws-set-new-track">${PICONS.plus(11)}<span>New track</span></button></div>
      <div class="ws-card" id="ws-set-tracks"></div>

      <div class="ws-sec"><span>Language servers</span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-set-lsp-detect" title="Look at the project's folders again and turn on the servers of new languages">Detect again</button></div>
      <div class="ws-card" id="ws-set-lsp"></div>

      <div class="ws-foot">
        ${isProjectSnoozed(project) ? `<button type="button" class="ws-btn" id="ws-set-wake" title="Wakes ${escapeHtml(snoozeWakeDescription(project.snoozedUntil))}">Wake now</button>` : ''}
        <button type="button" class="ws-btn" id="ws-set-status">${project.status === 'done' ? 'Reopen project' : 'Mark as done'}</button>
        <button type="button" class="ws-link-danger" id="ws-set-remove">Remove project…</button>
        <span class="ws-foot-note">Changes save as you make them.</span>
      </div>
    </div>`;

  const q = (sel) => body.querySelector(sel);

  // Name: saved on Enter or when the field loses focus, with a short "Saved".
  const nameInput = q('#ws-set-name');
  const saveName = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.value = project.name; return; }
    if (name === project.name) return;
    const result = await window.api.updateProject(project.id, { name });
    if (result?.error) { alert(result.error); nameInput.value = project.name; return; }
    project.name = name;
    flashSaved(q('#ws-set-name-saved'));
    loadProjects();
  };
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } };
  nameInput.onblur = saveName;
  q('#ws-set-open').onclick = () => window.api.openPath(project.root);
  q('#ws-set-icon').onclick = () => chooseProjectIcon(project);
  const removeIcon = q('#ws-set-icon-remove');
  if (removeIcon) removeIcon.onclick = () => saveProjectIcon(project, null);

  q('#ws-set-cwd').appendChild(buildCwdField(project, project.defaultCwd, `Project folder (${pathBasename(project.root)})`, [], async (defaultCwd) => {
    const result = await window.api.updateProject(project.id, { defaultCwd });
    if (result?.error) { alert(result.error); return; }
    loadProjects();
  }));

  // The editor's language servers for this project (project-lsp-settings.js).
  if (typeof renderProjectLanguageServers === 'function') renderProjectLanguageServers(project, q('#ws-set-lsp'), q('#ws-set-lsp-detect'));

  const foldersEl = q('#ws-set-folders');
  if (!(project.folders || []).length) foldersEl.innerHTML = '<div class="ws-item ws-item--empty">None attached. Sessions run in the project folder.</div>';
  for (const folder of project.folders || []) {
    const row = document.createElement('div');
    row.className = 'ws-item ws-frow';
    row.dataset.path = folder.path;
    row.dataset.detail = 'settings';
    const isWorktree = folder.mode === 'worktree';
    row.innerHTML = `<span class="ws-frow-icon ${isWorktree ? 'is-worktree' : ''}">${isWorktree ? PICONS.branch(13) : PICONS.folder(13)}</span>` +
      `<span class="ws-frow-name">${escapeHtml(pathBasename(folder.path))}</span>` +
      `<span class="ws-card-meta mono ws-frow-detail">${escapeHtml(folderSettingsText(project, folder))}</span>` +
      `<button type="button" class="ws-ghost ws-ghost--sm ws-item-open" title="Open in ${escapeHtml(fileManagerName())}">${ICONS.folderOpen(11)}<span>Open</span></button>` +
      `<button type="button" class="ws-ghost ws-ghost--sm ws-item-x" title="Detach">${PICONS.x(12)}</button>`;
    row.querySelector('.ws-item-open').onclick = () => window.api.openPath(folder.path);
    row.querySelector('.ws-item-x').onclick = () => detachFolderFlow(project, folder);
    foldersEl.appendChild(row);
  }
  q('#ws-set-attach').onclick = () => attachFolderAsk(project);

  // Worktree branch: the name saves on Enter or blur, the switch saves at once.
  const sharedBox = q('#ws-set-shared');
  const branchInput = q('#ws-set-branch');
  const branchHelp = q('#ws-set-branch-help');
  const renderBranchState = () => {
    branchInput.style.display = sharedBox.checked ? '' : 'none';
    branchHelp.textContent = sharedBox.checked
      ? 'Every new worktree checks out this branch.'
      : 'Each worktree names its own branch when you attach it.';
  };
  const saveBranch = async () => {
    const branchName = branchInput.value.trim();
    if (sharedBox.checked === shared && branchName === (project.branchName || '')) return;
    const result = await window.api.updateProject(project.id, { sharedBranch: sharedBox.checked, branchName });
    if (result?.error) { alert(result.error); return; }
    project.sharedBranch = sharedBox.checked;
    project.branchName = branchName;
    flashSaved(q('#ws-set-branch-saved'));
    loadProjects();
  };
  branchInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); branchInput.blur(); } };
  branchInput.onblur = saveBranch;
  sharedBox.onchange = () => { renderBranchState(); saveBranch(); };
  renderBranchState();

  const tracksEl = q('#ws-set-tracks');
  if (!(project.tracks || []).length) tracksEl.innerHTML = '<div class="ws-item ws-item--empty">No tracks. A track is one line of work with its own sessions, start folder and CLI.</div>';
  for (const track of project.tracks || []) tracksEl.appendChild(buildTrackSettingsRow(project, track));
  q('#ws-set-new-track').onclick = () => promptNewTrack(project);

  q('#ws-set-status').onclick = () => toggleProjectDone(project);
  const wakeBtn = q('#ws-set-wake');
  if (wakeBtn) wakeBtn.onclick = () => wakeProject(project);
  q('#ws-set-remove').onclick = () => removeProjectFlow(project);

  const flash = projectsUi.savedFlash;
  if (flash && flash.until > Date.now()) {
    const el = flash.id ? q('#' + CSS.escape(flash.id)) : null;
    if (el) showSavedFlash(el, flash.until - Date.now());
  }
}

/** Show a "Saved" mark for a moment. Remembered by id, since a save re-renders the tab. */
function flashSaved(el) {
  if (!el) return;
  projectsUi.savedFlash = { id: el.id, until: Date.now() + 1600 };
  showSavedFlash(el, 1600);
}

function showSavedFlash(el, ms) {
  el.classList.add('on');
  clearTimeout(el._savedTimer);
  el._savedTimer = setTimeout(() => el.classList.remove('on'), ms);
}

/** A path with the home folder as "~". */
function shortPathLabel(p) {
  return typeof shortProjectPath === 'function' ? shortProjectPath(p) : p;
}

function buildTrackSettingsRow(project, track) {
  const row = document.createElement('div');
  row.className = 'ws-item ws-trow' + (track.status === 'done' ? ' done' : '');
  const colors = trackColors(project, track);
  row.innerHTML = `
    <span class="ws-trow-dot" style="background:${colors.fg}"></span>
    <input type="text" class="ws-input ws-trow-name" value="${escapeHtml(track.name)}" spellcheck="false" title="Rename (Enter or click away to save)">
    <span class="ws-trow-cwd"></span>
    <select class="ws-select ws-trow-cli" title="CLI for new sessions"></select>
    <button type="button" class="ws-ghost ws-ghost--sm ws-trow-status">${track.status === 'done' ? 'Reopen' : 'Done'}</button>
    <button type="button" class="ws-ghost ws-ghost--sm ws-trow-delete" title="Delete track">${PICONS.trash(13)}</button>`;
  const patch = async (fields) => {
    const result = await window.api.updateTrack(track.id, fields);
    if (result?.error) { alert(result.error); return false; }
    loadProjects();
    return true;
  };
  const nameInput = row.querySelector('.ws-trow-name');
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } };
  nameInput.onblur = () => { const name = nameInput.value.trim(); if (name && name !== track.name) patch({ name }); else nameInput.value = track.name; };

  const inherited = project.defaultCwd || project.root;
  const cwdField = buildCwdField(project, track.cwd, `Project default (${pathBasename(inherited)})`,
    project.defaultCwd ? [{ value: project.root, label: `Project folder (${pathBasename(project.root)})` }] : [],
    (cwd) => patch({ cwd }));
  cwdField.classList.add('ws-trow-field');
  row.querySelector('.ws-trow-cwd').replaceWith(cwdField);

  const cli = row.querySelector('.ws-trow-cli');
  const renderCli = (harnesses) => {
    cli.replaceChildren();
    const options = [{ id: '', label: 'Ask each time' }, ...harnesses.map(h => ({ id: h.id, label: h.label }))];
    if (track.cli && !options.some(o => o.id === track.cli)) options.push({ id: track.cli, label: track.cli });
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.id; o.textContent = opt.label; o.selected = (track.cli || '') === opt.id;
      cli.appendChild(o);
    }
  };
  renderCli([{ id: 'claude', label: 'Claude' }]);
  window.api.getHarnesses().then(list => { if (row.isConnected) renderCli((list || []).filter(h => h.enabled)); }).catch(() => {});
  cli.onchange = () => patch({ cli: cli.value || null });

  row.querySelector('.ws-trow-status').onclick = () => toggleTrackDone(project, track, patch);
  row.querySelector('.ws-trow-delete').onclick = () => deleteTrackFlow(project, track);
  return row;
}

// --- Session lists: the drawers in the sidebar ---

function trackCwdLabel(project, track) {
  if (!track?.cwd) return '';
  if (!isPathInside(track.cwd, project.root)) return pathBasename(track.cwd);
  return track.cwd === project.root ? 'project folder' : track.cwd.slice(project.root.length + 1);
}

const PANE_GROUP_LIMIT = 8;
const GROUP_MODES = [['time', 'Time'], ['track', 'Track'], ['state', 'State']];

/** The grouping every drawer uses. The argument is kept for callers that think per project. */
function paneGroupMode(_project) {
  const mode = projectsUi.groupMode;
  return GROUP_MODES.some(([m]) => m === mode) ? mode : 'time';
}

/** Change the grouping of every drawer, from the combo beside the search field. */
function setSessionGroupMode(mode) {
  if (!GROUP_MODES.some(([m]) => m === mode)) return;
  projectsUi.groupMode = mode;
  saveProjectsUi();
  const select = document.getElementById('projects-group-select');
  if (select && select.value !== mode) select.value = mode;
  refreshProjectDrawers();
}

{
  // The grouping combo beside the search field (index.html), shown on the Projects tab.
  const select = document.getElementById('projects-group-select');
  if (select) {
    select.value = paneGroupMode(null);
    select.onchange = () => setSessionGroupMode(select.value);
  }
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Time buckets: what is live now, then today, yesterday, this week, this month, older. */
function timeBucket(session, now) {
  const t = sessionEventTime(session);
  const today = startOfDay(now);
  if (t >= today) return 'today';
  if (t >= today - 86400000) return 'yesterday';
  if (t >= today - 6 * 86400000) return 'week';
  if (t >= today - 29 * 86400000) return 'month';
  return 'older';
}

/**
 * The same rows, grouped three ways. Each group: { key, title, color, sessions,
 * track (Track view), plus (Track view) }. Whatever the grouping, the pinned
 * sessions come first, in a Pinned group of their own in the order they were
 * dragged into (pinned-order.js), and the groups under it leave them out.
 */
function groupSessions(project, mode) {
  // One rule everywhere: the session with the latest event comes first.
  const newestFirst = (a, b) => sessionEventTime(b) - sessionEventTime(a);
  const byEvent = (list) => list.filter(s => !s.archived && !s.starred).sort(newestFirst);
  const all = byEvent(projectSessionsAll(project));
  const byRunningFirst = byEvent;
  const pinned = projectSessionsAll(project).filter(s => !s.archived && s.starred)
    .sort(PinnedOrder.compareByRank(s => s.pinRank, newestFirst));
  const pinnedGroup = pinned.length ? [{ key: 'pinned', title: 'Pinned', sessions: pinned, unlimited: true, ordered: true }] : [];

  if (mode === 'track') {
    const groups = (project.tracks || []).map(track => ({
      key: track.id, title: track.name, color: trackColors(project, track).fg, track,
      sessions: byRunningFirst(track.sessions || []), plus: true, done: track.status === 'done',
    }));
    if (project.sessions.length || !groups.length) {
      groups.push({ key: 'general', title: 'General', color: trackColors(project, null).fg, track: null, sessions: byRunningFirst(project.sessions), plus: true });
    }
    return [...pinnedGroup, ...groups];
  }

  if (mode === 'state') {
    const attention = all.filter(s => sessionState(s) === 'attention');
    const running = all.filter(s => sessionState(s) === 'running');
    const idle = all.filter(s => !sessionState(s));
    return [
      ...pinnedGroup,
      { key: 'attention', title: 'Needs input', color: '#f0b060', sessions: attention },
      { key: 'running', title: 'Running', color: '#59d46d', sessions: running },
      { key: 'idle', title: 'Idle', sessions: idle },
    ].filter(g => g.sessions.length);
  }

  const now = Date.now();
  const live = all.filter(s => sessionState(s));
  const rest = all.filter(s => !sessionState(s));
  const buckets = { today: [], yesterday: [], week: [], month: [], older: [] };
  for (const s of rest) buckets[timeBucket(s, now)].push(s);
  return [
    ...pinnedGroup,
    { key: 'now', title: 'Now', sessions: live, unlimited: true },
    { key: 'today', title: 'Today', sessions: buckets.today },
    { key: 'yesterday', title: 'Yesterday', sessions: buckets.yesterday },
    { key: 'week', title: 'Earlier this week', sessions: buckets.week },
    { key: 'month', title: 'Earlier this month', sessions: buckets.month },
    { key: 'older', title: 'Older', sessions: buckets.older },
  ].filter(g => g.sessions.length);
}

/**
 * A project's sessions as one list, grouped by time, track or state. The
 * sidebar search lists its matches under the project row instead, so a
 * drawer keeps the whole list during a search too.
 */
function buildSessionPaneList(project) {
  const matches = [];
  const searching = false;
  const mode = paneGroupMode(project);
  const expanded = projectsUi.expandedLists;
  const scroll = document.createElement('div');
  scroll.className = 'pane-scroll';
  let groups = groupSessions(project, mode);
  if (searching) {
    groups = [
      { key: 'matches', title: 'Active', sessions: matches.filter(s => !s.archived), unlimited: true },
      { key: 'archived-matches', title: 'Archived', sessions: matches.filter(s => s.archived), unlimited: true },
    ].filter(g => g.sessions.length);
  }
  if (!groups.length) {
    const none = document.createElement('div');
    none.className = 'pane-empty';
    none.innerHTML = '<span>No sessions yet.</span>';
    scroll.appendChild(none);
  }
  for (const group of groups) {
    const head = document.createElement('div');
    head.className = 'pane-sec' + (group.done ? ' done' : '');
    if (group.color) head.style.color = group.color;
    head.innerHTML = `<span class="pane-sec-title">${escapeHtml(group.title)}</span><span class="pane-sec-count">${group.sessions.length}</span>` +
      (group.plus ? `<span class="ws-flex"></span><button type="button" class="pane-icon-btn pane-sec-plus" title="${group.track ? `New session in ${escapeHtml(group.track.name)}` : 'New session in the project'}">${PICONS.plus(11)}</button>` : '');
    if (group.plus) {
      head.querySelector('.pane-sec-plus').onclick = (e) => { e.stopPropagation(); launchFromTrack(project, group.track, e.currentTarget); };
      if (group.track) head.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(trackMenuItems(project, group.track), { x: e.clientX, y: e.clientY }); };
    }
    scroll.appendChild(head);

    const id = `${project.id}:${mode}:${group.key}`;
    const defaultLimit = mode === 'track' ? visibleSessionCount : PANE_GROUP_LIMIT;
    const limit = group.unlimited || expanded[id] ? Infinity : defaultLimit;
    for (const s of group.sessions.slice(0, limit)) {
      const row = buildSessionRow(project, s, {
        showTrack: searching || group.ordered || mode !== 'track',
        className: s.archived ? 'pane-session pane-session--archived' : 'pane-session',
      });
      // The Pinned group is ordered by dragging its rows, among themselves.
      if (group.ordered) {
        markOrderRow(row, `pinned:${project.id}`, s.sessionId);
        bindOrderDrag(row, setPinnedOrder);
      }
      scroll.appendChild(row);
    }
    if (!group.sessions.length) {
      const none = document.createElement('div');
      none.className = 'pane-empty';
      none.textContent = 'No sessions yet.';
      scroll.appendChild(none);
    }
    if (group.sessions.length > limit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'pane-more';
      more.textContent = `+ ${group.sessions.length - limit} ${mode === 'time' ? 'older' : 'more'}`;
      more.onclick = () => { expanded[id] = true; refreshProjectDrawer(project.id); };
      scroll.appendChild(more);
    }
  }
  const archived = archivedSessionsOf(project);
  if (!searching && archived.length) scroll.appendChild(buildArchivedSection(project, archived, `pane:${project.id}`, { showTrack: mode !== 'track', rowClass: 'pane-session pane-session--archived' }));
  return scroll;
}

// --- Menus ---

function closeContextMenu() {
  if (!openCtxMenu) return;
  openCtxMenu.remove();
  openCtxMenu = null;
  document.removeEventListener('pointerdown', onCtxPointerDown, true);
  document.removeEventListener('keydown', onCtxKey, true);
}

function onCtxPointerDown(e) {
  if (!openCtxMenu) return;
  // Submenus hang off document.body, not the root menu, so they count as inside too.
  const inside = openCtxMenu.contains(e.target) || openCtxMenu._subs.some(s => s.contains(e.target));
  if (!inside) closeContextMenu();
}

function onCtxKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); }
}

function placeMenu(menu, { x, y, anchor }) {
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left = x;
  let top = y;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    left = rect.left;
    top = rect.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4);
  }
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function buildMenu(items, depth = 0) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    if (!item) continue;
    if (item.sep) { const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep); continue; }
    if (item.head) { const head = document.createElement('div'); head.className = 'ctx-head'; head.textContent = item.head; menu.appendChild(head); continue; }
    const row = document.createElement('div');
    row.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '') + (item.muted ? ' muted' : '');
    row.innerHTML = `<span class="ctx-icon">${item.icon || ''}</span><span class="ctx-label">${escapeHtml(item.label)}</span>` +
      (item.hint ? `<span class="ctx-hint">${escapeHtml(item.hint)}</span>` : '') +
      (item.submenu ? `<span class="ctx-arrow">${PICONS.chevronRight(10)}</span>` : '');
    // A second action at the right of the row, shown while it is pointed at
    // (the Task Manager's "open in a window of its own"): { icon, title, onClick },
    // and always in sight, dimmed, with `always`.
    if (item.side && !item.disabled) {
      const side = document.createElement('button');
      side.type = 'button';
      side.className = 'ctx-side' + (item.side.always ? ' ctx-side--always' : '');
      side.title = item.side.title || '';
      side.setAttribute('aria-label', item.side.title || '');
      side.innerHTML = item.side.icon || '';
      side.onclick = (e) => { e.stopPropagation(); closeContextMenu(); item.side.onClick?.(); };
      row.appendChild(side);
    }
    if (item.submenu) {
      let sub = null;
      const openSub = () => {
        if (sub) return;
        menu.querySelectorAll('.ctx-item.open').forEach(o => { if (o !== row) { o.classList.remove('open'); o._closeSub?.(); } });
        sub = buildMenu(item.submenu, depth + 1);
        sub.classList.add('ctx-submenu');
        document.body.appendChild(sub);
        const rect = row.getBoundingClientRect();
        let left = rect.right + 2;
        if (left + sub.offsetWidth > window.innerWidth - 8) left = rect.left - sub.offsetWidth - 2;
        let top = rect.top - 5;
        if (top + sub.offsetHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - sub.offsetHeight - 8);
        sub.style.left = `${left}px`;
        sub.style.top = `${top}px`;
        row.classList.add('open');
        openCtxMenu._subs.push(sub);
      };
      row._closeSub = () => { if (sub) { sub.remove(); openCtxMenu._subs = openCtxMenu._subs.filter(s => s !== sub); sub = null; row.classList.remove('open'); } };
      row.onmouseenter = openSub;
      row.onclick = (e) => { e.stopPropagation(); openSub(); };
    } else if (!item.disabled) {
      row.onmouseenter = () => menu.querySelectorAll('.ctx-item.open').forEach(o => { o.classList.remove('open'); o._closeSub?.(); });
      row.onclick = (e) => { e.stopPropagation(); closeContextMenu(); item.onClick?.(); };
    }
    menu.appendChild(row);
  }
  return menu;
}

/** One menu style for every right-click and every "…" button. */
function showContextMenu(items, position) {
  closeContextMenu();
  if (typeof closeProjectPopover === 'function') closeProjectPopover();
  if (typeof closeTaskPopover === 'function') closeTaskPopover();
  const menu = buildMenu(items);
  menu._subs = [];
  const remove = menu.remove.bind(menu);
  menu.remove = () => { for (const s of menu._subs) s.remove(); remove(); };
  document.body.appendChild(menu);
  openCtxMenu = menu;
  placeMenu(menu, position || { x: 20, y: 20 });
  setTimeout(() => {
    document.addEventListener('pointerdown', onCtxPointerDown, true);
    document.addEventListener('keydown', onCtxKey, true);
  }, 0);
  return menu;
}

/**
 * Every folder a terminal can open in from a project launch menu. Keep the
 * current project/track cwd first so the first Terminal row preserves the old
 * single-row behavior, then offer the project folder and every attached
 * folder. A track cwd may point inside one of those roots, so include it even
 * when it is not itself an attached-folder row.
 */
function terminalLaunchItems(project, target) {
  const paths = [target.projectPath, project.root, ...(project.folders || []).map(f => f.path)]
    .filter((path, index, all) => path && all.indexOf(path) === index);

  return paths.map(projectPath => {
    return {
      label: 'Terminal',
      icon: ICONS.terminal(14),
      hint: projectPath === project.root ? '' : `in ${shortProjectPath(projectPath)}`,
      onClick: () => launchTerminalSession({ ...target, projectPath }),
    };
  });
}

function newSessionItems(project, track) {
  const target = launchTargetFor(project, track);
  return [
    ...LAUNCH_CLIS.map(cli => ({ label: harnessLabel(cli), icon: harnessIcon(cli, 14, cliIconClass(cli)), onClick: async () => { const o = await resolveDefaultSessionOptions(target); o.runtime = cli; launchNewSession(target, o); } })),
    ...terminalLaunchItems(project, target),
    { sep: true },
    ...LAUNCH_CLIS.map(cli => ({ label: `${harnessLabel(cli)}, configure…`, muted: true, onClick: () => showNewSessionDialog(target, cli) })),
  ];
}

function showNewSessionMenu(project, track, anchor) {
  const items = [...newSessionItems(project, track)];
  const tracks = (project.tracks || []).filter(t => t.status !== 'done');
  if (tracks.length) {
    items.push({ sep: true }, { head: 'In a track' });
    for (const t of tracks) items.push({ label: t.name, icon: PICONS.list(13), submenu: newSessionItems(project, t) });
  }
  showContextMenu(items, { anchor });
}

/** One Attach: a plain folder attaches as it is; a repository asks how the project should work in it. */
async function attachFolderAsk(project) {
  const folder = await window.api.browseFolder();
  if (!folder) return;
  let info = { git: false };
  try { info = await window.api.getFolderGitStatus(folder); } catch {}
  const mode = info?.git ? await askRepoMode(folder, info) : 'in-place';
  if (!mode) return;
  await attachFolderFlow(project, mode, folder);
}

/** The repository question as a small dialog. Resolves 'in-place', 'worktree' or null. */
function askRepoMode(folderPath, info) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog ws-prompt np-ask-dialog';
    dialog.innerHTML = `
      <h3>${escapeHtml(pathBasename(folderPath))}</h3>
      <div class="add-project-hint">This is a git repository${info?.branch ? `, on ${escapeHtml(info.branch)}` : ''}. How should the project work in it?</div>
      <div class="np-ask-opts">
        <div class="np-ask-opt"><button type="button" class="ws-btn np-ask-btn" data-mode="in-place">As it is</button><div class="np-help">Sessions work in the folder, on whatever is checked out.</div></div>
        <div class="np-ask-opt"><button type="button" class="ws-btn np-ask-btn np-ask-btn--wt" data-mode="worktree">New worktree</button><div class="np-help">A worktree under the project on its branch. Your checkout is untouched.</div></div>
      </div>
      <div class="add-project-actions"><button class="add-project-cancel-btn" type="button">Cancel</button></div>`;
    const done = (value) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    function onKey(e) { if (e.key === 'Escape') done(null); }
    dialog.querySelectorAll('.np-ask-btn').forEach(btn => { btn.onclick = () => done(btn.dataset.mode); });
    dialog.querySelector('.add-project-cancel-btn').onclick = () => done(null);
    document.addEventListener('keydown', onKey);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  });
}

/** "Stop all", with what it would stop, shown only when something is running. */
function stopAllMenuItems(project) {
  const running = runningWorkInProject(project);
  if (!anyRunningWork(running)) return [];
  const parts = [];
  if (running.sessions.length) parts.push(`${running.sessions.length} session${running.sessions.length === 1 ? '' : 's'}`);
  if (running.tasks.length) parts.push(`${running.tasks.length} task${running.tasks.length === 1 ? '' : 's'}`);
  if (running.busy.length) parts.push(`${running.busy.length} working`);
  return [{
    label: 'Stop all',
    icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>',
    hint: parts.join(', '),
    onClick: () => stopAllInProject(project),
  }];
}

/**
 * A row of the project menu that opens one of its tabs (Files, Git,
 * Settings) on the project's page, with the button at its right that opens
 * the tab in a window of its own instead, as beside the tab itself.
 */
function projectTabMenuItem(project, tab, icon) {
  const label = PROJECT_WINDOW_TAB_LABELS[tab];
  return {
    label,
    icon,
    onClick: () => selectProject(project.id, { tab }),
    side: {
      icon: ICONS.popOut(12),
      title: `Open ${label} in a window of its own`,
      always: true,
      onClick: () => window.api.openProjectWindow(project.id, tab),
    },
  };
}

function projectMenuItems(project, { fromPage = false } = {}) {
  const isDone = project.status === 'done';
  return [
    !fromPage && { label: 'Open overview', icon: PICONS.dashboard(14), onClick: () => selectProject(project.id, { tab: 'overview' }) },
    { label: 'New session', icon: PICONS.plus(14), submenu: newSessionItems(project, null) },
    { label: 'New track…', icon: PICONS.list(14), onClick: () => promptNewTrack(project) },
    { label: 'Note', icon: PICONS.note(14), onClick: () => openProjectNote(project) },
    { sep: true },
    { label: 'Rename…', icon: PICONS.pencil(14), onClick: () => renameProjectFlow(project) },
    { label: 'Attach folder…', icon: PICONS.folder(14), onClick: () => attachFolderAsk(project) },
    { label: 'New scheduled task…', icon: PICONS.clock(14), onClick: () => showScheduleDialog({ projectId: project.id, trackId: null, project }) },
    projectTabMenuItem(project, 'files', PICONS.file(14)),
    projectTabMenuItem(project, 'git', PICONS.branch(14)),
    projectTabMenuItem(project, 'settings', ICONS.gear(14)),
    { label: 'Open project folder', icon: ICONS.folderOpen(14), onClick: () => window.api.openPath(project.root) },
    { sep: true },
    { label: project.starred ? 'Unstar project' : 'Star project', icon: starIconSvg(!project.starred, 14), onClick: () => toggleProjectStar(project) },
    ...snoozeMenuItems(project),
    ...stopAllMenuItems(project),
    { label: isDone ? 'Reopen project' : 'Mark as done', icon: PICONS.check(14), onClick: () => toggleProjectDone(project) },
    { label: 'Remove project…', icon: PICONS.trash(14), danger: true, onClick: () => removeProjectFlow(project) },
  ].filter(Boolean);
}

function trackMenuItems(project, track) {
  const sessions = sessionsOfTrack(project, track.id);
  const inherited = project.defaultCwd || project.root;
  const cwdOptions = [{ value: null, label: `Project default (${pathBasename(inherited)})` }];
  if (project.defaultCwd) cwdOptions.push({ value: project.root, label: `Project folder (${pathBasename(project.root)})` });
  for (const f of project.folders || []) cwdOptions.push({ value: f.path, label: pathBasename(f.path) });
  const patch = async (fields) => { const r = await window.api.updateTrack(track.id, fields); if (r?.error) alert(r.error); else loadProjects(); };
  return [
    sessions.length ? { label: 'Resume latest', icon: PICONS.play(13), onClick: () => openSession(sessions[0]) } : null,
    { label: 'New session', icon: PICONS.plus(14), submenu: newSessionItems(project, track) },
    { label: 'New scheduled task…', icon: PICONS.clock(14), onClick: () => showScheduleDialog({ projectId: project.id, trackId: track.id, project }) },
    { label: 'Show all sessions', icon: PICONS.list(14), onClick: () => showTrackInDrawer(project, track.id) },
    { sep: true },
    { label: 'Rename…', icon: PICONS.pencil(14), onClick: () => renameTrackFlow(project, track) },
    { label: 'Sessions start in', icon: PICONS.folder(14), hint: track.cwd ? pathBasename(track.cwd) : 'default',
      submenu: cwdOptions.map(o => ({ label: o.label, muted: (track.cwd || null) === o.value, hint: (track.cwd || null) === o.value ? 'current' : '', onClick: () => patch({ cwd: o.value }) })) },
    { label: 'CLI', icon: PICONS.terminal(14), hint: track.cli ? harnessLabel(track.cli) : 'ask',
      submenu: [
        { label: 'Ask each time', muted: !track.cli, onClick: () => patch({ cli: null }) },
        ...LAUNCH_CLIS.map(cli => ({ label: harnessLabel(cli), icon: harnessIcon(cli, 14, cliIconClass(cli)), muted: track.cli === cli, onClick: () => patch({ cli }) })),
      ] },
    { sep: true },
    { label: track.status === 'done' ? 'Reopen track' : 'Mark as done', icon: PICONS.check(14), onClick: () => toggleTrackDone(project, track, patch) },
    { label: 'Delete track…', icon: PICONS.trash(14), danger: true, onClick: () => deleteTrackFlow(project, track) },
  ].filter(Boolean);
}

/** The "Move to…" section of a session menu: tracks of its project, other projects, or no project. */
/**
 * Where a session can be moved. `inMenu`: the items sit among a session's
 * other actions (its right-click menu), so the projects go behind one "Move
 * to project" row, wherever the session is filed. Without it they are the
 * Sessions tab's Move to project… popover.
 */
function sessionMoveItems(session, { inMenu = false } = {}) {
  const info = projectForSession(session);
  const project = info?.project || null;
  const move = async (projectId, trackId) => {
    const result = await window.api.setSessionAssignment(session.sessionId, projectId, trackId);
    if (result?.error) { alert(result.error); return; }
    session.projectId = projectId;
    session.trackId = trackId;
    if (session.type === 'terminal') persistTerminalSession(session);
    loadProjects();
  };
  const moveItems = [];
  // A group of items, after a separator unless it opens the menu.
  const addGroup = (...items) => moveItems.push(...(moveItems.length ? [{ sep: true }] : []), ...items);
  if (project) {
    moveItems.push({ head: `Move within ${project.name}` });
    for (const t of (project.tracks || []).filter(t => t.status !== 'done')) {
      const current = session.trackId === t.id;
      moveItems.push({ label: t.name, muted: current, hint: current ? 'current' : '', onClick: current ? null : () => move(project.id, t.id) });
    }
    const inGeneral = !session.trackId;
    moveItems.push({ label: 'General', muted: inGeneral, hint: inGeneral ? 'current' : '', onClick: inGeneral ? null : () => move(project.id, null) });
    moveItems.push({ label: 'New track from here…', onClick: async () => {
      const name = await showPromptDialog({ title: 'New track', label: 'Name', placeholder: 'Build' });
      if (!name) return;
      const created = await window.api.createTrack(project.id, { name, cwd: null });
      if (created?.error) { alert(created.error); return; }
      move(project.id, created.track.id);
    } });
  }
  const others = (cachedProjectTreeAll?.projects || []).filter(p => p.status !== 'done' && p.id !== project?.id);
  if (others.length) {
    const projectRows = others.map(p => {
      const tracks = (p.tracks || []).filter(t => t.status !== 'done');
      return tracks.length
        ? { label: p.name, submenu: [{ label: 'General', onClick: () => move(p.id, null) }, ...tracks.map(t => ({ label: t.name, onClick: () => move(p.id, t.id) }))] }
        : { label: p.name, onClick: () => move(p.id, null) };
    });
    // Behind one row, so the menu reads as an action. In the Sessions tab's
    // popover, for a session outside every project, they are the whole menu.
    if (project || inMenu) addGroup({ label: 'Move to project', icon: PICONS.folder(14), submenu: projectRows });
    else addGroup({ head: 'Move to project' }, ...projectRows);
  }
  if (session.projectId) addGroup({
    label: `Remove from ${project ? project.name : 'project'}…`,
    icon: PICONS.x(13), hint: 'stays in the Sessions tab',
    onClick: () => {
      const name = project ? project.name : 'its project';
      if (!confirm(`Remove ${sessionTitle(session)} from ${name}?\n\nThe session stays in the Sessions tab under its folder.`)) return;
      move(null, null);
    },
  });
  else if (info?.byCwd) addGroup({ label: 'Filed by its folder', disabled: true });
  return moveItems;
}

/**
 * Fork a session. The fork runs in the source's folder and is filed where the
 * source is, so the project's lists show it straight away.
 */
function forkSessionInPlace(session) {
  const info = projectForSession(session);
  const target = info
    ? { ...launchTargetFor(info.project, (info.project.tracks || []).find(t => t.id === session.trackId) || null), projectPath: session.projectPath }
    : { projectPath: session.projectPath };
  forkSession(session, target);
}

function sessionMenuItems(session) {
  const moveItems = sessionMoveItems(session, { inMenu: true });
  const running = isSessionRunning(session.sessionId);
  const unread = typeof responseReadySessions !== 'undefined' && responseReadySessions.has(session.sessionId);
  const sessionActions = [
    running ? { label: 'Stop', icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>', onClick: () => confirmAndStopSession(session.sessionId) } : null,
    session.type !== 'terminal' && !running ? { label: 'Resume with config…', icon: ICONS.launchConfig(14), onClick: () => showResumeSessionDialog(session) } : null,
    session.type !== 'terminal' && cliCanFork(session.runtime) ? { label: 'Fork', icon: PICONS.fork(14), onClick: () => forkSessionInPlace(session) } : null,
    session.type !== 'terminal' ? { label: unread ? 'Mark as read' : 'Mark as unread', icon: unread ? ICONS.markRead(14) : ICONS.markUnread(14), onClick: () => { if (unread) clearUnread(session.sessionId); else markUnread(session.sessionId); refreshSidebar(); } } : null,
    session.type !== 'terminal' ? { label: 'View messages', icon: PICONS.messages(14), onClick: () => showJsonlViewer(session) } : null,
  ].filter(Boolean);
  const stateActions = [
    { label: session.starred ? 'Unstar session' : 'Star session', icon: starIconSvg(!session.starred, 14), onClick: () => toggleSessionStar(session) },
    { label: 'Rename…', icon: PICONS.pencil(14), onClick: () => renameSessionFlow(session) },
    { label: 'Copy session ID', onClick: () => window.api.writeClipboard(session.sessionId) },
    isDismissibleSession(session.sessionId) ? { label: 'Dismiss', icon: PICONS.x(14), hint: 'never started', onClick: () => dismissSession(session.sessionId) } : null,
    session.type !== 'terminal' ? { label: session.archived ? 'Unarchive' : 'Archive', icon: PICONS.archive(14), onClick: () => toggleArchiveSession(session) } : null,
  ].filter(Boolean);
  return [
    ...sessionActions,
    sessionActions.length && moveItems.length ? { sep: true } : null,
    ...moveItems,
    moveItems.length && stateActions.length ? { sep: true } : null,
    ...stateActions,
  ].filter(Boolean);
}

// --- Flows (create, rename, attach, detach, done, remove) ---
//
// Dialog rule: a click on the backdrop does nothing. These hold typed work, and
// a stray click used to throw it away. Escape and Cancel are the ways out.

/** A small modal with one text field. Resolves the trimmed value, or null on cancel. */
function showPromptDialog({ title, label, value = '', placeholder = '', confirm = 'Save', help = '', type = 'text', min = '' }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog ws-prompt';
    dialog.innerHTML = `
      <h3>${escapeHtml(title)}</h3>
      ${label ? `<label class="new-project-label">${escapeHtml(label)}</label>` : ''}
      <div class="folder-input-row"><input type="${escapeHtml(type)}" id="ws-prompt-input" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}"${min ? ` min="${escapeHtml(min)}"` : ''}></div>
      ${help ? `<div class="add-project-hint" style="margin-top:8px;">${escapeHtml(help)}</div>` : ''}
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn" type="button">${escapeHtml(confirm)}</button>
      </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const input = dialog.querySelector('#ws-prompt-input');
    const finish = (result) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); if (e.key === 'Enter') finish(input.value.trim() || null); };
    document.addEventListener('keydown', onKey);
    dialog.querySelector('.add-project-cancel-btn').onclick = () => finish(null);
    dialog.querySelector('.add-project-add-btn').onclick = () => finish(input.value.trim() || null);
    input.focus();
    input.select();
  });
}

async function promptNewTrack(project) {
  const name = await showPromptDialog({ title: 'New track', label: 'Name', placeholder: 'Build', confirm: 'Create', help: 'A track is one line of work inside the project, with its own sessions. It starts in the project folder unless you change it.' });
  if (!name) return;
  const result = await window.api.createTrack(project.id, { name, cwd: null });
  if (result?.error) { alert(result.error); return; }
  loadProjects();
}

async function renameProjectFlow(project) {
  const name = await showPromptDialog({ title: 'Rename project', label: 'Name', value: project.name, confirm: 'Rename', help: 'The folder on disk keeps its name.' });
  if (!name || name === project.name) return;
  const result = await window.api.updateProject(project.id, { name });
  if (result?.error) { alert(result.error); return; }
  loadProjects();
}

async function renameTrackFlow(project, track) {
  const name = await showPromptDialog({ title: 'Rename track', label: 'Name', value: track.name, confirm: 'Rename' });
  if (!name || name === track.name) return;
  const result = await window.api.updateTrack(track.id, { name });
  if (result?.error) { alert(result.error); return; }
  loadProjects();
}

/**
 * Rename a session, the same as the Sessions tab does inline: the name is
 * stored beside the transcript, and typing the session's own title back
 * clears it, so the title follows the CLI's again.
 */
async function renameSessionFlow(session) {
  const fallback = session.aiTitle || session.summary || '';
  const current = session.name || fallback;
  const name = await showPromptDialog({ title: 'Rename session', label: 'Name', value: current, confirm: 'Rename' });
  if (!name || name === current) return;
  const nameToSave = name === fallback ? null : name;
  await window.api.renameSession(session.sessionId, nameToSave);
  session.name = nameToSave;
  loadProjects();
}

async function attachFolderFlow(project, mode, folderPath = null) {
  const folder = folderPath || await window.api.browseFolder();
  if (!folder) return;
  let branch = null;
  if (mode === 'worktree' && !projectBranchName(project)) {
    branch = await showPromptDialog({ title: `Branch for ${pathBasename(folder)}`, label: 'Branch name', placeholder: project.slug, confirm: 'Attach' });
    if (!branch) return;
  }
  const result = await window.api.attachProjectFolder(project.id, { path: folder, mode, branch });
  if (result?.error) { alert(result.error); return; }
  loadProjects();
}

/**
 * The one question before a folder leaves a project. A worktree also offers
 * to delete its checkout; keeping it is the default. Cancel changes nothing.
 * Resolves { removeWorktree } to go ahead, or null.
 */
function confirmDetachFolder(project, folder) {
  const isWorktree = folder.mode === 'worktree';
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog ws-prompt';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'detach-folder-title');
    dialog.innerHTML = `
      <h3 id="detach-folder-title">${escapeHtml(`Detach ${pathBasename(folder.path)} from ${project.name}?`)}</h3>
      <div class="add-project-hint">${isWorktree ? 'New sessions of the project stop working in it.' : 'New sessions of the project stop working in it. Nothing on disk changes.'}</div>
      <div class="np-tree mono detach-folder-path"><span class="np-tree-item">${escapeHtml(folder.path)}</span></div>
      ${isWorktree ? `
        <label class="new-project-label"><input type="checkbox" class="detach-folder-remove"> Also delete this checkout</label>
        <div class="add-project-hint">${escapeHtml(folder.branch ? `The branch ${folder.branch} and its commits stay.` : 'Its branch and commits stay.')}</div>` : ''}
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn" type="button">Detach</button>
      </div>`;
    const removeBox = dialog.querySelector('.detach-folder-remove');
    const confirmBtn = dialog.querySelector('.add-project-add-btn');
    if (removeBox) removeBox.onchange = () => { confirmBtn.textContent = removeBox.checked ? 'Detach and delete' : 'Detach'; };
    const finish = value => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    dialog.querySelector('.add-project-cancel-btn').onclick = () => finish(null);
    confirmBtn.onclick = () => finish({ removeWorktree: !!removeBox?.checked });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    dialog.querySelector('.add-project-cancel-btn').focus();
  });
}

async function detachFolderFlow(project, folder) {
  const choice = await confirmDetachFolder(project, folder);
  if (!choice) return;
  const opts = folder.mode === 'worktree' ? { removeWorktree: choice.removeWorktree } : {};
  let result = await window.api.detachProjectFolder(project.id, folder.path, opts);
  if (result?.dirty && confirm(`The worktree has uncommitted changes.\n\n${result.error}\n\nRemove it anyway and lose those changes?`)) {
    result = await window.api.detachProjectFolder(project.id, folder.path, { removeWorktree: true, force: true });
  }
  if (result?.error) { alert(result.error); return; }
  loadProjects();
}

async function deleteTrackFlow(project, track) {
  const choice = await new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog ws-prompt';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'delete-track-title');
    dialog.innerHTML = `
      <h3 id="delete-track-title">Delete track ${escapeHtml(track.name)}?</h3>
      <div class="add-project-hint">Sessions stay in ${escapeHtml(project.name)} and retain their former track name.</div>
      <label class="new-project-label"><input type="checkbox" class="delete-track-archive"> Also archive all sessions in this track</label>
      <div class="add-project-hint">If selected, running sessions will stop and raw terminals will close.</div>
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn" type="button">Delete track</button>
      </div>`;
    const finish = value => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    dialog.querySelector('.add-project-cancel-btn').onclick = () => finish(null);
    dialog.querySelector('.add-project-add-btn').onclick = () => finish({ archiveSessions: dialog.querySelector('input').checked });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    dialog.querySelector('.add-project-cancel-btn').focus();
  });
  if (!choice) return;
  const result = await window.api.deleteTrack(track.id, choice);
  if (result?.error) { alert(result.error); return; }
  for (const session of sessionMap.values()) {
    if (session.trackId !== track.id && !result.sessionIds?.includes(session.sessionId)) continue;
    session.trackId = null;
    session.formerTrackName = result.formerTrackName;
    if (choice.archiveSessions) {
      session.archived = 1;
      forgetTerminalHistory(session.sessionId);
      if (session.type === 'terminal') forgetPersistedTerminalSession(session.sessionId);
    } else if (session.type === 'terminal') persistTerminalSession(session);
  }
  if (projectsUi.trackByProject[project.id] === track.id) delete projectsUi.trackByProject[project.id];
  await loadProjects();
}

/** A project's worktrees, each marked dirty when git reports uncommitted changes right now. */
async function projectWorktreesWithState(project) {
  const worktrees = (project.folders || []).filter(f => f.mode === 'worktree');
  if (!worktrees.length) return [];
  let byPath = {};
  try { byPath = (await window.api.getProjectGitStatus(project.id, { force: true }))?.byPath || {}; } catch {}
  return worktrees.map(f => ({ path: f.path, branch: f.branch || '', dirty: !!(byPath[f.path]?.git && byPath[f.path].dirty) }));
}

/**
 * Delete the checkouts of a finished project's worktrees. Only the ones the
 * dialog showed as having uncommitted changes are forced, so a checkout that
 * picked up changes after the user looked is kept rather than wiped.
 * Resolves the ones that stay, with why.
 */
async function deleteProjectWorktrees(project, worktrees) {
  const kept = [];
  for (const wt of worktrees) {
    const result = await window.api.detachProjectFolder(project.id, wt.path, { removeWorktree: true, force: wt.dirty });
    if (result?.error) kept.push(`${wt.path}\n  ${result.dirty ? 'It has uncommitted changes.' : result.error}`);
  }
  return kept;
}

/**
 * What is still alive in a project: its running sessions, and the tasks
 * running in any folder it works in. Marking a project done stops both, so
 * the user is asked first.
 */
function runningWorkInProject(project) {
  const sessions = projectSessionsAll(project).filter(s => isSessionRunning(s.sessionId));
  const pseudo = typeof taskPseudoProject === 'function' ? taskPseudoProject(project) : null;
  const tasks = (pseudo?.tasks || []).filter(t => t.run?.running);
  // Mid-turn sessions are the ones where stopping interrupts real work, so
  // they are called out separately from ones merely sitting at a prompt.
  const busy = sessions.filter(s => typeof sessionBusyState !== 'undefined' && sessionBusyState.get(s.sessionId) === true);
  return { sessions, tasks, busy };
}

function anyRunningWork(running) {
  return running.sessions.length > 0 || running.tasks.length > 0;
}

/** Stop every running session and task in one project. */
async function stopRunningWork(running) {
  for (const session of running.sessions) {
    try { await window.api.stopSession(session.sessionId); } catch {}
    activePtyIds.delete(session.sessionId);
  }
  for (const task of running.tasks) {
    try { await window.api.stopTask(task.projectPath, task.label); } catch {}
  }
  pollActiveSessions();
}

/** Running sessions (mid-turn ones marked) and tasks, one line each. */
function runningWorkLines(running) {
  const busyIds = new Set((running.busy || []).map(s => s.sessionId));
  return [
    ...running.sessions.map(s => busyIds.has(s.sessionId) ? `${sessionTitle(s)}  · working` : sessionTitle(s)),
    ...running.tasks.map(t => t.label),
  ];
}

/** Mid-turn sessions are called out, since stopping those interrupts work in progress. */
function busyNote(running) {
  const n = (running.busy || []).length;
  return n ? `${n} session${n === 1 ? ' is' : 's are'} mid-turn; stopping interrupts work in progress.` : '';
}

/** A short scrolling list for a dialog, capped at `max` lines. */
function dialogListHtml(lines, max = 8) {
  const shown = lines.slice(0, max);
  const more = lines.length - shown.length;
  return `<div class="np-tree mono done-running-list">${shown.map(n => `<span class="np-tree-item">${escapeHtml(n)}</span>`).join('')}${more > 0 ? `<span class="np-tree-item"><em>+ ${more} more</em></span>` : ''}</div>`;
}

/**
 * Warn before "Stop all" stops a project's running work, or the search bar's
 * Stop the running sessions it shows (`where` says which, e.g. 'matching "api"').
 * Resolves true to go ahead.
 */
function confirmStopWork(project, running, { where = `in ${project?.name}` } = {}) {
  const parts = [];
  if (running.sessions.length) parts.push(`${running.sessions.length} running session${running.sessions.length === 1 ? '' : 's'}`);
  if (running.tasks.length) parts.push(`${running.tasks.length} running task${running.tasks.length === 1 ? '' : 's'}`);
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog ws-prompt';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'stop-running-title');
    dialog.innerHTML = `
      <h3 id="stop-running-title">${escapeHtml(`Stop ${parts.join(' and ')} ${where}?`)}</h3>
      <div class="add-project-hint">${escapeHtml(busyNote(running))}</div>
      ${dialogListHtml(runningWorkLines(running))}
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn" type="button">Stop all</button>
      </div>`;
    const finish = value => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    dialog.querySelector('.add-project-cancel-btn').onclick = () => finish(false);
    dialog.querySelector('.add-project-add-btn').onclick = () => finish(true);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    dialog.querySelector('.add-project-cancel-btn').focus();
  });
}

/**
 * The one question before a project is marked done: what stops, what pauses,
 * and whether to keep or delete its worktrees. Keep is the default, so a
 * project can be reopened later exactly as it was. Cancel changes nothing.
 * Resolves { deleteWorktrees } to go ahead, or null.
 */
function confirmMarkDone(project, { running, schedules, worktrees }) {
  const stopLines = runningWorkLines(running);
  const dirty = worktrees.filter(w => w.dirty);
  const n = worktrees.length;
  const plural = n === 1 ? 'worktree' : 'worktrees';
  const sections = [];
  if (stopLines.length) {
    sections.push(`
      <label class="new-project-label">Stops now</label>
      ${busyNote(running) ? `<div class="add-project-hint">${escapeHtml(busyNote(running))}</div>` : ''}
      ${dialogListHtml(stopLines)}`);
  }
  if (schedules.length) {
    sections.push(`
      <label class="new-project-label">Pauses until reopened</label>
      ${dialogListHtml(schedules.map(s => s.name))}`);
  }
  if (n) {
    const wtLines = worktrees.map(w => `${pathBasename(w.path)}${w.branch ? ` · ${w.branch}` : ''}${w.dirty ? '  · uncommitted changes' : ''}`);
    sections.push(`
      <label class="new-project-label">${n === 1 ? 'Worktree' : `${n} worktrees`}</label>
      ${dialogListHtml(wtLines)}
      <div class="done-choice" role="radiogroup">
        <label class="done-choice-opt"><input type="radio" name="done-wt" value="keep" checked><span><b>Keep on disk</b><span class="done-choice-help">Reopen the project any time and pick up where you left off.</span></span></label>
        <label class="done-choice-opt"><input type="radio" name="done-wt" value="delete"><span><b>Delete the ${plural}</b><span class="done-choice-help">Removes ${n === 1 ? 'this folder' : 'these folders'}. Branches and their commits stay.</span>
          <span class="done-choice-paths mono">${worktrees.map(w => `<span title="${escapeHtml(w.path)}">${escapeHtml(shortPathLabel(w.path))}${w.dirty ? '<em> · uncommitted changes</em>' : ''}</span>`).join('')}</span></span></label>
      </div>
      ${dirty.length ? `<div class="done-choice-warn" hidden>${dirty.length === n && n === 1 ? 'It has' : `${dirty.length} of them ${dirty.length === 1 ? 'has' : 'have'}`} uncommitted changes. Deleting loses them.</div>` : ''}`);
  }
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog ws-prompt';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'mark-done-title');
    dialog.innerHTML = `
      <h3 id="mark-done-title">${escapeHtml(`Mark ${project.name} as done?`)}</h3>
      <div class="add-project-hint">It moves to the Done list. Reopen it any time.</div>
      ${sections.join('')}
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn" type="button">Mark as done</button>
      </div>`;
    const confirmBtn = dialog.querySelector('.add-project-add-btn');
    const warn = dialog.querySelector('.done-choice-warn');
    const deleting = () => dialog.querySelector('input[name="done-wt"]:checked')?.value === 'delete';
    dialog.querySelectorAll('input[name="done-wt"]').forEach(input => {
      input.onchange = () => {
        confirmBtn.textContent = deleting() ? `Mark as done and delete ${plural}` : 'Mark as done';
        if (warn) warn.hidden = !deleting();
      };
    });
    const finish = value => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    dialog.querySelector('.add-project-cancel-btn').onclick = () => finish(null);
    confirmBtn.onclick = () => finish({ deleteWorktrees: deleting() });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    dialog.querySelector('.add-project-cancel-btn').focus();
  });
}

/**
 * Marking a track done pauses its scheduled tasks until it is reopened; say
 * so before doing it. `patch` is the caller's updateTrack wrapper.
 */
async function toggleTrackDone(project, track, patch) {
  const toDone = track.status !== 'done';
  if (toDone) {
    const paused = schedulesForProject(project).filter(s => s.trackId === track.id && s.enabled);
    if (paused.length && !confirm(`Mark “${track.name}” as done?\n\n${paused.length} scheduled task${paused.length === 1 ? '' : 's'} in it will pause until the track is reopened.`)) return;
  }
  await patch({ status: toDone ? 'done' : 'active' });
}

/**
 * Reopening is one click. Marking done asks once, and only when there is
 * something to ask about: running work, schedules, or worktrees. Everything
 * is decided in that dialog; nothing happens until the user confirms.
 */
async function toggleProjectDone(project) {
  if (project.status === 'done') {
    const result = await window.api.updateProject(project.id, { status: 'active' });
    if (result?.error) { alert(result.error); return; }
    loadProjects();
    return;
  }
  const running = runningWorkInProject(project);
  // Schedules do not need stopping — a done project simply stops firing
  // them — but the user should hear that before it happens.
  const schedules = schedulesForProject(project).filter(s => s.enabled);
  const worktrees = await projectWorktreesWithState(project);
  let choice = { deleteWorktrees: false };
  if (anyRunningWork(running) || schedules.length || worktrees.length) {
    choice = await confirmMarkDone(project, { running, schedules, worktrees });
    if (!choice) return;
  }
  if (anyRunningWork(running)) await stopRunningWork(running);
  const result = await window.api.updateProject(project.id, { status: 'done' });
  if (result?.error) { alert(result.error); return; }
  if (choice.deleteWorktrees) {
    const kept = await deleteProjectWorktrees(project, worktrees);
    if (kept.length) alert(`${project.name} is done, but ${kept.length === 1 ? 'one worktree was' : `${kept.length} worktrees were`} not deleted and ${kept.length === 1 ? 'stays' : 'stay'} on disk:\n\n${kept.join('\n\n')}`);
  }
  loadProjects();
}

/** Stop every running session and task in a project, after confirming. */
async function stopAllInProject(project) {
  const running = runningWorkInProject(project);
  if (!anyRunningWork(running)) return;
  if (!await confirmStopWork(project, running)) return;
  await stopRunningWork(running);
  loadProjects();
}

// --- Snooze ---
//
// Hidden until a wake time; the sessions keep running. The decision is made
// from the clock at render (see snooze.js), so waking costs nothing and the
// only timer is the one below, armed at the earliest wake.

let projectWakeTimer = null;

/** Snoozed as the list sees it: the wake time is ahead and no session needs input. */
function isProjectSnoozed(project) {
  return projectSnoozed(project, Date.now(), groupState(projectSessionsAll(project)) === 'attention');
}

function projectSnoozedKey(projects) {
  return projects.filter(isProjectSnoozed).map(p => p.id).sort().join('|');
}

/**
 * One timer for the whole list, and none while nothing is snoozed. A late
 * timer (a throttled background window, a laptop asleep past the hour) only
 * delays the repaint: focus and the session poll compare against the clock
 * too, so the list catches up on its own.
 */
function armProjectWakeTimer(projects) {
  if (projectWakeTimer) { clearTimeout(projectWakeTimer); projectWakeTimer = null; }
  const delay = nextWakeDelayMs(projects, Date.now());
  if (delay === null) return;
  projectWakeTimer = setTimeout(() => { projectWakeTimer = null; renderProjectList(); }, delay);
}

async function snoozeProject(project, snoozedUntil) {
  const result = await window.api.updateProject(project.id, { snoozedUntil });
  if (result?.error) { alert(result.error); return; }
  // Out of sight means the page too: snoozing the open project closes it.
  // The shelf itself is left as the user set it; it starts collapsed.
  if (snoozedUntil && projectsUi.selectedProjectId === project.id) {
    projectsUi.selectedProjectId = null;
    saveProjectsUi();
    leaveProjectViews();
    placeholder.style.display = '';
  }
  loadProjects();
}

function wakeProject(project) {
  return snoozeProject(project, null);
}

async function pickSnoozeTime(project) {
  const now = new Date();
  const suggested = new Date(now.getTime() + 60 * 60 * 1000);
  suggested.setMinutes(0, 0, 0);
  const value = await showPromptDialog({
    title: `Snooze ${project.name}`, label: 'Wake up at', confirm: 'Snooze',
    type: 'datetime-local', value: toLocalInputValue(suggested), min: toLocalInputValue(now),
    help: 'The project moves to the Snoozed shelf until then. Its sessions keep running.',
  });
  if (!value) return;
  const wake = new Date(value);
  if (!Number.isFinite(wake.getTime()) || wake.getTime() <= Date.now()) { alert('Pick a time in the future.'); return; }
  snoozeProject(project, wake.toISOString());
}

function snoozeSubmenu(project) {
  const items = resolveSnoozePresets(new Date()).map(p => ({ label: p.label, hint: p.whenLabel, onClick: () => snoozeProject(project, p.snoozedUntil) }));
  items.push({ sep: true }, { label: 'Pick a time…', onClick: () => pickSnoozeTime(project) });
  return items;
}

/** The snooze rows of a project menu. A finished project has none; one that needs input cannot hide. */
function snoozeMenuItems(project) {
  if (project.status === 'done') return [];
  if (groupState(projectSessionsAll(project)) === 'attention') {
    return [{ label: 'Snooze', icon: PICONS.clock(14), disabled: true, hint: 'needs input' }];
  }
  if (isProjectSnoozed(project)) {
    return [
      { label: 'Wake now', icon: PICONS.clock(14), hint: `wakes ${snoozeWakeDescription(project.snoozedUntil)}`, onClick: () => wakeProject(project) },
      { label: 'Snooze again', icon: PICONS.clock(14), submenu: snoozeSubmenu(project) },
    ];
  }
  return [{ label: 'Snooze', icon: PICONS.clock(14), submenu: snoozeSubmenu(project) }];
}

function projectStatusChip(project) {
  if (project.status === 'done') return '<span class="ws-chip ws-chip--status done">Done</span>';
  if (isProjectSnoozed(project)) return `<span class="ws-chip ws-chip--status snoozed" title="Wakes ${escapeHtml(snoozeWakeDescription(project.snoozedUntil))}">Snoozed</span>`;
  return '<span class="ws-chip ws-chip--status active">Active</span>';
}

// The app can come back from a sleep or a throttled background window after
// a wake time passed. Focus is the moment the user looks, so repaint then.
window.addEventListener('focus', () => {
  if ((currentProjectTree()?.projects || []).some(p => p.snoozedUntil)) renderProjectList();
});

// A project is removed only once "delete" is typed, so it is never one click away.
const REMOVE_PROJECT_WORD = 'delete';

/** Whether what was typed confirms a removal: the word, in any case, spaces around it ignored. */
function isRemoveProjectWord(value) {
  return String(value || '').trim().toLowerCase() === REMOVE_PROJECT_WORD;
}

/** Ask before a project is removed; resolves true once the user typed the word and confirmed. */
function confirmRemoveProject(project) {
  return new Promise(resolve => {
    let input = null;
    const handle = gitGraphOpenDialog({
      title: `Remove ${project.name} from Switchboard Evolution?`,
      bodyHtml: `<p class="ws-remove-text">The folder <span class="mono">${escapeHtml(project.root || '')}</span> and all its sessions stay on disk. The project's tracks and schedules are removed with it.</p>
        <label class="new-project-label" for="ws-remove-word">Type <strong>${REMOVE_PROJECT_WORD}</strong> to confirm</label>
        <div class="folder-input-row"><input type="text" id="ws-remove-word" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${REMOVE_PROJECT_WORD}" aria-label="Type ${REMOVE_PROJECT_WORD} to confirm"></div>`,
      primaryLabel: 'Remove project',
      primaryDanger: true,
      focusSelector: '#ws-remove-word',
      onSubmit: async () => {
        if (!isRemoveProjectWord(input && input.value)) throw new Error(`Type ${REMOVE_PROJECT_WORD} to remove the project.`);
        handle.close();
        resolve(true);
      },
      onCancel: () => resolve(false),
    });
    input = handle.dialog.querySelector('#ws-remove-word');
    const primary = handle.dialog.querySelector('.gg-dialog-primary');
    const sync = () => { primary.disabled = !isRemoveProjectWord(input.value); };
    input.addEventListener('input', sync);
    sync();
  });
}

async function removeProjectFlow(project) {
  if (!(await confirmRemoveProject(project))) return;
  const result = await window.api.deleteProject(project.id);
  if (result?.error) { alert(result.error); return; }
  projectsUi.navigationByProject.delete(project.id);
  if (projectsUi.selectedProjectId === project.id) { projectsUi.selectedProjectId = null; saveProjectsUi(); leaveProjectViews(); placeholder.style.display = ''; }
  loadProjects();
}

// --- "Sessions start in" select (shared by settings rows) ---

function buildCwdField(project, current, firstOptionLabel, extraOptions, onChange) {
  const field = document.createElement('div');
  field.className = 'ws-cwd';
  const label = document.createElement('label');
  label.className = 'ws-label';
  label.textContent = 'Sessions start in';
  const select = document.createElement('select');
  select.className = 'ws-select';
  const options = [{ value: '', label: firstOptionLabel }, ...(extraOptions || [])];
  for (const folder of project.folders || []) {
    if (!options.some(o => o.value === folder.path)) options.push({ value: folder.path, label: pathBasename(folder.path) });
  }
  if (current && !options.some(o => o.value === current)) options.push({ value: current, label: current });
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    o.selected = (current || '') === opt.value;
    select.appendChild(o);
  }
  select.onchange = () => onChange(select.value || null);
  field.append(label, select);
  return field;
}

// --- Popovers kept for the Sessions tab's Move button ---

function closeProjectPopover() {
  if (openProjectPopover) {
    openProjectPopover.element.remove();
    document.removeEventListener('pointerdown', dismissProjectPopover);
    openProjectPopover = null;
  }
}

function dismissProjectPopover(event) {
  if (!openProjectPopover) return;
  if (openProjectPopover.element.contains(event.target) || openProjectPopover.anchor.contains(event.target)) return;
  closeProjectPopover();
}

/** The Sessions tab's Move button: the same menu the Projects tab uses. */
function showMovePopover(session, anchor) {
  const items = sessionMoveItems(session);
  if (!items.length) items.push({ label: 'No projects yet. Create one from the Projects tab.', disabled: true });
  showContextMenu(items, { anchor });
}

// --- New project dialog ---

function slugifyClient(name) {
  let slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 60) slug = slug.slice(0, 60).replace(/-+$/g, '');
  return slug || 'project';
}

/**
 * New project: a form on the left, and on the right what Create will make:
 * the project folder and its files, each worktree on its branch, and folders
 * used in place. Pass `folders` to open
 * with folders already attached (a "new project from this folder" flow).
 */
async function showNewProjectDialog({ name: initialName = '', folders: initialFolders = [] } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay np-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog np-dialog';
  dialog.innerHTML = `
    <div class="np-form">
      <h3>New project</h3>
      <label class="new-project-label" for="np-name">Name</label>
      <div class="folder-input-row">
        <input type="text" id="np-name" placeholder="Website redesign" autocomplete="off" spellcheck="false" value="${escapeHtml(initialName)}">
      </div>
      <div class="np-row-head">
        <label class="new-project-label">Works in</label>
        <button type="button" class="np-link" id="np-add-folder">${PICONS.plus(11)}<span>Add folder</span></button>
      </div>
      <div class="np-folders" id="np-folders"></div>
      <div class="np-branch-line" id="np-branch-line" style="display:none;"></div>
      <div class="np-branch" id="np-branch" style="display:none;">
        <label class="new-project-label" for="np-branch-name">Worktree branch</label>
        <div class="np-inline">
          <input type="text" id="np-branch-name" class="np-input mono" spellcheck="false" title="One branch name for every worktree">
          <label class="ws-check"><input type="checkbox" id="np-shared-branch" checked> Same branch in every repo</label>
        </div>
        <div class="np-help" id="np-branch-help"></div>
      </div>
      <div class="add-project-error" id="np-error"></div>
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn" type="button">Create project</button>
      </div>
    </div>
    <div class="np-preview" id="np-preview"></div>
  `;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const q = (sel) => dialog.querySelector(sel);
  const nameInput = q('#np-name');
  const foldersEl = q('#np-folders');
  const branchSection = q('#np-branch');
  const branchLine = q('#np-branch-line');
  const branchInput = q('#np-branch-name');
  const sharedBox = q('#np-shared-branch');
  const branchHelp = q('#np-branch-help');
  const errorEl = q('#np-error');
  const previewEl = q('#np-preview');
  const createBtn = q('.add-project-add-btn');

  // mode is null until the folder is known: a plain folder becomes in-place on
  // its own, a repository asks. A caller may decide up front with f.mode.
  const folders = initialFolders.map(f => ({ path: f.path, mode: f.mode || null, branch: '', git: null, envFiles: [], copyEnv: new Set() }));
  let root = '~/Switchboard';
  try { root = (await window.api.getProjectsRoot()) || root; } catch {}
  const shortPath = (p) => (typeof shortProjectPath === 'function' ? shortProjectPath(p) : p);
  const slug = () => slugifyClient(nameInput.value);
  const branchName = () => (sharedBox.checked && branchInput.value.trim()) || slug();
  // With one shared name every worktree uses it; otherwise each repo names its own, defaulting to the slug.
  const branchFor = (folder) => (sharedBox.checked ? branchName() : (folder.branch.trim() || slug()));
  const hasWorktree = () => folders.some(f => f.mode === 'worktree');

  function renderBranchLine() {
    const any = hasWorktree();
    branchLine.style.display = any ? '' : 'none';
    if (!any) branchSection.style.display = 'none';
    branchLine.innerHTML = sharedBox.checked
      ? `Worktrees use branch <b class="mono">${escapeHtml(branchName())}</b> · <button type="button" class="np-link" id="np-branch-change">Change</button>`
      : `Each worktree names its own branch · <button type="button" class="np-link" id="np-branch-change">Change</button>`;
    branchLine.querySelector('#np-branch-change').onclick = () => {
      const open = branchSection.style.display === 'none';
      branchSection.style.display = open ? '' : 'none';
      if (open && sharedBox.checked) branchInput.focus();
    };
    branchInput.placeholder = slug();
    branchInput.style.display = sharedBox.checked ? '' : 'none';
    branchHelp.textContent = sharedBox.checked
      ? 'One branch name, checked out in every worktree.'
      : 'Each worktree gets its own branch. Name them on the rows above; empty means the project name.';
  }

  function renderFolders() {
    foldersEl.replaceChildren();
    if (!folders.length) {
      const none = document.createElement('div');
      none.className = 'np-folder-none';
      none.textContent = 'None yet. A project can work in its own folder alone.';
      foldersEl.appendChild(none);
    }
    for (const folder of folders) {
      const isRepo = folder.git?.git === true;
      const asking = folder.mode === null && isRepo;
      const row = document.createElement('div');
      row.className = 'np-folder' + (asking ? ' np-folder--ask' : '');
      row.dataset.path = folder.path;
      let detail;
      if (folder.git === null) detail = shortPath(folder.path) + ' · checking…';
      else if (folder.mode === 'worktree') detail = `worktree · repos/${pathBasename(folder.path)} · ${branchFor(folder)}`;
      else if (isRepo) detail = `${asking ? '' : 'in place · '}on ${folder.git.branch} · ${shortPath(folder.path)}`;
      else detail = `in place · ${shortPath(folder.path)}`;
      row.innerHTML = `<span class="np-folder-icon${folder.mode === 'worktree' ? ' is-worktree' : ''}">${folder.mode === 'worktree' ? PICONS.branch(13) : PICONS.folder(13)}</span>` +
        `<span class="np-folder-name">${escapeHtml(pathBasename(folder.path))}</span>` +
        `<span class="np-folder-path mono" title="${escapeHtml(folder.path)}">${escapeHtml(detail)}</span>`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'np-x';
      remove.title = 'Remove';
      remove.innerHTML = '&times;';
      remove.onclick = () => { folders.splice(folders.indexOf(folder), 1); renderFolders(); renderPreview(); };
      row.appendChild(remove);
      if (asking) {
        // The one decision a repository needs, asked once, where it matters.
        const ask = document.createElement('div');
        ask.className = 'np-ask';
        ask.innerHTML = `<div class="np-ask-q">This is a git repository. How should the project work in it?</div>
          <div class="np-ask-opts">
            <div class="np-ask-opt"><button type="button" class="ws-btn np-ask-btn" data-mode="in-place">As it is</button><div class="np-help">Sessions work in the folder, on whatever is checked out.</div></div>
            <div class="np-ask-opt"><button type="button" class="ws-btn np-ask-btn np-ask-btn--wt" data-mode="worktree">New worktree</button><div class="np-help">A worktree under the project on its branch. Your checkout is untouched.</div></div>
          </div>`;
        ask.querySelectorAll('.np-ask-btn').forEach(btn => { btn.onclick = () => { folder.mode = btn.dataset.mode; renderFolders(); renderPreview(); }; });
        row.appendChild(ask);
      }
      // git worktree add checks out tracked files only, so the repository's
      // .env stays behind. Offer the ones it has; an in-place folder keeps its
      // own and needs nothing.
      if (folder.mode === 'worktree' && folder.envFiles.length) {
        const env = document.createElement('div');
        env.className = 'np-folder-env';
        const toolbar = document.createElement('div');
        toolbar.className = 'np-env-toolbar';
        const title = document.createElement('span');
        title.className = 'np-env-title';
        title.textContent = 'Environment files';
        const count = document.createElement('span');
        count.className = 'np-env-count';
        count.setAttribute('aria-live', 'polite');
        const actions = document.createElement('div');
        actions.className = 'np-env-actions';
        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'np-link';
        all.textContent = 'Select all';
        const none = document.createElement('button');
        none.type = 'button';
        none.className = 'np-link';
        none.textContent = 'Select none';
        actions.append(all, none);
        toolbar.append(title, count, actions);
        const help = document.createElement('div');
        help.className = 'np-env-help';
        help.textContent = 'Copy selected files into the new worktree. Existing files are kept.';
        const boxes = document.createElement('div');
        boxes.className = 'np-env-files';
        boxes.setAttribute('role', 'group');
        boxes.setAttribute('aria-label', `Environment files for ${pathBasename(folder.path)}`);
        const inputs = [];
        const updateSelection = () => {
          const selected = folder.envFiles.filter(name => folder.copyEnv.has(name)).length;
          count.textContent = `${selected} of ${folder.envFiles.length} selected`;
          all.disabled = selected === folder.envFiles.length;
          none.disabled = selected === 0;
        };
        const selectFiles = selected => {
          folder.copyEnv = new Set(selected ? folder.envFiles : []);
          for (const input of inputs) input.checked = selected;
          updateSelection();
          renderPreview();
        };
        all.onclick = () => selectFiles(true);
        none.onclick = () => selectFiles(false);
        for (const name of folder.envFiles) {
          const label = document.createElement('label');
          label.className = 'ws-check np-env-file';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = folder.copyEnv.has(name);
          box.onchange = () => {
            if (box.checked) folder.copyEnv.add(name); else folder.copyEnv.delete(name);
            updateSelection();
            renderPreview();
          };
          inputs.push(box);
          label.appendChild(box);
          label.appendChild(Object.assign(document.createElement('span'), { className: 'mono', textContent: name }));
          boxes.appendChild(label);
        }
        updateSelection();
        env.append(toolbar, help, boxes);
        row.appendChild(env);
      }
      if (folder.mode === 'worktree' && !sharedBox.checked) {
        const line = document.createElement('div');
        line.className = 'np-folder-branch';
        line.innerHTML = `${PICONS.branch(11)}<span>branch</span>`;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'np-input mono';
        input.spellcheck = false;
        input.placeholder = slug();
        input.value = folder.branch;
        input.oninput = () => { folder.branch = input.value; renderPreview(); };
        line.appendChild(input);
        row.appendChild(line);
      }
      foldersEl.appendChild(row);
    }
    renderBranchLine();
    const undecided = folders.some(f => f.mode === null && f.git?.git === true);
    createBtn.disabled = undecided;
    createBtn.title = undecided ? 'Choose how to work in each repository first.' : '';
  }

  function renderPreview() {
    const s = slug();
    const worktrees = folders.filter(f => f.mode === 'worktree');
    // A repository still being asked about is left out until it is decided.
    const inPlace = folders.filter(f => f.mode === 'in-place' || (f.mode === null && f.git?.git !== true));
    const tree = [
      `<span class="np-tree-root">${escapeHtml(shortPath(root))}/${escapeHtml(s)}/</span>`,
      `<span class="np-tree-item">CLAUDE.md <em>· the brief, read by every session</em></span>`,
      `<span class="np-tree-item">AGENTS.md <em>· the same brief, for Codex</em></span>`,
      `<span class="np-tree-item">plan.md <em>· todos.md · when a session needs them</em></span>`,
    ];
    if (worktrees.length) {
      tree.push(`<span class="np-tree-item np-tree-dir">repos/</span>`);
      for (const f of worktrees) {
        tree.push(`<span class="np-tree-sub">${PICONS.branch(11)}${escapeHtml(pathBasename(f.path))} <em>· branch ${escapeHtml(branchFor(f))}</em></span>`);
        const env = f.envFiles.filter(name => f.copyEnv.has(name));
        if (env.length) tree.push(`<span class="np-tree-sub np-tree-env"><em>copied in: ${escapeHtml(env.join(', '))}</em></span>`);
      }
    }
    previewEl.innerHTML = `
      <div class="np-preview-title">What you get</div>
      <div class="np-tree mono">${tree.join('')}</div>
      ${inPlace.length ? `<div class="np-preview-sec"><span class="np-preview-label">Also works in place</span>${inPlace.map(f => `<span class="np-preview-row mono" title="${escapeHtml(f.path)}">${PICONS.folder(11)}<span>${escapeHtml(shortPath(f.path))}</span></span>`).join('')}</div>` : ''}
      <div class="np-preview-foot">Sessions start in the project folder and can read every folder listed here.</div>`;
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.style.display = text ? 'block' : 'none';
  }

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  async function addFolder(folderPath) {
    if (!folderPath || folders.some(f => f.path === folderPath)) return;
    const folder = { path: folderPath, mode: null, branch: '', git: null, envFiles: [], copyEnv: new Set() };
    folders.push(folder);
    renderFolders();
    renderPreview();
    // A worktree only gets the repository's tracked files, so ask the folder
    // what .env files it has at the same time as its git state.
    const [git, env] = await Promise.all([
      window.api.getFolderGitStatus(folderPath).catch(() => ({ git: false })),
      window.api.listEnvFiles(folderPath).catch(() => null),
    ]);
    folder.git = git || { git: false };
    folder.envFiles = env?.files || [];
    folder.copyEnv = new Set(env?.defaults || []);
    if (!folder.git?.git && folder.mode === null) folder.mode = 'in-place';
    if (folders.includes(folder)) { renderFolders(); renderPreview(); }
  }

  async function create() {
    const name = nameInput.value.trim();
    if (!name) { showError('Give the project a name.'); nameInput.focus(); return; }
    showError('');
    createBtn.disabled = true;
    createBtn.textContent = hasWorktree() ? 'Creating worktrees…' : 'Creating…';
    let result;
    try {
      result = await window.api.createProject({
        name,
        folders: folders.map(f => ({
          path: f.path,
          mode: f.mode || 'in-place',
          branch: f.mode === 'worktree' && !sharedBox.checked ? f.branch.trim() : '',
          copyEnv: f.mode === 'worktree' ? f.envFiles.filter(name => f.copyEnv.has(name)) : [],
        })),
        sharedBranch: sharedBox.checked,
        branchName: branchInput.value.trim(),
      });
    } catch (err) {
      result = { error: err.message };
    }
    createBtn.disabled = false;
    createBtn.textContent = 'Create project';
    if (!result || result.error) { showError(result?.error || 'Could not create the project.'); return; }
    close();
    projectsUi.selectedProjectId = result.project?.id || null;
    setProjectTab(projectsUi.selectedProjectId, 'overview');
    saveProjectsUi();
    await loadProjects();
    const tab = document.querySelector('.sidebar-tab[data-tab="projects"]');
    if (tab && activeTab !== 'projects') tab.click();
    else showProjectOverview();
    if (result.errors?.length) {
      alert(`Project created, but some worktrees could not be made:\n\n${result.errors.join('\n')}\n\nAttach them again from the project settings.`);
    }
  }

  q('#np-add-folder').onclick = async () => addFolder(await window.api.browseFolder());
  q('.add-project-cancel-btn').onclick = close;
  createBtn.onclick = create;
  nameInput.addEventListener('input', () => { renderBranchLine(); renderPreview(); });
  branchInput.addEventListener('input', () => { renderBranchLine(); renderPreview(); });
  sharedBox.addEventListener('change', () => { renderFolders(); renderPreview(); });

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (document.activeElement === nameInput || document.activeElement === branchInput)) create();
  }
  document.addEventListener('keydown', onKey);

  renderFolders();
  renderPreview();
  for (const folder of folders) {
    Promise.all([
      window.api.getFolderGitStatus(folder.path).catch(() => ({ git: false })),
      window.api.listEnvFiles(folder.path).catch(() => null),
    ]).then(([git, env]) => {
      folder.git = git || { git: false };
      folder.envFiles = env?.files || [];
      folder.copyEnv = new Set(env?.defaults || []);
      if (!folder.git?.git && folder.mode === null) folder.mode = 'in-place';
      renderFolders(); renderPreview();
    }).catch(() => {});
  }
  nameInput.focus();
}
