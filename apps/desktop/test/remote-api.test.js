const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRemoteApi } = require('../remote-api');

/** An API over a few fake handlers, recording how they were called. */
function setup(handlers) {
  const calls = [];
  const registry = new Map(Object.entries(handlers).map(([channel, fn]) => [channel, {
    kind: 'handle',
    fn: (...args) => { calls.push([channel, ...args]); return fn(...args.slice(1)); },
  }]));
  return { api: createRemoteApi({ getHandler: (channel) => registry.get(channel) || null }), calls };
}

test('a listed method calls the window handler with a null event', async () => {
  const { api, calls } = setup({ 'rename-session': (id, name) => ({ name }) });
  assert.deepEqual(await api.call('rename-session', ['s1', 'Login work']), { result: { name: 'Login work' } });
  assert.deepEqual(calls, [['rename-session', null, 's1', 'Login work']]);
});

test('a channel that is not listed cannot be called, even if it exists', async () => {
  const { api, calls } = setup({ 'open-external': () => true, 'set-setting': () => true });
  assert.match((await api.call('open-external', ['https://example.com'])).error, /Not available remotely/);
  assert.match((await api.call('set-setting', ['global', {}])).error, /Not available remotely/);
  assert.equal(calls.length, 0);
});

test('a listed method this desktop does not have is reported, not called', async () => {
  const { api } = setup({});
  assert.match((await api.call('get-projects', [false])).error, /Not available on this desktop/);
});

test('parameters are checked before the handler runs', async () => {
  const { api, calls } = setup({ 'archive-session': () => ({ archived: 1 }), 'get-project-git-diff': () => '' });
  assert.match((await api.call('archive-session', ['s1', 'yes'])).error, /Wrong parameter 2/);
  assert.match((await api.call('archive-session', ['s1', 1, 'extra'])).error, /Wrong parameters/);
  assert.match((await api.call('archive-session', 's1')).error, /Wrong parameters/);
  assert.match((await api.call('get-project-git-diff', ['p1', 'relative/path', 'a.js'])).error, /Wrong parameter 2/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await api.call('archive-session', ['s1', 1]), { result: { archived: 1 } });
});

test('a handler error becomes an error reply, and results go through JSON', async () => {
  const { api } = setup({
    'get-stats': () => { throw new Error('stats-cache.json is missing'); },
    'get-project-tree': () => ({ when: new Date(0), skip: undefined }),
  });
  assert.deepEqual(await api.call('get-stats'), { error: 'stats-cache.json is missing' });
  assert.deepEqual(await api.call('get-project-tree', [false]), { result: { when: '1970-01-01T00:00:00.000Z' } });
});

test('capabilities list only the methods the desktop has', () => {
  const { api } = setup({ 'get-projects': () => [], 'toggle-star': () => ({}), 'browse-folder': () => null });
  assert.deepEqual(api.capabilities(), ['get-projects', 'toggle-star']);
});

test('only phone-safe events are forwarded', () => {
  const { api } = setup({});
  assert.equal(api.forwardsEvent('cli-busy-state'), true);
  assert.equal(api.forwardsEvent('projects-changed'), true);
  assert.equal(api.forwardsEvent('terminal-data'), false);
  assert.equal(api.forwardsEvent('updater-event'), false);
  assert.equal(api.forwardsEvent('mcp-open-file'), false);
  // Meant for the window only: what phones are looking at, their read commands.
  assert.equal(api.forwardsEvent('remote-viewing'), false);
  assert.equal(api.forwardsEvent('remote-mark-read'), false);
  assert.equal(api.forwardsEvent('window-visibility'), false);
});

test('local methods get the calling phone first, and need an implementation', async () => {
  const calls = [];
  const api = createRemoteApi({
    getHandler: () => null,
    localMethods: {
      'attach-terminal': (client, id, since) => { calls.push([client.name, id, since]); return { seq: 7 }; },
      'fit-terminal': () => true,
    },
  });
  assert.deepEqual(await api.call('attach-terminal', ['s1', 3], { name: 'phone' }), { result: { seq: 7 } });
  assert.deepEqual(calls, [['phone', 's1', 3]]);
  assert.match((await api.call('detach-terminal', ['s1'], { name: 'phone' })).error, /Not available on this desktop/);
  assert.match((await api.call('fit-terminal', ['s1', 10, 30], { name: 'phone' })).error, /Wrong parameter 2/);
  assert.ok(api.capabilities().includes('attach-terminal'));
  assert.ok(!api.capabilities().includes('detach-terminal'));
});

