// project-knowledge-view.js — the Node Knowledge tab: the project folder and
// each attached folder of the project as a codebase-memory-mcp (CBM) code graph. The main process
// (knowledge.js) runs CBM and fills in the CBM project of every call; this
// file only names the folder. What CBM answers is read with KnowledgeModel
// (packages/shared/knowledge-model.js), shared with the phone.
//
// The tab has views, switched like the Git tab's (Overview, Search, Trace,
// Impact, Query, ADR, Coverage, Compare, Lens, Settings) and a folder picker
// beside them. Its state lives per project in knowledgeTabs, so a rebuild of
// the page (every projects-changed) draws it again from what it had.

const knowledgeTabs = new Map(); // projectId → state
const KN_VIEW_IDS = KnowledgeModel.VIEWS.map(v => v.id);
// The views drawn by this app; each later file adds its own (knViewRenderers).
const knViewRenderers = {};

function knState(project) {
  let s = knowledgeTabs.get(project.id);
  if (!s) {
    s = { view: 'overview', folder: null, status: null, statusSig: '', statusRequest: 0, loading: false, error: null, stale: true, views: {} };
    knowledgeTabs.set(project.id, s);
  }
  return s;
}

/**
 * The folders the tab offers: the status's (the project folder first, then the
 * attached ones, a root also attached once), else, before it comes, the
 * project folder and the attached ones.
 */
function knFolders(project) {
  const rows = (project.folders || []).filter(f => f && f.path);
  const listed = knowledgeTabs.get(project.id)?.status?.folders;
  if (Array.isArray(listed) && listed.length) {
    // The status's own fields first; a worktree's from the project's row when the status lacks them.
    return listed.filter(f => f && f.path).map(f => {
      const row = rows.find(r => r.path === f.path);
      return row && f.mode !== 'project' ? { ...row, ...f, mode: f.mode || row.mode } : f;
    });
  }
  const attached = rows.filter(f => f.path !== project.root);
  return project.root ? [{ path: project.root, mode: 'project' }, ...attached] : attached;
}

/** The attached folders among them (not the project folder): those "Link now" links. */
function knAttachedFolders(project) {
  return knFolders(project).filter(f => f.mode !== 'project');
}

/** A folder's name in the tab: the project folder says what it is. */
function knFolderLabel(f) {
  return f && f.mode === 'project' ? 'Project folder' : pathBasename(f?.path || '');
}

function knProjectTag(f) {
  return f && f.mode === 'project' ? `<span class="kn-label kn-label--muted" title="${escapeAttr(`${f.path}: the project's own folder (plans, notes, tools), where its sessions start. Its graph keeps out the folders inside it that have one of their own.`)}">project folder</span>` : '';
}

/** What a worktree folder is a checkout of, and what happens to its graph. */
function knWorktreeTitle(f) {
  if (!f || f.mode !== 'worktree') return '';
  const of = f.sourcePath ? ` of ${f.sourcePath}` : '';
  return `Worktree${of}${f.branch ? `, branch ${f.branch}` : ''}. Its code graph is its own: made when it joins a project with the code graph on, deleted when it leaves the project.`;
}

function knWorktreeTag(f) {
  return f && f.mode === 'worktree' ? `<span class="kn-label kn-label--muted" title="${escapeAttr(knWorktreeTitle(f))}">worktree</span>` : '';
}

/**
 * The folder the tab shows: the one picked, else the first attached folder with
 * a graph (the code), else the project folder's graph, else the first attached
 * folder, else the project folder.
 */
function knFolder(project, s = knState(project)) {
  const folders = knFolders(project);
  if (s.folder && folders.some(f => f.path === s.folder)) return s.folder;
  const status = s.status?.folders || [];
  const indexed = (f) => status.some(x => x.path === f.path && x.indexed);
  const attached = folders.filter(f => f.mode !== 'project');
  const pick = attached.find(indexed) || folders.find(indexed) || attached[0] || folders[0];
  return pick ? pick.path : null;
}

function knFolderStatus(s, folderPath) {
  return (s.status?.folders || []).find(f => f.path === folderPath) || null;
}

/** Per view and folder: the view's own cached data. */
function knViewData(s, view, folderPath) {
  const byView = s.views[view] || (s.views[view] = {});
  return byView[folderPath] || (byView[folderPath] = {});
}

function knVisible(project, body) {
  return !!(body && body.isConnected && selectedProject()?.id === project.id && projectTab(project) === 'knowledge');
}

/** A file of a folder as the Files tab names it: relative to the folder. */
function knRelPath(folderPath, file) {
  const f = String(file || '');
  if (!f) return null;
  const root = String(folderPath || '').replace(/[\\/]+$/, '');
  if (root && (f === root || f.startsWith(root + '/') || f.startsWith(root + '\\'))) return f.slice(root.length + 1);
  return f.startsWith('/') ? null : f;
}

function knNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function knStatusSignature(status) {
  if (!status) return '';
  return JSON.stringify([
    status.binary?.found, status.binary?.latest, status.binary?.download, status.client?.running, status.client?.error, status.settings,
    (status.folders || []).map(f => [f.path, f.name, f.indexed, f.index?.indexed_at, f.index?.nodes, f.index?.cross_repo?.status, f.job, f.error]),
    status.error,
  ]);
}

async function knLoadStatus(project) {
  const s = knState(project);
  const request = ++s.statusRequest;
  s.loading = true;
  const result = await window.api.getKnowledgeStatus(project.id);
  if (request !== s.statusRequest) return false;
  s.loading = false;
  s.stale = false;
  if (result?.error) {
    const changed = s.error !== result.error;
    s.error = result.error;
    return changed;
  }
  s.error = null;
  const sig = knStatusSignature(result);
  const changed = sig !== s.statusSig;
  s.status = result;
  s.statusSig = sig;
  return changed;
}

// --- The tab ---

