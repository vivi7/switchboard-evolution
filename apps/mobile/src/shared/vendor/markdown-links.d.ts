// Copied from packages/shared/markdown-links.d.ts by scripts/sync-shared.mjs.
// Do not edit: change it in packages/shared and run npm run sync-shared.

// Types for markdown-links.js, next to this file.

export type MarkdownLink =
  | { kind: 'anchor'; anchor: string }
  | { kind: 'file'; path: string; anchor: string }
  | { kind: 'external'; url: string }
  | { kind: 'none' };

export function parseMarkdownLink(href: string): MarkdownLink;
export function headingSlug(text: string): string;
export function headingSlugs(texts: readonly string[]): string[];
