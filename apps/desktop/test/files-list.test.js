const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validFilesFilter, loadFilesFilter, saveFilesFilter, FILES_FILTER_KEY,
  buildFilesSections, filesSectionsEmpty, pinnedStep, pinnedDropIndex,
  pinnedShownStep, selectionAfterClick,
} = require('../public/files-list');

const file = (filePath, extra = {}) => ({ filePath, filename: filePath.split('/').pop(), ...extra });

const agents = {
  global: { files: [file('/demo/.claude/CLAUDE.md', { displayPath: '~/.claude' })] },
  projects: [
    { folder: '-demo-app', shortName: 'demo/app', files: [file('/demo/app/CLAUDE.md', { displayPath: 'demo/app/' }), file('/demo/app/AGENTS.md')] },
    { folder: '-demo-site', shortName: 'demo/site', files: [file('/demo/site/CLAUDE.md')] },
  ],
};
const opened = {
  opened: [file('/demo/notes/todo.txt'), file('/demo/app/CLAUDE.md'), file('/demo/notes/plan.ts')],
  pinned: [],
};

const paths = (list) => list.map(f => f.filePath);
const groupPaths = (groups) => groups.map(g => [g.key, paths(g.files)]);

test('the filter is one of the three, All when unknown', () => {
  assert.equal(validFilesFilter('agents'), 'agents');
  assert.equal(validFilesFilter('opened'), 'opened');
  assert.equal(validFilesFilter('pinned'), 'all');
  assert.equal(validFilesFilter(undefined), 'all');
});

test('the filter is kept in storage, and a broken storage means All', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(loadFilesFilter(storage), 'all');
  saveFilesFilter(storage, 'opened');
  assert.equal(store.get(FILES_FILTER_KEY), 'opened');
  assert.equal(loadFilesFilter(storage), 'opened');
  saveFilesFilter(storage, 'nonsense');
  assert.equal(loadFilesFilter(storage), 'all');
  assert.equal(loadFilesFilter({ getItem: () => { throw new Error('denied'); } }), 'all');
  assert.equal(loadFilesFilter(null), 'all');
});

test('All shows the agent files in their groups and every opened file under Opened, by project then name', () => {
  const sections = buildFilesSections({ agents, opened, filter: 'all' });
  assert.deepEqual(sections.pinned, []);
  // The dropped CLAUDE.md has a project name, so it comes before the others.
  assert.deepEqual(sections.opened.map(f => [f.projectName, f.filename]), [
    ['demo/app', 'CLAUDE.md'], ['', 'plan.ts'], ['', 'todo.txt'],
  ]);
  assert.deepEqual(groupPaths(sections.groups), [
    ['__global__', ['/demo/.claude/CLAUDE.md']],
    ['-demo-app', ['/demo/app/CLAUDE.md', '/demo/app/AGENTS.md']],
    ['-demo-site', ['/demo/site/CLAUDE.md']],
  ]);
});

test('Agent files shows only the agent groups, as the tab did before', () => {
  const sections = buildFilesSections({ agents, opened, filter: 'agents' });
  assert.deepEqual(sections.opened, []);
  assert.equal(sections.groups.length, 3);
});

test('Opened shows every opened file, agent files too, and no group', () => {
  const sections = buildFilesSections({ agents, opened, filter: 'opened' });
  assert.deepEqual(paths(sections.opened), ['/demo/notes/todo.txt', '/demo/app/CLAUDE.md', '/demo/notes/plan.ts']);
  assert.deepEqual(sections.groups, []);
});

test('a pinned file stays in its group, first, with every filter; one of no project has the Pinned group', () => {
  const withPins = { ...opened, pinned: [file('/demo/notes/plan.ts'), file('/demo/app/AGENTS.md'), file('/demo/elsewhere/x.md')] };
  for (const filter of ['all', 'agents']) {
    const sections = buildFilesSections({ agents, opened: withPins, filter });
    assert.deepEqual(paths(sections.pinned), ['/demo/notes/plan.ts', '/demo/elsewhere/x.md'], filter);
    assert.deepEqual(paths(sections.groups.find(g => g.key === '-demo-app').files),
      ['/demo/app/AGENTS.md', '/demo/app/CLAUDE.md'], filter);
  }
  const bare = buildFilesSections({ agents, opened: withPins, filter: 'opened' });
  assert.deepEqual(paths(bare.pinned), ['/demo/notes/plan.ts', '/demo/app/AGENTS.md', '/demo/elsewhere/x.md']);
  assert.deepEqual(paths(bare.opened), ['/demo/notes/todo.txt', '/demo/app/CLAUDE.md']);
});

