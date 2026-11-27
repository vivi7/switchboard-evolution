import { describe, expect, it, jest } from '@jest/globals';

import type { PromptImproverInfo } from '@/prompt-improver/model';
import { FIELDS, searchParts, searchSettings, searchStatus } from '@/shared/vendor/settings-model';
import type { KnowledgeBinary, KnowledgeConfig } from '../knowledge';
import { settingsEntries, type ComputerInfo, type SettingsSources } from '../search';
import { settingsTabs } from '../tabs';
import type { GlobalSettingsInfo } from '../types';

// knowledge.ts reads the computer through these, which this test does not.
jest.mock('@/projects/queries', () => ({ act: jest.fn() }));
jest.mock('@/remote/query', () => ({ queryClient: {} }));
jest.mock('@/store/connection', () => ({ useCapability: jest.fn(), useConnection: jest.fn() }));

const tabs = settingsTabs({ global: true, knowledge: true, improver: true });

const computer: ComputerInfo = {
  desktop: { addresses: ['192.0.2.10'], port: 8787, pairedAt: 0 },
  routes: ['Local network'],
  hello: { appVersion: '1.21.0', deviceName: 'Demo phone' },
  offline: false,
  mobileVersion: '1.21.0',
};

const global: GlobalSettingsInfo = {
  values: {
    disabledHarnesses: [],
    permissionMode: null,
    worktree: false,
    worktreeName: '',
    chrome: false,
    addDirs: '',
    codexSandbox: 'workspace-write',
    codexApproval: '',
    codexModel: '',
    preLaunchCmd: '',
    terminalTheme: 'switchboard',
    accentColor: '#8088ff',
    shellProfile: 'auto',
    visibleSessionCount: 5,
    sessionMaxAgeDays: 3,
    terminalEngine: 'hc',
    projectsRoot: '',
    mcpEmulation: false,
    editorPrefs: { minimap: true, stickyScroll: true, whitespace: false, vim: false },
    languageServers: true,
  },
  options: {
    harnesses: [{ id: 'claude', label: 'Claude Code', enabled: true }, { id: 'codex', label: 'Codex', enabled: true }],
    shellProfiles: [],
    terminalEngine: { engine: 'hc', version: '0.6.1', source: 'bundled', path: '/Users/demo/app/herdr-core', session: 'switchboard' },
    templatesDir: '/Users/demo/.switchboard/templates',
  },
};

const binary: KnowledgeBinary = {
  found: { version: '0.8.1', source: 'agents', path: '/Users/demo/.local/bin/codebase-memory-mcp', ok: true },
  minimum: '0.6.0',
  latest: null,
  updateAvailable: false,
  pinned: '0.8.1',
  installDir: '/Users/demo/.switchboard/bin',
  canDownload: true,
};
const config: KnowledgeConfig = { values: { auto_index: 'true' }, keys: { auto_index: 'bool', ui_enabled: 'bool' } };

const improver: PromptImproverInfo = {
  settings: { enabled: true, confirm: true, engine: 'session', context: 'recent', recentTurns: 4, models: { claude: '', codex: '', opencode: '' }, timeoutSec: 120, template: null },
  defaultTemplate: 'Improve it.',
  placeholders: [],
  clis: ['claude'],
};

const all: SettingsSources = { computer, global, binary, config, improver };
const ids = (sources: SettingsSources, tab: string) => settingsEntries(tabs, sources).filter((e) => e.tab === tab).map((e) => e.id);