function knSubnavHtml(project, s) {
  const view = s.view;
  const button = (v) => `<button type="button" class="git-workspace-nav-btn${view === v.id ? ' active' : ''}" data-kn-view="${v.id}" role="tab" aria-selected="${view === v.id}">${escapeHtml(v.label)}</button>`;
  const views = KnowledgeModel.VIEWS.filter(v => knViewRenderers[v.id] || v.id === 'overview' || v.id === 'settings');
  const folders = knFolders(project);
  const folder = knFolder(project, s);
  const fstatus = knFolderStatus(s, folder);
  const options = folders.map(f => {
    const st = knFolderStatus(s, f.path);
    const mark = st?.job && KnowledgeModel.jobActive(st.job) ? ' (indexing)' : st?.indexed ? '' : ' (not indexed)';
    const kind = f.mode === 'worktree' ? ' · worktree' : '';
    return `<option value="${escapeAttr(f.path)}"${f.path === folder ? ' selected' : ''}>${escapeHtml(knFolderLabel(f))}${kind}${mark}</option>`;
  }).join('');
  let meta = '';
  if (fstatus?.job && KnowledgeModel.jobActive(fstatus.job)) meta = `<span class="kn-busy" aria-hidden="true"></span>${escapeHtml(KnowledgeModel.jobText(fstatus.job))}`;
  else if (fstatus?.indexed && fstatus.index) {
    const sum = KnowledgeModel.indexSummary(fstatus.index);
    meta = `${knNumber(sum.nodes)} nodes · ${knNumber(sum.edges)} links${sum.indexedAt ? ` · ${escapeHtml(KnowledgeModel.ago(sum.indexedAt))}` : ''}`;
  }
  return `<div class="git-workspace-subnav kn-subnav">
    <div class="git-workspace-nav kn-nav" role="tablist" aria-label="Node Knowledge view">${views.map(button).join('')}</div>
    <div class="kn-subnav-side">
      ${folders.length > 1 ? `<select class="ws-select kn-folder-select" aria-label="Folder">${options}</select>` : folders.length ? `<span class="kn-folder-one" title="${escapeAttr(folder)}">${PICONS.folder(12)}${escapeHtml(knFolderLabel(folders.find(f => f.path === folder)))}</span>` : ''}
      ${meta ? `<span class="kn-subnav-meta">${meta}</span>` : ''}
      ${fstatus?.indexed ? `<button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="reindex" title="Read the folder again (only what changed)">${PICONS.refresh(12)}<span>Refresh</span></button>` : ''}
    </div>
  </div>`;
}

/**
 * What decides which page the view shows (the gate) or that Overview and
 * Settings, which show the status itself, must be drawn again. A change in
 * anything else (a refresh's job, when a folder was indexed) only redraws
 * the bar, so what is typed in a view and its focus stay.
 */
function knGateSignature(project, s) {
  const folder = knFolder(project, s);
  const f = knFolderStatus(s, folder);
  const st = s.status;
  return JSON.stringify([
    s.error, !!st, st?.binary?.found?.ok, st?.binary?.download, st?.client?.halted, knFolders(project).length, folder,
    !!f?.indexed, !!(f?.job && KnowledgeModel.jobActive(f.job) && !f.indexed), !f?.indexed && f?.job?.state === 'failed',
  ]);
}

function knWireSubnav(project, body) {
  const s = knState(project);
  body.querySelectorAll('[data-kn-view]').forEach(btn => {
    btn.onclick = () => {
      if (s.view === btn.dataset.knView) return;
      s.view = btn.dataset.knView;
      renderKnowledgeTab(project, body);
    };
  });
  const select = body.querySelector('.kn-folder-select');
  if (select) select.onchange = () => { s.folder = select.value; renderKnowledgeTab(project, body); };
  const reindex = body.querySelector('[data-kn-act="reindex"]');
  if (reindex) reindex.onclick = () => knIndex(project, knFolder(project, s), body);
}

/** Draw the tab into the project page's body. */
function renderKnowledgeTab(project, body) {
  const s = knState(project);
  if (!KN_VIEW_IDS.includes(s.view) || (!knViewRenderers[s.view] && s.view !== 'overview' && s.view !== 'settings')) s.view = 'overview';
  body.className = 'ws-body git-workspace-body kn-body';
  // The bar of the views keeps where it was scrolled to when the tab is drawn again.
  const navScroll = body.querySelector('.kn-nav')?.scrollLeft || 0;
  body.innerHTML = `${knSubnavHtml(project, s)}<div class="git-workspace-view kn-view" id="kn-view" role="tabpanel"></div>`;
  knWireSubnav(project, body);
  bindScrollingTabs(body.querySelector('.kn-nav'), '.git-workspace-nav-btn.active', navScroll);
  s.gateSig = knGateSignature(project, s);
  knRenderView(project, body.querySelector('#kn-view'), body);
  if (s.stale || !s.status) {
    knLoadStatus(project).then(changed => {
      if (changed && knVisible(project, body)) knStatusChanged(project);
    }).catch(() => {});
  }
}

function knRedraw(project) {
  const body = projectViewer?.querySelector('#ws-body.kn-body');
  if (body && knVisible(project, body)) renderKnowledgeTab(project, body);
}

/** After the status changed: the whole tab when the gate or a status view needs it, else only the bar. */
function knStatusChanged(project) {
  const body = projectViewer?.querySelector('#ws-body.kn-body');
  if (!body || !knVisible(project, body)) return;
  const s = knState(project);
  const bar = body.querySelector('.kn-subnav');
  if (!bar || s.view === 'overview' || s.view === 'settings' || knGateSignature(project, s) !== s.gateSig) {
    renderKnowledgeTab(project, body);
    return;
  }
  const holder = document.createElement('div');
  holder.innerHTML = knSubnavHtml(project, s);
  // The views stay as they are, scrolled where they were; what is beside them is new.
  bar.querySelector('.kn-subnav-side').replaceWith(holder.querySelector('.kn-subnav-side'));
  knWireSubnav(project, body);
}

