import { describe, expect, it } from '@jest/globals';

import { groupTools, type ChatRow } from '../chat-groups';
import { homeShort, isFolderPath, localLinkPath, looksLikePath, planOf, planTitle, stripLocation, toolFilePath } from '../file-refs';
import type { ChatItem } from '../transcript';

type Tool = Extract<ChatItem, { kind: 'tool' }>;
const tool = (id: string, name: string, input: unknown, result?: string): Tool => ({ kind: 'tool', id, name, summary: id, input, ...(result !== undefined ? { result } : {}) });

describe('paths in a message', () => {
  it('takes `code` that names a file for a path', () => {
    for (const text of [
      'src/remote/pairing.ts:25-63', 'client.ts:84', 'remote-server.js', 'main.js:1546-1592', 'package.json', 'README.md',
      '~/.claude/plans/brave-otter.md', './scripts/build.sh', '../switchboard/remote-api.js', '/Users/me/code/app/index.tsx',
      '.env', '.gitignore', 'Makefile', 'src/App.tsx#L12-L30', '@/components/ChatView.tsx', '~/.zshrc',
    ]) expect([text, looksLikePath(text)]).toEqual([text, true]);
  });

  it('leaves code, commands, addresses and versions alone', () => {
    for (const text of [
      'useState', 'pairingLink()', 'safeStorage', '0.0.0.0', 'v1.2.3', '/compact', '/plan', 'ws://${host}:${port}',
      'https://example.com/a.md', 'npm run lint', 'origin/main', 'feat/x', 'a//b.ts', '*.md', 'process.env', 'e.g.', '..', '~',
    ]) expect([text, looksLikePath(text)]).toEqual([text, false]);
  });

  it('drops the line a path points at', () => {
    expect(stripLocation('src/a.ts:12')).toBe('src/a.ts');
    expect(stripLocation('src/a.ts:12-30')).toBe('src/a.ts');
    expect(stripLocation('src/a.ts:12:5')).toBe('src/a.ts');
    expect(stripLocation('src/a.ts#L12-L30')).toBe('src/a.ts');
    expect(stripLocation('src/a.ts')).toBe('src/a.ts');
  });

  it('opens links to files and leaves web and mail links to the browser', () => {
    expect(localLinkPath('src/components/ChatView.tsx#L12')).toBe('src/components/ChatView.tsx');
    expect(localLinkPath('file:///Users/me/My%20Plan.md')).toBe('/Users/me/My Plan.md');
    expect(localLinkPath('/Users/me/a.md')).toBe('/Users/me/a.md');
    expect(localLinkPath('https://docs.expo.dev')).toBeNull();
    expect(localLinkPath('mailto:a@b.c')).toBeNull();
    expect(localLinkPath('#section')).toBeNull();
    expect(localLinkPath('guide.md#the-cluster')).toBe('guide.md');
    expect(localLinkPath('docs/my%20file.md#setup')).toBe('docs/my file.md');
    expect(localLinkPath('README.md:3')).toBe('README.md');
    expect(localLinkPath('')).toBeNull();
  });

  it('shortens the home folder to ~', () => {
    expect(homeShort('/Users/alice/.claude/plans/x.md')).toBe('~/.claude/plans/x.md');
    expect(homeShort('/home/ana/x.md')).toBe('~/x.md');
    expect(homeShort('/opt/x.md')).toBe('/opt/x.md');
  });
});

describe('the file of a tool', () => {
  it('is the file a tool read or changed', () => {
    expect(toolFilePath('Read', { file_path: '/code/a.ts', limit: 20 })).toBe('/code/a.ts');
    expect(toolFilePath('Write', { file_path: '/Users/me/.claude/plans/x.md', content: '# X' })).toBe('/Users/me/.claude/plans/x.md');
    expect(toolFilePath('NotebookEdit', { notebook_path: '/code/n.ipynb' })).toBe('/code/n.ipynb');
    // Codex's arguments come as JSON text.
    expect(toolFilePath('read_file', '{"path":"/code/b.rs"}')).toBe('/code/b.rs');
  });

  it('is none for a search or a command', () => {
    expect(toolFilePath('Grep', { pattern: 'x', path: '/code' })).toBeNull();
    expect(toolFilePath('Bash', { command: 'ls' })).toBeNull();
    expect(toolFilePath('Read', null)).toBeNull();
  });
});

describe('a folder a tool names', () => {
  it('is spelled with a trailing slash', () => {
    expect(isFolderPath('/code/src/')).toBe(true);
    expect(isFolderPath('src\\')).toBe(true);
    expect(isFolderPath('/code/src/app.ts')).toBe(false);
    expect(isFolderPath('/code/src/app.ts:12')).toBe(false);
  });
});

describe('the plan of plan mode', () => {
  const plan = '# Switchboard ⇄ mobile via Cloudflare Tunnel\n\n## Context\nToday the phone…';
  const file = '/Users/me/.claude/plans/cloudflare-peppy-wozniak.md';

  it('comes from ExitPlanMode: its text, its file and its title', () => {
    expect(planOf(tool('t', 'ExitPlanMode', { plan, planFilePath: file }))).toEqual({ text: plan, file, title: 'Switchboard ⇄ mobile via Cloudflare Tunnel' });
    expect(planOf(tool('t', 'ExitPlanMode', { plan }))).toEqual({ text: plan, file: null, title: 'Switchboard ⇄ mobile via Cloudflare Tunnel' });
    expect(planOf(tool('t', 'ExitPlanMode', { planFilePath: file }))?.title).toBe('cloudflare-peppy-wozniak');
  });

  it('is none for an ExitPlanMode without a plan, or another tool', () => {
    expect(planOf(tool('t', 'ExitPlanMode', {}))).toBeNull();
    expect(planOf(tool('t', 'Write', { file_path: file, content: plan }))).toBeNull();
    expect(planOf({ kind: 'user', id: 'u', text: plan })).toBeNull();
  });

  it('is titled by its first heading, or its first line', () => {
    expect(planTitle('Intro line\n# The heading\n')).toBe('The heading');
    expect(planTitle('\n\n## Only a subheading\n')).toBe('Only a subheading');
    expect(planTitle('Plain first line\nmore')).toBe('Plain first line');
    expect(planTitle('')).toBe('');
  });

  it('stays a row of its own between tool calls, and runs while it waits for an answer', () => {
    const shape = (row: ChatRow) => (row.kind === 'tools' ? `tools(${row.items.map((i) => i.id).join(',')})` : row.kind === 'item' ? `${row.item.id}${row.running ? '*' : ''}` : row.kind);
    const items: ChatItem[] = [tool('r1', 'Read', { file_path: '/a' }, 'x'), tool('r2', 'Read', { file_path: '/b' }, 'x'), tool('w', 'Write', { file_path: file }, 'ok'), tool('p', 'ExitPlanMode', { plan, planFilePath: file })];
    expect(groupTools(items).map(shape)).toEqual(['tools(r1,r2,w)', 'p*']);
  });
});