describe('settingsEntries', () => {
  it('lists the rows tab by tab, in the tabs\' order', () => {
    const order = [...new Set(settingsEntries(tabs, all).map((e) => e.tab))];
    expect(order).toEqual(['computer', 'application', 'agents', 'editor', 'knowledge', 'improver']);
  });

  it('has a row for every field of the shared catalog', () => {
    const found = new Set(settingsEntries(tabs, all).map((e) => e.id));
    // The CLIs have a row each, the Editor's preferences one per preference.
    const missing = FIELDS.filter((f) => f.kind !== 'harnesses' && f.kind !== 'editorPrefs' && !found.has(f.key));
    expect(missing).toEqual([]);
    expect(found).toContain('harness:claude');
    expect(found).toContain('editorPrefs.minimap');
  });

  it('never gives two rows of a tab the same id', () => {
    const keys = settingsEntries(tabs, all).map((e) => `${e.tab}:${e.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('puts Project Templates after Projects Folder, with the folder', () => {
    const rows = settingsEntries(tabs, all);
    const at = rows.findIndex((e) => e.id === 'projectsRoot');
    expect(rows[at + 1]).toMatchObject({ id: 'templates', title: 'Project Templates', where: 'Application' });
    expect(rows[at + 1].description).toContain('/Users/demo/.switchboard/templates');
  });

  it('says which engine runs the sessions beside Terminal Engine', () => {
    const row = settingsEntries(tabs, all).find((e) => e.id === 'terminalEngine');
    expect(row?.description).toContain('Now: herdr-core 0.6.1');
  });

  it('says the tab and the section, once when they are named the same', () => {
    const rows = settingsEntries(tabs, all);
    expect(rows.find((e) => e.id === 'worktree')?.where).toBe('Agents › Claude CLI Options');
    expect(rows.find((e) => e.id === 'editorPrefs.vim')?.where).toBe('Editor');
    expect(rows.find((e) => e.id === 'addresses')?.where).toBe('Computer');
  });

  it('lists the Computer rows the tab shows in its state', () => {
    expect(ids(all, 'computer')).toEqual(['desktop-version', 'mobile-version', 'source', 'device', 'addresses', 'paired', 'pair-again', 'forget']);
    const away = { computer: { ...computer, routes: ['Local network', 'ngrok'], hello: null, offline: true } };
    expect(ids(away, 'computer')).toEqual(['route', 'desktop-version', 'mobile-version', 'source', 'addresses', 'paired', 'reconnect', 'pair-again', 'forget']);
  });

  it('has CBM\'s settings only while the program can be used, and never the Lens', () => {
    expect(ids(all, 'knowledge')).toEqual(['program', 'auto_index']);
    expect(ids({ binary: { ...binary, found: null }, config }, 'knowledge')).toEqual(['program']);
    expect(ids({ binary }, 'knowledge')).toEqual(['program']);
  });

  it('has the reset of the improver prompt only when it is yours', () => {
    expect(ids(all, 'improver')).not.toContain('reset');
    const yours = { improver: { ...improver, settings: { ...improver.settings, template: 'Mine' } } };
    expect(ids(yours, 'improver')).toContain('reset');
  });

  it('leaves out the tabs not shown and the ones not read yet', () => {
    const older = settingsTabs({ global: false, knowledge: false, improver: true });
    expect([...new Set(settingsEntries(older, all).map((e) => e.tab))]).toEqual(['computer', 'improver']);
    expect([...new Set(settingsEntries(tabs, { computer }).map((e) => e.tab))]).toEqual(['computer']);
  });
});

describe('searching the phone\'s settings', () => {
  const rows = settingsEntries(tabs, all);

  it('gives the title matches first, then the description matches, each once', () => {
    const found = searchSettings(rows, 'terminal');
    expect(found.titles.map((e) => e.id)).toEqual(['terminalTheme', 'terminalEngine']);
    expect(found.descriptions.map((e) => e.id)).toEqual(['shellProfile']);
  });

  it('finds the phone\'s own rows too', () => {
    expect(searchSettings(rows, 'forget').titles.map((e) => e.id)).toEqual(['forget']);
    expect(searchSettings(rows, 'time limit').titles.map((e) => e.id)).toEqual(['timeout']);
  });

  it('cuts a text at the words searched for', () => {
    expect(searchParts('Terminal Theme', 'theme')).toEqual([{ text: 'Terminal ', match: false }, { text: 'Theme', match: true }]);
    expect(searchStatus('zzz', searchSettings(rows, 'zzz').titles.length)).toBe('No setting matches “zzz”.');
  });
});
