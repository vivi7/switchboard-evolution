// What a paired phone may call, and which events it receives.
//
// Remote access is an explicit whitelist: a channel the desktop adds later is
// not callable from a phone until it is listed here, with a check for each
// parameter. Methods call the same handler the window's IPC does
// (ipc-registry.js). Channels that act on the desktop itself (native dialogs,
// Finder, the clipboard, the updater) are deliberately absent.

// --- Parameter checks ---

const isString = (max = 4096) => v => typeof v === 'string' && v.length <= max;
const isId = isString(200);
const isBool = v => typeof v === 'boolean';
const isInt = (min, max) => v => Number.isInteger(v) && v >= min && v <= max;
const isPath = v => typeof v === 'string' && v.length > 0 && v.length <= 4096 && v.startsWith('/');
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const optional = check => v => v === undefined || v === null || check(v);
const arrayOf = (check, max) => v => Array.isArray(v) && v.length <= max && v.every(check);
const oneOf = (...values) => v => values.includes(v);
// A phone's upload travels in one message (the protocol's frame limit is 16 MB).
const MAX_PHONE_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_PHONE_UPLOAD_BYTES / 3) * 4;
const isBase64 = v => typeof v === 'string' && v.length <= MAX_BASE64_LENGTH && /^[A-Za-z0-9+/]*={0,2}$/.test(v);
const isVersion = v => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const isRelative = v => typeof v === 'string' && v.length <= 4096 && !v.startsWith('/');
/** An object with only these keys, each passing its check; `required` keys must be there. */
const fields = (checks, required = []) => v => isPlainObject(v)
  && required.every(key => v[key] !== undefined)
  && Object.keys(v).every(key => Object.hasOwn(checks, key) && checks[key](v[key]));

const METHODS = new Map();

/**
 * Allow a method. `params` is one check per positional parameter; extra
 * parameters are refused. The method name is the IPC channel, unless
 * `channel` says otherwise. A `local` method is not an IPC handler but a
 * function given to createRemoteApi, called with the phone that asked first:
 * the ones that need to know who is calling (attaching a terminal). A module
 * that implements a method itself passes it as `run`, called the same way.
 */
function allow(method, params = [], { channel = method, local = false, run = null } = {}) {
  METHODS.set(method, { channel, params, local, run });
}

// Any CLI the desktop has registered, or a plain terminal.
const isLaunchRuntime = (r) => r === 'terminal' || require('./harnesses').allHarnesses().some(h => h.id === r && h.buildLaunchArgs);

const isLaunchSpec = (v) => isPlainObject(v)
  && ['new', 'resume', 'fork'].includes(v.mode)
  && optional(isId)(v.sessionId)
  && optional(isPath)(v.projectPath)
  && optional(isId)(v.projectId)
  && optional(isId)(v.trackId)
  && optional(isLaunchRuntime)(v.runtime)
  && optional(isString(100000))(v.initialPrompt)
  && optional(isPlainObject)(v.options)
  // Started on a phase or a todo of the project's plan, or by a schedule.
  && optional((p) => isPlainObject(p) && ['plan', 'todos'].includes(p.file) && isString(2000)(p.itemText))(v.planItem)
  && optional(isId)(v.scheduleId);

// Sessions
allow('get-projects', [optional(isBool)]);
allow('get-active-sessions');
allow('get-active-terminals');
allow('get-session-states');
allow('get-harnesses');
allow('get-codex-models');
// The command catalog of a session (command-catalog.js), asked by the
// session's id: a phone never names a folder for the desktop to read.
allow('get-command-catalog-clis');
allow('get-command-catalog', [isId, optional(fields({ cli: isId, runtime: isId }))]);
allow('get-effective-settings', [optional(isPath)]);
allow('get-session-last-message', [isId]);
allow('read-session-entries', [isId, optional(isInt(0, Number.MAX_SAFE_INTEGER))]);
// Only the last entries, for a first look at a long conversation.
allow('read-session-tail', [isId, isInt(1, 5000)]);
allow('search', [isString(20), isString(500), optional(isBool)]);
allow('search-session-ids', [isString(500), optional(arrayOf(isId, 5000))]);
allow('toggle-star', [isId]);
// A project's pinned sessions, in the order they were dragged into.
allow('set-pinned-order', [arrayOf(isId, 1000)]);
allow('rename-session', [isId, optional(isString(200))]);
allow('archive-session', [isId, isInt(0, 1)]);
allow('stop-session', [isId]);
allow('set-session-assignment', [isId, optional(isId), optional(isId)]);
allow('launch-session', [isLaunchSpec]);