/** Where the tab is not usable yet: no CBM, an old one, no folders, a folder without a graph. */
function knGateHtml(project, s, folder) {
  if (s.error) return knNoticeHtml('Node Knowledge could not start', s.error, `<button type="button" class="ws-btn" data-kn-act="restart">${PICONS.refresh(12)}<span>Try again</span></button>`);
  const status = s.status;
  if (!status) return `<div class="kn-loading">Looking for codebase-memory-mcp…</div>`;
  const bin = status.binary || {};
  if (!bin.found || !bin.found.ok) return knSetupHtml(bin);
  if (status.client?.halted) {
    return knNoticeHtml('codebase-memory-mcp keeps stopping', status.client.error || '', `<button type="button" class="ws-btn" data-kn-act="restart">${PICONS.refresh(12)}<span>Start it again</span></button>`);
  }
  if (!knFolders(project).length) {
    return knNoticeHtml('No folders to index', 'Node Knowledge turns the project folder and each folder attached to the project into a code graph. Attach the repositories this project works in.', `<button type="button" class="ws-btn ws-btn--primary" data-kn-act="attach">${PICONS.plus(12)}<span>Attach folder…</span></button>`);
  }
  if (s.view === 'settings' || s.view === 'lens') return null;
  const fstatus = knFolderStatus(s, folder);
  // Only a first index hides the view; a refresh of a graph there is shown in the bar.
  if (fstatus?.job && KnowledgeModel.jobActive(fstatus.job) && !fstatus.indexed) {
    return `<div class="kn-notice kn-notice--busy"><div class="kn-notice-title"><span class="kn-busy" aria-hidden="true"></span>${escapeHtml(KnowledgeModel.jobText(fstatus.job))}</div>
      <div class="kn-notice-text">codebase-memory-mcp is reading <span class="mono">${escapeHtml(pathBasename(folder))}</span>. A large repository takes a minute or two the first time; afterwards only what changed is read again.</div></div>`;
  }
  if (!fstatus?.indexed) {
    const failed = fstatus?.job?.state === 'failed' ? `<div class="kn-notice-error">${escapeHtml(KnowledgeModel.jobText(fstatus.job))}</div>` : '';
    const mode = status.settings?.mode || 'full';
    const modes = KnowledgeModel.INDEX_MODES.map(m => `<option value="${m.id}"${m.id === mode ? ' selected' : ''}>${escapeHtml(m.label)} · ${escapeHtml(m.hint)}</option>`).join('');
    return `<div class="kn-notice">
      <div class="kn-notice-title">${escapeHtml(pathBasename(folder))} has no code graph yet</div>
      <div class="kn-notice-text">Indexing reads the source of <span class="mono">${escapeHtml(folder)}</span> into a graph of its functions, classes, routes and the calls between them, kept by codebase-memory-mcp on this computer. The graph stays there.</div>
      ${failed}
      <div class="kn-notice-actions">
        <select class="ws-select" data-kn-field="mode" aria-label="Index mode">${modes}</select>
        <button type="button" class="ws-btn ws-btn--primary" data-kn-act="index">${PICONS.play(12)}<span>Index ${escapeHtml(pathBasename(folder))}</span></button>
        ${knFolders(project).length > 1 ? `<button type="button" class="ws-btn" data-kn-act="index-all">Index every folder</button>` : ''}
      </div>
    </div>`;
  }
  return null;
}

function knNoticeHtml(title, text, actions = '') {
  return `<div class="kn-notice"><div class="kn-notice-title">${escapeHtml(title)}</div>${text ? `<div class="kn-notice-text">${escapeHtml(text)}</div>` : ''}${actions ? `<div class="kn-notice-actions">${actions}</div>` : ''}</div>`;
}