test('a launch request is checked field by field', async () => {
  const { api, calls } = setup({ 'launch-session': (spec) => ({ sessionId: 'new-id', spec }) });
  assert.equal((await api.call('launch-session', [{ mode: 'new', projectPath: '/p/app', runtime: 'claude', initialPrompt: 'Hi' }])).result.sessionId, 'new-id');
  for (const bad of [
    { mode: 'delete' },
    { mode: 'new', projectPath: 'relative/path' },
    { mode: 'new', projectPath: '/p', runtime: 'bash -c rm' },
    { mode: 'resume', sessionId: 42 },
    { mode: 'new', projectPath: '/p', options: 'yes' },
    'new',
  ]) {
    assert.match((await api.call('launch-session', [bad])).error, /Wrong parameter 1/, JSON.stringify(bad));
  }
  assert.equal(calls.length, 1);
});

test('phones hear about marks and IDE diffs', () => {
  const { api } = setup({});
  for (const channel of ['session-notices-changed', 'mcp-open-diff', 'mcp-close-tab', 'mcp-close-all-diffs', 'mcp-diff-resolved']) {
    assert.equal(api.forwardsEvent(channel), true, channel);
  }
});

test('marks, viewing and diff answers are local methods with checked parameters', async () => {
  const calls = [];
  const record = (name) => (client, ...args) => { calls.push([name, client.name, ...args]); return true; };
  const api = createRemoteApi({
    getHandler: () => null,
    localMethods: Object.fromEntries(['get-session-notices', 'mark-read', 'mark-unread', 'set-viewing', 'list-pending-diffs', 'mcp-diff-response']
      .map(name => [name, record(name)])),
  });
  const phone = { name: 'phone' };
  assert.deepEqual(await api.call('set-viewing', ['s1'], phone), { result: true });
  assert.deepEqual(await api.call('set-viewing', [null], phone), { result: true });
  assert.deepEqual(await api.call('mark-read', ['s1'], phone), { result: true });
  assert.deepEqual(await api.call('mcp-diff-response', ['s1', 'd1', 'reject'], phone), { result: true });
  assert.match((await api.call('mark-unread', [7], phone)).error, /Wrong parameter 1/);
  assert.match((await api.call('mcp-diff-response', ['s1', 'd1', 'accept-edited'], phone)).error, /Wrong parameter 3/);
  assert.match((await api.call('mcp-diff-response', ['s1', 'd1'], phone)).error, /Wrong parameter 3/);
  assert.match((await api.call('list-pending-diffs', ['s1'], phone)).error, /Wrong parameters/);
  assert.deepEqual(calls, [
    ['set-viewing', 'phone', 's1'],
    ['set-viewing', 'phone', null],
    ['mark-read', 'phone', 's1'],
    ['mcp-diff-response', 'phone', 's1', 'd1', 'reject'],
  ]);
});

test('a launch can name a plan item or a schedule, checked like the rest', async () => {
  const { api, calls } = setup({ 'launch-session': (spec) => ({ sessionId: 'id', spec }) });
  const ok = { mode: 'new', projectPath: '/p', projectId: 'proj', planItem: { file: 'todos', itemText: 'Write tests' }, scheduleId: 's1' };
  assert.equal((await api.call('launch-session', [ok])).result.sessionId, 'id');
  for (const bad of [
    { ...ok, planItem: 'Write tests' },
    { ...ok, planItem: { file: 'other', itemText: 'x' } },
    { ...ok, planItem: { file: 'plan', itemText: 7 } },
    { ...ok, scheduleId: 42 },
  ]) {
    assert.match((await api.call('launch-session', [bad])).error, /Wrong parameter 1/, JSON.stringify(bad));
  }
  assert.equal(calls.length, 1);
});

