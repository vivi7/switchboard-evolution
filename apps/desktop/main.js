const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, powerSaveBlocker, protocol, safeStorage, screen, session: electronSession, shell, ShareMenu, webContents } = require('electron');
// `--help` and `--version` answer and exit here, before anything below runs (cli-flags.js).
require('./cli-flags').answerCliFlags(process.argv, app);
// Capture every IPC handler as it is registered, so the remote-access server
// can call the same functions. Must run before the first registration below.
require('./ipc-registry').install(ipcMain);
const { addSink, emit } = require('./broadcast');
const { getHandler } = require('./ipc-registry');
const nacl = require('tweetnacl');
const qrcode = require('qrcode-generator');
const { createRemoteProtocol } = require('./remote-protocol');
const { createRemoteAuth } = require('./remote-auth');
const { createRemoteApi } = require('./remote-api');
const { createRemoteServer, reachableAddresses, pairingLink } = require('./remote-server');
const webPage = require('./web-page');
const { createRemoteTunnels } = require('./remote-tunnels');
const { sessionStates } = require('./session-states');
const { subagentsDirFor, subagentsRunning } = require('./subagent-activity');
const { readViewerEntriesSince } = require('./transcript-reader');
const { createPromptImprover } = require('./prompt-improver');
const { createPromptImproverWindows } = require('./prompt-improver-windows');
const PromptImproverModel = require('./public/prompt-improver-model');
const { markBusy, markIdle, applyStatusReport, takeStatusRecords } = require('./cli-state');
const { createTerminalFanout } = require('./terminal-fanout');
const { createSessionLauncher } = require('./remote-launch');
const { createSessionNotices } = require('./session-notices');
const { listFolders, createFolder, createPhoneFiles } = require('./remote-files');
const { planLineText } = require('./remote-plan');
const { createRemoteTasks } = require('./remote-tasks');
const { createAttachments } = require('./remote-attachments');
const { keepWindowOnClose, showWindow, createPowerSaveGuard } = require('./window-lifecycle');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const log = require('electron-log');
// getFolderIndexMtimeMs moved to session-cache.js
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, listPendingDiffs, rekeyMcpServer, cleanStaleLockFiles } = require('./mcp-bridge');
const { fetchAndTransformUsage } = require('./claude-auth');
const { runStatsCommand, refreshStatsCache } = require('./stats-refresh');
const { readHead } = require('./jsonl-scan');
const codexAuth = require('./codex-auth');
const { copyOldUserData } = require('./user-data-migration');
const { describeOpenWindows, windowsToRestore } = require('./window-restore');

// SWITCHBOARD_DATA_DIR isolates a dev/test instance from the installed app:
// db.js puts switchboard.db under it, and pointing userData there gives the
// instance its own single-instance lock (requestSingleInstanceLock keys on
// userData), so both can run side by side.
if (process.env.SWITCHBOARD_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.SWITCHBOARD_DATA_DIR, 'electron'));
} else if (app.isPackaged && app.name === 'Switchboard Evolution') {
  // Switchboard Evolution was called OmniboardV: its first start takes the old
  // app's settings (user-data-migration.js).
  try {
    copyOldUserData(app.getPath('userData'), [path.join(app.getPath('appData'), 'OmniboardV')], log);
  } catch (err) {
    log.warn(`[startup] could not copy the settings of OmniboardV: ${err.message}`);
  }
}

log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

try { require('electron-reloader')(module, { watchRenderer: true }); } catch {};

// Clean env for child processes — strips Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction, and pins a UTF-8
// LC_CTYPE when the launch environment has no locale. See pty-env.js.
const { buildPtyEnv } = require('./pty-env');
const cleanPtyEnv = buildPtyEnv(process.env);

// Sessions can run in herdr-core (hc-engine.js), which keeps them alive when
// Switchboard quits; with no hc, or with it turned off, they run here in node-pty.
const { createHcEngine, locateHc, hcSessionName } = require('./hc-engine');
let hcEngine = null;
let terminalEngineStatus = { engine: 'inside', reason: 'starting' };
// Handlers that list or start sessions wait until the ones hc kept are found again.
let sessionsReady = Promise.resolve();
const { shouldStartFresh, shouldBlockArchivedSession } = require('./session-launch');
const { createTerminalActivity } = require('./terminal-activity');

// Shell profiles → shell-profiles.js
const { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, quoteArgvForShell, envSourcePrefix } = require('./shell-profiles');
const { scanSchedules } = require('./schedule-runner');
const shellEnv = require('./shell-env');
const { encodeProjectPath } = require('./encode-project-path');
const { resolveEffectiveSettings } = require('./resolve-effective-settings');
const { listProjectDirectory, readProjectFile, readPreviewFile, openFileExternally, resolveProjectEntry, isViewableFile, previewType } = require('./project-files');
const openedFiles = require('./opened-files');
const { manageProjectEntry, trashProjectEntries, revealFile, shareFile, createProjectEntry, duplicateProjectEntry, pasteProjectEntry } = require('./file-management');
const FileSelection = require('./public/file-selection');
const { createDraftStore } = require('./file-drafts');
const fileTimeline = require('./file-timeline');
const projectSearch = require('./project-search');
const { readPlans, linkPlans, projectResolver } = require('./plans-source');
const { resolveTerminalFiles } = require('./terminal-file-links');
const { createCommandCatalog } = require('./command-catalog');
const { createDocsRefresher } = require('./command-docs-refresh');
const { scanClaudeLocal } = require('./claude-local-commands');
const { scanCodexLocal } = require('./codex-local-commands');
const { scanOpencodeLocal } = require('./opencode-local-commands');
const sessionVersion = require('./session-version');
const { PREVIEW_SCHEME, PREVIEW_SCHEMES, handlePreviewAssetRequest } = require('./preview-assets');
protocol.registerSchemesAsPrivileged(PREVIEW_SCHEMES);
const { createTaskManager } = require('./task-manager');
const { createProcessMonitor } = require('./process-monitor');
const { lastAssistantMessage } = require('./session-preview');


// --- Auto-updater (only in packaged builds that ship an update feed) ---
// A local build made with publish disabled has no app-update.yml, so it skips
// the updater instead of failing every check.
let autoUpdater = null;
if ((app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) || process.env.FORCE_UPDATER) {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  function sendUpdaterEvent(type, data) {
    log.info(`[updater] ${type}`, data || '');
    emit('updater-event', type, data);
  }
  autoUpdater.on('checking-for-update', () => sendUpdaterEvent('checking'));
  autoUpdater.on('update-available', (info) => sendUpdaterEvent('update-available', info));
  autoUpdater.on('update-not-available', (info) => sendUpdaterEvent('update-not-available', info));
  autoUpdater.on('download-progress', (progress) => sendUpdaterEvent('download-progress', progress));
  autoUpdater.on('update-downloaded', (info) => sendUpdaterEvent('update-downloaded', info));
  autoUpdater.on('error', (err) => {
    log.error('[updater] Error:', err?.message || String(err));
    emit('updater-event', 'error', { message: err?.message || String(err) });
  });
}
const {
  getMeta, getAllMeta, toggleStar, setPinnedOrder, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedSession, upsertCachedSessions,
  updateCachedAiTitle,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  copySessionAssignment, moveSessionAssignment, rekeyPlanLinks,
  closeDb,
} = require('./db');
const dbModule = require('./db');

const { createSettingsPatcher, keepOneHarnessOn } = require('./settings-patch');
const SettingsModel = require('./public/settings-model');
const { getHarness, DEFAULT_HARNESS, transcriptPath, availableHarnesses, allHarnesses, progressBusyState,
        harnessForFolder: getHarnessForFolder } = require('./harnesses');
const claudeHarness = getHarness(DEFAULT_HARNESS);
const PROJECTS_DIR = claudeHarness.sessionsRoot();
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const MAX_BUFFER_SIZE = 256 * 1024;

// Active PTY sessions
const activeSessions = new Map();
let mainWindow = null;
// The desktop window receives every event; see broadcast.js.
addSink((channel, args) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
});
let appIsQuitting = false;

function createWindow() {
  // Restore saved window bounds
  const savedBounds = getSetting('global')?.windowBounds;
  let bounds = { width: 1400, height: 900 };

  let restorePosition = null;
  if (savedBounds && savedBounds.width && savedBounds.height) {
    bounds.width = savedBounds.width;
    bounds.height = savedBounds.height;

    // Only restore position if it's on a visible display
    if (savedBounds.x != null && savedBounds.y != null) {
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const b = d.bounds;
        return savedBounds.x >= b.x - 100 && savedBounds.x < b.x + b.width &&
               savedBounds.y >= b.y - 100 && savedBounds.y < b.y + b.height;
      });
      if (onScreen) {
        restorePosition = { x: savedBounds.x, y: savedBounds.y };
      }
    }
  }

  // A build with a name of its own (Switchboard Evolution) shows that name as the window
  // title too; a dev run is called "switchboard" (package.json) and keeps
  // the usual title.
  const windowTitle = app.name && app.name !== 'switchboard' ? app.name : 'Switchboard';
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: windowTitle,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      // A pull request's page on GitHub, in a panel (web-page.js checks every one).
      webviewTag: true,
    },
  });
  // index.html's <title> would rename the window back to "Switchboard".
  if (windowTitle !== 'Switchboard') mainWindow.on('page-title-updated', (event) => event.preventDefault());

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    mainWindow.setBounds({ ...restorePosition, width: bounds.width, height: bounds.height });
  }

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  // The windows of their own that were open when it closed come back once
  // the main window is there.
  mainWindow.webContents.once('did-finish-load', restoreOpenWindows);

  // Open external links in the system browser instead of a child BrowserWindow
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  // Override window.open so xterm WebLinksAddon's default handler (which does
  // window.open() then sets location.href) routes through our IPC instead of
  // creating a child BrowserWindow.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      window.open = function(url) {
        if (url && /^https?:\\/\\//i.test(url)) { window.api.openExternal(url); return null; }
        const proxy = {};
        Object.defineProperty(proxy, 'location', { get() {
          const loc = {};
          Object.defineProperty(loc, 'href', {
            set(u) { if (/^https?:\\/\\//i.test(u)) window.api.openExternal(u); }
          });
          return loc;
        }});
        return proxy;
      };
      void 0;
    `);
  });

  // Prevent Cmd+R / Ctrl+Shift+R from reloading the page (Chromium built-in).
  // Ctrl+R alone on macOS is NOT a reload shortcut and must pass through to xterm
  // for reverse-i-search.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r' && input.meta) event.preventDefault();
    if (key === 'r' && input.control && input.shift) event.preventDefault();
  });

  // Save window bounds on move/resize (debounced)
  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Also save immediately before close (debounce may not have flushed)
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }
  });
  // With remote access on, closing on macOS only hides the window.
  keepWindowOnClose(mainWindow, {
    platform: process.platform,
    keepAlive: () => remoteServer.status().running,
    isQuitting: () => appIsQuitting,
    onVisibility: (visible) => emit('window-visibility', visible),
  });

  mainWindow.on('closed', () => {
    // On macOS the app stays alive in the dock after the last window closes.
    // Kill all running PTY processes so orphaned `claude` processes don't
    // accumulate in the background with no way for the user to interact.
    // Sessions in herdr-core are meant to outlive the window: they keep
    // running and stay attached, and the next window picks them up.
    for (const [id, session] of activeSessions) {
      if (session.pty?.detach) continue;
      if (!session.exited) {
        try { session.pty.kill(); } catch {}
      }
      activeSessions.delete(id);
    }
    taskManager.shutdown();
    // They close with the main window, and open again with the next one.
    freezeOpenWindows();
    for (const win of [...toolWindows.values(), ...projectWindows.values(), ...compareWindows, ...fileWindows, ...viewerFileWindows, ...webWindows.keys(), ...commandsWindows.values()]) if (!win.isDestroyed()) win.close();
    mainWindow = null;
  });
}

/** The explicit way out for sessions that would otherwise outlive Switchboard in herdr-core. */
async function quitStoppingSessions() {
  const running = [...new Set(activeSessions.values())].filter(s => !s.exited);
  if (running.length) {
    const { response } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      type: 'warning',
      buttons: ['Stop All and Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Stop ${running.length} running session${running.length === 1 ? '' : 's'} and quit?`,
      detail: hcEngine ? 'A plain Quit leaves them running in herdr-core, to pick up on the next start.' : 'Quitting stops them either way.',
    });
    if (response !== 0) return;
    const stops = running.map(session => {
      session.stopRequested = true;
      try { return session.pty.kill(); } catch { return null; }
    });
    // hc ends them on its side; wait for the requests to go out before the connection closes.
    await Promise.race([Promise.allSettled(stops), new Promise(r => setTimeout(r, 3000))]);
  }
  app.quit();
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit and Stop All Sessions…', click: () => { quitStoppingSessions(); } },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Session cache helpers ---

const { deriveProjectPath } = claudeHarness;

// Session cache → session-cache.js
const sessionCache = require('./session-cache');
const { SessionIndexer } = require('./session-indexer');
const sessionIndexer = new SessionIndexer({
  projectsDir: PROJECTS_DIR,
  onStatus: (text, type) => sessionCache.sendStatus(text, type),
  onChanged: () => sessionCache.notifyRendererProjectsChanged('sessions'),
  onError: err => log.error('[indexer]', err),
});
sessionCache.init({
  indexer: sessionIndexer,
  PROJECTS_DIR,
  activeSessions,
  log,
  db: {
    deleteCachedFolder, getCachedByFolder, getCachedSession, upsertCachedSessions, deleteCachedSession,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, setSetting, getMeta, setName,
    updateCachedAiTitle, updateSearchTitle,
  },
});
const { refreshFolder, reconcileCacheFromFilesystem, buildProjectsFromCache,
        notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker,
        refreshHarnessTitles, initializeHiddenProjectTimestamps } = sessionCache;

// --- Projects (a piece of work with a folder on disk) ---
const projects = require('./projects');
projects.init({
  db: dbModule,
  log,
  buildProjectsFromCache,
  notifyRendererProjectsChanged,
  isHarnessId: (id) => allHarnesses().some(h => h.id === id),
  plansDir: PLANS_DIR,
});
// --- Git Graph tab: service + SSRF-safe avatar cache ---
const gitGraphService = require('./git-graph-service');
const gitGraphAvatars = require('./git-graph-avatars');
// What of the Git Graph a paired phone may use.
require('./remote-git-graph');
// What of the Worktrees tab a paired phone may use.
require('./remote-worktrees');
require('./remote-knowledge');
// The prompt improver and its settings, for a paired phone.
require('./remote-prompt-improver');
// The global settings and CBM's settings, for a paired phone.
require('./remote-settings');
// What of the Pull Requests tab a paired phone may use.
require('./remote-pull-requests');
// What of the Actions view a paired phone may use (not the downloads).
require('./remote-actions');
// What of the Task Manager a paired phone may use.
const { isOwner: isProcessOwner } = require('./remote-process-usage');
// Mirrors db.js's own DATA_DIR resolution (SWITCHBOARD_DATA_DIR override,
// else ~/.switchboard) without depending on db.js's internals.
const GIT_GRAPH_DATA_DIR = process.env.SWITCHBOARD_DATA_DIR
  ? path.resolve(process.env.SWITCHBOARD_DATA_DIR)
  : path.join(os.homedir(), '.switchboard');
gitGraphAvatars.init({
  dataDir: path.join(GIT_GRAPH_DATA_DIR, 'git-graph-avatars'),
  log,
});
gitGraphService.init({ db: dbModule, log, send: emit });
require('./pull-requests').init({ log });

// An upgrade can change the working rules in the brief. Bring every project's
// managed blocks up to date once at startup; unchanged files are not written.
projects.syncAllProjectBriefs().catch(err => log.error('[projects] brief sync failed:', err?.message || String(err)));
// Watch every project's plan-tracker.md and todos.md so a tick made by a
// session is credited to it and the page refreshes.
projects.initPlanWatch({ activeSessions, send: emit });

