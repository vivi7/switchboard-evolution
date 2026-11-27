const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  readPlan: (filename) => ipcRenderer.invoke('read-plan', filename),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  getStats: () => ipcRenderer.invoke('get-stats'),
  refreshStats: () => ipcRenderer.invoke('refresh-stats'),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  getCodexUsage: () => ipcRenderer.invoke('get-codex-usage'),
  getMemories: () => ipcRenderer.invoke('get-memories'),
  readMemory: (filePath) => ipcRenderer.invoke('read-memory', filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke('save-memory', filePath, content),
  // The Files tab's opened and pinned files (main.js, opened-files.js).
  getOpenedFiles: () => ipcRenderer.invoke('get-opened-files'),
  addOpenedFiles: (paths) => ipcRenderer.invoke('add-opened-files', paths),
  removeOpenedFile: (filePath) => ipcRenderer.invoke('remove-opened-file', filePath),
  setFilePinned: (filePath, pinned) => ipcRenderer.invoke('set-file-pinned', filePath, pinned),
  movePinnedFile: (filePath, toIndex) => ipcRenderer.invoke('move-pinned-file', filePath, toIndex),
  openFileWindow: (filePath) => ipcRenderer.invoke('open-file-window', filePath),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  getHarnesses: () => ipcRenderer.invoke('get-harnesses'),
  getCodexModels: () => ipcRenderer.invoke('get-codex-models'),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  // RAM task manager: memory per session/task tree, and the ways to end one
  getProcessUsage: () => ipcRenderer.invoke('get-process-usage'),
  getProjectDiskUsage: (force) => ipcRenderer.invoke('get-project-disk-usage', force === true),
  stopOwner: (owner) => ipcRenderer.invoke('stop-owner', owner),
  killOwnedProcess: (owner, pid, force) => ipcRenderer.invoke('kill-owned-process', owner, pid, force),
  forceStopOwner: (owner) => ipcRenderer.invoke('force-stop-owner', owner),
  // The Task Manager and Stats in a window of their own ('task-manager', 'stats'),
  // and whether the window a page runs in stays above the others.
  openToolWindow: (kind) => ipcRenderer.invoke('open-tool-window', kind),
  // A project's tab in a window of its own, and what that window asks the main window to do.
  openProjectWindow: (projectId, tab) => ipcRenderer.invoke('open-project-window', projectId, tab),
  focusProjectWindow: (projectId, tab) => ipcRenderer.invoke('focus-project-window', projectId, tab),
  switchProjectWindowTab: (tab) => ipcRenderer.invoke('switch-project-window-tab', tab),
  openGitCompareWindow: (projectId, repoPath, hashes, labels, subjects) => ipcRenderer.invoke('open-git-compare-window', projectId, repoPath, hashes, labels, subjects),
  openGitFileWindow: (projectId, repoPath, file) => ipcRenderer.invoke('open-git-file-window', projectId, repoPath, file),
  runInMainWindow: (name, args) => ipcRenderer.invoke('project-window-run', name, args),
  onProjectWindowRun: (callback) => {
    ipcRenderer.on('project-window-run', (_event, name, args) => callback(name, args));
  },
  getWindowOnTop: () => ipcRenderer.invoke('get-window-on-top'),
  setWindowOnTop: (onTop) => ipcRenderer.invoke('set-window-on-top', onTop),
  openInMainWindow: (owner) => ipcRenderer.invoke('task-manager-open-owner', owner),
  onTaskManagerOpenOwner: (callback) => {
    ipcRenderer.on('task-manager-open-owner', (_event, owner) => callback(owner));
  },
  getTerminalEngine: () => ipcRenderer.invoke('get-terminal-engine'),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  setPinnedOrder: (sessionIds) => ipcRenderer.invoke('set-pinned-order', sessionIds),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query, titleOnly) => ipcRenderer.invoke('search', type, query, titleOnly),
  searchSessionIds: (query, sessionIds) => ipcRenderer.invoke('search-session-ids', query, sessionIds),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),
  getSessionLastMessage: (sessionId) => ipcRenderer.invoke('get-session-last-message', sessionId),
  readSessionEntries: (sessionId, cursor) => ipcRenderer.invoke('read-session-entries', sessionId, cursor),
  getSessionStates: () => ipcRenderer.invoke('get-session-states'),
  // Remote access (the mobile companion app)
  remoteAccessStatus: () => ipcRenderer.invoke('remote-access-status'),
  setRemoteAccessEnabled: (enabled) => ipcRenderer.invoke('remote-access-set-enabled', enabled),
  setRemoteAccessPort: (port) => ipcRenderer.invoke('remote-access-set-port', port),
  startRemotePairing: () => ipcRenderer.invoke('remote-access-start-pairing'),
  setupRemoteTunnel: (provider, params) => ipcRenderer.invoke('remote-tunnel-setup', provider, params),
  removeRemoteTunnel: (provider, params) => ipcRenderer.invoke('remote-tunnel-remove', provider, params),
  cancelRemotePairing: () => ipcRenderer.invoke('remote-access-cancel-pairing'),
  listRemoteDevices: () => ipcRenderer.invoke('remote-access-list-devices'),
  revokeRemoteDevice: (id) => ipcRenderer.invoke('remote-access-revoke-device', id),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  // One field saved at a time: ({ ok: true, settings } | { ok: false, error }).
  patchSetting: (key, patch) => ipcRenderer.invoke('patch-setting', key, patch),
  onGlobalSettingsChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('global-settings-changed', handler);
    return () => ipcRenderer.removeListener('global-settings-changed', handler);
  },
  deleteSetting: (key) => ipcRenderer.invoke('delete-setting', key),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke('get-effective-settings', projectPath),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),

  // Project/worktree tasks
  listProjectTasks: (projectPath) => ipcRenderer.invoke('list-project-tasks', projectPath),
  listTasksForProjects: (projectPaths) => ipcRenderer.invoke('list-tasks-for-projects', projectPaths),
  getTaskRun: (projectPath, label) => ipcRenderer.invoke('get-task-run', projectPath, label),
  startTask: (projectPath, label) => ipcRenderer.invoke('start-task', projectPath, label),
  stopTask: (projectPath, label) => ipcRenderer.invoke('stop-task', projectPath, label),
  stopAllTasks: (projectPath) => ipcRenderer.invoke('stop-all-tasks', projectPath),
  restartTask: (projectPath, label) => ipcRenderer.invoke('restart-task', projectPath, label),

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),

  // Projects (a piece of work with a folder on disk; see projects.js)
  getProjectTree: (showArchived) => ipcRenderer.invoke('get-project-tree', showArchived),
  createProject: (spec) => ipcRenderer.invoke('create-project', spec),
  updateProject: (id, patch) => ipcRenderer.invoke('update-project', id, patch),
  setStarredOrder: (ids) => ipcRenderer.invoke('set-starred-order', ids),
  deleteProject: (id) => ipcRenderer.invoke('delete-project', id),
  attachProjectFolder: (id, spec) => ipcRenderer.invoke('attach-project-folder', id, spec),
  detachProjectFolder: (id, folderPath, opts) => ipcRenderer.invoke('detach-project-folder', id, folderPath, opts),
  setSessionAssignment: (sessionId, projectId, trackId) => ipcRenderer.invoke('set-session-assignment', sessionId, projectId, trackId),
  getProjectsRoot: () => ipcRenderer.invoke('get-projects-root'),
  getProjectGitStatus: (id, opts) => ipcRenderer.invoke('get-project-git-status', id, opts),
  getProjectGitInfo: (id) => ipcRenderer.invoke('get-project-git-info', id),
  getProjectGitDiff: (id, folderPath, filePath, side) => ipcRenderer.invoke('get-project-git-diff', id, folderPath, filePath, side),
  stageProjectGitFiles: (id, folderPath, paths, stage) => ipcRenderer.invoke('stage-project-git-files', id, folderPath, paths, stage),
  stageProjectGitLines: (id, folderPath, filePath, side, diffId, lines) => ipcRenderer.invoke('stage-project-git-lines', id, folderPath, filePath, side, diffId, lines),
  discardProjectGitFiles: (id, folderPath, paths) => ipcRenderer.invoke('discard-project-git-files', id, folderPath, paths),
  ignoreProjectGitPaths: (id, folderPath, paths, untrack) => ipcRenderer.invoke('ignore-project-git-paths', id, folderPath, paths, untrack),
  readProjectGitEditFile: (id, folderPath, filePath) => ipcRenderer.invoke('read-project-git-edit-file', id, folderPath, filePath),
  saveProjectGitEditFile: (id, folderPath, filePath, content, version) => ipcRenderer.invoke('save-project-git-edit-file', id, folderPath, filePath, content, version),
  getFolderGitStatus: (folderPath) => ipcRenderer.invoke('get-folder-git-status', folderPath),

  // Git Graph tab
  getProjectGitGraph: (id, folderPath, opts) => ipcRenderer.invoke('get-project-git-graph', id, folderPath, opts),
  getGitGraphCommitDetail: (id, folderPath, hash) => ipcRenderer.invoke('get-git-graph-commit-detail', id, folderPath, hash),
  getGitGraphCompareDetail: (id, folderPath, fromHash, toHash) => ipcRenderer.invoke('get-git-graph-compare-detail', id, folderPath, fromHash, toHash),
  getGitGraphFileAtRevision: (id, folderPath, rev, filePath) => ipcRenderer.invoke('get-git-graph-file-at-revision', id, folderPath, rev, filePath),
  getGitGraphFileDiffBetween: (id, folderPath, fromRev, toRevOrNull, filePath) => ipcRenderer.invoke('get-git-graph-file-diff-between', id, folderPath, fromRev, toRevOrNull, filePath),
  getGitGraphRepoConfig: (id, folderPath) => ipcRenderer.invoke('get-git-graph-repo-config', id, folderPath),
  setGitGraphRepoConfig: (id, folderPath, patch) => ipcRenderer.invoke('set-git-graph-repo-config', id, folderPath, patch),
  trustGitGraphRepoConfig: (id, folderPath, trusted) => ipcRenderer.invoke('trust-git-graph-repo-config', id, folderPath, trusted),
  exportGitGraphRepoConfig: (id, folderPath) => ipcRenderer.invoke('export-git-graph-repo-config', id, folderPath),
  getGitGraphUserDetails: (id, folderPath) => ipcRenderer.invoke('get-git-graph-user-details', id, folderPath),
  getGitGraphGlobalPreferences: () => ipcRenderer.invoke('get-git-graph-global-preferences'),
  setGitGraphGlobalPreferences: (patch) => ipcRenderer.invoke('set-git-graph-global-preferences', patch),
  getGitGraphRemotes: (id, folderPath) => ipcRenderer.invoke('get-git-graph-remotes', id, folderPath),
  getGitGraphTagDetails: (id, folderPath, tagName) => ipcRenderer.invoke('get-git-graph-tag-details', id, folderPath, tagName),
  getGitGraphAvatarUrl: (id, folderPath, email) => ipcRenderer.invoke('get-git-graph-avatar-url', id, folderPath, email),
  clearGitGraphAvatarCache: () => ipcRenderer.invoke('clear-git-graph-avatar-cache'),
  runGitGraphAction: (id, folderPath, actionId, params) => ipcRenderer.invoke('run-git-graph-action', id, folderPath, actionId, params),
  cancelGitGraphAction: (id, folderPath, actionId) => ipcRenderer.invoke('cancel-git-graph-action', id, folderPath, actionId),
  saveGitGraphArchive: (id, folderPath, opts) => ipcRenderer.invoke('save-git-graph-archive', id, folderPath, opts),
  confirmGitGraphAvatarsGitLabHost: (id, folderPath, host) => ipcRenderer.invoke('confirm-git-graph-avatars-gitlab-host', id, folderPath, host),
  onGitGraphRepoChanged: (callback) => {
    ipcRenderer.on('git-graph-repo-changed', (_event, folderPath, info) => callback(folderPath, info));
  },
  onGitGraphActionProgress: (callback) => {
    ipcRenderer.on('git-graph-action-progress', (_event, payload) => callback(payload));
  },
  // Pull Requests tab (pull-requests.js)
  getPullRequests: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-requests', id, folderPath, opts),
  getPullRequestsPage: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-requests-page', id, folderPath, opts),
  getPullRequestFiles: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-files', id, folderPath, opts),
  getPullRequestFileDiff: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-file-diff', id, folderPath, opts),
  runPullRequestAction: (id, folderPath, params) => ipcRenderer.invoke('run-pull-request-action', id, folderPath, params),
  getPullRequestConversation: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-conversation', id, folderPath, opts),
  getPullRequestCommits: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-commits', id, folderPath, opts),
  getPullRequestCommitFiles: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-commit-files', id, folderPath, opts),
  getPullRequestChecks: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-checks', id, folderPath, opts),
  getPullRequestJobLog: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-job-log', id, folderPath, opts),
  getPullRequestViewed: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-viewed', id, folderPath, opts),
  getPullRequestBranches: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-branches', id, folderPath, opts),
  getPullRequestCandidates: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-candidates', id, folderPath, opts),
  renderPullRequestMarkdown: (id, folderPath, opts) => ipcRenderer.invoke('render-pull-request-markdown', id, folderPath, opts),
  getPullRequestTexts: (id, folderPath, opts) => ipcRenderer.invoke('get-pull-request-texts', id, folderPath, opts),
  editPullRequest: (id, folderPath, params) => ipcRenderer.invoke('edit-pull-request', id, folderPath, params),
  // Actions tab (actions.js)
  getActionsWorkflows: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-workflows', id, folderPath, opts),
  getActionsRuns: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-runs', id, folderPath, opts),
  getActionsRun: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-run', id, folderPath, opts),
  getActionsJob: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-job', id, folderPath, opts),
  getActionsStepLog: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-step-log', id, folderPath, opts),
  getActionsJobLog: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-job-log', id, folderPath, opts),
  getActionsWorkflowFile: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-workflow-file', id, folderPath, opts),
  getActionsDispatchForm: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-dispatch-form', id, folderPath, opts),
  getActionsRefs: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-refs', id, folderPath, opts),
  getActionsCaches: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-caches', id, folderPath, opts),
  getActionsRunners: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-runners', id, folderPath, opts),
  getActionsDeployments: (id, folderPath, opts) => ipcRenderer.invoke('get-actions-deployments', id, folderPath, opts),
  editActions: (id, folderPath, params) => ipcRenderer.invoke('edit-actions', id, folderPath, params),
  saveActionsArtifact: (id, folderPath, opts) => ipcRenderer.invoke('save-actions-artifact', id, folderPath, opts),
  saveActionsLog: (id, folderPath, opts) => ipcRenderer.invoke('save-actions-log', id, folderPath, opts),
  listEnvFiles: (folderPath) => ipcRenderer.invoke('list-env-files', folderPath),
  saveProjectBrief: (id, content) => ipcRenderer.invoke('save-project-brief', id, content),
  createProjectFile: (id, name, content) => ipcRenderer.invoke('create-project-file', id, name, content),
  projectEnvFiles: (id) => ipcRenderer.invoke('project-env-files', id),
  createProjectEnvFile: (id, folderPath) => ipcRenderer.invoke('create-project-env-file', id, folderPath),
  excludeProjectEnvFile: (id, folderPath) => ipcRenderer.invoke('exclude-project-env-file', id, folderPath),
  addProjectFiles: (id, sourcePaths) => ipcRenderer.invoke('add-project-files', id, sourcePaths),
  listRecentProjectFiles: (id) => ipcRenderer.invoke('list-recent-project-files', id),
  getProjectPlan: (id) => ipcRenderer.invoke('get-project-plan', id),
  setPlanItem: (id, kind, line, done) => ipcRenderer.invoke('set-plan-item', id, kind, line, done),
  appendPlanItem: (id, kind, text) => ipcRenderer.invoke('append-plan-item', id, kind, text),
  editPlanItem: (id, kind, line, text) => ipcRenderer.invoke('edit-plan-item', id, kind, line, text),
  adoptPlan: (id, filename, opts) => ipcRenderer.invoke('adopt-plan', id, filename, opts),
  listTemplates: () => ipcRenderer.invoke('list-templates'),
  // Node Knowledge tab (knowledge.js, codebase-memory-mcp)
  getKnowledgeStatus: (id) => ipcRenderer.invoke('get-knowledge-status', id),
  getKnowledgeSettings: (id) => ipcRenderer.invoke('get-knowledge-settings', id),
  setKnowledgeSettings: (id, patch) => ipcRenderer.invoke('set-knowledge-settings', id, patch),
  knowledgeQuery: (id, folder, tool, args) => ipcRenderer.invoke('knowledge-query', id, folder, tool, args),
  knowledgeCompare: (id, base, target, opts) => ipcRenderer.invoke('knowledge-compare', id, base, target, opts),
  knowledgePrompt: (id, folder, name, args) => ipcRenderer.invoke('knowledge-prompt', id, folder, name, args),
  knowledgeIndex: (id, folder, opts) => ipcRenderer.invoke('knowledge-index', id, folder, opts),
  knowledgeIndexAll: (id, opts) => ipcRenderer.invoke('knowledge-index-all', id, opts),
  knowledgeLinkCrossRepo: (id) => ipcRenderer.invoke('knowledge-link-cross-repo', id),
  knowledgeDeleteIndex: (id, folder) => ipcRenderer.invoke('knowledge-delete-index', id, folder),
  knowledgeModules: (id, folder) => ipcRenderer.invoke('knowledge-modules', id, folder),
  knowledgeDeleteInnerGraph: (id, folder, name) => ipcRenderer.invoke('knowledge-delete-inner-graph', id, folder, name),
  knowledgeAdr: (id, folder, opts) => ipcRenderer.invoke('knowledge-adr', id, folder, opts),
  knowledgeIngestTraces: (id, folder, opts) => ipcRenderer.invoke('knowledge-ingest-traces', id, folder, opts),
  knowledgeImportTracesFile: (id, folder, label) => ipcRenderer.invoke('knowledge-import-traces-file', id, folder, label),
  getKnowledgeConfig: () => ipcRenderer.invoke('get-knowledge-config'),
  setKnowledgeConfig: (key, value) => ipcRenderer.invoke('set-knowledge-config', key, value),
  getKnowledgeGlobal: () => ipcRenderer.invoke('get-knowledge-global'),
  setKnowledgeGlobal: (patch) => ipcRenderer.invoke('set-knowledge-global', patch),
  knowledgePickBinary: () => ipcRenderer.invoke('knowledge-pick-binary'),
  knowledgeLens: (id, folder, workspace) => ipcRenderer.invoke('knowledge-lens', id, folder, workspace),
  knowledgeDownloadBinary: () => ipcRenderer.invoke('knowledge-download-binary'),
  knowledgeRestart: () => ipcRenderer.invoke('knowledge-restart'),
  getKnowledgeBinary: () => ipcRenderer.invoke('get-knowledge-binary'),
  knowledgeInstallAgents: (opts) => ipcRenderer.invoke('knowledge-install-agents', opts),
  onKnowledgeChanged: (callback) => {
    const handler = (_event, payload) => callback(payload || {});
    ipcRenderer.on('knowledge-changed', handler);
    return () => ipcRenderer.removeListener('knowledge-changed', handler);
  },
  // Worktrees tab (worktrees.js)
  getProjectWorktrees: (id) => ipcRenderer.invoke('get-project-worktrees', id),
  getWorktreeSettings: (id) => ipcRenderer.invoke('get-worktree-settings', id),
  setWorktreeSettings: (id, patch) => ipcRenderer.invoke('set-worktree-settings', id, patch),
  listWorktreeBranches: (id, repoPath) => ipcRenderer.invoke('list-worktree-branches', id, repoPath),
  suggestWorktreePath: (id, repoPath, ref) => ipcRenderer.invoke('suggest-worktree-path', id, repoPath, ref),
  createWorktree: (id, spec) => ipcRenderer.invoke('worktree-create', id, spec),
  runWorktreePostCreate: (id, worktreePath) => ipcRenderer.invoke('worktree-run-post-create', id, worktreePath),
  removeWorktree: (id, worktreePath, opts) => ipcRenderer.invoke('worktree-remove', id, worktreePath, opts),
  deleteWorktreeBranch: (id, repoPath, branch, opts) => ipcRenderer.invoke('worktree-delete-branch', id, repoPath, branch, opts),
  getMergedWorktrees: (id, repoPath, base) => ipcRenderer.invoke('worktree-merged', id, repoPath, base),
  lockWorktree: (id, worktreePath, reason) => ipcRenderer.invoke('worktree-lock', id, worktreePath, reason),
  unlockWorktree: (id, worktreePath) => ipcRenderer.invoke('worktree-unlock', id, worktreePath),
  moveWorktree: (id, worktreePath, newPath) => ipcRenderer.invoke('worktree-move', id, worktreePath, newPath),
  repairWorktrees: (id, repoPath, paths) => ipcRenderer.invoke('worktree-repair', id, repoPath, paths),
  previewWorktreePrune: (id, repoPath) => ipcRenderer.invoke('worktree-prune-preview', id, repoPath),
  pruneWorktrees: (id, repoPath, opts) => ipcRenderer.invoke('worktree-prune', id, repoPath, opts),
  attachWorktreeToProject: (id, worktreePath) => ipcRenderer.invoke('worktree-attach', id, worktreePath),
  detachWorktreeFromProject: (id, worktreePath) => ipcRenderer.invoke('worktree-detach', id, worktreePath),
  getWorktreeChanges: (id, worktreePath) => ipcRenderer.invoke('worktree-changes', id, worktreePath),
  getWorktreeFileDiff: (id, worktreePath, filePath) => ipcRenderer.invoke('worktree-file-diff', id, worktreePath, filePath),
  onProjectPlanChanged: (callback) => {
    ipcRenderer.on('project-plan-changed', (_event, projectId) => callback(projectId));
  },
  listSchedules: () => ipcRenderer.invoke('list-schedules'),
  createSchedule: (spec) => ipcRenderer.invoke('create-schedule', spec),
  updateSchedule: (id, patch) => ipcRenderer.invoke('update-schedule', id, patch),
  deleteSchedule: (id) => ipcRenderer.invoke('delete-schedule', id),
  resolveScheduleLaunch: (id) => ipcRenderer.invoke('resolve-schedule-launch', id),
  getScheduleContext: (spec) => ipcRenderer.invoke('get-schedule-context', spec),
  onScheduleDue: (callback) => {
    ipcRenderer.on('schedule-due', (_event, launch) => callback(launch));
  },
  createTrack: (projectId, spec) => ipcRenderer.invoke('create-track', projectId, spec),
  updateTrack: (id, patch) => ipcRenderer.invoke('update-track', id, patch),
  deleteTrack: (id, options) => ipcRenderer.invoke('delete-track', id, options),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (target) => ipcRenderer.invoke('open-path', target),
  revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  // A pull request's page on GitHub in a window of its own (main.js openWebWindow).
  openWebWindow: (url, title) => ipcRenderer.invoke('open-web-window', url, title),
  // The terminal's Commands palette for one session, in a window of its own (main.js openCommandsWindow).
  openCommandsWindow: (info) => ipcRenderer.invoke('open-commands-window', info),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send('close-terminal', id),
  sendTaskInput: (projectPath, label, data) => ipcRenderer.send('task-input', projectPath, label, data),
  resizeTask: (projectPath, label, cols, rows) => ipcRenderer.send('task-resize', projectPath, label, cols, rows),

  // Listeners (main → renderer)
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (_event, sessionId, data) => callback(sessionId, data));
  },
  onSessionDetected: (callback) => {
    ipcRenderer.on('session-detected', (_event, tempId, realId) => callback(tempId, realId));
  },
  onHarnessesChanged: (callback) => {
    ipcRenderer.on('harnesses-changed', () => callback());
  },
  onProcessExited: (callback) => {
    ipcRenderer.on('process-exited', (_event, sessionId, exitCode, signal, userStopped) =>
      callback(sessionId, exitCode, signal, userStopped));
  },
  onTerminalNotification: (callback) => {
    ipcRenderer.on('terminal-notification', (_event, sessionId, message, kind) => callback(sessionId, message, kind));
  },
  onCliBusyState: (callback) => {
    ipcRenderer.on('cli-busy-state', (_event, sessionId, busy) => callback(sessionId, busy));
  },  onCliSubagentState: (callback) => {
    ipcRenderer.on('cli-subagent-state', (_event, sessionId, running) => callback(sessionId, running));
  },

  onSessionForked: (callback) => {
    ipcRenderer.on('session-forked', (_event, oldId, newId) => callback(oldId, newId));
  },
  onProjectsChanged: (callback) => {
    ipcRenderer.on('projects-changed', (_e, reason) => callback(reason || 'project'));
  },
  onRemoteAccessStatus: (callback) => {
    ipcRenderer.on('remote-access-status', (_event, status) => callback(status));
  },
  // Seen elsewhere, and marks shared with paired phones (session-notices.js)
  onWindowVisibility: (callback) => {
    ipcRenderer.on('window-visibility', (_event, visible) => callback(visible));
  },
  onRemoteViewing: (callback) => {
    ipcRenderer.on('remote-viewing', (_event, sessionIds) => callback(sessionIds));
  },
  onRemoteMarkRead: (callback) => {
    ipcRenderer.on('remote-mark-read', (_event, sessionId, read) => callback(sessionId, read));
  },
  publishSessionNotices: (notices) => ipcRenderer.send('session-notices', notices),
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, text, type) => callback(text, type));
  },
  onTaskOutput: (callback) => {
    ipcRenderer.on('task-output', (_event, projectPath, label, data) => callback(projectPath, label, data));
  },
  onTaskStateChanged: (callback) => {
    ipcRenderer.on('task-state-changed', (_event, run) => callback(run));
  },
  onProjectTasksChanged: (callback) => {
    ipcRenderer.on('project-tasks-changed', (_event, projectPath) => callback(projectPath));
  },

  // File drag-and-drop
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Platform
  platform: process.platform,

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  onUpdaterEvent: (callback) => {
    ipcRenderer.on('updater-event', (_event, type, data) => callback(type, data));
  },

  // MCP bridge (main → renderer)
  onMcpOpenDiff: (callback) => {
    ipcRenderer.on('mcp-open-diff', (_event, sessionId, diffId, data) => callback(sessionId, diffId, data));
  },
  onMcpOpenFile: (callback) => {
    ipcRenderer.on('mcp-open-file', (_event, sessionId, data) => callback(sessionId, data));
  },
  onMcpCloseAllDiffs: (callback) => {
    ipcRenderer.on('mcp-close-all-diffs', (_event, sessionId) => callback(sessionId));
  },
  onMcpCloseTab: (callback) => {
    ipcRenderer.on('mcp-close-tab', (_event, sessionId, diffId) => callback(sessionId, diffId));
  },
  onMcpDiffResolved: (callback) => {
    ipcRenderer.on('mcp-diff-resolved', (_event, sessionId, diffId, action) => callback(sessionId, diffId, action));
  },

  // MCP bridge (renderer → main)
  // Resolves whether this answer was the one taken (the first answer wins).
  mcpDiffResponse: (sessionId, diffId, action, editedContent) =>
    ipcRenderer.invoke('mcp-diff-response', sessionId, diffId, action, editedContent),
  readFileForPanel: (filePath) => ipcRenderer.invoke('read-file-for-panel', filePath),
  // The editor's language servers (lsp/manager.js): one session per window, folder and server.
  lspOpen: (filePath) => ipcRenderer.invoke('lsp-open', filePath),
  lspSend: (sessionId, message) => ipcRenderer.send('lsp-send', sessionId, message),
  lspClose: (sessionId) => ipcRenderer.invoke('lsp-close', sessionId),
  lspRestart: (sessionId) => ipcRenderer.invoke('lsp-restart', sessionId),
  onLspMessage: (callback) => {
    const handler = (_event, sessionId, message) => callback(sessionId, message);
    ipcRenderer.on('lsp-message', handler);
    return () => ipcRenderer.removeListener('lsp-message', handler);
  },
  onLspState: (callback) => {
    const handler = (_event, sessionId, state) => callback(sessionId, state);
    ipcRenderer.on('lsp-state', handler);
    return () => ipcRenderer.removeListener('lsp-state', handler);
  },
  lspProjectServers: (projectId) => ipcRenderer.invoke('lsp-project-servers', projectId),
  setProjectLspServer: (projectId, serverId, on) => ipcRenderer.invoke('set-project-lsp-server', projectId, serverId, on),
  lspDetect: (projectId) => ipcRenderer.invoke('lsp-detect', projectId),
  // The app's switch for every language server (Settings › Editor).
  getLanguageServers: () => ipcRenderer.invoke('get-language-servers'),
  setLanguageServers: (on) => ipcRenderer.invoke('set-language-servers', on),
  onLanguageServersChanged: (callback) => {
    const handler = (_event, on) => callback(on);
    ipcRenderer.on('language-servers-changed', handler);
    return () => ipcRenderer.removeListener('language-servers-changed', handler);
  },
  lspApplyEdits: (fileEdits, options) => ipcRenderer.invoke('lsp-apply-edits', fileEdits, options),
  editorFindDefinition: (filePath, word) => ipcRenderer.invoke('editor-find-definition', filePath, word),
  editorFormat: (request) => ipcRenderer.invoke('editor-format', request),
  openFileExternally: (filePath, projectRoot) => ipcRenderer.invoke('open-file-externally', filePath, projectRoot),
  shareFile: (filePath) => ipcRenderer.invoke('share-file', filePath),
  resolveTerminalFiles: (references, context) => ipcRenderer.invoke('resolve-terminal-files', references, context),
  resolveDocumentLink: (reference, fromFile) => ipcRenderer.invoke('resolve-document-link', reference, fromFile),
  // The command catalog of a session (command-catalog.js): which CLIs have one, and a session's.
  getCommandCatalogClis: () => ipcRenderer.invoke('get-command-catalog-clis'),
  getCommandCatalog: (sessionId, options) => ipcRenderer.invoke('get-command-catalog', sessionId, options),
  onCommandCatalogUpdated: (callback) => {
    ipcRenderer.on('command-catalog-updated', (_event, info) => callback(info));
  },
  // The prompt improver (prompt-improver.js): rewrite a session's prompt with its CLI, and its settings.
  improvePrompt: (sessionId, prompt, options) => ipcRenderer.invoke('improve-prompt', sessionId, prompt, options),
  cancelPromptImprovement: (sessionId) => ipcRenderer.invoke('cancel-prompt-improvement', sessionId),
  getPromptImproverSettings: () => ipcRenderer.invoke('get-prompt-improver-settings'),
  setPromptImproverSettings: (changes) => ipcRenderer.invoke('set-prompt-improver-settings', changes),
  onPromptImproverSettingsChanged: (callback) => {
    ipcRenderer.on('prompt-improver-settings-changed', (_event, settings) => callback(settings));
  },
  // The Improve prompt window in a window of its own (prompt-improver-windows.js).
  openPromptImproverWindow: (state) => ipcRenderer.invoke('open-prompt-improver-window', state),
  getPromptImproverWindowState: (token) => ipcRenderer.invoke('get-prompt-improver-window-state', token),
  applyPromptImprovement: (request) => ipcRenderer.invoke('apply-prompt-improvement', request),
  onPromptImproverApplyRequest: (callback) => {
    ipcRenderer.on('prompt-improver-apply-request', (_event, request) => callback(request));
  },
  promptImproverApplied: (id, result) => ipcRenderer.send('prompt-improver-applied', id, result),
  listProjectDirectory: (projectPath, relativePath) => ipcRenderer.invoke('list-project-directory', projectPath, relativePath),
  readProjectFile: (projectPath, relativePath) => ipcRenderer.invoke('read-project-file', projectPath, relativePath),
  searchProjectFiles: (root, options) => ipcRenderer.invoke('search-project-files', root, options),
  replaceInProjectFiles: (root, options) => ipcRenderer.invoke('replace-in-project-files', root, options),
  manageProjectEntry: (projectPath, relativePath, action, newName) => ipcRenderer.invoke('manage-project-entry', projectPath, relativePath, action, newName),
  trashProjectEntries: (projectPath, relativePaths) => ipcRenderer.invoke('trash-project-entries', projectPath, relativePaths),
  createProjectEntry: (projectPath, folderRelative, name, kind) => ipcRenderer.invoke('create-project-entry', projectPath, folderRelative, name, kind),
  duplicateProjectEntry: (projectPath, relativePath) => ipcRenderer.invoke('duplicate-project-entry', projectPath, relativePath),
  pasteProjectEntry: (sourcePath, sourceRelative, targetPath, targetRelative, mode) => ipcRenderer.invoke('paste-project-entry', sourcePath, sourceRelative, targetPath, targetRelative, mode),
  getFileTimeline: (projectPath, relativePath) => ipcRenderer.invoke('get-file-timeline', projectPath, relativePath),
  getFileTimelineDiff: (projectPath, relativePath, hash, repoPath, oldPath) => ipcRenderer.invoke('get-file-timeline-diff', projectPath, relativePath, hash, repoPath, oldPath),
  getFileAtCommit: (projectPath, relativePath, hash, repoPath) => ipcRenderer.invoke('get-file-at-commit', projectPath, relativePath, hash, repoPath),
  openFileWithApp: (filePath, projectRoot, appPath) => ipcRenderer.invoke('open-file-with-app', filePath, projectRoot, appPath),
  saveFileForPanel: (filePath, content) => ipcRenderer.invoke('save-file-for-panel', filePath, content),
  // 'save', 'discard' or 'cancel', for an editor with unsaved changes.
  confirmUnsavedChanges: (fileName) => ipcRenderer.invoke('confirm-unsaved-changes', fileName),
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback) => {
    ipcRenderer.on('file-changed', (_event, filePath) => callback(filePath));
  },
});