test('project, track and folder changes take only the fields the window sends', async () => {
  const handlers = Object.fromEntries(['create-project', 'update-project', 'delete-project', 'create-track', 'update-track', 'delete-track',
    'attach-project-folder', 'detach-project-folder', 'create-project-file', 'save-project-brief', 'get-projects-root', 'append-plan-item']
    .map(name => [name, () => ({ ok: true })]));
  const { api, calls } = setup(handlers);
  const good = [
    ['create-project', [{ name: 'Billing', folders: [{ path: '/code/billing', mode: 'worktree', branch: 'feat/x' }], template: 'web' }]],
    ['update-project', ['p1', { snoozedUntil: '2026-11-02T08:00:00.000Z' }]],
    ['update-project', ['p1', { status: 'done', name: 'Billing v2', defaultCwd: null }]],
    ['update-project', ['p1', { starred: true }]],
    ['delete-project', ['p1']],
    ['create-track', ['p1', { name: 'API', cli: 'codex' }]],
    ['update-track', ['t1', { status: 'done' }]],
    ['delete-track', ['t1', { archiveSessions: true }]],
    ['attach-project-folder', ['p1', { path: '/code/web' }]],
    ['detach-project-folder', ['p1', '/code/web', { removeWorktree: true }]],
    ['create-project-file', ['p1', 'todos.md']],
    ['create-project-file', ['p1', 'note.md']],
    ['save-project-brief', ['p1', '# Brief']],
    ['get-projects-root', []],
    ['append-plan-item', ['p1', 'todos', 'Write docs']],
  ];
  for (const [method, params] of good) assert.deepEqual(await api.call(method, params), { result: { ok: true } }, method);
  const bad = [
    ['create-project', [{ folders: [] }]],
    ['create-project', [{ name: 'X', folders: [{ path: 'relative' }] }]],
    ['create-project', [{ name: 'X', root: '/etc' }]],
    ['update-project', ['p1', { status: 'archived' }]],
    ['update-project', ['p1', { root: '/etc' }]],
    ['update-project', ['p1', { starred: 'yes' }]],
    ['create-track', ['p1', { cwd: '/code' }]],
    ['update-track', ['t1', { status: 'paused' }]],
    ['attach-project-folder', ['p1', { path: '/code', mode: 'copy' }]],
    ['create-project-file', ['p1', '../etc/passwd']],
    ['append-plan-item', ['p1', 'todos', 'Two\n## lines']],
  ];
  for (const [method, params] of bad) assert.match((await api.call(method, params)).error, /Wrong parameter/, `${method} ${JSON.stringify(params)}`);
  assert.equal(calls.length, good.length);
});

test("a phone reads a project's picture and sends a file for it, never the finished one", async () => {
  const handlers = Object.fromEntries(['get-project-icon', 'import-project-icon', 'set-project-icon'].map(name => [name, () => ({ ok: true })]));
  const { api, calls } = setup(handlers);
  assert.deepEqual(await api.call('get-project-icon', ['p1']), { result: { ok: true } });
  assert.deepEqual(await api.call('import-project-icon', ['p1', 'logo.svg', 'PHN2Zy8+']), { result: { ok: true } });
  assert.match((await api.call('get-project-icon', [{ id: 'p1' }])).error, /Wrong parameter 1/);
  assert.match((await api.call('import-project-icon', ['p1', 'logo.svg', 'not base64!'])).error, /Wrong parameter 3/);
  assert.match((await api.call('set-project-icon', ['p1', null])).error, /Not available remotely/);
  assert.equal(calls.length, 2);
});

test('schedules from a phone: the window\'s timings only, no cron or source file', async () => {
  const { api, calls } = setup({ 'create-schedule': () => ({ ok: true }), 'update-schedule': () => ({ ok: true }), 'get-schedule-context': () => ({}) });
  const spec = { name: 'Nightly', prompt: 'Check the build', projectId: 'p1', every: 'day', atHour: 2, atMinute: 30, cli: 'claude', enabled: true };
  assert.deepEqual(await api.call('create-schedule', [spec]), { result: { ok: true } });
  assert.deepEqual(await api.call('update-schedule', ['s1', { enabled: false }]), { result: { ok: true } });
  assert.deepEqual(await api.call('get-schedule-context', [{ projectId: 'p1' }]), { result: {} });
  for (const bad of [{ ...spec, every: 'cron', cron: '* * * * *' }, { ...spec, sourceFile: '/x.md' }, { ...spec, atHour: 24 }, { ...spec, name: undefined }]) {
    assert.match((await api.call('create-schedule', [bad])).error, /Wrong parameter 1/, JSON.stringify(bad));
  }
  assert.equal(calls.length, 3);
});

