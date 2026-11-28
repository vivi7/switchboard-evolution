// file-drafts.js — the text an editor holds that is not saved to its file yet
// (public/viewer-panel.js). One JSON file per draft in <data folder>/drafts,
// named after a hash of the file's path, so it is found again after a restart
// or a crash. Written for the owner alone: a draft of a local.env.sh holds
// what that file holds.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PATH_LENGTH = 4096;

function isFilePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH && path.isAbsolute(value);
}

function createDraftStore({ dir }) {
  // The drafts that could not be written, until one of the same file is, or it is dropped.
  const failed = new Set();
  const fileFor = filePath => path.join(dir, crypto.createHash('sha256').update(filePath).digest('hex') + '.json');

  function read(file) {
    try {
      const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
      return isFilePath(draft?.filePath) && typeof draft.content === 'string' && typeof draft.base === 'string' ? draft : null;
    } catch { return null; }
  }

  function get(filePath) {
    return isFilePath(filePath) ? read(fileFor(filePath)) : null;
  }

  /** `content` is the unsaved text, `base` the file's text the edits started from. */
  function set(filePath, { content, base } = {}) {
    if (!isFilePath(filePath) || typeof content !== 'string') return { ok: false, error: 'Invalid draft' };
    const target = fileFor(filePath);
    const temp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const draft = { filePath, content, base: typeof base === 'string' ? base : '', updatedAt: new Date().toISOString() };
      fs.writeFileSync(temp, JSON.stringify(draft), { mode: 0o600 });
      // In one step: a crash leaves the old draft or the new one, never half of one.
      fs.renameSync(temp, target);
      failed.delete(filePath);
      return { ok: true };
    } catch (err) {
      try { fs.rmSync(temp, { force: true }); } catch {}
      failed.add(filePath);
      return { ok: false, error: err.message };
    }
  }

  function remove(filePath) {
    if (!isFilePath(filePath)) return;
    failed.delete(filePath);
    try { fs.rmSync(fileFor(filePath), { force: true }); } catch {}
  }

  function all() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter(name => name.endsWith('.json')).map(name => read(path.join(dir, name))).filter(Boolean);
  }

  function list() {
    return all()
      .map(({ filePath, updatedAt }) => ({ filePath, updatedAt, exists: fs.existsSync(filePath) }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  /** The drafts of `target`, or of the files under it when it is a folder. */
  function under(target) {
    return isFilePath(target) ? all().filter(d => d.filePath === target || d.filePath.startsWith(target + path.sep)) : [];
  }

  /** A file or folder was renamed or moved: its drafts go with it. */
  function move(from, to) {
    if (!isFilePath(to)) return;
    for (const draft of under(from)) {
      if (set(to + draft.filePath.slice(from.length), draft).ok) remove(draft.filePath);
    }
  }

  /** A file or folder went to the Trash: its unsaved edits are dropped, as the question said. */
  function removeUnder(target) {
    for (const draft of under(target)) remove(draft.filePath);
  }

  /** What a file action of the explorers (file-management.js) means for the drafts. */
  function follow(result) {
    if (!result || result.cancelled) return;
    if (result.action === 'rename' || result.action === 'move') {
      if (result.filePath && result.newFilePath) move(result.filePath, result.newFilePath);
    } else if (result.action === 'trash') {
      removeUnder(result.filePath);
    } else if (result.action === 'trash-many') {
      for (const change of result.changes || []) removeUnder(change.filePath);
    }
  }

  return { get, set, remove, list, move, removeUnder, follow, failed: () => [...failed] };
}

module.exports = { createDraftStore };
