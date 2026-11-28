// project-icons.js — the pictures of projects, kept in the data folder as
// project-icons/<projectId>-<version>.png. The window makes the 256×256 PNG
// (public/project-icon.js); here it is checked, written, read and removed. The
// version is the hash of the picture, kept in projects.icon: a new picture is a
// new file name and a new version, so no window and no phone shows an old one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROJECT_ICON_SIZE } = require('./public/project-icon');

// A 256 × 256 PNG is at most about 260 KB; anything far past that is not one.
const MAX_ICON_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VERSION_RE = /^[0-9a-f]{16}$/;

/** The bytes of a base64 PNG of the icon's size, or { error }. */
function decodeIcon(base64) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_ICON_BYTES / 3) * 4) return { error: 'The icon is not a valid image' };
  const bytes = Buffer.from(base64, 'base64');
  // Signature, then the IHDR chunk: its width and height are at bytes 16 and 20.
  const isPng = bytes.length > 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('latin1', 12, 16) === 'IHDR';
  if (!isPng || bytes.readUInt32BE(16) !== PROJECT_ICON_SIZE || bytes.readUInt32BE(20) !== PROJECT_ICON_SIZE) {
    return { error: `The icon must be a ${PROJECT_ICON_SIZE} × ${PROJECT_ICON_SIZE} PNG` };
  }
  return { bytes };
}

const iconName = (projectId, version) => `${projectId}-${version}.png`;

/** Where a project's picture is, or null when it has none or the file is gone. */
function findIcon(dir, projectId, version) {
  if (!VERSION_RE.test(String(version || ''))) return null;
  const file = path.join(dir, iconName(projectId, version));
  return fs.existsSync(file) ? file : null;
}

/** Writes the picture and returns its version. */
function writeIcon(dir, projectId, bytes) {
  const version = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, iconName(projectId, version));
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, file);
  return version;
}

/** Removes a project's pictures, but for the version to keep. */
function removeIcons(dir, projectId, keep = null) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const prefix = `${projectId}-`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.png')) continue;
    const version = name.slice(prefix.length, -'.png'.length);
    if (!VERSION_RE.test(version) || version === keep) continue;
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

module.exports = { decodeIcon, findIcon, writeIcon, removeIcons };
