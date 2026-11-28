// The tabs of the editors (public/editor-tabs.js): their labels, what stays
// open behind them, and a session's file panel built on them (file-panel.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');

/** Just enough of a DOM element for the tabs and the panel. */
function element() {
  const classes = new Set();
  const el = {
    children: [], parentElement: null, style: {}, dataset: {}, hidden: false, textContent: '', innerHTML: '',
    classList: {
      add: (...names) => names.forEach(n => classes.add(n)),
      remove: (...names) => names.forEach(n => classes.delete(n)),
      toggle: (name, on = !classes.has(name)) => (on ? classes.add(name) : classes.delete(name)),
      contains: name => classes.has(name),
    },
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(n => classes.add(n)); },
    get className() { return [...classes].join(' '); },
    appendChild(child) { child.parentElement = el; el.children.push(child); return child; },
    replaceChildren(...children) { el.children = []; children.forEach(c => el.appendChild(c)); },
    removeChild(child) { el.children = el.children.filter(c => c !== child); },
    remove() { el.parentElement?.removeChild(el); el.parentElement = null; },
    insertBefore(child) { return el.appendChild(child); },
    addEventListener(type, callback) { el[`on:${type}`] = callback; },
    setAttribute(name, value) { el[name] = value; },
    querySelector: () => null,
  };
  return el;
}

/** The tabs (and, with `panel`, the file panel; with `project`, the project's Files tab) over a stand-in viewer. */
function setup({ panel = false, project = false, stored = new Map(), drafts = new Map(), files = {} } = {}) {
  const panels = [];
  class FakePanel {
    constructor(host, opts) { this.opts = opts; this.filePath = ''; this.editorView = null; this.toolbar = { closeBtn: {} }; this.opens = 0; panels.push(this); }
    open(_title, filePath, content, preview = {}) {
      const draft = drafts.get(filePath);
      this.opens++;
      this.filePath = filePath;
      this.saved = content;
      this.content = draft ? draft.content : content;
      this.missing = !!preview.missing;
      this.editorView = { requestMeasure() {}, focus() {}, destroy() {} };
    }
    type(text) { this.content = text; this.opts.onDirtyChange?.(true); }
    isDirty() { return this.content !== this.saved; }
    async confirmLeave() { return this.answer !== 'cancel'; }
    goToLocation(line) { this.line = line; }
    async relocate(_title, filePath) { this.filePath = filePath; }
    dispose({ discard = false } = {}) { this.disposed = true; this.discarded = discard; }
  }
  const alerts = [];
  const answers = [];
  const listeners = {};
  const byId = { 'terminal-area': element(), terminals: element() };
  const created = [];
  const context = vm.createContext({
    document: {
      createElement: () => { const el = element(); created.push(el); return el; },
      getElementById: id => byId[id] || created.find(el => el.id === id) || null,
      addEventListener() {},
      body: element(),
    },
    localStorage: {
      getItem: key => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: key => stored.delete(key),
    },
    alert: message => alerts.push(message),
    requestAnimationFrame: () => {},
  });
  vm.runInContext('globalThis.window = globalThis', context);
  context.addEventListener = (type, callback) => { listeners[type] = callback; };
  context.ViewerPanel = FakePanel;
  context.api = new Proxy({
    getDraft: filePath => drafts.get(filePath) || null,
    mcpDiffResponse: (...args) => { answers.push(args); return Promise.resolve(true); },
    readFileForPanel: async filePath => (filePath in files ? { ok: true, content: files[filePath] } : { ok: false, error: 'gone' }),
    readProjectFile: async (root, rel) => (`${root}/${rel}` in files
      ? { ok: true, content: files[`${root}/${rel}`], filePath: `${root}/${rel}` } : { ok: false, error: 'gone' }),
  }, { get: (target, name) => target[name] || (() => {}) });
  vm.runInContext(read('editor-tabs.js'), context);
  if (panel) {
    // The explorers' path helpers (remapFileActionPath…).
    vm.runInContext(read('file-actions.js'), context);
    context.openUnsupportedFile = async () => false;
    vm.runInContext(read('file-panel.js'), context);
    context.initFilePanel();
  }
  const run = code => vm.runInContext(code, context);
  let pages = null;
  if (project) {
    const projects = ['a', 'b'].map(id => ({ id, name: id.toUpperCase(), root: `/w/${id}`, folders: [] }));
    // The project page on screen, and the place its Files tab keeps for the editor.
    pages = { shown: 'a', hosts: new Map(projects.map(p => [p.id, Object.assign(element(), { isConnected: true })])) };
    Object.assign(context, {
      projectsUi: { files: new Map() },
      cachedProjectTreeAll: { projects },
      findTreeProject: id => projects.find(p => p.id === id),
      selectedProject: () => projects.find(p => p.id === pages.shown),
      projectViewer: {
        querySelector: selector => (selector === '#ws-editor' ? pages.hosts.get(pages.shown) : null),
        querySelectorAll: () => [],
      },
      pathBasename: p => String(p).split('/').filter(Boolean).pop(),
    });
    vm.runInContext(read('file-actions.js'), context);
    vm.runInContext(read('project-files-view.js'), context);
  }
  const editor = id => run('projectEditors').get(id);
  const openIn = async (id, rel) => {
    pages.shown = id;
    await context.openFileInProjectEditor(context.findTreeProject(id), rel, { root: `/w/${id}` });
  };
  const pathsOf = id => Array.from(editor(id).tabs.tabs, tab => tab.path);
  const labelsOf = id => editor(id).tabs.bar.children.map(tab => tab.children[1].textContent);
  const state = id => run('filePanelState').get(id);
  const tabsOf = id => state(id).editors.tabs.map(tab => tab.path);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { context, panels, alerts, answers, stored, drafts, files, state, tabsOf, settle, pages, editor, openIn, pathsOf, labelsOf };
}

