const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_OPENED_FILES, normalizeOpenedFiles, addOpened, removeOpened, setPinned, movePinned,
  setProjectPinned, movePinnedProject,
  displayFolder, describeFile, describeOpenedFiles, existingFilePath, checkDroppedPaths,
} = require('../opened-files');

const A = path.resolve('/demo/notes/a.md');
const B = path.resolve('/demo/notes/b.ts');
const C = path.resolve('/demo/other/c.png');
const T1 = new Date('2026-01-01T10:00:00.000Z');
const T2 = new Date('2026-01-02T10:00:00.000Z');

test('normalizeOpenedFiles keeps only absolute paths, once each', () => {
  const state = normalizeOpenedFiles({
    opened: [
      { filePath: A, openedAt: T1.toISOString() },
      { filePath: 'relative/x.md', openedAt: T1.toISOString() },
      { filePath: A, openedAt: T2.toISOString() },
      { filePath: B, openedAt: 'not a date' },
      null,
    ],
    pinned: [B, B, 'relative', 42, C],
  });
  assert.deepEqual(state.opened.map(e => e.filePath), [A, B]);
  assert.equal(state.opened[0].openedAt, T1.toISOString());
  assert.equal(state.opened[1].openedAt, new Date(0).toISOString());
  assert.deepEqual(state.pinned, [B, C]);
});

test('normalizeOpenedFiles turns anything else into an empty list', () => {
  for (const value of [null, undefined, 'x', 3, [], { opened: 'x', pinned: {} }]) {
    assert.deepEqual(normalizeOpenedFiles(value), { opened: [], pinned: [], pinnedProjects: [] });
  }
});

test('addOpened puts the files on top, in the order given, without repeats', () => {
  let state = addOpened(null, [A], T1);
  state = addOpened(state, [B, C, B, 'relative'], T2);
  assert.deepEqual(state.opened.map(e => e.filePath), [B, C, A]);
  assert.equal(state.opened[0].openedAt, T2.toISOString());
  // Opening A again brings it back to the top with the new time.
  state = addOpened(state, [A], new Date('2026-01-03T00:00:00.000Z'));
  assert.deepEqual(state.opened.map(e => e.filePath), [A, B, C]);
  assert.equal(state.opened[0].openedAt, '2026-01-03T00:00:00.000Z');
});

test('addOpened keeps the newest files up to the limit, and every pinned one', () => {
  const paths = Array.from({ length: MAX_OPENED_FILES + 5 }, (_, i) => path.resolve(`/demo/many/f${i}.txt`));
  let state = { opened: [], pinned: [] };
  // The oldest file is pinned: it stays although the list is full.
  state = addOpened(state, [paths[0]], T1);
  state = setPinned(state, paths[0], true);
  for (const p of paths.slice(1)) state = addOpened(state, [p], T2);
  assert.equal(state.opened.length, MAX_OPENED_FILES);
  assert.equal(state.opened[0].filePath, paths[paths.length - 1]);
  assert.ok(state.opened.some(e => e.filePath === paths[0]));
  assert.ok(!state.opened.some(e => e.filePath === paths[1]));
});

test('removeOpened forgets the file and its pin', () => {
  let state = addOpened(null, [A, B], T1);
  state = setPinned(state, A, true);
  state = setPinned(state, C, true);
  state = removeOpened(state, A);
  assert.deepEqual(state.opened.map(e => e.filePath), [B]);
  assert.deepEqual(state.pinned, [C]);
});

test('setPinned adds at the end, once, and unpins', () => {
  let state = setPinned(null, A, true);
  state = setPinned(state, B, true);
  state = setPinned(state, A, true);
  assert.deepEqual(state.pinned, [A, B]);
  state = setPinned(state, A, false);
  assert.deepEqual(state.pinned, [B]);
  assert.deepEqual(setPinned(state, 'relative', true).pinned, [B]);
});

test('movePinned moves within the pinned files and clamps at both ends', () => {
  let state = { opened: [], pinned: [A, B, C] };
  assert.deepEqual(movePinned(state, C, 0).pinned, [C, A, B]);
  assert.deepEqual(movePinned(state, A, 1).pinned, [B, A, C]);
  assert.deepEqual(movePinned(state, A, 99).pinned, [B, C, A]);
  assert.deepEqual(movePinned(state, C, -3).pinned, [C, A, B]);
  assert.deepEqual(movePinned(state, path.resolve('/demo/none.md'), 0).pinned, [A, B, C]);
  assert.deepEqual(movePinned(state, B, 'x').pinned, [A, B, C]);
});