// Unread and needs-you marks: the window keeps them (session-notices.js).
allow('get-session-notices', [], { local: true });
allow('mark-read', [isId], { local: true });
allow('mark-unread', [isId], { local: true });
// The session on the phone's screen (or null), which then counts as seen.
allow('set-viewing', [optional(isId)], { local: true });

// IDE diffs from sessions started with IDE emulation. The first answer wins,
// from the window or any phone; editing the change stays on the desktop.
allow('list-pending-diffs', [], { local: true });
allow('mcp-diff-response', [isId, isId, (v) => v === 'accept' || v === 'reject'], { local: true });

// Terminals: output comes per session, to the phones attached to it.
allow('attach-terminal', [isId, optional(isInt(0, Number.MAX_SAFE_INTEGER))], { local: true });
allow('detach-terminal', [isId], { local: true });
allow('terminal-input', [isId, isString(65536)]);
// Resizing reflows the desktop's view too, so only on an explicit request.
allow('fit-terminal', [isId, isInt(20, 500), isInt(5, 300)], { local: true });
allow('unfit-terminal', [isId], { local: true });

// Projects
const isName = isString(200);
const isFolderSpec = fields({
  path: isPath, mode: optional(oneOf('in-place', 'worktree')), branch: optional(isName), copyEnv: optional(arrayOf(isName, 50)),
}, ['path']);
allow('get-project-tree', [optional(isBool)]);
allow('get-projects-root');
allow('list-templates');
allow('create-project', [fields({
  name: isName, folders: optional(arrayOf(isFolderSpec, 20)), branchName: optional(isName), sharedBranch: optional(isBool), template: optional(isName),
}, ['name'])]);
allow('update-project', [isId, fields({
  name: isName, status: oneOf('active', 'done'), sharedBranch: isBool, branchName: optional(isName),
  defaultCwd: optional(isPath), snoozedUntil: optional(isString(40)), starred: isBool,
})]);
// The Starred section, in the order it was dragged into.
allow('set-starred-order', [arrayOf(isId, 1000)]);
// A project's picture: read to show it in the project's square, and set from a
// file picked on the phone (a name and its bytes), which the computer makes into the icon.
allow('get-project-icon', [isId]);
allow('import-project-icon', [isId, isString(255), isBase64]);
// Forgets the project; its folder stays on disk.
allow('delete-project', [isId]);
allow('create-track', [isId, fields({ name: isName, cwd: optional(isPath), cli: optional(isString(40)) }, ['name'])]);
allow('update-track', [isId, fields({
  name: isName, cwd: optional(isPath), cli: optional(isString(40)), status: oneOf('active', 'done'), sortOrder: isInt(-1e6, 1e6),
})]);
allow('delete-track', [isId, optional(fields({ archiveSessions: isBool }))]);
allow('attach-project-folder', [isId, isFolderSpec]);
allow('detach-project-folder', [isId, isPath, optional(fields({ removeWorktree: isBool, force: isBool }))]);
// The folder picker the window gets from the system (remote-files.js).
allow('list-folders', [optional(isPath), optional(isBool)], { local: true });
// Its New Folder: one name inside the folder the picker shows.
allow('create-folder', [isPath, isString(255)], { local: true });

// The plan: plan-tracker.md ('plan') and todos.md ('todos'). Lines are 0-based;
// a change to a line carries the text the phone saw there, checked first, so
// a plan that moved meanwhile is not changed in the wrong place.
const isPlanFile = oneOf('plan', 'todos');
const isLine = isInt(0, 1_000_000);
const isItemText = v => isString(2000)(v) && !/[\r\n]/.test(v);
allow('get-project-plan', [isId]);
allow('set-plan-item', [isId, isPlanFile, isLine, isBool, isString(2000)], { local: true });
allow('edit-plan-item', [isId, isPlanFile, isLine, isItemText, isString(2000)], { local: true });
allow('append-plan-item', [isId, isPlanFile, isItemText]);
allow('create-project-file', [isId, oneOf('plan.md', 'plan-tracker.md', 'todos.md', 'memory.md', 'note.md'), optional(isString(2_000_000))]);
allow('save-project-brief', [isId, isString(2_000_000)]);
// The Env tab: the local.env.sh of the project folder and of each attached folder
// (projects.js checks that the folder is one of the project's). Reading and saving
// one goes through read-project-file and save-project-file.
allow('project-env-files', [isId]);
allow('create-project-env-file', [isId, isPath]);
allow('exclude-project-env-file', [isId, isPath]);