test('plan edits, file reads and saves and the folder picker are local methods', async () => {
  const names = ['set-plan-item', 'edit-plan-item', 'list-project-directory', 'read-project-file', 'save-project-file', 'list-folders', 'create-folder'];
  const calls = [];
  const api = createRemoteApi({ getHandler: () => null, localMethods: Object.fromEntries(names.map(n => [n, (client, ...args) => { calls.push([n, ...args]); return { ok: true }; }])) });
  // The text the phone saw on that line comes along, to be checked before changing it.
  assert.deepEqual(await api.call('set-plan-item', ['p1', 'plan', 4, true, 'Routes'], {}), { result: { ok: true } });
  assert.deepEqual(await api.call('edit-plan-item', ['p1', 'todos', 2, 'Write the docs', 'Write docs'], {}), { result: { ok: true } });
  assert.deepEqual(await api.call('list-project-directory', ['/code/web', 'src'], {}), { result: { ok: true } });
  assert.deepEqual(await api.call('read-project-file', ['/code/web', 'README.md'], {}), { result: { ok: true } });
  assert.deepEqual(await api.call('save-project-file', ['/code/web', 'README.md', '# Hi'], {}), { result: { ok: true } });
  assert.deepEqual(await api.call('list-folders', [], {}), { result: { ok: true } });
  assert.deepEqual(await api.call('create-folder', ['/code', 'web'], {}), { result: { ok: true } });
  assert.match((await api.call('set-plan-item', ['p1', 'memory', 4, true, 'x'], {})).error, /Wrong parameter 2/);
  assert.match((await api.call('set-plan-item', ['p1', 'plan', -1, true, 'x'], {})).error, /Wrong parameter 3/);
  assert.match((await api.call('set-plan-item', ['p1', 'plan', 4, true], {})).error, /Wrong parameter 5/);
  assert.match((await api.call('edit-plan-item', ['p1', 'todos', 2, 'a\nb', 'x'], {})).error, /Wrong parameter 4/);
  assert.match((await api.call('list-project-directory', ['/code/web', '/etc'], {})).error, /Wrong parameter 2/);
  assert.match((await api.call('read-project-file', ['/code/web', '/etc/passwd'], {})).error, /Wrong parameter 2/);
  assert.match((await api.call('list-folders', ['relative'], {})).error, /Wrong parameter 1/);
  assert.match((await api.call('create-folder', ['relative', 'web'], {})).error, /Wrong parameter 1/);
  assert.match((await api.call('create-folder', ['/code'], {})).error, /Wrong parameter 2/);
  assert.match((await api.call('create-folder', ['/code', 'x'.repeat(256)], {})).error, /Wrong parameter 2/);
  assert.equal(calls.length, 7);
});

test('field checks only know their own fields, and a check that throws is a refusal', async () => {
  const { api, calls } = setup({ 'update-project': () => ({ ok: true }) });
  for (const patch of [{ constructor: 'x' }, { toString: 1 }, { hasOwnProperty: 'name' }, JSON.parse('{"__proto__": {"name": "x"}}')]) {
    assert.match((await api.call('update-project', ['p1', patch])).error, /Wrong parameter 2/, JSON.stringify(patch));
  }
  const throwing = { get name() { throw new Error('boom'); } };
  assert.match((await api.call('update-project', ['p1', throwing])).error, /Wrong parameter 2/);
  assert.equal(calls.length, 0);
});

test('another module can let phones hear one of its events', () => {
  const { allowEvent } = require('../remote-api');
  const { api } = setup({});
  assert.equal(api.forwardsEvent('some-feature-changed'), false);
  allowEvent('some-feature-changed');
  assert.equal(api.forwardsEvent('some-feature-changed'), true);
});

test('a module can run a method itself, with the calling phone first', async () => {
  const { allow } = require('../remote-api');
  allow('module-owned-method', [isIdLike], { run: (client, value) => ({ by: client.name, value }) });
  const api = createRemoteApi({ getHandler: () => null });
  assert.deepEqual(await api.call('module-owned-method', ['x1'], { name: 'phone' }), { result: { by: 'phone', value: 'x1' } });
  assert.match((await api.call('module-owned-method', [42], { name: 'phone' })).error, /Wrong parameter 1/);
  assert.ok(api.capabilities().includes('module-owned-method'));
});

