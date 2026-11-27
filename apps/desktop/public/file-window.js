// A file in a window of its own (main.js openFileWindow):
// file-window.html?file=<absolute path>. The editor of the sidebar's Files tab
// for that file alone: edit and save, preview, open elsewhere, and the pin
// that keeps the window above the others (tool-window.js).
// Uses ViewerPanel (viewer-panel.js) and openUnsupportedFile (file-actions.js).

(async () => {
  const filePath = new URLSearchParams(location.search).get('file') || '';
  const name = filePath.split(/[\\/]/).pop() || 'File';
  document.title = name;

  const host = document.getElementById('file-window');
  const panel = new ViewerPanel(host, {
    copyPath: true, copyContent: true, language: 'auto', storageKey: 'markdownPreviewMode',
    onSave: (path, content) => window.api.saveFileForPanel(path, content),
    // This window stays its file's: a linked file opens in a window of its own.
    openLinked: (filePath) => window.api.openFileWindow(filePath),
  });
  // The pin closes the toolbar's row of buttons.
  const pin = document.getElementById('tool-window-pin');
  const controls = panel.toolbar.el.querySelector('.viewer-toolbar-controls') || panel.toolbar.el;
  if (pin) controls.appendChild(pin);

  const showMessage = (text) => {
    const message = document.createElement('div');
    message.className = 'plans-empty file-window-message';
    message.textContent = text;
    host.appendChild(message);
  };

  let result;
  try { result = await window.api.readFileForPanel(filePath); } catch (err) { result = { ok: false, error: err.message }; }
  if (await openUnsupportedFile(result, filePath)) {
    panel.toolbar.setTitle(name);
    panel.toolbar.setPath(filePath);
    showMessage('This file has no preview here: it opened in its default application.');
    return;
  }
  if (!result?.ok) {
    panel.toolbar.setTitle(name);
    panel.toolbar.setPath(filePath);
    showMessage(result?.error || 'Unable to open the file.');
    return;
  }
  panel.open(name, filePath, result.content || '', result);
})();
