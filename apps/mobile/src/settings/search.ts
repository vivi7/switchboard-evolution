import type { PromptImproverInfo } from '@/prompt-improver/model';
import { searchWhere } from '@/shared/vendor/settings-model';
import { binaryText, knowledgeFields, type KnowledgeBinary, type KnowledgeConfig } from './knowledge';
import { TEMPLATES_AFTER, fieldsFor, terminalEngineNow, type CatalogTabKey } from './model';
import {
  COMPUTER,
  IMPROVER,
  IMPROVER_INTRO,
  TEMPLATES,
  addressesText,
  desktopVersionText,
  harnessHelp,
  mobileVersionText,
  pairedText,
  templateOwner,
} from './rows';
import type { PhoneSettingsTab } from './tabs';
import type { GlobalSettingsInfo } from './types';

// What the Settings search looks through: every row each tab shows, with the
// title and the description it shows, in the tabs' order and from the top of
// each. The tabs draw only the chosen one, so the rows are listed here from
// the same data. What matches, and in which order, is the shared model's
// (searchSettings), as on the desktop.

/** A row of a tab: `id` is its SettingRow's, which a result leads to. */
export interface SettingsEntry {
  tab: PhoneSettingsTab;
  id: string;
  title: string;
  description: string;
  where: string;
}

/** What the Computer tab shows of the paired computer: never its keys. */
export interface ComputerInfo {
  desktop: { addresses: string[]; port: number; pairedAt: number };
  /** The names of the ways to reach it, when there is a choice. */
  routes: string[];
  /** The computer's answer, while connected. */
  hello: { appVersion: string; deviceName: string } | null;
  /** Offline, the tab offers to reconnect. */
  offline: boolean;
  mobileVersion: string | null;
}

/** What has been read of each tab; a tab whose data is missing gives no rows. */
export interface SettingsSources {
  computer?: ComputerInfo;
  global?: GlobalSettingsInfo;
  binary?: KnowledgeBinary;
  config?: KnowledgeConfig;
  improver?: PromptImproverInfo;
}

type Row = { id: string; title: string; description?: string; section?: string };

export function settingsEntries(tabs: readonly { key: PhoneSettingsTab; label: string }[], sources: SettingsSources): SettingsEntry[] {
  return tabs.flatMap(({ key, label }) => rowsOf(key, sources).map(({ id, title, description = '', section = '' }) => (
    { tab: key, id, title, description, where: searchWhere(label, section) }
  )));
}

function rowsOf(tab: PhoneSettingsTab, sources: SettingsSources): Row[] {
  switch (tab) {
    case 'computer': return sources.computer ? computerRows(sources.computer) : [];
    case 'application':
    case 'agents':
    case 'editor': return sources.global ? catalogRows(tab, sources.global) : [];
    case 'knowledge': return sources.binary ? knowledgeRows(sources.binary, sources.config) : [];
    case 'improver': return sources.improver ? improverRows(sources.improver) : [];
    default: return [];
  }
}

function computerRows({ desktop, routes, hello, offline, mobileVersion }: ComputerInfo): Row[] {
  const rows: (Row | false)[] = [
    routes.length > 1 && { id: 'route', title: COMPUTER.route, description: routes.join(', ') },
    { id: 'desktop-version', title: COMPUTER.desktopVersion, description: desktopVersionText(hello?.appVersion) },
    { id: 'mobile-version', title: COMPUTER.mobileVersion, description: mobileVersionText(mobileVersion) },
    { id: 'source', title: COMPUTER.source, description: COMPUTER.sourceAddress },
    !!hello && { id: 'device', title: COMPUTER.device, description: hello.deviceName },
    { id: 'addresses', title: COMPUTER.addresses, description: addressesText(desktop) },
    { id: 'paired', title: COMPUTER.paired, description: pairedText(desktop) },
    offline && { id: 'reconnect', title: COMPUTER.reconnect },
    { id: 'pair-again', title: COMPUTER.pairAgain },
    { id: 'forget', title: COMPUTER.forget },
  ];
  return rows.filter((row): row is Row => !!row);
}

function catalogRows(tab: CatalogTabKey, info: GlobalSettingsInfo): Row[] {
  return fieldsFor(tab).flatMap(({ section, fields }) => fields.flatMap((field): Row[] => {
    // A switch per CLI, each with its own row.
    if (field.kind === 'harnesses') {
      return info.options.harnesses.map((h) => ({ id: `harness:${h.id}`, title: h.label, description: harnessHelp(h.id), section }));
    }
    const help = field.key === 'terminalEngine' ? `${field.help} ${terminalEngineNow(info.options.terminalEngine)}` : field.help;
    const row = { id: field.key, title: field.label, description: help, section };
    if (field.key !== TEMPLATES_AFTER) return [row];
    return [row, { id: 'templates', title: TEMPLATES.label, description: `${TEMPLATES.help} ${info.options.templatesDir || TEMPLATES.none}`, section }];
  }));
}

function knowledgeRows(binary: KnowledgeBinary, config: KnowledgeConfig | undefined): Row[] {
  const text = binaryText(binary);
  const program = { id: 'program', title: 'codebase-memory-mcp', description: [text.summary, text.problem, text.newer, text.path].filter(Boolean).join(' · ') };
  // CBM's settings show only while the program is there and new enough.
  if (!binary.found?.ok || !config) return [program];
  return [program, ...knowledgeFields(config.keys).map((field) => ({ id: field.key, title: field.label, description: field.help }))];
}

function improverRows({ settings }: PromptImproverInfo): Row[] {
  const custom = !!settings.template;
  const row = (id: keyof typeof IMPROVER, description = ''): Row => ({ id, title: IMPROVER[id].label, description });
  return [
    row('enabled', IMPROVER_INTRO),
    row('confirm', IMPROVER.confirm.help),
    row('engine', IMPROVER.engine.help),
    row('context'),
    row('turns', IMPROVER.turns.help),
    row('models', IMPROVER.models.help),
    row('timeout', IMPROVER.timeout.help),
    row('template', `${templateOwner(custom)}. ${IMPROVER.template.help}`),
    ...(custom ? [row('reset')] : []),
  ];
}
