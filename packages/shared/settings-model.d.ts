// Types for settings-model.js, next to this file.

export type TabKey = 'computer' | 'application' | 'agents' | 'editor' | 'knowledge' | 'improver';
export interface Tab { key: TabKey; label: string }

export type FieldKind = 'bool' | 'int' | 'text' | 'path' | 'choice' | 'color' | 'harnesses' | 'editorPrefs';

export interface FieldChoice { value: string | null; label: string; desc?: string }

export interface SettingField {
  key: string;
  tab: Exclude<TabKey, 'computer'>;
  section: string;
  kind: FieldKind;
  label: string;
  help: string;
  default: unknown;
  /** A folder's own settings can override it (null there = use the global one). */
  folder: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  /** For shellProfile these are only 'auto': the rest come from the computer. */
  choices?: FieldChoice[];
}

export type EditorPrefName = 'minimap' | 'stickyScroll' | 'whitespace' | 'vim';
export type EditorPrefs = Record<EditorPrefName, boolean>;

export interface EditorPrefInfo { name: EditorPrefName | 'languageServers'; label: string; help: string; fallback: boolean }
export interface ThemeChoice { value: string; label: string }
export interface AccentPreset { color: string; label: string }

export interface KnowledgeConfigField {
  key: string;
  label: string;
  help: string;
  /** A free number rather than a switch or a list. */
  number?: boolean;
  /** A limit CBM can switch off. */
  limit?: boolean;
}

export interface PatchContext { harnessIds?: string[]; shellProfileIds?: string[] }
export type PatchResult = { ok: true; patch: Record<string, unknown> } | { ok: false; error: string };

export const DESKTOP_TABS: readonly Tab[];
export const PHONE_TABS: readonly Tab[];
export const FIELDS: readonly SettingField[];
export const EDITOR_PREFS: readonly EditorPrefInfo[];
export const TERMINAL_THEME_CHOICES: readonly ThemeChoice[];
export const ACCENT_DEFAULT: string;
export const ACCENT_PRESETS: readonly AccentPreset[];
export const KNOWLEDGE_CONFIG_FIELDS: readonly KnowledgeConfigField[];
export const KNOWLEDGE_SOURCE_LABELS: Readonly<Record<string, string>>;

export function validateGlobalPatch(patch: unknown, ctx?: PatchContext): PatchResult;
export function validateFolderPatch(patch: unknown): PatchResult;
export function effectiveGlobalValues(stored: Record<string, unknown> | null | undefined, appDefaults: Record<string, unknown> | null | undefined): Record<string, unknown>;
/** The patch for one edited field, or null when the (trimmed) value is the saved one. */
export function changedPatch(key: string, value: unknown, saved: unknown): Record<string, unknown> | null;
export function editorPrefsSync(
  storedGlobal: { editorPrefs?: Partial<EditorPrefs> } | null | undefined,
  current: Partial<EditorPrefs>,
): { migrate: EditorPrefs | null; apply: Partial<EditorPrefs> };

/** A setting the search looks through. */
export interface SearchableSetting { title: string; description: string }
export interface SearchFound<T> { titles: T[]; descriptions: T[] }

export const SEARCH_GROUPS: readonly { key: 'titles' | 'descriptions'; label: string }[];
/** The title matches, then the settings that need their description to match; each in the order given. */
export function searchSettings<T extends SearchableSetting>(entries: readonly T[], query: string): SearchFound<T>;
/** `text` in pieces, `match` true on the ones that are a word of `query`. */
export function searchParts(text: string, query: string): { text: string; match: boolean }[];
export function searchWhere(tab: string, section: string): string;
export function searchStatus(query: string, count: number): string;
