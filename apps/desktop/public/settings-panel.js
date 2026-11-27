// Settings panel component
// The Global Settings page, in tabs (Application, Agents, Editor, Node
// Knowledge, Prompt Improver), and a folder's own settings, without tabs,
// each with a search box at the top (settings-search.js).
// Each setting is saved as it changes, one key at a time (patch-setting): a
// switch or a choice when it is clicked, a text or number field when you
// leave it or press Enter. "Saved" shows beside the field for a moment; a
// value the main process refuses shows why, and the field goes back to the
// saved value. What a save changes in the app (theme, sidebar, accent) the
// main window applies itself, from global-settings-changed (app.js).

(function () {
  // Where the app's source, releases and issues are (Settings › Updates).
  const SWITCHBOARD_REPOSITORY_URL = 'https://github.com/vivi7/switchboard-evolution';
  const settingsViewer = document.getElementById('settings-viewer');
  const settingsViewerTitle = document.getElementById('settings-viewer-title');
  const settingsViewerBody = document.getElementById('settings-viewer-body');

  const SAVED_NOTE_MS = 1500;
  const NOTICE_MS = 8000;
  // The page always opens on this tab.
  const FIRST_TAB = 'application';

  // The control of each setting the panel draws (the Editor's are
  // editor-settings.js's). The CLI toggles are a class: one per CLI.
  const CONTROL_IDS = {
    disabledHarnesses: 'sv-harness-toggle',
    permissionMode: 'sv-perm-mode',
    worktree: 'sv-worktree',
    worktreeName: 'sv-worktree-name',
    chrome: 'sv-chrome',
    addDirs: 'sv-add-dirs',
    codexSandbox: 'sv-codex-sandbox',
    codexApproval: 'sv-codex-approval',
    codexModel: 'sv-codex-model',
    preLaunchCmd: 'sv-pre-launch',
    terminalTheme: 'sv-terminal-theme',
    accentColor: 'sv-accent-color',
    shellProfile: 'sv-shell-profile',
    visibleSessionCount: 'sv-visible-count',
    sessionMaxAgeDays: 'sv-max-age',
    terminalEngine: 'sv-terminal-engine',
    projectsRoot: 'sv-projects-root',
    mcpEmulation: 'sv-mcp-emulation',
  };

  // What a field shows when neither the settings nor the app's defaults have a value.
  const FALLBACKS = {
    permissionMode: '', worktree: false, worktreeName: '', chrome: false, addDirs: '',
    codexSandbox: '', codexApproval: '', codexModel: '', preLaunchCmd: '',
    visibleSessionCount: 10, sessionMaxAgeDays: 3, terminalTheme: 'switchboard', mcpEmulation: true, shellProfile: 'auto',
  };

  // The page on screen follows settings changed elsewhere (a phone, another
  // window) through one listener: a new page replaces the listener of the one
  // before, and a listener whose page is gone removes only itself, never the
  // listener of the page that replaced it. `subscribe(cb)` returns the unsubscribe.
  function createChangeFollower(subscribe) {
    let current = null;
    function stop() {
      const off = current;
      current = null;
      if (off) off();
    }
    function follow(onChange, isLive) {
      stop();
      const off = subscribe((event) => {
        if (isLive()) { onChange(event); return; }
        off();
        if (current === off) current = null;
      });
      current = off;
    }
    return { follow, stop };
  }
  const changes = createChangeFollower(cb => (window.api.onGlobalSettingsChanged ? window.api.onGlobalSettingsChanged(cb) : () => {}));
  // Node Knowledge follows CBM's settings the same way (knowledge-changed, project-knowledge-settings.js).
  const knowledgeChanges = createChangeFollower(cb => (window.api.onKnowledgeChanged ? window.api.onKnowledgeChanged(cb) : () => {}));

  // Each open takes a number; an open overtaken by a later one (or by Close)
  // while it waits for the settings stops before it draws.
  let openToken = 0;

  function closeSettingsViewer() {
    openToken++;
    changes.stop();
    knowledgeChanges.stop();
    settingsViewer.style.display = 'none';
    const terminalArea = document.getElementById('terminal-area');
    const terminalHeader = document.getElementById('terminal-header');
    const placeholder = document.getElementById('placeholder');
    const gridViewActive = localStorage.getItem('gridViewActive') === '1';
    const activeSessionId = sessionStorage.getItem('activeSessionId') || null;
    // Check if there's an active session with an open terminal
    if (activeSessionId && window._openSessions && window._openSessions.has(activeSessionId)) {
      terminalArea.style.display = '';
      terminalHeader.style.display = '';
    } else if (gridViewActive) {
      terminalArea.style.display = '';
    } else {
      placeholder.style.display = '';
    }
  }

  // --- Controls: a setting's value as its control shows it, in the form it is saved ---

  const harnessToggles = () => [...settingsViewerBody.querySelectorAll('.sv-harness-toggle')];
  const controlOf = key => (key === 'disabledHarnesses' ? harnessToggles()[0] : settingsViewerBody.querySelector('#' + CONTROL_IDS[key])) || null;

  function readControl(key) {
    // The switched-off set rather than the switched-on one, so a CLI added in
    // a later version is on by default instead of silently missing. Locked
    // toggles count too: `disabled` only stops the user changing them.
    if (key === 'disabledHarnesses') return harnessToggles().filter(t => !t.checked).map(t => t.dataset.harness);
    const el = controlOf(key);
    if (key === 'accentColor') {
      const c = AccentColor.normalize(el.value);
      return c === AccentColor.DEFAULT ? null : c;
    }
    if (el.type === 'checkbox') return el.checked;
    // Empty is not a number: the main process refuses it, and the field goes back.
    if (el.type === 'number') return el.value.trim() === '' ? null : Number(el.value);
    if (key === 'permissionMode') return el.value || null;
    return el.value;
  }

  function writeControl(key, value) {
    if (key === 'disabledHarnesses') {
      const off = new Set(value || []);
      for (const t of harnessToggles()) t.checked = !off.has(t.dataset.harness);
      syncHarnessLock();
      return;
    }
    if (key === 'accentColor') { showAccent(AccentColor.apply(value)); return; }
    const el = controlOf(key);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value ?? '';
  }

  const showsValue = (key, value) => JSON.stringify(readControl(key)) === JSON.stringify(value ?? null);
  // A field being typed in is not overwritten by a change made elsewhere.
  const isTyping = el => !!el && el === document.activeElement && (el.type === 'text' || el.type === 'number');

  // At least one CLI has to stay on, or the sidebar has nothing to show and
  // the "+" menu nothing to offer. The last one still switched on is locked
  // rather than hidden, so the reason is visible. Main keeps one on too, for
  // any writer that does not come through this panel.
  function syncHarnessLock() {
    const toggles = harnessToggles();
    const on = toggles.filter(t => t.checked);
    for (const t of toggles) {
      const lock = on.length === 1 && t.checked;
      t.disabled = lock;
      const desc = t.closest('.settings-field')?.querySelector('.settings-description');
      if (desc && lock && !desc.dataset.originalText) {
        desc.dataset.originalText = desc.innerHTML;
        desc.textContent = 'Kept on — at least one CLI must stay enabled';
      } else if (desc && !lock && desc.dataset.originalText) {
        desc.innerHTML = desc.dataset.originalText;
        delete desc.dataset.originalText;
      }
    }
  }

  // The accent's swatches and picker show `color` (already applied).
  function showAccent(color) {
    const group = settingsViewerBody.querySelector('.sv-accent');
    if (!group) return;
    group.querySelectorAll('.sv-accent-swatch').forEach(b => {
      const on = b.dataset.accent === color;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const picker = group.querySelector('#sv-accent-color');
    if (picker.value !== color) picker.value = color;
  }

  // --- Notes beside a field: "Saved" for a moment, or why a value was refused ---

  function fieldNote(control) {
    const field = control.closest('.settings-field');
    let note = field.querySelector('.settings-field-note');
    if (!note) {
      note = document.createElement('span');
      note.className = 'settings-field-note';
      note.setAttribute('role', 'status');
      field.querySelector('.settings-label').after(note);
    }
    clearTimeout(note._hideTimer);
    return note;
  }

  function noteSaved(control) {
    const note = fieldNote(control);
    note.classList.remove('error');
    note.textContent = 'Saved';
    note._hideTimer = setTimeout(() => { note.textContent = ''; }, SAVED_NOTE_MS);
  }

  // The error stays until the field is saved again.
  function noteError(control, message) {
    const note = fieldNote(control);
    note.classList.add('error');
    note.textContent = message;
  }

  // A longer notice under the field's description (IDE Emulation's).
  function fieldNotice(control, text) {
    const info = control.closest('.settings-field')?.querySelector('.settings-field-info');
    if (!info) return;
    info.querySelector('.settings-notice')?.remove();
    const notice = document.createElement('div');
    notice.className = 'settings-notice';
    notice.textContent = text;
    info.appendChild(notice);
    setTimeout(() => notice.remove(), NOTICE_MS);
  }

  // --- Tabs (global settings only) ---

  function tabBarHtml() {
    return `<div class="settings-tabs" role="tablist" aria-label="Settings">${SettingsModel.DESKTOP_TABS.map(t => {
      const on = t.key === FIRST_TAB;
      return `<button type="button" class="settings-tab${on ? ' active' : ''}" role="tab" id="sv-tab-${t.key}" data-tab="${t.key}" aria-controls="sv-pane-${t.key}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${escapeHtml(t.label)}</button>`;
    }).join('')}</div>`;
  }

  function bindTabs() {
    const tabs = [...settingsViewerBody.querySelectorAll('.settings-tab')];
    const select = (tab) => {
      for (const t of tabs) {
        const on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        settingsViewerBody.querySelector(`.settings-pane[data-tab="${t.dataset.tab}"]`).hidden = !on;
      }
      settingsViewerBody.scrollTop = 0;
    };
    for (const tab of tabs) {
      tab.addEventListener('click', () => select(tab));
      // Arrows, Home and End move between the tabs shown.
      tab.addEventListener('keydown', (e) => {
        const shown = tabs.filter(t => !t.hidden);
        const i = shown.indexOf(tab);
        const next = { ArrowRight: shown[(i + 1) % shown.length], ArrowLeft: shown[(i - 1 + shown.length) % shown.length], Home: shown[0], End: shown[shown.length - 1] }[e.key];
        if (!next) return;
        e.preventDefault();
        select(next);
        next.focus();
      });
    }
  }

  // A tab whose section has nothing to show is left out.
  function hideTabIfEmpty(key, section) {
    const tab = settingsViewerBody.querySelector(`.settings-tab[data-tab="${key}"]`);
    if (tab) tab.hidden = section.hidden || !section.innerHTML.trim();
  }

  async function openSettingsViewer(scope, projectPath) {
    const token = ++openToken;
    const superseded = () => token !== openToken;
    changes.stop();
    knowledgeChanges.stop();
    const isProject = scope === 'project';
    const settingsKey = isProject ? 'project:' + projectPath : 'global';
    const current = (await window.api.getSetting(settingsKey)) || {};
    let globalSettings = isProject ? ((await window.api.getSetting('global')) || {}) : {};
    // What actually runs when nothing is stored: the app's defaults under the
    // saved global values. A fresh install shows these, not blanks.
    const appDefaults = (await window.api.getEffectiveSettings(null).catch(() => null)) || {};
    if (superseded()) return;

    const shortName = isProject
      ? shortProjectPath(projectPath)
      : 'Global';

    settingsViewerTitle.textContent = (isProject ? 'Folder Settings — ' : 'Global Settings — ') + shortName;

    // Show settings viewer, hide others
    if (typeof hideProjectChrome === 'function') hideProjectChrome();
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    document.getElementById('plan-viewer').style.display = 'none';
    document.getElementById('stats-viewer').style.display = 'none';
    document.getElementById('memory-viewer').style.display = 'none';
    document.getElementById('jsonl-viewer').style.display = 'none';
    document.getElementById('process-viewer').style.display = 'none';
    // Which settings are on screen: the Global settings tab lights only for its own.
    settingsViewer.dataset.scope = scope;
    settingsViewer.style.display = 'flex';

    const set = v => v !== undefined && v !== null;
    // What runs when this scope has no value of its own: the global setting, else the app's default.
    const inheritedValue = name => (set(globalSettings[name]) ? globalSettings[name] : set(appDefaults[name]) ? appDefaults[name] : FALLBACKS[name]);
    const usesGlobal = name => isProject && !set(current[name]);

    function useGlobalCheckbox(fieldName) {
      if (!isProject) return '';
      return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${usesGlobal(fieldName) ? 'checked' : ''}> Use global default</label>`;
    }

    function fieldValue(fieldName) {
      if (usesGlobal(fieldName)) return inheritedValue(fieldName);
      if (set(current[fieldName])) return current[fieldName];
      return set(appDefaults[fieldName]) ? appDefaults[fieldName] : FALLBACKS[fieldName];
    }

    function fieldDisabled(fieldName) {
      return usesGlobal(fieldName) ? 'disabled' : '';
    }

    // Fetched before the template so the toggles render as direct children of
    // their section: the card's rounded top and bottom come from
    // `.settings-section > .settings-field`, which a wrapper div would break.
    const harnesses = isProject ? [] : await window.api.getHarnesses().catch(() => []);
    const harnessFields = harnesses.map(h => `
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">${escapeHtml(h.label)}</span>
            <div class="settings-description">Scan for <code>${escapeHtml(h.id)}</code> sessions, show them, and offer it when starting one</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" class="sv-harness-toggle" data-harness="${escapeHtml(h.id)}" ${h.enabled ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>`).join('');

    const permModeValue = fieldValue('permissionMode');
    const codexSandboxValue = fieldValue('codexSandbox');
    const codexApprovalValue = fieldValue('codexApproval');
    const codexModelValue = fieldValue('codexModel');
    const worktreeValue = fieldValue('worktree');
    const worktreeNameValue = fieldValue('worktreeName');
    const chromeValue = fieldValue('chrome');
    const preLaunchValue = fieldValue('preLaunchCmd');
    const addDirsValue = fieldValue('addDirs');
    const visCountValue = fieldValue('visibleSessionCount');
    const maxAgeValue = fieldValue('sessionMaxAgeDays');
    const themeValue = fieldValue('terminalTheme');
    // Global only: the accent colour of the whole app (accent.js).
    const accentValue = window.AccentColor ? AccentColor.normalize(current.accentColor) : '#8088ff';
    const mcpEmulationValue = fieldValue('mcpEmulation');
    // Global-only: where new projects get their folder (projects.js). Empty
    // means the default, ~/Switchboard.
    const projectsRootValue = (!isProject && typeof current.projectsRoot === 'string') ? current.projectsRoot : '';
    const terminalEngineValue = current.terminalEngine === 'inside' ? 'inside' : 'hc';
    const shellProfileValue = fieldValue('shellProfile');

    // Discover available shell profiles
    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch {};
    if (superseded()) return;

    // The Agents tab; a folder's settings are these sections alone (no CLI Agents).
    const agentsSections = `
      ${harnessFields ? `<div class="settings-section">
        <div class="settings-section-title">CLI Agents</div>${harnessFields}
      </div>` : ''}

      <div class="settings-section">
        <div class="settings-section-title">Claude CLI Options</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Permission Mode</span>
              ${useGlobalCheckbox('permissionMode')}
            </div>
            <div class="settings-description">Permission mode passed to the <code>claude</code> command</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
              ${PERMISSION_MODES.map(m => m.value === null
                ? '<option value="">Default (none)</option>'
                : `<option value="${m.value}" ${permModeValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree</span>
              ${useGlobalCheckbox('worktree')}
            </div>
            <div class="settings-description">Enable worktree for new sessions</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''} ${fieldDisabled('worktree')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree Name</span>
              ${useGlobalCheckbox('worktreeName')}
            </div>
            <div class="settings-description">Custom name for worktree branches</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')} style="width:140px">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Chrome</span>
              ${useGlobalCheckbox('chrome')}
            </div>
            <div class="settings-description">Enable Chrome browser automation</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-chrome" ${chromeValue ? 'checked' : ''} ${fieldDisabled('chrome')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Additional Directories</span>
              ${useGlobalCheckbox('addDirs')}
            </div>
            <div class="settings-description">Extra directories to include in Claude sessions</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Codex CLI Options</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Sandbox</span>
              ${useGlobalCheckbox('codexSandbox')}
            </div>
            <div class="settings-description">What <code>codex</code> is allowed to touch. Leave on Default to use codex's own config.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-codex-sandbox" ${fieldDisabled('codexSandbox')}>
              ${CODEX_SANDBOX_MODES.map(m => `<option value="${m.value}" ${codexSandboxValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Approval</span>
              ${useGlobalCheckbox('codexApproval')}
            </div>
            <div class="settings-description">When codex stops to ask before running a command</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-codex-approval" ${fieldDisabled('codexApproval')}>
              ${CODEX_APPROVAL_POLICIES.map(m => `<option value="${m.value}" ${codexApprovalValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Model</span>
              ${useGlobalCheckbox('codexModel')}
            </div>
            <div class="settings-description">Passed as <code>--model</code>; blank uses codex's default</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-codex-model" placeholder="default" value="${escapeHtml(codexModelValue)}" ${fieldDisabled('codexModel')} style="width:140px">
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Session Launch</div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Pre-launch Command</span>
              ${useGlobalCheckbox('preLaunchCmd')}
            </div>
            <div class="settings-description">Prepended to the claude command (e.g. "aws-vault exec profile --")</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>
          </div>
        </div>
      </div>`;

    // The Application tab: the app's own settings, then Updates and Support.
    const applicationSections = isProject ? '' : `
      <div class="settings-section">
        <div class="settings-section-title">Application</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Theme</span>
            <div class="settings-description">Color theme for terminal sessions</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-terminal-theme">
              ${Object.entries(TERMINAL_THEMES).map(([key, t]) =>
                `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        ${window.AccentColor ? `<div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Accent Color</span>
            <div class="settings-description">The color of buttons, selections, active tabs and highlights across the app, in every window. It changes as you pick it.</div>
          </div>
          <div class="settings-field-control sv-accent" role="group" aria-label="Accent color">
            ${AccentColor.PRESETS.map(p => `<button type="button" class="sv-accent-swatch${accentValue === p.color ? ' on' : ''}" data-accent="${escapeAttr(p.color)}" style="--swatch: ${escapeAttr(p.color)}" title="${escapeAttr(p.label)}" aria-label="${escapeAttr(p.label)}" aria-pressed="${accentValue === p.color}"></button>`).join('')}
            <label class="sv-accent-custom" title="Any color"><input type="color" id="sv-accent-color" value="${escapeAttr(accentValue)}" aria-label="Custom accent color"><span>Custom</span></label>
          </div>
        </div>` : ''}

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Shell Profile</span>
            <div class="settings-description">Shell used for terminal and Claude sessions. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-shell-profile">
              <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
              ${shellProfiles.map(p =>
                `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Max Visible Sessions</span>
            <div class="settings-description">Show up to this many sessions per folder or project track before collapsing the rest</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Session Max Age (days)</span>
            <div class="settings-description">Sessions older than this are hidden behind "+N older" even if under the count limit</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Engine</span>
            <div class="settings-description">Where sessions run. In herdr-core they keep running when Switchboard quits, and only Stop (or Quit and Stop All Sessions) ends them. Takes effect at the next start. <span id="sv-terminal-engine-status"></span></div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-terminal-engine">
              <option value="hc"${terminalEngineValue === 'hc' ? ' selected' : ''}>herdr-core (keep running)</option>
              <option value="inside"${terminalEngineValue === 'inside' ? ' selected' : ''}>Inside Switchboard</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Projects Folder</span>
            <div class="settings-description">Where new projects are created. Existing projects stay where they are.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-projects-root" placeholder="~/Switchboard" value="${escapeHtml(projectsRootValue)}" spellcheck="false">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Project Templates</span>
            <div class="settings-description">One folder per template, each with a <code>template.json</code> and the files a new project starts with. Add a folder to add a template. <span id="sv-templates-dir"></span></div>
          </div>
          <div class="settings-field-control">
            <button class="settings-check-updates-btn" id="sv-open-templates" type="button">Open Folder</button>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">IDE Emulation</span>
            <div class="settings-description">Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-mcp-emulation" ${mcpEmulationValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Updates</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Version</span>
            <div class="settings-description"><span id="sv-current-version"></span> <span id="sv-update-status"></span></div>
          </div>
          <div class="settings-field-control">
            <button class="settings-check-updates-btn" id="sv-check-updates-btn">Check for Updates</button>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Source code</span>
            <div class="settings-description">Switchboard Evolution on GitHub: the desktop and the phone app, releases and issues.</div>
          </div>
          <div class="settings-field-control">
            <button class="settings-check-updates-btn" id="sv-github-btn" title="${SWITCHBOARD_REPOSITORY_URL}">Open on GitHub</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Support</div>
        <div class="settings-donate" id="sv-donate"></div>
      </div>`;

    settingsViewerBody.innerHTML = `
    <div class="settings-form">
      <div class="settings-head">
        <input type="search" class="settings-input settings-search-input" id="sv-search" placeholder="Search settings" aria-label="Search settings" autocomplete="off" spellcheck="false">
        ${isProject ? '' : tabBarHtml()}
      </div>
      <div class="settings-search-status" role="status"></div>
      <div class="settings-search-results" hidden></div>
      ${isProject ? agentsSections : `
      <div class="settings-pane" data-tab="application" id="sv-pane-application" role="tabpanel" aria-labelledby="sv-tab-application">${applicationSections}</div>
      <div class="settings-pane" data-tab="agents" id="sv-pane-agents" role="tabpanel" aria-labelledby="sv-tab-agents" hidden>${agentsSections}</div>
      <div class="settings-pane" data-tab="editor" id="sv-pane-editor" role="tabpanel" aria-labelledby="sv-tab-editor" hidden>
        <div class="settings-section" id="sv-editor"></div>
      </div>
      <div class="settings-pane" data-tab="knowledge" id="sv-pane-knowledge" role="tabpanel" aria-labelledby="sv-tab-knowledge" hidden>
        <div class="settings-section" id="sv-knowledge"></div>
      </div>
      <div class="settings-pane" data-tab="improver" id="sv-pane-improver" role="tabpanel" aria-labelledby="sv-tab-improver" hidden>
        <div class="settings-section" id="sv-prompt-improver" hidden></div>
      </div>`}

      <div class="settings-btn-row">
        <button type="button" class="settings-close-btn" id="sv-close-btn">Close</button>
        ${isProject ? '<button type="button" class="settings-remove-btn" id="sv-remove-btn">Hide Folder</button>' : ''}
      </div>
    </div>
  `;
    const form = settingsViewerBody.querySelector('.settings-form');
    if (!isProject) bindTabs();
    bindSettingsSearch(form);
    syncHarnessLock();

    // --- Saving: each setting as it changes ---

    const drawnKeys = Object.keys(CONTROL_IDS).filter(key => controlOf(key));
    const useGlobalBox = key => settingsViewerBody.querySelector(`.use-global-cb[data-field="${key}"]`);
    // What each setting is saved as, here: what a field goes back to when a
    // save is refused. A folder's own value is null while it uses the global one.
    const saved = {};
    for (const key of drawnKeys) saved[key] = usesGlobal(key) ? null : readControl(key);

    // One save at a time per setting, so a quick second change compares with
    // what the first one saved.
    const queues = {};
    const enqueue = (key, job) => (queues[key] = (queues[key] || Promise.resolve()).then(job).catch(() => {}));
    const saveField = (key, value, control) => enqueue(key, () => writeField(key, value, control));

    async function writeField(key, value, control) {
      const patch = SettingsModel.changedPatch(key, value, saved[key]);
      if (!patch) return;
      const res = await window.api.patchSetting(settingsKey, patch).catch(err => ({ ok: false, error: err.message }));
      if (res && res.ok) {
        // As the main process saved it: trimmed, or with the last CLI kept on.
        saved[key] = res.settings[key] ?? null;
        if (!showsValue(key, saved[key])) writeControl(key, saved[key]);
        // Compared with what was sent: global-settings-changed may already have reset the toggles.
        const keptOn = key === 'disabledHarnesses' && (saved[key] || []).length < patch[key].length;
        if (keptOn) noteError(control, 'Kept on — at least one CLI must stay enabled');
        else noteSaved(control);
        if (key === 'mcpEmulation') fieldNotice(control, 'IDE Emulation setting changed. New sessions will use the updated setting — running sessions are not affected.');
      } else {
        writeControl(key, saved[key]);
        noteError(control, (res && res.error) || 'Not saved');
      }
      if (isProject) showFolderValue(key);
    }

    // A folder without a value of its own shows the global one, and its field is locked.
    function showFolderValue(key) {
      const box = useGlobalBox(key);
      if (!box) return;
      box.checked = saved[key] === null;
      controlOf(key).disabled = box.checked;
      if (box.checked) writeControl(key, inheritedValue(key));
    }

    for (const key of drawnKeys) {
      if (key === 'disabledHarnesses' || key === 'accentColor') continue;
      const el = controlOf(key);
      el.addEventListener('change', () => saveField(key, readControl(key), el));
    }

    for (const toggle of harnessToggles()) {
      toggle.addEventListener('change', () => {
        syncHarnessLock();
        saveField('disabledHarnesses', readControl('disabledHarnesses'), toggle);
      });
    }

    // "Use global default": ticked, the folder's value goes; unticked, the value shown becomes the folder's.
    settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.field;
        controlOf(key).disabled = cb.checked;
        if (!cb.checked) { saveField(key, readControl(key), cb); return; }
        writeControl(key, inheritedValue(key));
        saveField(key, null, cb);
      });
    });

    // Accent colour: shown at once in every window, saved when picked.
    const accentGroup = settingsViewerBody.querySelector('.sv-accent');
    if (accentGroup && window.AccentColor) {
      const picker = accentGroup.querySelector('#sv-accent-color');
      const choose = (color) => {
        showAccent(AccentColor.apply(color));
        saveField('accentColor', readControl('accentColor'), accentGroup);
      };
      accentGroup.querySelectorAll('.sv-accent-swatch').forEach(b => { b.onclick = () => choose(b.dataset.accent); });
      picker.addEventListener('input', () => { AccentColor.apply(picker.value); });
      picker.addEventListener('change', () => choose(picker.value));
    }

    // A setting changed elsewhere (a phone, another window, or this page's own
    // save): show it, apart from a field being typed in, which shows what is
    // saved once it is left.
    changes.follow(({ settings, changed }) => {
      const next = settings || {};
      if (isProject) globalSettings = next;
      for (const key of changed || []) {
        if (!drawnKeys.includes(key)) continue;
        if (isProject) {
          if (useGlobalBox(key)?.checked) writeControl(key, inheritedValue(key));
          continue;
        }
        saved[key] = next[key] ?? null;
        const el = controlOf(key);
        if (!isTyping(el)) writeControl(key, saved[key]);
        else el.addEventListener('blur', () => enqueue(key, () => { if (!showsValue(key, saved[key])) writeControl(key, saved[key]); }), { once: true });
      }
    }, () => !superseded() && form.isConnected);

    // --- Actions and the sections that draw themselves ---

    settingsViewerBody.querySelector('#sv-close-btn').addEventListener('click', () => closeSettingsViewer());

    // Project templates folder (global only)
    const openTemplates = settingsViewerBody.querySelector('#sv-open-templates');
    if (openTemplates) {
      window.api.listTemplates().then(result => {
        const dirEl = settingsViewerBody.querySelector('#sv-templates-dir');
        if (dirEl && result?.dir) dirEl.textContent = result.dir;
        openTemplates.onclick = () => { if (result?.dir) window.api.openPath(result.dir); };
      }).catch(() => {});
    }

    // Which engine runs sessions right now (global only)
    const engineStatus = settingsViewerBody.querySelector('#sv-terminal-engine-status');
    if (engineStatus && window.api.getTerminalEngine) {
      window.api.getTerminalEngine().then(status => {
        engineStatus.textContent = status?.engine === 'hc'
          ? `Now: herdr-core ${status.version} (${status.source === 'bundled' ? 'the copy inside the app' : status.path}), session "${status.session}".`
          : `Now: inside Switchboard. ${status?.reason || ''}`;
      }).catch(() => {});
    }

    const githubBtn = settingsViewerBody.querySelector('#sv-github-btn');
    if (githubBtn) githubBtn.addEventListener('click', () => window.api.openExternal(SWITCHBOARD_REPOSITORY_URL));
    // The editor's preferences (editor-settings.js), applied as they change.
    const editorSection = settingsViewerBody.querySelector('#sv-editor');
    if (editorSection && typeof renderEditorSettings === 'function') renderEditorSettings(editorSection);
    if (editorSection) hideTabIfEmpty('editor', editorSection);
    // Node Knowledge: codebase-memory-mcp's program and its own settings (project-knowledge-settings.js).
    const knowledgeSection = settingsViewerBody.querySelector('#sv-knowledge');
    if (knowledgeSection && typeof knRenderGlobalSettings === 'function') {
      // Followed while this page is on screen; a section drawn late, after a later open or Close, follows nothing.
      const live = () => !superseded() && knowledgeSection.isConnected;
      knRenderGlobalSettings(knowledgeSection, { follow: onChange => { if (live()) knowledgeChanges.follow(onChange, live); } });
    }
    // The prompt improver (prompt-improver-settings.js); its tab shows once the section does.
    const improverSection = settingsViewerBody.querySelector('#sv-prompt-improver');
    if (improverSection) {
      hideTabIfEmpty('improver', improverSection);
      if (typeof renderPromptImproverSettings === 'function') {
        Promise.resolve(renderPromptImproverSettings(improverSection)).catch(() => {})
          .then(() => hideTabIfEmpty('improver', improverSection));
      }
    }

    // The donation box of the Projects tab, always here and without its X (donate-box.js).
    const donateSlot = settingsViewerBody.querySelector('#sv-donate');
    if (donateSlot && typeof window.buildDonateBox === 'function') donateSlot.appendChild(window.buildDonateBox());

    // Check for updates button + current version + inline status
    const checkUpdatesBtn = settingsViewerBody.querySelector('#sv-check-updates-btn');
    if (checkUpdatesBtn) {
      const updateStatusEl = settingsViewerBody.querySelector('#sv-update-status');
      window.api.getAppVersion().then(v => {
        const el = settingsViewerBody.querySelector('#sv-current-version');
        if (el) el.textContent = `v${v}`;
      });
      const settingsUpdaterHandler = (type, data) => {
        if (!updateStatusEl) return;
        switch (type) {
          case 'checking': updateStatusEl.textContent = '— checking…'; break;
          case 'update-available': updateStatusEl.textContent = `— v${data.version} available`; break;
          case 'update-not-available': updateStatusEl.textContent = '— up to date'; break;
          case 'download-progress': updateStatusEl.textContent = `— downloading ${Math.round(data.percent)}%`; break;
          case 'update-downloaded': updateStatusEl.textContent = `— v${data.version} ready, restart to update`; break;
          case 'error': updateStatusEl.textContent = '— check failed'; break;
        }
      };
      window.api.onUpdaterEvent(settingsUpdaterHandler);
      checkUpdatesBtn.addEventListener('click', () => {
        window.api.updaterCheck();
      });
    }

    // Remove project button
    const removeBtn = settingsViewerBody.querySelector('#sv-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        if (!confirm(`Hide project "${shortName}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`)) return;
        await window.api.removeProject(projectPath);
        // Not the listener of a page opened while the folder was being hidden.
        if (!superseded()) changes.stop();
        settingsViewer.style.display = 'none';
        document.getElementById('placeholder').style.display = 'flex';
        if (typeof loadProjects === 'function') loadProjects();
      });
    }
  }

  // Expose globally
  window.openSettingsViewer = openSettingsViewer;
  window.closeSettingsViewer = closeSettingsViewer;
})();
