// Links in a Markdown file, read the same way by the desktop's preview and the
// phone's: what an address points at, and the anchors GitHub gives headings.
(function (root) {
  // The lines a path may point at: "#L12", "#L12-L30", "#L12C3".
  const LINES = /^#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i;
  // "README.md:12" reads like a scheme and is a path with a line.
  const PATH_AND_LINE = /^[^:/\\]+:\d+(?:[-:]\d+)?(?:#|$)/;

  function decode(text) {
    try { return decodeURIComponent(text); } catch { return text; }
  }

  /**
   * What a link's address points at:
   *   { kind: 'anchor', anchor }       a section of this file ("#setup")
   *   { kind: 'file', path, anchor }   a file or folder on the computer; `path` is
   *                                    decoded and keeps a line it names ("a.js:12",
   *                                    "a.js#L12"), `anchor` is the section ("a.md#setup")
   *   { kind: 'external', url }        any other scheme: web, mail
   *   { kind: 'none' }                 nothing to open
   */
  function parseMarkdownLink(href) {
    let url = String(href || '').trim();
    if (!url) return { kind: 'none' };
    if (url.startsWith('#')) return { kind: 'anchor', anchor: decode(url.slice(1)) };
    if (url.startsWith('//')) return { kind: 'external', url };
    if (/^file:/i.test(url)) {
      const local = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(url);
      if (!local) return { kind: 'none' };
      // "file:///C:/x" is "C:/x".
      url = local[1].replace(/^\/(?=[a-z]:[/\\])/i, '');
    } else if (/^[a-z][a-z0-9+.-]+:/i.test(url) && !PATH_AND_LINE.test(url)) {
      return { kind: 'external', url };
    }
    const hash = url.indexOf('#');
    const fragment = hash < 0 ? '' : url.slice(hash);
    const lines = LINES.test(fragment) ? fragment : '';
    const path = decode(hash < 0 ? url : url.slice(0, hash)) + lines;
    if (!path) return { kind: 'none' };
    return { kind: 'file', path, anchor: lines ? '' : decode(fragment.slice(1)) };
  }

  /** A heading's anchor as GitHub writes it: "2. Set it up!" is "2-set-it-up". */
  function headingSlug(text) {
    return String(text || '').trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
  }

  /** The anchors of a file's headings, in order; a repeated one ends in -1, -2… */
  function headingSlugs(texts) {
    const taken = new Set();
    return (texts || []).map((text) => {
      const base = headingSlug(text);
      let slug = base;
      for (let n = 1; taken.has(slug); n++) slug = `${base}-${n}`;
      taken.add(slug);
      return slug;
    });
  }

  const api = { parseMarkdownLink, headingSlug, headingSlugs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MarkdownLinks = api;
})(typeof window !== 'undefined' ? window : globalThis);