test('a project keeps its group when its only file is pinned', () => {
  const sections = buildFilesSections({ agents, opened: { opened: [], pinned: [file('/demo/site/CLAUDE.md')] }, filter: 'all' });
  assert.deepEqual(sections.pinned, []);
  assert.deepEqual(paths(sections.groups.find(g => g.key === '-demo-site').files), ['/demo/site/CLAUDE.md']);
});

test('a pinned agent file keeps the place its group shows', () => {
  const withPins = { opened: [], pinned: [file('/demo/.claude/CLAUDE.md', { displayPath: '/demo/.claude' })] };
  const sections = buildFilesSections({ agents, opened: withPins, filter: 'all' });
  assert.equal(sections.groups.find(g => g.key === '__global__').files[0].displayPath, '~/.claude');
});

test('a search narrows every section, the pinned one too', () => {
  const withPins = { ...opened, pinned: [file('/demo/notes/plan.ts'), file('/demo/site/CLAUDE.md')] };
  const matchIds = new Set(['/demo/notes/plan.ts', '/demo/app/AGENTS.md']);
  const sections = buildFilesSections({ agents, opened: withPins, filter: 'all', matchIds });
  assert.deepEqual(paths(sections.pinned), ['/demo/notes/plan.ts']);
  // Pinned and opened: it shows under Opened too.
  assert.deepEqual(paths(sections.opened), ['/demo/notes/plan.ts']);
  assert.deepEqual(groupPaths(sections.groups), [['-demo-app', ['/demo/app/AGENTS.md']]]);
  assert.equal(filesSectionsEmpty(buildFilesSections({ agents, opened: withPins, matchIds: new Set() })), true);
});

test('nothing loaded yet is an empty tab', () => {
  const sections = buildFilesSections({});
  assert.equal(sections.filter, 'all');
  assert.equal(filesSectionsEmpty(sections), true);
});

test('pinnedStep moves one place up or down, not past the ends', () => {
  const pinned = ['/a', '/b', '/c'];
  assert.equal(pinnedStep(pinned, '/b', -1), 0);
  assert.equal(pinnedStep(pinned, '/b', 1), 2);
  assert.equal(pinnedStep(pinned, '/a', -1), null);
  assert.equal(pinnedStep(pinned, '/c', 1), null);
  assert.equal(pinnedStep(pinned, '/x', 1), null);
});

test('pinnedDropIndex places the dragged file before or after the one it is dropped on', () => {
  const pinned = ['/a', '/b', '/c', '/d'];
  assert.equal(pinnedDropIndex(pinned, '/d', '/a', false), 0);
  assert.equal(pinnedDropIndex(pinned, '/a', '/c', true), 2);
  assert.equal(pinnedDropIndex(pinned, '/a', '/c', false), 1);
  assert.equal(pinnedDropIndex(pinned, '/c', '/a', true), 1);
  assert.equal(pinnedDropIndex(pinned, '/a', '/d', true), 3);
  // Dropped where it already is.
  assert.equal(pinnedDropIndex(pinned, '/b', '/a', true), null);
  assert.equal(pinnedDropIndex(pinned, '/b', '/c', false), null);
  assert.equal(pinnedDropIndex(pinned, '/b', '/b', true), null);
  assert.equal(pinnedDropIndex(pinned, '/x', '/a', true), null);
});

test('pinned projects come apart, in their order, with the filters that show groups', () => {
  const withPins = { ...opened, pinnedProjects: ['-demo-site', '-demo-gone', '-demo-app'] };
  for (const filter of ['all', 'agents']) {
    const sections = buildFilesSections({ agents, opened: withPins, filter });
    assert.deepEqual(sections.pinnedGroups.map(g => g.key), ['-demo-site', '-demo-app'], filter);
    assert.deepEqual(sections.groups.map(g => g.key), ['__global__'], filter);
  }
  assert.deepEqual(buildFilesSections({ agents, opened: withPins, filter: 'opened' }).pinnedGroups, []);
});

test('a pinned project with nothing to show has no group, and one left alone is not empty', () => {
  const withPins = { opened: [], pinned: [file('/demo/site/CLAUDE.md')], pinnedProjects: ['-demo-site', '-demo-app'] };
  const found = buildFilesSections({ agents, opened: withPins, matchIds: new Set(['/demo/app/AGENTS.md']) });
  assert.deepEqual(groupPaths(found.pinnedGroups), [['-demo-app', ['/demo/app/AGENTS.md']]]);
  assert.deepEqual(found.groups, []);
  assert.equal(filesSectionsEmpty(found), false);
});