const labels = files => {
  const { context } = setup();
  return Array.from(context.editorTabLabels(files.map(([filePath, project]) => ({ filePath, project }))));
};

test('a name only one open file has is the whole label', () => {
  assert.deepEqual(labels([['/w/app/src/main.js', 'App']]), ['main.js']);
  assert.deepEqual(labels([['/w/app/src/main.js', 'App'], ['/w/lib/readme.md', 'Lib']]), ['main.js', 'readme.md']);
});

test('files of one name in one project get folders back to where their paths differ', () => {
  assert.deepEqual(
    labels([['/w/app/apps/desktop/package.json', 'App'], ['/w/app/apps/mobile/package.json', 'App']]),
    ['desktop/package.json', 'mobile/package.json'],
  );
  assert.deepEqual(
    labels([['/w/app/x/src/foo.js', 'App'], ['/w/app/y/src/foo.js', 'App']]),
    ['x/src/foo.js', 'y/src/foo.js'],
  );
  assert.deepEqual(labels([['/w/app/p/foo.js', 'App'], ['/w/app/a/foo.js', 'App']]), ['p/foo.js', 'a/foo.js']);
});

test('files of one name in different projects get the project, and folders only when it takes more', () => {
  assert.deepEqual(
    labels([['/w/app/package.json', 'App'], ['/w/lib/package.json', 'Lib']]),
    ['App · package.json', 'Lib · package.json'],
  );
  assert.deepEqual(
    labels([['/w/app/a/index.js', 'App'], ['/w/app/b/index.js', 'App'], ['/w/lib/a/index.js', 'Lib']]),
    ['App · a/index.js', 'App · b/index.js', 'Lib · index.js'],
  );
  // A file of no project is told apart by its path.
  assert.deepEqual(
    labels([['/w/app/notes.md', 'App'], ['/home/u/notes.md', '']]),
    ['App · notes.md', 'u/notes.md'],
  );
  // Two projects of the same name.
  assert.deepEqual(
    labels([['/a/app/x.js', 'App'], ['/b/web/x.js', 'App'], ['/c/x.js', 'Lib']]),
    ['App · app/x.js', 'App · web/x.js', 'Lib · x.js'],
  );
});

