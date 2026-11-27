// Files the chat mentions, to offer opening them: the plan Claude wrote in
// plan mode (ExitPlanMode carries its text and where it is saved), the file
// a tool read or changed, and paths in a message's `code` or links. The
// computer finds where a path is (locate-file) when one is tapped.

import { parseMarkdownLink } from '@/shared/vendor/markdown-links';

import { inputObject } from './tool-details';
import type { ChatItem } from './transcript';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

// Kinds of file a path in `code` ends in. Without a slash or an extension
// from here, `code` is taken for code: `useState`, `/compact`, `0.0.0.0`.
const EXTENSIONS = new Set([
  'md', 'mdx', 'markdown', 'txt', 'rst', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'plist',
  'csv', 'tsv', 'log', 'lock', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro', 'html', 'htm',
  'css', 'scss', 'sass', 'less', 'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp',
  'hpp', 'cs', 'php', 'lua', 'r', 'dart', 'scala', 'ex', 'exs', 'erl', 'hs', 'sql', 'graphql', 'gql', 'proto', 'sh', 'bash',
  'zsh', 'fish', 'ps1', 'gradle', 'properties', 'tf', 'ipynb', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'patch', 'diff',
]);
const NAMES = new Set(['Makefile', 'Dockerfile', 'Gemfile', 'Procfile', 'LICENSE']);

// "file.ts:12", "file.ts:12-30", "file.ts:12:5", "file.ts#L12-L30".
const LOCATION = /(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)$/;

/** The path without the line it points at. */
export function stripLocation(ref: string): string {
  return ref.replace(LOCATION, '');
}

/** Whether `code` in a message reads as a path to a file: `src/app.ts:12`, `~/.zshrc`, `package.json`. */
export function looksLikePath(text: string): boolean {
  const ref = stripLocation(text.trim());
  if (!ref || ref.length > 400 || !/^[\w@.~+\-/]+$/.test(ref) || ref.includes('//')) return false;
  const name = ref.split('/').pop() || '';
  if (!name || name === '.' || name === '..') return false;
  // Spelled as a path: home, relative to here, or absolute with a folder in it.
  if (/^(?:~|\.{1,2})\//.test(ref)) return true;
  if (ref.startsWith('/') && ref.indexOf('/', 1) > 0) return true;
  if (NAMES.has(name)) return true;
  // A dotfile: .env, .gitignore.
  if (/^\.\w[\w.-]*$/.test(name)) return true;
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1];
  return !!ext && EXTENSIONS.has(ext.toLowerCase()) && /^[\w@+-]/.test(name);
}

/** The path a markdown link points at on the computer, or null for a web or mail link or a section. */
export function localLinkPath(url: string): string | null {
  const link = parseMarkdownLink(url);
  return link.kind === 'file' ? stripLocation(link.path) || null : null;
}

/** The file a tool read or changed, from its input. */
export function toolFilePath(name: string, input: unknown): string | null {
  const value = inputObject(input);
  if (!value) return null;
  const path = value.file_path ?? value.notebook_path ?? (name === 'read_file' || name === 'view_image' ? value.path : undefined);
  return typeof path === 'string' && path ? path : null;
}

/** Whether a path a tool names is spelled as a folder (a trailing slash), not a file: its open button then says so. */
export function isFolderPath(path: string): boolean {
  return /[\\/]$/.test(stripLocation(path.trim()));
}

/** A plan Claude wrote in plan mode: its markdown, where it is saved, and its title. */
export type PlanRef = { text: string; file: string | null; title: string };

/** The first heading of a plan, or its first line. */
export function planTitle(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#\s/.test(line)) ?? lines[0] ?? '';
  const title = heading.replace(/^#+\s*/, '').trim();
  return title.length > 200 ? `${title.slice(0, 200)}…` : title;
}

/** The plan an ExitPlanMode call put up for approval, or null for any other item. */
export function planOf(item: ChatItem): PlanRef | null {
  if (item.kind !== 'tool' || item.name !== 'ExitPlanMode') return null;
  const value = inputObject((item as ToolItem).input);
  const text = typeof value?.plan === 'string' ? value.plan : '';
  const file = typeof value?.planFilePath === 'string' && value.planFilePath ? value.planFilePath : null;
  if (!text.trim() && !file) return null;
  const name = file?.split('/').pop()?.replace(/\.md$/i, '');
  return { text, file, title: planTitle(text) || name || 'Plan' };
}

/** A path with the home folder as ~: /Users/me/.claude/plans/x.md reads ~/.claude/plans/x.md. */
export function homeShort(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, '~');
}
