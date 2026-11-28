const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/project-git-view.js'), 'utf8');

/** public/project-git-view.js only defines functions and a Map at top level, so it loads whole in a vm context given the same globals the renderer provides. */
function loadContext(localStorageImpl) {
  const context = vm.createContext({
    document: { createElement: () => ({
      dataset: {},
      focus() { context.focused = this; },
      style: { setProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      appendChild() {},
      addEventListener() {},
      remove() {},
      querySelectorAll: () => [],
    }) },
    window: { api: {} },
    escapeHtml: (str) => String(str),
    pathBasename: (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || '',
    formatDate: () => 'just now',
    PICONS: {
      branch: () => '<svg data-icon="branch"></svg>',
      list: () => '<svg data-icon="list"></svg>',
      tree: () => '<svg data-icon="tree"></svg>',
      folder: () => '<svg data-icon="folder"></svg>',
      chevronDown: () => '<svg data-icon="chevron-down"></svg>',
      chevronRight: () => '<svg data-icon="chevron-right"></svg>',
    },
    localStorage: localStorageImpl || { getItem() { return null; }, setItem() {} },
    GitChangeActions: require('../public/git-change-actions'),
    alert: () => {},
  });
  vm.runInContext(source, context);
  return context;
}

function change(p, extra) {
  return Object.assign({ path: p, status: 'modified' }, extra);
}

// Values built inside the vm context are objects of that realm (its own
// Array/Object), so deepStrictEqual against a plain literal here would fail
// on prototype identity alone. A JSON round-trip normalizes to this realm.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('buildGitChangeTree nests by folder, sorting folders before files, natural + case-insensitive', () => {
  const ctx = loadContext();
  const changes = [
    change('src/b.js'),
    change('src/A.js'),
    change('readme.md'),
    change('src/file10.js'),
    change('src/file2.js'),
    change('assets/logo.png'),
  ];
  const tree = ctx.buildGitChangeTree(changes);

  assert.deepEqual(plain(tree.map(n => [n.kind, n.name])), [
    ['folder', 'assets'],
    ['folder', 'src'],
    ['file', 'readme.md'],
  ]);

  const src = tree.find(n => n.name === 'src');
  assert.deepEqual(plain(src.children.map(n => n.name)), ['A.js', 'b.js', 'file2.js', 'file10.js']);
});

test('root-level files with no folder appear as plain file nodes', () => {
  const ctx = loadContext();
  const tree = ctx.buildGitChangeTree([change('package.json'), change('README.md')]);
  assert.deepEqual(plain(tree.map(n => n.kind)), ['file', 'file']);
  // Case-insensitive natural order: "package.json" vs "README.md" -> p < r.
  assert.deepEqual(plain(tree.map(n => n.name)), ['package.json', 'README.md']);
});

test('compacts a folder chain of single children into one row, but not a folder with files or several subfolders', () => {
  const ctx = loadContext();
  const changes = [
    change('backend/docs/ai-engine/notes.md'),
    change('frontend/src/app.js'),
    change('frontend/test/app.test.js'),
    change('shared/util.js'),
    change('shared/lib/helpers.js'),
  ];
  const tree = ctx.buildGitChangeTree(changes);

  const backend = tree.find(n => n.name.startsWith('backend'));
  assert.equal(backend.name, 'backend/docs/ai-engine');
  assert.equal(backend.children.length, 1);
  assert.equal(backend.children[0].kind, 'file');

  // frontend has two subfolders (src, test) -> not compacted.
  const frontend = tree.find(n => n.name === 'frontend');
  assert.equal(frontend.name, 'frontend');
  assert.deepEqual(plain(frontend.children.map(c => c.name)), ['src', 'test']);

  // shared has a file (util.js) alongside a subfolder (lib/) -> not compacted.
  const shared = tree.find(n => n.name === 'shared');
  assert.equal(shared.name, 'shared');
  assert.deepEqual(plain(shared.children.map(c => [c.kind, c.name])), [['folder', 'lib'], ['file', 'util.js']]);
});

test('renamed files are placed at their new path (change.path), not the old one', () => {
  const ctx = loadContext();
  const tree = ctx.buildGitChangeTree([
    change('new/location/file.js', { status: 'renamed', oldPath: 'old/spot/file.js' }),
  ]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'new/location');
  assert.equal(tree[0].children[0].change.path, 'new/location/file.js');
  assert.equal(tree[0].children[0].change.oldPath, 'old/spot/file.js');
});

test('gitTreeRows flattens with depth and group-seeded keys', () => {
  const ctx = loadContext();
  const tree = ctx.buildGitChangeTree([
    change('a/b/one.js'),
    change('a/b/two.js'),
    change('a/c.js'),
  ]);
  const rows = ctx.gitTreeRows(tree, new Set(), 'modified');
  assert.deepEqual(plain(rows.map(r => [r.kind, r.name, r.depth])), [
    ['folder', 'a', 0],
    ['folder', 'b', 1],
    ['file', 'one.js', 2],
    ['file', 'two.js', 2],
    ['file', 'c.js', 1],
  ]);
  const aRow = rows.find(r => r.name === 'a');
  const bRow = rows.find(r => r.name === 'b');
  assert.equal(aRow.key, 'modified/a');
  assert.equal(bRow.key, 'modified/a/b');
  // a's count must recurse through subfolder b (2 files) plus its own c.js.
  assert.equal(aRow.count, 3);
  assert.equal(bRow.count, 2);
});