test('every file keeps its viewer and its text while another tab is shown', async () => {
  const { context, panels } = setup();
  const host = context.document.createElement();
  const tabs = new context.EditorTabs(host, { createPanel: (el, _tab, shared) => new context.ViewerPanel(el, shared) });
  const a = tabs.add('/a.js');
  tabs.fill(a, 'a');
  tabs.activate(a);
  a.panel.type('a typed');
  const b = tabs.add('/b.js');
  tabs.fill(b, 'b');
  tabs.activate(b);
  assert.equal(panels.length, 2);
  assert.equal(a.element.hidden, true);
  assert.equal(b.element.hidden, false);
  tabs.activate(a);
  assert.equal(a.panel.content, 'a typed');
  assert.equal(a.panel.opens, 1);

  a.panel.answer = 'cancel';
  assert.equal(await tabs.close(a), false);
  assert.equal(tabs.tabs.length, 2);
  a.panel.answer = 'discard';
  assert.equal(await tabs.close(a), true);
  assert.deepEqual(Array.from(tabs.tabs, t => t.path), ['/b.js']);
  assert.equal(tabs.active, b);
});

test('the open files come back after a restart, unread, marking those with unsaved text', () => {
  const stored = new Map();
  const first = setup({ stored });
  const open = ({ context }) => new context.EditorTabs(context.document.createElement(), {
    storageKey: 'tabs', createPanel: (el, _tab, shared) => new context.ViewerPanel(el, shared),
  });
  const before = open(first);
  for (const file of ['/a.js', '/b.js']) before.activate(before.add(file));

  const second = setup({ stored, drafts: new Map([['/a.js', { content: 'typed', base: 'a' }]]) });
  const after = open(second);
  assert.deepEqual(Array.from(after.tabs, t => [t.path, t.loaded, after.isDirty(t)]), [['/a.js', false, true], ['/b.js', false, false]]);
  assert.equal(after.lastUsed().path, '/b.js');
  assert.equal(second.panels.length, 0);
});

test('a session keeps its files, and what is typed in them, across sessions and diffs', async () => {
  const { context, state, tabsOf, settle, answers } = setup({ panel: true, files: { '/p/a.js': 'a', '/p/b.js': 'b' } });
  context.switchPanel('s1');
  const a = await context.openFileInPanel('s1', '/p/a.js');
  a.type('a typed');
  const b = await context.openFileInPanel('s1', '/p/b.js');
  assert.deepEqual(Array.from(tabsOf('s1')), ['/p/a.js', '/p/b.js']);
  assert.notEqual(a, b);

  context.switchPanel('s2');
  await context.openFileInPanel('s2', '/p/b.js');
  context.switchPanel('s1');
  assert.equal(await context.openFileInPanel('s1', '/p/a.js'), a);
  assert.equal(a.content, 'a typed');
  assert.equal(a.opens, 1);

  // The CLI's diff takes the files' place; closed, the file shown before is back.
  context.createMergeViewer = () => ({ dom: context.document.createElement(), destroy() {} });
  context.openDiffTab('s1', 'd1', { oldFilePath: '/p/b.js', oldContent: 'b', newContent: 'c' });
  assert.equal(state('s1').currentTab.type, 'diff');
  context.handleClose();
  await settle();
  assert.equal(answers.length, 1);
  assert.equal(state('s1').currentTab.type, 'file');
  assert.equal(state('s1').currentTab.filePath, '/p/a.js');
  assert.equal(a.content, 'a typed');
});

test('the CLI opening a file again leaves unsaved changes alone, and closing the last tab closes the panel', async () => {
  const { context, state, settle } = setup({ panel: true });
  context.switchPanel('s1');
  context.openFileTab('s1', { filePath: '/p/a.js', content: 'a' });
  await settle();
  const tab = state('s1').editors.find('/p/a.js');
  tab.panel.type('typed');
  context.openFileTab('s1', { filePath: '/p/a.js', content: 'new' });
  assert.equal(tab.panel.content, 'typed');
  await state('s1').editors.close(tab);
  assert.equal(state('s1').currentTab, null);
  assert.equal(state('s1').panelVisible, false);
});

test('a session shown after a restart brings its files back with their unsaved text', async () => {
  const stored = new Map();
  const first = setup({ panel: true, stored, files: { '/p/a.js': 'a' } });
  first.context.switchPanel('s1');
  await first.context.openFileInPanel('s1', '/p/a.js');

  const second = setup({ panel: true, stored, files: { '/p/a.js': 'a' }, drafts: new Map([['/p/a.js', { content: 'typed', base: 'a' }]]) });
  second.context.switchPanel('s1');
  await second.settle();
  assert.equal(second.state('s1').panelVisible, true);
  assert.equal(second.state('s1').editors.find('/p/a.js').panel.content, 'typed');
});

