const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const stored = new Map();
globalThis.window = globalThis.window || new EventTarget();
globalThis.localStorage = {
  getItem: key => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => { stored.set(key, String(value)); },
};

const editorModule = name => import(pathToFileURL(path.join(__dirname, `../public/editor/${name}.mjs`)).href);
const state = () => import('@codemirror/state');

test('a file shorter than the minimap does not scroll it; the slider covers the lines on screen', async () => {
  const { minimapLayout } = await editorModule('minimap');
  const l = minimapLayout({ lines: 100, height: 400, scrollTop: 0, scrollHeight: 2000, clientHeight: 400, firstVisible: 11, lastVisible: 30 });
  assert.equal(l.offset, 0);
  assert.equal(l.sliderTop, 20);
  assert.equal(l.sliderHeight, 40);
  assert.deepEqual([l.firstDrawn, l.lastDrawn], [1, 100]);
});

test('a taller file scrolls the minimap in proportion to the editor', async () => {
  const { minimapLayout, lineAtY } = await editorModule('minimap');
  const base = { lines: 1000, height: 400, scrollHeight: 20400, clientHeight: 400, firstVisible: 1, lastVisible: 20 };
  assert.equal(minimapLayout({ ...base, scrollTop: 0 }).offset, 0);
  const half = minimapLayout({ ...base, scrollTop: 10000, firstVisible: 500, lastVisible: 519 });
  assert.equal(half.offset, 800, 'halfway: half of the 1600 pixels the minimap cannot show');
  assert.equal(half.sliderTop, 998 - 800);
  assert.deepEqual([half.firstDrawn, half.lastDrawn], [401, 600]);
  const end = minimapLayout({ ...base, scrollTop: 20000 });
  assert.equal(end.offset, 1600);
  assert.equal(lineAtY(half, 0, 1000), 401);
  assert.equal(lineAtY(end, 399, 1000), 1000);
});

test('the find bar\'s matches are marked, the current one apart', async () => {
  const { searchMarks } = await editorModule('minimap');
  const { searchState, setSearchQuery } = await editorModule('find');
  const { EditorState, EditorSelection } = await state();
  let s = EditorState.create({ doc: 'one two\ntwo\nthree two', extensions: searchState, selection: EditorSelection.single(8, 11) });
  s = s.update({ effects: setSearchQuery.of({ regex: /two/g, scope: null }) }).state;
  assert.deepEqual(searchMarks(s), [
    { line: 1, fromCol: 4, toCol: 7, active: false },
    { line: 2, fromCol: 0, toCol: 3, active: true },
    { line: 3, fromCol: 6, toCol: 9, active: false },
  ]);
});

test('a diff\'s changes are marked as added, changed or deleted lines', async () => {
  const { diffMarks } = await editorModule('minimap');
  const { EditorState } = await state();
  const { unifiedMergeView } = await import('@codemirror/merge');
  // Changes far apart, so that the diff keeps them in chunks of their own.
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const original = `${lines.join('\n')}\n`;
  const changed = [...lines];
  changed[1] = 'LINE 2';            // line 2 changed
  changed.splice(14, 1);            // line 15 deleted: the text goes on at line 15
  changed.push('line 31');          // a line added at the end (line 30 now)
  const doc = `${changed.join('\n')}\n`;
  const s = EditorState.create({ doc, extensions: unifiedMergeView({ original }) });
  const kinds = diffMarks(s).map(m => `${m.kind}:${m.fromLine}-${m.toLine}`);
  assert.deepEqual(kinds, ['changed:2-2', 'deleted:15-15', 'added:30-30']);
  assert.deepEqual(diffMarks(EditorState.create({ doc })), [], 'no diff, no marks');
});

test('errors and warnings are marked by severity', async () => {
  const { diagnosticMarks } = await editorModule('minimap');
  const { EditorState } = await state();
  const { setDiagnostics } = await import('@codemirror/lint');
  let s = EditorState.create({ doc: 'one\ntwo\nthree' });
  s = s.update(setDiagnostics(s, [
    { from: 4, to: 7, severity: 'error', message: 'bad' },
    { from: 8, to: 13, severity: 'info', message: 'hm' },
  ])).state;
  assert.deepEqual(diagnosticMarks(s), [
    { fromLine: 2, toLine: 2, severity: 'error' },
    { fromLine: 3, toLine: 3, severity: 'warning' },
  ]);
});

test('the scroller makes room for a shown minimap, so that no text goes under it', async () => {
  const { MinimapView, MINIMAP_WIDTH } = await editorModule('minimap');
  const element = () => ({ style: {}, setAttribute() {}, append() {}, appendChild() {}, addEventListener() {}, removeEventListener() {}, remove() {} });
  globalThis.document = { createElement: element };
  try {
    const view = { dom: element(), scrollDOM: element(), requestMeasure() {} };
    const map = new MinimapView(view);
    assert.equal(view.scrollDOM.style.marginRight, `${MINIMAP_WIDTH}px`);
    map.draw({ shown: false });
    assert.equal(view.scrollDOM.style.marginRight, '', 'not drawn in a narrow editor');
    map.makeRoom(true);
    map.destroy();
    assert.equal(view.scrollDOM.style.marginRight, '', 'the minimap switched off');
  } finally {
    delete globalThis.document;
  }
});

test('the wheel over the minimap scrolls the text, and passes on at its end', async () => {
  const { MinimapView } = await editorModule('minimap');
  const scroller = {
    scrollTop: 0, scrollLeft: 0,
    scrollBy(x, y) { this.scrollLeft = Math.max(0, this.scrollLeft + x); this.scrollTop = Math.max(0, this.scrollTop + y); },
  };
  const wheel = (deltaY, ctrlKey = false) => {
    let taken = false;
    MinimapView.prototype.wheel.call({ view: { scrollDOM: scroller } }, { deltaX: 0, deltaY, ctrlKey, preventDefault() { taken = true; } });
    return taken;
  };
  assert.equal(wheel(120), true);
  assert.equal(scroller.scrollTop, 120);
  assert.equal(wheel(120, true), false, 'Ctrl + wheel is not a scroll');
  assert.equal(scroller.scrollTop, 120);
  wheel(-120);
  assert.equal(wheel(-120), false, 'already at the top');
});

test('the minimap is in an editor when it is on, never in a compact one', async () => {
  const { editorExtensions } = await editorModule('core');
  const { prefActive, setPref } = await editorModule('prefs');
  const { EditorState } = await state();
  const make = options => EditorState.create({ extensions: editorExtensions(options).extensions });
  assert.equal(prefActive(make({ filename: 'a.js' }), 'minimap'), true, 'on by default');
  assert.equal(prefActive(make({ filename: 'q.cypher', statusBar: false }), 'minimap'), false, 'the Cypher box');
  assert.equal(prefActive(make({ filename: 'a.js', readOnly: true, statusBar: false, merge: true }), 'minimap'), false, 'the original side');
  setPref('minimap', false);
  assert.equal(prefActive(make({ filename: 'a.js' }), 'minimap'), false);
  stored.clear();
});