test('pinnedShownStep passes the next project in sight, hidden ones included', () => {
  const all = ['a', 'hidden', 'b', 'c'];
  const shown = ['a', 'b', 'c'];
  assert.equal(pinnedShownStep(all, shown, 'a', 1), 2);
  assert.equal(pinnedShownStep(all, shown, 'b', -1), 0);
  assert.equal(pinnedShownStep(all, shown, 'a', -1), null);
  assert.equal(pinnedShownStep(all, shown, 'c', 1), null);
  assert.equal(pinnedShownStep(all, shown, 'hidden', 1), null);
});

test('Ctrl+click adds a row to the selection or takes it out', () => {
  const order = ['/a', '/b', '/c'];
  const one = selectionAfterClick({ selected: new Set(), order, anchor: null, clicked: '/b' });
  assert.deepEqual([[...one.selected], one.anchor], [['/b'], '/b']);
  const two = selectionAfterClick({ ...one, order, clicked: '/a' });
  assert.deepEqual([...two.selected], ['/b', '/a']);
  assert.deepEqual([...selectionAfterClick({ ...two, order, clicked: '/b' }).selected], ['/a']);
});

test('Shift+click selects every row from the last one clicked, either way', () => {
  const order = ['/a', '/b', '/c', '/d'];
  const down = selectionAfterClick({ selected: new Set(), order, anchor: '/b', clicked: '/d', range: true });
  assert.deepEqual([[...down.selected], down.anchor], [['/b', '/c', '/d'], '/b']);
  const up = selectionAfterClick({ selected: new Set(['/d']), order, anchor: '/c', clicked: '/a', range: true });
  assert.deepEqual([...up.selected], ['/d', '/a', '/b', '/c']);
  // Without a row clicked before, or with one no longer shown, that row alone.
  const alone = selectionAfterClick({ selected: new Set(), order, anchor: '/gone', clicked: '/c', range: true });
  assert.deepEqual([[...alone.selected], alone.anchor], [['/c'], '/c']);
});

const projects = [
  { id: 1, name: 'App', root: '/demo/app', folders: [{ path: '/demo/lib' }] },
  { id: 2, name: 'Site', root: '/demo/site', folders: [] },
  { id: 3, name: 'Idle', root: '/demo/idle', folders: [] },
];
const open = [
  { filePath: '/demo/app/src/main.js', projectId: 1 },
  { filePath: '/demo/lib/util.js', projectId: null },
  { filePath: '/demo/site/index.html', projectId: 2 },
  { filePath: '/demo/site/CLAUDE.md', projectId: 2 },
];
const none = { opened: [], pinned: [] };

test('Opened files lists every open file under its project, one with nothing open left out', () => {
  const sections = buildFilesSections({ agents, opened: none, filter: 'opened', open, projects });
  assert.deepEqual(sections.groups.map(g => [g.label, paths(g.files)]), [
    ['App', ['/demo/app/src/main.js', '/demo/lib/util.js']],
    ['Site', ['/demo/site/index.html', '/demo/site/CLAUDE.md']],
  ]);
  assert.deepEqual(sections.opened, []);
  assert.deepEqual(sections.groups[0].files.map(f => f.displayPath), ['src/', 'lib/']);
  assert.equal(sections.groups[1].files[0].displayPath, './');
});

test('an open or dropped file of no project stays under Opened, each file once', () => {
  const sections = buildFilesSections({
    agents, filter: 'opened', projects,
    opened: { opened: [file('/demo/notes/todo.txt'), file('/demo/app/src/main.js')], pinned: [] },
    open: [...open, { filePath: '/demo/notes/todo.txt', projectId: null }],
  });
  assert.deepEqual(paths(sections.opened), ['/demo/notes/todo.txt']);
  assert.deepEqual(paths(sections.groups[0].files), ['/demo/app/src/main.js', '/demo/lib/util.js']);
});

test('a file opened in a project\'s Files tab is listed under that project, wherever it is', () => {
  const sections = buildFilesSections({
    opened: none, filter: 'opened', projects, open: [{ filePath: '/demo/site/shared.js', projectId: 1 }],
  });
  assert.deepEqual(sections.groups.map(g => g.label), ['App']);
});

