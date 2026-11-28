const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { decodeIcon, findIcon, writeIcon, removeIcons } = require('../project-icons');
const { createIconRenderer } = require('../project-icon-render');
const { PROJECT_ICON_SIZE, iconSourceKind, centerSquare, svgViewBox } = require('../public/project-icon');

/** The start of a PNG, as far as the checks read it: signature and IHDR size. */
function pngHeader(width, height, filler = 0) {
  const bytes = Buffer.alloc(33, filler);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('only a PNG of the icon size is taken', () => {
  const good = pngHeader(PROJECT_ICON_SIZE, PROJECT_ICON_SIZE);
  assert.deepEqual(decodeIcon(good.toString('base64')).bytes, good);
  for (const bad of [
    pngHeader(512, 512).toString('base64'),
    pngHeader(PROJECT_ICON_SIZE, 100).toString('base64'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
    '', undefined, 42, 'A'.repeat(2 * 1024 * 1024),
  ]) {
    assert.match(decodeIcon(bad).error, /icon/, String(bad).slice(0, 40));
  }
});

test('a new picture gets a new file, and the old one goes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-icons-'));
  try {
    const first = writeIcon(dir, 'p1', pngHeader(256, 256, 1));
    const other = writeIcon(dir, 'p1-b', pngHeader(256, 256, 1));
    const second = writeIcon(dir, 'p1', pngHeader(256, 256, 2));
    assert.notEqual(first, second);
    assert.deepEqual(fs.readFileSync(findIcon(dir, 'p1', second)), pngHeader(256, 256, 2));

    removeIcons(dir, 'p1', second);
    assert.equal(findIcon(dir, 'p1', first), null);
    assert.ok(findIcon(dir, 'p1', second));
    assert.ok(findIcon(dir, 'p1-b', other), "another project's picture stays");

    removeIcons(dir, 'p1');
    assert.deepEqual(fs.readdirSync(dir), [`p1-b-${other}.png`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a version that is not one, or a folder not there, finds nothing', () => {
  const dir = path.join(os.tmpdir(), 'project-icons-missing');
  assert.equal(findIcon(dir, 'p1', null), null);
  assert.equal(findIcon(dir, 'p1', '../../etc/passwd'), null);
  assert.equal(findIcon(dir, 'p1', '0123456789abcdef'), null);
  removeIcons(dir, 'p1');
});

test('PNG, JPG and SVG are taken, by their extension', () => {
  assert.equal(iconSourceKind('logo.PNG'), 'png');
  assert.equal(iconSourceKind('photo.jpg'), 'jpeg');
  assert.equal(iconSourceKind('photo.JPEG'), 'jpeg');
  assert.equal(iconSourceKind('drawing.svg'), 'svg');
  for (const name of ['anim.gif', 'photo.webp', 'png', 'logo.png.exe', 'x.constructor', '']) assert.equal(iconSourceKind(name), null, name);
});

test('a picture that is not square is cropped at its centre', () => {
  assert.deepEqual(centerSquare(1000, 400), { x: 300, y: 0, side: 400 });
  assert.deepEqual(centerSquare(300, 801), { x: 0, y: 250.5, side: 300 });
  assert.deepEqual(centerSquare(64, 64), { x: 0, y: 0, side: 64 });
});

test("an SVG's box: its viewBox, else its size, else a browser's default", () => {
  assert.equal(svgViewBox({ viewBox: '0,0, 24 48', width: '100', height: '100' }), '0 0 24 48');
  assert.equal(svgViewBox({ viewBox: null, width: '120px', height: '60' }), '0 0 120 60');
  assert.equal(svgViewBox({ viewBox: '', width: '1in', height: '72pt' }), '0 0 96 96');
  assert.equal(svgViewBox({ viewBox: '0 0 0 10', width: '100%', height: '2em' }), '0 0 300 150');
});

test('the project square shows the picture, else the initials', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
  const identity = source.slice(source.indexOf('// --- Identity ---'), source.indexOf('/**\n * One color per track'));
  const context = vm.createContext({
    escapeHtml: text => String(text),
    escapeAttr: text => String(text).replace(/"/g, '&quot;'),
  });
  vm.runInContext(identity, context);
  const project = { id: 'p1', name: 'Billing Portal', iconUrl: null };
  assert.match(context.markHtml(project), />BP<\/span>$/);
  const withPicture = context.markHtml({ ...project, iconUrl: 'file:///data/project-icons/p1-0123456789abcdef.png' }, 38, 'proj-mark--lg');
  assert.match(withPicture, /class="proj-mark proj-mark--icon proj-mark--lg" style="width:38px;height:38px;"/);
  assert.match(withPicture, /<img src="file:\/\/\/data\/project-icons\/p1-0123456789abcdef\.png" alt="" draggable="false">/);
  assert.doesNotMatch(withPicture, />BP</);
});

/** A hidden window that draws nothing: it answers `answer`, and tells what was asked of it. */
function fakeWindow(answer) {
  const seen = { windows: 0, destroyed: 0, scripts: [], options: null };
  class BrowserWindow {
    constructor(options) { seen.windows++; seen.options = options; this.gone = false; this.webContents = { executeJavaScript: async (script) => { seen.scripts.push(script); return answer(); } }; }
    async loadFile(file) { seen.page = path.basename(file); }
    isDestroyed() { return this.gone; }
    destroy() { this.gone = true; seen.destroyed++; }
  }
  return { BrowserWindow, seen };
}

test("a phone's file is drawn in a hidden window of its own, closed afterwards", async () => {
  const { BrowserWindow, seen } = fakeWindow(() => ({ png: 'UE5H' }));
  const render = createIconRenderer({ BrowserWindow });
  assert.deepEqual(await render('my "logo".svg', 'PHN2Zy8+'), { png: 'UE5H' });
  assert.equal(seen.options.show, false);
  assert.deepEqual(seen.options.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.equal(seen.page, 'project-icon.html');
  assert.deepEqual(seen.scripts, ['projectIconFromBase64("my \\"logo\\".svg", "PHN2Zy8+")']);
  assert.equal(seen.destroyed, 1);
});

test('a file that is not a picture opens no window; a failing or endless one closes it', async () => {
  const refused = fakeWindow(() => ({ png: 'UE5H' }));
  const render = createIconRenderer({ BrowserWindow: refused.BrowserWindow });
  assert.match((await render('notes.txt', 'aGk=')).error, /PNG, JPG or SVG/);
  assert.match((await render('logo.png', '')).error, /empty/);
  assert.equal(refused.seen.windows, 0);

  const failing = fakeWindow(() => { throw new Error('gone'); });
  assert.match((await createIconRenderer({ BrowserWindow: failing.BrowserWindow })('logo.png', 'aGk=')).error, /gone/);
  assert.equal(failing.seen.destroyed, 1);

  const endless = fakeWindow(() => new Promise(() => {}));
  assert.match((await createIconRenderer({ BrowserWindow: endless.BrowserWindow, timeoutMs: 10 })('logo.png', 'aGk=')).error, /too long/);
  assert.equal(endless.seen.destroyed, 1);
});

test("the sidebar's square is a button that changes the picture", () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
  const identity = source.slice(source.indexOf('// --- Identity ---'), source.indexOf('/**\n * One color per track'));
  const context = vm.createContext({
    escapeHtml: text => String(text),
    escapeAttr: text => String(text).replace(/"/g, '&quot;'),
    PICONS: { camera: () => '<svg></svg>' },
  });
  vm.runInContext(identity, context);
  const html = context.markButtonHtml({ id: 'p1', name: 'A "B"', iconUrl: null });
  assert.match(html, /^<button type="button" class="proj-mark-btn"[^>]*aria-label="Change the icon of A &quot;B&quot;"><span class="proj-mark /);
  assert.match(html, /<span class="proj-mark-camera" aria-hidden="true"><svg><\/svg><\/span><\/button>$/);
});
