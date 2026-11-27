// settings-model.js — the catalog of the app's settings, for the desktop
// (its Settings panel and main process) and the phone (its Settings screens).
//
// One list says which settings exist, where they sit (tab and section), what
// they are called, how they are explained, what values they take and which
// of them a folder can override. The panel, the phone and the main process all
// read it, and the checks below are the ones the main process runs on every
// save: a setting is saved as it changes, so a patch holds one field (an
// Editor preference holds one name). Labels and help are the panel's own;
// a test keeps the panel and this file in step. Shared with the phone app
// (scripts/sync-shared.mjs): no DOM, no Node.
(function (root) {
  const SessionConfig = typeof module !== 'undefined' && module.exports ? require('./session-config') : root.SessionConfig;

  // The tabs of the desktop's Settings; the phone has one more at the start:
  // the settings of the app on the phone itself.
  const DESKTOP_TABS = [
    { key: 'application', label: 'Application' },
    { key: 'agents', label: 'Agents' },
    { key: 'editor', label: 'Editor' },
    { key: 'knowledge', label: 'Node Knowledge' },
    { key: 'improver', label: 'Prompt Improver' },
  ];
  const PHONE_TABS = [{ key: 'computer', label: 'Computer' }, ...DESKTOP_TABS];

  // The terminal themes of terminal-themes.js (its keys and labels).
  const TERMINAL_THEME_CHOICES = [
    { value: 'switchboard', label: 'Switchboard' },
    { value: 'ghostty', label: 'Ghostty' },
    { value: 'tokyoNight', label: 'Tokyo Night' },
    { value: 'catppuccinMocha', label: 'Catppuccin Mocha' },
    { value: 'dracula', label: 'Dracula' },
    { value: 'nord', label: 'Nord' },
    { value: 'solarizedDark', label: 'Solarized Dark' },
  ];

  // The accent colours of accent.js.
  const ACCENT_DEFAULT = '#8088ff';
  const ACCENT_PRESETS = [
    { color: ACCENT_DEFAULT, label: 'Indigo (default)' },
    { color: '#5b9dff', label: 'Blue' },
    { color: '#2fc4b2', label: 'Teal' },
    { color: '#5cc46a', label: 'Green' },
    { color: '#e8b23a', label: 'Amber' },
    { color: '#ff8a4c', label: 'Orange' },
    { color: '#f06464', label: 'Red' },
    { color: '#f06aa8', label: 'Pink' },
    { color: '#b07cff', label: 'Violet' },
  ];

  // The editor's preferences (editor/prefs.mjs: label and fallback; the help is
  // the one of editor-settings.js). The first four are saved together under
  // `editorPrefs`; the language servers are a setting of their own, since the
  // main process keeps that one.
  const EDITOR_PREFS = [
    { name: 'minimap', label: 'Minimap', help: 'A small view of the whole file at the right of each editor, with the matches of a search and the changes of a diff. Not in narrow editors.', fallback: true },
    { name: 'stickyScroll', label: 'Sticky Scroll', help: 'The first lines of the blocks you are scrolling through stay at the top of the editor; a click goes to one.', fallback: true },
    { name: 'whitespace', label: 'Show Whitespace', help: 'Draw spaces and tabs, and mark the ones at the end of a line.', fallback: false },
    { name: 'vim', label: 'Vim Mode', help: 'Edit with Vim\'s keys and modes. The app\'s keys (find, save, go to line, go to symbol) stay the app\'s.', fallback: false },
    { name: 'languageServers', label: 'Language Servers', help: 'Hover, errors, go to definition, rename and suggestions from the language servers installed on this computer, started for the languages found in a project\'s folders (each project\'s Settings) when a file of theirs opens. Off: none starts, in any project, and the running ones stop.', fallback: true },
  ];
  const EDITOR_PREF_NAMES = EDITOR_PREFS.filter(p => p.name !== 'languageServers').map(p => p.name);
  const editorPrefDefaults = () => Object.fromEntries(EDITOR_PREFS.filter(p => EDITOR_PREF_NAMES.includes(p.name)).map(p => [p.name, p.fallback]));

  // Node Knowledge: CBM's own settings (moved from project-knowledge-settings.js)
  // and where the binary the app runs came from.
  const KNOWLEDGE_CONFIG_FIELDS = [
    { key: 'auto_watch', label: 'Refresh the agents\' projects', help: 'Re-index the project of an agent\'s session when its git state moves.' },
    { key: 'watch_non_git', label: 'Watch folders without git', help: 'Also re-index such folders when files change (a scan of the tree).' },
    { key: 'ignore_worktrees', label: 'Leave git worktrees alone', help: 'Do not index linked worktrees on the automatic paths.' },
    { key: 'auto_index', label: 'Index new projects', help: 'Index a folder when an agent first opens a session in it. On unless you turn it off.' },
    { key: 'auto_index_limit', label: 'Up to', help: 'Files at most, for that automatic index: 2147483647, the most CBM takes, unless you change it.', number: true },
    { key: 'doc_candidates', label: 'Docs to code', help: 'Link documentation to the code it describes (auto: on in a full index).' },
    { key: 'index_max_files', label: 'Files per index', help: 'A limit, or off.', limit: true },
    { key: 'index_max_source_mb', label: 'Source per index (MB)', help: 'A limit, or off.', limit: true },
    { key: 'index_max_rss_mb', label: 'Memory while indexing (MB)', help: 'A limit, or off.', limit: true },
    { key: 'index_max_duration_seconds', label: 'Time per index (s)', help: 'A limit, or off.', limit: true },
  ];
  const KNOWLEDGE_SOURCE_LABELS = { override: 'from SWITCHBOARD_CBM', settings: 'chosen here', agents: 'the one your agents use', installed: 'installed on this computer' };

  // folder: a folder's own settings can override the field (null = use the global one).
  const FIELDS = [
    { key: 'disabledHarnesses', tab: 'agents', section: 'CLI Agents', kind: 'harnesses', label: 'CLI Agents',
      help: 'Scan for the sessions of an agent, show them, and offer it when starting one', default: [], folder: false },
    { key: 'permissionMode', tab: 'agents', section: 'Claude CLI Options', kind: 'choice', label: 'Permission Mode',
      help: 'Permission mode passed to the claude command', default: null, folder: true, choices: SessionConfig.PERMISSION_MODES },
    { key: 'worktree', tab: 'agents', section: 'Claude CLI Options', kind: 'bool', label: 'Worktree',
      help: 'Enable worktree for new sessions', default: false, folder: true },
    { key: 'worktreeName', tab: 'agents', section: 'Claude CLI Options', kind: 'text', label: 'Worktree Name',
      help: 'Custom name for worktree branches', default: '', folder: true, maxLength: 200 },
    { key: 'chrome', tab: 'agents', section: 'Claude CLI Options', kind: 'bool', label: 'Chrome',
      help: 'Enable Chrome browser automation', default: false, folder: true },
    { key: 'addDirs', tab: 'agents', section: 'Claude CLI Options', kind: 'text', label: 'Additional Directories',
      help: 'Extra directories to include in Claude sessions', default: '', folder: true, maxLength: 4096 },
    { key: 'codexSandbox', tab: 'agents', section: 'Codex CLI Options', kind: 'choice', label: 'Sandbox',
      help: 'What codex is allowed to touch. Leave on Default to use codex\'s own config.', default: 'workspace-write', folder: true, choices: SessionConfig.CODEX_SANDBOX_MODES },
    { key: 'codexApproval', tab: 'agents', section: 'Codex CLI Options', kind: 'choice', label: 'Approval',
      help: 'When codex stops to ask before running a command', default: '', folder: true, choices: SessionConfig.CODEX_APPROVAL_POLICIES },
    { key: 'codexModel', tab: 'agents', section: 'Codex CLI Options', kind: 'text', label: 'Model',
      help: 'Passed as --model; blank uses codex\'s default', default: '', folder: true, maxLength: 120 },
    { key: 'preLaunchCmd', tab: 'agents', section: 'Session Launch', kind: 'text', label: 'Pre-launch Command',
      help: 'Prepended to the claude command (e.g. "aws-vault exec profile --")', default: '', folder: true, maxLength: 2000 },
    { key: 'terminalTheme', tab: 'application', section: 'Application', kind: 'choice', label: 'Terminal Theme',
      help: 'Color theme for terminal sessions', default: 'switchboard', folder: false, choices: TERMINAL_THEME_CHOICES },
    { key: 'accentColor', tab: 'application', section: 'Application', kind: 'color', label: 'Accent Color',
      help: 'The color of buttons, selections, active tabs and highlights across the app, in every window. It changes as you pick it.', default: null, folder: false },
    // The choices are 'auto' and the profiles of the computer (ctx.shellProfileIds).
    { key: 'shellProfile', tab: 'application', section: 'Application', kind: 'choice', label: 'Shell Profile',
      help: 'Shell used for terminal and Claude sessions. Changes take effect for new sessions only.', default: 'auto', folder: false, choices: [{ value: 'auto', label: 'Auto (detect)' }] },
    { key: 'visibleSessionCount', tab: 'application', section: 'Application', kind: 'int', label: 'Max Visible Sessions',
      help: 'Show up to this many sessions per folder or project track before collapsing the rest', default: 5, folder: false, min: 1, max: 100 },
    { key: 'sessionMaxAgeDays', tab: 'application', section: 'Application', kind: 'int', label: 'Session Max Age (days)',
      help: 'Sessions older than this are hidden behind "+N older" even if under the count limit', default: 3, folder: false, min: 1, max: 365 },
    { key: 'terminalEngine', tab: 'application', section: 'Application', kind: 'choice', label: 'Terminal Engine',
      help: 'Where sessions run. In herdr-core they keep running when Switchboard quits, and only Stop (or Quit and Stop All Sessions) ends them. Takes effect at the next start.', default: 'hc', folder: false,
      choices: [{ value: 'hc', label: 'herdr-core (keep running)' }, { value: 'inside', label: 'Inside Switchboard' }] },
    { key: 'projectsRoot', tab: 'application', section: 'Application', kind: 'path', label: 'Projects Folder',
      help: 'Where new projects are created. Existing projects stay where they are.', default: '', folder: false, maxLength: 4096 },
    { key: 'mcpEmulation', tab: 'application', section: 'Application', kind: 'bool', label: 'IDE Emulation',
      help: 'Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.', default: false, folder: false },
    { key: 'editorPrefs', tab: 'editor', section: 'Editor', kind: 'editorPrefs', label: 'Editor', help: '', default: editorPrefDefaults(), folder: false },
    { key: 'languageServers', tab: 'editor', section: 'Editor', kind: 'bool', label: 'Language Servers',
      help: EDITOR_PREFS.find(p => p.name === 'languageServers').help, default: true, folder: false },
  ];
  const FIELD_BY_KEY = new Map(FIELDS.map(f => [f.key, f]));

  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const isHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim());
  const normalizeAccent = value => (isHex(value) ? value.trim().toLowerCase() : ACCENT_DEFAULT);
  const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
  // A full path wherever the app runs: from / or ~, a Windows drive (C:\ or C:/) or a share (\\server).
  const FULL_PATH = /^(?:[/~]|[A-Za-z]:[\\/]|\\\\)/;

  /** One field's value, checked: { value } or { error }. `null` is not handled here. */
  function checkValue(field, value, ctx) {
    const fail = error => ({ error });
    switch (field.kind) {
      case 'bool':
        return typeof value === 'boolean' ? { value } : fail(`${field.label} must be on or off`);
      case 'int':
        return Number.isInteger(value) && value >= field.min && value <= field.max
          ? { value } : fail(`${field.label} must be a whole number from ${field.min} to ${field.max}`);
      case 'text':
      case 'path': {
        if (typeof value !== 'string') return fail(`${field.label} must be text`);
        const text = value.trim();
        if (CONTROL.test(text)) return fail(`${field.label} contains unsafe characters`);
        if (/[\r\n]/.test(text)) return fail(`${field.label} must be a single line`);
        if (text.length > field.maxLength) return fail(`${field.label} is too long (at most ${field.maxLength} characters)`);
        if (field.kind === 'path' && text !== '' && !FULL_PATH.test(text)) return fail(`${field.label} must be a full path, like ~/Code`);
        return { value: text };
      }
      case 'choice': {
        let values = field.choices.map(c => c.value);
        if (field.key === 'shellProfile') values = ['auto', ...(ctx.shellProfileIds || [])];
        return values.includes(value) ? { value } : fail(`Invalid ${field.label}`);
      }
      case 'color':
        // null is the default accent.
        if (value === null) return { value };
        return isHex(value) ? { value: value.trim().toLowerCase() } : fail(`${field.label} must be a color like #8088ff`);
      case 'harnesses': {
        const known = ctx.harnessIds || [];
        if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !known.includes(id))) return fail('Unknown CLI agent');
        return { value: [...new Set(value)] };
      }
      case 'editorPrefs': {
        const names = isObject(value) ? Object.keys(value) : [];
        if (!names.length) return fail('Editor preferences must name at least one preference');
        for (const name of names) {
          if (!EDITOR_PREF_NAMES.includes(name)) return fail(`Unknown editor preference: ${name}`);
          if (typeof value[name] !== 'boolean') return fail(`${name} must be on or off`);
        }
        return { value: Object.fromEntries(names.map(n => [n, value[n]])) };
      }
      default:
        return fail(`Unsupported setting: ${field.key}`);
    }
  }

  function validatePatch(patch, ctx, folder) {
    if (!isObject(patch) || Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to save' };
    const out = {};
    for (const key of Object.keys(patch)) {
      const field = FIELD_BY_KEY.get(key);
      if (!field || (folder && !field.folder)) return { ok: false, error: `Unsupported setting: ${key}` };
      if (folder && patch[key] === null) { out[key] = null; continue; }
      const checked = checkValue(field, patch[key], ctx);
      if ('error' in checked) return { ok: false, error: checked.error };
      out[key] = checked.value;
    }
    return { ok: true, patch: out };
  }

  /** The global settings a save may write: { ok: true, patch } with the values trimmed and normalised, or { ok: false, error }. */
  function validateGlobalPatch(patch, ctx = { harnessIds: [], shellProfileIds: [] }) {
    return validatePatch(patch, ctx || {}, false);
  }

  /** The same for a folder's own settings: only the fields a folder overrides; null means "use the global one". */
  function validateFolderPatch(patch) {
    return validatePatch(patch, {}, true);
  }

  /** Every setting's value as the app runs it: saved, else the app's default, else the catalog's. */
  function effectiveGlobalValues(stored, appDefaults) {
    const saved = isObject(stored) ? stored : {};
    const defaults = isObject(appDefaults) ? appDefaults : {};
    const out = {};
    for (const field of FIELDS) {
      const value = saved[field.key] ?? defaults[field.key] ?? field.default;
      out[field.key] = Array.isArray(value) ? [...value] : value;
    }
    const prefs = editorPrefDefaults();
    for (const name of EDITOR_PREF_NAMES) {
      for (const source of [saved.editorPrefs, defaults.editorPrefs]) {
        if (isObject(source) && typeof source[name] === 'boolean') { prefs[name] = source[name]; break; }
      }
    }
    out.editorPrefs = prefs;
    out.accentColor = normalizeAccent(out.accentColor);
    out.terminalEngine = saved.terminalEngine === 'inside' ? 'inside' : 'hc';
    return out;
  }

  const sameValue = (a, b) => {
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every(x => b.includes(x));
    return (a ?? null) === (b ?? null);
  };

  /**
   * The patch for one field the user edited, or null when nothing changed: the
   * value, trimmed, is the saved one. `key` is a field's key, or
   * 'editorPrefs.<name>' for one Editor preference.
   */
  function changedPatch(key, value, saved) {
    const prefName = key.startsWith('editorPrefs.') ? key.slice('editorPrefs.'.length) : null;
    if (!prefName && !FIELD_BY_KEY.has(key)) throw new Error(`Unsupported setting: ${key}`);
    const next = typeof value === 'string' ? value.trim() : value;
    if (sameValue(next, saved)) return null;
    return prefName ? { editorPrefs: { [prefName]: next } } : { [key]: next };
  }

  /**
   * How the window's editor preferences (kept in localStorage) and the saved
   * ones meet. Nothing saved yet: `migrate` is what the window has, to save
   * once. Saved: `apply` is what the window must change to follow them.
   */
  function editorPrefsSync(storedGlobal, current) {
    const have = isObject(current) ? current : {};
    const saved = isObject(storedGlobal) && isObject(storedGlobal.editorPrefs) ? storedGlobal.editorPrefs : null;
    if (!saved) {
      const defaults = editorPrefDefaults();
      return { migrate: Object.fromEntries(EDITOR_PREF_NAMES.map(n => [n, typeof have[n] === 'boolean' ? have[n] : defaults[n]])), apply: {} };
    }
    const apply = {};
    for (const name of EDITOR_PREF_NAMES) {
      if (typeof saved[name] === 'boolean' && saved[name] !== have[name]) apply[name] = saved[name];
    }
    return { migrate: null, apply };
  }

  // --- The settings search, of the desktop's Settings page and the phone's ---

  /** The lists a search gives, in the order they show, with their headings. */
  const SEARCH_GROUPS = [{ key: 'titles', label: 'Found in titles' }, { key: 'descriptions', label: 'Found in descriptions' }];

  /** The words of a query, in lower case. */
  const searchWords = query => String(query || '').toLowerCase().split(/\s+/).filter(Boolean);

  /**
   * The entries ({ title, description }) that answer `query`, each list in the
   * order given: `titles` have every word in their title; `descriptions` are
   * the others that have every word in their title or description.
   */
  function searchSettings(entries, query) {
    const words = searchWords(query);
    const titles = [];
    const descriptions = [];
    if (!words.length) return { titles, descriptions };
    for (const entry of entries) {
      const title = entry.title.toLowerCase();
      if (words.every(w => title.includes(w))) { titles.push(entry); continue; }
      const description = entry.description.toLowerCase();
      if (words.every(w => title.includes(w) || description.includes(w))) descriptions.push(entry);
    }
    return { titles, descriptions };
  }

  /**
   * `text` in pieces, in order, `match` true on the ones that are a word of
   * `query`. Words that overlap give matching pieces one after the other.
   */
  function searchParts(text, query) {
    const lower = text.toLowerCase();
    const ranges = [];
    for (const word of searchWords(query)) {
      for (let i = lower.indexOf(word); i >= 0; i = lower.indexOf(word, i + word.length)) ranges.push([i, i + word.length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const parts = [];
    let done = 0;
    const add = (from, to, match) => { if (to > from) parts.push({ text: text.slice(from, to), match }); };
    for (const [from, to] of ranges) {
      if (to <= done) continue;
      const start = Math.max(from, done);
      add(done, start, false);
      add(start, to, true);
      done = to;
    }
    add(done, text.length, false);
    return parts;
  }

  /** Where a result is: "Tab › Section", the section left out when it is named as its tab. */
  function searchWhere(tab, section) {
    const same = section.toLowerCase() === tab.toLowerCase();
    return [tab, same ? '' : section].filter(Boolean).join(' › ');
  }

  /** The line above the results; '' without a query. */
  function searchStatus(query, count) {
    const text = String(query || '').trim();
    if (!text) return '';
    if (!count) return `No setting matches “${text}”.`;
    return count === 1 ? '1 setting found' : `${count} settings found`;
  }

  const api = { DESKTOP_TABS, PHONE_TABS, FIELDS, EDITOR_PREFS, TERMINAL_THEME_CHOICES, ACCENT_DEFAULT, ACCENT_PRESETS,
    KNOWLEDGE_CONFIG_FIELDS, KNOWLEDGE_SOURCE_LABELS, validateGlobalPatch, validateFolderPatch, effectiveGlobalValues, changedPatch, editorPrefsSync,
    SEARCH_GROUPS, searchSettings, searchParts, searchWhere, searchStatus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SettingsModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