test('a rename moves a session\'s tab, a trash drops it with its unsaved text', async () => {
  const { context, state, tabsOf, settle } = setup({ panel: true, files: { '/p/a.js': 'a', '/p/b.js': 'b' } });
  context.switchPanel('s1');
  const a = await context.openFileInPanel('s1', '/p/a.js');
  const b = await context.openFileInPanel('s1', '/p/b.js');
  const entry = relativePath => ({ projectPath: '/p', relativePath, filePath: `/p/${relativePath}` });
  await context.applyBrowserFileAction({ ...entry('a.js'), action: 'rename', newRelativePath: 'c.js', newFilePath: '/p/c.js' });
  assert.deepEqual(Array.from(tabsOf('s1')), ['/p/c.js', '/p/b.js']);
  assert.equal(a.filePath, '/p/c.js');
  await context.applyBrowserFileAction({ ...entry('b.js'), action: 'trash' });
  await settle();
  assert.deepEqual(Array.from(tabsOf('s1')), ['/p/c.js']);
  assert.equal(b.discarded, true);
  assert.equal(state('s1').currentTab.filePath, '/p/c.js');
});

test('each project keeps its own tabs in its Files tab, brought back after a restart', async () => {
  const stored = new Map();
  const files = { '/w/a/notes.txt': 'a', '/w/a/src/main.js': 'm', '/w/b/notes.txt': 'b' };
  const first = setup({ project: true, stored, files });
  await first.openIn('a', 'notes.txt');
  first.editor('a').panel.type('a typed');
  await first.openIn('a', 'src/main.js');
  await first.openIn('b', 'notes.txt');
  assert.deepEqual(first.pathsOf('a'), ['/w/a/notes.txt', '/w/a/src/main.js']);
  assert.deepEqual(first.pathsOf('b'), ['/w/b/notes.txt']);
  // One file of that name in each project: its name alone.
  assert.deepEqual(first.labelsOf('b'), ['notes.txt']);
  assert.equal(first.pages.hosts.get('a').children[0], first.editor('a').host);
  assert.equal(first.pages.hosts.get('b').children[0], first.editor('b').host);
  // Back on the first project: its tab and what was typed in it are as left.
  await first.openIn('a', 'notes.txt');
  assert.equal(first.editor('a').panel.content, 'a typed');
  assert.deepEqual([...stored.keys()].sort(), ['editorTabs:project:a', 'editorTabs:project:b']);

  const second = setup({ project: true, stored, files });
  second.context.ensureProjectEditor('b');
  assert.deepEqual(second.pathsOf('b'), ['/w/b/notes.txt']);
  second.context.ensureProjectEditor('a');
  assert.deepEqual(second.pathsOf('a'), ['/w/a/notes.txt', '/w/a/src/main.js']);
});

test('a file read after the page changed stays out of the other project\'s page', async () => {
  const { context, pages, editor, openIn } = setup({ project: true, files: { '/w/a/x.js': 'x' } });
  await openIn('a', 'x.js');
  const ed = editor('a');
  const tab = ed.tabs.tabs[0];
  pages.shown = 'b';
  await context.showProjectEditorTab(ed, tab);
  assert.equal(pages.hosts.get('b').children.length, 0);
  assert.equal(editor('b'), undefined);
});

test('a rename and a trash reach the tabs of a project not shown since the start', async () => {
  const tab = rel => ({ path: `/w/b/${rel}`, data: { projectId: 'b', root: '/w/b', rel }, used: 1 });
  const stored = new Map([['editorTabs:project:b', JSON.stringify({ files: [tab('x.js'), tab('y.js')] })]]);
  const { context, editor, pathsOf } = setup({ project: true, stored });
  const entry = relativePath => ({ projectPath: '/w/b', relativePath, filePath: `/w/b/${relativePath}` });
  await context.applyProjectFileAction({ ...entry('x.js'), action: 'rename', newRelativePath: 'z.js', newFilePath: '/w/b/z.js' });
  assert.deepEqual(pathsOf('b'), ['/w/b/z.js', '/w/b/y.js']);
  assert.equal(editor('b').tabs.tabs[0].data.rel, 'z.js');
  await context.applyProjectFileAction({ ...entry('y.js'), action: 'trash' });
  assert.deepEqual(pathsOf('b'), ['/w/b/z.js']);
  assert.equal(editor('a'), undefined);
});
