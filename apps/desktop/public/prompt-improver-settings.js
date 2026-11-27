// prompt-improver-settings.js — the Prompt improver section of the app's
// Settings (settings-panel.js calls renderPromptImproverSettings), and the
// window where the improver prompt is edited.
//
// Each change applies at once (set-prompt-improver-settings, the main
// process checks it with the shared model) and reaches the phones; the
// panel's Save button is not needed. The editor shows only the improver
// prompt: the context the app adds after it (the session's last turns, its
// commands, skills and MCP servers) is built at each run and not shown.

const PI_CLI_OPTIONS = [
  { value: 'session', label: 'The session\'s CLI' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
];

function piEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function piField(label, help, control, wide = false) {
  return `<div class="settings-field${wide ? ' settings-field-wide' : ''}">
      <div class="settings-field-info">
        <span class="settings-label">${piEsc(label)}</span>
        <div class="settings-description">${help}</div>
      </div>
      <div class="settings-field-control">${control}</div>
    </div>`;
}

/** The section's HTML for `info` = { settings, defaultTemplate, clis }. */
function promptImproverSettingsHtml(info) {
  const s = info.settings;
  const clis = info.clis || [];
  const toggle = (key, on) => `<label class="settings-toggle"><input type="checkbox" data-pi="${key}" ${on ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>`;
  const engine = `<select class="settings-select" data-pi="engine">${PI_CLI_OPTIONS
    .filter((o) => o.value === 'session' || clis.includes(o.value) || o.value === s.engine)
    .map((o) => `<option value="${o.value}"${o.value === s.engine ? ' selected' : ''}>${piEsc(o.label)}</option>`).join('')}</select>`;
  const context = `<select class="settings-select" data-pi="context">
      <option value="recent"${s.context === 'recent' ? ' selected' : ''}>The prompt and the last turns</option>
      <option value="none"${s.context === 'none' ? ' selected' : ''}>The prompt only</option>
    </select>`;
  const models = ['claude', 'codex', 'opencode'].map((cli) => `<label class="pi-model"><span>${piEsc(window.PromptImproverModel.cliLabel(cli))}</span>
      <input type="text" class="settings-input settings-input-compact" data-pi-model="${cli}" value="${piEsc(s.models[cli])}" placeholder="CLI's default" spellcheck="false"></label>`).join('');
  const custom = !!s.template;
  return `<div class="settings-section-title">Prompt improver</div>
    ${piField('Prompt improver', 'A button next to Commands in a session (and on the phone, next to “/”) rewrites the prompt you are writing, with the commands, skills and MCP servers the session has. It runs the CLI you are signed in to, once and out of sight, on your subscription: no API key. The prompt is never sent for you.', toggle('enabled', s.enabled))}
    ${piField('Ask first on the phone', 'The phone asks before improving. On the desktop the Improve window is the question.', toggle('confirm', s.confirm))}
    ${piField('CLI that rewrites', 'Who rewrites the prompt. The commands and skills offered are always those of the session the prompt is for.', engine)}
    ${piField('Context', 'With the last turns, the rewrite knows what the conversation is about.', context)}
    ${piField('Last turns', 'How many messages of the conversation go with the prompt (0 to 20).', `<input type="number" class="settings-input settings-input-compact" data-pi="recentTurns" min="0" max="20" value="${s.recentTurns}">`)}
    ${piField('Models', 'A model for each CLI, as the CLI names it (for example sonnet, gpt-5, opencode/big-pickle). Empty: the CLI\'s default.', `<div class="pi-models">${models}</div>`, true)}
    ${piField('Time limit', 'Seconds before a run is stopped (20 to 600).', `<input type="number" class="settings-input settings-input-compact" data-pi="timeoutSec" min="20" max="600" value="${s.timeoutSec}">`)}
    ${piField('Improver prompt', `The instructions the CLI follows to rewrite a prompt. ${custom ? 'Yours.' : 'The default one.'} The context the app adds after it is not shown in the editor.`,
      `<div class="pi-template-actions"><button type="button" class="settings-check-updates-btn" data-pi-act="edit">Edit improver prompt…</button>${custom ? '<button type="button" class="settings-check-updates-btn" data-pi-act="reset">Reset to default</button>' : ''}</div>`)}
    <div class="pi-settings-error" role="alert" hidden></div>`;
}

/** Fill `section` and keep it in step with changes made elsewhere (a phone, the editor). */
async function renderPromptImproverSettings(section) {
  if (!section || !window.api.getPromptImproverSettings) return;
  let info;
  try {
    info = await window.api.getPromptImproverSettings();
  } catch {
    section.hidden = true;
    return;
  }
  const draw = () => {
    section.innerHTML = promptImproverSettingsHtml(info);
    wire();
  };
  const showError = (message) => {
    const box = section.querySelector('.pi-settings-error');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  };
  const save = async (changes) => {
    const res = await window.api.setPromptImproverSettings(changes);
    if (!res || !res.ok) { showError((res && res.error) || 'Not saved.'); return false; }
    info = { ...info, settings: res.settings };
    showError('');
    return true;
  };
  function wire() {
    for (const input of section.querySelectorAll('[data-pi]')) {
      input.addEventListener('change', async () => {
        const key = input.dataset.pi;
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (input.type === 'number') value = parseInt(value, 10);
        if (!(await save({ [key]: value }))) draw();
      });
    }
    for (const input of section.querySelectorAll('[data-pi-model]')) {
      input.addEventListener('change', async () => {
        if (!(await save({ models: { [input.dataset.piModel]: input.value.trim() } }))) draw();
      });
    }
    const edit = section.querySelector('[data-pi-act="edit"]');
    if (edit) edit.onclick = () => openPromptTemplateEditor(info, async (template) => {
      const ok = await save({ template });
      if (ok) draw();
      return ok;
    });
    const reset = section.querySelector('[data-pi-act="reset"]');
    if (reset) reset.onclick = async () => { if (await save({ template: null })) draw(); };
  }
  draw();
  section.hidden = false;
  if (window.api.onPromptImproverSettingsChanged && !section._piListening) {
    section._piListening = true;
    window.api.onPromptImproverSettingsChanged((settings) => {
      if (!section.isConnected) return;
      info = { ...info, settings };
      // Not while the user is typing in one of its fields.
      const active = document.activeElement;
      if (!section.contains(active)) { draw(); return; }
      // A whole row with the focus (a search result led there, settings-search.js)
      // holds nothing typed: it is drawn again and keeps the focus.
      const rows = () => [...section.querySelectorAll('.settings-field')];
      const at = rows().indexOf(active);
      if (at < 0) return;
      draw();
      const row = rows()[at];
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
    });
  }
}

/**
 * The window to edit the improver prompt: the app's Markdown editor, the
 * placeholders it understands under it, Reset to default, Save (Cmd/Ctrl+S).
 * `onSave(templateOrNull)` resolves true when saved.
 */
function openPromptTemplateEditor(info, onSave) {
  const M = window.PromptImproverModel;
  const start = info.settings.template || info.defaultTemplate || M.DEFAULT_TEMPLATE;
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay gg-dialog-overlay';
  overlay.innerHTML = `<div class="add-project-dialog gg-dialog pi-dialog pi-template-dialog" role="dialog" aria-modal="true" aria-label="Improver prompt">
      <h3>Improver prompt</h3>
      <div class="gg-dialog-body">
        <div class="pi-template-host"></div>
        <div class="pi-placeholders">${(info.placeholders || M.PLACEHOLDERS).map((p) => `<div><code>${piEsc(p.name)}</code> ${piEsc(p.description)}</div>`).join('')}
          <div>After the prompt the app adds, out of sight: the session's CLI, its last turns and the commands, skills and MCP servers it has, with how to call them and the instruction to use one when it clearly fits the task.</div></div>
      </div>
      <div class="gg-dialog-error" role="alert" hidden></div>
      <div class="add-project-actions">
        <button type="button" class="add-project-cancel-btn" data-act="default">Reset to default</button>
        <span class="pi-spacer"></span>
        <button type="button" class="add-project-cancel-btn" data-act="cancel">Cancel</button>
        <button type="button" class="add-project-add-btn" data-act="save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const host = overlay.querySelector('.pi-template-host');
  let editor = null;
  let area = null;
  if (typeof window.createCodeEditor === 'function') {
    editor = window.createCodeEditor(host, { doc: start, language: 'markdown', wrap: true });
  } else {
    area = document.createElement('textarea');
    area.className = 'gg-field-input pi-text';
    area.value = start;
    host.appendChild(area);
  }
  const text = () => (editor ? window.cmGetText(editor) : area.value);
  const setText = (t) => { if (editor) window.cmSetText(editor, t); else area.value = t; };
  const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  const errorBox = overlay.querySelector('.gg-dialog-error');
  const save = async () => {
    const t = text();
    if (!t.trim()) { errorBox.textContent = 'The improver prompt is empty: Reset to default to start again.'; errorBox.hidden = false; return; }
    if (t.length > M.MAX_TEMPLATE) { errorBox.textContent = `Longer than ${M.MAX_TEMPLATE} characters.`; errorBox.hidden = false; return; }
    const ok = await onSave(t === (info.defaultTemplate || M.DEFAULT_TEMPLATE) ? null : t);
    if (ok) close();
    else { errorBox.textContent = 'Not saved.'; errorBox.hidden = false; }
  };
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
  }
  document.addEventListener('keydown', onKey, true);
  host.addEventListener('cm-save', (e) => { e.stopPropagation(); save(); });
  overlay.querySelector('[data-act="cancel"]').onclick = close;
  overlay.querySelector('[data-act="save"]').onclick = save;
  overlay.querySelector('[data-act="default"]').onclick = () => setText(info.defaultTemplate || M.DEFAULT_TEMPLATE);
  if (editor && editor.focus) editor.focus();
  else if (area) area.focus();
}