// --- IPC: browse-folder ---
ipcMain.handle('browse-folder', async (event) => {
  // On the window that asked: a project's Settings can be in a window of its own.
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) || mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// --- IPC: add-project ---
ipcMain.handle('add-project', async (_event, projectPath) => {
  try {
    // Validate the path exists and is a directory
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Unhide if previously hidden
    const global = getSetting('global') || {};
    if (global.hiddenProjects && global.hiddenProjects.includes(projectPath)) {
      global.hiddenProjects = global.hiddenProjects.filter(p => p !== projectPath);
      if (global.hiddenProjectTimestamps) {
        delete global.hiddenProjectTimestamps[projectPath];
      }
      setSetting('global', global);
    }

    // Create the corresponding folder in ~/.claude/projects/ so it persists
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Seed a minimal .jsonl so deriveProjectPath can read the cwd
    if (!fs.readdirSync(folderPath).some(f => f.endsWith('.jsonl'))) {
      const seedId = require('crypto').randomUUID();
      const seedFile = path.join(folderPath, seedId + '.jsonl');
      const now = new Date().toISOString();
      const line = JSON.stringify({ type: 'user', cwd: projectPath, sessionId: seedId, uuid: require('crypto').randomUUID(), timestamp: now, message: { role: 'user', content: 'New project' } });
      fs.writeFileSync(seedFile, line + '\n');
    }

    // Immediately index the new folder so it's in cache before frontend renders
    await refreshFolder(folder);
    notifyRendererProjectsChanged();

    return { ok: true, folder, projectPath };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remove-project ---
ipcMain.handle('remove-project', (_event, projectPath) => {
  try {
    // Add to hidden projects list
    const global = getSetting('global') || {};
    const hidden = global.hiddenProjects || [];
    if (!hidden.includes(projectPath)) hidden.push(projectPath);
    global.hiddenProjects = hidden;
    global.hiddenProjectTimestamps = {
      ...(global.hiddenProjectTimestamps || {}),
      [projectPath]: Date.now(),
    };
    setSetting('global', global);

    // Clean up DB cache and search index for this folder
    const folder = encodeProjectPath(projectPath);
    deleteCachedFolder(folder);
    deleteSearchFolder(folder);
    deleteSetting('project:' + projectPath);

    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: projects ---
// Every mutating handler notifies the renderer itself (projects.js), so both
// the Sessions and the Projects tab refresh from one event.
// --- Claude Code's trust in the attached folders (claude-trust.js) ---
// Attaching a folder to a project is the user's consent to Claude Code working
// there, so it is recorded once instead of Claude asking in every session.
const claudeTrust = require('./claude-trust');

function projectFolderPaths(projectId) {
  try { return dbModule.listProjectFolders(projectId).map(f => f.path); } catch { return []; }
}

function trustFolders(folders) {
  const list = [...new Set((folders || []).filter(Boolean))];
  if (!list.length) return;
  claudeTrust.recordTrust(list).then((result) => {
    if (result.error) log.warn(`[trust] could not record Claude Code's trust: ${result.error}`);
    else if (result.keys.length) log.info(`[trust] Claude Code now trusts ${result.keys.join(', ')}`);
  });
}

/** Wrap a handler taking a project id first: trust the folders it added to that project. */
function trustingNewFolders(fn) {
  return async (id, ...args) => {
    const before = new Set(projectFolderPaths(id));
    const result = await fn(id, ...args);
    if (!result?.error) trustFolders(projectFolderPaths(id).filter(p => !before.has(p)));
    return result;
  };
}

// One question at a time: two sessions started together share the answer.
let folderTrustQueue = Promise.resolve();

/**
 * Before a session with attached folders Claude Code does not trust yet, ask
 * once whether to trust them. Never blocks the launch on an error.
 */
function confirmFolderTrust(win, dirs) {
  const run = folderTrustQueue.then(async () => {
    const untrusted = await claudeTrust.untrustedFolders(dirs);
    if (!untrusted.length) return;
    const shown = untrusted.slice(0, 8).map(d => `• ${d}`);
    if (untrusted.length > shown.length) shown.push(`+ ${untrusted.length - shown.length} more`);
    const options = {
      type: 'question',
      buttons: ['Trust and Start', 'Start Without Trusting'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: untrusted.length === 1
        ? 'Trust this attached folder for Claude Code?'
        : `Trust these ${untrusted.length} attached folders for Claude Code?`,
      detail: `${shown.join('\n')}\n\nClaude Code asks about attached folders it does not trust in every new session. Trusting them here records the answer once, as starting Claude Code in each folder and trusting it would, and the session starts without asking.`,
    };
    const { response } = win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (response !== 0) return;
    const result = await claudeTrust.recordTrust(untrusted);
    if (result.error) log.warn(`[trust] could not record Claude Code's trust: ${result.error}`);
  }).catch((err) => log.warn('[trust] check failed', err));
  folderTrustQueue = run;
  return run;
}

function guarded(fn) {
  return async (_event, ...args) => {
    try { return await fn(...args); } catch (err) {
      log.error('[projects]', err);
      return { error: err.message };
    }
  };
}

/** guarded, for a handler that needs the window that asked (a dialog's parent). */
function guardedEvent(fn) {
  return async (event, ...args) => {
    try { return await fn(event, ...args); } catch (err) {
      log.error('[projects]', err);
      return { error: err.message };
    }
  };
}
ipcMain.handle('get-project-tree', guarded((showArchived) => {
  // Mirrors get-projects: until the cache is populated there is nothing to
  // file, and the renderer is told via projects-changed once there is.
  if (!isCachePopulated() || !isSearchIndexPopulated()) return { projects: [] };
  return projects.buildProjectTree(!!showArchived);
}));
ipcMain.handle('create-project', guarded(async (spec) => {
  const result = await projects.createProject(spec || {});
  const id = result?.project?.id;
  if (id) {
    const row = dbModule.getProject(id);
    trustFolders([row?.root, ...projectFolderPaths(id)]);
  }
  return result;
}));
ipcMain.handle('update-project', guarded((id, patch) => projects.updateProject(id, patch || {})));
// The Starred section in the order it was dragged into (pinned-order.js).
ipcMain.handle('set-starred-order', guarded((ids) => projects.setStarredOrder(ids)));
ipcMain.handle('delete-project', guarded((id) => projects.deleteProject(id)));
ipcMain.handle('attach-project-folder', guarded(trustingNewFolders((id, spec) => projects.attachFolder(id, spec || {}))));
ipcMain.handle('detach-project-folder', guarded((id, folderPath, opts) => projects.detachFolder(id, folderPath, opts || {})));
ipcMain.handle('set-session-assignment', guarded((sessionId, projectId, trackId) => {
  const cleanProjectId = projectId || null;
  const cleanTrackId = trackId || null;
  const result = projects.assignSession(sessionId, cleanProjectId, cleanTrackId);
  // Raw terminals have no transcript to rehydrate this relationship from.
  // Keep the live PTY metadata aligned with the durable renderer descriptor so
  // a renderer reload cannot put a moved terminal back in its old location.
  if (!result?.error) {
    const session = activeSessions.get(sessionId);
    if (session?.isPlainTerminal) {
      session.projectId = cleanProjectId;
      session.trackId = cleanProjectId ? cleanTrackId : null;
    }
  }
  return result;
}));
// Scheduled tasks. The tick that fires them is startScheduleTicker below.
ipcMain.handle('list-schedules', guarded(() => projects.listSchedules()));
ipcMain.handle('create-schedule', guarded((spec) => projects.createSchedule(spec || {})));
ipcMain.handle('update-schedule', guarded((id, patch) => projects.updateSchedule(id, patch || {})));
ipcMain.handle('delete-schedule', guarded((id) => projects.deleteSchedule(id)));
ipcMain.handle('resolve-schedule-launch', guarded((id) => projects.resolveScheduleLaunch(id)));
ipcMain.handle('get-schedule-context', guarded((spec) => projects.resolveScheduleContext(spec || {})));
ipcMain.handle('create-track', guarded((projectId, spec) => projects.createTrack(projectId, spec || {})));
ipcMain.handle('update-track', guarded((id, patch) => projects.updateTrack(id, patch || {})));
ipcMain.handle('delete-track', guarded((id, options = {}) => {
  const track = dbModule.getTrack(id);
  if (!track) return { error: 'Track not found' };
  const archiveSessions = options.archiveSessions === true;
  // Raw terminals have no transcript row, but participate in track deletion.
  for (const [sid, session] of activeSessions) {
    if (session.trackId === id && session.isPlainTerminal) dbModule.setSessionAssignment(sid, track.projectId, id);
  }
  const result = projects.deleteTrack(id, { archiveSessions });
  if (result.error) return result;
  const affected = new Set(result.sessionIds);
  for (const [sid, session] of activeSessions) {
    if (session.trackId !== id && !affected.has(sid)) continue;
    session.trackId = null;
    session.formerTrackName = track.name;
    if (archiveSessions && !session.exited) {
      session.stopRequested = true;
      try { session.pty.kill(); } catch (error) { log.error('[delete-track] stop failed', error); }
    }
  }
  return result;
}));
ipcMain.handle('get-projects-root', guarded(() => projects.projectsRoot()));
ipcMain.handle('get-project-git-status', guarded((id, opts) => projects.folderGitStatus(id, opts || {})));
ipcMain.handle('get-project-git-info', guarded((id) => projects.projectGitInfo(id)));
ipcMain.handle('get-project-git-diff', guarded((id, folderPath, filePath, side) => projects.projectGitDiff(id, folderPath, filePath, side)));
ipcMain.handle('stage-project-git-files', guarded((id, folderPath, paths, stage) => projects.stageProjectGitFiles(id, String(folderPath || ''), paths ?? null, !!stage)));
ipcMain.handle('stage-project-git-lines', guarded((id, folderPath, filePath, side, diffId, lines) => projects.stageProjectGitLines(id, String(folderPath || ''), filePath, side, String(diffId || ''), Array.isArray(lines) ? lines : [])));
// Untracked files go to the Trash; the window and the phone ask before calling.
ipcMain.handle('discard-project-git-files', guarded((id, folderPath, paths) => projects.discardProjectGitFiles(id, String(folderPath || ''), paths ?? null, { trash: (filePath) => shell.trashItem(filePath) })));
ipcMain.handle('ignore-project-git-paths', guarded((id, folderPath, paths, untrack) => projects.ignoreProjectGitPaths(id, String(folderPath || ''), Array.isArray(paths) ? paths : [], !!untrack)));
ipcMain.handle('read-project-git-edit-file', guarded((id, folderPath, filePath) => projects.readProjectGitEditFile(id, String(folderPath || ''), String(filePath || ''))));
ipcMain.handle('save-project-git-edit-file', guarded((id, folderPath, filePath, content, version) => projects.saveProjectGitEditFile(id, String(folderPath || ''), String(filePath || ''), content, version)));
ipcMain.handle('get-folder-git-status', guarded((folderPath) => projects.folderGitInfo(String(folderPath || ''))));

// --- IPC: Git Graph tab ---
// Every handler delegates one line into projects.js, same shape as the four
// git handlers above; projects.js re-checks the attached-folder boundary.
ipcMain.handle('get-project-git-graph', guarded((id, folderPath, opts) => projects.projectGitGraph(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-git-graph-commit-detail', guarded((id, folderPath, hash) => projects.projectGitGraphCommitDetail(id, String(folderPath || ''), hash)));
ipcMain.handle('get-git-graph-compare-detail', guarded((id, folderPath, fromHash, toHash) => projects.projectGitGraphCompareDetail(id, String(folderPath || ''), fromHash, toHash)));
ipcMain.handle('get-git-graph-file-at-revision', guarded((id, folderPath, rev, filePath) => projects.projectGitGraphFileAtRevision(id, String(folderPath || ''), rev, filePath)));
ipcMain.handle('get-git-graph-file-diff-between', guarded((id, folderPath, fromRev, toRevOrNull, filePath) => projects.projectGitGraphFileDiffBetween(id, String(folderPath || ''), fromRev, toRevOrNull, filePath)));
ipcMain.handle('get-git-graph-repo-config', guarded((id, folderPath) => projects.projectGitGraphRepoConfig(id, String(folderPath || ''))));
ipcMain.handle('set-git-graph-repo-config', guarded((id, folderPath, patch) => projects.setProjectGitGraphRepoConfig(id, String(folderPath || ''), patch || {})));
ipcMain.handle('trust-git-graph-repo-config', guarded((id, folderPath, trusted) => projects.trustProjectGitGraphRepoConfig(id, String(folderPath || ''), !!trusted)));
// avatarsSelfHostedGitLabHost sends this repo's commit-author email
// addresses to whatever host it names, so — unlike every other repo setting,
// which round-trips through the generic set-git-graph-repo-config channel —
// it is only ever written after a real dialog, shown by this process and
// naming the exact host, that the renderer cannot fake or skip.
ipcMain.handle('confirm-git-graph-avatars-gitlab-host', guarded(async (id, folderPath, host) => {
  if (host !== null && typeof host === 'string' && host.trim()) {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Cancel', 'Confirm'],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirm Self-Hosted GitLab Host',
      message: `Send this repository's commit author email addresses to "${host}" for avatar lookup?`,
      detail: 'Only confirm this for a self-hosted GitLab instance you trust — every avatar lookup for this repository will contact this host from now on.',
    });
    if (choice.response !== 1) return { cancelled: true };
  }
  return projects.setProjectGitGraphAvatarsSelfHostedGitLabHost(id, String(folderPath || ''), host || null);
}));
ipcMain.handle('export-git-graph-repo-config', guarded((id, folderPath) => projects.exportProjectGitGraphRepoConfig(id, String(folderPath || ''))));
ipcMain.handle('get-git-graph-user-details', guarded((id, folderPath) => projects.projectGitGraphUserDetails(id, String(folderPath || ''))));
ipcMain.handle('get-git-graph-global-preferences', guarded(() => gitGraphService.getGitGraphGlobalPreferences()));
ipcMain.handle('set-git-graph-global-preferences', guarded((patch) => gitGraphService.setGitGraphGlobalPreferences(patch || {})));
ipcMain.handle('get-git-graph-remotes', guarded((id, folderPath) => projects.projectGitGraphRemotes(id, String(folderPath || ''))));
ipcMain.handle('get-git-graph-tag-details', guarded((id, folderPath, tagName) => projects.projectGitGraphTagDetails(id, String(folderPath || ''), tagName)));
ipcMain.handle('get-git-graph-avatar-url', guarded((id, folderPath, email) => projects.projectGitGraphAvatarUrl(id, String(folderPath || ''), email)));
ipcMain.handle('clear-git-graph-avatar-cache', guarded(() => gitGraphAvatars.clearCache()));
// The single generic whitelisted-action dispatcher — actionId is
// looked up in git-actions.js's ACTIONS table, never a dynamic property/
// function-name lookup off the renderer's string.
ipcMain.handle('run-git-graph-action', guarded((id, folderPath, actionId, params) => projects.runProjectGitGraphAction(id, String(folderPath || ''), String(actionId || ''), params || {})));
ipcMain.handle('cancel-git-graph-action', guarded((id, folderPath, actionId) => projects.cancelProjectGitGraphAction(id, String(folderPath || ''), String(actionId || ''))));
// Create Archive's destination is never taken from the renderer: this shows
// the real native Save dialog itself and only ever hands createArchive the
// path *it* returned, the same way any other "Save As" in the app works —
// the renderer only supplies the ref being archived and a suggested filename.
ipcMain.handle('save-git-graph-archive', guarded(async (id, folderPath, opts = {}) => {
  const suggestedName = String(opts.suggestedName || 'archive').replace(/[\\/]/g, '-');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Create Archive',
    defaultPath: `${suggestedName}.zip`,
    filters: [
      { name: 'Zip Archive', extensions: ['zip'] },
      { name: 'Tar Archive', extensions: ['tar'] },
    ],
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  const format = path.extname(result.filePath).toLowerCase() === '.tar' ? 'tar' : 'zip';
  return projects.runProjectGitGraphAction(id, String(folderPath || ''), 'createArchive', {
    ref: opts.ref, refType: opts.refType, remote: opts.remote, format, absPath: result.filePath,
  });
}));
// --- IPC: Pull Requests tab (pull-requests.js, through the GitHub CLI) ---
ipcMain.handle('get-pull-requests', guarded((id, folderPath, opts) => projects.projectPullRequests(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-pull-requests-page', guarded((id, folderPath, opts) => projects.projectPullRequestsPage(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-pull-request-files', guarded((id, folderPath, opts) => projects.projectPullRequestFiles(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-pull-request-file-diff', guarded((id, folderPath, opts) => projects.projectPullRequestFileDiff(id, String(folderPath || ''), opts || {})));
ipcMain.handle('run-pull-request-action', guarded((id, folderPath, params) => projects.runProjectPullRequestAction(id, String(folderPath || ''), params || {})));
// What an open pull request shows: its conversation, commits, checks and viewed files, and what its editors need.
ipcMain.handle('get-pull-request-conversation', guarded((id, folderPath, opts) => projects.projectPullRequestConversation(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-pull-request-commits', guarded((id, folderPath, opts) => projects.projectPullRequestCommits(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-pull-request-commit-files', guarded((id, folderPath, opts) => projects.projectPullRequestCommitFiles(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-pull-request-checks', guarded((id, folderPath, opts) => projects.projectPullRequestChecks(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-pull-request-job-log', guarded((id, folderPath, opts) => projects.projectPullRequestJobLog(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-pull-request-viewed', guarded((id, folderPath, opts) => projects.projectPullRequestViewed(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-pull-request-branches', guarded((id, folderPath, opts) => projects.projectPullRequestBranches(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-pull-request-candidates', guarded((id, folderPath, opts) => projects.projectPullRequestCandidates(id, String(folderPath || ''), opts || {})));
ipcMain.handle('render-pull-request-markdown', guarded((id, folderPath, opts) => projects.renderProjectPullRequestMarkdown(id, String(folderPath || ''), opts || {})));
// What the list's search looks through (pull-request-search.js).
ipcMain.handle('get-pull-request-texts', guarded((id, folderPath, opts) => projects.projectPullRequestTexts(id, String(folderPath || ''), opts || {})));
// Every other change to a pull request (pull-request-edits.js).
ipcMain.handle('edit-pull-request', guarded((id, folderPath, params) => projects.editProjectPullRequest(id, String(folderPath || ''), params || {})));
// --- IPC: Actions tab (actions.js, through the GitHub CLI) ---
ipcMain.handle('get-actions-workflows', guarded((id, folderPath, opts) => projects.projectActionsWorkflows(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-actions-runs', guarded((id, folderPath, opts) => projects.projectActionsRuns(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-actions-run', guarded((id, folderPath, opts) => projects.projectActionsRun(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-actions-job', guarded((id, folderPath, opts) => projects.projectActionsJob(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-actions-step-log', guarded((id, folderPath, opts) => projects.projectActionsStepLog(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-actions-job-log', guarded((id, folderPath, opts) => projects.projectActionsJobLog(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-actions-workflow-file', guarded((id, folderPath, opts) => projects.projectActionsWorkflowFile(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-actions-dispatch-form', guarded((id, folderPath, opts) => projects.projectActionsDispatchForm(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-actions-refs', guarded((id, folderPath, opts) => projects.projectActionsRefs(id, String(folderPath || ''), opts || {})));
// Management: caches, the repository's self-hosted runners, deployments.
ipcMain.handle('get-actions-caches', guarded((id, folderPath, opts) => projects.projectActionsCaches(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-actions-runners', guarded((id, folderPath, opts) => projects.projectActionsRunners(id, String(folderPath || ''), opts || {})));
ipcMain.handle('get-actions-deployments', guarded((id, folderPath, opts) => projects.projectActionsDeployments(id, String(folderPath || ''), opts || {})));
// Every change to GitHub Actions (actions-edits.js).
ipcMain.handle('edit-actions', guarded((id, folderPath, params) => projects.editProjectActions(id, String(folderPath || ''), params || {})));
// The downloads: like Create Archive, the destination comes only from the
// system's own dialog shown here, never from the renderer.
ipcMain.handle('save-actions-artifact', guardedEvent(async (event, id, folderPath, opts = {}) => {
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) || mainWindow, {
    title: `Download ${String(opts.name || 'artifact')}`,
    buttonLabel: 'Download here',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return { cancelled: true };
  const result = await projects.downloadProjectActionsArtifact(id, String(folderPath || ''), {
    remote: opts.remote, runId: opts.runId, name: opts.name, destDir: picked.filePaths[0],
  });
  if (result && result.ok) shell.showItemInFolder(result.path);
  return result;
}));
ipcMain.handle('save-actions-log', guardedEvent(async (event, id, folderPath, opts = {}) => {
  const job = opts.jobId != null;
  const suggested = String(opts.suggestedName || (job ? 'job-log' : 'logs')).replace(/[\\/:*?"<>|]/g, '-');
  const picked = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) || mainWindow, {
    title: job ? 'Download log' : 'Download log archive',
    defaultPath: `${suggested}.${job ? 'txt' : 'zip'}`,
    filters: job ? [{ name: 'Text', extensions: ['txt', 'log'] }] : [{ name: 'Zip Archive', extensions: ['zip'] }],
  });
  if (picked.canceled || !picked.filePath) return { cancelled: true };
  const result = await projects.saveProjectActionsLog(id, String(folderPath || ''), {
    remote: opts.remote, jobId: job ? opts.jobId : null, runId: job ? null : opts.runId, attempt: opts.attempt == null ? null : opts.attempt, filePath: picked.filePath,
  });
  if (result && result.ok) shell.showItemInFolder(result.path);
  return result;
}));
// The .env files a folder has, and the ones the dialog ticks by default,
// so a new worktree can be offered its repository's local environment.
ipcMain.handle('list-env-files', guarded((folderPath) => ({
  ok: true,
  files: projects.listEnvFiles(String(folderPath || '')),
  defaults: projects.defaultEnvSelection(String(folderPath || '')),
})));
ipcMain.handle('save-project-brief', guarded((id, content) => projects.saveBrief(id, content)));
ipcMain.handle('create-project-file', guarded((id, name, content) => projects.createProjectFile(id, name, content)));
// The Env tab: the local.env.sh of the project folder and of each attached
// folder (projects.js envFilesState), made with + and kept out of Git on request.
ipcMain.handle('project-env-files', guarded((id) => projects.envFilesState(id)));
ipcMain.handle('create-project-env-file', guarded((id, folderPath) => projects.createEnvFile(id, folderPath)));
ipcMain.handle('exclude-project-env-file', guarded((id, folderPath) => projects.excludeEnvFile(id, folderPath)));
ipcMain.handle('add-project-files', guarded((id, sourcePaths) => projects.addProjectFiles(id, sourcePaths)));
ipcMain.handle('list-recent-project-files', guarded((id) => projects.listRecentProjectFiles(id)));
ipcMain.handle('get-project-plan', guarded((id) => projects.readProjectPlan(id)));
// Every client hears of an edit, wherever it was made; the window redraws only what moved.
const planEdited = (id, result) => { if (result?.ok) emit('project-plan-changed', id); return result; };
ipcMain.handle('set-plan-item', guarded((id, kind, line, done) => planEdited(id, projects.setPlanItem(id, kind, line, done))));
ipcMain.handle('append-plan-item', guarded((id, kind, text) => planEdited(id, projects.appendPlanItem(id, kind, text))));
ipcMain.handle('edit-plan-item', guarded((id, kind, line, text) => planEdited(id, projects.editPlanItem(id, kind, line, text))));
ipcMain.handle('adopt-plan', guarded((id, filename, opts) => projects.adoptPlan(id, filename, opts || {})));
ipcMain.handle('list-templates', guarded(() => projects.listTemplates()));

// --- IPC: Worktrees tab ---
// worktrees.js checks every path against the project's repositories itself.
const worktrees = require('./worktrees');
worktrees.init({ db: dbModule, log, projects });
const wtPath = (value) => String(value || '');
ipcMain.handle('get-project-worktrees', guarded((id) => worktrees.listProjectWorktrees(id)));
ipcMain.handle('get-worktree-settings', guarded((id) => worktrees.getSettings(id)));
ipcMain.handle('set-worktree-settings', guarded((id, patch) => worktrees.setSettings(id, patch || {})));
ipcMain.handle('list-worktree-branches', guarded((id, repoPath) => worktrees.listRepoBranches(id, wtPath(repoPath))));
ipcMain.handle('suggest-worktree-path', guarded((id, repoPath, ref) => worktrees.suggestWorktreePath(id, wtPath(repoPath), String(ref || ''))));
ipcMain.handle('worktree-create', guarded(trustingNewFolders((id, spec) => worktrees.createWorktree(id, spec || {}))));
ipcMain.handle('worktree-run-post-create', guarded((id, worktreePath) => worktrees.runPostCreate(id, wtPath(worktreePath))));
ipcMain.handle('worktree-remove', guarded((id, worktreePath, opts) => worktrees.removeWorktree(id, wtPath(worktreePath), opts || {})));
ipcMain.handle('worktree-delete-branch', guarded((id, repoPath, branch, opts) => worktrees.deleteBranch(id, wtPath(repoPath), String(branch || ''), opts || {})));
ipcMain.handle('worktree-merged', guarded((id, repoPath, base) => worktrees.mergedWorktrees(id, wtPath(repoPath), String(base || ''))));
ipcMain.handle('worktree-lock', guarded((id, worktreePath, reason) => worktrees.lockWorktree(id, wtPath(worktreePath), String(reason || ''))));
ipcMain.handle('worktree-unlock', guarded((id, worktreePath) => worktrees.unlockWorktree(id, wtPath(worktreePath))));
ipcMain.handle('worktree-move', guarded(trustingNewFolders((id, worktreePath, newPath) => worktrees.moveWorktree(id, wtPath(worktreePath), wtPath(newPath)))));
ipcMain.handle('worktree-repair', guarded((id, repoPath, paths) => worktrees.repairWorktrees(id, wtPath(repoPath), Array.isArray(paths) ? paths.map(String) : [])));
ipcMain.handle('worktree-prune-preview', guarded((id, repoPath) => worktrees.prunePreview(id, wtPath(repoPath))));
ipcMain.handle('worktree-prune', guarded((id, repoPath, opts) => worktrees.pruneWorktrees(id, wtPath(repoPath), opts || {})));
ipcMain.handle('worktree-attach', guarded(trustingNewFolders((id, worktreePath) => worktrees.attachToProject(id, wtPath(worktreePath)))));
ipcMain.handle('worktree-detach', guarded((id, worktreePath) => worktrees.detachFromProject(id, wtPath(worktreePath))));
ipcMain.handle('worktree-changes', guarded((id, worktreePath) => worktrees.worktreeChanges(id, wtPath(worktreePath))));
ipcMain.handle('worktree-file-diff', guarded((id, worktreePath, filePath) => worktrees.worktreeFileDiff(id, wtPath(worktreePath), String(filePath || ''))));

// --- IPC: Node Knowledge tab (codebase-memory-mcp) ---
// knowledge.js checks every folder against the project and fills in the CBM
// project name itself; cbm-client.js is the app's one MCP session with CBM.
const cbmLocator = require('./cbm-locator');
const { createCbmClient } = require('./cbm-client');
const knowledge = require('./knowledge');
const cbmClient = createCbmClient({
  locate: () => cbmLocator.locateCbm({ configured: knowledge.globalSettings().binaryPath }),
  env: () => buildPtyEnv(process.env),
  // CBM indexes the folder an MCP session starts in (auto_index). The app's own
  // session starts in the home folder, which CBM never indexes, so no graph of
  // an app folder is made (sessionLaunch still writes its configs in userData/cbm).
  cwd: () => os.homedir(),
  log,
  clientInfo: { name: 'switchboard-evolution', version: app.getVersion() },
});
knowledge.init({
  db: dbModule, log, projects, client: cbmClient, emit,
  watchRepo: (dir) => gitGraphService.ensureRepoWatch(dir),
  syncBrief: (id) => projects.syncProjectBrief(id),
  cbmDir: () => path.join(app.getPath('userData'), 'cbm'),
});
// Projects with the code graph on get a "Code graph" section in their managed block.
projects.addBriefSection((id) => knowledge.briefSection(id));
// A new project starts with the graph on; a folder that joins such a project is indexed (a worktree
// as a graph of its own, which it loses when it leaves).
projects.onProjectCreated((event) => knowledge.projectCreated(event));
projects.onFolderChange((event) => knowledge.folderChanged(event));
// A deleted project's folder keeps its files but loses its graph (when no other project has it).
projects.onProjectDeleted((event) => { knowledge.projectDeleted(event).catch((err) => log.warn('[knowledge] project deleted', err.message)); });
addSink((channel, args) => {
  if (channel === 'git-graph-repo-changed' && typeof args[0] === 'string') knowledge.scheduleRefresh(args[0]);
});

// --- The editor's language servers (lsp/) ---
// Started for a file inside a project's folders, when that project has the
// server on (its Settings tab) and the server is installed on this computer:
// nothing is downloaded. One process per window, folder and server
// (lsp/manager.js), spoken to by the window's editors over lsp-send /
// lsp-message.
const { createProjectServers } = require('./lsp/project-servers');
const { createLspManager } = require('./lsp/manager');
const lspLocate = require('./lsp/locate');
function lspDataDir() {
  const dir = path.join(app.getPath('userData'), 'lsp');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
// The app's switch (Settings › Editor, "Language servers"): off, no server starts anywhere.
function languageServersOn() {
  return (getSetting('global') || {}).languageServers !== false;
}
const lspProjects = createProjectServers({
  db: dbModule,
  log,
  locate: server => lspLocate.locateServer(server, { root: '', dataDir: lspDataDir() }),
});
const lspManager = createLspManager({
  projectServers: lspProjects,
  locate: (server, context) => lspLocate.locateServer(server, context),
  send: (ownerId, channel, ...args) => {
    const target = webContents.fromId(ownerId);
    if (target && !target.isDestroyed()) target.send(channel, ...args);
  },
  log,
  dataDir: lspDataDir(),
  env: async () => ({ ...buildPtyEnv(process.env), PATH: lspLocate.serverPath({ login: await lspLocate.loginPath() }) }),
  isOn: languageServersOn,
});
// A window's servers stop with it.
const lspOwners = new Set();
function watchLspOwner(sender) {
  if (!sender || lspOwners.has(sender.id)) return;
  const id = sender.id;
  lspOwners.add(id);
  sender.once('destroyed', () => { lspOwners.delete(id); lspManager.closeOwner(id); });
}
// A folder that joins a project turns on the servers of the languages it has
// (with the switch off it is looked at later, the first time a server is needed).
projects.onFolderChange((event) => {
  if (event.change !== 'attached' || !event.folder?.path || !languageServersOn()) return;
  lspProjects.ensureDetected(event.projectId, [event.folder.path]).catch(err => log.warn(`[lsp] detection failed: ${err.message}`));
});
ipcMain.handle('lsp-open', async (event, filePath) => {
  try {
    watchLspOwner(event.sender);
    return await lspManager.open({ ownerId: event.sender.id, filePath });
  } catch (err) {
    log.error('[lsp] open', err);
    return { unavailable: 'error', error: err.message };
  }
});
ipcMain.on('lsp-send', (event, sessionId, message) => lspManager.fromClient(event.sender.id, sessionId, message));
ipcMain.handle('lsp-close', async (event, sessionId) => { await lspManager.close(event.sender.id, sessionId); return { ok: true }; });
ipcMain.handle('lsp-restart', (event, sessionId) => lspManager.restart(event.sender.id, sessionId));
ipcMain.handle('lsp-project-servers', guarded(projectId => lspProjects.summary(projectId, { detect: languageServersOn() })));
ipcMain.handle('get-language-servers', () => languageServersOn());
ipcMain.handle('set-language-servers', guarded(async (on) => {
  const result = await settingsPatcher.patch('global', { languageServers: !!on });
  return result.ok ? { ok: true, on: !!on } : result;
}));
ipcMain.handle('set-project-lsp-server', guarded((projectId, serverId, on) => lspProjects.setEnabled(projectId, serverId, on)));
ipcMain.handle('lsp-detect', guarded(async (projectId) => { await lspProjects.redetect(projectId); return lspProjects.summary(projectId); }));
// A rename's edits to files no editor has open, written here (only inside a project's folders).
const lspEdits = require('./lsp/apply-edits');
ipcMain.handle('lsp-apply-edits', guardedEvent(async (event, fileEdits, { title = 'Rename' } = {}) => {
  const files = Object.keys(fileEdits || {});
  if (!files.length) return { ok: true, files: 0 };
  const sender = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
  const win = sender && !sender.isDestroyed() ? sender : mainWindow;
  const shown = files.slice(0, 8).map(f => `• ${f}`);
  if (files.length > shown.length) shown.push(`+ ${files.length - shown.length} more`);
  const options = {
    type: 'question',
    message: `${title} also in ${files.length} file${files.length === 1 ? '' : 's'} that ${files.length === 1 ? 'is' : 'are'} not open?`,
    detail: `${shown.join('\n')}\n\nThe files are changed on disk.`,
    buttons: ['Change Them', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response !== 0) return { cancelled: true };
  return lspEdits.writeFileEdits(fileEdits, { folderOf: f => lspProjects.folderOf(f) });
}));
// Format Document and Format Selection (formatter.js): the project's Prettier, else the app's.
const { createFormatter } = require('./formatter');
const formatter = createFormatter({ folderOf: f => lspProjects.folderOf(f), log });
ipcMain.handle('editor-format', guarded(request => formatter.format(request || {})));
// Go to Definition through the code graph where no language server answers.
const { findDefinitionInGraph } = require('./lsp/graph-definition');
ipcMain.handle('editor-find-definition', guarded((filePath, word) => findDefinitionInGraph({
  folderOf: f => lspProjects.folderOf(f),
  query: (projectId, folder, tool, args) => knowledge.query(projectId, folder, tool, args),
}, filePath, word)));
// Like guarded(), and the error's code too ('not-indexed', 'cbm-missing', …) for the tab's states.
function knowledgeGuarded(fn) {
  return async (_event, ...args) => {
    try { return await fn(...args); } catch (err) {
      if (!err.code) log.error('[knowledge]', err);
      return { error: err.message, code: err.code || null };
    }
  };
}
const knPath = (value) => String(value || '');
const knObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
ipcMain.handle('get-knowledge-status', knowledgeGuarded((id) => knowledge.status(id)));
ipcMain.handle('get-knowledge-settings', knowledgeGuarded((id) => knowledge.getSettings(id)));
ipcMain.handle('set-knowledge-settings', knowledgeGuarded((id, patch) => knowledge.setSettings(id, knObject(patch))));
ipcMain.handle('knowledge-query', knowledgeGuarded((id, folder, tool, args) => knowledge.query(id, knPath(folder), String(tool || ''), args)));
ipcMain.handle('knowledge-compare', knowledgeGuarded((id, base, target, opts) => knowledge.compare(id, knPath(base), knPath(target), knObject(opts))));
ipcMain.handle('knowledge-prompt', knowledgeGuarded((id, folder, name, args) => knowledge.prompt(id, knPath(folder), String(name || ''), knObject(args))));
ipcMain.handle('knowledge-index', knowledgeGuarded((id, folder, opts) => knowledge.index(id, knPath(folder), { mode: knObject(opts).mode })));
ipcMain.handle('knowledge-index-all', knowledgeGuarded((id, opts) => knowledge.indexAll(id, { mode: knObject(opts).mode })));
ipcMain.handle('knowledge-link-cross-repo', knowledgeGuarded((id) => knowledge.linkCrossRepo(id)));
ipcMain.handle('knowledge-delete-index', knowledgeGuarded((id, folder) => knowledge.deleteIndex(id, knPath(folder))));
ipcMain.handle('knowledge-modules', knowledgeGuarded((id, folder) => knowledge.modules(id, knPath(folder))));
ipcMain.handle('knowledge-delete-inner-graph', knowledgeGuarded((id, folder, name) => knowledge.deleteInnerGraph(id, knPath(folder), String(name || ''))));
ipcMain.handle('knowledge-adr', knowledgeGuarded((id, folder, opts) => knowledge.adr(id, knPath(folder), knObject(opts))));
ipcMain.handle('knowledge-ingest-traces', knowledgeGuarded((id, folder, opts) => knowledge.ingestTraces(id, knPath(folder), knObject(opts))));
// The traces file comes from this dialog, never as a path from the renderer.
ipcMain.handle('knowledge-import-traces-file', knowledgeGuarded(async (id, folder, label) => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Import runtime traces',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
  return knowledge.ingestTracesFile(id, knPath(folder), picked.filePaths[0], label == null ? null : String(label));
}));
ipcMain.handle('get-knowledge-config', knowledgeGuarded(() => knowledge.getConfig()));
ipcMain.handle('set-knowledge-config', knowledgeGuarded((key, value) => knowledge.setConfig(String(key || ''), value == null ? '' : String(value))));
ipcMain.handle('get-knowledge-global', knowledgeGuarded(() => ({ ok: true, settings: knowledge.globalSettings() })));
ipcMain.handle('set-knowledge-global', knowledgeGuarded((patch) => knowledge.setGlobalSettings(knObject(patch))));
ipcMain.handle('knowledge-pick-binary', knowledgeGuarded(async () => {
  const picked = await dialog.showOpenDialog(mainWindow, { title: 'Choose codebase-memory-mcp', properties: ['openFile', 'showHiddenFiles'] });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
  return knowledge.setGlobalSettings({ binaryPath: picked.filePaths[0] });
}));
ipcMain.handle('knowledge-lens', knowledgeGuarded((id, folder, workspace) => knowledge.lens(id, knPath(folder), String(workspace || ''))));
ipcMain.handle('knowledge-download-binary', knowledgeGuarded(() => knowledge.downloadBinary()));
ipcMain.handle('knowledge-restart', knowledgeGuarded(() => knowledge.restart()));
ipcMain.handle('get-knowledge-binary', knowledgeGuarded(() => knowledge.binary()));
ipcMain.handle('knowledge-install-agents', knowledgeGuarded((opts) => knowledge.installAgents({ dryRun: knObject(opts).dryRun !== false })));

// --- IPC: get-projects ---
ipcMain.handle('open-external', (_event, url) => {
  log.info('[open-external IPC]', url);
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
});

// Reveal a folder in the OS file manager. Only existing directories, so a
// renderer value can never launch a file.
ipcMain.handle('open-path', async (_event, target) => {
  try {
    const resolved = path.resolve(String(target || ''));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return { error: 'Not a folder' };
    const err = await shell.openPath(resolved);
    return err ? { error: err } : { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Show a viewer panel's file selected in the OS file manager.
ipcMain.handle('reveal-file', (_event, filePath) => {
  try {
    return { ok: true, ...revealFile(filePath, { shell }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- IPC: clipboard write ---
// The renderer's navigator.clipboard.writeText is gated on focus/user-activation and
// is flaky-to-dead on Linux/Wayland (Ozone). The main-process clipboard has no such
// strings attached, so all terminal copies go through here.
ipcMain.handle('clipboard-write-text', (_event, text) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

// --- IPC: MCP bridge ---
ipcMain.handle('mcp-diff-response', (_event, sessionId, diffId, action, editedContent) =>
  resolvePendingDiff(sessionId, diffId, action, editedContent));

ipcMain.handle('resolve-terminal-files', (_event, references, context) => resolveTerminalFiles(references, context));

ipcMain.handle('open-file-externally', async (_event, filePath, projectRoot) => {
  try {
    return { ok: true, ...await openFileExternally(filePath, projectRoot, shell) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Share a viewer panel's file through the macOS share menu (AirDrop, Mail,
// Messages and any app with a share extension). Other systems have no such menu.
ipcMain.handle('share-file', (event, filePath) => {
  try {
    if (process.platform !== 'darwin') throw new Error('Sharing files is only available on macOS');
    const window = BrowserWindow.fromWebContents(event.sender);
    return { ok: true, ...shareFile(filePath, { share: file => new ShareMenu({ filePaths: [file] }).popup({ window }) }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('read-file-for-panel', async (_event, filePath) => {
  try {
    return { ok: true, ...readPreviewFile(filePath) };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});

ipcMain.handle('list-project-directory', async (_event, projectPath, relativePath) => {
  try {
    return { ok: true, entries: listProjectDirectory(projectPath, relativePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('manage-project-entry', async (_event, projectPath, relativePath, action, newName) => {
  try {
    const result = await manageProjectEntry(projectPath, relativePath, action, newName, {
      shell,
      confirmTrash: async (filePath, isDirectory) => {
        const destination = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
        const choice = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          message: `Move "${path.basename(filePath)}" to the ${destination}?`,
          detail: `${isDirectory ? 'The folder and its contents' : 'The file'} can be restored from the ${destination}. Open previews of this item will close; unsaved edits will be discarded.`,
          buttons: ['Cancel', `Move to ${destination}`], defaultId: 0, cancelId: 0,
          noLink: true,
        });
        return choice.response === 1;
      },
    });
    drafts.follow(result);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Several ticked entries of the Files tab to the Trash, after one question
// asked over the window that asked (a project window too).
ipcMain.handle('trash-project-entries', async (event, projectPath, relativePaths) => {
  try {
    const sender = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
    const win = sender && !sender.isDestroyed() ? sender : mainWindow;
    const result = await trashProjectEntries(projectPath, relativePaths, {
      shell,
      confirm: async (entries) => {
        const question = FileSelection.trashQuestion(entries, { platform: process.platform });
        const choice = await dialog.showMessageBox(win, {
          type: 'question',
          message: question.title,
          detail: question.detail,
          buttons: ['Cancel', question.confirm], defaultId: 0, cancelId: 0,
          noLink: true,
        });
        return choice.response === 1;
      },
    });
    drafts.follow(result);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// The Files tab's explorer: new file or folder, duplicate, paste a copied or cut entry.
const explorerAction = (fn) => async (_event, ...args) => {
  try {
    return { ok: true, ...await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};
ipcMain.handle('create-project-entry', explorerAction((projectPath, folderRelative, name, kind) => createProjectEntry(projectPath, folderRelative, name, kind)));
ipcMain.handle('duplicate-project-entry', explorerAction((projectPath, relativePath) => duplicateProjectEntry(projectPath, relativePath)));
ipcMain.handle('paste-project-entry', explorerAction((sourcePath, sourceRelative, targetPath, targetRelative, mode) => {
  const result = pasteProjectEntry(sourcePath, sourceRelative, targetPath, targetRelative, mode);
  drafts.follow(result);
  return result;
}));
ipcMain.handle('get-file-timeline', explorerAction((projectPath, relativePath) => fileTimeline.getFileTimeline(projectPath, relativePath)));
ipcMain.handle('get-file-timeline-diff', explorerAction((projectPath, relativePath, hash, repoPath, oldPath) => fileTimeline.getFileTimelineDiff(projectPath, relativePath, hash, repoPath, oldPath)));
ipcMain.handle('get-file-at-commit', explorerAction((projectPath, relativePath, hash, repoPath) => fileTimeline.getFileAtCommit(projectPath, relativePath, hash, repoPath)));

// "Open With…": a file of a project in an application the user picks (macOS),
// or in the one given (a recent pick). Only an existing file, only an .app.
ipcMain.handle('open-file-with-app', explorerAction(async (filePath, projectRoot, appPath) => {
  if (process.platform !== 'darwin') throw new Error('Open With is only available on macOS');
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('File path must be absolute');
  const root = resolveProjectEntry(projectRoot).root;
  const { resolved } = resolveProjectEntry(root, path.relative(root, fs.realpathSync(filePath)));
  if (!fs.statSync(resolved).isFile()) throw new Error('Not a file');
  let app = appPath;
  if (!app) {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: `Open ${path.basename(resolved)} with`,
      defaultPath: '/Applications',
      buttonLabel: 'Open',
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['app'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true };
    app = picked.filePaths[0];
  }
  if (typeof app !== 'string' || !path.isAbsolute(app) || !/\.app$/i.test(app) || !fs.existsSync(app)) throw new Error('Not an application');
  await new Promise((resolve, reject) => {
    execFile('open', ['-a', app, resolved], (err, _stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
  });
  return { appPath: app, appName: path.basename(app, '.app') };
}));

// Search and replace across a folder's files, as VS Code's Search view does.
ipcMain.handle('search-project-files', (_event, root, options) => projectSearch.search(String(root || ''), options || {}));
ipcMain.handle('replace-in-project-files', (_event, root, options) => projectSearch.replace(String(root || ''), options || {}));

ipcMain.handle('read-project-file', async (_event, projectPath, relativePath) => {
  try {
    return { ok: true, ...readProjectFile(projectPath, relativePath) };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});

ipcMain.handle('save-file-for-panel', async (_event, filePath, content, options) => {
  try {
    const resolved = path.resolve(filePath);
    // `create`: unsaved text kept for a file that is gone is written back, into a folder still there.
    if (!fs.existsSync(resolved) && !(options?.create === true && fs.existsSync(path.dirname(resolved)))) {
      return { ok: false, error: 'File does not exist' };
    }
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Unsaved edits (file-drafts.js) ───────────────────────────────────
// What an editor holds and has not saved is written here as it is typed, so
// closing a view, a window or the app loses nothing. Synchronous: a window
// that closes writes its last keys before it goes. Every other window with the
// same file open follows, so one file has one unsaved text.
const drafts = createDraftStore({ dir: path.join(dbModule.DATA_DIR, 'drafts') });

function tellOtherWindows(sender, change) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents !== sender) win.webContents.send('draft-changed', change);
  }
}

ipcMain.on('draft-get', (event, filePath) => { event.returnValue = drafts.get(filePath); });

ipcMain.on('draft-set', (event, filePath, draft) => {
  const result = drafts.set(filePath, draft);
  if (result.ok) tellOtherWindows(event.sender, { filePath, state: 'dirty', content: draft.content, base: draft.base });
  else log.warn(`[drafts] could not keep unsaved changes: ${result.error}`);
  event.returnValue = result;
});

// `change.content` is the text the file has now: saved, or the edits dropped.
ipcMain.on('draft-remove', (event, filePath, change) => {
  drafts.remove(filePath);
  tellOtherWindows(event.sender, { filePath, state: 'clean', content: change?.content });
  event.returnValue = true;
});

ipcMain.handle('list-drafts', () => drafts.list());

// A window whose unsaved text could not be kept (viewer-panel.js stops its
// unload): asked before it is lost.
let discardUnkeptDrafts = false;

function confirmLosingDrafts(win) {
  const options = {
    type: 'warning',
    message: 'Your unsaved changes could not be kept',
    detail: 'Switchboard could not write a copy of them. Keep it open and save the files, or they are lost.',
    buttons: ['Keep Open', 'Close Anyway'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const response = win && !win.isDestroyed() ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
  return response === 1;
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-prevent-unload', (event) => {
    // A web page shown inside the app keeps its own question.
    if (contents.getType() !== 'window') return;
    // preventDefault here lets the window go, against the page's wish to stay.
    if (discardUnkeptDrafts || confirmLosingDrafts(BrowserWindow.fromWebContents(contents))) event.preventDefault();
    else appIsQuitting = false;
  });
});

// An editor with unsaved changes is about to show another file or close:
// Save, Don't Save or Cancel, asked over the window that asked.
ipcMain.handle('confirm-unsaved-changes', async (event, fileName) => {
  const sender = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
  const win = sender && !sender.isDestroyed() ? sender : mainWindow;
  const name = typeof fileName === 'string' && fileName ? fileName : 'this file';
  const options = {
    type: 'warning',
    message: `Do you want to save the changes you made to ${name}?`,
    detail: 'Your changes will be lost if you don\'t save them.',
    buttons: ['Save', 'Don\'t Save', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return ['save', 'discard', 'cancel'][response] || 'cancel';
});

// ── File Watching (for viewer panels) ────────────────────────────────
const fileWatchers = new Map(); // filePath → FSWatcher
// How many editors watch each: one closing a file leaves it watched for the others.
const fileWatcherUsers = new Map();

ipcMain.handle('watch-file', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  if (fileWatchers.has(resolved)) {
    fileWatcherUsers.set(resolved, (fileWatcherUsers.get(resolved) || 1) + 1);
    return { ok: true };
  }
  try {
    let debounce = null;
    const watcher = fs.watch(resolved, (eventType) => {
      if (eventType !== 'change') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => emit('file-changed', resolved), 300);
    });
    fileWatchers.set(resolved, watcher);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('unwatch-file', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  const watcher = fileWatchers.get(resolved);
  if (watcher) {
    const users = (fileWatcherUsers.get(resolved) || 1) - 1;
    if (users > 0) {
      fileWatcherUsers.set(resolved, users);
    } else {
      watcher.close();
      fileWatchers.delete(resolved);
      fileWatcherUsers.delete(resolved);
    }
  }
  return { ok: true };
});

ipcMain.handle('get-projects', (_event, showArchived) => {
  try {
    const needsPopulate = !sessionIndexer.initialComplete && (!isCachePopulated() || !isSearchIndexPopulated());

    if (needsPopulate) {
      populateCacheViaWorker();
      return [];
    }

    // Pick up folders changed while the app was closed, or never indexed by an
    // older build, so sessions/worktrees don't silently go missing. Stat-gated,
    // so it's cheap when nothing has changed.
    reconcileCacheFromFilesystem();
    // Backstop for a dropped fs.watch event: a session waiting for its
    // transcript would otherwise stay stuck under its temporary id. Only runs
    // while something is actually waiting.
    if (hasPendingLaunches()) sweepPendingLaunches();
    return buildProjectsFromCache(showArchived);
  } catch (err) {
    console.error('Error listing projects:', err);
    return [];
  }
});

// --- IPC: get-plans ---
// Each plan with the session that wrote it, its folder and project, for the
// Plans tab's Group, Filter and Sort (plans-source.js, public/plans-list.js).
ipcMain.handle('get-plans', () => {
  try {
    const plans = readPlans(PLANS_DIR);

    // Index plans for FTS
    try {
      deleteSearchType('plan');
      upsertSearchEntries(plans.map(p => ({
        id: p.filename, type: 'plan', folder: null,
        title: p.title,
        body: p.content,
      })));
    } catch {}

    let slugSessions = [];
    let projectRows = [];
    try {
      slugSessions = dbModule.getSlugSessions();
      projectRows = dbModule.listProjects();
    } catch (err) {
      console.error('Error linking plans to sessions:', err);
    }
    return linkPlans(plans, slugSessions, projectResolver(projectRows, projects.projectForCwd));
  } catch (err) {
    console.error('Error reading plans:', err);
    return [];
  }
});

// --- IPC: read-plan ---
ipcMain.handle('read-plan', (_event, filename) => {
  try {
    const filePath = path.join(PLANS_DIR, path.basename(filename));
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, filePath };
  } catch (err) {
    console.error('Error reading plan:', err);
    return { content: '', filePath: '' };
  }
});

// --- IPC: save-plan ---
ipcMain.handle('save-plan', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(PLANS_DIR)) {
      return { ok: false, error: 'path outside plans directory' };
    }
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving plan:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: get-stats ---
ipcMain.handle('get-stats', () => {
  if (!harnessEnabled(DEFAULT_HARNESS)) return null;
  try {
    if (!fs.existsSync(STATS_CACHE_PATH)) return null;
    const raw = fs.readFileSync(STATS_CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading stats cache:', err);
    return null;
  }
});

// --- IPC: refresh-stats ---
let statsRefreshInFlight = null;
ipcMain.handle('refresh-stats', async () => {
  if (!harnessEnabled(DEFAULT_HARNESS)) return { stats: null, usage: {} };
  if (statsRefreshInFlight) return statsRefreshInFlight;

  statsRefreshInFlight = (async () => {
    const usagePromise = fetchAndTransformUsage().catch(() => ({}));
    const result = await refreshStatsCache(STATS_CACHE_PATH, () => {
      const globalSettings = getSetting('global') || {};
      const profile = resolveShell(globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile);
      return runStatsCommand({
        spawn: (...args) => pty.spawn(...args),
        shell: profile.path,
        args: shellArgs(profile.path, 'claude "/stats"', profile.args || []),
        options: {
          name: 'xterm-256color', cols: 120, rows: 40, cwd: os.homedir(),
          env: {
            ...cleanPtyEnv,
            TERM: 'xterm-256color', COLORTERM: 'truecolor',
            TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6',
            FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
          },
        },
      });
    });
    if (result.statsError) log.warn('Error refreshing stats:', result.statsError);
    return { ...result, usage: await usagePromise || {} };
  })();
  try { return await statsRefreshInFlight; }
  finally { statsRefreshInFlight = null; }
});

// --- IPC: get-usage (lightweight, API-only, no PTY) ---
ipcMain.handle('get-usage', async () => {
  if (!harnessEnabled(DEFAULT_HARNESS)) return {};
  try {
    return await fetchAndTransformUsage() || {};
  } catch (err) {
    log.error('Error fetching usage:', err);
    return {};
  }
});

// --- IPC: get-codex-usage --- (same idea for the codex account)
ipcMain.handle('get-codex-usage', async () => {
  // Nothing is fetched for a CLI the user switched off, or one that was never
  // signed in — no request, no error surfaced.
  if (!harnessEnabled('codex')) return {};
  try {
    return await codexAuth.fetchAndTransformUsage() || {};
  } catch (err) {
    log.error('Error fetching codex usage:', err);
    return {};
  }
});

// --- IPC: get-memories ---
function folderToShortPath(folder) {
  // Convert "-Users-me-dev-my-app" → "dev/my-app"
  const parts = folder.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}

/** Scan a directory for .md files (non-recursive). Returns array of { filename, filePath, modified }. */
function scanMdFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const fp = path.join(dir, e.name);
        const content = fs.readFileSync(fp, 'utf8').trim();
        if (content) {
          const stat = fs.statSync(fp);
          results.push({ filename: e.name, filePath: fp, modified: stat.mtime.toISOString() });
        }
      }
    }
  } catch {}
  return results;
}

ipcMain.handle('get-memories', () => {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  // --- Global files ---
  const globalFiles = scanMdFiles(CLAUDE_DIR).map(f => ({ ...f, displayPath: '~/.claude' }));

  // --- Per-project files ---
  const projects = [];
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const folderPath = path.join(PROJECTS_DIR, folder);
        const projectPath = deriveProjectPath(folderPath, folder);
        if (projectPath && hiddenProjects.has(projectPath)) continue;

        // Use same 2-deep short path as Sessions tab (e.g. "dev/my-app")
        // Splits on both separators — `cwd` is backslash-separated on Windows,
        // where splitting on '/' alone left the whole path as one segment.
        const shortName = projectPath
          ? projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
          : folderToShortPath(folder);
        const files = [];
        const seenPaths = new Set();

        // 1. ~/.claude/projects/{folder}/ — claude-home .md files
        const claudeHomeFiles = scanMdFiles(folderPath);
        for (const f of claudeHomeFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }
        // memory/MEMORY.md
        const memoryDir = path.join(folderPath, 'memory');
        const memoryFiles = scanMdFiles(memoryDir);
        for (const f of memoryFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }

        // 2. {projectPath}/ — project root CLAUDE.md, agents.md
        if (projectPath) {
          for (const name of ['CLAUDE.md', 'GEMINI.md', 'agents.md']) {
            const fp = path.join(projectPath, name);
            try {
              if (fs.existsSync(fp)) {
                const content = fs.readFileSync(fp, 'utf8').trim();
                if (content && !seenPaths.has(fp)) {
                  const stat = fs.statSync(fp);
                  files.push({ filename: name, filePath: fp, modified: stat.mtime.toISOString(), displayPath: shortName + '/', source: 'project' });
                  seenPaths.add(fp);
                }
              }
            } catch {}
          }

          // 3. {projectPath}/.claude/ — commands/*.md and other .md files
          const dotClaudeDir = path.join(projectPath, '.claude');
          const dotClaudeFiles = scanMdFiles(dotClaudeDir);
          for (const f of dotClaudeFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
          // commands/*.md
          const commandsDir = path.join(dotClaudeDir, 'commands');
          const commandFiles = scanMdFiles(commandsDir);
          for (const f of commandFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/commands/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
        }

        if (files.length > 0) {
          projects.push({ folder, projectPath: projectPath || '', shortName, files });
        }
      }
    }
  } catch (err) {
    console.error('Error scanning memories:', err);
  }

  // Sort projects by most recent file modified date
  projects.sort((a, b) => {
    const aMax = Math.max(...a.files.map(f => new Date(f.modified).getTime()));
    const bMax = Math.max(...b.files.map(f => new Date(f.modified).getTime()));
    return bMax - aMax;
  });

  const result = { global: { files: globalFiles }, projects };

  // Index all files for FTS
  try {
    deleteSearchType('memory');
    const allFiles = [
      ...globalFiles.map(f => ({ ...f, label: 'Global' })),
      ...projects.flatMap(p => p.files.map(f => ({ ...f, label: p.shortName }))),
    ];
    upsertSearchEntries(allFiles.map(f => ({
      id: f.filePath, type: 'memory', folder: null,
      title: f.label + ' ' + f.filename,
      body: fs.readFileSync(f.filePath, 'utf8'),
    })));
  } catch {}

  return result;
});

// --- IPC: read-memory ---
ipcMain.handle('read-memory', (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    // Allow paths under ~/.claude/ or any .md file that exists
    if (!resolved.endsWith('.md')) return '';
    if (!resolved.startsWith(CLAUDE_DIR) && !fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    console.error('Error reading memory file:', err);
    return '';
  }
});

// --- IPC: save-memory ---
ipcMain.handle('save-memory', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving memory file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: the Files tab's opened and pinned files (opened-files.js) ---
// Opened: files dropped on the sidebar (files-drop.js). Pinned: any file of
// the tab, kept at its top in the order the user gives.
function readOpenedFilesState() {
  return openedFiles.normalizeOpenedFiles(getSetting(openedFiles.OPENED_FILES_SETTING));
}

function describeOpenedFilesState(state) {
  return openedFiles.describeOpenedFiles(state, { home: os.homedir() });
}

/** The text of the opened files in the search index, as get-memories does for agent files. */
function indexOpenedFiles(state) {
  try {
    deleteSearchType('opened');
    const entries = [];
    for (const { filePath } of state.opened) {
      try {
        if (!['text', 'html'].includes(previewType(filePath))) continue;
        const stat = fs.statSync(filePath);
        if (!isViewableFile(filePath, stat)) continue;
        entries.push({
          id: filePath, type: 'opened', folder: null,
          title: `${path.basename(filePath)} ${path.dirname(filePath)}`,
          body: fs.readFileSync(filePath, 'utf8'),
        });
      } catch {}
    }
    upsertSearchEntries(entries);
  } catch {}
}

function saveOpenedFilesState(state, { reindex = false } = {}) {
  setSetting(openedFiles.OPENED_FILES_SETTING, state);
  if (reindex) indexOpenedFiles(state);
  return describeOpenedFilesState(state);
}

ipcMain.handle('get-opened-files', () => {
  const state = readOpenedFilesState();
  indexOpenedFiles(state);
  return describeOpenedFilesState(state);
});

ipcMain.handle('add-opened-files', (_event, paths) => {
  const { files, rejected } = openedFiles.checkDroppedPaths(paths);
  const state = files.length ? openedFiles.addOpened(readOpenedFilesState(), files) : readOpenedFilesState();
  const described = files.length ? saveOpenedFilesState(state, { reindex: true }) : describeOpenedFilesState(state);
  return { ...described, added: files, rejected };
});

ipcMain.handle('remove-opened-file', (_event, filePath) => {
  if (!openedFiles.isFilePath(filePath)) return describeOpenedFilesState(readOpenedFilesState());
  return saveOpenedFilesState(openedFiles.removeOpened(readOpenedFilesState(), filePath), { reindex: true });
});

ipcMain.handle('set-file-pinned', (_event, filePath, pinned) => {
  if (!openedFiles.isFilePath(filePath)) return describeOpenedFilesState(readOpenedFilesState());
  return saveOpenedFilesState(openedFiles.setPinned(readOpenedFilesState(), filePath, !!pinned));
});

ipcMain.handle('move-pinned-file', (_event, filePath, toIndex) => {
  if (!openedFiles.isFilePath(filePath)) return describeOpenedFilesState(readOpenedFilesState());
  return saveOpenedFilesState(openedFiles.movePinned(readOpenedFilesState(), filePath, toIndex));
});

// --- IPC: search ---
ipcMain.handle('search-session-ids', (_event, query, sessionIds) => {
  if (typeof query !== 'string' || !Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string')) return [];
  return dbModule.searchSessionIds(query, sessionIds);
});

ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchByType(type, query, 50, !!titleOnly);
});

// --- IPC: settings ---
ipcMain.handle('get-setting', (_event, key) => {
  return getSetting(key);
});

// Something was switched on or off. Watchers follow the new set, and a
// reconcile picks up whatever a newly-enabled harness did while it was
// being ignored — incremental, because its cached rows were kept and the
// folder mtime gate re-reads only what actually changed.
function harnessSetChanged() {
  stopHarnessWatchers();
  startHarnessWatchers();
  try { projectsWatcher?.close(); } catch {}
  projectsWatcher = null;
  startProjectsWatcher();
  try { reconcileCacheFromFilesystem(); } catch (err) { log.error('[harness-toggle]', err.message); }
  notifyRendererProjectsChanged();
  // The status bar quota gauge only re-reads on a 5-minute timer, so
  // without this a switched-off CLI keeps its bars until the next tick.
  emit('harnesses-changed');
}

const launchableHarnessIds = () => allHarnesses().filter(h => h.buildLaunchArgs).map(h => h.id);

// The one patch of the settings (settings-patch.js): the panel and a paired phone save through it.
const settingsPatcher = createSettingsPatcher({
  getSetting,
  setSetting,
  harnessIds: launchableHarnessIds,
  launchableHarnessIds,
  shellProfileIds: () => getShellProfiles().map(p => p.id),
  onHarnessesChanged: harnessSetChanged,
  // Off: every server stops; every window hears it (its editors let their servers go, or ask again when on).
  onLanguageServers: async (on) => {
    if (!on) await lspManager.stopAll();
    for (const target of webContents.getAllWebContents()) {
      if (!target.isDestroyed()) target.send('language-servers-changed', !!on);
    }
  },
  emit,
  log,
});
ipcMain.handle('patch-setting', async (_event, key, patch) => {
  try { return await settingsPatcher.patch(key, patch); } catch (err) {
    log.error('[settings]', err);
    return { ok: false, error: err.message };
  }
});

// The global settings as a phone shows them: the values in force, and the
// options its fields need (only what a phone reads, no folder listings).
ipcMain.handle('get-global-settings', () => ({
  values: SettingsModel.effectiveGlobalValues(getSetting('global') || {}, SETTING_DEFAULTS),
  options: {
    harnesses: allHarnesses().filter(h => h.buildLaunchArgs).map(h => ({ id: h.id, label: h.label, enabled: !disabledHarnessIds().has(h.id) })),
    shellProfiles: getShellProfiles().map(p => ({ id: p.id, name: p.name })),
    terminalEngine: terminalEngineStatus,
    templatesDir: projects.templatesRoot() || null,
  },
}));
ipcMain.handle('set-global-settings', async (_event, patch) => {
  try { return await settingsPatcher.patch('global', patch); } catch (err) {
    log.error('[settings]', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-setting', (_event, key, value) => {
  const beforeSet = key === 'global' ? disabledHarnessIds() : null;
  const before = beforeSet ? [...beforeSet].sort().join(',') : null;

  if (key === 'global' && Array.isArray(value?.disabledHarnesses)) {
    // The settings panel already prevents switching off every CLI; this is
    // the guard for any other writer.
    const kept = keepOneHarnessOn(value.disabledHarnesses, beforeSet, launchableHarnessIds());
    if (kept.length !== value.disabledHarnesses.length) {
      log.warn(`[harness-toggle] refusing to disable every CLI; keeping ${value.disabledHarnesses.find(id => !kept.includes(id))} on`);
      value = { ...value, disabledHarnesses: kept };
    }
  }

  setSetting(key, value);

  if (key === 'global' && before !== [...disabledHarnessIds()].sort().join(',')) harnessSetChanged();
  return { ok: true };
});

ipcMain.handle('delete-setting', (_event, key) => {
  deleteSetting(key);
  return { ok: true };
});

// --- Scheduled tasks ---

const SETTING_DEFAULTS = {
  permissionMode: null,
  dangerouslySkipPermissions: false,
  worktree: false,
  worktreeName: '',
  chrome: false,
  preLaunchCmd: '',
  addDirs: '',
  // Claude's model and effort. Empty leaves the choice to claude.
  model: '',
  effort: '',
  visibleSessionCount: 5,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  mcpEmulation: false,
  shellProfile: 'auto',
  // Codex equivalents of the permission settings above. Kept separate because
  // the vocabularies do not map: codex has no permission modes, and Claude has
  // no sandbox policy. An empty value means "leave it to codex's own config".
  // The app starts on workspace-write: a project's attached folders only reach
  // codex under that sandbox, and read-only sessions cannot do the work.
  codexSandbox: 'workspace-write',
  codexApproval: '',
  codexModel: '',
  codexEffort: '',
};

// --- Harness enablement ---
//
// A disabled harness is not scanned, not watched, not listed as something to
// start, and its sessions are hidden. Its cached rows are deliberately KEPT:
// re-enabling then costs an incremental reconcile rather than a full re-index,
// and nothing is lost if the toggle was a mistake.
function disabledHarnessIds() {
  const global = getSetting('global') || {};
  return new Set(global.disabledHarnesses || []);
}

function harnessEnabled(id) {
  return !disabledHarnessIds().has(id || DEFAULT_HARNESS);
}

// --- IPC: harnesses --- (which CLIs this machine has, and which are switched on)
ipcMain.handle('get-harnesses', () => {
  const disabled = disabledHarnessIds();
  return allHarnesses()
    .filter(h => h.buildLaunchArgs)
    .map(h => ({ id: h.id, label: h.label, enabled: !disabled.has(h.id) }));
});

// --- IPC: command catalog --- (what the CLI of a session understands, for the
// terminal's Commands palette and the phone's sheet; command-catalog.js)
// The docs packed with the app, refreshed at most once a day when a catalog
// is opened (command-docs-refresh.js); Electron's fetch follows the system proxy.
let commandDocs = null;
const commandCatalog = createCommandCatalog({
  versionsFor: sessionVersion.versionsFor,
  localScanners: { claude: scanClaudeLocal, codex: scanCodexLocal, opencode: scanOpencodeLocal },
  refreshed: (cli) => (commandDocs ? commandDocs.current(cli) : null),
});
commandDocs = createDocsRefresher({
  cacheDir: path.join(app.getPath('userData'), 'command-catalog'),
  fetchImpl: (url, init) => net.fetch(url, init),
  packed: (cli) => commandCatalog.packed(cli),
  // The tag a CLI's own source is read at: the version installed now.
  versionOf: (cli) => sessionVersion.versionsFor({ cli }).installed || null,
  emit,
});

/**
 * What the catalog needs to know of a session, running or not. `hint` is the
 * caller's own idea of the session's CLI, for one main does not know yet (a
 * session that has no transcript row so far).
 */
function commandCatalogContext(sessionId, hint = null) {
  const session = activeSessions.get(sessionId) || null;
  const row = getCachedSession((session && session.realSessionId) || sessionId) || null;
  const isPlainTerminal = !!(session && session.isPlainTerminal) || (!session && hint === 'terminal');
  let transcript = null;
  if (!isPlainTerminal && row) {
    try { transcript = transcriptPath(row); } catch { transcript = null; }
  }
  return {
    runtime: (session && session.runtime) || (row && row.runtime)
      || (hint && commandCatalog.clis().includes(hint) ? hint : null) || DEFAULT_HARNESS,
    isPlainTerminal,
    transcript,
    projectPath: (session && session.projectPath) || (row && row.projectPath) || null,
    addDirs: (session && session.launchAddDirs) || [],
  };
}

ipcMain.handle('get-command-catalog-clis', () => commandCatalog.clis().filter(harnessEnabled));
ipcMain.handle('get-command-catalog', (_event, sessionId, options) => {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const cli = options && typeof options.cli === 'string' ? options.cli : undefined;
  const hint = options && typeof options.runtime === 'string' ? options.runtime : null;
  const catalog = commandCatalog.forSession(commandCatalogContext(sessionId, hint), { cli });
  // Newer docs arrive later, with command-catalog-updated.
  if (catalog) commandDocs.maybeRefresh(catalog.cli).catch(() => {});
  return catalog;
});

// --- IPC: prompt improver --- (rewrites the prompt being written to a
// session's CLI with that CLI, or the one chosen in Settings, run once out of
// sight under the user's own sign-in: prompt-improver.js). Its settings are
// `promptImprover` in the global settings (public/prompt-improver-model.js).
const promptImprover = createPromptImprover({
  getSettings: () => (getSetting('global') || {}).promptImprover,
  getContext: async (sessionId, hint) => {
    const ctx = commandCatalogContext(sessionId, hint);
    if (ctx.isPlainTerminal) return { isPlainTerminal: true };
    const realId = activeSessions.get(sessionId)?.realSessionId || sessionId;
    const row = getCachedSession(realId) || null;
    const projectPath = ctx.projectPath || os.homedir();
    let catalog = null;
    try { catalog = commandCatalog.forSession(ctx); } catch (err) { log.warn('[prompt-improver] catalog', err.message); }
    // The same environment files and project variables as the session (open-terminal).
    const projectId = getMeta(realId)?.projectId || getMeta(sessionId)?.projectId || null;
    let envFiles = [];
    let projectEnv = {};
    if (projectId) {
      try { envFiles = await projects.envFilesFor(projectId, projectPath); } catch (err) { log.warn('[prompt-improver] env files', err.message); }
      try {
        const launch = projects.launchContext(projectId, projectPath);
        if (launch && launch.addDirs.length) projectEnv = launch.env || {};
      } catch (err) { log.warn('[prompt-improver] launch context', err.message); }
    }
    const requested = resolveShell(effectiveShellProfileId(projectPath));
    const profile = isWslShell(requested.path) ? resolveShell('auto') : requested;
    return {
      runtime: ctx.runtime,
      isPlainTerminal: false,
      projectPath,
      project: path.basename(projectPath),
      version: (catalog && catalog.version && (catalog.version.session || catalog.version.installed)) || '',
      entries: (catalog && catalog.entries) || [],
      readEntries: row ? async () => readViewerEntriesSince(getHarness(row.runtime), row, 0).entries : null,
      launch: { shell: profile.path, extraArgs: [...(profile.args || [])], envFiles },
      env: { ...cleanPtyEnv, ...projectEnv },
    };
  },
  newOpencodeId: () => getHarness('opencode').newSessionId(),
  hideSession: (id) => setArchived(id, 1),
  tmpDir: app.getPath('temp'),
  log,
});

function promptImproverSettings() {
  return PromptImproverModel.normalizeSettings((getSetting('global') || {}).promptImprover);
}

ipcMain.handle('improve-prompt', (_event, sessionId, prompt, options) => {
  const opts = options && typeof options === 'object' ? options : {};
  return promptImprover.improve(sessionId, prompt, {
    mode: typeof opts.mode === 'string' ? opts.mode : undefined,
    runtime: typeof opts.runtime === 'string' ? opts.runtime : null,
  });
});
ipcMain.handle('cancel-prompt-improvement', (_event, sessionId) => ({ ok: promptImprover.cancel(sessionId) }));
ipcMain.handle('get-prompt-improver-settings', () => ({
  settings: promptImproverSettings(),
  defaultTemplate: PromptImproverModel.DEFAULT_TEMPLATE,
  placeholders: PromptImproverModel.PLACEHOLDERS,
  clis: commandCatalog.clis().filter(harnessEnabled),
}));
// A change to some of the settings: the rest stay as they are; `template: null`
// goes back to the default improver prompt.
ipcMain.handle('set-prompt-improver-settings', (_event, changes) => {
  const checked = PromptImproverModel.validateSettings(changes);
  if (!checked.ok) return { ok: false, error: checked.error };
  const current = promptImproverSettings();
  const next = PromptImproverModel.normalizeSettings({
    ...current, ...changes, models: { ...current.models, ...((changes && changes.models) || {}) },
  });
  setSetting('global', { ...(getSetting('global') || {}), promptImprover: next });
  emit('prompt-improver-settings-changed', next);
  return { ok: true, settings: next };
});

// Codex's model catalog, for model suggestions and the per-model reasoning
// efforts in session and schedule settings.
ipcMain.handle('get-codex-models', () => getHarness('codex')?.readModelCatalog?.() || []);

ipcMain.handle('get-shell-profiles', () => {
  _shellProfiles = null; // refresh on each request
  return getShellProfiles();
});

function effectiveSettings(projectPath) {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  return resolveEffectiveSettings(SETTING_DEFAULTS, global, project);
}

ipcMain.handle('get-effective-settings', (_event, projectPath) => effectiveSettings(projectPath));

// Task processes deliberately live outside activeSessions. A server can be
// stopped, restarted, or reattached without changing an AI session lifecycle.
const taskManager = createTaskManager({
  baseEnv: cleanPtyEnv,
  getShellProfile: (projectPath) => resolveShell(effectiveSettings(projectPath).shellProfile),
  // A project worktree inherits its source repo's tasks.json.
  resolveWorktreeParent: (projectPath) => projects.worktreeParentFor(projectPath),
  log,
  send: emit,
});

ipcMain.handle('list-project-tasks', (_event, projectPath) => taskManager.listTasks(projectPath));
ipcMain.handle('list-tasks-for-projects', (_event, projectPaths) => taskManager.listTasksForProjects(projectPaths));
ipcMain.handle('get-task-run', (_event, projectPath, label) => taskManager.getRun(projectPath, label));
ipcMain.handle('start-task', (_event, projectPath, label) => taskManager.startTask(projectPath, label));
ipcMain.handle('stop-task', (_event, projectPath, label) => taskManager.stopTask(projectPath, label));
ipcMain.handle('stop-all-tasks', (_event, projectPath) => taskManager.stopAllTasks(projectPath));
ipcMain.handle('restart-task', (_event, projectPath, label) => taskManager.restartTask(projectPath, label));
ipcMain.on('task-input', (_event, projectPath, label, data) => taskManager.sendInput(projectPath, label, data));
ipcMain.on('task-resize', (_event, projectPath, label, cols, rows) => taskManager.resize(projectPath, label, cols, rows));

// --- IPC: get-active-sessions ---
ipcMain.handle('get-active-sessions', async () => {
  await sessionsReady;
  const active = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited) active.push(sessionId);
  }
  return active;
});

// --- IPC: get-active-terminals --- (plain terminal sessions for renderer restore)
ipcMain.handle('get-active-terminals', async () => {
  await sessionsReady;
  const terminals = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited && session.isPlainTerminal) {
      terminals.push({
        sessionId,
        projectPath: session.projectPath,
        projectId: session.projectId || null,
        trackId: session.trackId || null,
      });
    }
  }
  return terminals;
});

// --- IPC: stop-session ---
ipcMain.handle('stop-session', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'not running' };
  session.stopRequested = true;
  session.pty.kill();
  return { ok: true };
});

// --- IPC: RAM task manager ---
// What each live session and running task costs, measured over its whole
// process tree (the CLI, its MCP servers, whatever it started), so the heavy
// ones can be found and stopped. Root pids are always looked up here, never
// taken from the renderer.
const processMonitor = createProcessMonitor();

/** The live session behind an id, also under the real id a fork or plan-accept gave it. */
function ownedSession(sessionId) {
  let session = activeSessions.get(sessionId);
  if (!session) session = [...activeSessions.values()].find(s => s.realSessionId === sessionId);
  return session && !session.exited ? session : null;
}

/** One entry per live session and per running task, each with the pid its tree hangs from. */
function processOwners() {
  const owners = [];
  const seen = new Set();
  for (const [key, session] of activeSessions) {
    if (seen.has(session) || session.exited) continue;
    seen.add(session);
    owners.push({
      kind: 'session',
      id: session.realSessionId || key,
      pid: session.pty?.pid || null,
      type: session.isPlainTerminal ? 'terminal' : 'cli',
      runtime: session.isPlainTerminal ? null : session.runtime || null,
      projectPath: session.projectPath || null,
      startedAt: session._openedAt || null,
      busy: !!session._cliBusy,
      stopRequested: !!session.stopRequested,
    });
  }
  for (const task of taskManager.listProcesses()) {
    owners.push({ kind: 'task', id: `${task.projectPath}\0${task.label}`, type: 'task', ...task });
  }
  return owners;
}

function ownerRootPid(owner) {
  if (owner?.kind === 'session') return ownedSession(owner.id)?.pty?.pid || null;
  if (owner?.kind === 'task') {
    return taskManager.listProcesses().find(t => t.projectPath === owner.projectPath && t.label === owner.label)?.pid || null;
  }
  return null;
}

// Programs that host sessions outside the app's own process tree: their own
// memory is Switchboard's too (process-monitor.js usage()).
const TERMINAL_HOSTS = ['herdr-core', 'herdr-core.exe'];

// Free disk space changes slowly, and Windows reads it through PowerShell.
const DISKS_MAX_AGE_MS = 15000;
let diskSpace = null;

function readDisks() {
  if (diskSpace && Date.now() - diskSpace.at < DISKS_MAX_AGE_MS) return diskSpace.promise;
  // On Linux, the filesystems of the projects and of the app, besides home.
  const paths = [getSetting('global')?.projectsRoot, app.getAppPath()].filter(Boolean);
  const promise = processMonitor.disks({ paths }).catch(() => []);
  diskSpace = { at: Date.now(), promise };
  return promise;
}

/**
 * Everything the Task Manager shows: the memory installed and in use on the
 * computer, what Switchboard uses (the app, its terminal host, every session
 * and task), the free space on the disks, and each session and task.
 */
async function measureProcessUsage() {
  const [usage, memory, disks] = await Promise.all([
    processMonitor.usage(processOwners(), { appPid: process.pid, hostNames: TERMINAL_HOSTS }),
    processMonitor.systemMemory(),
    readDisks(),
  ]);
  return {
    platform: process.platform,
    totalMemBytes: memory.totalBytes,
    usedMemBytes: memory.usedBytes,
    // What each memory number is: 'footprint' (macOS), 'rss' or 'working-set'.
    memoryMeasure: usage.measure,
    app: usage.app,
    switchboard: usage.total,
    // { name, mount, totalBytes, freeBytes, primary }, the disk of home and projects first.
    disks,
    owners: usage.owners,
    sampledAt: Date.now(),
  };
}

// The window, a Task Manager window and a phone may all be refreshing: one
// measurement serves the requests that arrive while it runs, and for a moment after.
let processUsage = null;
ipcMain.handle('get-process-usage', () => {
  if (processUsage && (processUsage.pending || Date.now() - processUsage.at < 1500)) return processUsage.promise;
  const current = { pending: true, at: 0, promise: null };
  current.promise = measureProcessUsage().finally(() => { current.pending = false; current.at = Date.now(); });
  processUsage = current;
  return current.promise;
});

// How much disk each project takes with its attached folders (disk-usage.js):
// measured in the background, kept for half an hour; the Task Manager's disk
// ring asks while it is open, and "Measure again" forces a new measurement.
const { createDiskUsage } = require('./disk-usage');
const diskUsage = createDiskUsage({
  listProjects: () => dbModule.listProjects().map(p => ({
    id: p.id, name: p.name, root: p.root, status: p.status,
    folders: dbModule.listProjectFolders(p.id).map(f => f.path),
  })),
  log,
});
ipcMain.handle('get-project-disk-usage', (_event, force) => diskUsage.get({ force: force === true }));

// --- Pages in a window of their own: the Task Manager and Stats ---
// From the button in their tab's tooltip: a small window that can stay above
// the others, so the numbers stay in sight while working. Each remembers its
// place and size, and whether it stays on top (the Task Manager does at
// first). They close with the main window.
const TOOL_WINDOWS = {
  'task-manager': { page: 'task-manager.html', title: 'Task Manager', width: 640, height: 560, minWidth: 380, minHeight: 280, onTop: true },
  stats: { page: 'stats.html', title: 'Stats', width: 760, height: 720, minWidth: 420, minHeight: 320, onTop: false },
};
const toolWindows = new Map(); // kind → BrowserWindow

function toolWindowSettings(kind) {
  const global = getSetting('global') || {};
  // 1.6.1 kept the Task Manager's window under its own key.
  return global.toolWindows?.[kind] || (kind === 'task-manager' ? global.taskManagerWindow : null) || {};
}

function saveToolWindowSettings(kind, patch) {
  const global = getSetting('global') || {};
  global.toolWindows = { ...(global.toolWindows || {}), [kind]: { ...toolWindowSettings(kind), ...patch } };
  setSetting('global', global);
}

function openToolWindow(kind, { bounds, inactive = false } = {}) {
  const spec = TOOL_WINDOWS[kind];
  if (!spec) return;
  const open = toolWindows.get(kind);
  if (open && !open.isDestroyed()) {
    bringForward(open);
    return;
  }
  const win = createPageWindow(kind, spec, { bounds, inactive });
  toolWindows.set(kind, win);
  win.loadFile(path.join(__dirname, 'public', spec.page));
  win.on('closed', () => {
    if (toolWindows.get(kind) === win) toolWindows.delete(kind);
    rememberOpenWindows();
  });
  rememberOpenWindows();
}

function bringForward(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * A small window for a page of its own, `kind` naming where its place and
 * size are remembered. `offset` moves it down and right from that place, so
 * a second window of the same kind does not hide the first.
 */
function createPageWindow(kind, spec, { offset = 0, bounds: place = null, inactive = false } = {}) {
  // `place`: where this very window was (opened again at a start), rather
  // than where its kind last was.
  const saved = { ...toolWindowSettings(kind), ...(place || {}) };
  if (place) offset = 0;
  const bounds = { width: saved.width || spec.width, height: saved.height || spec.height };
  const onScreen = saved.x != null && saved.y != null && screen.getAllDisplays().some(d => {
    const b = d.workArea;
    return saved.x >= b.x - 100 && saved.x < b.x + b.width && saved.y >= b.y - 50 && saved.y < b.y + b.height;
  });
  if (onScreen) Object.assign(bounds, { x: saved.x + offset, y: saved.y + offset });
  const win = new BrowserWindow({
    ...bounds,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    title: spec.title,
    backgroundColor: '#111118',
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      // Only the pages that show a pull request's page on GitHub (web-page.js).
      webviewTag: !!spec.webview,
    },
  });
  if (saved.onTop ?? spec.onTop) win.setAlwaysOnTop(true, 'floating');
  // Opened again at a start, it does not take the focus from the main window.
  win.once('ready-to-show', () => (inactive ? win.showInactive() : win.show()));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  let boundsTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const b = win.getBounds();
      saveToolWindowSettings(kind, { x: b.x, y: b.y, width: b.width, height: b.height });
    }, 500);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('closed', () => clearTimeout(boundsTimer));
  return win;
}

// --- A project's tab in a window of its own ---
// From the button beside each tab of a project's page: index.html again, as
// a window without the sidebar and the terminals (public/project-window.js).
// A session it opens goes to the main window, which has the terminals. One
// window per project and tab; each tab remembers its window's place and size,
// and whether it stays on top. They close with the main window. A tab's
// window can move to another tab (switch-project-window-tab). 'note' is the
// project's note.md (public/note-panel.js), in a smaller window.
const PROJECT_WINDOW_TABS = new Set(['overview', 'plan', 'todos', 'files', 'git', 'knowledge', 'env', 'settings', 'note']);
// webview: the Git tab's Pull Requests can open a pull request's page in a panel.
const PROJECT_WINDOW_SPEC = { title: 'Switchboard', width: 1000, height: 760, minWidth: 520, minHeight: 360, onTop: false, webview: true };
const NOTE_WINDOW_SPEC = { title: 'Note', width: 560, height: 640, minWidth: 340, minHeight: 260, onTop: false };
// What a project window asks the main window to do (app.js runFromProjectWindow).
const PROJECT_WINDOW_RUN = new Set(['openSession', 'showSession', 'launchNewSession', 'openRawTerminalSession']);
// The events a project's page lives on. Terminal output, notices and the
// rest stay with the main window.
const PROJECT_WINDOW_EVENTS = new Set([
  'projects-changed', 'project-plan-changed', 'git-graph-repo-changed', 'git-graph-action-progress',
  'task-state-changed', 'project-tasks-changed', 'harnesses-changed', 'file-changed',
  'knowledge-changed',
]);
const projectWindows = new Map(); // `${projectId}\n${tab}` → BrowserWindow

addSink((channel, args) => {
  if (!PROJECT_WINDOW_EVENTS.has(channel)) return;
  for (const win of projectWindows.values()) if (!win.isDestroyed()) win.webContents.send(channel, ...args);
});

function openProjectWindow(projectId, tab, { bounds, inactive = false } = {}) {
  if (typeof projectId !== 'string' || !projectId || projectId.length > 200 || !PROJECT_WINDOW_TABS.has(tab)) return false;
  const key = `${projectId}\n${tab}`;
  const open = projectWindows.get(key);
  if (open && !open.isDestroyed()) {
    bringForward(open);
    return true;
  }
  const kind = `project-${tab}`;
  const sameKind = [...projectWindows.keys()].filter(k => k.endsWith(`\n${tab}`)).length;
  const spec = tab === 'note' ? NOTE_WINDOW_SPEC : PROJECT_WINDOW_SPEC;
  const win = createPageWindow(kind, spec, { offset: 24 * sameKind, bounds, inactive });
  projectWindows.set(key, win);
  win.loadFile(path.join(__dirname, 'public', 'index.html'), { query: { projectWindow: projectId, tab } });
  win.on('closed', () => {
    // Under the tab it shows now, which may not be the one it opened on.
    for (const [k, w] of projectWindows) if (w === win) projectWindows.delete(k);
    rememberOpenWindows();
  });
  rememberOpenWindows();
  return true;
}

// --- The Git History's Compare in a window of its own ---
// From the toolbar of the History or the Compare popup (git-graph-compare.js):
// index.html again, as a project window that shows only the comparison of
// 2 to 4 commits, oldest first. Not opened again at the next start, and
// without the events of a project's page: the commits it compares fix what
// it shows. They close with the main window.
const compareWindows = new Set();
const GIT_COMPARE_WINDOW_SPEC = { title: 'Compare', width: 1280, height: 820, minWidth: 640, minHeight: 420, onTop: false };
const GIT_COMPARE_HASH = /^(#uncommitted|[0-9a-f]{4,64})$/i;

function openGitCompareWindow(projectId, repoPath, hashes, labels, subjects) {
  if (typeof projectId !== 'string' || !projectId || projectId.length > 200) return false;
  if (typeof repoPath !== 'string' || !repoPath || repoPath.length > 4096) return false;
  if (!Array.isArray(hashes) || hashes.length < 2 || hashes.length > 4) return false;
  if (!hashes.every(hash => typeof hash === 'string' && GIT_COMPARE_HASH.test(hash))) return false;
  const names = hashes.map((_, i) => String((Array.isArray(labels) && labels[i]) || '').slice(0, 60));
  const titles = hashes.map((_, i) => String((Array.isArray(subjects) && subjects[i]) || '').slice(0, 200));
  const win = createPageWindow('git-compare', GIT_COMPARE_WINDOW_SPEC, { offset: 24 * compareWindows.size });
  compareWindows.add(win);
  win.loadFile(path.join(__dirname, 'public', 'index.html'), {
    query: { projectWindow: projectId, tab: 'git', compare: JSON.stringify({ repo: repoPath, hashes, labels: names, subjects: titles }) },
  });
  win.on('closed', () => compareWindows.delete(win));
  return true;
}

ipcMain.handle('open-git-compare-window', (_event, projectId, repoPath, hashes, labels, subjects) => openGitCompareWindow(projectId, repoPath, hashes, labels, subjects));

// --- A file of the Git History in a window of its own ---
// From the file open in a record of the History (project-git-graph-view.js
// gitGraphOpenFileWindow): index.html again, as a project window that shows
// only that file's diff (or the file at a revision), which can stay above the
// others with its pin. A new window at each click, a little lower and to the
// right of the one before. Not opened again at the next start; they close
// with the main window.
const fileWindows = new Set();
const GIT_FILE_WINDOW_SPEC = { title: 'Diff', width: 1100, height: 780, minWidth: 520, minHeight: 360, onTop: false };
const GIT_FILE_FROM_REV = /^([0-9a-f]{4,64}\^?|HEAD)$/i;
const GIT_FILE_TO_REV = /^[0-9a-f]{4,64}$/i;
const GIT_FILE_KINDS = new Set(['diff', 'working', 'revision']);

/** The file a window shows, checked and trimmed; null when it is not one. */
function gitFileWindowSpec(file) {
  if (!file || typeof file !== 'object') return null;
  const kind = GIT_FILE_KINDS.has(file.kind) ? file.kind : null;
  if (!kind) return null;
  if (typeof file.path !== 'string' || !file.path || file.path.length > 4096) return null;
  if (file.oldPath != null && (typeof file.oldPath !== 'string' || file.oldPath.length > 4096)) return null;
  const fromRev = file.fromRev == null ? null : file.fromRev;
  const toRev = file.toRev == null ? null : file.toRev;
  if (fromRev !== null && (typeof fromRev !== 'string' || !GIT_FILE_FROM_REV.test(fromRev))) return null;
  if (toRev !== null && (typeof toRev !== 'string' || !GIT_FILE_TO_REV.test(toRev))) return null;
  if (kind === 'revision' ? !toRev : !fromRev) return null;
  const status = typeof file.status === 'string' && /^[a-z]{1,20}$/.test(file.status) ? file.status : null;
  return {
    kind, path: file.path, oldPath: file.oldPath || null, status, fromRev, toRev,
    label: String(file.label || '').slice(0, 60), subject: String(file.subject || '').slice(0, 200),
  };
}

function openGitFileWindow(projectId, repoPath, file) {
  if (typeof projectId !== 'string' || !projectId || projectId.length > 200) return false;
  if (typeof repoPath !== 'string' || !repoPath || repoPath.length > 4096) return false;
  const spec = gitFileWindowSpec(file);
  if (!spec) return false;
  const win = createPageWindow('git-file', GIT_FILE_WINDOW_SPEC, { offset: 24 * fileWindows.size });
  fileWindows.add(win);
  win.loadFile(path.join(__dirname, 'public', 'index.html'), {
    query: { projectWindow: projectId, tab: 'git', file: JSON.stringify({ repo: repoPath, ...spec }) },
  });
  win.on('closed', () => fileWindows.delete(win));
  return true;
}

ipcMain.handle('open-git-file-window', (_event, projectId, repoPath, file) => openGitFileWindow(projectId, repoPath, file));

// --- Any file in a window of its own ---
// A file dropped on the sidebar's "Open in new window" half (files-drop.js),
// or popped out of the Files tab's editor: file-window.html, an editor for
// that file alone, which can stay above the others with its pin. A new window
// for each file, a little lower and to the right of the one before. Not
// opened again at the next start; they close with the main window.
const viewerFileWindows = new Set();
const FILE_WINDOW_SPEC = { title: 'File', width: 1000, height: 760, minWidth: 480, minHeight: 320, onTop: false };

// The editor reloads the file when it changes on disk (viewer-panel.js).
addSink((channel, args) => {
  if (channel !== 'file-changed') return;
  for (const win of viewerFileWindows) if (!win.isDestroyed()) win.webContents.send(channel, ...args);
});

function openFileWindow(filePath) {
  const file = openedFiles.existingFilePath(filePath);
  if (!file) return false;
  const win = createPageWindow('file', { ...FILE_WINDOW_SPEC, title: path.basename(file) }, { offset: 24 * viewerFileWindows.size });
  viewerFileWindows.add(win);
  win.loadFile(path.join(__dirname, 'public', 'file-window.html'), { query: { file } });
  win.on('closed', () => viewerFileWindows.delete(win));
  return true;
}

ipcMain.handle('open-file-window', (_event, filePath) => openFileWindow(filePath));

// --- A pull request's page on GitHub in a window of its own ---
// From the icon before Merge in the Pull Requests view, or from the panel that
// shows the page inside the app (public/web-page-view.js): web-window.html, a
// <webview> with its toolbar, which can stay above the others with its pin.
// The same address already in a window brings that one forward; any other
// opens a new one, a little lower and to the right. Not opened again at the
// next start; they close with the main window.
const webWindows = new Map(); // BrowserWindow → the address it opened on
const WEB_WINDOW_SPEC = { title: 'GitHub', width: 1200, height: 860, minWidth: 520, minHeight: 360, onTop: false, webview: true };

function openWebWindow(url, title) {
  if (!webPage.isWebPageUrl(url)) return false;
  for (const [win, opened] of webWindows) {
    if (!win.isDestroyed() && opened === url) {
      bringForward(win);
      return true;
    }
  }
  const name = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || WEB_WINDOW_SPEC.title;
  const win = createPageWindow('web-page', { ...WEB_WINDOW_SPEC, title: name }, { offset: 24 * webWindows.size });
  webWindows.set(win, url);
  win.loadFile(path.join(__dirname, 'public', 'web-window.html'), { query: { url, title: name } });
  win.on('closed', () => webWindows.delete(win));
  return true;
}

ipcMain.handle('open-web-window', (_event, url, title) => openWebWindow(url, title));

// --- The terminal's Commands palette in a window of its own ---
// From the palette's window button (public/command-catalog-view.js):
// commands.html for one session, filling the window and kept open, above the
// others until its pin says otherwise. A pick types into that session. The
// same session's window comes forward; another session's opens a new one, a
// little lower and to the right. Not opened again at the next start; they
// close with the main window.
const commandsWindows = new Map(); // session id → BrowserWindow
const COMMANDS_WINDOW_SPEC = { title: 'Commands', width: 760, height: 600, minWidth: 420, minHeight: 300, onTop: true };
// What the palette's rules read of the session: whether its CLI works or waits for an answer.
const COMMANDS_WINDOW_EVENTS = new Set(['cli-busy-state', 'terminal-notification', 'command-catalog-updated']);

addSink((channel, args) => {
  if (!COMMANDS_WINDOW_EVENTS.has(channel)) return;
  for (const win of commandsWindows.values()) if (!win.isDestroyed()) win.webContents.send(channel, ...args);
});

function openCommandsWindow(info) {
  const sessionId = typeof info?.sessionId === 'string' ? info.sessionId.trim() : '';
  if (!sessionId) return false;
  const open = commandsWindows.get(sessionId);
  if (open && !open.isDestroyed()) {
    bringForward(open);
    return true;
  }
  const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const title = text(info.title, 200);
  const win = createPageWindow('commands', { ...COMMANDS_WINDOW_SPEC, title: title ? `Commands · ${title}` : COMMANDS_WINDOW_SPEC.title }, { offset: 24 * commandsWindows.size });
  commandsWindows.set(sessionId, win);
  const query = { session: sessionId, title };
  for (const key of ['runtime', 'type', 'cli']) if (text(info[key], 40)) query[key] = text(info[key], 40);
  win.loadFile(path.join(__dirname, 'public', 'commands.html'), { query });
  win.on('closed', () => { if (commandsWindows.get(sessionId) === win) commandsWindows.delete(sessionId); });
  return true;
}

ipcMain.handle('open-commands-window', (_event, info) => openCommandsWindow(info));

// The Improve prompt window in a window of its own, for the session it was
// opened for (prompt-improver-windows.js). Insert and Replace go to the main
// window, which has the session's terminal, and bring it forward.
const PROMPT_IMPROVER_WINDOW_SPEC = { title: 'Improve prompt', width: 780, height: 660, minWidth: 460, minHeight: 360, onTop: false };
const promptImproverWindows = createPromptImproverWindows({
  openWindow: ({ token, title }) => {
    const win = createPageWindow('prompt-improver', { ...PROMPT_IMPROVER_WINDOW_SPEC, title: title ? `Improve prompt · ${title}` : PROMPT_IMPROVER_WINDOW_SPEC.title });
    win.loadFile(path.join(__dirname, 'public', 'prompt-improver.html'), { query: { token } });
    return win;
  },
  bringForward,
  mainWindow: () => mainWindow,
});

ipcMain.handle('open-prompt-improver-window', (_event, state) => promptImproverWindows.open(state));
ipcMain.handle('get-prompt-improver-window-state', (_event, token) => promptImproverWindows.take(token));
ipcMain.handle('apply-prompt-improvement', async (_event, request) => {
  const result = await promptImproverWindows.apply(request);
  if (result.ok && mainWindow && !mainWindow.isDestroyed()) bringForward(mainWindow);
  return result;
});
ipcMain.on('prompt-improver-applied', (_event, id, result) => { promptImproverWindows.applied(id, result); });

// --- The windows of their own open again at the next start ---
// The list in the settings follows every window that opens or closes. When
// the app quits, or the main window closes and takes the others with it,
// the list is taken as it is and stays so (the closing that follows does
// not empty it) until the next main window has opened them again.
let openWindowsFrozen = true; // until the start has opened the saved ones

function rememberOpenWindows() {
  if (openWindowsFrozen) return;
  try {
    const global = getSetting('global') || {};
    global.openWindows = describeOpenWindows(toolWindows, projectWindows);
    setSetting('global', global);
  } catch (err) {
    log.warn(`[windows] could not remember the open windows: ${err.message}`);
  }
}

function freezeOpenWindows() {
  if (openWindowsFrozen) return;
  rememberOpenWindows();
  openWindowsFrozen = true;
}

function restoreOpenWindows() {
  if (!openWindowsFrozen) return;
  let list = [];
  try {
    list = windowsToRestore((getSetting('global') || {}).openWindows, {
      toolKinds: new Set(Object.keys(TOOL_WINDOWS)),
      projectTabs: PROJECT_WINDOW_TABS,
      projectExists: id => !!dbModule.getProject(id),
    });
  } catch (err) {
    log.warn(`[windows] could not read the windows to open again: ${err.message}`);
  }
  for (const entry of list) {
    try {
      if (entry.kind === 'project') openProjectWindow(entry.projectId, entry.tab, { bounds: entry.bounds, inactive: true });
      else openToolWindow(entry.kind, { bounds: entry.bounds, inactive: true });
    } catch (err) {
      log.warn(`[windows] could not open ${entry.kind} again: ${err.message}`);
    }
  }
  if (list.length) log.info(`[windows] opened again ${list.length} window(s) of their own`);
  openWindowsFrozen = false;
  rememberOpenWindows();
}

/** The kind of the tool window a page runs in ('project-git' for a project's Git tab), or null for the main window. */
function toolWindowKindOf(webContents) {
  for (const [kind, win] of toolWindows) if (!win.isDestroyed() && win.webContents === webContents) return kind;
  for (const [key, win] of projectWindows) if (!win.isDestroyed() && win.webContents === webContents) return `project-${key.split('\n')[1]}`;
  for (const win of compareWindows) if (!win.isDestroyed() && win.webContents === webContents) return 'git-compare';
  for (const win of fileWindows) if (!win.isDestroyed() && win.webContents === webContents) return 'git-file';
  for (const win of viewerFileWindows) if (!win.isDestroyed() && win.webContents === webContents) return 'file';
  for (const win of webWindows.keys()) if (!win.isDestroyed() && win.webContents === webContents) return 'web-page';
  return null;
}

ipcMain.handle('open-tool-window', (_event, kind) => { openToolWindow(String(kind)); return true; });
ipcMain.handle('open-project-window', (_event, projectId, tab) => openProjectWindow(projectId, tab));

// The project's tab already in a window of its own comes forward: true, or
// false when there is none (the Note opens floating then).
ipcMain.handle('focus-project-window', (_event, projectId, tab) => {
  if (typeof projectId !== 'string' || !PROJECT_WINDOW_TABS.has(tab)) return false;
  const win = projectWindows.get(`${projectId}\n${tab}`);
  if (!win || win.isDestroyed()) return false;
  bringForward(win);
  return true;
});

// A tab's window moving to another tab from the strip in its header. When
// that tab has a window already, that one comes forward and this one stays.
ipcMain.handle('switch-project-window-tab', (event, tab) => {
  if (!PROJECT_WINDOW_TABS.has(tab) || tab === 'note') return { switched: false };
  const entry = [...projectWindows].find(([, win]) => !win.isDestroyed() && win.webContents === event.sender);
  if (!entry) return { switched: false };
  const [key, win] = entry;
  const [projectId, current] = key.split('\n');
  if (current === 'note') return { switched: false };
  const target = `${projectId}\n${tab}`;
  if (target === key) return { switched: true };
  const other = projectWindows.get(target);
  if (other && !other.isDestroyed()) {
    bringForward(other);
    return { switched: false };
  }
  projectWindows.delete(key);
  projectWindows.set(target, win);
  rememberOpenWindows();
  return { switched: true };
});

// A project window opening a session: the main window does it and comes forward.
ipcMain.handle('project-window-run', (event, name, args) => {
  const fromProjectWindow = [...projectWindows.values()].some(win => !win.isDestroyed() && win.webContents === event.sender);
  if (!fromProjectWindow || !PROJECT_WINDOW_RUN.has(name) || !Array.isArray(args)) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  bringForward(mainWindow);
  mainWindow.webContents.send('project-window-run', name, args);
  return true;
});

ipcMain.handle('get-window-on-top', (event) => !!BrowserWindow.fromWebContents(event.sender)?.isAlwaysOnTop());

ipcMain.handle('set-window-on-top', (event, onTop) => {
  const kind = toolWindowKindOf(event.sender);
  const win = kind && BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const value = !!onTop;
  win.setAlwaysOnTop(value, 'floating');
  saveToolWindowSettings(kind, { onTop: value });
  return value;
});

// Open from the Task Manager's window: the main window comes forward and shows
// the session or the task's output (process-viewer.js onTaskManagerOpenOwner).
ipcMain.handle('task-manager-open-owner', (_event, owner) => {
  if (!isProcessOwner(owner) || !mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('task-manager-open-owner', owner);
  return true;
});

// The Task Manager's Stop: the usual stop, then nothing of the tree left behind,
// not even a child that ignored the hangup (see stopTree).
ipcMain.handle('stop-owner', async (_event, owner) => {
  const rootPid = ownerRootPid(owner);
  if (!rootPid) return { ok: false, error: 'Not running' };
  return processMonitor.stopTree(rootPid, () => {
    if (owner.kind === 'task') return taskManager.stopTask(owner.projectPath, owner.label);
    const session = ownedSession(owner.id);
    if (!session) return null;
    session.stopRequested = true;
    return session.pty.kill();
  });
});

// One process inside a session's or task's tree: SIGTERM, or SIGKILL when forced.
ipcMain.handle('kill-owned-process', async (_event, owner, pid, force) => {
  const rootPid = ownerRootPid(owner);
  if (!rootPid) return { ok: false, error: 'Not running' };
  return processMonitor.killInTree(rootPid, Number(pid), force ? 'SIGKILL' : 'SIGTERM');
});

// The way out when Stop is not enough: SIGKILL the whole tree, still counted as stopped by the user.
ipcMain.handle('force-stop-owner', async (_event, owner) => {
  const rootPid = ownerRootPid(owner);
  if (!rootPid) return { ok: false, error: 'Not running' };
  if (owner.kind === 'session') ownedSession(owner.id).stopRequested = true;
  else taskManager.stopTask(owner.projectPath, owner.label);
  return processMonitor.killTree(rootPid);
});

// --- IPC: toggle-star ---
ipcMain.handle('toggle-star', (_event, sessionId) => {
  const result = toggleStar(sessionId);
  // A pin from a phone shows in the window, and the other way round.
  notifyRendererProjectsChanged('sessions');
  return result;
});

// --- IPC: set-pinned-order ---
// A project's pinned sessions in the order they were dragged into
// (pinned-order.js), from the sidebar or a phone.
ipcMain.handle('set-pinned-order', (_event, sessionIds) => {
  if (!Array.isArray(sessionIds) || !sessionIds.every(id => typeof id === 'string')) return { error: 'The order is a list of sessions' };
  setPinnedOrder(sessionIds);
  notifyRendererProjectsChanged('sessions');
  return { ok: true };
});

// --- IPC: rename-session ---
ipcMain.handle('rename-session', (_event, sessionId, name) => {
  setName(sessionId, name || null);
  // Update search index title to include the new name
  const cached = getCachedSession(sessionId);
  const summary = cached?.summary || '';
  updateSearchTitle(sessionId, 'session', (name ? name + ' ' : '') + summary);
  // A rename from a phone shows in the window, and the other way round.
  notifyRendererProjectsChanged('sessions');
  return { name: name || null };
});

function readSessionViewerEntries(row) {
  // The harness owns its transcript naming and its on-disk format. Normalize
  // here so neither transcript consumer needs runtime-specific branches.
  const harness = getHarness(row.runtime);
  // A CLI keeping its sessions in a database reads them itself.
  if (harness.readEntriesSince) return harness.readEntriesSince(row, 0).entries;
  const jsonlPath = transcriptPath(row);
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return harness.toViewerEntries(entries);
}

ipcMain.handle('read-session-jsonl', (_event, sessionId) => {
  const row = getCachedSession(sessionId);
  if (!row) return { error: 'Session not found in cache' };
  try {
    return { entries: readSessionViewerEntries(row) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-session-last-message', (_event, sessionId) => {
  const row = getCachedSession(sessionId);
  if (!row) return { error: 'Session not found in cache' };
  try {
    const { text, truncated } = lastAssistantMessage(readSessionViewerEntries(row));
    return { text, truncated };
  } catch (err) {
    return { error: err.message };
  }
});

// The entries written since `cursor` (from the previous call: a byte offset, or
// a database CLI's own position), so a client following a live session does
// not re-read the whole transcript.
ipcMain.handle('read-session-entries', (_event, sessionId, cursor) => {
  const row = getCachedSession(sessionId);
  if (!row) return { error: 'Session not found in cache' };
  try {
    return readViewerEntriesSince(getHarness(row.runtime), row, cursor || 0);
  } catch (err) {
    return { error: err.message };
  }
});

// The last `count` entries of a transcript, for a phone opening a long
// conversation: all of it would take seconds to decrypt and lay out there.
// `earlier` says how many are left out; `cursor` follows on as above.
ipcMain.handle('read-session-tail', (_event, sessionId, count) => {
  const row = getCachedSession(sessionId);
  if (!row) return { error: 'Session not found in cache' };
  try {
    const read = readViewerEntriesSince(getHarness(row.runtime), row, 0);
    const entries = read.entries;
    const kept = entries.slice(-count);
    return { entries: kept, cursor: read.cursor, earlier: entries.length - kept.length };
  } catch (err) {
    return { error: err.message };
  }
});

// Busy, waiting-for-the-user and starting, for every live PTY at once.
ipcMain.handle('get-session-states', () => sessionStates(activeSessions));

// --- Remote access: the mobile companion app ---
// Off until the sidebar switch turns it on (remote-server.js).

// A dev or test instance (its own data dir) gets its own default port, so it
// can run next to the installed app.
const REMOTE_DEFAULT_PORT = process.env.SWITCHBOARD_DATA_DIR ? 47110 : 47100;
const desktopName = os.hostname().replace(/\.local$/, '');

function remoteAccessSettings() {
  const stored = getSetting('remoteAccess') || {};
  return { enabled: !!stored.enabled, port: Number.isInteger(stored.port) ? stored.port : REMOTE_DEFAULT_PORT };
}

// --- Remote terminals and launches ---

const terminalFanout = createTerminalFanout();

/** A live session, by the id the caller has for it. */
function liveSession(sessionId) {
  const session = activeSessions.get(sessionId);
  return session && !session.exited ? session : null;
}

/**
 * Resize a PTY for a phone. Unlike a window resize, this does not stop
 * buffering for a moment: the phone often types right after, and that
 * output must reach the replay; a redrawn prompt in it is the lesser harm.
 */
function resizeForRemote(session, cols, rows) {
  try { session.pty.resize(cols, rows); } catch {}
  terminalFanout.resized(session, cols, rows);
}

/** Give a PTY the window's size back, if this phone had fitted it to its screen. */
function releaseRemoteFit(session, client) {
  if (session.remoteFit !== client) return null;
  session.remoteFit = null;
  const { cols, rows } = session.desktopSize || { cols: 120, rows: 30 };
  resizeForRemote(session, cols, rows);
  return { cols, rows };
}

// Unread and needs-you marks, and what phones have on screen.
const sessionNotices = createSessionNotices({ emit });
addSink(sessionNotices.eventSink);
ipcMain.on('session-notices', (_event, notices) => sessionNotices.publish(notices));

// A phone's change to a line of the plan, only if the line still holds the
// text the phone saw there (remote-plan.js).
function remotePlanEdit(channel) {
  return async (_client, projectId, kind, line, value, expected) => {
    const plan = await getHandler('get-project-plan').fn(null, projectId);
    if (plan?.error) return plan;
    if (planLineText(plan, kind, line) !== expected) return { error: 'The plan changed meanwhile. Pull to refresh and try again.' };
    return getHandler(channel).fn(null, projectId, kind, line, value);
  };
}

// Files a phone may list, read and save: inside a project's folder or one attached to it.
// Claude's plans too, to read and save only: the chat opens the plan a session wrote.
const phoneRoots = () => [...dbModule.listProjects().map(p => p.root), ...dbModule.listAllProjectFolders().map(f => f.path)];
const phoneFiles = createPhoneFiles({ roots: phoneRoots, readRoots: () => [PLANS_DIR], shell, uploadsDir: path.join(dbModule.DATA_DIR, 'uploads') });
const phoneTasks = createRemoteTasks({ roots: phoneRoots, taskManager });
const phoneAttachments = createAttachments({ dir: path.join(dbModule.DATA_DIR, 'attachments') });

// Remote methods that need to know which phone is calling, or are not IPC handlers.
const remoteLocalMethods = {
  'attach-terminal': (client, sessionId, sinceSeq) => {
    const session = liveSession(sessionId);
    if (!session) throw new Error('This session is not running');
    return terminalFanout.attach(session, sessionId, client, sinceSeq ?? null);
  },
  'detach-terminal': (client, sessionId) => {
    const session = activeSessions.get(sessionId);
    if (session) {
      terminalFanout.detach(session, client);
      releaseRemoteFit(session, client);
    }
    return true;
  },
  // The desktop reflows too while a phone has the PTY at its size.
  'fit-terminal': (client, sessionId, cols, rows) => {
    const session = liveSession(sessionId);
    if (!session) throw new Error('This session is not running');
    session.remoteFit = client;
    resizeForRemote(session, cols, rows);
    return { cols, rows };
  },
  'unfit-terminal': (client, sessionId) => {
    const session = activeSessions.get(sessionId);
    const size = session ? releaseRemoteFit(session, client) : null;
    return size || (session?.pty ? { cols: session.pty.cols, rows: session.pty.rows } : null);
  },
  'get-session-notices': () => sessionNotices.snapshot(),
  'mark-read': (_client, sessionId) => sessionNotices.setRead(sessionId, true),
  'mark-unread': (_client, sessionId) => sessionNotices.setRead(sessionId, false),
  'set-viewing': (client, sessionId) => sessionNotices.setViewing(client, sessionId || null),
  'list-pending-diffs': () => listPendingDiffs(),
  'run-schedule': (_client, scheduleId) => sessionLauncher.runSchedule(scheduleId),
  'list-folders': (_client, dir, hidden) => listFolders(dir || undefined, { hidden: !!hidden }),
  'create-folder': (_client, dir, name) => createFolder(dir, name),
  'list-project-directory': (_client, projectPath, relativePath) => phoneFiles.list(projectPath, relativePath),
  'read-project-file': (_client, projectPath, relativePath) => phoneFiles.read(projectPath, relativePath),
  'read-project-file-chunk': (_client, projectPath, relativePath, offset) => phoneFiles.chunk(projectPath, relativePath, offset),
  'locate-file': (_client, filePath, cwd) => phoneFiles.locate(filePath, cwd),
  'save-project-file': (_client, projectPath, relativePath, content, expectedVersion) => phoneFiles.save(projectPath, relativePath, content, expectedVersion),
  'manage-project-entry': (_client, projectPath, relativePath, action, newName) => phoneFiles.manage(projectPath, relativePath, action, newName),
  'trash-project-entries': (_client, projectPath, relativePaths) => phoneFiles.trashMany(projectPath, relativePaths),
  'upload-project-file-chunk': (_client, projectPath, folderRelative, name, piece) => phoneFiles.upload(projectPath, folderRelative, name, piece),
  'create-project-entry': (_client, projectPath, folderRelative, name, kind) => phoneFiles.create(projectPath, folderRelative, name, kind),
  'duplicate-project-entry': (_client, projectPath, relativePath) => phoneFiles.duplicate(projectPath, relativePath),
  'paste-project-entry': (_client, sourcePath, sourceRelative, targetPath, targetRelative, mode) => phoneFiles.paste(sourcePath, sourceRelative, targetPath, targetRelative, mode),
  'get-file-timeline': (_client, projectPath, relativePath) => phoneFiles.timeline(projectPath, relativePath),
  'get-file-timeline-diff': (_client, projectPath, relativePath, hash, repoPath, oldPath) => phoneFiles.timelineDiff(projectPath, relativePath, hash, repoPath, oldPath),
  'search-project-files': (client, root, options) => phoneFiles.search(root, options, client),
  'replace-in-project-files': (_client, root, options) => phoneFiles.replace(root, options),
  'add-project-file-bytes': (_client, projectId, name, base64) => projects.addProjectFileBytes(projectId, name, Buffer.from(base64, 'base64')),
  'save-session-attachment': (_client, sessionId, name, base64) => phoneAttachments.save(sessionId, name, Buffer.from(base64, 'base64')),
  ...phoneTasks.methods,
  'set-plan-item': remotePlanEdit('set-plan-item'),
  'edit-plan-item': remotePlanEdit('edit-plan-item'),
  'mcp-diff-response': (_client, sessionId, diffId, action) => ({ ok: resolvePendingDiff(sessionId, diffId, action, null) }),
};

function remoteClientClosed(client) {
  sessionNotices.clientClosed(client);
  terminalFanout.detachClient(client);
  for (const session of new Set(activeSessions.values())) releaseRemoteFit(session, client);
}

// Start, resume or fork a session with an id minted here, through the same
// open-terminal handler the window uses.
const sessionLauncher = createSessionLauncher({
  openTerminal: (...args) => getHandler('open-terminal').fn(null, ...args),
  effectiveSettings,
  sessionConfig: require('./public/session-config'),
  getCachedSession,
  activeSessions,
  onLaunched: () => notifyRendererProjectsChanged('sessions'),
  resolveScheduleLaunch: (id) => projects.resolveScheduleLaunch(id),
});
ipcMain.handle('launch-session', (_event, spec) => sessionLauncher.launch(spec || {}));

const remoteAuth = createRemoteAuth({ nacl, getSetting, setSetting });
const remoteServer = createRemoteServer({
  protocol: createRemoteProtocol(nacl),
  auth: remoteAuth,
  api: createRemoteApi({ getHandler, localMethods: remoteLocalMethods }),
  log,
  appVersion: app.getVersion(),
  desktopName,
  // From the Internet a phone comes through a tunnel, with the access key.
  accessKey: () => remoteAuth.accessKey(),
  routes: () => remoteTunnels.routes(),
  onStatus: (status) => emit('remote-access-status', remoteAccessStatus(status)),
  onClientClosed: remoteClientClosed,
});
addSink(remoteServer.eventSink);

// Cloudflare and ngrok, for the Fork: they run while remote access is on.
const remoteTunnels = createRemoteTunnels({
  getSetting,
  setSetting,
  encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
  decrypt: (text) => safeStorage.decryptString(Buffer.from(text, 'base64')),
  spawn: require('child_process').spawn,
  fetch: (...args) => fetch(...args),
  log,
  port: () => remoteAccessSettings().port,
  configDir: path.join(app.getPath('userData'), 'tunnels'),
  onChange: () => emit('remote-access-status', remoteAccessStatus()),
});

// While remote access is on, a working session keeps the Mac from idle sleep.
const powerSaveGuard = createPowerSaveGuard({
  powerSaveBlocker,
  wanted: () => remoteServer.status().running && [...activeSessions.values()].some(s => !s.exited && s._cliBusy),
});
addSink((channel) => {
  if (channel === 'cli-busy-state' || channel === 'process-exited' || channel === 'remote-access-status') powerSaveGuard.update();
});

function remoteAccessStatus(status = remoteServer.status()) {
  const { enabled, port } = remoteAccessSettings();
  return { enabled, port, paired: remoteAuth.listDevices().length, running: status.running, error: status.error, clients: status.clients || [], tunnels: remoteTunnels.status() };
}

// A port held by another copy of the app (Switchboard, an older Switchboard Evolution or OmniboardV)
// frees up when that one quits. While access is switched on, keep trying,
// so paired phones get back in without anyone touching the switch.
const REMOTE_RETRY_MS = 5000;
let remoteRetryTimer = null;

async function startRemoteAccess() {
  clearTimeout(remoteRetryTimer);
  remoteRetryTimer = null;
  const started = await remoteServer.start(remoteAccessSettings().port);
  if (started.running) {
    remoteTunnels.start();
  } else if (remoteAccessSettings().enabled && /already in use/.test(started.error || '')) {
    remoteRetryTimer = setTimeout(() => {
      if (remoteAccessSettings().enabled && !remoteServer.status().running) startRemoteAccess();
    }, REMOTE_RETRY_MS);
    remoteRetryTimer.unref?.();
  }
  return started;
}

async function setRemoteAccessEnabled(enabled) {
  setSetting('remoteAccess', { ...remoteAccessSettings(), enabled });
  if (enabled) {
    await startRemoteAccess();
  } else {
    clearTimeout(remoteRetryTimer);
    remoteRetryTimer = null;
    remoteAuth.cancelPairing();
    remoteTunnels.stop();
    await remoteServer.stop();
  }
  return remoteAccessStatus();
}

ipcMain.handle('remote-access-status', () => remoteAccessStatus());
ipcMain.handle('remote-access-set-enabled', (_event, enabled) => setRemoteAccessEnabled(!!enabled));
ipcMain.handle('remote-access-set-port', async (_event, port) => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: 'Choose a port between 1024 and 65535' };
  setSetting('remoteAccess', { ...remoteAccessSettings(), port });
  if (remoteServer.status().running) {
    await remoteServer.stop();
    await remoteServer.start(port);
    remoteTunnels.portChanged();
  }
  return remoteAccessStatus();
});
ipcMain.handle('remote-access-start-pairing', () => {
  const status = remoteServer.status();
  if (!status.running) return { error: 'Turn remote access on first' };
  const { code, expiresAt } = remoteAuth.startPairing();
  const addresses = reachableAddresses(os.networkInterfaces(), os.hostname());
  const routes = remoteTunnels.routes();
  const link = pairingLink({ name: desktopName, addresses, port: status.port, publicKey: remoteAuth.identity().publicKey, code, expiresAt, accessKey: remoteAuth.accessKey(), routes });
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  return { qrSvg: qr.createSvgTag({ cellSize: 4, margin: 4 }), expiresAt, addresses, port: status.port, routes };
});
// Set up or remove Cloudflare (API token, domain, name) or ngrok (authtoken, optional domain).
ipcMain.handle('remote-tunnel-setup', async (_event, provider, params = {}) => {
  try {
    if (provider === 'cloudflare') return { status: await remoteTunnels.setupCloudflare(params) };
    if (provider === 'ngrok') return { status: remoteTunnels.setupNgrok(params) };
    return { error: 'Unknown tunnel' };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('remote-tunnel-remove', async (_event, provider, params = {}) => {
  try {
    if (provider === 'cloudflare') return { status: await remoteTunnels.removeCloudflare(params) };
    if (provider === 'ngrok') return { status: remoteTunnels.removeNgrok() };
    return { error: 'Unknown tunnel' };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('remote-access-cancel-pairing', () => { remoteAuth.cancelPairing(); return true; });
ipcMain.handle('remote-access-list-devices', () => remoteAuth.listDevices());
ipcMain.handle('remote-access-revoke-device', (_event, id) => {
  if (remoteAuth.revokeDevice(String(id || ''))) remoteServer.disconnectDevice(id);
  // Removing a device that was not connected changes no connection, only the
  // paired count the window shows.
  emit('remote-access-status', remoteAccessStatus());
  return remoteAuth.listDevices();
});

// --- IPC: archive-session ---

ipcMain.handle('archive-session', (_event, sessionId, archived) => {
  const val = archived ? 1 : 0;
  setArchived(sessionId, val);
  notifyRendererProjectsChanged('sessions');
  return { archived: val };
});

// --- IPC: open-terminal ---
/**
 * Follow a session's PTY: busy/idle and notifications from its OSC output,
 * the replay buffer, the window, and its exit. For a session started here and
 * for one herdr-core kept running while Switchboard was closed alike.
 */
function wireSessionPty(sessionId, session, harness) {
  const ptyProcess = session.pty;
  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;

    // Prompt marks for a plain terminal. Cheap on every chunk: the parse
    // returns immediately unless the chunk actually contains an OSC 133.
    if (session.activity) {
      const busy = session.activity.feedData(data);
      if (busy !== null) sendTerminalBusy(session, currentId, busy);
    }

    // OpenCode's status records (OSC 7501): one for the whole TUI, with no id,
    // and one per session it has open; the TUI's own is the PTY's state. A
    // record is sent only when it changes, so one cut by a chunk boundary
    // would never come again: the unfinished end of a chunk is kept and read
    // with the next one (only here, never sent twice to the terminal).
    if (harness?.parseStatusReport && (session._statusCarry || data.includes('\x1b'))) {
      const { reports, rest } = takeStatusRecords((session._statusCarry || '') + data);
      session._statusCarry = rest;
      for (const payload of reports) {
        const report = harness.parseStatusReport(payload);
        if (!report || report.id) continue;
        log.debug(`[OSC 7501] session=${currentId} state=${report.state} wasBusy=${!!session._cliBusy}`);
        for (const [channel, ...args] of applyStatusReport(session, report)) {
          if (channel === 'terminal-notification') log.info(`[OSC 7501] session=${currentId} → ATTENTION "${args[0]}"`);
          emit(channel, currentId, ...args);
        }
      }
    }

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle).
        // OSC 2 sets the title too: herdr-core repaints a kept session's title with it.
        if ((code === '0' || code === '2') && harness) {
          // What a title means is the harness's business: Claude marks idle with
          // ✳, codex drops the spinner prefix and says "Action Required" when
          // it is blocked on the user.
          const titleState = harness.parseTitleState(payload);
          // Remembered for the OSC 9;4 handler below, which trusts the title
          // over a progress report from any process in the PTY.
          if (titleState) session._titleBusy = titleState === 'busy';
          // The CLI's own title for the session: what it is called until its
          // transcript is indexed (session-cache.js), so the lists follow it.
          if (typeof harness.titleFromTerminal === 'function') {
            const cliTitle = harness.titleFromTerminal(payload);
            if (cliTitle && cliTitle !== session._cliTitle) {
              session._cliTitle = cliTitle;
              if (!getCachedSession(session.realSessionId || currentId)) notifyRendererProjectsChanged();
            }
          }
          const isBusy = titleState === 'busy';
          const isIdle = titleState === 'idle' || titleState === 'attention';
          log.debug(`[OSC 0] session=${currentId} state=${titleState || 'none'} wasBusy=${!!session._cliBusy}`);

          // A blocked session is announced by OSC 9 too, but only when the CLI's
          // notifications are on — which a session started before Switchboard
          // began forcing them is not. The title is the signal that is always
          // there, so it raises attention on its own. Latched, because the title
          // is rewritten on every repaint.
          if (titleState === 'attention') {
            if (!session._titleAttention) {
              session._titleAttention = true;
              log.info(`[OSC 0] session=${currentId} → ATTENTION "${payload}"`);
              emit('terminal-notification', currentId, payload, 'attention');
            }
          } else if (titleState) {
            session._titleAttention = false;
          }

          if (isBusy && markBusy(session)) {
            log.debug(`[OSC 0] session=${currentId} → BUSY`);
            emit('cli-busy-state', currentId, true);
          } else if (isIdle && markIdle(session)) {
            log.debug(`[OSC 0] session=${currentId} → IDLE`);
            emit('cli-busy-state', currentId, false);
          }
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\)
      const osc9Matches = data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          const progressState = progressBusyState({ level, titleBusy: !!session._titleBusy });
          log.debug(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" state=${progressState || 'none'} titleBusy=${!!session._titleBusy} wasBusy=${!!session._cliBusy}`);
          if (progressState === 'busy' && markBusy(session)) {
            log.debug(`[OSC 9;4] session=${currentId} → BUSY`);
            emit('cli-busy-state', currentId, true);
          } else if (progressState === 'idle' && markIdle(session)) {
            // The end of the progress run. Without acting on this, a busy state
            // raised by 9;4 could only be cleared by a spinner-to-idle title
            // change, which does not come for a slash command — the session sat
            // spinning until Claude's "waiting for your input" notice a full
            // minute later.
            log.debug(`[OSC 9;4] session=${currentId} → IDLE`);
            emit('cli-busy-state', currentId, false);
          }
        } else {
          // Regular notification (attention, permission, etc.). The harness
          // decides what its own wording means — codex says "Approval
          // requested: …" where Claude says "needs your permission…" — so the
          // renderer is handed a kind rather than re-deriving one from text.
          const kind = harness ? harness.classifyNotification(payload) : null;
          log.info(`[OSC 9] session=${currentId} kind=${kind || 'none'} message="${payload}"`);
          // Remembered for get-session-states, until the CLI is busy again.
          if (kind === 'attention') session._needsAttention = true;
          emit('terminal-notification', currentId, payload, kind);
        }
      }
    }

    // Standalone BEL (not part of an OSC sequence)
    if (data.includes('\x07') && !data.includes('\x1b]')) {
      log.info(`[BEL] session=${currentId}`);
    }

    // Track alternate screen mode (only if data contains the marker)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.altScreen = true;
        log.info(`[altscreen] session=${currentId} ON`);
      }
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.altScreen = false;
        log.info(`[altscreen] session=${currentId} OFF`);
      }
    }

    // Buffer output (skip resize-triggered redraws for plain terminals)
    if (!session._suppressBuffer) {
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1) {
        session.outputBufferSize -= session.outputBuffer.shift().length;
      }
    }

    emit('terminal-data', currentId, data);
    terminalFanout.feed(session, data);
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    session.exited = true;
    // Clean up MCP server
    const mcpId = session.realSessionId || sessionId;
    shutdownMcpServer(mcpId);
    session.mcpServer = null;

    const realId = session.realSessionId || sessionId;
    // The renderer needs to tell "the user ended this" from "this died" to
    // decide whether to tear the terminal down or leave it up with a banner.
    // A signal kill reports exitCode 0, so pass the signal and the
    // stop-session flag along rather than making it guess from the code.
    const stopRequested = !!session.stopRequested;
    if (!appIsQuitting) {
      emit('process-exited', realId, exitCode, signal, stopRequested);
      // If a fork/plan-accept transition re-keyed this session under realId
      // but the PTY exited before transition detection ran, also notify the
      // renderer for the original sessionId so it doesn't stay stuck as "Running".
      if (realId !== sessionId && activeSessions.has(sessionId)) {
        emit('process-exited', sessionId, exitCode, signal, stopRequested);
      }
    }
    activeSessions.delete(realId);
    // Clean up the original key too in case transition detection hasn't run yet
    activeSessions.delete(sessionId);
    // What the session wrote in the project folder (plans, notes) gets into its graph.
    if (!appIsQuitting && session.projectId) knowledge.sessionEnded(session.projectId);
  });
}

/** A session's PTY: in herdr-core when it runs, else node-pty. `labels` let a later start find it. */
function spawnSessionPty(file, args, options, labels) {
  if (hcEngine) {
    return hcEngine.spawn(file, args, { cwd: options.cwd, env: options.env, cols: options.cols, rows: options.rows, labels });
  }
  return pty.spawn(file, args, options);
}

/**
 * Start herdr-core unless it is turned off or missing, then pick up the
 * sessions it kept running while Switchboard was closed. Switchboard has its
 * own hc session (per data dir), started with the clean PTY environment:
 * the core keeps the environment of whoever starts it.
 */
async function startTerminalEngine() {
  const wanted = (getSetting('global') || {}).terminalEngine !== 'inside';
  if (!wanted) { terminalEngineStatus = { engine: 'inside', reason: 'Turned off in settings' }; return; }
  const found = locateHc({ userDataDir: app.getPath('userData') });
  if (!found) {
    terminalEngineStatus = { engine: 'inside', reason: 'herdr-core is not installed' };
    log.info('[hc] herdr-core not found; sessions run inside Switchboard');
    return;
  }
  const hcSession = hcSessionName(process.env.SWITCHBOARD_DATA_DIR);
  try {
    hcEngine = await createHcEngine({ binary: found.path, env: { ...cleanPtyEnv, HC_SESSION: hcSession }, log });
    terminalEngineStatus = { engine: 'hc', version: found.version, source: found.source, path: found.path, session: hcSession };
    log.info(`[hc] sessions run in herdr-core ${found.version} (${found.source}, session ${hcSession})`);
  } catch (err) {
    hcEngine = null;
    terminalEngineStatus = { engine: 'inside', reason: `herdr-core could not start: ${err.message}` };
    log.error('[hc] could not start herdr-core; sessions run inside Switchboard', err);
    return;
  }
  try { await adoptHcSessions(); } catch (err) { log.error('[hc] could not list kept sessions', err); }
}

/** The .jsonl files of a Claude project folder, and the slug of one session, as open-terminal reads them. */
function claudeFolderSnapshot(projectFolder, sessionId) {
  const dir = path.join(PROJECTS_DIR, projectFolder);
  let known = new Set();
  let slug = null;
  try { known = new Set(fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))); } catch {}
  try {
    for (const line of readHead(path.join(dir, sessionId + '.jsonl'), 8192).split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.slug) { slug = entry.slug; break; }
    }
  } catch {}
  return { known, slug };
}

/**
 * The sessions herdr-core kept running while Switchboard was closed: each is
 * rebuilt from its labels and attached again, its screen and history first,
 * so the list shows it running and opening it shows where it is.
 */
async function adoptHcSessions() {
  for (const record of await hcEngine.list()) {
    const labels = record.labels || {};
    const sessionId = labels.sid;
    if (!sessionId || activeSessions.has(sessionId)) continue;
    try {
      const isPlainTerminal = labels.kind === 'terminal';
      const runtimeId = isPlainTerminal ? null : (labels.runtime || DEFAULT_HARNESS);
      const harness = runtimeId ? getHarness(runtimeId) : null;
      const projectPath = labels.projectPath || record.cwd;
      const isClaude = runtimeId === DEFAULT_HARNESS;
      const projectFolder = isClaude ? encodeProjectPath(projectPath) : null;
      const { known, slug } = isClaude ? claudeFolderSnapshot(projectFolder, sessionId) : { known: new Set(), slug: null };
      const session = {
        pty: await hcEngine.adopt(record, { history: 1000 }),
        rendererAttached: false, exited: false,
        outputBuffer: [], outputBufferSize: 0, altScreen: false,
        projectPath, firstResize: true,
        projectFolder, knownJsonlFiles: known, sessionSlug: slug,
        isPlainTerminal, runtime: runtimeId, forkFrom: labels.forkFrom || null,
        activity: isPlainTerminal ? createTerminalActivity({
          shellName: labels.shell || 'zsh',
          canPollProcess: process.platform !== 'win32',
        }) : null,
        projectId: labels.projectId || null,
        trackId: labels.trackId || null,
        pendingLaunch: labels.pendingSpawnedAt ? {
          tag: labels.pendingTag || null, forkFrom: labels.forkFrom || null, projectPath, spawnedAt: Number(labels.pendingSpawnedAt),
        } : null,
        // Its IDE server went with the Switchboard that started it, and Claude
        // only reconnects to one that is back within seconds: its diffs now
        // show in the terminal until it is resumed.
        mcpServer: null, ideLost: labels.ide === '1',
        _openedAt: Number(labels.openedAt) || record.created_ms || Date.now(),
        adopted: true,
      };
      if (!isPlainTerminal && !session.projectId) {
        const meta = getMeta(sessionId);
        if (meta?.projectId) { session.projectId = meta.projectId; session.trackId = meta.trackId || null; }
      }
      activeSessions.set(sessionId, session);
      if (session.activity) startTerminalActivitySweep();
      wireSessionPty(sessionId, session, harness);
      log.info(`[hc] picked up ${sessionId} (${labels.kind || 'cli'}) running in ${record.address}`);
    } catch (err) {
      log.error(`[hc] could not pick up ${sessionId}`, err);
    }
  }
}

ipcMain.handle('get-terminal-engine', () => terminalEngineStatus);

// The startup files through which a terminal sources its environment files,
// written into the data folder once per run (shell-env.js).
let shellEnvWrappers = null;
function shellEnvWrapperDir() {
  if (!shellEnvWrappers) shellEnvWrappers = shellEnv.ensureWrappers(path.join(dbModule.DATA_DIR, 'shell-env'));
  return shellEnvWrappers;
}

/** The shell profile a session in `projectPath` starts with: the project's, the global one, the default. */
function effectiveShellProfileId(projectPath) {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  let profileId = SETTING_DEFAULTS.shellProfile;
  if (global.shellProfile !== undefined && global.shellProfile !== null) profileId = global.shellProfile;
  if (project.shellProfile !== undefined && project.shellProfile !== null) profileId = project.shellProfile;
  return profileId;
}

ipcMain.handle('open-terminal', async (_event, sessionId, projectPath, isNew, sessionOptions) => {
  if (!mainWindow) return { ok: false, error: 'no window' };
  await sessionsReady;

  const isPlainTerminal = sessionOptions?.type === 'terminal';
  if (shouldBlockArchivedSession({
    isNew,
    isPlainTerminal,
    archived: getMeta(sessionId)?.archived,
  })) {
    return { ok: false, error: 'Session is archived. Unarchive it before resuming.' };
  }

  // Reattach to existing session
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // The replay answers this window's request, so it goes to the window
    // only; a broadcast would repeat the backlog in every other client.
    // If TUI is in alternate screen mode, send escape to switch into it
    if (session.altScreen && !session.isPlainTerminal) {
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?1049h');
    }

    // Send buffered output for reattach
    for (const chunk of session.outputBuffer) {
      mainWindow.webContents.send('terminal-data', sessionId, chunk);
    }

    if (!session.isPlainTerminal) {
      // Hide cursor after buffer replay — the live PTY stream or resize nudge
      // will re-show it at the correct position, avoiding a stale cursor artifact
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?25l');
    }

    return { ok: true, reattached: true, mcpActive: !!session.mcpServer, ideLost: !!session.ideLost };
  }

  // Spawn new PTY
  if (!fs.existsSync(projectPath)) {
    return { ok: false, error: `project directory no longer exists: ${projectPath}` };
  }

  // A session that never wrote a transcript cannot be resumed — the CLI has no
  // record of the id, and asking it to resume one produces an error the user
  // can do nothing about ("No saved session found with ID ..."). Start it
  // fresh instead, which is what re-opening a session that never got going
  // means in practice.
  const cachedSession = getCachedSession(sessionId);
  const startFresh = shouldStartFresh({
    isNew,
    isPlainTerminal,
    hasCachedSession: !!cachedSession,
    resumeExisting: !!sessionOptions?.resumeExisting,
  });
  if (startFresh && !isNew && !isPlainTerminal) {
    log.info(`[open-terminal] ${sessionId} has no transcript; starting a new session instead of resuming`);
  }

  // A session that belongs to a project gets the project folder and every
  // attached folder as extra directories, so the brief loads wherever it
  // starts and the agent can edit the repos. New sessions say which project
  // in their options; resumed ones are looked up by their assignment.
  let projectEnv = {};
  // A fork of a project session belongs to the same project and track, even
  // when it is started from the Sessions tab where no project is in play.
  if (!isPlainTerminal && sessionOptions?.forkFrom && !sessionOptions.projectId) {
    const source = getMeta(sessionOptions.forkFrom);
    if (source?.projectId) sessionOptions = { ...sessionOptions, projectId: source.projectId, trackId: source.trackId || null };
  }
  if (!isPlainTerminal) {
    const launchProjectId = sessionOptions?.projectId || getMeta(sessionId)?.projectId || null;
    if (launchProjectId) {
      try {
        const ctx = projects.launchContext(launchProjectId, projectPath);
        if (ctx && ctx.addDirs.length) {
          sessionOptions = { ...(sessionOptions || {}), addDirs: projects.mergeAddDirs(sessionOptions?.addDirs, ctx.addDirs) };
          projectEnv = ctx.env;
        }
        // A project worktree is already the isolated checkout; asking Claude
        // for another one on top of it would nest worktrees.
        if (ctx?.worktree && sessionOptions?.worktree) {
          sessionOptions = { ...sessionOptions };
          delete sessionOptions.worktree;
          delete sessionOptions.worktreeName;
        }
      } catch (err) {
        log.error('[projects] launch context failed', err);
      }
    }
  }

  // The local.env.sh files the session's shell sources before it starts: in
  // the project folder only the project's, in an attached folder the
  // project's and then the folder's (projects.envFilesFor). A file that
  // cannot be read is logged and the session starts without it.
  let envFiles = [];
  const envProjectId = sessionOptions?.projectId || getMeta(sessionId)?.projectId || null;
  if (envProjectId) {
    try {
      envFiles = await projects.envFilesFor(envProjectId, projectPath);
    } catch (err) {
      log.error('[projects] environment files failed', err);
    }
  }

  // Which CLI drives this session. The cached row is authoritative for anything
  // that already exists on disk; the caller only gets to say for a brand-new
  // session, which has no row yet.
  const runtimeId = isPlainTerminal
    ? null
    : (cachedSession?.runtime || sessionOptions?.runtime || DEFAULT_HARNESS);
  const harness = runtimeId ? getHarness(runtimeId) : null;
  const isClaudeSession = runtimeId === DEFAULT_HARNESS;

  if (harness && !harness.buildLaunchArgs) {
    return { ok: false, error: `${harness.label} sessions cannot be launched yet` };
  }
  if (harness && harness.canFork === false && sessionOptions?.forkFrom) {
    return { ok: false, error: `${harness.label} sessions cannot be forked yet` };
  }

  // Claude asks about every --add-dir it does not trust, again in every session.
  // Ask once here instead, while someone is at the desktop; a phone or a
  // schedule says it is unattended and gets Claude's own question.
  if (isClaudeSession && sessionOptions?.addDirs && !sessionOptions?.unattended) {
    const dirs = String(sessionOptions.addDirs).split(',').map(d => d.trim()).filter(Boolean);
    const sender = _event?.sender ? BrowserWindow.fromWebContents(_event.sender) : null;
    await confirmFolderTrust(sender && !sender.isDestroyed() ? sender : mainWindow, dirs);
  }

  // Resolve shell profile from effective settings
  const effectiveProfileId = effectiveShellProfileId(projectPath);
  // WSL profiles only work for plain terminals — Claude CLI sessions need the
  // Windows shell because session data lives on the Windows filesystem.
  const requestedProfile = resolveShell(effectiveProfileId);
  const useWslProfile = isWslShell(requestedProfile.path) && isPlainTerminal;
  const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal)
    ? resolveShell('auto')
    : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  // For WSL, convert Windows path to /mnt/ path and pass via --cd;
  // the spawn cwd must remain a valid Windows path for wsl.exe itself.
  if (isWsl) {
    const wslCwd = windowsToWslPath(projectPath);
    shellExtraArgs.unshift('--cd', wslCwd);
  }
  log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);

  let knownJsonlFiles = new Set();
  let sessionSlug = null;
  let projectFolder = null;

  if (isClaudeSession) {
    // Snapshot existing .jsonl files before spawning (for new session + fork/plan detection)
    projectFolder = encodeProjectPath(projectPath);
    const claudeProjectDir = path.join(PROJECTS_DIR, projectFolder);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        knownJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }

    // Read slug from the session's jsonl file (for plan-accept detection)
    if (!startFresh) {
      try {
        const jsonlPath = path.join(claudeProjectDir, sessionId + '.jsonl');
        const head = readHead(jsonlPath, 8192);
        const firstLines = head.split('\n').filter(Boolean);
        for (const line of firstLines) {
          const entry = JSON.parse(line);
          if (entry.slug) { sessionSlug = entry.slug; break; }
        }
      } catch {}
    }
  }

  // A CLI that takes an id it did not make (OpenCode) is started on one in its
  // own format. The session stays under the id the caller knows until the CLI
  // records it, and is then re-keyed onto this one (resolvePendingLaunches).
  const launchId = (startFresh && harness?.newSessionId) ? harness.newSessionId() : sessionId;

  let ptyProcess;
  let mcpServer = null;
  try {
    if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command
      // Do not inherit Claude Code's nested-session marker if Switchboard was
      // itself launched from Claude; this is the user's shell and `claude`
      // should resolve normally from their profile/PATH.
      const terminalEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
      };
      delete terminalEnv.CLAUDECODE;
      // The environment files are sourced at the end of the shell's own
      // startup, through the startup files of shell-env.js.
      let terminalLaunch = { args: shellArgs(shell, undefined, shellExtraArgs), env: terminalEnv, files: [] };
      if (envFiles.length && !isWsl) {
        try {
          terminalLaunch = shellEnv.terminalEnvLaunch(shell, envFiles, { wrapperDir: shellEnvWrapperDir(), env: terminalEnv, args: terminalLaunch.args });
          if (terminalLaunch.files.length) log.info(`[env] ${sessionId} sources ${terminalLaunch.files.join(', ')}`);
        } catch (err) {
          log.error('[env] terminal startup files failed', err);
        }
      }
      ptyProcess = spawnSessionPty(shell, terminalLaunch.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: terminalLaunch.env,
      }, {
        sid: sessionId, kind: 'terminal', shell: path.basename(shell), projectPath,
        projectId: sessionOptions?.projectId, trackId: sessionOptions?.trackId,
      });
    } else {
      // Argv is built by the harness and quoted here, so a value can never be
      // spliced into the command line as shell syntax.
      // A project with the code graph on: its sessions get CBM's MCP server
      // when the agent has none of its own (knowledge.js sessionLaunch).
      try {
        const graph = knowledge.sessionLaunch(sessionOptions?.projectId || getMeta(sessionId)?.projectId || null, harness.id);
        if (graph.mcpConfig || graph.mcpServers) sessionOptions = { ...(sessionOptions || {}), ...graph };
      } catch (err) {
        log.warn('[knowledge] session launch', err.message);
      }
      const cliArgs = harness.buildLaunchArgs({
        sessionId: launchId, isNew: startFresh, options: sessionOptions,
      });

      let claudeCmd = harness.binary;
      if (cliArgs.length) claudeCmd += ' ' + quoteArgvForShell(shell, cliArgs);

      // customArgs is raw shell too, like preLaunchCmd below: the user's shell
      // does the quoting, e.g. --settings '{"outputStyle": "Learning"}'
      if (sessionOptions?.customArgs) {
        const custom = String(sessionOptions.customArgs);
        if (/[\r\n]/.test(custom)) {
          return { ok: false, error: 'customArgs must not contain newlines' };
        }
        claudeCmd += ' ' + custom;
      }

      // preLaunchCmd is raw shell by design (e.g. "aws-vault exec profile --") — block newlines only
      if (sessionOptions?.preLaunchCmd) {
        const pre = String(sessionOptions.preLaunchCmd);
        if (/[\r\n]/.test(pre)) {
          return { ok: false, error: 'preLaunchCmd must not contain newlines' };
        }
        claudeCmd = pre + ' ' + claudeCmd;
      }

      // The environment files come first, after the user's own startup files
      // (-l -i) and ahead of preLaunchCmd, so its wrapper and the CLI both see
      // the variables. Only bash, zsh and sh (envSourcePrefix).
      const envPrefix = envSourcePrefix(shell, envFiles);
      if (envPrefix) {
        claudeCmd = envPrefix + claudeCmd;
        log.info(`[env] ${sessionId} sources ${envFiles.join(', ')}`);
      }

      // Start MCP server for this session so Claude CLI sends diffs/file opens to Switchboard
      // (skip if user disabled IDE emulation in global settings)
      if (isClaudeSession && sessionOptions?.mcpEmulation !== false) {
        try {
          mcpServer = await startMcpServer(sessionId, [projectPath], log);
          claudeCmd += ' --ide';
        } catch (err) {
          log.error(`[mcp] Failed to start MCP server for ${sessionId}: ${err.message}`);
        }
      }

      const ptyEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
        ...projectEnv,
      };
      // A harness that cannot be told its session id up front gets to stamp the
      // environment instead, so its transcript can be recognised afterwards.
      if (startFresh && harness.launchEnv) Object.assign(ptyEnv, harness.launchEnv(sessionId));
      if (mcpServer) {
        ptyEnv.CLAUDE_CODE_SSE_PORT = String(mcpServer.port);
      }

      ptyProcess = spawnSessionPty(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
      }, {
        sid: sessionId, kind: 'cli', runtime: runtimeId, projectPath,
        projectId: sessionOptions?.projectId, trackId: sessionOptions?.trackId, forkFrom: sessionOptions?.forkFrom,
        ide: mcpServer ? '1' : undefined,
      });

    }
  } catch (err) {
    return { ok: false, error: `Error spawning PTY: ${err.message}` };
  }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    projectFolder, knownJsonlFiles, sessionSlug,
    isPlainTerminal, runtime: runtimeId, forkFrom: sessionOptions?.forkFrom || null,
    // The folders the CLI was given with --add-dir: their skills and commands
    // are the session's too (the command catalog, command-catalog.js).
    launchAddDirs: isPlainTerminal ? [] : String(sessionOptions?.addDirs || '').split(',').map(d => d.trim()).filter(Boolean),
    // A plain terminal has no CLI to report a busy state, so one is derived
    // from the shell's own OSC 133 prompt marks, or from the PTY's foreground
    // process when the shell sends none. A harness session already has the
    // OSC 0 / OSC 9;4 handlers below.
    activity: isPlainTerminal ? createTerminalActivity({
      shellName: path.basename(shell),
      // On Windows `pty.process` is the console title, not a process name.
      canPollProcess: process.platform !== 'win32',
    }) : null,
    // Plain terminals have no transcript row to carry their project filing.
    // Keep the launch context on the live PTY so renderer reloads can put a
    // terminal started in an attached folder back into the same project/track.
    projectId: sessionOptions?.projectId || null,
    trackId: sessionOptions?.trackId || null,
    // Set for a harness whose real session id only appears once its transcript
    // does; cleared by resolvePendingLaunches when the transcript is matched.
    pendingLaunch: (harness?.needsIdDetection?.({ isNew: startFresh, options: sessionOptions })) ? {
      // What identifies the launch once the CLI records it: the id it was
      // started on, or the env tag a CLI copies into its transcript (codex).
      tag: launchId !== sessionId ? launchId : (harness.originatorTag ? harness.originatorTag(sessionId) : null),
      // A fork is identified by its parent, not by our env tag — codex copies
      // the originator from the thread being forked.
      forkFrom: sessionOptions?.forkFrom || null,
      projectPath,
      spawnedAt: Date.now(),
    } : null,
    mcpServer, _openedAt: Date.now(),
  };
  activeSessions.set(sessionId, session);
  if (session.activity) startTerminalActivitySweep();
  // In herdr-core, what a later start needs to pick this session up again.
  if (ptyProcess.relabel) {
    ptyProcess.relabel({
      openedAt: session._openedAt,
      pendingTag: session.pendingLaunch?.tag || '',
      pendingSpawnedAt: session.pendingLaunch ? session.pendingLaunch.spawnedAt : '',
    });
  }

  // A session launched from a project is filed there. Recorded under whatever
  // id the session has right now; resolvePendingLaunches moves it to the real
  // id for a harness that only learns its id from the transcript.
  if (startFresh && !isPlainTerminal && sessionOptions?.projectId) {
    try {
      const assignment = projects.recordLaunchAssignment(sessionId, sessionOptions);
      if (assignment) {
        session.projectId = assignment.projectId;
        session.trackId = assignment.trackId;
        // Started from a phase or a todo on the project page.
        const item = sessionOptions.planItem;
        if (item?.itemText) projects.recordPlanLink(assignment.projectId, item.file, item.itemText, sessionId, 'started');
      }
    } catch (err) {
      log.error('[projects] could not record launch assignment', err);
    }
  }
  // Started by a schedule: the session remembers which, the schedule
  // remembers the run. Folder schedules have no project, so this is separate
  // from the assignment above.
  if (startFresh && !isPlainTerminal && sessionOptions?.scheduleId) {
    try { projects.recordScheduleRun(sessionOptions.scheduleId, sessionId); } catch (err) {
      log.error('[schedule] could not record the run', err);
    }
  }
  // A resumed project session is a project session too, for the plan watcher.
  if (!isPlainTerminal && !session.projectId) {
    const meta = getMeta(session.realSessionId || sessionId);
    if (meta?.projectId) { session.projectId = meta.projectId; session.trackId = meta.trackId || null; }
  }

  wireSessionPty(sessionId, session, harness);

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false, mcpActive: !!mcpServer };
});

// --- IPC: terminal-input (fire-and-forget) ---
ipcMain.on('terminal-input', (_event, sessionId, data) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    session.pty.write(data);
  }
});

// --- IPC: terminal-resize (fire-and-forget) ---
ipcMain.on('terminal-resize', (_event, sessionId, cols, rows) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    // The window's size, given back when a phone stops fitting the PTY to its own.
    session.desktopSize = { cols, rows };
    terminalFanout.resized(session, cols, rows);
    // For plain terminals, suppress buffering during resize to avoid
    // accumulating prompt redraws that pollute reattach replay
    if (session.isPlainTerminal) session._suppressBuffer = true;

    session.pty.resize(cols, rows);

    if (session.isPlainTerminal) {
      setTimeout(() => { session._suppressBuffer = false; }, 200);
    }

    // First resize: nudge to force TUI redraw on reattach (skip for plain terminals — causes duplicate prompts)
    if (session.firstResize && !session.isPlainTerminal) {
      session.firstResize = false;
      setTimeout(() => {
        try {
          session.pty.resize(cols + 1, rows);
          setTimeout(() => {
            try { session.pty.resize(cols, rows); } catch {}
          }, 50);
        } catch {}
      }, 50);
    }
  }
});

// --- IPC: close-terminal ---
ipcMain.on('close-terminal', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.rendererAttached = false;
    if (session.exited) {
      activeSessions.delete(sessionId);
    }
  }
});

// --- Plain-terminal activity: working, or waiting at the prompt? ---

/** One place to tell the renderer a terminal started or stopped working. */
function sendTerminalBusy(session, sessionId, busy) {
  session._cliBusy = busy;
  log.debug(`[terminal-activity] session=${sessionId} → ${busy ? 'BUSY' : 'IDLE'} ${JSON.stringify(session.activity.state())}`);
  emit('cli-busy-state', sessionId, busy);
}

// One sweep for every tracked terminal rather than a timer each. Reading
// `pty.process` costs ~18us, and only a shell that sends no prompt marks is
// read at all, so 50 terminals stay well under a millisecond per sweep.
const TERMINAL_ACTIVITY_INTERVAL_MS = 500;
let terminalActivityTimer = null;

function sweepTerminalActivity() {
  let tracked = 0;
  for (const [sessionId, session] of activeSessions) {
    if (!session.activity || session.exited) continue;
    tracked++;
    let busy = null;
    if (session.activity.needsPoll()) {
      // A PTY that has just exited throws here rather than returning a name.
      let name = null;
      try { name = session.pty.process; } catch {}
      busy = session.activity.feedProcess(name);
    }
    // Ticked either way: a silent command crosses the busy threshold with no
    // output to settle on.
    if (busy === null) busy = session.activity.tick();
    if (busy !== null) sendTerminalBusy(session, sessionId, busy);
  }
  if (tracked === 0) {
    clearInterval(terminalActivityTimer);
    terminalActivityTimer = null;
  }
}

/** Started when the first terminal appears, stopped when the last one goes. */
function startTerminalActivitySweep() {
  if (terminalActivityTimer) return;
  terminalActivityTimer = setInterval(sweepTerminalActivity, TERMINAL_ACTIVITY_INTERVAL_MS);
  terminalActivityTimer.unref?.();
}

// --- Subagents at work while the main agent waits (subagent-activity.js) ---
// The CLI is idle while its agent waits for a subagent, so busy alone shows
// nothing. Every few seconds, each live Claude session's subagents are read;
// a change goes out as cli-subagent-state, to the window and to the phones.
const SUBAGENT_SWEEP_MS = 3000;

function sweepSubagents() {
  const seen = new Set();
  for (const [key, session] of activeSessions) {
    if (seen.has(session)) continue;
    seen.add(session);
    const sessionId = session.realSessionId || key;
    let running = false;
    // Only Claude keeps its subagents' transcripts in a folder beside the session's.
    if (!session.exited && !session.isPlainTerminal && (session.runtime || DEFAULT_HARNESS) === DEFAULT_HARNESS) {
      const row = getCachedSession(sessionId);
      if (row) {
        try { running = subagentsRunning(subagentsDirFor(transcriptPath(row))); } catch { running = false; }
      }
    }
    if (running !== !!session._subagentsBusy) {
      session._subagentsBusy = running;
      log.debug(`[subagents] session=${sessionId} → ${running ? 'WORKING' : 'DONE'}`);
      emit('cli-subagent-state', sessionId, running);
    }
  }
}

const subagentSweepTimer = setInterval(sweepSubagents, SUBAGENT_SWEEP_MS);
subagentSweepTimer.unref?.();

// Session transitions → session-transitions.js
const sessionTransitions = require('./session-transitions');
sessionTransitions.init({ PROJECTS_DIR, activeSessions, log, rekeyMcpServer, copySessionAssignment });
const { detectSessionTransitions } = sessionTransitions;

// --- fs.watch on projects directory ---
let projectsWatcher = null;

function startProjectsWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  if (!harnessEnabled(DEFAULT_HARNESS)) return;

  const pendingFolders = new Set();
  let debounceTimer = null;

  function flushChanges() {
    debounceTimer = null;
    const folders = new Set(pendingFolders);
    pendingFolders.clear();

    // Claim a fork's transcript before indexing it, so the renderer learns the
    // real id in the same beat the row appears. A Claude fork mints its own id
    // (--fork-session ignores --session-id), so it needs this exactly as codex
    // sessions do.
    if (hasPendingLaunches()) {
      const candidates = [];
      for (const folder of folders) {
        try { candidates.push(...claudeHarness.listTranscripts(path.join(PROJECTS_DIR, folder))); } catch {}
      }
      resolvePendingLaunches(candidates);
    }

    let changed = false;
    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (fs.existsSync(folderPath)) {
        detectSessionTransitions(folder);
        refreshFolder(folder);
      } else refreshFolder(folder);
      changed = true;
    }

    if (changed) {
      // A transcript folder moved: sessions only, not the projects themselves.
      notifyRendererProjectsChanged('sessions');
    }
  }

  try {
    projectsWatcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // filename is relative, e.g. "folder-name/sessions-index.json" or "folder-name/abc.jsonl"
      const parts = filename.split(path.sep);
      const folder = parts[0];
      if (!folder || folder === '.git') return;

      // Only care about .jsonl changes or top-level folder add/remove
      const basename = parts[parts.length - 1];
      if (parts.length === 1) {
        pendingFolders.add(folder);
      } else if (basename.endsWith('.jsonl')) {
        pendingFolders.add(folder);
      } else {
        return;
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushChanges, 500);
    });

    projectsWatcher.on('error', (err) => {
      console.error('Projects watcher error:', err);
    });
  } catch (err) {
    console.error('Failed to start projects watcher:', err);
  }
}

/**
 * Adopt a just-written transcript as the real identity of a pending session.
 *
 * A harness that cannot be told its session id up front (codex) is launched
 * under a temporary uuid. When its transcript appears, the session is re-keyed
 * onto the real id — everything downstream (terminal data, exit, the renderer's
 * sidebar row) follows session.realSessionId, exactly as fork detection does.
 */
function resolvePendingLaunches(candidatePaths, harnessId = null) {
  for (const [tempId, session] of [...activeSessions]) {
    if (session.exited || !session.pendingLaunch || session.realSessionId) continue;
    const harness = getHarness(session.runtime);
    if (!harness.matchesLaunch) continue;
    // Candidates are one CLI's: a path, or an id for a database CLI.
    if (harnessId && harness.id !== harnessId) continue;

    for (const filePath of candidatePaths) {
      const signals = harness.readLaunchSignals(filePath);
      if (!harness.matchesLaunch(signals, session.pendingLaunch)) continue;
      // Another live session already owns this transcript.
      if (activeSessions.has(signals.sessionId)) continue;

      const realId = signals.sessionId;
      log.info(`[launch-detect] ${tempId} → ${realId} (originator=${signals.originator || 'none'})`);
      session.realSessionId = realId;
      session.pendingLaunch = null;
      activeSessions.delete(tempId);
      activeSessions.set(realId, session);
      // A Claude fork's IDE server was started under the launch id.
      rekeyMcpServer(tempId, realId);
      // In herdr-core the labels say which session this is on the next start.
      session.pty?.relabel?.({ sid: realId, pendingTag: '', pendingSpawnedAt: '' });
      if (session.projectId) {
        try {
          moveSessionAssignment(tempId, realId);
          rekeyPlanLinks(tempId, realId);
        } catch (err) { log.error('[projects] assignment move failed', err); }
      }
      try { dbModule.rekeyScheduleSession(tempId, realId); } catch (err) { log.error('[schedule] rekey failed', err); }
      emit('session-detected', tempId, realId);
      break;
    }
  }
}

/**
 * Look through every folder a pending session could have landed in.
 *
 * Only the folders that changed since the launch are worth reading, which in
 * practice is today's date directory.
 */
function sweepPendingLaunches() {
  const roots = new Map(); // harness → earliest spawn time still waiting
  for (const session of activeSessions.values()) {
    if (session.exited || !session.pendingLaunch || session.realSessionId) continue;
    const h = getHarness(session.runtime);
    if (!h.matchesLaunch) continue;
    const at = session.pendingLaunch.spawnedAt;
    roots.set(h, Math.min(roots.get(h) ?? at, at));
  }

  for (const [h, since] of roots) {
    if (h.watchPaths) { resolvePendingLaunches(pendingLaunchTags(h), h.id); continue; }
    const candidates = [];
    // Claude's folders live under the injected PROJECTS_DIR, not its own root.
    const dirs = h.folderPrefix
      ? h.listFolders().map(f => h.folderPath(f.slice(h.folderPrefix.length)))
      : h.listFolders().map(f => path.join(PROJECTS_DIR, f));
    for (const dir of dirs) {
      for (const filePath of h.listTranscripts(dir)) {
        try {
          if (fs.statSync(filePath).mtimeMs >= since - 60000) candidates.push(filePath);
        } catch {}
      }
    }
    resolvePendingLaunches(candidates);
  }
}

/**
 * The ids a database CLI's pending launches were started on: its candidates,
 * since its sessions have no file to turn up.
 */
function pendingLaunchTags(h) {
  const tags = [];
  for (const session of activeSessions.values()) {
    if (session.exited || session.realSessionId || !session.pendingLaunch?.tag) continue;
    if ((session.runtime || DEFAULT_HARNESS) === h.id) tags.push(session.pendingLaunch.tag);
  }
  return tags;
}

/** Is any session still waiting for its transcript to appear? */
function hasPendingLaunches() {
  for (const session of activeSessions.values()) {
    if (!session.exited && session.pendingLaunch && !session.realSessionId) return true;
  }
  return false;
}

// --- fs.watch on each non-Claude harness's sessions directory ---
//
// Separate from startProjectsWatcher because the path shape is different: a
// Claude event names <project-folder>/<file>, a codex event names
// <YYYY>/<MM>/<DD>/<file>. Both end up calling refreshFolder with a folder key.
const harnessWatchers = [];

function resolveHarnessFolderPath(folder) {
  const h = getHarnessForFolder(folder);
  return h.folderPath(h.folderPrefix ? folder.slice(h.folderPrefix.length) : folder);
}

function stopHarnessWatchers() {
  while (harnessWatchers.length) {
    try { harnessWatchers.pop().close(); } catch {}
  }
}

/**
 * A CLI keeping its sessions in one database (OpenCode) is watched through that
 * file and its write-ahead log, in their directory so a database created or
 * replaced later is still seen. A write names no session, so each pass refreshes
 * the folders whose stamp moved. Throttled rather than debounced: the database
 * is written all through a turn, and a debounce would hold every update back
 * until the turn paused.
 */
function startDatabaseWatcher(h) {
  const files = h.watchPaths();
  const dir = path.dirname(files[0]);
  if (!fs.existsSync(dir)) return;
  const names = new Set(files.map(f => path.basename(f)));
  let timer = null;

  function flush() {
    timer = null;
    // A launch waiting for its row is re-keyed before the row is listed, so the
    // window learns the session's id in the same beat it appears.
    if (hasPendingLaunches()) resolvePendingLaunches(pendingLaunchTags(h), h.id);
    let folders = [];
    try { folders = sessionCache.changedFolders(h); } catch (err) { log.error(`[harness-watch] ${h.id}:`, err.message); }
    for (const folder of folders) {
      try { refreshFolder(folder); } catch (err) { log.error('[harness-watch]', folder, err.message); }
    }
    if (folders.length) notifyRendererProjectsChanged('sessions');
  }

  try {
    const watcher = fs.watch(dir, (_eventType, filename) => {
      if (filename && !names.has(String(filename))) return;
      if (!timer) timer = setTimeout(flush, 1000);
    });
    watcher.on('error', (err) => log.error(`[harness-watch] ${h.id}:`, err.message));
    harnessWatchers.push(watcher);
    // Closing the watcher must not leave a pending pass behind.
    harnessWatchers.push({ close() { if (timer) clearTimeout(timer); timer = null; } });
    log.info(`[harness-watch] watching ${h.id} at ${files[0]}`);
  } catch (err) {
    log.error(`[harness-watch] failed to watch ${h.id}:`, err.message);
  }
}

function startHarnessWatchers() {
  for (const h of availableHarnesses()) {
    if (!h.folderPrefix) continue; // Claude's root is startProjectsWatcher's job
    if (!harnessEnabled(h.id)) continue;
    if (h.watchPaths) { startDatabaseWatcher(h); continue; }
    const root = h.sessionsRoot();
    if (!fs.existsSync(root)) continue;

    const pendingFolders = new Set();
    let debounceTimer = null;

    function flush() {
      debounceTimer = null;
      const folders = new Set(pendingFolders);
      pendingFolders.clear();

      // Claim transcripts before indexing them, so the renderer learns the real
      // session id in the same beat the row appears.
      if (hasPendingLaunches()) {
        const candidates = [];
        for (const folder of folders) {
          try { candidates.push(...h.listTranscripts(resolveHarnessFolderPath(folder))); } catch {}
        }
        resolvePendingLaunches(candidates);
      }

      for (const folder of folders) {
        try { refreshFolder(folder); } catch (err) { log.error('[harness-watch]', folder, err.message); }
      }
      const titlesChanged = refreshHarnessTitles(h);
      if (folders.size || titlesChanged) notifyRendererProjectsChanged('sessions');
    }

    try {
      const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const parts = filename.split(path.sep);
        // Transcripts sit at <YYYY>/<MM>/<DD>/<file>; anything shallower is a
        // directory being created, which the next file event will cover.
        if (parts.length < 4 || !parts[parts.length - 1].endsWith('.jsonl')) return;
        pendingFolders.add(h.folderPrefix + parts.slice(0, 3).join('/'));
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, 500);
      });
      watcher.on('error', (err) => log.error(`[harness-watch] ${h.id}:`, err.message));
      harnessWatchers.push(watcher);
      log.info(`[harness-watch] watching ${h.id} at ${root}`);
    } catch (err) {
      log.error(`[harness-watch] failed to watch ${h.id}:`, err.message);
    }

    // Codex names live next to sessions/, not underneath it, so the recursive
    // transcript watcher above can never observe an auto-title or `/rename`.
    // Watch the containing directory so atomic replacement of the index is
    // handled as well as ordinary appends.
    if (h.titleIndexPath && h.readSessionTitles) {
      const indexPath = h.titleIndexPath();
      const indexDir = path.dirname(indexPath);
      const indexName = path.basename(indexPath);
      let titleTimer = null;
      try {
        const titleWatcher = fs.watch(indexDir, (_eventType, filename) => {
          if (filename && String(filename) !== indexName) return;
          if (titleTimer) clearTimeout(titleTimer);
          titleTimer = setTimeout(() => {
            titleTimer = null;
            if (refreshHarnessTitles(h)) notifyRendererProjectsChanged('sessions');
          }, 300);
        });
        titleWatcher.on('error', (err) => log.error(`[harness-title-watch] ${h.id}:`, err.message));
        harnessWatchers.push(titleWatcher);
        log.info(`[harness-title-watch] watching ${h.id} at ${indexPath}`);
      } catch (err) {
        log.error(`[harness-title-watch] failed to watch ${h.id}:`, err.message);
      }
    }
  }
}

// --- IPC: app version ---
ipcMain.handle('get-app-version', () => app.getVersion());

// --- IPC: auto-updater ---
ipcMain.handle('updater-check', () => {
  if (!autoUpdater) return { available: false, dev: true };
  return autoUpdater.checkForUpdates();
});
ipcMain.handle('updater-download', () => {
  if (!autoUpdater) return;
  return autoUpdater.downloadUpdate();
});
ipcMain.handle('updater-install', () => {
  if (!autoUpdater) return;
  autoUpdater.quitAndInstall();
});
// On macOS quitAndInstall closes the window before before-quit, and a closed
// window may only hide: mark the quit once Squirrel really starts it.
if (process.platform === 'darwin') {
  require('electron').autoUpdater.on('before-quit-for-update', () => { appIsQuitting = true; });
}

// --- App lifecycle ---
// Prevent a second Electron instance from killing active PTY sessions.
// This happens when the user replaces the AppImage while Switchboard is running:
// the OS spawns the new binary, which would otherwise initialise a second process
// and leave the first one's node-pty sessions orphaned or killed.
// requestSingleInstanceLock ensures only one instance runs at a time. The second
// launch quits immediately; the first brings its window to the front.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Focus the existing window when a second launch is attempted.
  app.on('second-instance', () => {
    if (mainWindow) showWindow(mainWindow);
  });


// --- Scheduled task ticker ---
// Main owns the clock: a renderer timer is throttled while the window is
// hidden, and a schedule has to fire at the minute it names. Each fire is one
// 'schedule-due' event; the renderer launches the session, because the
// terminal lives there. A schedule whose last session is still working is
// skipped by projects.dueSchedules.
let scheduleTickerStop = null;
// "Still working" is the CLI being busy, not the PTY being open: an
// interactive session sits at its prompt until someone closes it, and that
// must not stop the next run.
function isSessionBusy(sessionId) {
  const session = activeSessions.get(sessionId);
  return !!session && !session.exited && !!session._cliBusy;
}
function fireSchedules(ids, reason) {
  if (!ids.length || !mainWindow || mainWindow.isDestroyed()) return;
  for (const id of ids) {
    const launch = projects.resolveScheduleLaunch(id);
    if (launch.error) { log.warn(`[schedule] ${id}: ${launch.error}`); continue; }
    log.info(`[schedule] ${reason}: ${launch.schedule.name}`);
    emit('schedule-due', launch);
  }
}
function startScheduleTicker() {
  if (scheduleTickerStop) return;
  let interval = null;
  const tick = () => {
    try { fireSchedules(projects.dueSchedules(new Date(), isSessionBusy), 'due'); } catch (err) {
      log.error('[schedule] tick failed', err);
    }
  };
  // Align to the minute so a 9:00 schedule fires at 9:00:00, not 9:00:37.
  const first = setTimeout(() => { tick(); interval = setInterval(tick, 60 * 1000); }, (60 - new Date().getSeconds()) * 1000);
  // Catch-up runs, for schedules that asked for it, once the renderer has had
  // time to load. Missed while the app was closed means missed since the last
  // run (projects.missedSchedules).
  const catchUp = setTimeout(() => {
    try { fireSchedules(projects.missedSchedules(new Date(), isSessionBusy), 'catch-up'); } catch (err) {
      log.error('[schedule] catch-up failed', err);
    }
  }, 20 * 1000);
  scheduleTickerStop = () => { clearTimeout(first); clearTimeout(catchUp); if (interval) clearInterval(interval); scheduleTickerStop = null; };
}

  app.whenReady().then(() => {
    protocol.handle(PREVIEW_SCHEME, handlePreviewAssetRequest);
    webPage.setupWebPages({ app, session: electronSession, shell, clipboard, Menu, log });
    buildMenu();
    initializeHiddenProjectTimestamps();
    sessionsReady = startTerminalEngine();
    createWindow();
    startProjectsWatcher();
    startHarnessWatchers();
    // Retry legacy imports each launch; successful files are remembered in
    // the DB, including deleted tasks. Missing folders can be picked up later.
    // Then tick once a minute and launch due tasks through the renderer.
    try {
      const imported = projects.importLegacySchedules(scanSchedules(log));
      if (imported) log.info(`[schedule] Imported ${imported} schedule file(s) as folder schedules`);
    } catch (err) { log.error('[schedule] legacy import failed', err); }
    startScheduleTicker();
    // Projects with the code graph on refresh it when their repositories move.
    knowledge.startWatching();
    // Graphs nothing uses any more (a worktree that left while CBM was away), once the app has settled.
    setTimeout(() => {
      knowledge.sweepOrphans().catch((err) => log.warn('[knowledge] sweep failed', err.message));
      knowledge.applyConfigDefaults().catch((err) => log.warn('[knowledge] could not apply the CBM defaults', err.message));
      // One file, one graph: the folders inside others leave their graphs; then the project folders are read again.
      knowledge.reconcileExclusions()
        .catch((err) => log.warn('[knowledge] exclusions', err.message))
        .then(() => knowledge.refreshProjectFolders());
    }, 30_000).unref?.();
    // The remote-access switch stays where it was left.
    if (remoteAccessSettings().enabled) startRemoteAccess();

    // Re-index search if FTS table was recreated (e.g. tokenizer config change)
    if (searchFtsRecreated) populateCacheViaWorker();

    // Check for updates after launch
    if (autoUpdater) {
      setTimeout(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 5000);
      // Re-check every 4 hours for long-running sessions
      setInterval(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 4 * 60 * 60 * 1000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (mainWindow) showWindow(mainWindow);
    });
  }); // end app.whenReady
} // end gotSingleInstanceLock else-branch

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  // Unsaved text that could not be kept is asked about before anything is shut down.
  if (!discardUnkeptDrafts && drafts.failed().length) {
    if (!confirmLosingDrafts(mainWindow)) {
      event.preventDefault();
      appIsQuitting = false;
      return;
    }
    discardUnkeptDrafts = true;
  }
  // The renderer persists raw-terminal descriptors and scrollback during its
  // unload. Do not report the shutdown kills as user-initiated terminal exits,
  // or that renderer cleanup would delete the descriptors before restart.
  appIsQuitting = true;
  // The windows still open come back at the next start.
  freezeOpenWindows();
  remoteTunnels.stop();
  remoteServer.stop();
  knowledge.stopWatching();
  cbmClient.stop();
  lspManager.stopAll();
  // Shut down all MCP servers
  shutdownAllMcp();
  taskManager.shutdown();

  // Close filesystem watcher
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }

  // Kill all PTY processes on quit. Sessions in herdr-core are left running:
  // Switchboard only stops viewing them, and the next start finds them again.
  for (const [, session] of activeSessions) {
    if (session.exited) continue;
    if (session.pty?.detach) continue;
    try { session.pty.kill(); } catch {}
  }
  if (hcEngine) { try { hcEngine.close(); } catch {} }
});

// Close SQLite after all windows are closed to avoid "connection is not open" errors
app.on('will-quit', () => {
  // A language server still there after its shutdown and exit messages goes now.
  lspManager.killAll();
  closeDb();
});