test('All files lists every open file under Opened with its project\'s name, by project then file name', () => {
  const more = [
    { filePath: '/demo/site/about.html', projectId: 2 },
    { filePath: '/demo/loose/b.txt', projectId: null },
    ...open,
    { filePath: '/demo/loose/a.txt', projectId: null },
    { filePath: '/demo/.claude/CLAUDE.md', projectId: null },
  ];
  const sections = buildFilesSections({ agents, opened: none, filter: 'all', open: more, projects });
  assert.deepEqual(sections.opened.map(f => `${f.projectName}|${f.filename}`), [
    'App|main.js', 'App|util.js', 'Global|CLAUDE.md', 'Site|about.html', 'Site|CLAUDE.md', 'Site|index.html',
    '|a.txt', '|b.txt',
  ]);
  assert.deepEqual(buildFilesSections({ agents, opened: none, filter: 'agents', open, projects }).opened, []);
});

test('under Opened the pinned files come first, in the order the user gave, whatever their names', () => {
  const pins = ['/demo/loose/z.txt', '/demo/site/index.html', '/demo/lib/util.js'].map(p => file(p));
  const sections = buildFilesSections({
    agents, filter: 'all', projects, opened: { opened: [], pinned: pins },
    open: [...open, { filePath: '/demo/loose/a.txt', projectId: null }, { filePath: '/demo/loose/z.txt', projectId: null }],
  });
  assert.deepEqual(sections.opened.map(f => `${f.projectName}|${f.filename}`), [
    '|z.txt', 'Site|index.html', 'App|util.js',
    'App|main.js', 'Site|CLAUDE.md', '|a.txt',
  ]);
});

const agentsWithFolders = {
  ...agents,
  projects: [
    { ...agents.projects[0], projectPath: '/demo/app' },
    { folder: '-demo-home', shortName: 'demo/home', projectPath: '/demo', files: [file('/demo/AGENTS.md')] },
  ],
};

test('a pinned file stays in its project\'s group, in All files too', () => {
  const pins = ['/demo/lib/util.js', '/demo/site/index.html', '/demo/app/src/main.js', '/demo/loose.txt'].map(p => file(p));
  const sections = buildFilesSections({
    agents: agentsWithFolders, opened: { opened: [], pinned: pins }, filter: 'all', open, projects,
  });
  const byLabel = Object.fromEntries(sections.groups.map(g => [g.label, paths(g.files)]));
  // The attached folder's file goes with its project's agent files, ahead of them.
  assert.deepEqual(byLabel['demo/app'], ['/demo/lib/util.js', '/demo/app/src/main.js', '/demo/app/CLAUDE.md', '/demo/app/AGENTS.md']);
  // A project without agent files has a group of its own, deeper than the folder around it.
  assert.deepEqual(byLabel.Site, ['/demo/site/index.html']);
  assert.deepEqual(byLabel['demo/home'], ['/demo/loose.txt', '/demo/AGENTS.md']);
  assert.deepEqual(sections.pinned, []);
  assert.equal(sections.groups.find(g => g.label === 'Site').files[0].displayPath, './');
});

test('a pinned file stays in its project\'s group among the opened ones, open or not', () => {
  const pins = ['/demo/site/notes.md', '/demo/app/src/main.js', '/demo/loose.txt'].map(p => file(p));
  const sections = buildFilesSections({ opened: { opened: [], pinned: pins }, filter: 'opened', open, projects });
  assert.deepEqual(sections.groups.map(g => [g.label, paths(g.files)]), [
    ['App', ['/demo/app/src/main.js', '/demo/lib/util.js']],
    ['Site', ['/demo/site/notes.md', '/demo/site/index.html', '/demo/site/CLAUDE.md']],
  ]);
  assert.deepEqual(paths(sections.pinned), ['/demo/loose.txt']);
});

test('a project pinned among the agent files is pinned among the opened ones too', () => {
  const withPaths = { ...agents, projects: agents.projects.map(p => ({ ...p, projectPath: `/demo/${p.shortName.split('/')[1]}` })) };
  const sections = buildFilesSections({
    agents: withPaths, filter: 'opened', projects, open, opened: { ...none, pinnedProjects: ['-demo-site'] },
  });
  assert.deepEqual(sections.pinnedGroups.map(g => [g.label, g.pinKey]), [['Site', '-demo-site']]);
  assert.deepEqual(sections.groups.map(g => [g.label, g.pinKey]), [['App', '-demo-app']]);
  // Without agent files, the project's folder is its key.
  const bare = buildFilesSections({ filter: 'opened', projects, open, opened: { ...none, pinnedProjects: ['/demo/site'] } });
  assert.deepEqual(bare.pinnedGroups.map(g => g.label), ['Site']);
});

test('a search finds an open file by its path', () => {
  const sections = buildFilesSections({
    agents, opened: none, filter: 'opened', projects, open, matchIds: new Set(), query: 'UTIL',
  });
  assert.deepEqual(sections.groups.map(g => paths(g.files)), [['/demo/lib/util.js']]);
});