test('a collapsed folder hides its descendants but keeps its own row', () => {
  const ctx = loadContext();
  const tree = ctx.buildGitChangeTree([
    change('a/b/one.js'),
    change('a/b/two.js'),
    change('a/c.js'),
  ]);
  const allRows = ctx.gitTreeRows(tree, new Set(), 'modified');
  const bKey = allRows.find(r => r.name === 'b').key;

  const collapsed = new Set([bKey]);
  const rows = ctx.gitTreeRows(tree, collapsed, 'modified');
  assert.deepEqual(plain(rows.map(r => r.name)), ['a', 'b', 'c.js']);
  const bRow = rows.find(r => r.name === 'b');
  assert.equal(bRow.collapsed, true);
  assert.equal(bRow.count, 2);
});

test('gitChangesViewMode reads the stored mode and falls back to "tree" for missing, invalid, or throwing storage', () => {
  assert.equal(loadContext({ getItem() { return null; }, setItem() {} }).gitChangesViewMode(), 'tree');
  assert.equal(loadContext({ getItem() { return 'nonsense'; }, setItem() {} }).gitChangesViewMode(), 'tree');
  assert.equal(loadContext({ getItem() { throw new Error('blocked'); }, setItem() {} }).gitChangesViewMode(), 'tree');
  assert.equal(loadContext({ getItem() { return 'list'; }, setItem() {} }).gitChangesViewMode(), 'list');
});

test('setGitChangesViewMode swallows a throwing localStorage', () => {
  const ctx = loadContext({ getItem() { return null; }, setItem() { throw new Error('blocked'); } });
  assert.doesNotThrow(() => ctx.setGitChangesViewMode('tree'));
});

// --- paintGitChanges: exercises the actual list/tree render dispatch and
// the folder-row click wiring, not just the pure tree helpers above. ---

/** Minimal '#git-file-list' stand-in: just enough for paintGitChanges/createGitFileRow to append rows to and query them back. */
function fakeList() {
  const children = [];
  return {
    children,
    replaceChildren() { children.length = 0; },
    appendChild(el) { children.push(el); },
    querySelectorAll(selector) {
      if (selector !== '.git-file-row') return [];
      return children.filter(el => typeof el.className === 'string' && el.className.split(' ').includes('git-file-row'));
    },
  };
}

/** Minimal 'body' stand-in dispatching the two selectors paintGitChanges/paintGitDiff query for. */
function fakeBody(list, diffPane) {
  return {
    isConnected: true,
    querySelector(selector) {
      if (selector === '#git-file-list') return list;
      if (selector === '#git-diff-pane') return diffPane || null;
      return null;
    },
    querySelectorAll(selector) {
      return selector === '.git-folder-row' ? list.children.filter(el => String(el.className).split(' ').includes('git-folder-row')) : [];
    },
  };
}

test('paintGitChanges renders a flat list in "list" mode and a folder tree in "tree" mode', () => {
  const changes = [change('a/b/one.js'), change('a/b/two.js'), change('a/c.js'), change('readme.md')];
  const repo = { path: '/repo', changes };

  const listCtx = loadContext({ getItem() { return 'list'; }, setItem() {} });
  const list1 = fakeList();
  listCtx.paintGitChanges({ id: 'p' }, listCtx.gitTabState('p'), repo, fakeBody(list1));
  assert.equal(list1.children.some(c => c.className === 'git-folder-row'), false);
  assert.equal(list1.children.filter(c => typeof c.className === 'string' && c.className.includes('git-file-row')).length, 4);

  const treeCtx = loadContext({ getItem() { return 'tree'; }, setItem() {} });
  const list2 = fakeList();
  treeCtx.paintGitChanges({ id: 'p' }, treeCtx.gitTabState('p'), repo, fakeBody(list2));
  assert.equal(list2.children.some(c => c.className === 'git-folder-row'), true);
});

test('paintGitChanges only repaints the diff pane when repaintDiff is not false', () => {
  const ctx = loadContext();
  const repo = { path: '/repo', changes: [change('a.js')] };
  const state = ctx.gitTabState('p');
  state.selectedFiles.set(repo.path, 'a.js');
  state.diffs.set('/repo\u0000a.js', { diff: '+hello' });
  const diffPane = { dataset: {}, innerHTML: 'UNTOUCHED' };
  const body = fakeBody(fakeList(), diffPane);

  ctx.paintGitChanges({ id: 'p' }, state, repo, body, { repaintDiff: false });
  assert.equal(diffPane.innerHTML, 'UNTOUCHED');

  ctx.paintGitChanges({ id: 'p' }, state, repo, body);
  assert.notEqual(diffPane.innerHTML, 'UNTOUCHED');
});