// Files, inside a project's folders only (remote-files.js), and Claude's plans to read and save.
allow('list-recent-project-files', [isId]);
allow('list-project-directory', [isPath, isRelative], { local: true });
allow('read-project-file', [isPath, isRelative], { local: true });
// Where a path a session mentions is (absolute, ~/, or relative to the session's folder `cwd`):
// the folder and relative path to open it with, if it is in one a phone may read.
allow('locate-file', [isString(4096), optional(isPath)], { local: true });
// Any file of those folders, for the phone to download: a piece of it from a byte offset.
allow('read-project-file-chunk', [isPath, isRelative, isInt(0, Number.MAX_SAFE_INTEGER)], { local: true });
// A save may carry the version the phone read (sha1); if the file has changed since, nothing is written.
allow('save-project-file', [isPath, isRelative, isString(2_000_000), optional(isVersion)], { local: true });
// Rename or move to the Trash only; revealing in Finder would act on the Mac's screen.
allow('manage-project-entry', [isPath, isRelative, oneOf('rename', 'trash'), optional(isString(255))], { local: true });
allow('trash-project-entries', [isPath, arrayOf(isRelative, 5000)], { local: true });
// A file from the phone into a folder, a piece at a time (remote-files.js): `upload` names it,
// `last` puts it in the folder, `conflict` says what an entry of that name already there becomes.
allow('upload-project-file-chunk', [isPath, isRelative, isString(255), fields({
  upload: v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v),
  offset: isInt(0, Number.MAX_SAFE_INTEGER),
  base64: optional(isBase64),
  last: optional(isBool),
  conflict: optional(oneOf('replace', 'keep-both')),
  abort: optional(isBool),
}, ['upload', 'offset'])], { local: true });
// The explorer of the Files tab: a new file or folder (name may hold "/"), a copy next to an
// entry, a copied or cut entry pasted into a folder of the same or another known root.
allow('create-project-entry', [isPath, isRelative, isString(1000), oneOf('file', 'folder')], { local: true });
allow('duplicate-project-entry', [isPath, isRelative], { local: true });
allow('paste-project-entry', [isPath, isRelative, isPath, isRelative, oneOf('copy', 'move')], { local: true });
// The Timeline of a file: the commits that changed it, and the file before and after one (hash null: uncommitted).
allow('get-file-timeline', [isPath, isRelative], { local: true });
allow('get-file-timeline-diff', [isPath, isRelative, v => v === null || isString(64)(v), optional(isString(4096)), optional(isString(4096))], { local: true });
// Search and replace across a folder, as the Files tab's Search does.
const isSearchQuery = {
  query: isString(1000), isRegex: optional(isBool), matchCase: optional(isBool), wholeWord: optional(isBool),
  include: optional(isString(2000)), exclude: optional(isString(2000)),
};
const isReplaceMatch = fields({ line: isInt(1, 100_000_000), column: isInt(0, 100_000_000), length: isInt(0, 100_000_000), text: isString(100_000) }, ['line', 'column', 'text']);
allow('search-project-files', [isPath, fields({ ...isSearchQuery, maxResults: optional(isInt(1, 20000)) }, ['query'])], { local: true });
allow('replace-in-project-files', [isPath, fields({
  ...isSearchQuery, replace: isString(100_000),
  files: arrayOf(fields({ path: isRelative, matches: optional(arrayOf(isReplaceMatch, 20000)) }, ['path']), 20000),
}, ['query', 'replace', 'files'])], { local: true });
// Bytes into the project's added-files folder.
allow('add-project-file-bytes', [isId, isString(255), isBase64], { local: true });
// A photo or file for a session, saved under the data folder (remote-attachments.js); the answer carries the path to paste.
allow('save-session-attachment', [isId, isString(255), isBase64], { local: true });

