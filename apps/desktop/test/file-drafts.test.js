const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDraftStore } = require('../file-drafts');

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'file-drafts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'drafts');
  return { home, dir, store: createDraftStore({ dir }) };
}

test('a draft is found again by a new store, as after a restart', (t) => {
  const { home, dir, store } = setup(t);
  const filePath = path.join(home, 'a.txt');
  assert.equal(store.get(filePath), null);
  assert.deepEqual(store.set(filePath, { content: 'typed', base: 'saved' }), { ok: true });
  store.set(filePath, { content: 'typed more', base: 'saved' });
  const again = createDraftStore({ dir });
  assert.equal(again.get(filePath).content, 'typed more');
  assert.equal(again.get(filePath).base, 'saved');
  assert.deepEqual(again.list().map(d => [d.filePath, d.exists]), [[filePath, false]]);
  fs.writeFileSync(filePath, 'saved');
  assert.equal(again.list()[0].exists, true);
  assert.equal(fs.readdirSync(dir).length, 1, 'no temporary file left');
  again.remove(filePath);
  assert.equal(again.get(filePath), null);
  assert.deepEqual(again.list(), []);
});

test('drafts are readable by their owner alone', { skip: process.platform === 'win32' }, (t) => {
  const { home, dir, store } = setup(t);
  store.set(path.join(home, 'local.env.sh'), { content: 'x', base: '' });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).mode & 0o777, 0o600);
});

test('a path that is not absolute, or content that is not text, is refused', (t) => {
  const { home, store } = setup(t);
  assert.equal(store.set('a.txt', { content: 'x' }).ok, false);
  assert.equal(store.set(path.join(home, 'a.txt'), { content: null }).ok, false);
  assert.equal(store.get('a.txt'), null);
});

test('a draft that cannot be written is remembered until one is, or it is dropped', (t) => {
  const { home, dir, store } = setup(t);
  const filePath = path.join(home, 'a.txt');
  // A file where the folder should be.
  fs.writeFileSync(dir, '');
  const result = store.set(filePath, { content: 'x', base: '' });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.deepEqual(store.failed(), [filePath]);
  fs.rmSync(dir);
  assert.equal(store.set(filePath, { content: 'x', base: '' }).ok, true);
  assert.deepEqual(store.failed(), []);
});

test('drafts follow a file or folder renamed, moved or trashed', (t) => {
  const { home, store } = setup(t);
  const at = (...parts) => path.join(home, ...parts);
  for (const file of [at('src', 'a.js'), at('src', 'deep', 'b.js'), at('src-old', 'c.js')]) {
    store.set(file, { content: file, base: '' });
  }
  const names = () => store.list().map(d => d.filePath).sort();
  store.follow({ ok: true, action: 'rename', filePath: at('src'), newFilePath: at('lib') });
  assert.deepEqual(names(), [at('lib', 'a.js'), at('lib', 'deep', 'b.js'), at('src-old', 'c.js')].sort());
  assert.equal(store.get(at('lib', 'a.js')).content, at('src', 'a.js'));
  store.follow({ ok: true, action: 'move', cancelled: true, filePath: at('lib'), newFilePath: at('x') });
  assert.equal(names().length, 3);
  store.follow({ ok: true, action: 'trash', filePath: at('lib', 'deep') });
  assert.deepEqual(names(), [at('lib', 'a.js'), at('src-old', 'c.js')].sort());
  store.follow({ ok: true, action: 'trash-many', changes: [{ filePath: at('lib') }, { filePath: at('src-old', 'c.js') }] });
  assert.deepEqual(names(), []);
});