test("a folder row's onclick toggles its collapsed state and repaints only the list, leaving the diff pane untouched", () => {
  const ctx = loadContext({ getItem() { return 'tree'; }, setItem() {} });
  const repo = { path: '/repo', changes: [change('a/b/one.js'), change('a/b/two.js'), change('a/c.js')] };
  const state = ctx.gitTabState('p');
  state.selectedFiles.set(repo.path, 'a/c.js');
  state.diffs.set('/repo\u0000a/c.js', { diff: '+x' });
  const list = fakeList();
  const diffPane = { dataset: {}, innerHTML: '' };
  const body = fakeBody(list, diffPane);

  ctx.paintGitChanges({ id: 'p' }, state, repo, body);
  const paintedDiff = diffPane.innerHTML;
  assert.notEqual(paintedDiff, '');

  // Folder 'a' (the outermost, first-rendered folder row) collapsed.
  const folderRowA = list.children.find(c => c.className === 'git-folder-row');
  assert.ok(folderRowA);
  folderRowA.onclick();

  assert.equal(diffPane.innerHTML, paintedDiff);
  // The selected file (a/c.js) is now hidden, so its folder is highlighted instead.
  assert.deepEqual(list.children.map(c => c.className), ['git-file-group', 'git-folder-row selected']);
  // The rebuilt row for the same folder gets keyboard focus back.
  assert.notEqual(ctx.focused, folderRowA);
  assert.equal(ctx.focused, list.children[1]);
  assert.equal(ctx.focused.dataset.key, folderRowA.dataset.key);
});