function isIdLike(v) { return typeof v === 'string'; }

test('a phone can search and replace in a folder, with only the known fields', async () => {
  const calls = [];
  const api = createRemoteApi({
    getHandler: () => null,
    localMethods: {
      'search-project-files': (_client, root, opts) => { calls.push(['search', root, opts]); return { ok: true, files: [] }; },
      'replace-in-project-files': (_client, root, opts) => { calls.push(['replace', root, opts]); return { ok: true, replaced: 1 }; },
    },
  });
  const phone = { name: 'phone' };
  const query = { query: 'greet', isRegex: false, matchCase: true, wholeWord: false };
  assert.deepEqual((await api.call('search-project-files', ['/p/app', { ...query, include: 'src', maxResults: 2000 }], phone)).result, { ok: true, files: [] });
  const match = { line: 3, column: 4, length: 5, text: 'greet' };
  assert.equal((await api.call('replace-in-project-files', ['/p/app', { ...query, replace: 'hello', files: [{ path: 'src/a.js', matches: [match] }, { path: 'b.js' }] }], phone)).result.replaced, 1);
  // A field the desktop does not know, a match out of range, or an absolute path is refused.
  assert.match((await api.call('search-project-files', ['/p/app', { ...query, extra: 1 }], phone)).error, /Wrong parameter 2/);
  assert.match((await api.call('replace-in-project-files', ['/p/app', { ...query, replace: '', files: [{ path: 'a.js', matches: [{ ...match, line: 0 }] }] }], phone)).error, /Wrong parameter 2/);
  assert.match((await api.call('replace-in-project-files', ['/p/app', { ...query, replace: '', files: [{ path: '/etc/hosts' }] }], phone)).error, /Wrong parameter 2/);
  assert.equal(calls.length, 2);
});

test('a phone can stage files and the picked lines of one side of a diff', async () => {
  const { api, calls } = setup({
    'get-project-git-diff': () => ({ ok: true }),
    'stage-project-git-files': () => ({ ok: true }),
    'stage-project-git-lines': () => ({ ok: true }),
  });
  const id = 'a'.repeat(40);
  assert.ok((await api.call('get-project-git-diff', ['p1', '/r', 'a.js', 'staged'])).result.ok);
  assert.ok((await api.call('stage-project-git-files', ['p1', '/r', ['a.js', 'old.js'], false])).result.ok);
  assert.ok((await api.call('stage-project-git-files', ['p1', '/r', null, true])).result.ok);
  assert.ok((await api.call('stage-project-git-lines', ['p1', '/r', 'a.js', 'unstaged', id, [5, 6]])).result.ok);
  assert.match((await api.call('get-project-git-diff', ['p1', '/r', 'a.js', 'both'])).error, /Wrong parameter 4/);
  assert.match((await api.call('stage-project-git-lines', ['p1', '/r', 'a.js', 'unstaged', 'not-a-sha', [5]])).error, /Wrong parameter 5/);
  assert.equal(calls.length, 4);
});

test('a phone can discard changes and add paths to .gitignore, with or without leaving Git', async () => {
  const { api, calls } = setup({
    'discard-project-git-files': () => ({ ok: true }),
    'ignore-project-git-paths': () => ({ ok: true }),
  });
  assert.ok((await api.call('discard-project-git-files', ['p1', '/r', ['src', 'a.js']])).result.ok);
  assert.ok((await api.call('discard-project-git-files', ['p1', '/r', null])).result.ok);
  assert.ok((await api.call('ignore-project-git-paths', ['p1', '/r', ['dist'], true])).result.ok);
  assert.match((await api.call('discard-project-git-files', ['p1', '/r', 'a.js'])).error, /Wrong parameter 3/);
  assert.match((await api.call('ignore-project-git-paths', ['p1', '/r', null, false])).error, /Wrong parameter 3/);
  assert.match((await api.call('ignore-project-git-paths', ['p1', '/r', ['dist'], 'yes'])).error, /Wrong parameter 4/);
  assert.equal(calls.length, 3);
});

