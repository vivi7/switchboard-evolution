const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(options = {}) {
  const element = () => ({
    style: { setProperty(name, value) { this[name] = value; } }, children: [], textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, callback) { this[type] = callback; },
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) { this.children.push(child); },
    insertBefore(child) { this.children.unshift(child); },
    replaceChildren(...children) { this.children = children; },
    after(sibling) { this.afterSibling = sibling; },
    querySelector() { return null; },
  });
  const toolbar = {
    setTitle(title) { this.titleEl.textContent = title; }, setPath() {}, setWrapMode() {}, setPreviewMode() {},
    setDirty(dirty) { this.dirty = dirty; },
  };
  for (const key of ['el', 'titleEl', 'previewBtn', 'wrapBtn', 'saveBtn', 'gotoLineBtn', 'copyContentBtn', 'openExternalBtn', 'revealBtn', 'shareBtn', 'fontSmallerBtn', 'fontLargerBtn']) toolbar[key] = element();
  toolbar.flashSave = () => { toolbar.flashes = (toolbar.flashes || 0) + 1; };
  const revoked = [];
  let nextUrl = 0;
  let saved = 0;
  const revealed = [];
  const alerts = [];
  const api = { watchFile() {}, unwatchFile() {}, revealFile: filePath => revealed.push(filePath) };
  const stored = new Map();
  const listeners = {};
  const documentListeners = {};
  const context = vm.createContext({
    document: { createElement: element, addEventListener(type, callback) { (documentListeners[type] ||= []).push(callback); } },
    navigator: { platform: 'MacIntel' },
    localStorage: { getItem: key => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => stored.set(key, String(value)) },
    Uint8Array, Blob, atob, setTimeout, clearTimeout, alert: message => alerts.push(message),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    URL: { createObjectURL: () => `blob:${++nextUrl}`, revokeObjectURL: url => revoked.push(url) },
    window: {
      api, JsoncParser: require('jsonc-parser'), createViewerToolbar: () => toolbar,
      addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
      dispatchEvent(event) { for (const callback of listeners[event.type] || []) callback(event); },
      createEditableViewer: (_el, content, _name, { onChange } = {}) => ({
        state: { doc: { toString: () => content, length: content.length } },
        // Like CodeMirror: every change of the text, typed or loaded, is an update.
        dispatch({ changes }) { if (changes) { content = changes.insert; this.state.doc.length = content.length; onChange?.(); } },
        requestMeasure() { this.measured = (this.measured || 0) + 1; },
        destroy() { this.destroyed = true; },
      }),
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/json-reader.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/viewer-panel.js'), 'utf8'), context);
  const writes = [];
  const panel = new context.window.ViewerPanel(element(), {
    language: 'auto',
    onSave: async (filePath, content) => { saved++; writes.push([filePath, content]); return { ok: true }; },
    ...options,
  });
  const media = { previewType: 'image', mimeType: 'image/png', base64: 'AAEC' };
  return { panel, toolbar, revoked, api, media, revealed, alerts, saved: () => saved, writes, stored, context, documentListeners };
}

test('the toolbar opens the shown file in its default app and reports failures', async () => {
  const { panel, toolbar, api, alerts } = setup();
  const calls = [];
  api.openFileExternally = async (...args) => { calls.push(args); return { ok: true }; };
  await toolbar.openExternalBtn.click();
  assert.deepEqual(calls, []);
  panel.open('Code', '/app.js', 'const a = 1;');
  await toolbar.openExternalBtn.click();
  assert.deepEqual(calls, [['/app.js', null]]);
  api.openFileExternally = async () => ({ ok: false, error: 'No default application' });
  await toolbar.openExternalBtn.click();
  assert.deepEqual(alerts, ['No default application']);
});

test('media previews cannot save binary files and switching files restores editing', async () => {
  const { panel, toolbar, media, revoked, saved } = setup();
  panel.open('Code', '/app.js', 'const original = true;');
  const oldEditor = panel.editorView;
  panel.open('Image', '/image.png', undefined, media);
  assert.equal(oldEditor.destroyed, true);
  assert.equal(panel.editorView, null);
  assert.equal(toolbar.saveBtn.style.display, 'none');
  assert.equal(toolbar.copyContentBtn.style.display, 'none');
  await panel._save();
  assert.equal(saved(), 0);
  assert.equal(panel.previewEl.children[0].src, 'blob:1');
  panel.open('Text', '/notes.txt', 'New content');
  assert.equal(panel.getContent(), 'New content');
  assert.equal(toolbar.saveBtn.style.display, '');
  assert.equal(panel.editorEl.style.display, '');
  assert.deepEqual(revoked, ['blob:1']);
});

test('media reloads replace and release object URLs; destroy releases the last preview', async () => {
  const { panel, media, api, revoked } = setup();
  panel.open('Image', '/image.png', undefined, media);
  api.readFileForPanel = async () => ({ ok: true, ...media, base64: 'AwQF' });
  await panel._reloadFromDisk();
  assert.equal(panel.previewEl.children[0].src, 'blob:2');
  assert.deepEqual(revoked, ['blob:1']);
  panel.destroy();
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  assert.equal(panel.filePath, '');
});

test('a delayed reload cannot replace a newly selected file or revive a destroyed preview', async () => {
  const { panel, api, media } = setup();
  let resolve;
  api.readFileForPanel = () => new Promise(done => { resolve = done; });
  panel.open('Image', '/image.png', undefined, media);
  const pending = panel._reloadFromDisk();
  panel.open('Code', '/app.js', 'keep this');
  resolve({ ok: true, ...media });
  await pending;
  assert.equal(panel.filePath, '/app.js');
  assert.equal(panel.getContent(), 'keep this');
  const second = panel._reloadFromDisk();
  panel.destroy();
  resolve({ ok: true, content: 'stale' });
  await second;
  assert.equal(panel.editorView, null);
  assert.equal(panel.filePath, '');
});


test('renaming an open file preserves edits, updates saves and ignores a stale reload', async () => {
  const { panel, api, saved } = setup();
  panel.open('Draft', '/notes.md', 'unsaved edits');
  const requests = [];
  api.readFileForPanel = () => new Promise(resolve => requests.push(resolve));
  const stale = panel._reloadFromDisk();
  const rename = panel.relocate('Renamed', '/renamed.md');
  requests[0]({ ok: true, content: 'stale disk content' });
  await stale;
  requests[1]({ ok: true, content: 'disk content' });
  await rename;
  assert.equal(panel.filePath, '/renamed.md');
  assert.equal(panel.getContent(), 'unsaved edits');
  assert.equal(panel._watchedPath, '/renamed.md');
  panel.toolbar.flashSave = () => {};
  await panel._save();
  assert.equal(saved(), 1);
});


test('renaming to a media extension cannot discard an editable buffer', async () => {
  const { panel, api, media } = setup();
  panel.open('Text', '/notes.txt', 'unsaved text');
  api.readFileForPanel = async () => ({ ok: true, ...media });
  await panel.relocate('Image', '/notes.png');
  assert.equal(panel.filePath, '/notes.png');
  assert.equal(panel.getContent(), 'unsaved text');
  assert.equal(panel.previewType, 'text');
});

test('a rename reply cannot revive a closed editor', async () => {
  const { panel, api } = setup();
  panel.open('Text', '/notes.txt', 'text');
  let resolve;
  api.readFileForPanel = () => new Promise(done => { resolve = done; });
  const rename = panel.relocate('Renamed', '/renamed.txt');
  panel.destroy();
  resolve({ ok: true, content: 'late reply' });
  await rename;
  assert.equal(panel.filePath, '');
  assert.equal(panel.editorView, null);
});

test('PowerPoint is read-only and transfers bytes only to an isolated preview frame', async () => {
  const { panel, toolbar, saved, revoked } = setup();
  panel.open('Deck', '/slides.pptx', undefined, { previewType: 'pptx', previewUrl: 'switchboard-preview://test/pptx-preview.html', base64: 'AAEC' });
  const frame = panel.previewEl.children[0];
  assert.equal(frame.src, 'switchboard-preview://test/pptx-preview.html');
  assert.equal(frame.sandbox, 'allow-scripts');
  assert.equal(frame.title, 'PowerPoint preview: slides.pptx');
  assert.equal(panel.editorView, null);
  assert.equal(toolbar.saveBtn.style.display, 'none');
  await panel._save();
  assert.equal(saved(), 0);
  const messages = [];
  frame.contentWindow = { postMessage: (...args) => messages.push(args) };
  frame.load();
  assert.equal(messages[0][0].type, 'switchboard-pptx');
  assert.deepEqual([...new Uint8Array(messages[0][0].buffer)], [0, 1, 2]);
  assert.equal(messages[0][2][0], messages[0][0].buffer);
  panel.open('Text', '/notes.txt', 'Editable');
  assert.equal(panel.getContent(), 'Editable');
  assert.equal(toolbar.saveBtn.style.display, '');
  assert.equal(panel.previewEl.children.length, 0);
  assert.deepEqual(revoked, [], 'PPTX frames own their media URLs');
});

test('PowerPoint reload and rename replace the frame, and stale reloads cannot revive it', async () => {
  const { panel, api } = setup();
  const deck = { ok: true, previewType: 'pptx', previewUrl: 'switchboard-preview://test/pptx-preview.html', base64: 'AAEC' };
  panel.open('Deck', '/slides.pptx', undefined, deck);
  const original = panel.previewEl.children[0];
  api.readFileForPanel = async () => deck;
  await panel._reloadFromDisk();
  assert.notEqual(panel.previewEl.children[0], original);
  await panel.relocate('Renamed', '/renamed.pptx');
  assert.equal(panel.previewEl.children[0].title, 'PowerPoint preview: renamed.pptx');
  let resolve;
  api.readFileForPanel = () => new Promise(done => { resolve = done; });
  const pending = panel._reloadFromDisk();
  panel.destroy();
  resolve(deck);
  await pending;
  assert.equal(panel.previewEl.children.length, 0);
  assert.equal(panel._presentationBytes, null);
});

test('a delayed PowerPoint frame load is ignored after switching files', () => {
  const { panel } = setup();
  panel.open('Deck', '/slides.pptx', undefined, { previewType: 'pptx', previewUrl: 'switchboard-preview://test/pptx-preview.html', base64: 'AAEC' });
  const frame = panel.previewEl.children[0];
  frame.contentWindow = { postMessage() { assert.fail('Stale preview must not receive data'); } };
  panel.open('Text', '/notes.txt', 'Keep this');
  frame.load();
  assert.equal(panel.getContent(), 'Keep this');
});

test('JSON opens as a tree that keeps what the user closed across a reload, and can go back to editing', async () => {
  const { panel, toolbar, api } = setup();
  panel.open('Config', '/config.json', '{"name": "app", "scripts": {"build": "x"}, "empty": []}');
  assert.equal(toolbar.previewBtn.style.display, '');
  assert.equal(panel.previewMode, true);
  assert.equal(panel.previewEl.className, 'json-reader');
  assert.equal(panel.editorEl.style.display, 'none');
  const tree = panel.previewEl.children[0];
  assert.equal(tree.open, true);
  const rows = tree.children[1].children;
  assert.deepEqual(rows[0].children.map(c => c.textContent), ['"name"', ': ', '"app"']);
  const scripts = rows[1];
  assert.equal(scripts.open, true, 'a small top level opens its containers');
  assert.equal(scripts.children[0].children.at(-1).textContent, '1 key');
  assert.deepEqual(rows[2].children.map(c => c.textContent), ['"empty"', ': ', '[]']);

  scripts.open = false;
  scripts.toggle();
  api.readFileForPanel = async () => ({ ok: true, content: '{"name": "app", "scripts": {"build": "y", "test": "z"}, "empty": []}' });
  await panel._reloadFromDisk();
  const reloaded = panel.previewEl.children[0].children[1].children[1];
  assert.equal(reloaded.open, false, 'a node the user closed stays closed');
  assert.equal(reloaded.children[1].children.length, 0, 'closed nodes build no rows');
  assert.equal(reloaded.children[0].children.at(-1).textContent, '2 keys');

  panel._togglePreview();
  assert.equal(panel.previewMode, false);
  assert.equal(panel.editorEl.style.display, '');
  assert.equal(panel.previewEl.children.length, 0);
  panel.open('Text', '/notes.txt', 'plain');
  assert.equal(toolbar.previewBtn.style.display, 'none');
});

test('a broken JSON file says where it breaks, and its button jumps there in the editor', () => {
  const { panel } = setup();
  panel.open('Broken', '/bad.json', '{\n  "a": }');
  const error = panel.previewEl.children[0];
  assert.equal(error.className, 'json-reader-error');
  assert.match(error.children[0].textContent, /line 2, column 8/);
  const moves = [];
  panel.goToLocation = (line, column) => moves.push([line, column]);
  error.children[1].click();
  assert.deepEqual(moves, [[2, 8]]);
});

test('a .jsonc file with comments and a trailing comma reads as a tree, not an error', () => {
  const { panel } = setup();
  panel.open('Settings', '/settings.jsonc', '// editor settings\n{"tabSize": 2,}');
  assert.equal(panel.previewEl.children[0].className, 'json-reader-node');
});

test('the reveal button shows the open file in the file manager, including media previews', () => {
  const { panel, toolbar, media, revealed } = setup();
  panel.open('Plan', '/Users/me/.claude/plans/plan.md', '# plan');
  assert.equal(toolbar.revealBtn.style.display, '');
  toolbar.revealBtn.click();
  panel.open('Image', '/project/image.png', undefined, media);
  assert.equal(toolbar.revealBtn.style.display, '');
  toolbar.revealBtn.click();
  assert.deepEqual(revealed, ['/Users/me/.claude/plans/plan.md', '/project/image.png']);
  panel.destroy();
  toolbar.revealBtn.click();
  panel.open('Untitled', '', '');
  assert.equal(toolbar.revealBtn.style.display, 'none');
  assert.equal(revealed.length, 2);
});

test('the share button hands the shown file to the share menu, media included, and reports failures', async () => {
  const { panel, toolbar, api, media, alerts } = setup();
  const calls = [];
  api.shareFile = async (...args) => { calls.push(args); return { ok: true }; };
  await toolbar.shareBtn.click();
  assert.deepEqual(calls, []);
  panel.open('Plan', '/Users/me/plan.md', '# plan');
  assert.equal(toolbar.shareBtn.style.display, '');
  await toolbar.shareBtn.click();
  panel.open('Image', '/Users/me/shot.png', undefined, media);
  assert.equal(toolbar.shareBtn.style.display, '');
  await toolbar.shareBtn.click();
  assert.deepEqual(calls, [['/Users/me/plan.md'], ['/Users/me/shot.png']]);
  api.shareFile = async () => ({ ok: false, error: 'The file does not exist' });
  await toolbar.shareBtn.click();
  assert.deepEqual(alerts, ['The file does not exist']);
  panel.open('Nothing', '', '');
  assert.equal(toolbar.shareBtn.style.display, 'none');
});

test('A− and A+ size the text one pixel a step, within bounds, remembered for every editor', async () => {
  const { panel, toolbar, stored, context } = setup();
  panel.open('Notes', '/notes.md', '# Notes');
  assert.equal(panel.container.style['--viewer-font-step'], '0');
  await toolbar.fontLargerBtn.click();
  await toolbar.fontLargerBtn.click();
  assert.equal(panel.container.style['--viewer-font-step'], '2');
  assert.equal(stored.get('viewerFontStep'), '2');
  assert.ok(panel.editorView.measured >= 2);
  for (let i = 0; i < 30; i++) await toolbar.fontSmallerBtn.click();
  assert.equal(panel.container.style['--viewer-font-step'], '-4');
  assert.equal(toolbar.fontSmallerBtn.disabled, true);
  assert.equal(toolbar.fontLargerBtn.disabled, false);
  // Another editor opened later starts at the size chosen.
  const other = new context.window.ViewerPanel(toolbar.el, { language: 'auto' });
  assert.equal(other.container.style['--viewer-font-step'], '-4');
});

test('with autosave an edit is saved once the typing stops, quietly, and never a loaded text', async () => {
  const { panel, toolbar, writes } = setup({ autosaveMs: 5 });
  panel.open('Note', '/note.md', '# Note');
  assert.equal(panel.isDirty(), false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(writes, []);
  panel.editorView.dispatch({ changes: { from: 0, to: 6, insert: '# Note\nfirst' } });
  panel.editorView.dispatch({ changes: { from: 0, to: 12, insert: '# Note\nfirst line' } });
  assert.equal(panel.isDirty(), true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(writes, [['/note.md', '# Note\nfirst line']]);
  assert.equal(panel.isDirty(), false);
  assert.equal(toolbar.flashes, undefined);
});

test('flush writes what is not saved yet at once, and nothing when it is saved', async () => {
  const { panel, writes } = setup({ autosaveMs: 60_000 });
  panel.open('Note', '/note.md', 'a');
  await panel.flush();
  assert.deepEqual(writes, []);
  panel.editorView.dispatch({ changes: { from: 0, to: 1, insert: 'ab' } });
  await panel.flush();
  assert.deepEqual(writes, [['/note.md', 'ab']]);
});

test('without autosave an edit waits for Save, which still flashes', async () => {
  const { panel, toolbar, writes } = setup();
  panel.open('Code', '/app.js', 'a');
  panel.editorView.dispatch({ changes: { from: 0, to: 1, insert: 'ab' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(writes, []);
  await panel._save();
  assert.deepEqual(writes, [['/app.js', 'ab']]);
  assert.equal(toolbar.flashes, 1);
});

test('the title shows a dot while there are unsaved changes, gone once saved', async () => {
  const { panel, toolbar } = setup();
  panel.open('Code', '/app.js', 'a');
  assert.equal(toolbar.dirty, false);
  panel.editorView.dispatch({ changes: { from: 0, to: 1, insert: 'ab' } });
  assert.equal(toolbar.dirty, true);
  await panel._save();
  assert.equal(toolbar.dirty, false);
});

test('before showing another file, unsaved changes are saved, dropped or kept, as the user answers', async () => {
  const { panel, api, writes } = setup();
  const asked = [];
  let answer = 'cancel';
  api.confirmUnsavedChanges = async (name) => { asked.push(name); return answer; };
  panel.open('app.js', '/app.js', 'a');
  assert.equal(await panel.confirmLeave(), true, 'nothing to save: no question');
  assert.deepEqual(asked, []);
  panel.editorView.dispatch({ changes: { from: 0, to: 1, insert: 'ab' } });
  assert.equal(await panel.confirmLeave(), false, 'Cancel stays');
  assert.deepEqual(asked, ['app.js']);
  answer = 'discard';
  assert.equal(await panel.confirmLeave(), true);
  assert.deepEqual(writes, []);
  answer = 'save';
  assert.equal(await panel.confirmLeave(), true);
  assert.deepEqual(writes, [['/app.js', 'ab']]);
});

test('an autosaving viewer saves instead of asking', async () => {
  const { panel, api, writes } = setup({ autosaveMs: 60_000 });
  api.confirmUnsavedChanges = async () => { throw new Error('asked'); };
  panel.open('Note', '/note.md', 'a');
  panel.editorView.dispatch({ changes: { from: 0, to: 1, insert: 'ab' } });
  assert.equal(await panel.confirmLeave(), true);
  assert.deepEqual(writes, [['/note.md', 'ab']]);
});

test('a change on disk is put in place when nothing is unsaved, and asked about when something is', async () => {
  const { panel, api, context, toolbar } = setup();
  const set = [];
  context.window.cmSetText = (view, text) => { set.push(text); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); return true; };
  let disk = 'a';
  api.readFileForPanel = async () => ({ ok: true, content: disk });
  panel.open('Code', '/app.js', 'a');
  disk = 'from disk';
  await panel._reloadFromDisk();
  assert.deepEqual(set, ['from disk'], 'reloaded in place (keeping the cursor)');
  assert.equal(panel.getContent(), 'from disk');
  assert.equal(panel.isDirty(), false);
  // Unsaved changes: never overwritten, a question instead.
  panel.editorView.dispatch({ changes: { from: 0, to: 9, insert: 'mine' } });
  disk = 'from disk again';
  await panel._reloadFromDisk();
  assert.equal(panel.getContent(), 'mine');
  assert.equal(panel.conflictEl.hidden, false);
  assert.equal(toolbar.el.afterSibling, panel.conflictEl, 'the question sits under the toolbar');
  // Reload takes the disk; the question goes.
  panel._applyDiskContent(panel._diskContent);
  assert.equal(panel.getContent(), 'from disk again');
  assert.equal(panel.conflictEl.hidden, true);
  assert.equal(panel.isDirty(), false);
  // The disk saying what the editor has (its own save) is no question.
  panel.editorView.dispatch({ changes: { from: 0, to: 15, insert: 'saved' } });
  disk = 'saved';
  await panel._reloadFromDisk();
  assert.equal(panel.conflictEl.hidden, true);
  assert.equal(panel.isDirty(), false);
});

test('the text given back and compared keeps the file\'s line breaks (cmGetText)', () => {
  const { panel, context } = setup();
  // As the editor does: its lines split on any break, given back with the file's CRLF.
  context.window.cmGetText = view => view.state.doc.toString().replace(/\r?\n/g, '\r\n');
  panel.open('Win', '/win.txt', 'a\r\nb');
  assert.equal(panel.getContent(), 'a\r\nb');
  assert.equal(panel.isDirty(), false);
});

test('Cmd/Ctrl+F where no field has the focus opens the find bar of the viewer shown', () => {
  const { panel, context, documentListeners } = setup();
  const opened = [];
  context.window.cmOpenSearch = (view, opts) => { opened.push(opts); return true; };
  panel.open('Code', '/app.js', 'a');
  Object.assign(panel.container, { isConnected: true, getClientRects: () => [{}], contains: () => false });
  const key = (props) => {
    const event = { key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: { tagName: 'DIV' }, defaultPrevented: false, ...props };
    event.preventDefault = () => { event.defaultPrevented = true; };
    for (const listener of documentListeners.keydown) listener(event);
    return event;
  };
  assert.equal(key({ key: 'f', code: 'KeyF', metaKey: true }).defaultPrevented, true);
  // (Objects made in the vm's realm: compared as JSON.)
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ replace: false }]);
  assert.equal(key({ key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true }).defaultPrevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(opened.at(-1))), { replace: true });
  // A field keeps its keys; other keys pass.
  assert.equal(key({ key: 'f', code: 'KeyF', metaKey: true, target: { tagName: 'INPUT' } }).defaultPrevented, false);
  assert.equal(key({ key: 'k', code: 'KeyK', metaKey: true }).defaultPrevented, false);
  assert.equal(opened.length, 2);
});

test('the editor\'s keys work from the toolbar: F3, Ctrl+G, Cmd+Shift+O go to the editor', () => {
  const { panel, context } = setup();
  const ran = [];
  context.window.cmRunEditorKeys = (view, event) => { ran.push(event.key); return true; };
  panel.open('Code', '/app.js', 'a');
  panel.editorView.dom = { contains: () => false };
  for (const props of [{ key: 'F3', code: 'F3' }, { key: 'g', code: 'KeyG', ctrlKey: true }, { key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }, { key: 'x', code: 'KeyX' }]) {
    const event = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: { tagName: 'BUTTON', closest: () => null }, defaultPrevented: false, ...props };
    event.preventDefault = () => { event.defaultPrevented = true; };
    panel._onKeyDown(event);
  }
  assert.deepEqual(ran, ['F3', 'g', 'O']);
});

/** The drafts of main (file-drafts.js) as preload.js gives them to a window. */
function draftApi(drafts = new Map()) {
  return {
    drafts,
    getDraft: filePath => drafts.get(filePath) || null,
    setDraft: (filePath, draft) => { drafts.set(filePath, { ...draft }); return { ok: true }; },
    removeDraft: filePath => drafts.delete(filePath),
  };
}

/** A viewer with drafts, and a way to type in it. */
function draftSetup(drafts, options) {
  const made = setup(options);
  const { drafts: kept, ...methods } = draftApi(drafts);
  Object.assign(made.api, methods);
  const type = (text, panel = made.panel) => panel.editorView.dispatch({ changes: { from: 0, to: panel.editorView.state.doc.length, insert: text } });
  return { ...made, drafts: kept, type };
}

test('what is typed goes into the draft after a pause, and comes back after a restart', async () => {
  const first = draftSetup();
  first.panel.open('Code', '/app.js', 'saved');
  first.type('typed');
  assert.equal(first.drafts.size, 0, 'not on every key');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(first.drafts.get('/app.js'), { content: 'typed', base: 'saved' });

  const second = draftSetup(first.drafts);
  second.panel.open('Code', '/app.js', 'saved');
  assert.equal(second.panel.getContent(), 'typed');
  assert.equal(second.panel.isDirty(), true);
  assert.equal(second.toolbar.dirty, true);
});

test('showing another file, or closing the viewer or the window, keeps what is typed', () => {
  const { panel, drafts, type, context } = draftSetup();
  panel.open('A', '/a.js', 'a');
  type('a typed');
  panel.open('B', '/b.js', 'b');
  assert.equal(drafts.get('/a.js').content, 'a typed');
  panel.open('A', '/a.js', 'a');
  assert.equal(panel.getContent(), 'a typed');
  type('a typed more');
  panel.destroy();
  assert.equal(drafts.get('/a.js').content, 'a typed more');

  panel.open('B', '/b.js', 'b');
  type('b typed');
  let held = false;
  context.window.dispatchEvent({ type: 'beforeunload', preventDefault: () => { held = true; } });
  assert.equal(drafts.get('/b.js').content, 'b typed');
  assert.equal(held, false);
});

test('a draft that cannot be written holds the window and says why', () => {
  const { panel, api, type, context } = draftSetup();
  api.setDraft = () => ({ ok: false, error: 'disk full' });
  panel.open('A', '/a.js', 'a');
  type('a typed');
  let held = false;
  context.window.dispatchEvent({ type: 'beforeunload', preventDefault: () => { held = true; } });
  assert.equal(held, true);
  assert.match(panel.noticeEl.textContent, /disk full/);
});

test('saving, undoing back to the file, and Don\'t Save drop the draft', async () => {
  const { panel, api, drafts, type, writes } = draftSetup();
  panel.open('A', '/a.js', 'a');
  type('one');
  panel._flushDraft();
  await panel._save();
  assert.deepEqual(writes, [['/a.js', 'one']]);
  assert.equal(drafts.size, 0);

  type('two');
  panel._flushDraft();
  type('one');
  panel._flushDraft();
  assert.equal(drafts.size, 0);

  type('three');
  panel._flushDraft();
  api.confirmUnsavedChanges = async () => 'discard';
  assert.equal(await panel.confirmLeave(), true);
  assert.equal(drafts.size, 0);
  panel.destroy();
  assert.equal(drafts.size, 0, 'not written again on the way out');
});

test('text typed while a save is under way stays unsaved and kept', async () => {
  let done;
  const { panel, drafts, type } = draftSetup(undefined, { onSave: () => new Promise(resolve => { done = resolve; }) });
  panel.open('A', '/a.js', 'a');
  type('one');
  const saving = panel._save();
  type('one two');
  done({ ok: true });
  await saving;
  assert.equal(panel.isDirty(), true);
  assert.deepEqual(drafts.get('/a.js'), { content: 'one two', base: 'one' });
});

test('a draft of a file that changed since is shown with the question', () => {
  const { panel } = draftSetup(new Map([['/a.js', { content: 'mine', base: 'old' }]]));
  panel.open('A', '/a.js', 'new on disk');
  assert.equal(panel.getContent(), 'mine');
  assert.equal(panel.conflictEl.hidden, false);
  panel._keepMine();
  assert.equal(panel.conflictEl.hidden, true);
});

test('a file that is gone shows its draft, and Save writes it again', async () => {
  const calls = [];
  const { panel, drafts } = draftSetup(new Map([['/gone.js', { content: 'kept', base: 'was' }]]), {
    onSave: async (...args) => { calls.push(args); return { ok: true }; },
  });
  panel.open('Gone', '/gone.js', 'was', { missing: true });
  assert.equal(panel.getContent(), 'kept');
  assert.equal(panel.isDirty(), true);
  assert.match(panel.noticeEl.textContent, /no longer on disk/);
  await panel._save();
  assert.equal(JSON.stringify(calls), JSON.stringify([['/gone.js', 'kept', { create: true }]]));
  assert.equal(drafts.size, 0);
  assert.equal(panel.isDirty(), false);
  assert.equal(panel.noticeEl.hidden, true);
});

test('two viewers of one file show the same unsaved text', async () => {
  const { panel, drafts, type, context } = draftSetup();
  const other = new context.window.ViewerPanel(context.document.createElement(), { language: 'auto', onSave: async () => ({ ok: true }) });
  context.window.cmSetText = (view, text) => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); return true; };
  // The harness gives every viewer the same toolbar.
  panel.open('A', '/a.js', 'a');
  other.open('A', '/a.js', 'a');
  type('typed here');
  panel._flushDraft();
  assert.equal(other.getContent(), 'typed here');
  assert.equal(other.isDirty(), true);
  await other._save();
  assert.equal(panel.isDirty(), false);
  assert.equal(drafts.size, 0);
});

test('a renamed file keeps its unsaved text as unsaved', async () => {
  const { panel, api, drafts, type } = draftSetup();
  api.readFileForPanel = async () => ({ ok: true, content: 'a' });
  panel.open('A', '/a.js', 'a');
  type('typed');
  panel._flushDraft();
  // As main moves the draft along with the file.
  drafts.set('/b.js', drafts.get('/a.js'));
  drafts.delete('/a.js');
  await panel.relocate('B', '/b.js');
  assert.equal(panel.isDirty(), true);
  assert.deepEqual(drafts.get('/b.js'), { content: 'typed', base: 'a' });
});

test('a file moved to the Trash takes its draft with it', () => {
  const { panel, drafts, type } = draftSetup();
  panel.open('A', '/a.js', 'a');
  type('typed');
  panel._flushDraft();
  panel.dispose({ discard: true });
  assert.equal(drafts.size, 0);
});
