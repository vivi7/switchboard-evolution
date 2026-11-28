// project-icon.js — a project's own picture, shown in its square instead of
// the initials. A PNG, JPG or SVG file the user picks becomes a 256×256 PNG,
// cropped at the centre when it is not square. A window draws it (a canvas
// reads SVG too): the app's own for a file picked on the computer, a hidden
// one for a phone's (project-icon-render.js). project-icons.js in main checks
// and keeps the result, and reads PROJECT_ICON_SIZE from here.
(function (root) {
  const PROJECT_ICON_SIZE = 256;
  const PROJECT_ICON_ACCEPT = '.png,.jpg,.jpeg,.svg';
  // Far above any picture meant for an icon; larger ones only cost memory to open.
  const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
  const EXTENSIONS = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', svg: 'svg' };
  // CSS absolute units in pixels. A relative one (%, em) says nothing about the picture.
  const SVG_UNITS = { '': 1, px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };

  /** 'png', 'jpeg' or 'svg' by the file's extension, else null. */
  function iconSourceKind(name) {
    const match = /\.([a-z]+)$/i.exec(String(name || ''));
    const ext = match ? match[1].toLowerCase() : '';
    return Object.hasOwn(EXTENSIONS, ext) ? EXTENSIONS[ext] : null;
  }

  /** The largest square in the middle of a width × height picture. */
  function centerSquare(width, height) {
    const side = Math.min(width, height);
    return { x: (width - side) / 2, y: (height - side) / 2, side };
  }

  function svgLength(value) {
    const match = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(String(value ?? ''));
    if (!match) return null;
    const unit = match[2].toLowerCase();
    const length = Object.hasOwn(SVG_UNITS, unit) ? Number(match[1]) * SVG_UNITS[unit] : 0;
    return length > 0 && Number.isFinite(length) ? length : null;
  }

  /**
   * The viewBox that holds an SVG's whole picture: its own, else its width and
   * height, else the 300 × 150 a browser gives an SVG without a size.
   */
  function svgViewBox({ viewBox, width, height }) {
    const box = String(viewBox ?? '').trim().split(/[\s,]+/).map(Number);
    if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) return box.join(' ');
    return `0 0 ${svgLength(width) || 300} ${svgLength(height) || 150}`;
  }

  /**
   * An SVG's text redrawn on a square of the icon's size: `slice` makes the
   * picture cover it, cropped at the centre, sharp at any original size.
   */
  function squareSvg(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) {
      throw new Error('This file is not a readable SVG image.');
    }
    svg.setAttribute('viewBox', svgViewBox({
      viewBox: svg.getAttribute('viewBox'), width: svg.getAttribute('width'), height: svg.getAttribute('height'),
    }));
    svg.setAttribute('width', String(PROJECT_ICON_SIZE));
    svg.setAttribute('height', String(PROJECT_ICON_SIZE));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    // A size in the style attribute would win over the two above.
    svg.style?.removeProperty('width');
    svg.style?.removeProperty('height');
    return new XMLSerializer().serializeToString(doc);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read this image.'));
      img.src = src;
    });
  }

  /** The picked file as the base64 of a 256 × 256 PNG. Throws with a message to show. */
  async function makeProjectIcon(file) {
    const kind = iconSourceKind(file?.name);
    if (!kind) throw new Error('Choose a PNG, JPG or SVG image.');
    if (file.size > MAX_SOURCE_BYTES) throw new Error('The image is larger than 20 MB.');
    const size = PROJECT_ICON_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    if (kind === 'svg') {
      // A data: URL, which leaves the canvas readable; an SVG shown as an image runs no script.
      const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(squareSvg(await file.text())));
      context.drawImage(img, 0, 0, size, size);
    } else {
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        const { x, y, side } = centerSquare(img.naturalWidth, img.naturalHeight);
        if (!side) throw new Error('Could not read this image.');
        context.drawImage(img, x, y, side, side, 0, 0, size, size);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }

  /**
   * The same for a file's name and base64 content, as the hidden window gets a
   * phone's pick. Resolves { png } or { error }: a thrown message would not
   * cross to main.
   */
  async function projectIconFromBase64(name, base64) {
    try {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      return { png: await makeProjectIcon(new File([bytes], name)) };
    } catch (err) {
      return { error: err.message };
    }
  }

  /** The system's file dialog, on the window that asked. Resolves the file, or null. */
  function pickProjectIconFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = PROJECT_ICON_ACCEPT;
      input.onchange = () => resolve(input.files?.[0] || null);
      input.oncancel = () => resolve(null);
      input.click();
    });
  }

  const api = {
    PROJECT_ICON_SIZE, PROJECT_ICON_ACCEPT, iconSourceKind, centerSquare, svgViewBox,
    squareSvg, makeProjectIcon, projectIconFromBase64, pickProjectIconFile,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
