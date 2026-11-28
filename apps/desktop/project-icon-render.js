// project-icon-render.js — a picture sent by a phone, made into the project's
// 256×256 PNG by the window's own code (public/project-icon.js: a canvas reads
// SVG too). It runs in a hidden, sandboxed window with no preload, so a file
// from outside is never opened by a page that can reach the app, and it works
// with the app's window closed.

const path = require('path');
const { iconSourceKind } = require('./public/project-icon');

// Far more than any picture takes; past it the file is one that never ends drawing.
const RENDER_TIMEOUT_MS = 20_000;
const PAGE = path.join(__dirname, 'public', 'project-icon.html');

/** `render(name, base64)` resolves { png } (base64) or { error }. */
function createIconRenderer({ BrowserWindow, timeoutMs = RENDER_TIMEOUT_MS }) {
  return async function renderIcon(name, base64) {
    if (!iconSourceKind(name)) return { error: 'Choose a PNG, JPG or SVG image.' };
    if (typeof base64 !== 'string' || !base64) return { error: 'The file is empty' };
    let win = null;
    let timer = null;
    try {
      win = new BrowserWindow({
        show: false, width: 300, height: 300,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      const draw = async () => {
        await win.loadFile(PAGE);
        // Both go in as JSON strings, so nothing in them is read as code.
        return win.webContents.executeJavaScript(`projectIconFromBase64(${JSON.stringify(String(name))}, ${JSON.stringify(base64)})`);
      };
      const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'The image took too long to read' }), timeoutMs); });
      return await Promise.race([draw(), late]);
    } catch (err) {
      return { error: `Could not read this image: ${err.message}` };
    } finally {
      clearTimeout(timer);
      if (win && !win.isDestroyed()) win.destroy();
    }
  };
}

module.exports = { createIconRenderer };