test('setProjectPinned adds at the end, once, and unpins', () => {
  let state = setProjectPinned(null, '-demo-app', true);
  state = setProjectPinned(state, '-demo-site', true);
  state = setProjectPinned(state, '-demo-app', true);
  assert.deepEqual(state.pinnedProjects, ['-demo-app', '-demo-site']);
  state = setProjectPinned(state, '-demo-app', false);
  assert.deepEqual(state.pinnedProjects, ['-demo-site']);
  for (const key of ['', null, 42]) assert.deepEqual(setProjectPinned(state, key, true).pinnedProjects, ['-demo-site']);
});

test('movePinnedProject moves within the pinned projects and clamps at both ends', () => {
  const state = { pinnedProjects: ['a', 'b', 'c'] };
  assert.deepEqual(movePinnedProject(state, 'c', 0).pinnedProjects, ['c', 'a', 'b']);
  assert.deepEqual(movePinnedProject(state, 'a', 99).pinnedProjects, ['b', 'c', 'a']);
  assert.deepEqual(movePinnedProject(state, 'x', 0).pinnedProjects, ['a', 'b', 'c']);
});

test('changes to the files keep the pinned projects', () => {
  let state = setProjectPinned(null, '-demo-app', true);
  state = addOpened(state, [A, B], T1);
  state = setPinned(state, A, true);
  state = movePinned(state, A, 0);
  state = removeOpened(state, B);
  assert.deepEqual(state.pinnedProjects, ['-demo-app']);
  assert.deepEqual(describeOpenedFiles(state).pinnedProjects, ['-demo-app']);
});

test('displayFolder shows the home folder as ~', () => {
  const home = path.resolve('/demo/home');
  assert.equal(displayFolder(path.join(home, 'docs', 'a.md'), home), `~${path.sep}docs`);
  assert.equal(displayFolder(path.join(home, 'a.md'), home), '~');
  assert.equal(displayFolder(path.resolve('/demo/homework/a.md'), home), path.resolve('/demo/homework'));
  assert.equal(displayFolder(A, ''), path.dirname(A));
});

test('describeFile says whether the file is still there', () => {
  const mtime = new Date('2026-02-01T00:00:00.000Z');
  const statSync = (p) => {
    if (p === A) return { isFile: () => true, mtime };
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  assert.deepEqual(describeFile(A, { statSync }), {
    filePath: A, filename: 'a.md', displayPath: path.dirname(A), modified: mtime.toISOString(), exists: true,
  });
  assert.equal(describeFile(B, { statSync }).exists, false);
  assert.equal(describeFile(B, { statSync }).modified, null);
});

test('describeOpenedFiles describes the opened and the pinned files', () => {
  const statSync = () => ({ isFile: () => true, mtime: T2 });
  const state = setPinned(addOpened(null, [A], T1), C, true);
  const described = describeOpenedFiles(state, { statSync });
  assert.deepEqual(described.opened.map(f => [f.filename, f.openedAt, f.exists]), [['a.md', T1.toISOString(), true]]);
  assert.deepEqual(described.pinned.map(f => f.filename), ['c.png']);
});

test('checkDroppedPaths keeps the files and turns the rest away', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-opened-'));
  try {
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'hello');
    const missing = path.join(dir, 'gone.txt');
    const { files, rejected } = checkDroppedPaths([file, dir, missing, 'relative.txt', file]);
    assert.deepEqual(files, [file]);
    assert.deepEqual(rejected.map(r => r.reason), ['Folders cannot be opened', 'File not found', 'Not an absolute path']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('existingFilePath accepts only an absolute path to a file that is there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-opened-'));
  try {
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, '<p>hi</p>');
    assert.equal(existingFilePath(file), file);
    assert.equal(existingFilePath(dir), null);
    assert.equal(existingFilePath(path.join(dir, 'gone.html')), null);
    assert.equal(existingFilePath('page.html'), null);
    assert.equal(existingFilePath(null), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
