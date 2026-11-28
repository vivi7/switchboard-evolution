// project-env-view.js — the Env tab of a project page: the local.env.sh of
// the project folder and of each attached folder, which a session's shell
// sources before it starts (projects.js envFilesFor, shell-env.js). The
// sidebar lists them; a folder without one has a + that makes it. The rules
// of what a session loads are at the top of the sidebar, in the words the
// phone shows too (env-files-model.js).
//
// One ViewerPanel serves the tab. Its DOM moves between renders, as in the
// Files tab, so an unsaved edit survives the re-render every projects-changed
// event triggers.
//
// Depends on globals from projects-view.js (PICONS, findTreeProject,
// selectedProject, shortPathLabel), project-files-view.js (filesRoots,
// bindFilesDivider), utils.js (escapeHtml, escapeAttr), env-files-model.js
// (EnvFilesModel) and viewer-panel.js.

let envEditor = null; // { host, panel, projectId, dir }
const envTabs = new Map(); // projectId → { selected: folder path, entries, error }

function envTabState(project) {
  let state = envTabs.get(project.id);
  if (!state) {
    state = { selected: project.root, entries: null, error: null };
    envTabs.set(project.id, state);
  }
  return state;
}

function ensureEnvEditor() {
  if (envEditor) return envEditor;
  const host = document.createElement('div');
  host.className = 'ws-editor-panel';
  const panel = new ViewerPanel(host, {
    copyPath: true, copyContent: true, language: 'auto',
    onSave: async (filePath, content, options) => {
      const result = await window.api.saveFileForPanel(filePath, content, options);
      if (!result || result.error || result.ok === false) {
        showEnvError(envEditor?.projectId, result?.error || 'Could not save the file.');
        return { ok: false };
      }
      return { ok: true };
    },
  });
  envEditor = { host, panel, projectId: null, dir: null };
  return envEditor;
}

/**
 * The sidebar's rows: the project folder, then each attached folder in the
 * project's order, with the Files tab's labels, joined with what main knows
 * of each file.
 */
function envEntries(project, state) {
  const known = new Map((state.entries || []).map(entry => [entry.path, entry]));
  return filesRoots(project)
    .map(root => ({ ...root, ...(known.get(root.path) || {}), label: root.label }))
    .filter(entry => known.has(entry.path));
}

function envRowHtml(entry, selected) {
  const icon = entry.kind === 'project' ? PICONS.dashboard(14) : PICONS.folder(14);
  const where = typeof shortPathLabel === 'function' ? shortPathLabel(entry.path) : entry.path;
  const fileName = EnvFilesModel.ENV_FILE_NAME;
  const warn = entry.exists && entry.gitIgnored === false
    ? `<div class="ws-env-warn">Not ignored by Git: it could be committed.
        <button type="button" class="ws-env-exclude" data-path="${escapeAttr(entry.path)}" title="${escapeAttr(`Add /${fileName} to this clone's .git/info/exclude, which is never committed`)}">Ignore in this clone</button></div>`
    : '';
  const action = entry.exists
    ? ''
    : `<button type="button" class="ws-env-create" data-path="${escapeAttr(entry.path)}" title="${escapeAttr(`Create ${fileName} in ${where}`)}" aria-label="${escapeAttr(`Create ${fileName} in ${entry.label}`)}">${PICONS.plus(14)}</button>`;
  return `
    <div class="ws-env-row${selected ? ' selected' : ''}${entry.exists ? '' : ' missing'}" role="listitem" data-path="${escapeAttr(entry.path)}">
      <button type="button" class="ws-env-open" data-path="${escapeAttr(entry.path)}" ${entry.exists ? '' : 'disabled'} title="${escapeAttr(entry.filePath || where)}">
        <span class="ws-env-icon">${icon}</span>
        <span class="ws-env-text">
          <span class="ws-env-label">${escapeHtml(entry.label)}</span>
          <span class="ws-env-file">${entry.exists ? escapeHtml(fileName) : `No ${escapeHtml(fileName)} yet`}</span>
        </span>
      </button>
      ${action}
      ${warn}
    </div>`;
}

function envRulesHtml() {
  return `
    <details class="ws-env-rules" open>
      <summary>How the files load</summary>
      <ul>${EnvFilesModel.ENV_RULES.map(rule => `<li>${escapeHtml(rule)}</li>`).join('')}</ul>
    </details>`;
}

function showEnvError(projectId, message) {
  const project = projectId ? findTreeProject(projectId) : null;
  if (!project) return;
  envTabState(project).error = message;
  const box = projectViewer?.querySelector('#ws-env-error');
  if (box) { box.textContent = message; box.hidden = !message; }
}

async function loadEnvFiles(project) {
  const state = envTabState(project);
  let result;
  try { result = await window.api.projectEnvFiles(project.id); } catch (err) { result = { error: err.message }; }
  if (result?.ok) {
    state.entries = result.entries;
    state.error = null;
  } else {
    state.error = result?.error || 'Could not read the environment files.';
  }
  return state;
}