test('tree rows show the tree node name (backslashes included) and keep the staged state visible', () => {
  const ctx = loadContext({ getItem() { return 'tree'; }, setItem() {} });
  const repo = { path: '/repo', changes: [change('docs/a\\b.md', { indexStatus: 'M', worktreeStatus: ' ' }), change('docs/other.md', { indexStatus: ' ', worktreeStatus: 'M' })] };
  const list = fakeList();
  ctx.paintGitChanges({ id: 'p' }, ctx.gitTabState('p'), repo, fakeBody(list));
  const rows = list.children.filter(c => typeof c.className === 'string' && c.className.includes('git-file-row'));
  const backslash = rows.find(r => r.innerHTML.includes('a\\b.md'));
  assert.ok(backslash, 'the full node name is shown, not what follows the backslash');
  assert.match(backslash.innerHTML, /git-file-meta">Staged</);
  assert.ok(rows.some(r => /git-file-meta">Unstaged</.test(r.innerHTML)));
});

test('a collapsed folder that hides the selected file is highlighted in its place', () => {
  const ctx = loadContext({ getItem() { return 'tree'; }, setItem() {} });
  const repo = { path: '/repo', changes: [change('src/a.js'), change('src/b.js'), change('top.js')] };
  const state = ctx.gitTabState('p');
  state.selectedFiles.set(repo.path, 'src/b.js');
  ctx.gitCollapsedSet(state, repo.path).add('modified/src');
  const list = fakeList();
  ctx.paintGitChanges({ id: 'p' }, state, repo, fakeBody(list), { repaintDiff: false });
  const folder = list.children.find(c => typeof c.className === 'string' && c.className.startsWith('git-folder-row'));
  assert.equal(folder.className, 'git-folder-row selected');
});

test('the Git tab switches between History, Changes, Worktrees, Pull Requests and Actions, in that order', () => {
  const ctx = loadContext();
  assert.equal(ctx.projectGitView('p1'), 'history', 'a project opens on History');
  ctx.setProjectGitView('p1', 'worktrees');
  assert.equal(ctx.projectGitView('p1'), 'worktrees');
  ctx.setProjectGitView('p1', 'nonsense');
  assert.equal(ctx.projectGitView('p1'), 'worktrees', 'an unknown view is ignored');
  const html = ctx.gitWorkspaceNavHtml('worktrees');
  const labels = [...html.matchAll(/data-git-view="(\w+)"[^>]*>([^<]+)</g)].map(m => [m[1], m[2]]);
  assert.deepEqual(labels, [['history', 'History'], ['changes', 'Changes'], ['worktrees', 'Worktrees'], ['pulls', 'Pull Requests'], ['actions', 'Actions']]);
  assert.match(html, /id="git-workspace-worktrees-tab" class="git-workspace-nav-btn active"/);
  ctx.setProjectGitView('p1', 'pulls');
  assert.equal(ctx.projectGitView('p1'), 'pulls');
  ctx.setProjectGitView('p1', 'actions');
  assert.equal(ctx.projectGitView('p1'), 'actions');
});

test('the chosen repository goes along from Changes and History to Pull Requests, Actions and back', () => {
  const states = { history: { selectedRepo: null }, pulls: { selectedRepo: null }, actions: { selectedRepo: null } };
  const ctx = loadContext();
  // The other views' states are globals of their own files.
  ctx.gitGraphState = () => states.history;
  ctx.prTabState = () => states.pulls;
  ctx.actTabState = () => states.actions;
  ctx.gitTabState('p2').workspaceView = 'changes';
  ctx.gitTabState('p2').selectedRepo = '/code/api';
  ctx.setProjectGitView('p2', 'pulls');
  assert.equal(states.pulls.selectedRepo, '/code/api');
  states.pulls.selectedRepo = '/code/web';
  ctx.setProjectGitView('p2', 'actions');
  assert.equal(states.actions.selectedRepo, '/code/web');
  ctx.setProjectGitView('p2', 'history');
  assert.equal(states.history.selectedRepo, '/code/web');
  // Worktrees takes the repository too, and hands it on.
  ctx.wtTabState = () => states.worktrees;
  states.worktrees = { selectedRepo: null };
  ctx.setProjectGitView('p2', 'worktrees');
  assert.equal(states.worktrees.selectedRepo, '/code/web');
  states.worktrees.selectedRepo = '/code/api';
  ctx.setProjectGitView('p2', 'changes');
  assert.equal(ctx.gitTabState('p2').selectedRepo, '/code/api');
});

test('several repositories shown go along between History, Pull Requests and Worktrees', () => {
  const states = {
    history: { selectedRepo: '/code/api', selectedRepos: ['/code/api', '/code/web'] },
    pulls: { selectedRepo: null }, worktrees: { selectedRepo: null }, actions: { selectedRepo: null },
  };
  const ctx = loadContext();
  ctx.RepoSelection = require('../public/repo-selection');
  ctx.gitGraphState = () => states.history;
  ctx.prTabState = () => states.pulls;
  ctx.wtTabState = () => states.worktrees;
  ctx.actTabState = () => states.actions;
  ctx.gitTabState('p3').workspaceView = 'history';
  ctx.setProjectGitView('p3', 'pulls');
  assert.deepEqual([...states.pulls.selectedRepos], ['/code/api', '/code/web']);
  assert.equal(states.pulls.selectedRepo, '/code/api');
  ctx.setProjectGitView('p3', 'worktrees');
  assert.deepEqual([...states.worktrees.selectedRepos], ['/code/api', '/code/web']);
  // Actions shows one repository: the primary.
  ctx.setProjectGitView('p3', 'actions');
  assert.equal(states.actions.selectedRepo, '/code/api');
  // Back from Actions with a repository History shows: History keeps both.
  states.actions.selectedRepo = '/code/web';
  ctx.setProjectGitView('p3', 'history');
  assert.equal(states.history.selectedRepo, '/code/web');
  assert.deepEqual([...states.history.selectedRepos], ['/code/api', '/code/web']);
  // One History does not show: that one alone.
  ctx.setProjectGitView('p3', 'actions');
  states.actions.selectedRepo = '/code/docs';
  ctx.setProjectGitView('p3', 'pulls');
  assert.equal(states.pulls.selectedRepo, '/code/docs');
  assert.deepEqual([...states.pulls.selectedRepos], ['/code/docs']);
});

// --- Staging: lists by side, stage / unstage buttons ---

const diffModelSource = fs.readFileSync(path.join(__dirname, '../public/git-diff-model.js'), 'utf8');

function stagingContext(calls) {
  const ctx = loadContext({ getItem() { return 'list'; }, setItem() {} });
  ctx.window.api = {
    stageProjectGitFiles: (...args) => { calls.push(['files', ...args]); return Promise.resolve({ ok: true }); },
    stageProjectGitLines: (...args) => { calls.push(['lines', ...args]); return Promise.resolve({ ok: true }); },
    getProjectGitInfo: () => Promise.resolve({ ok: false }),
    getProjectGitDiff: () => new Promise(() => {}),
  };
  ctx.fileIconHtml = (name) => `<img data-icon="${name}">`;
  vm.runInContext(diffModelSource, ctx);
  // In the window, window is the global object; here the module lands on ctx.window.
  ctx.GitDiffModel = ctx.window.GitDiffModel;
  return ctx;
}

test('gitSideLists groups like VS Code: merge, staged, and changes (a file can be in both)', () => {
  const ctx = loadContext();
  const lists = plain(ctx.gitSideLists([
    change('both.js', { indexStatus: 'M', worktreeStatus: 'M' }),
    change('staged.js', { indexStatus: 'A', worktreeStatus: ' ', status: 'added' }),
    change('new.txt', { indexStatus: '?', worktreeStatus: '?', status: 'untracked' }),
    change('clash.js', { indexStatus: 'U', worktreeStatus: 'U', status: 'conflicted' }),
  ]));
  assert.deepEqual(lists.merge.map(c => c.path), ['clash.js']);
  assert.deepEqual(lists.staged.map(c => c.path), ['both.js', 'staged.js']);
  assert.deepEqual(lists.unstaged.map(c => c.path), ['both.js', 'new.txt']);
  assert.equal(ctx.gitSideCode(change('n', { status: 'untracked', indexStatus: '?', worktreeStatus: '?' }), 'unstaged'), 'U');
  assert.equal(ctx.gitSideCode(change('d', { indexStatus: 'D', worktreeStatus: ' ' }), 'staged'), 'D');
});

test('with staging, the list has a heading per side and a stage or unstage button per file', async () => {
  const calls = [];
  const ctx = stagingContext(calls);
  const repo = { path: '/repo', changes: [
    change('src/both.js', { indexStatus: 'M', worktreeStatus: 'M' }),
    change('new.txt', { indexStatus: '?', worktreeStatus: '?', status: 'untracked' }),
  ] };
  const list = fakeList();
  const state = ctx.gitTabState('p');
  const body = Object.assign(fakeBody(list), { classList: { add() {}, remove() {} } });
  ctx.paintGitChanges({ id: 'p' }, state, repo, body, { repaintDiff: false });
  const groups = list.children.filter(c => c.className === 'git-file-group');
  assert.deepEqual(groups.map(g => /git-file-group-label">([^<]+)</.exec(g.innerHTML)[1]), ['Staged Changes', 'Changes']);
  const rows = list.children.filter(c => String(c.className).includes('git-file-row'));
  assert.deepEqual(rows.map(r => r.dataset.key), ['staged\u0000src/both.js', 'unstaged\u0000src/both.js', 'unstaged\u0000new.txt']);
  assert.match(rows[0].innerHTML, /data-act="unstage"/);
  assert.match(rows[2].innerHTML, /data-act="stage"/);
  assert.match(rows[2].innerHTML, /git-file-code untracked">U</);
  assert.match(rows[2].innerHTML, /data-icon="new.txt"/);
  // The first row is selected when nothing was.
  assert.equal(state.selectedFiles.get('/repo'), 'staged\u0000src/both.js');

  // The stage button stages that file (and only reaches the button's handler).
  const button = { dataset: { act: 'stage' } };
  rows[2].onclick({ target: { closest: () => button }, stopPropagation() {} });
  assert.deepEqual(plain(calls[0]), ['files', 'p', '/repo', ['new.txt'], true]);
});

test('after a file leaves its list the selection lands on the file now at that place', () => {
  const ctx = loadContext();
  const state = ctx.gitTabState('p');
  const repo = { path: '/repo' };
  state.selectedFiles.set('/repo', 'unstaged\u0000a.js');
  state.selectionHint.set('/repo', { side: 'unstaged', path: 'a.js', index: 0 });
  const items = [
    { side: 'staged', change: change('a.js') },
    { side: 'unstaged', change: change('b.js') },
  ];
  assert.equal(ctx.gitSelectedItem(state, repo, items).change.path, 'b.js');
  state.selectionHint.set('/repo', { side: 'unstaged', path: 'a.js', index: 3 });
  assert.equal(ctx.gitSelectedItem(state, repo, items.slice(0, 1)).change.path, 'a.js', 'then the same file on the other side');
});

test('the hunks of a diff can be picked line by line, and a hunk staged as a whole', () => {
  const ctx = stagingContext([]);
  const diff = ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@ fn', ' a', '-b', '+B', ' c', ''].join('\n');
  const parsed = ctx.GitDiffModel.parseUnifiedDiff(diff);
  const html = ctx.gitHunksHtml(parsed, new Set([6]), 'unstaged');
  assert.match(html, /git-dl remove" data-index="5"/);
  assert.match(html, /git-dl add picked" data-index="6"/);
  assert.match(html, /Stage Hunk/);
  assert.match(ctx.gitHunksHtml(parsed, new Set(), 'staged'), /Unstage Hunk/);
  assert.equal(ctx.gitDiffNote(ctx.GitDiffModel.parseUnifiedDiff('diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n')), 'New file');
});

test('Changes header: repository tabs first, the chosen path under them, no title above', () => {
  const ctx = loadContext();
  const repos = [{ path: '/work/app', git: true }, { path: '/work/api', git: true }];
  const html = ctx.gitRepoHeaderHtml(repos, repos[1], { readOnly: false });
  assert.doesNotMatch(html, /git-tab-title/);
  const picker = html.indexOf('git-repo-picker');
  const line = html.indexOf('git-tab-pathline');
  assert.ok(picker >= 0 && line > picker, 'the path comes after the tabs');
  assert.match(html, /<span class="git-tab-path mono">\/work\/api<\/span><\/div>/);
  assert.match(html, /git-repo-option active" data-index="1">api</);
  assert.doesNotMatch(html, /Read only/);
});

test('Changes header with one repository: only its path, with Read only when nothing can be staged', () => {
  const ctx = loadContext();
  const repo = { path: '/work/app', git: true };
  const html = ctx.gitRepoHeaderHtml([repo], repo, { readOnly: true });
  assert.doesNotMatch(html, /git-repo-picker/);
  assert.match(html, /git-tab-pathline"><span class="git-tab-path mono">\/work\/app<\/span><span class="git-readonly">Read only<\/span>/);
});

test('paintGitRepository puts the summary (and any warning) after the path line', () => {
  const ctx = loadContext();
  const body = { innerHTML: '', querySelectorAll: () => [] };
  const repos = [
    { path: '/work/app', git: true, branch: 'main', changes: [], commits: [], stats: { insertions: 0, deletions: 0 } },
    { path: '/work/api', git: true, branch: 'dev', changes: [], commits: [], stats: { insertions: 0, deletions: 0 } },
  ];
  ctx.paintGitRepository({ id: 'p' }, { repositories: repos, selectedRepo: '/work/api' }, body);
  const html = body.innerHTML;
  assert.doesNotMatch(html, /git-tab-title/);
  const order = ['git-repo-picker', 'git-tab-pathline', 'git-summary'].map(cls => html.indexOf(cls));
  assert.ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
});


// --- Discard and .gitignore: row buttons, right-click menu, confirmation ---

function stagingApi(calls) {
  return {
    stageProjectGitFiles: async () => ({ ok: true }),
    stageProjectGitLines: async () => ({ ok: true }),
    discardProjectGitFiles: async (...args) => { calls.push(['discard', ...args]); return { ok: true, failed: [] }; },
    ignoreProjectGitPaths: async (...args) => { calls.push(['ignore', ...args]); return { ok: true }; },
    getProjectGitInfo: async () => ({ ok: true, repositories: [] }),
  };
}

const porcelain = (p, code) => ({ path: p, code, indexStatus: code[0], worktreeStatus: code[1], status: code === '??' ? 'untracked' : 'modified', staged: code[0] !== ' ' && code[0] !== '?' });
const labels = (items) => plain(items.map(item => (item.sep ? '—' : item.label)));

test('the row menu offers Discard in Changes and the .gitignore entry that fits the file or folder', () => {
  const ctx = loadContext();
  ctx.window.api = stagingApi([]);
  const repo = { path: '/repo', changes: [porcelain('src/a.js', ' M'), porcelain('src/new.txt', '??'), porcelain('b.js', 'M ')] };
  const state = ctx.gitTabState('p');
  const menu = (side, target) => labels(ctx.gitRowMenuItems({ id: 'p' }, state, repo, {}, side, target));
  assert.deepEqual(menu('unstaged', { path: 'src/new.txt', dir: false }), ['Stage Changes', 'Discard Changes…', '—', 'Add to .gitignore']);
  assert.deepEqual(menu('unstaged', { path: 'src/a.js', dir: false }), ['Stage Changes', 'Discard Changes…', '—', 'Add to .gitignore and Remove from Git…']);
  assert.deepEqual(menu('unstaged', { path: 'src', dir: true }), ['Stage Changes', 'Discard Changes…', '—', 'Add to .gitignore', 'Add to .gitignore and Remove from Git…']);
  assert.deepEqual(menu('staged', { path: 'b.js', dir: false }), ['Unstage Changes', '—', 'Add to .gitignore and Remove from Git…']);

  // An older main process: staging only.
  ctx.window.api = { stageProjectGitFiles: async () => ({ ok: true }) };
  assert.deepEqual(menu('unstaged', { path: 'src', dir: true }), ['Stage Changes']);
});

test('Changes rows, its folders and its heading get a Discard button; Staged Changes does not', () => {
  const ctx = loadContext({ getItem() { return 'tree'; }, setItem() {} });
  ctx.window.api = stagingApi([]);
  const repo = { path: '/repo', changes: [porcelain('src/a.js', ' M'), porcelain('lib/b.js', 'M ')] };
  const list = fakeList();
  ctx.paintGitChanges({ id: 'p' }, ctx.gitTabState('p'), repo, fakeBody(list));
  const html = (el) => String(el.innerHTML || '');
  const groups = list.children.filter(el => el.className === 'git-file-group');
  assert.deepEqual(groups.map(el => html(el).includes('data-act="discard-all"')), [false, true]);
  const folders = list.children.filter(el => String(el.className).startsWith('git-folder-row'));
  assert.deepEqual(folders.map(el => [el.dataset.key, html(el).includes('data-act="discard"')]), [['staged/lib', false], ['unstaged/src', true]]);
  const files = list.children.filter(el => String(el.className).includes('git-file-row'));
  assert.deepEqual(files.map(el => html(el).includes('data-act="discard"')), [false, true]);
});

test('Discard asks first, then discards exactly the files it counted', async () => {
  const ctx = loadContext();
  const calls = [];
  ctx.window.api = stagingApi(calls);
  const repo = { path: '/repo', changes: [porcelain('src/a.js', ' M'), porcelain('src/new.txt', '??'), porcelain('srcx/c.js', ' M')] };
  const state = ctx.gitTabState('p');
  const body = { classList: { add() {}, remove() {} }, isConnected: false };
  const questions = [];
  ctx.gitChangesConfirm = async (question) => { questions.push(plain(question)); return false; };
  await ctx.gitDiscard({ id: 'p' }, state, repo, body, { path: 'src', dir: true });
  assert.equal(calls.length, 0);
  assert.equal(questions[0].title, 'Discard the changes in 2 files in “src”?');

  ctx.gitChangesConfirm = async () => true;
  await ctx.gitDiscard({ id: 'p' }, state, repo, body, { path: 'src', dir: true });
  assert.deepEqual(plain(calls), [['discard', 'p', '/repo', ['src/a.js', 'src/new.txt']]]);
});

test('Add to .gitignore runs at once; Remove from Git asks first', async () => {
  const ctx = loadContext();
  const calls = [];
  ctx.window.api = stagingApi(calls);
  const repo = { path: '/repo', changes: [porcelain('dist/a.js', ' M')] };
  const body = { classList: { add() {}, remove() {} }, isConnected: false };
  let asked = 0;
  ctx.gitChangesConfirm = async () => { asked += 1; return false; };
  await ctx.gitIgnore({ id: 'p' }, ctx.gitTabState('p'), repo, body, { path: 'dist', dir: true }, false);
  await ctx.gitIgnore({ id: 'p' }, ctx.gitTabState('p'), repo, body, { path: 'dist', dir: true }, true);
  assert.equal(asked, 1);
  assert.deepEqual(plain(calls), [['ignore', 'p', '/repo', ['dist'], false]]);
});

/** A CodeMirror view as createUnifiedMergeViewer gives it, with a text that can be changed. */
function fakeEditorView(text) {
  const view = {
    text,
    destroyed: false,
    get state() { return { doc: { length: view.text.length, toString: () => view.text } }; },
    destroy() { view.destroyed = true; },
    focus() {},
    requestMeasure() {},
  };
  return view;
}

function editingContext(calls, saveResults = []) {
  const ctx = loadContext();
  ctx.window.api = Object.assign(stagingApi(calls), {
    readProjectGitEditFile: async (...args) => { calls.push(['read', ...args]); return { ok: true, content: 'a\nb\n', base: 'a\n', version: 'v1' }; },
    saveProjectGitEditFile: async (...args) => { calls.push(['save', ...args]); return saveResults.shift() || { ok: true, version: 'v2' }; },
  });
  const views = [];
  ctx.window.createUnifiedMergeViewer = (host, base, content, filename, options) => {
    const view = fakeEditorView(content);
    views.push({ base, content, filename, options: plain(options), view });
    return view;
  };
  ctx.paintGitChanges = () => {};
  ctx.paintGitDiff = () => {};
  ctx.refreshGitRepositories = async () => { calls.push(['refresh']); };
  return { ctx, views };
}

test('the diff offers Edit for a file on disk, and Exit Edit Mode and Save while editing', () => {
  const { ctx } = editingContext([]);
  const head = (c, side, edit) => ctx.gitDiffHeadHtml({ side, change: c }, null, edit);
  assert.match(head(porcelain('src/a.js', ' M'), 'unstaged'), /git-edit-act/);
  assert.match(head(porcelain('src/a.js', 'M '), 'staged'), /git-edit-act/);
  assert.doesNotMatch(head(porcelain('src/a.js', ' D'), 'unstaged'), /git-edit-act/);
  const editing = head(porcelain('src/a.js', ' M'), 'unstaged', { busy: false });
  assert.match(editing, /Exit Edit Mode/);
  assert.match(editing, /git-edit-save/);
  assert.match(editing, />Editing</);
  assert.doesNotMatch(editing, /git-file-act|git-edit-act/);
  // An older main process: no Edit.
  delete ctx.window.api.readProjectGitEditFile;
  assert.doesNotMatch(head(porcelain('src/a.js', ' M'), 'unstaged'), /git-edit-act/);
});

test('Edit opens the file on disk against its staged copy, with every line shown and no merge buttons', async () => {
  const calls = [];
  const { ctx, views } = editingContext(calls);
  const state = ctx.gitTabState('p');
  const repo = { path: '/repo', changes: [porcelain('src/a.js', 'MM')] };
  const item = { side: 'staged', change: repo.changes[0] };
  await ctx.gitStartEdit({ id: 'p' }, state, repo, fakeBody(fakeList()), item);
  assert.deepEqual(plain(calls), [['read', 'p', '/repo', 'src/a.js']]);
  assert.equal(views.length, 1);
  assert.deepEqual([views[0].base, views[0].content, views[0].filename], ['a\n', 'a\nb\n', 'src/a.js']);
  assert.deepEqual(views[0].options, { readOnly: false, mergeControls: false, collapse: false });
  assert.ok(state.editors.has('/repo\0src/a.js'));
  // Opened again from the other side: the same file, the same editor.
  await ctx.gitStartEdit({ id: 'p' }, state, repo, fakeBody(fakeList()), { side: 'unstaged', change: repo.changes[0] });
  assert.equal(views.length, 1);
});

test('Save writes against the version read, stays in edit mode and reads the lists again', async () => {
  const calls = [];
  const { ctx, views } = editingContext(calls);
  const state = ctx.gitTabState('p');
  const repo = { path: '/repo', changes: [porcelain('src/a.js', ' M')] };
  const item = { side: 'unstaged', change: repo.changes[0] };
  const body = fakeBody(fakeList());
  await ctx.gitStartEdit({ id: 'p' }, state, repo, body, item);
  const session = state.editors.get('/repo\0src/a.js');
  // Nothing typed: nothing to save.
  await ctx.gitSaveEdit({ id: 'p' }, state, repo, body, item, session);
  assert.equal(calls.filter(c => c[0] === 'save').length, 0);
  views[0].view.text = 'a\nb\nc\n';
  await ctx.gitSaveEdit({ id: 'p' }, state, repo, body, item, session);
  assert.deepEqual(plain(calls.slice(1)), [['save', 'p', '/repo', 'src/a.js', 'a\nb\nc\n', 'v1'], ['refresh']]);
  assert.equal(session.version, 'v2');
  assert.equal(ctx.gitEditDirty(session), false);
  assert.ok(state.editors.has('/repo\0src/a.js'));
});

test('a file changed on disk is overwritten only after asking', async () => {
  const calls = [];
  const changed = { ok: false, code: 'CHANGED', error: 'The file changed on disk after it was opened', version: 'v9' };
  const { ctx, views } = editingContext(calls, [changed, changed]);
  const state = ctx.gitTabState('p');
  const repo = { path: '/repo', changes: [porcelain('a.txt', ' M')] };
  const item = { side: 'unstaged', change: repo.changes[0] };
  const body = fakeBody(fakeList());
  await ctx.gitStartEdit({ id: 'p' }, state, repo, body, item);
  const session = state.editors.get('/repo\0a.txt');
  views[0].view.text = 'mine\n';
  const questions = [];
  ctx.gitChangesConfirm = async (q) => { questions.push(plain(q)); return false; };
  await ctx.gitSaveEdit({ id: 'p' }, state, repo, body, item, session);
  assert.equal(questions[0].title, '“a.txt” changed on disk');
  assert.equal(questions[0].confirm, 'Overwrite');
  assert.equal(calls.filter(c => c[0] === 'save').length, 1);

  ctx.gitChangesConfirm = async () => true;
  await ctx.gitSaveEdit({ id: 'p' }, state, repo, body, item, session);
  // The second save of this round goes without a version: it overwrites.
  assert.deepEqual(plain(calls.filter(c => c[0] === 'save').map(c => c[5])), ['v1', 'v1', null]);
});

test('Exit Edit Mode drops the editor and what was not saved, and reads the diff again', async () => {
  const calls = [];
  const { ctx, views } = editingContext(calls);
  const state = ctx.gitTabState('p');
  const repo = { path: '/repo', changes: [porcelain('a.txt', ' M')] };
  const item = { side: 'unstaged', change: repo.changes[0] };
  await ctx.gitStartEdit({ id: 'p' }, state, repo, fakeBody(fakeList()), item);
  state.diffs.set(ctx.gitDiffKey(repo, 'unstaged', 'a.txt'), { diff: 'old' });
  views[0].view.text = 'unsaved\n';
  const questions = [];
  ctx.gitChangesConfirm = async (q) => { questions.push(q.confirm); return questions.length > 1; };
  await ctx.gitExitEdit({ id: 'p' }, state, repo, fakeBody(fakeList()), item);
  assert.equal(state.editors.size, 1, 'Cancel stays in edit mode');
  await ctx.gitExitEdit({ id: 'p' }, state, repo, fakeBody(fakeList()), item);
  assert.deepEqual(questions, ['Discard', 'Discard']);
  assert.equal(views[0].view.destroyed, true);
  assert.equal(state.editors.size, 0);
  assert.equal(state.diffs.has(ctx.gitDiffKey(repo, 'unstaged', 'a.txt')), false);
  assert.equal(calls.filter(c => c[0] === 'save').length, 0);
  assert.deepEqual(plain(calls.at(-1)), ['refresh']);
});

// --- A diff's code in the editors' colours ---

const DIFF = [
  'diff --git a/x.js b/x.js',
  '--- a/x.js',
  '+++ b/x.js',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '\\ No newline at end of file',
  '@@ -10,2 +10,2 @@ function f() {',
  '-old',
  '+new',
].join('\n');

test('a diff with a file name has its code coloured by the editors: each hunk\'s old and new sides as wholes, the lines keeping their kind', () => {
  const ctx = loadContext();
  const calls = [];
  ctx.window.cmHighlightLines = (code, filename) => { calls.push([code, filename]); return code.split('\n').map(l => `[${l}]`); };
  const html = ctx.gitDiffLines(DIFF, { filename: 'src/x.js' });
  assert.deepEqual(calls, [
    ['const a = 1;\nconst b = 2;', 'src/x.js'],
    ['const a = 1;\nconst b = 3;', 'src/x.js'],
    ['old', 'src/x.js'],
    ['new', 'src/x.js'],
  ]);
  const lines = html.match(/<span class="git-diff-line[^"]*">.*?<\/span>(?=<span class="git-diff-line|$)/g);
  assert.equal(lines.length, 11);
  assert.equal(lines[0], '<span class="git-diff-line header">diff --git a/x.js b/x.js</span>');
  assert.equal(lines[3], '<span class="git-diff-line hunk">@@ -1,3 +1,3 @@</span>');
  assert.equal(lines[4], '<span class="git-diff-line code"><span class="git-diff-sign"> </span>[const a = 1;]</span>');
  assert.equal(lines[5], '<span class="git-diff-line code remove"><span class="git-diff-sign">-</span>[const b = 2;]</span>');
  assert.equal(lines[6], '<span class="git-diff-line code add"><span class="git-diff-sign">+</span>[const b = 3;]</span>');
  assert.equal(lines[7], '<span class="git-diff-line">\\ No newline at end of file</span>');
  assert.equal(lines[10], '<span class="git-diff-line code add"><span class="git-diff-sign">+</span>[new]</span>');
});

test('a diff stays green and red as text without a file name, a highlighter, or a language the editors know', () => {
  const ctx = loadContext();
  const plain = ctx.gitDiffLines(DIFF);
  assert.match(plain, /<span class="git-diff-line add">\+const b = 3;<\/span>/);
  assert.equal(ctx.gitDiffLines(DIFF, { filename: 'x.js' }), plain);
  ctx.window.cmHighlightLines = () => null;
  assert.equal(ctx.gitDiffLines(DIFF, { filename: 'notes.unknown' }), plain);
});

test('unsaved text in edit mode is kept as a draft, comes back, and goes with a save', async () => {
  const calls = [];
  const { ctx, views } = editingContext(calls);
  const drafts = new Map();
  Object.assign(ctx.window.api, {
    getDraft: filePath => drafts.get(filePath) || null,
    setDraft: (filePath, draft) => { drafts.set(filePath, draft); return { ok: true }; },
    removeDraft: filePath => drafts.delete(filePath),
  });
  const listeners = {};
  ctx.window.addEventListener = (type, callback) => { listeners[type] = callback; };
  ctx.shareViewerDraft = () => {};
  ctx.window.cmSetText = (view, text) => { view.text = text; };
  const state = ctx.gitTabState('p');
  const repo = { path: '/repo', changes: [porcelain('src/a.js', ' M')] };
  const item = { side: 'unstaged', change: repo.changes[0] };
  const body = fakeBody(fakeList());
  await ctx.gitStartEdit({ id: 'p' }, state, repo, body, item);
  views[0].view.text = 'typed\n';
  let held = false;
  listeners.beforeunload({ preventDefault: () => { held = true; } });
  assert.equal(held, false);
  assert.deepEqual(plain(drafts.get('/repo/src/a.js')), { content: 'typed\n', base: 'a\nb\n' });

  // As after a restart: another window's edit mode starts from the draft.
  state.editors.clear();
  await ctx.gitStartEdit({ id: 'p' }, state, repo, body, item);
  const session = state.editors.get('/repo\0src/a.js');
  assert.equal(views.at(-1).view.text, 'typed\n');
  assert.equal(ctx.gitEditDirty(session), true);
  await ctx.gitSaveEdit({ id: 'p' }, state, repo, body, item, session);
  assert.equal(drafts.size, 0);
});