function knSetupHtml(bin) {
  const found = bin.found;
  const dl = bin.download;
  const step = dl && !dl.error ? { download: 'Downloading…', verify: 'Checking the download…', install: 'Installing…' }[dl.step] || 'Working…' : null;
  const title = found ? `codebase-memory-mcp ${found.version} is too old` : 'Node Knowledge needs codebase-memory-mcp';
  const text = found
    ? `This tab needs ${bin.minimum} or later. The one found is at ${found.path}.`
    : `codebase-memory-mcp indexes a repository into a code graph on this computer (MIT, by DeusData). Switchboard uses the one your coding agents use; none was found.`;
  const actions = step
    ? `<span class="kn-busy" aria-hidden="true"></span><span class="kn-notice-step">${escapeHtml(step)}</span>`
    : `${bin.canDownload ? `<button type="button" class="ws-btn ws-btn--primary" data-kn-act="download">${PICONS.play(12)}<span>${found ? 'Update' : 'Download and install'} ${escapeHtml(bin.pinned)}</span></button>` : ''}
       <button type="button" class="ws-btn" data-kn-act="pick-binary">Choose the program…</button>
       <button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="releases">${PICONS.globe(12)}<span>Releases</span></button>`;
  return `<div class="kn-notice">
    <div class="kn-notice-title">${escapeHtml(title)}</div>
    <div class="kn-notice-text">${escapeHtml(text)}</div>
    ${bin.canDownload && !found ? `<div class="kn-notice-text muted">The download is checked against the release's checksums and installed into <span class="mono">${escapeHtml(bin.installDir)}</span>, where CBM's own installer puts it, without changing any agent's configuration.</div>` : ''}
    ${dl?.error ? `<div class="kn-notice-error">${escapeHtml(dl.error)}</div>` : ''}
    <div class="kn-notice-actions">${actions}</div>
  </div>`;
}

function knRenderView(project, view, body) {
  const s = knState(project);
  const folder = knFolder(project, s);
  const gate = knGateHtml(project, s, folder);
  if (gate) {
    view.innerHTML = `<div class="kn-page">${gate}</div>`;
    knWireGate(project, view, body, folder);
    return;
  }
  if (s.view === 'settings') renderKnowledgeSettings(project, view, body);
  else if (s.view !== 'overview' && knViewRenderers[s.view]) knViewRenderers[s.view](project, view, folder, body);
  else renderKnowledgeOverview(project, view, folder, body);
}

function knWireGate(project, view, body, folder) {
  const on = (act, fn) => view.querySelectorAll(`[data-kn-act="${act}"]`).forEach(el => { el.onclick = fn; });
  on('attach', () => attachFolderAsk(project));
  on('index', () => knIndex(project, folder, body, view.querySelector('[data-kn-field="mode"]')?.value));
  on('index-all', () => knIndexAll(project, body, view.querySelector('[data-kn-field="mode"]')?.value));
  on('download', () => knDownload(project));
  on('pick-binary', () => knPickBinary(project));
  on('releases', () => window.api.openExternal(knState(project).status?.binary?.releasePage || 'https://github.com/DeusData/codebase-memory-mcp/releases'));
  on('restart', async () => { await window.api.knowledgeRestart(); knState(project).stale = true; knRedraw(project); });
}

// --- Actions ---

function knToastError(result) {
  if (result?.error) {
    alert(result.error);
    return true;
  }
  return false;
}

async function knIndex(project, folder, body, mode) {
  if (!folder) return;
  const s = knState(project);
  const result = await window.api.knowledgeIndex(project.id, folder, mode ? { mode } : {});
  if (knToastError(result)) return;
  s.stale = true;
  await knLoadStatus(project);
  if (knVisible(project, body)) renderKnowledgeTab(project, body);
}

async function knIndexAll(project, body, mode) {
  const result = await window.api.knowledgeIndexAll(project.id, mode ? { mode } : {});
  if (knToastError(result)) return;
  knState(project).stale = true;
  await knLoadStatus(project);
  if (knVisible(project, body)) renderKnowledgeTab(project, body);
}

async function knDownload(project) {
  const pending = window.api.knowledgeDownloadBinary();
  knState(project).stale = true;
  setTimeout(() => knRedraw(project), 100);
  const result = await pending;
  knState(project).stale = true;
  if (result?.error) await knLoadStatus(project);
  knRedraw(project);
}

async function knPickBinary(project) {
  const result = await window.api.knowledgePickBinary();
  if (result?.canceled) return;
  if (knToastError(result)) return;
  knState(project).stale = true;
  knRedraw(project);
}

/**
 * Open a folder's file in the Files tab, at a line when given. The Files tab
 * opens its selected file when it draws, so the file is selected first and
 * the line is picked once the editor shows it.
 */
async function knOpenInFiles(project, folderPath, file, line) {
  const rel = knRelPath(folderPath, file);
  if (!rel) return;
  filesUi(project).root = folderPath;
  filesState(project, folderPath).selected = rel;
  showProjectTab(project, 'files');
  const showing = () => {
    const ed = typeof projectEditors !== 'undefined' ? projectEditors.get(project.id) : null;
    return ed && ed.root === folderPath && ed.rel === rel && ed.panel?.editorView ? ed : null;
  };
  for (let i = 0; i < 80; i++) {
    const ed = showing();
    if (ed) {
      if (line) ed.panel.selectRange(Number(line), 0, 0);
      return;
    }
    if (i === 8) openFileInProjectEditor(project, rel, { root: folderPath });
    await new Promise(r => setTimeout(r, 50));
  }
}

/** A symbol by qualified name: its file and first line come from get_code_snippet. */
async function knOpenQn(project, folderPath, qn) {
  const r = await window.api.knowledgeQuery(project.id, folderPath, 'get_code_snippet', { qualified_name: qn, source_mode: 'outline', max_lines: 1 });
  if (knToastError(r)) return;
  const amb = KnowledgeModel.ambiguity(r);
  const target = amb ? amb.suggestions[0] : KnowledgeModel.snippetModel(r);
  if (target?.file) knOpenInFiles(project, folderPath, target.file, target.start);
}

// --- Overview ---

function knFolderCardHtml(project, s, f) {
  const st = knFolderStatus(s, f.path) || {};
  const job = st.job;
  const busy = job && KnowledgeModel.jobActive(job);
  const sum = st.indexed && st.index ? KnowledgeModel.indexSummary(st.index) : null;
  const gaps = sum ? sum.gaps : null;
  const gapText = gaps && (gaps.files || gaps.partial || gaps.unusable)
    ? `${gaps.files ? `${knNumber(gaps.files)} files left out` : ''}${gaps.partial ? `${gaps.files ? ' · ' : ''}${knNumber(gaps.partial)} read in part` : ''}${gaps.unusable ? ` · ${knNumber(gaps.unusable)} unreadable` : ''}`
    : '';
  const cross = sum?.crossRepo;
  const crossText = cross && cross.status === 'ran'
    ? `Linked with ${cross.targets.length ? cross.targets.map(t => escapeHtml(t)).join(', ') : 'nothing'} · ${knNumber(cross.edges)} cross-repo calls`
    : '';
  let line;
  if (busy) line = `<span class="kn-busy" aria-hidden="true"></span>${escapeHtml(KnowledgeModel.jobText(job))}`;
  else if (sum) line = `${knNumber(sum.nodes)} nodes · ${knNumber(sum.edges)} links${sum.indexedAt ? ` · indexed ${escapeHtml(KnowledgeModel.ago(sum.indexedAt))}` : ''}`;
  else if (job?.state === 'failed') line = `<span class="kn-error-text">${escapeHtml(KnowledgeModel.jobText(job))}</span>`;
  else line = 'Not indexed';
  const current = f.path === knFolder(project, s);
  return `<div class="ws-card kn-folder-card${current ? ' kn-folder-card--current' : ''}" data-kn-folder="${escapeAttr(f.path)}">
    <div class="ws-card-h">
      ${PICONS.folder(13)}
      <span class="ws-card-title" title="${escapeAttr(f.path)}">${escapeHtml(knFolderLabel(f))}</span>
      ${knWorktreeTag(f)}${knProjectTag(f)}
      ${st.name && st.name !== pathBasename(f.path) ? `<span class="ws-card-meta mono" title="The name codebase-memory-mcp knows it by">${escapeHtml(st.name)}</span>` : ''}
      <span class="kn-spacer"></span>
      ${busy ? '' : `<button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="index-folder" title="${sum ? 'Read the folder again (only what changed)' : 'Build its code graph'}">${sum ? PICONS.refresh(11) : PICONS.play(11)}<span>${sum ? 'Refresh' : 'Index'}</span></button>`}
    </div>
    <div class="ws-card-text kn-folder-line">${line}</div>
    ${crossText ? `<div class="ws-card-text muted">${crossText}</div>` : ''}
    ${gapText ? `<div class="ws-card-text muted" title="See the Coverage view">${escapeHtml(gapText)}</div>` : ''}
    ${st.inner?.length ? `<div class="ws-card-text muted" title="See the Coverage view">${knNumber(st.inner.length)} other graph${st.inner.length === 1 ? '' : 's'} of folders inside it repeat${st.inner.length === 1 ? 's' : ''} part of this one</div>` : ''}
  </div>`;
}

const KN_COLUMN_LABELS = { qn: 'symbol', fan_in: 'called by', fan_out: 'calls out', top_nodes: 'main symbols' };

function knTableHtml(columns, rows, { qnColumn = null, fileColumn = null, max = 50 } = {}) {
  if (!rows.length) return '<div class="ws-card-text muted">None</div>';
  const head = columns.map(c => `<th>${escapeHtml(KN_COLUMN_LABELS[c] || c.replace(/_/g, ' '))}</th>`).join('');
  const body = rows.slice(0, max).map((row, i) => `<tr${qnColumn || fileColumn ? ` class="kn-row-link" data-kn-row="${i}"` : ''}>${columns.map(c => {
    const v = row[c];
    const text = c === qnColumn ? KnowledgeModel.shortName(v) : KnowledgeModel.cellText(Array.isArray(v) ? v.join(', ') : v);
    const title = c === qnColumn ? ` title="${escapeAttr(String(v))}"` : '';
    return `<td${title}>${escapeHtml(text)}</td>`;
  }).join('')}</tr>`).join('');
  const more = rows.length > max ? `<div class="ws-card-text muted">${knNumber(rows.length - max)} more</div>` : '';
  return `<div class="kn-table-wrap"><table class="kn-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

function knBarsHtml(rows, key, valueKey) {
  const max = Math.max(1, ...rows.map(r => Number(r[valueKey]) || 0));
  return `<div class="kn-bars">${rows.slice(0, 12).map(r => {
    const value = Number(r[valueKey]) || 0;
    return `<div class="kn-bar-row"><span class="kn-bar-label">${escapeHtml(String(r[key]))}</span><span class="kn-bar"><span class="kn-bar-fill" style="width:${Math.max(2, Math.round(value / max * 100))}%"></span></span><span class="kn-bar-value">${knNumber(value)}</span></div>`;
  }).join('')}</div>`;
}

const KN_ARCH_HINTS = {
  languages: 'Files per language',
  packages: 'Packages by size, with the calls into and out of them',
  entry_points: 'Where the program starts',
  hotspots: 'The most called code: a change here reaches far',
  routes: 'HTTP routes and their handlers',
  layers: 'How the code splits into layers',
  boundaries: 'Calls between packages',
  clusters: 'Groups of code that call each other most',
};

function knArchitectureHtml(arch) {
  const cards = [];
  for (const sec of arch.sections) {
    if (sec.id === 'node_labels' || sec.id === 'edge_types') continue;
    let content;
    if (sec.id === 'languages') content = knBarsHtml(sec.rows, 'language', 'files');
    else if (sec.id === 'clusters') content = knTableHtml(['label', 'members', 'top_nodes'], sec.rows, { max: 20 });
    else if (sec.id === 'entry_points') content = knTableHtml(['qn', 'file'], sec.rows, { qnColumn: 'qn', max: 30 });
    else if (sec.id === 'hotspots') content = knTableHtml(['qn', 'fan_in'], sec.rows, { qnColumn: 'qn', max: 30 });
    else content = knTableHtml(sec.columns, sec.rows, { max: 30 });
    cards.push(`<div class="ws-card kn-arch-card" data-kn-section="${sec.id}">
      <div class="ws-card-h"><span class="ws-card-title">${escapeHtml(sec.title)}</span><span class="ws-card-meta">${escapeHtml(KN_ARCH_HINTS[sec.id] || '')}</span></div>
      ${content}
    </div>`);
  }
  return cards.join('');
}

function knSchemaHtml(schema) {
  const chips = (list, key) => list.map(x => `<span class="kn-chip"><span>${escapeHtml(x[key])}</span><b>${knNumber(x.count)}</b></span>`).join('');
  return `<div class="ws-card kn-arch-card kn-arch-card--wide">
    <div class="ws-card-h"><span class="ws-card-title">What the graph holds</span><span class="ws-card-meta">Kinds of nodes and links; the Query view asks about them in Cypher</span></div>
    <div class="kn-chips">${chips(schema.labels, 'label')}</div>
    <div class="kn-chips kn-chips--edges">${chips(schema.edges, 'type')}</div>
  </div>`;
}

async function knLoadOverview(project, folder, data, generation) {
  data.loading = true;
  data.generation = generation;
  const [arch, schema] = await Promise.all([
    window.api.knowledgeQuery(project.id, folder, 'get_architecture', { aspects: ['overview'] }),
    window.api.knowledgeQuery(project.id, folder, 'get_graph_schema', { limit: 100 }),
  ]);
  data.loading = false;
  data.error = arch?.error || schema?.error || null;
  data.arch = arch?.error ? null : KnowledgeModel.architectureModel(arch);
  data.schema = schema?.error ? null : KnowledgeModel.schemaModel(schema);
}

function renderKnowledgeOverview(project, view, folder, body) {
  const s = knState(project);
  const fstatus = knFolderStatus(s, folder);
  const generation = fstatus?.index?.indexed_at || '';
  const data = knViewData(s, 'overview', folder);
  const folders = knFolders(project);
  let archHtml;
  if (data.error) archHtml = `<div class="kn-notice-error">${escapeHtml(data.error)}</div>`;
  else if (!data.arch) archHtml = '<div class="kn-loading">Reading the architecture…</div>';
  else archHtml = `${knArchitectureHtml(data.arch)}${data.schema ? knSchemaHtml(data.schema) : ''}`;
  const cycles = data.cycles;
  const cyclesHtml = cycles
    ? `<div class="ws-card kn-arch-card kn-arch-card--wide"><div class="ws-card-h"><span class="ws-card-title">Call cycles</span><span class="ws-card-meta">${cycles.cyclesTotal == null ? '' : `${knNumber(cycles.cyclesTotal)} found`}</span></div>
        ${cycles.cycles.length ? `<div class="kn-cycles">${cycles.cycles.slice(0, 40).map(c => `<div class="kn-cycle">${c.members.map(m => `<button type="button" class="kn-sym-link" data-kn-qn="${escapeAttr(m)}" title="${escapeAttr(m)}">${escapeHtml(KnowledgeModel.shortName(m))}</button>`).join('<span class="kn-arrow">→</span>')}<span class="kn-arrow">↺</span></div>`).join('')}</div>` : '<div class="ws-card-text muted">No functions call each other in a circle.</div>'}
      </div>`
    : '';
  view.innerHTML = `<div class="kn-page">
    <div class="kn-section-title">${folders.length > 1 ? 'Folders' : 'Folder'}</div>
    <div class="kn-folder-grid">${folders.map(f => knFolderCardHtml(project, s, f)).join('')}</div>
    <div class="kn-section-title"><span>Architecture of ${escapeHtml(pathBasename(folder))}</span>
      <span class="kn-title-actions">
        ${typeof knAskAgentButtonHtml === 'function' ? knAskAgentButtonHtml('explore') : ''}
        <button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="cycles"${data.cyclesLoading ? ' disabled' : ''}>${data.cyclesLoading ? 'Looking…' : 'Find call cycles'}</button>
      </span>
    </div>
    ${cyclesHtml}
    <div class="kn-arch-grid">${archHtml}</div>
  </div>`;

  view.querySelectorAll('.kn-folder-card').forEach(card => {
    const path = card.dataset.knFolder;
    card.querySelector('[data-kn-act="index-folder"]')?.addEventListener('click', (e) => { e.stopPropagation(); knIndex(project, path, body); });
    card.onclick = () => { if (path !== knFolder(project, s)) { s.folder = path; renderKnowledgeTab(project, body); } };
  });
  view.querySelector('[data-kn-act="cycles"]').onclick = async () => {
    data.cyclesLoading = true;
    renderKnowledgeOverview(project, view, folder, body);
    const r = await window.api.knowledgeQuery(project.id, folder, 'get_architecture', { aspects: ['cycles'] });
    data.cyclesLoading = false;
    data.cycles = r?.error ? { cycles: [], cyclesTotal: null } : KnowledgeModel.architectureModel(r);
    if (r?.error) data.error = r.error;
    if (view.isConnected) renderKnowledgeOverview(project, view, folder, body);
  };
  view.querySelectorAll('[data-kn-qn]').forEach(btn => { btn.onclick = () => knShowSymbol(project, folder, btn.dataset.knQn); });
  if (typeof knWireAskAgent === 'function') knWireAskAgent(project, view, folder, {});
  if (data.arch) {
    for (const sec of data.arch.sections) {
      const card = view.querySelector(`[data-kn-section="${sec.id}"]`);
      card?.querySelectorAll('[data-kn-row]').forEach(tr => {
        const row = sec.rows[Number(tr.dataset.knRow)];
        tr.onclick = () => (row?.qn ? knShowSymbol(project, folder, row.qn) : row?.file ? knOpenInFiles(project, folder, row.file) : null);
      });
    }
  }
  if ((!data.arch && !data.loading && !data.error) || (data.generation !== generation && !data.loading)) {
    knLoadOverview(project, folder, data, generation).then(() => {
      if (view.isConnected && knVisible(project, body) && knFolder(project, s) === folder && s.view === 'overview') renderKnowledgeOverview(project, view, folder, body);
    });
  }
}

/** A symbol from anywhere in the tab: the Search view's panel when it exists, else its file. */
function knShowSymbol(project, folder, qn) {
  if (typeof knOpenSymbolPanel === 'function') knOpenSymbolPanel(project, folder, qn);
  else knOpenQn(project, folder, qn);
}

// --- Settings ---

function knSwitchHtml(id, on, label) {
  return `<label class="ws-check ws-check--switch"><input type="checkbox" class="ws-switch-input" id="${id}"${on ? ' checked' : ''}><span class="ws-switch"></span>${label ? escapeHtml(label) : ''}</label>`;
}

function renderKnowledgeSettings(project, view, body) {
  const s = knState(project);
  const status = s.status || {};
  const settings = status.settings || {};
  const bin = status.binary || {};
  const found = bin.found;
  const folders = knFolders(project);
  const modeOptions = KnowledgeModel.INDEX_MODES.map(m => `<option value="${m.id}"${m.id === settings.mode ? ' selected' : ''}>${escapeHtml(m.label)}</option>`).join('');
  const modeHint = (KnowledgeModel.INDEX_MODES.find(m => m.id === settings.mode) || KnowledgeModel.INDEX_MODES[0]).hint;
  const sourceText = { override: 'from SWITCHBOARD_CBM', settings: 'chosen in Switchboard', agents: 'the one your agents use', installed: 'installed on this computer' }[found?.source] || '';
  const folderRows = folders.map(f => {
    const st = knFolderStatus(s, f.path) || {};
    const busy = st.job && KnowledgeModel.jobActive(st.job);
    return `<div class="ws-row kn-set-folder" data-kn-folder="${escapeAttr(f.path)}">
      <div class="ws-row-k"><b>${escapeHtml(knFolderLabel(f))}${knWorktreeTag(f)}${knProjectTag(f)}</b><span class="mono" title="${escapeAttr(f.path)}">${escapeHtml(st.name ? `CBM name: ${st.name}` : 'Not indexed yet')}</span></div>
      <div class="ws-row-v">
        ${f.mode === 'project' ? '' : `<label class="ws-check" title="Write the graph to .codebase-memory/graph.db.zst in the repository at each index, so a teammate who clones it starts from it"><input type="checkbox" data-kn-share${st.shared ? ' checked' : ''}>Share with the team</label>`}
        <button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="ignore" title="The files codebase-memory-mcp leaves out (.cbmignore, as .gitignore)">${PICONS.file(11)}<span>Ignore rules</span></button>
        ${busy ? `<span class="kn-busy" aria-hidden="true"></span><span class="ws-help">${escapeHtml(KnowledgeModel.jobText(st.job))}</span>` : `<button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="index-folder">${st.indexed ? PICONS.refresh(11) : PICONS.play(11)}<span>${st.indexed ? 'Re-index' : 'Index'}</span></button>`}
        ${st.indexed && f.mode !== 'project' ? '<button type="button" class="ws-link-danger" data-kn-act="delete">Delete graph…</button>' : ''}
      </div>
    </div>`;
  }).join('');

  view.innerHTML = `<div class="kn-page"><div class="ws-settings ws-rows kn-settings">
    <div class="ws-sec"><span>Code graph</span><span class="ws-saved" id="kn-set-saved">${PICONS.check(11)}<span>Saved</span></span></div>
    <div class="ws-card">
      <div class="ws-row">
        <div class="ws-row-k"><b>Use the code graph</b><span>On in new projects. Index the project folder and the attached folders (each one that joins it, and those without a graph when you turn this on), one graph each, with a folder inside another left out of the one around it, keep the graphs fresh as the repositories change, tell its agents about them (a Code graph section in CLAUDE.md and AGENTS.md), and give its Claude and Codex sessions the graph's tools. A worktree that joins the project gets a graph of its own, deleted when it leaves.</span></div>
        <div class="ws-row-v">${knSwitchHtml('kn-set-enabled', settings.enabled)}</div>
      </div>
      <div class="ws-row">
        <div class="ws-row-k"><b>Refresh automatically</b><span>After a commit, a checkout or saved files, read the folder again (only what changed).</span></div>
        <div class="ws-row-v">${knSwitchHtml('kn-set-refresh', settings.autoRefresh)}</div>
      </div>
      <div class="ws-row">
        <div class="ws-row-k"><b>How much to read</b><span>${escapeHtml(modeHint)}.</span></div>
        <div class="ws-row-v"><select class="ws-select" id="kn-set-mode">${modeOptions}</select></div>
      </div>
      <div class="ws-row">
        <div class="ws-row-k"><b>Link the repositories</b><span>Find the calls one folder makes into another (HTTP, gRPC, queues) after each index.</span></div>
        <div class="ws-row-v">${knSwitchHtml('kn-set-cross', settings.crossRepo)}<button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="link"${knAttachedFolders(project).length < 2 ? ' disabled title="Needs two attached folders with a graph"' : ''}>${PICONS.link(11)}<span>Link now</span></button></div>
      </div>
    </div>

    <div class="ws-sec">Agents</div>
    <div class="ws-card">
      ${['claude', 'codex'].map(id => {
        const how = status.agents?.[id];
        const name = id === 'claude' ? 'Claude Code' : 'Codex';
        const text = how === 'global' ? `${name} has codebase-memory-mcp in its own config: every session sees the graph.`
          : how === 'session' ? `${name} has no codebase-memory-mcp of its own: ${settings.enabled ? 'Switchboard gives this project\'s sessions the server on their command line.' : 'with the code graph on, Switchboard gives this project\'s sessions the server.'}`
          : 'Needs codebase-memory-mcp.';
        return `<div class="ws-row"><div class="ws-row-k"><b>${name}</b><span>${text}</span></div><div class="ws-row-v"><span class="kn-label${how === 'global' ? '' : ' kn-label--muted'}">${how === 'global' ? 'Its own' : how === 'session' ? 'Per session' : '—'}</span></div></div>`;
      }).join('')}
      <div class="ws-row">
        <div class="ws-row-k"><b>Tools in the sessions</b><span>When Switchboard adds the server: all of CBM's tools, only those that read and analyse, or the few that search and trace.</span></div>
        <div class="ws-row-v"><select class="ws-select" id="kn-set-profile">${KnowledgeModel.TOOL_PROFILES.map(p => `<option value="${p.id}"${p.id === settings.toolProfile ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}</select></div>
      </div>
    </div>

    <div class="ws-sec"><span>Folders</span>${folders.length > 1 ? `<button type="button" class="ws-ghost ws-ghost--sm ws-ghost--accent" data-kn-act="index-all">${PICONS.play(11)}<span>Index every folder</span></button>` : ''}</div>
    <div class="ws-card">${folderRows || '<div class="ws-card-text muted">No folders attached.</div>'}</div>

    <div class="ws-sec">codebase-memory-mcp</div>
    <div class="ws-card">
      <div class="ws-row">
        <div class="ws-row-k"><b>Program</b><span>${found ? `${escapeHtml(found.version)}, ${escapeHtml(sourceText)}` : 'Not found'}</span></div>
        <div class="ws-row-v">${found ? `<span class="mono ws-path ws-path--clip" title="${escapeAttr(found.path)}">${escapeHtml(found.path)}</span>` : ''}<button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="pick-binary">Choose…</button>${found?.source === 'settings' ? '<button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="clear-binary">Use the default</button>' : ''}</div>
      </div>
      ${bin.updateAvailable ? `<div class="ws-row"><div class="ws-row-k"><b>Update</b><span>${escapeHtml(bin.latest)} is out. Every CBM process on this computer must run the same version: update it where your agents get it, or here.</span></div><div class="ws-row-v"><button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="releases">${PICONS.globe(11)}<span>Release notes</span></button></div></div>` : ''}
      <div class="ws-row">
        <div class="ws-row-k"><b>Session</b><span>${status.client?.running ? 'Running' : status.client?.error ? escapeHtml(status.client.error) : 'Starts when the tab asks something'}</span></div>
        <div class="ws-row-v"><button type="button" class="ws-ghost ws-ghost--sm" data-kn-act="restart">${PICONS.refresh(11)}<span>Restart</span></button></div>
      </div>
    </div>
    <div class="ws-foot"><span class="ws-foot-note">Changes save as you make them. The graphs live in codebase-memory-mcp's own folder on this computer; your agents see the same ones.</span></div>
  </div></div>`;

  const q = (sel) => view.querySelector(sel);
  const save = async (patch) => {
    const r = await window.api.setKnowledgeSettings(project.id, patch);
    if (knToastError(r)) return;
    if (s.status) s.status.settings = r.settings;
    flashSaved(q('#kn-set-saved'));
  };
  q('#kn-set-enabled').onchange = (e) => save({ enabled: e.target.checked });
  q('#kn-set-refresh').onchange = (e) => save({ autoRefresh: e.target.checked });
  q('#kn-set-cross').onchange = (e) => save({ crossRepo: e.target.checked });
  q('#kn-set-mode').onchange = (e) => save({ mode: e.target.value }).then(() => knRedraw(project));
  q('#kn-set-profile').onchange = (e) => save({ toolProfile: e.target.value });
  const on = (act, fn) => view.querySelectorAll(`[data-kn-act="${act}"]`).forEach(el => { el.onclick = fn; });
  on('link', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const r = await window.api.knowledgeLinkCrossRepo(project.id);
    btn.disabled = false;
    if (knToastError(r)) return;
    s.stale = true;
    knRedraw(project);
  });
  on('index-all', () => knIndexAll(project, body));
  on('pick-binary', () => knPickBinary(project));
  on('clear-binary', async () => { await window.api.setKnowledgeGlobal({ binaryPath: '' }); s.stale = true; knRedraw(project); });
  on('releases', () => window.api.openExternal(bin.releasePage || 'https://github.com/DeusData/codebase-memory-mcp/releases'));
  on('restart', async () => { await window.api.knowledgeRestart(); s.stale = true; knRedraw(project); });
  view.querySelectorAll('.kn-set-folder').forEach(row => {
    const folder = row.dataset.knFolder;
    const share = row.querySelector('[data-kn-share]');
    if (share) share.onchange = (e) => save({ share: { [folder]: e.target.checked } });
    row.querySelector('[data-kn-act="index-folder"]')?.addEventListener('click', () => knIndex(project, folder, body));
    row.querySelector('[data-kn-act="ignore"]').onclick = () => knEditIgnore(project, folder);
    row.querySelector('[data-kn-act="delete"]')?.addEventListener('click', () => knConfirmDelete(project, folder, body));
  });
}

/** .cbmignore in the Files tab's editor, made empty first when the folder has none. */
async function knEditIgnore(project, folder) {
  const exists = await window.api.readProjectFile?.(folder, '.cbmignore').catch(() => null);
  if (!exists || exists.error) {
    const made = await window.api.createProjectEntry(folder, '', '.cbmignore', 'file');
    if (made?.error && !/exist/i.test(made.error)) { alert(made.error); return; }
  }
  knOpenInFiles(project, folder, '.cbmignore');
}

function knConfirmDelete(project, folder, body) {
  const name = pathBasename(folder);
  const handle = gitGraphOpenDialog({
    title: `Delete the code graph of ${name}?`,
    bodyHtml: `<p class="kn-dialog-text">codebase-memory-mcp forgets everything it read in <span class="mono">${escapeHtml(folder)}</span>, and its decision record (ADR). Your agents lose it too. The folder itself is not touched; index it again to get the graph back.</p>`,
    primaryLabel: 'Delete graph',
    primaryDanger: true,
    onSubmit: async () => {
      const r = await window.api.knowledgeDeleteIndex(project.id, folder);
      if (r?.error) throw new Error(r.error);
      handle.close();
      const s = knState(project);
      for (const byView of Object.values(s.views)) delete byView[folder];
      s.stale = true;
      await knLoadStatus(project);
      if (knVisible(project, body)) renderKnowledgeTab(project, body);
    },
  });
}

// --- Live updates ---

let knChangedTimer = null;
const knChangedProjects = new Set();

function knOnChanged(payload) {
  const p = payload || {};
  for (const [id, s] of knowledgeTabs) {
    if (p.projectId && p.projectId !== id) continue;
    s.stale = true;
    if (p.folderPath && (p.reason === 'adr' || p.reason === 'traces' || p.reason === 'deleted')) {
      for (const byView of Object.values(s.views)) delete byView[p.folderPath];
    }
    knChangedProjects.add(id);
  }
  clearTimeout(knChangedTimer);
  knChangedTimer = setTimeout(async () => {
    const ids = [...knChangedProjects];
    knChangedProjects.clear();
    const project = typeof selectedProject === 'function' ? selectedProject() : null;
    if (!project || !ids.includes(project.id) || projectTab(project) !== 'knowledge') return;
    const changed = await knLoadStatus(project);
    if (changed) knStatusChanged(project);
  }, 250);
}

if (typeof window !== 'undefined' && window.api?.onKnowledgeChanged) window.api.onKnowledgeChanged(knOnChanged);
