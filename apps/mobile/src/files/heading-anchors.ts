import type MarkdownIt from 'markdown-it';

import { headingSlugs } from '@/shared/vendor/markdown-links';

/**
 * A markdown-it plugin: each heading gets an `anchor` attribute, the one GitHub
 * gives it, for the links to a section of a file.
 */
export function headingAnchors(md: MarkdownIt) {
  // Before the typographer changes the text the anchor is made from.
  md.core.ruler.after('inline', 'heading_anchors', (state) => {
    const tokens = state.tokens;
    const headings = tokens.flatMap((token, i) => (token.type === 'heading_open' ? [i] : []));
    const texts = headings.map((i) => (tokens[i + 1]?.children ?? [])
      .filter((child) => child.type === 'text' || child.type === 'code_inline')
      .map((child) => child.content)
      .join(''));
    headingSlugs(texts).forEach((anchor, n) => tokens[headings[n]].attrSet('anchor', anchor));
    return true;
  });
}