test('a phone can read a changed file to edit and save it, against its version', async () => {
  const { api, calls } = setup({
    'read-project-git-edit-file': () => ({ ok: true, content: 'a', base: '', version: 'f'.repeat(40) }),
    'save-project-git-edit-file': () => ({ ok: true, version: 'e'.repeat(40) }),
  });
  assert.ok((await api.call('read-project-git-edit-file', ['p1', '/r', 'src/a.js'])).result.ok);
  assert.ok((await api.call('save-project-git-edit-file', ['p1', '/r', 'src/a.js', 'text', 'f'.repeat(40)])).result.ok);
  assert.ok((await api.call('save-project-git-edit-file', ['p1', '/r', 'src/a.js', 'text'])).result.ok);
  assert.match((await api.call('save-project-git-edit-file', ['p1', '/r', 'src/a.js', 'text', 'v1'])).error, /Wrong parameter 5/);
  assert.match((await api.call('save-project-git-edit-file', ['p1', '/r', 'src/a.js', 42])).error, /Wrong parameter 4/);
  assert.equal(calls.length, 3);
});

test('the phone can start any CLI the desktop has, and nothing else', async () => {
  const { api } = setup({ 'launch-session': (spec) => ({ sessionId: 'id', spec }) });
  for (const runtime of ['claude', 'codex', 'opencode', 'terminal']) {
    const reply = await api.call('launch-session', [{ mode: 'new', projectPath: '/p/app', runtime }]);
    assert.equal(reply.result?.sessionId, 'id', runtime);
  }
  assert.match((await api.call('launch-session', [{ mode: 'new', projectPath: '/p/app', runtime: 'gemini' }])).error, /Wrong parameter 1/);
});

test('a phone asks for the command catalog of a session by its id, and nothing else', async () => {
  const { api, calls } = setup({ 'get-command-catalog': (id, options) => ({ id, cli: options?.cli || 'claude' }), 'get-command-catalog-clis': () => ['claude'] });
  assert.deepEqual(await api.call('get-command-catalog-clis', []), { result: ['claude'] });
  assert.deepEqual(await api.call('get-command-catalog', ['s1']), { result: { id: 's1', cli: 'claude' } });
  assert.deepEqual(await api.call('get-command-catalog', ['s1', { cli: 'codex' }]), { result: { id: 's1', cli: 'codex' } });
  assert.match((await api.call('get-command-catalog', ['s1', { cli: 'codex', cwd: '/etc' }])).error, /Wrong parameter 2/);
  assert.deepEqual(await api.call('get-command-catalog', ['s1', { runtime: 'codex' }]), { result: { id: 's1', cli: 'claude' } });
  assert.match((await api.call('get-command-catalog', [{ path: '/etc' }])).error, /Wrong parameter 1/);
  assert.equal(calls.filter((c) => c[0] === 'get-command-catalog').length, 3);
  // Phones hear when newer docs were read, to ask again.
  assert.equal(api.forwardsEvent('command-catalog-updated'), true);
});

test('a phone reads the Env tab\'s list, makes a local.env.sh and keeps it out of Git, with checked parameters', async () => {
  const { api, calls } = setup({
    'project-env-files': (id) => ({ ok: true, fileName: 'local.env.sh', entries: [{ path: '/work/p', kind: 'project', exists: true, gitIgnored: null }] }),
    'create-project-env-file': (id, folder) => ({ ok: true, filePath: `${folder}/local.env.sh` }),
    'exclude-project-env-file': (id, folder) => ({ ok: true, pattern: '/local.env.sh' }),
  });
  assert.equal((await api.call('project-env-files', ['p1'])).result.entries[0].kind, 'project');
  assert.deepEqual((await api.call('create-project-env-file', ['p1', '/work/app'])).result, { ok: true, filePath: '/work/app/local.env.sh' });
  assert.equal((await api.call('exclude-project-env-file', ['p1', '/work/app'])).result.pattern, '/local.env.sh');
  assert.match((await api.call('create-project-env-file', ['p1', 'relative/app'])).error, /Wrong parameter 2/);
  assert.match((await api.call('exclude-project-env-file', ['p1'])).error, /Wrong parameter 2/, 'the folder is required');
  assert.equal(calls.length, 3);
  assert.ok(api.capabilities().includes('project-env-files'));
});