// Schedules: the timings the window offers (no cron, which only comes from imported files).
const scheduleFields = {
  name: isName, prompt: isString(100000), trackId: optional(isId),
  every: oneOf('15m', '30m', 'hour', 'day', 'weekdays', 'week'),
  atHour: optional(isInt(0, 23)), atMinute: optional(isInt(0, 59)), weekday: optional(isInt(0, 6)),
  cli: optional(isString(40)), enabled: isBool, catchUp: isBool, sessionConfig: isPlainObject,
};
allow('list-schedules');
allow('create-schedule', [fields({ ...scheduleFields, projectId: optional(isId), cwd: optional(isPath) }, ['name', 'prompt'])]);
allow('update-schedule', [isId, fields(scheduleFields)]);
allow('delete-schedule', [isId]);
allow('resolve-schedule-launch', [isId]);
// Run now, with the schedule's own options (remote-launch.js).
allow('run-schedule', [isId], { local: true });
allow('get-schedule-context', [fields({ projectId: optional(isId), trackId: optional(isId), cwd: optional(isPath), cli: optional(isString(40)) })]);
allow('get-project-git-status', [isId, optional(isPlainObject)]);
allow('get-project-git-info', [isId]);
allow('get-project-git-diff', [isId, isPath, isString(4096), optional(oneOf('unstaged', 'staged'))]);
// Staging, as the Git tab does it: whole files, or the picked lines of one side's diff.
allow('stage-project-git-files', [isId, isPath, v => v === null || arrayOf(isString(4096), 5000)(v), isBool]);
allow('stage-project-git-lines', [isId, isPath, isString(4096), oneOf('unstaged', 'staged'), isVersion, arrayOf(isInt(0, 10_000_000), 200_000)]);
// The Changes list's row menu: discard working-tree changes (null: all of them; untracked files go to
// the Trash on the computer, after the phone asked), add paths to .gitignore, optionally leaving Git too.
allow('discard-project-git-files', [isId, isPath, v => v === null || arrayOf(isString(4096), 5000)(v)]);
allow('ignore-project-git-paths', [isId, isPath, arrayOf(isString(4096), 5000), isBool]);
allow('read-project-git-edit-file', [isId, isPath, isString(4096)]);
allow('save-project-git-edit-file', [isId, isPath, isString(4096), isString(2_000_000), optional(isVersion)]);

// Usage and app
allow('get-usage');
allow('get-codex-usage');
allow('get-stats');
allow('get-app-version');

/**
 * Events every phone receives. Terminal output does not go to everyone: it
 * goes to the phones attached to that session (terminal-fanout.js).
 */
const EVENTS = new Set([
  'projects-changed',
  'harnesses-changed',
  'cli-busy-state',
  'cli-subagent-state',
  'terminal-notification',
  'process-exited',
  'session-detected',
  'session-forked',
  'project-plan-changed',
  'session-notices-changed',
  'mcp-open-diff',
  'mcp-close-tab',
  'mcp-close-all-diffs',
  'mcp-diff-resolved',
  // Newer CLI docs for the command catalog (command-docs-refresh.js).
  'command-catalog-updated',
]);

function createRemoteApi({ getHandler, localMethods = {} }) {
  const implementation = (spec) => (spec.run ? { local: spec.run }
    : spec.local ? (localMethods[spec.channel] ? { local: localMethods[spec.channel] } : null)
    : getHandler(spec.channel));

  /** The methods this desktop actually has: listed here and implemented. */
  function capabilities() {
    return [...METHODS].filter(([, spec]) => implementation(spec)).map(([method]) => method).sort();
  }

  /** Call a method for a phone. Resolves { result } or { error }. */
  async function call(method, params, client = null) {
    const spec = METHODS.get(method);
    if (!spec) return { error: `Not available remotely: ${method}` };
    const handler = implementation(spec);
    if (!handler) return { error: `Not available on this desktop: ${method}` };
    const args = params === undefined ? [] : params;
    if (!Array.isArray(args) || args.length > spec.params.length) return { error: `Wrong parameters for ${method}` };
    for (let i = 0; i < spec.params.length; i++) {
      let ok = false;
      try { ok = spec.params[i](args[i]); } catch {}
      if (!ok) return { error: `Wrong parameter ${i + 1} for ${method}` };
    }
    try {
      const result = handler.local ? await handler.local(client, ...args) : await handler.fn(null, ...args);
      // Through JSON, the same shape the phone will decode.
      return { result: result === undefined ? null : JSON.parse(JSON.stringify(result)) };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  }

  return { call, capabilities, forwardsEvent: (channel) => EVENTS.has(channel) };
}

/** Let phones hear an event, for a module that adds its own methods with allow(). */
function allowEvent(channel) {
  EVENTS.add(channel);
}

module.exports = { createRemoteApi, allow, allowEvent, MAX_PHONE_UPLOAD_BYTES };