function paintEnvList(project, body) {
  const state = envTabState(project);
  const list = body.querySelector('#ws-env-list');
  if (!list) return;
  const entries = envEntries(project, state);
  list.innerHTML = entries.map(entry => envRowHtml(entry, entry.path === state.selected)).join('')
    || '<div class="ws-help ws-env-empty">Loading…</div>';
  const error = body.querySelector('#ws-env-error');
  error.textContent = state.error || '';
  error.hidden = !state.error;
  list.querySelectorAll('.ws-env-open').forEach(button => {
    button.onclick = () => openEnvFile(project, body, button.dataset.path);
  });
  list.querySelectorAll('.ws-env-create').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      const result = await window.api.createProjectEnvFile(project.id, button.dataset.path);
      if (!result?.ok) showEnvError(project.id, result?.error || 'Could not create the file.');
      await loadEnvFiles(project);
      if (!body.isConnected) return;
      paintEnvList(project, body);
      if (result?.ok) openEnvFile(project, body, button.dataset.path);
    };
  });
  list.querySelectorAll('.ws-env-exclude').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      const result = await window.api.excludeProjectEnvFile(project.id, button.dataset.path);
      if (!result?.ok) showEnvError(project.id, result?.error || 'Could not change .git/info/exclude.');
      await loadEnvFiles(project);
      if (body.isConnected) paintEnvList(project, body);
    };
  });
}

function paintEnvOrder(body, entry) {
  const line = body.querySelector('#ws-env-order');
  if (!line) return;
  line.textContent = entry ? EnvFilesModel.loadOrderText(entry.kind) : '';
  line.hidden = !entry;
}

async function openEnvFile(project, body, dirPath) {
  const state = envTabState(project);
  const entry = envEntries(project, state).find(item => item.path === dirPath);
  if (!entry?.exists) return;
  const host = body.querySelector('#ws-env-editor');
  if (!host) return;
  const ed = ensureEnvEditor();
  const same = ed.projectId === project.id && ed.dir === dirPath && ed.panel.filePath === entry.filePath;
  if (!same && ed.panel.filePath && !(await ed.panel.confirmLeave())) return;
  state.selected = dirPath;
  body.querySelectorAll('.ws-env-row').forEach(row => row.classList.toggle('selected', row.dataset.path === dirPath));
  paintEnvOrder(body, entry);
  if (same) { host.replaceChildren(ed.host); return; }
  const fileName = EnvFilesModel.ENV_FILE_NAME;
  let result;
  try { result = await window.api.readProjectFile(dirPath, fileName); } catch (err) { result = { ok: false, error: err.message }; }
  if (!host.isConnected || selectedProject()?.id !== project.id || envTabState(project).selected !== dirPath) return;
  if (!result?.ok) {
    host.innerHTML = `<div class="ws-editor-empty">${escapeHtml(result?.error || 'Could not open the file.')}</div>`;
    return;
  }
  ed.projectId = project.id;
  ed.dir = dirPath;
  host.replaceChildren(ed.host);
  ed.panel.open(`${entry.kind === 'project' ? project.name : `${project.name} · ${entry.label}`} · ${fileName}`, result.filePath || entry.filePath, result.content, result);
}

async function renderEnvTab(project, body) {
  body.classList.add('ws-body--files');
  const state = envTabState(project);
  body.innerHTML = `
    <div class="ws-files ws-env">
      <div class="ws-files-side ws-env-side">
        ${envRulesHtml()}
        <div class="ws-env-error" id="ws-env-error" role="alert" hidden></div>
        <div class="ws-env-list" id="ws-env-list" role="list" aria-label="Environment files"></div>
      </div>
      <div class="ws-files-divider" role="separator" aria-label="Resize the list" aria-orientation="vertical" tabindex="0"></div>
      <div class="ws-editor-area ws-env-area">
        <div class="ws-env-order" id="ws-env-order" hidden></div>
        <div class="ws-editor" id="ws-env-editor"><div class="ws-editor-empty">Pick a folder to edit its ${escapeHtml(EnvFilesModel.ENV_FILE_NAME)}.</div></div>
      </div>
    </div>`;
  bindFilesDivider(project, body.querySelector('.ws-files'));
  // The editor belongs to the tab: put back the file that is open.
  const ed = envEditor;
  const reopened = ed?.projectId === project.id && ed.panel.filePath;
  if (reopened) body.querySelector('#ws-env-editor').replaceChildren(ed.host);
  paintEnvList(project, body);
  await loadEnvFiles(project);
  if (!body.isConnected) return;
  paintEnvList(project, body);
  const entries = envEntries(project, state);
  if (!entries.some(entry => entry.path === state.selected && entry.exists)) state.selected = entries.find(entry => entry.exists)?.path || null;
  const current = entries.find(entry => entry.path === state.selected);
  paintEnvOrder(body, current);
  if (reopened && ed.dir === state.selected) return;
  if (current) await openEnvFile(project, body, current.path);
}
