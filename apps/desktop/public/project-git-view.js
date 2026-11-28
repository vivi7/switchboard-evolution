// The Git tab of a project: Changes (staging), History (the Git Graph),
// Worktrees, Pull Requests and Actions. Repositories are the folders attached to the project; every git
// command runs in main and the renderer only receives data.
//
// Changes stages and unstages like a Git client: whole files from the lists
// (Merge Changes, Staged Changes, Changes, as VS Code groups them), and hunks
// or picked lines from a file's diff (git-diff-model.js names the lines; the
// main process builds the patch and applies it to the index).

const projectGitTabState = new Map();

// 'list' or 'tree'; one preference for every project, like DIFF_MODE_KEY.
const GIT_CHANGES_VIEW_KEY = 'gitChangesView';

function gitChangesViewMode() {
  let stored = null;
  try { stored = localStorage.getItem(GIT_CHANGES_VIEW_KEY); } catch {}
  return stored === 'list' ? 'list' : 'tree';
}

function setGitChangesViewMode(mode) {
  try { localStorage.setItem(GIT_CHANGES_VIEW_KEY, mode); } catch {}
}

function gitTabState(projectId) {
  if (!projectGitTabState.has(projectId)) {
    projectGitTabState.set(projectId, {
      workspaceView: 'history',
      repositories: null,
      selectedRepo: null,
      selectedFiles: new Map(), // repo path -> `${side}\0${path}`
      selectionHint: new Map(), // repo path -> { side, path, index }, to land near it after a change
      diffs: new Map(), // `${repo}\0${side}\0${path}` -> { diff, truncated, diffId, parsed } | { error }
      picked: new Map(), // same key -> Set of picked line indices
      editors: new Map(), // `${repo}\0${path}` -> a file in edit mode (gitStartEdit)
      busy: false,
      collapsedFolders: new Map(), // repo path -> Set of collapsed tree folder keys
      request: 0,
      error: '',
    });
  }
  return projectGitTabState.get(projectId);
}

// The Git tab's views, in the order its switch shows them: History first,
// and the view a project opens on.
const GIT_WORKSPACE_VIEWS = ['history', 'changes', 'worktrees', 'pulls', 'actions'];
const GIT_WORKSPACE_LABELS = { history: 'History', changes: 'Changes', worktrees: 'Worktrees', pulls: 'Pull Requests', actions: 'Actions' };
// The views that can show several repositories at once (git-repo-tabs.js).
const GIT_MULTI_REPO_VIEWS = ['history', 'pulls', 'worktrees'];

function projectGitView(projectOrId) {
  const projectId = typeof projectOrId === 'string' ? projectOrId : projectOrId?.id;
  const view = projectId && gitTabState(projectId).workspaceView;
  return GIT_WORKSPACE_VIEWS.includes(view) ? view : 'history';
}

/**
 * The repositories a view takes from the one the user leaves: the primary
 * always; every repository shown between History, Pull Requests and
 * Worktrees; and a view that shows several keeps its own when it already
 * shows the repository handed over by Changes or Actions.
 */
function gitCarryRepoSelection(from, to, fromView, toView) {
  if (!from || !to || from === to || !from.selectedRepo) return;
  const fromMulti = GIT_MULTI_REPO_VIEWS.includes(fromView);
  const toMulti = GIT_MULTI_REPO_VIEWS.includes(toView);
  if (!toMulti) { to.selectedRepo = from.selectedRepo; return; }
  if (fromMulti && Array.isArray(from.selectedRepos) && from.selectedRepos.length) {
    to.selectedRepo = from.selectedRepo;
    to.selectedRepos = [...from.selectedRepos];
    return;
  }
  const target = { primary: to.selectedRepo || null, paths: Array.isArray(to.selectedRepos) ? to.selectedRepos : (to.selectedRepo ? [to.selectedRepo] : []) };
  const carried = typeof RepoSelection !== 'undefined'
    ? RepoSelection.carryRepoSelection(target, from.selectedRepo)
    : { primary: from.selectedRepo, paths: [from.selectedRepo] };
  to.selectedRepo = carried.primary;
  to.selectedRepos = carried.paths;
}

function setProjectGitView(projectOrId, view) {
  const projectId = typeof projectOrId === 'string' ? projectOrId : projectOrId?.id;
  if (!projectId || !GIT_WORKSPACE_VIEWS.includes(view)) return;
  const changesState = gitTabState(projectId);
  const current = projectGitView(projectId);

  // Each view has its own richer state, but the repositories shown are a
  // workspace-level choice. Carry them across when the user changes views.
  const repoStates = { changes: changesState };
  if (typeof gitGraphState === 'function') repoStates.history = gitGraphState(projectId);
  if (typeof prTabState === 'function') repoStates.pulls = prTabState(projectId);
  if (typeof wtTabState === 'function') repoStates.worktrees = wtTabState(projectId);
  if (typeof actTabState === 'function') repoStates.actions = actTabState(projectId);
  gitCarryRepoSelection(repoStates[current], repoStates[view], current, view);
  changesState.workspaceView = view;
}

function gitWorkspaceNavHtml(view) {
  const button = (name, label) => `<button type="button" id="git-workspace-${name}-tab" class="git-workspace-nav-btn${view === name ? ' active' : ''}" data-git-view="${name}" role="tab" aria-selected="${view === name}" aria-controls="git-workspace-view">${label}</button>`;
  return `<div class="git-workspace-subnav"><div class="git-workspace-nav" role="tablist" aria-label="Git view">${GIT_WORKSPACE_VIEWS.map((name) => button(name, GIT_WORKSPACE_LABELS[name])).join('')}</div></div>`;
}

/**
 * The Git tab: History (the Git Graph, with its actions) first, then Changes
 * (working tree and diffs), Worktrees, Pull Requests
 * (project-pull-requests-view.js) and Actions (project-actions-view.js).
 */
function renderProjectGitWorkspace(project, body) {
  const view = projectGitView(project);
  body.className = 'ws-body git-workspace-body';
  body.innerHTML = `${gitWorkspaceNavHtml(view)}<div class="git-workspace-view" id="git-workspace-view" role="tabpanel" aria-labelledby="git-workspace-${view}-tab"></div>`;

  body.querySelectorAll('.git-workspace-nav-btn').forEach((button) => {
    button.onclick = () => {
      if (button.dataset.gitView === projectGitView(project)) return;
      setProjectGitView(project, button.dataset.gitView);
      renderProjectGitWorkspace(project, body);
    };
  });

  const viewBody = body.querySelector('#git-workspace-view');
  if (view === 'changes') renderProjectGitTab(project, viewBody);
  else if (view === 'worktrees') renderProjectWorktreesTab(project, viewBody);
  else if (view === 'pulls') renderProjectPullRequestsTab(project, viewBody);
  else if (view === 'actions') renderProjectActionsTab(project, viewBody);
  else renderProjectGitGraphTab(project, viewBody);
}

function gitCollapsedSet(state, repoPath) {
  if (!state.collapsedFolders.has(repoPath)) state.collapsedFolders.set(repoPath, new Set());
  return state.collapsedFolders.get(repoPath);
}

function gitRepoName(repo) {
  return pathBasename(repo.path) || repo.path;
}

function gitRelativeTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : formatDate(date);
}

function gitSyncText(repo) {
  if (repo.ahead === null || repo.behind === null) return 'No upstream';
  if (!repo.ahead && !repo.behind) return 'Up to date';
  const parts = [];
  if (repo.ahead) parts.push(`${repo.ahead} ahead`);
  if (repo.behind) parts.push(`${repo.behind} behind`);
  return parts.join(' · ');
}

function gitChangeMeta(change) {
  if (change.status === 'untracked') return 'Untracked';
  if (change.status === 'conflicted') return 'Conflicted';
  const inIndex = change.indexStatus !== ' ' && change.indexStatus !== '?';
  const inWorktree = change.worktreeStatus !== ' ' && change.worktreeStatus !== '?';
  if (inIndex && inWorktree) return 'Staged + unstaged';
  return inIndex ? 'Staged' : 'Unstaged';
}

function gitChangeCode(change) {
  return {
    conflicted: '!',
    untracked: '?',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    modified: 'M',
  }[change.status] || 'M';
}

// --- Staging: the lists by side, as VS Code groups them ---

const GICONS = {
  plus: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  minus: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>`,
  check: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>`,
  edit: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  discard: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`,
};

const GIT_SIDES = [
  { side: 'merge', label: 'Merge Changes' },
  { side: 'staged', label: 'Staged Changes' },
  { side: 'unstaged', label: 'Changes' },
];

/** Whether this desktop can stage (it always can; the guard keeps the tests' fake api read-only). */
function gitCanStage() {
  return typeof window !== 'undefined' && typeof window.api?.stageProjectGitFiles === 'function';
}

/** Whether this desktop can discard changes and edit .gitignore from the list (an older main process cannot). */
function gitCanDiscard() {
  return typeof window !== 'undefined' && typeof window.api?.discardProjectGitFiles === 'function';
}

function gitCanIgnore() {
  return typeof window !== 'undefined' && typeof window.api?.ignoreProjectGitPaths === 'function';
}

/** Whether the diff of `change` can turn into an editor: a newer main process, and a file on disk. */
function gitCanEdit(change) {
  return typeof window !== 'undefined' && typeof window.api?.readProjectGitEditFile === 'function'
    && typeof window.createUnifiedMergeViewer === 'function' && !!GitChangeActionsLib()?.canEdit(change);
}

/** The key of a file in edit mode: the file, whichever side of the list it was opened from. */
function gitEditKey(repo, path) {
  return `${repo.path}\0${path}`;
}

/** git-change-actions.js, shared with main and the phone. */
function GitChangeActionsLib() {
  return typeof GitChangeActions !== 'undefined' ? GitChangeActions : globalThis.GitChangeActions;
}

/** "Trash", or what Windows calls it. */
function gitTrashName() {
  return typeof window !== 'undefined' && window.api?.platform === 'win32' ? 'Recycle Bin' : 'Trash';
}

/** { merge, staged, unstaged }: a file staged and changed again is in both of the last two. */
function gitSideLists(changes) {
  const lists = { merge: [], staged: [], unstaged: [] };
  for (const change of changes) {
    if (change.status === 'conflicted') { lists.merge.push(change); continue; }
    if (change.indexStatus && change.indexStatus !== ' ' && change.indexStatus !== '?') lists.staged.push(change);
    if (change.status === 'untracked' || (change.worktreeStatus && change.worktreeStatus !== ' ')) lists.unstaged.push(change);
    // A change without the two letters (an old main process) is listed once.
    if (!change.indexStatus && !change.worktreeStatus && change.status !== 'untracked') lists.unstaged.push(change);
  }
  return lists;
}

/** The letter a side shows for a file: its index letter when staged, its working-tree letter otherwise. */
function gitSideCode(change, side) {
  if (side === 'merge' || change.status === 'conflicted') return '!';
  if (change.status === 'untracked') return 'U';
  const letter = side === 'staged' ? change.indexStatus : change.worktreeStatus;
  return ['M', 'A', 'D', 'R', 'C', 'T'].includes(letter) ? letter : gitChangeCode(change);
}

function gitCodeClass(code) {
  return { A: 'added', U: 'untracked', D: 'deleted', R: 'renamed', C: 'renamed', '!': 'conflicted' }[code] || 'modified';
}

function gitSelectionKey(side, path) {
  return `${side}\0${path}`;
}

/** The side of the diff to show for a list: a conflicted file shows its working tree. */
function gitDiffSide(side) {
  return side === 'staged' ? 'staged' : 'unstaged';
}

function gitDiffKey(repo, side, path) {
  return `${repo.path}\0${gitDiffSide(side)}\0${path}`;
}

/** Every (side, change) the lists show, in order. */
function gitSideItems(changes) {
  const lists = gitSideLists(changes);
  return GIT_SIDES.flatMap(({ side }) => lists[side].map(change => ({ side, change })));
}

/** The item to select: the one remembered, or near where it was before it left its list. */
function gitSelectedItem(state, repo, items) {
  const key = state.selectedFiles.get(repo.path);
  let selected = items.find(item => gitSelectionKey(item.side, item.change.path) === key);
  if (!selected && key) {
    const hint = state.selectionHint.get(repo.path);
    if (hint) {
      const same = items.filter(item => item.side === hint.side);
      selected = same[Math.min(hint.index, same.length - 1)]
        || items.find(item => item.change.path === hint.path) || null;
    }
  }
  return selected || items[0] || null;
}

function gitWarningHtml(repo) {
  const warnings = [];
  const conflicts = repo.changes.filter(change => change.status === 'conflicted').length;
  if (repo.operation) warnings.push(`${repo.operation[0].toUpperCase()}${repo.operation.slice(1)} in progress`);
  if (conflicts) warnings.push(`${conflicts} conflicted file${conflicts === 1 ? '' : 's'}`);
  if (repo.detached) warnings.push(`Detached at ${repo.head || 'HEAD'}`);
  if (!warnings.length) return '';
  return `<div class="git-alert">${escapeHtml(warnings.join(' · '))}</div>`;
}

function gitOverviewHtml(repo) {
  const latest = repo.commits[0];
  const changed = repo.changes.length;
  const statParts = [];
  if (repo.stats.insertions) statParts.push(`<span class="git-plus">+${repo.stats.insertions}</span>`);
  if (repo.stats.deletions) statParts.push(`<span class="git-minus">−${repo.stats.deletions}</span>`);
  return `
    ${gitWarningHtml(repo)}
    <section class="git-summary">
      <div class="git-summary-top">
        <span class="git-branch">${PICONS.branch(14)}<span>${escapeHtml(repo.detached ? (repo.head || 'Detached HEAD') : (repo.branch || 'Unknown branch'))}</span></span>
        <span class="git-clean-state ${changed ? 'changed' : 'clean'}">${changed ? `${changed} changed file${changed === 1 ? '' : 's'}` : 'Clean'}</span>
      </div>
      <div class="git-summary-meta">
        <span>${escapeHtml(gitSyncText(repo))}</span>
        ${statParts.length ? `<span class="git-stat">${statParts.join(' ')}</span>` : ''}
      </div>
      <div class="git-latest">
        <span class="git-kicker">Latest commit</span>
        ${latest
          ? `<span class="git-latest-subject">${escapeHtml(latest.subject)}</span><span class="git-latest-meta"><span class="mono">${escapeHtml(latest.shortHash)}</span> · ${escapeHtml(latest.author)} · ${escapeHtml(gitRelativeTime(latest.date))}</span>`
          : '<span class="git-empty-inline">No commits yet</span>'}
      </div>
    </section>`;
}

/**
 * A unified diff as lines, green the added ones and red the removed ones.
 * With `filename`, and the editors' highlighter loaded (codemirror-setup.js,
 * cmHighlightLines), the code takes the editors' colours instead and the lines
 * keep only their green and red backgrounds (gitDiffCodeLines).
 */
function gitDiffLines(diff, { filename = '' } = {}) {
  const lines = String(diff || '').split('\n');
  const code = filename ? gitDiffCodeLines(lines, filename) : null;
  return lines.map((line, i) => {
    let cls = '';
    if (line.startsWith('@@')) cls = ' hunk';
    else if (line.startsWith('+') && !line.startsWith('+++')) cls = ' add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = ' remove';
    else if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity index|rename (from|to))/.test(line)) cls = ' header';
    if (code && code[i] !== null) {
      // Inside a hunk the first character is the line's kind, whatever follows it.
      const kind = line[0] === '+' ? ' add' : line[0] === '-' ? ' remove' : '';
      return `<span class="git-diff-line code${kind}"><span class="git-diff-sign">${escapeHtml(line[0] || ' ')}</span>${code[i]}</span>`;
    }
    return `<span class="git-diff-line${cls}">${line ? escapeHtml(line) : ' '}</span>`;
  }).join('');
}

/**
 * The code of a diff's hunks in the editors' colours: one HTML string per
 * line of `lines` inside a hunk, null for the others (headers, @@ lines, "\ No
 * newline"). Each hunk's old side (its context and removed lines) and new
 * side (its context and added lines) are coloured as wholes, so a comment or a
 * string over several lines stays one. Null when the file's language is not
 * one the editors highlight.
 */
function gitDiffCodeLines(lines, filename) {
  const highlight = typeof window !== 'undefined' ? window.cmHighlightLines : null;
  if (typeof highlight !== 'function') return null;
  const out = new Array(lines.length).fill(null);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('@@')) { i++; continue; }
    const before = [];
    const after = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('diff --git '); j++) {
      const kind = lines[j][0];
      if (kind === '-') before.push(j);
      else if (kind === '+') after.push(j);
      else if (kind === ' ' || lines[j] === '') { before.push(j); after.push(j); }
    }
    // The new side last: a context line shows as it reads now.
    for (const rows of [before, after]) {
      if (!rows.length) continue;
      const html = highlight(rows.map(r => lines[r].slice(1)).join('\n'), filename);
      if (!Array.isArray(html)) return null;
      rows.forEach((r, k) => { out[r] = html[k] ?? ''; });
    }
    i = j;
  }
  return out;
}

/** What a diff's file header says, in words: new, deleted, renamed, mode changed, binary. */
function gitDiffNote(parsed) {
  if (!parsed) return '';
  const notes = [];
  for (const index of parsed.header) {
    const line = parsed.lines[index];
    if (line.startsWith('new file mode')) notes.push('New file');
    else if (line.startsWith('deleted file mode')) notes.push('Deleted file');
    else if (line.startsWith('rename from ')) notes.push(`Renamed from ${line.slice(12)}`);
    else if (line.startsWith('old mode ')) notes.push(`Mode ${line.slice(9)}`);
    else if (line.startsWith('new mode ')) notes.push(`→ ${line.slice(9)}`);
  }
  if (parsed.binary) notes.push('Binary file');
  return notes.join(' · ');
}

/** The hunks of a diff, each line with its numbers and a gutter to pick it by. */
function gitHunksHtml(parsed, picked, side) {
  const verb = side === 'staged' ? 'Unstage' : 'Stage';
  return parsed.hunks.map((hunk, h) => {
    const lines = hunk.lines.map((line) => {
      if (line.kind === 'eof') return `<div class="git-dl eof"><span class="git-dl-gutter"></span><span class="git-dl-text">${escapeHtml(line.text.replace(/^\\ ?/, ''))}</span></div>`;
      const changed = line.kind === 'add' || line.kind === 'remove';
      const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ';
      const on = changed && picked.has(line.index);
      return `<div class="git-dl ${line.kind}${on ? ' picked' : ''}"${changed ? ` data-index="${line.index}"` : ''}>`
        + `<span class="git-dl-gutter"${changed ? ` title="Click or drag to pick lines to ${verb.toLowerCase()}; Shift+click picks a range"` : ''}>`
        + `<span class="git-dl-num">${line.oldLine ?? ''}</span><span class="git-dl-num">${line.newLine ?? ''}</span><span class="git-dl-sign">${sign}</span></span>`
        + `<span class="git-dl-text">${line.text ? escapeHtml(line.text) : ' '}</span></div>`;
    }).join('');
    return `<div class="git-hunk" data-hunk="${h}">
      <div class="git-hunk-head"><span class="git-hunk-range mono">@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@</span><span class="git-hunk-section mono">${escapeHtml(hunk.section)}</span><button type="button" class="ws-ghost ws-ghost--sm git-hunk-act" data-hunk="${h}">${verb} Hunk</button></div>
      ${lines}
    </div>`;
  }).join('');
}

function gitDiffSideLabel(side, change) {
  if (side === 'merge') return 'Merge conflict';
  if (side === 'staged') return 'Staged';
  return change.status === 'untracked' ? 'Untracked' : 'Unstaged';
}

/** The header of the diff: the file, which side, and the staging buttons; in edit mode, Exit and Save. */
function gitDiffHeadHtml(item, cached, edit = null) {
  const { side, change } = item;
  const renamed = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
  let actions = '';
  if (edit) {
    actions = `<span class="git-diff-actions">
      <button type="button" class="ws-ghost ws-ghost--sm git-edit-exit" title="Back to the diff; what is not saved is dropped">Exit Edit Mode</button>
      <button type="button" class="ws-ghost ws-ghost--sm git-edit-save" title="Save to disk (⌘S)" disabled>Save</button>
    </span>`;
  } else if (gitCanStage()) {
    const pickable = cached && !cached.error && cached.parsed && GitDiffModelLib().canPickLines(cached.parsed) && !cached.truncated;
    const verb = side === 'staged' ? 'Unstage' : 'Stage';
    const fileLabel = side === 'merge' ? 'Mark as Resolved' : `${verb} File`;
    actions = `<span class="git-diff-actions">
      ${pickable ? `<button type="button" class="ws-ghost ws-ghost--sm git-pick-clear" hidden>Clear</button><button type="button" class="ws-ghost ws-ghost--sm git-pick-act" disabled>${verb} Selected Lines</button>` : ''}
      ${gitCanEdit(change) ? `<button type="button" class="ws-ghost ws-ghost--sm git-edit-act" title="Edit the file here, with what differs from its staged copy marked">${GICONS.edit(12)}<span>Edit</span></button>` : ''}
      <button type="button" class="ws-ghost ws-ghost--sm git-file-act">${side === 'staged' ? GICONS.minus(12) : side === 'merge' ? GICONS.check(12) : GICONS.plus(12)}<span>${fileLabel}</span></button>
    </span>`;
  }
  const label = edit ? 'Editing' : gitDiffSideLabel(side, change);
  return `<div class="git-diff-title"><span class="git-diff-file mono" title="${escapeHtml(renamed)}">${escapeHtml(renamed)}</span><span class="git-diff-side ${edit ? 'editing' : side}">${escapeHtml(label)}</span>${actions}</div>`;
}

/** git-diff-model.js, as a global in the window. */
function GitDiffModelLib() {
  return typeof GitDiffModel !== 'undefined' ? GitDiffModel : null;
}

function paintGitDiff(project, state, repo, body, item) {
  const pane = body.querySelector('#git-diff-pane');
  if (!pane) return;
  if (!item) {
    pane.innerHTML = '<div class="git-diff-empty">Select a changed file to view its diff.</div>';
    return;
  }
  // An item from an older caller is a bare change.
  if (!item.change) item = { side: 'unstaged', change: item };
  const { side, change } = item;
  const editing = state.editors && state.editors.get(gitEditKey(repo, change.path));
  if (editing) {
    paintGitEditor(project, state, repo, body, item, editing);
    return;
  }
  const staging = gitCanStage() && !!GitDiffModelLib();
  const key = staging ? gitDiffKey(repo, side, change.path) : `${repo.path}\0${change.path}`;
  const cached = state.diffs.get(key);
  const selectedKey = gitSelectionKey(side, change.path);
  const stillSelected = () => body.isConnected && state.selectedRepo === repo.path
    && (state.selectedFiles.get(repo.path) === selectedKey || state.selectedFiles.get(repo.path) === change.path);
  pane.dataset.path = change.path;
  // A diff read before the last refresh stays on screen while it is read
  // again, and is drawn again only if it changed: the scroll and the picked
  // lines stay where they are.
  if (!cached || (cached.stale && !cached.refreshing)) {
    if (!cached) pane.innerHTML = '<div class="git-diff-empty">Loading diff…</div>';
    else cached.refreshing = true;
    const request = staging
      ? window.api.getProjectGitDiff(project.id, repo.path, change.path, gitDiffSide(side))
      : window.api.getProjectGitDiff(project.id, repo.path, change.path);
    const settle = (next) => {
      const prev = state.diffs.get(key);
      state.diffs.set(key, next);
      if (!stillSelected()) return;
      if (prev && prev !== cached) return; // a newer read already landed
      if (prev && !prev.error && !next.error && prev.diff === next.diff) return;
      const scroll = body.scrollTop;
      paintGitDiff(project, state, repo, body, item);
      body.scrollTop = scroll;
    };
    request.then((result) => {
      if (result?.ok) {
        const diff = result.diff || '';
        settle({ diff, truncated: !!result.truncated, diffId: result.diffId || null, parsed: staging ? GitDiffModelLib().parseUnifiedDiff(diff) : null });
      } else {
        settle({ error: result?.error || 'Could not load this diff.' });
      }
    }).catch((err) => settle({ error: err?.message || 'Could not load this diff.' }));
    if (!cached) return;
  }
  if (cached.error) {
    pane.innerHTML = `<div class="git-diff-empty">${escapeHtml(cached.error)}</div>`;
    return;
  }
  if (!staging) {
    pane.innerHTML = cached.diff
      ? `<div class="git-diff-title mono">${escapeHtml(change.path)}</div><pre class="git-diff">${gitDiffLines(cached.diff)}</pre>`
      : `<div class="git-diff-title mono">${escapeHtml(change.path)}</div><div class="git-diff-empty">No textual diff is available.</div>`;
    return;
  }
  const parsed = cached.parsed;
  const model = GitDiffModelLib();
  const pickable = model.canPickLines(parsed) && !cached.truncated;
  // Picked lines belong to one exact diff; a new one starts with none.
  let entry = state.picked.get(key);
  if (!entry || entry.diffId !== cached.diffId) {
    entry = { diffId: cached.diffId, lines: new Set() };
    state.picked.set(key, entry);
  }
  const picked = entry.lines;
  const note = gitDiffNote(parsed);
  let content;
  if (!cached.diff) content = '<div class="git-diff-empty">No textual diff is available.</div>';
  else if (pickable) content = `<div class="git-hunks">${gitHunksHtml(parsed, picked, side)}</div>`;
  else content = `<pre class="git-diff">${gitDiffLines(cached.diff)}</pre>`;
  pane.innerHTML = `${gitDiffHeadHtml(item, cached)}${note ? `<div class="git-diff-note">${escapeHtml(note)}${cached.truncated ? ' · too long to stage in parts' : ''}</div>` : (cached.truncated ? '<div class="git-diff-note">Too long to stage in parts</div>' : '')}${content}`;
  bindGitDiffPane(project, state, repo, body, item, { key, cached, pickable, picked });
}

/** The diff's buttons, and picking lines in its gutter by click, drag or Shift+click. */
function bindGitDiffPane(project, state, repo, body, item, { key, cached, pickable, picked }) {
  const pane = body.querySelector('#git-diff-pane');
  if (!pane || !gitCanStage()) return;
  const { side, change } = item;
  const verb = side === 'staged' ? 'Unstage' : 'Stage';
  const fileButton = pane.querySelector('.git-file-act');
  if (fileButton) {
    fileButton.onclick = () => gitStageFiles(project, state, repo, body, [change], side !== 'staged', item);
  }
  const editButton = pane.querySelector('.git-edit-act');
  if (editButton) editButton.onclick = () => gitStartEdit(project, state, repo, body, item);
  if (!pickable) return;
  const model = GitDiffModelLib();
  const pickButton = pane.querySelector('.git-pick-act');
  const clearButton = pane.querySelector('.git-pick-clear');
  const refresh = () => {
    pane.querySelectorAll('.git-dl[data-index]').forEach(el => el.classList.toggle('picked', picked.has(Number(el.dataset.index))));
    const n = picked.size;
    if (pickButton) {
      pickButton.disabled = n === 0;
      pickButton.textContent = n ? `${verb} ${n} Selected Line${n === 1 ? '' : 's'}` : `${verb} Selected Lines`;
    }
    if (clearButton) clearButton.hidden = n === 0;
  };
  refresh();
  if (pickButton) pickButton.onclick = () => gitStageLines(project, state, repo, body, item, cached, [...picked]);
  if (clearButton) clearButton.onclick = () => { picked.clear(); refresh(); };
  pane.querySelectorAll('.git-hunk-act').forEach((button) => {
    button.onclick = () => gitStageLines(project, state, repo, body, item, cached, model.changedLineIndices(cached.parsed, Number(button.dataset.hunk)));
  });

  const order = model.changedLineIndices(cached.parsed);
  const between = (a, b) => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return order.filter(i => i >= lo && i <= hi);
  };
  let drag = null; // { anchor, on, base }
  pane.onmousedown = (event) => {
    const gutter = event.target.closest('.git-dl-gutter');
    const line = gutter?.closest('.git-dl[data-index]');
    if (!line || event.button !== 0) return;
    event.preventDefault();
    const index = Number(line.dataset.index);
    if (event.shiftKey && state.pickAnchor?.key === key) {
      for (const i of between(state.pickAnchor.index, index)) picked.add(i);
      refresh();
      return;
    }
    const on = !picked.has(index);
    drag = { anchor: index, on, base: new Set(picked) };
    state.pickAnchor = { key, index };
    if (on) picked.add(index); else picked.delete(index);
    refresh();
    const stop = () => { drag = null; document.removeEventListener('mouseup', stop); };
    document.addEventListener('mouseup', stop);
  };
  pane.onmouseover = (event) => {
    if (!drag) return;
    const line = event.target.closest('.git-dl[data-index]');
    if (!line) return;
    const range = new Set(between(drag.anchor, Number(line.dataset.index)));
    picked.clear();
    for (const i of drag.base) picked.add(i);
    for (const i of range) { if (drag.on) picked.add(i); else picked.delete(i); }
    refresh();
  };
}

// ── Edit mode ────────────────────────────────────────────────────────
// Edit turns the diff into an editor of the file on disk, with what differs
// from the staged copy marked as it is typed. Save writes the file and stays
// in edit mode: the edit becomes a change to stage in the list. Exit Edit
// Mode goes back to the diff, after asking when something is not saved. A file
// stays in edit mode while another file is looked at, and its rows show a
// pencil. Unsaved text is kept in the file's draft (file-drafts.js), as in every
// editor (viewer-panel.js): entering edit mode again after a restart brings it back.

// Every file in edit mode in this window.
const gitEditSessions = new Set();
let gitEditEventsBound = false;
const GIT_DRAFT_DELAY_MS = 300;

/** The path on disk of a repository's file, as the other editors name it. */
function gitEditFilePath(repo, path) {
  const sep = window.api.platform === 'win32' ? '\\' : '/';
  return `${String(repo.path).replace(/[\\/]$/, '')}${sep}${path.split('/').join(sep)}`;
}

function gitStopDraftTimer(session) {
  if (session.draftTimer) clearTimeout(session.draftTimer);
  session.draftTimer = null;
}

/** Write a session's unsaved text to the draft, or drop the draft. False when it could not be written. */
function gitKeepEdit(session) {
  gitStopDraftTimer(session);
  if (!window.api.setDraft || !gitEditSessions.has(session)) return true;
  if (!gitEditDirty(session)) {
    gitDropEditDraft(session);
    return true;
  }
  const content = gitEditText(session.view);
  if (session.kept === content) return true;
  const draft = { content, base: session.saved };
  const result = window.api.setDraft(session.filePath, draft);
  if (!result?.ok) return false;
  session.kept = content;
  shareViewerDraft({ filePath: session.filePath, state: 'dirty', ...draft });
  return true;
}

function gitDropEditDraft(session) {
  if (session.kept === null || session.kept === undefined) return;
  session.kept = null;
  const change = { filePath: session.filePath, state: 'clean', content: session.saved };
  window.api.removeDraft?.(session.filePath, change);
  shareViewerDraft(change);
}

/** The same file's unsaved text changed in another editor: this one follows. */
function gitFollowDraft(session, { state, content }) {
  if (typeof content !== 'string') return;
  gitStopDraftTimer(session);
  session.kept = state === 'dirty' ? content : null;
  if (state !== 'dirty') session.saved = content;
  if (gitEditText(session.view) !== content) window.cmSetText?.(session.view, content);
}

function bindGitEditEvents() {
  if (gitEditEventsBound || !window.addEventListener) return;
  gitEditEventsBound = true;
  window.addEventListener('viewer-drafts-changed', (event) => {
    for (const session of gitEditSessions) {
      if (session.filePath === event.detail?.filePath) gitFollowDraft(session, event.detail);
    }
  });
  // As the viewers: what is typed is kept before the window goes.
  window.addEventListener('beforeunload', (event) => {
    let kept = true;
    for (const session of gitEditSessions) if (!gitKeepEdit(session)) kept = false;
    if (kept) return;
    event.preventDefault();
    event.returnValue = false;
  });
}

/** A file leaves edit mode: its editor goes. */
function gitDropEditSession(session) {
  gitStopDraftTimer(session);
  gitEditSessions.delete(session);
  session.view.destroy();
  session.host.remove();
}

/** The text of a file in edit mode, with the file's line breaks (CRLF stays CRLF). */
function gitEditText(view) {
  return window.cmGetText ? window.cmGetText(view) : view.state.doc.toString();
}

/** Whether a file in edit mode has text that is not saved. */
function gitEditDirty(session) {
  return gitEditText(session.view) !== session.saved;
}

/** Save is on with unsaved text, and says so while it saves. */
function gitEditButtons(body, session) {
  const pane = body.querySelector && body.querySelector('#git-diff-pane');
  if (!pane || !session.host.isConnected || !pane.contains(session.host)) return;
  const save = pane.querySelector('.git-edit-save');
  if (!save) return;
  save.disabled = session.busy || !gitEditDirty(session);
  save.textContent = session.busy ? 'Saving…' : 'Save';
}

function paintGitEditor(project, state, repo, body, item, session) {
  const pane = body.querySelector('#git-diff-pane');
  if (!pane) return;
  pane.dataset.path = item.change.path;
  pane.innerHTML = `${gitDiffHeadHtml(item, null, session)}<div class="git-diff-note">${escapeHtml(GitChangeActionsLib().editNote(item.change))}</div><div class="git-edit-slot"></div>`;
  pane.querySelector('.git-edit-slot').appendChild(session.host);
  session.view.requestMeasure();
  pane.querySelector('.git-edit-exit').onclick = () => gitExitEdit(project, state, repo, body, item);
  pane.querySelector('.git-edit-save').onclick = () => gitSaveEdit(project, state, repo, body, item, session);
  gitEditButtons(body, session);
}

async function gitStartEdit(project, state, repo, body, item) {
  const key = gitEditKey(repo, item.change.path);
  if (state.editors.has(key)) return;
  let result;
  try { result = await window.api.readProjectGitEditFile(project.id, repo.path, item.change.path); } catch (err) { result = { ok: false, error: err.message }; }
  if (!result || !result.ok) {
    alert(result?.error || 'Could not open this file.');
    return;
  }
  if (state.editors.has(key)) return;
  const host = document.createElement('div');
  host.className = 'git-edit-editor';
  const filePath = gitEditFilePath(repo, item.change.path);
  const session = { host, view: null, version: result.version, saved: result.content, busy: false, filePath, kept: null, draftTimer: null };
  session.view = window.createUnifiedMergeViewer(host, result.base, result.content, item.change.path, {
    readOnly: false, mergeControls: false, collapse: false,
    onDocChange: () => {
      gitEditButtons(body, session);
      gitStopDraftTimer(session);
      if (gitEditSessions.has(session)) session.draftTimer = setTimeout(() => gitKeepEdit(session), GIT_DRAFT_DELAY_MS);
    },
  });
  // What an edit differs from: the text as the editor gives it back, its line breaks made one kind.
  session.saved = gitEditText(session.view);
  gitEditSessions.add(session);
  bindGitEditEvents();
  // Unsaved text kept for this file comes back.
  const draft = window.api.getDraft?.(filePath);
  if (draft) {
    const plain = text => String(text).replace(/\r\n/g, '\n');
    session.kept = draft.content;
    if (plain(draft.content) !== plain(session.saved)) window.cmSetText?.(session.view, draft.content);
    // The file changed since those edits began: saving asks before overwriting it.
    if (plain(draft.base) !== plain(session.saved)) session.version = 'changed-since-draft';
  }
  // ⌘S in the editor.
  host.addEventListener('cm-save', (event) => {
    event.stopPropagation();
    gitSaveEdit(project, state, repo, body, item, session);
  });
  state.editors.set(key, session);
  paintGitChanges(project, state, repo, body, { repaintDiff: false });
  paintGitDiff(project, state, repo, body, item);
  session.view.focus();
}

async function gitSaveEdit(project, state, repo, body, item, session, { force = false } = {}) {
  if (session.busy || (!force && !gitEditDirty(session))) return;
  const text = gitEditText(session.view);
  session.busy = true;
  gitEditButtons(body, session);
  let result;
  try { result = await window.api.saveProjectGitEditFile(project.id, repo.path, item.change.path, text, force ? null : session.version); } catch (err) { result = { ok: false, error: err.message }; }
  session.busy = false;
  if (result && result.ok) {
    session.version = result.version;
    session.saved = text;
    gitKeepEdit(session);
    gitEditButtons(body, session);
    // The lists, with the edit to stage.
    await refreshGitRepositories(project, state, body);
    return;
  }
  gitEditButtons(body, session);
  if (result && result.code === 'CHANGED') {
    const name = pathBasename(item.change.path) || item.change.path;
    const overwrite = await gitChangesConfirm({
      title: `“${name}” changed on disk`,
      detail: 'It changed after you started editing it, perhaps by an agent. Saving puts your text in its place, and what changed on disk is lost.',
      confirm: 'Overwrite',
    });
    if (overwrite) await gitSaveEdit(project, state, repo, body, item, session, { force: true });
    return;
  }
  alert(result?.error || 'Could not save the file.');
}

/** Back to the diff, read again; what is not saved is dropped, once the user agrees. */
async function gitExitEdit(project, state, repo, body, item) {
  const key = gitEditKey(repo, item.change.path);
  const session = state.editors.get(key);
  if (!session) return;
  if (gitEditDirty(session)) {
    const name = pathBasename(item.change.path) || item.change.path;
    const discard = await gitChangesConfirm({
      title: `Discard your changes to “${name}”?`,
      detail: 'They are not saved, and leaving edit mode drops them.',
      confirm: 'Discard',
    });
    if (!discard || state.editors.get(key) !== session) return;
  }
  gitDropEditDraft(session);
  state.editors.delete(key);
  gitDropEditSession(session);
  for (const side of ['unstaged', 'staged', 'merge']) state.diffs.delete(gitDiffKey(repo, side, item.change.path));
  await refreshGitRepositories(project, state, body);
}

/** The scroll of the tab, to put back after the lists are drawn again. */
function gitScrollOf(body) {
  return body.scrollTop;
}

async function gitAfterStaging(project, state, repo, body, item, result) {
  if (result && result.ok === false && result.code !== 'STALE') alert(result.error || 'Git could not do this.');
  if (item) {
    const lists = gitSideLists(repo.changes);
    const index = (lists[item.side] || []).findIndex(c => c.path === item.change.path);
    state.selectionHint.set(repo.path, { side: item.side, path: item.change.path, index: Math.max(0, index) });
  }
  await refreshGitRepositories(project, state, body);
  if (result?.code === 'STALE') {
    const pane = body.querySelector('#git-diff-pane');
    pane?.insertAdjacentHTML('afterbegin', `<div class="git-diff-note is-warning">${escapeHtml(result.error)}</div>`);
  }
}

async function gitStageFiles(project, state, repo, body, changes, stage, item = null) {
  if (state.busy || !changes.length) return;
  state.busy = true;
  body.classList.add('is-busy');
  const paths = [...new Set(changes.flatMap(c => (!stage && c.oldPath ? [c.path, c.oldPath] : [c.path])))];
  let result;
  try { result = await window.api.stageProjectGitFiles(project.id, repo.path, paths, stage); } catch (err) { result = { ok: false, error: err.message }; }
  state.busy = false;
  body.classList.remove('is-busy');
  await gitAfterStaging(project, state, repo, body, item, result);
}

async function gitStageLines(project, state, repo, body, item, cached, lines) {
  if (state.busy || !lines.length) return;
  state.busy = true;
  body.classList.add('is-busy');
  let result;
  try {
    result = await window.api.stageProjectGitLines(project.id, repo.path, item.change.path, gitDiffSide(item.side), cached.diffId, lines);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  state.busy = false;
  body.classList.remove('is-busy');
  if (result?.ok) state.picked.delete(gitDiffKey(repo, item.side, item.change.path));
  await gitAfterStaging(project, state, repo, body, item, result);
}

// --- Discard and .gitignore (row buttons and the right-click menu) ---

/**
 * A question before something is lost: { title, detail, confirm } from
 * git-change-actions.js. Resolves true on the red button, false on Cancel or
 * Escape. The same look as the Git Graph's own confirmation.
 */
function gitChangesConfirm({ title, detail, confirm }) {
  if (typeof document === 'undefined' || !document.body) return Promise.resolve(false);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay gg-dialog-overlay gg-confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog gg-dialog gg-confirm-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `
      <h3>${escapeHtml(title)}</h3>
      <div class="add-project-hint">${escapeHtml(detail)}</div>
      <div class="add-project-actions">
        <button type="button" class="add-project-cancel-btn">Cancel</button>
        <button type="button" class="add-project-add-btn gg-dialog-primary gg-dialog-primary-danger">${escapeHtml(confirm)}</button>
      </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    let closed = false;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    function finish(value) {
      if (closed) return;
      closed = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    }
    document.addEventListener('keydown', onKey, true);
    const cancel = dialog.querySelector('.add-project-cancel-btn');
    cancel.onclick = () => finish(false);
    dialog.querySelector('.add-project-add-btn').onclick = () => finish(true);
    cancel.focus();
  });
}

/** Run one call of the list's row menu with the list held busy, then read the repositories again. */
async function gitRunRowAction(project, state, body, call, failure) {
  if (state.busy) return;
  state.busy = true;
  body.classList.add('is-busy');
  let result;
  try { result = await call(); } catch (err) { result = { error: err.message }; }
  state.busy = false;
  body.classList.remove('is-busy');
  if (!result || result.error || result.ok === false) alert(result?.error || failure);
  else if (result.failed?.length) alert(`These could not be moved to the ${gitTrashName()}:\n${result.failed.map(item => `${item.path}: ${item.error}`).join('\n')}`);
  await refreshGitRepositories(project, state, body);
}

/** Discard the "Changes" side of a file or folder row (target null: all of it), after asking. */
async function gitDiscard(project, state, repo, body, target) {
  const lib = GitChangeActionsLib();
  const targets = lib.discardTargets(repo.changes, target);
  if (!targets.length || state.busy) return;
  const name = target?.dir ? target.path.split('/').pop() : null;
  if (!(await gitChangesConfirm(lib.discardQuestion(targets, name, { trash: gitTrashName() })))) return;
  // The files the question counted, not whatever the folder holds by the time main runs.
  const paths = targets.map(change => change.path);
  await gitRunRowAction(project, state, body, () => window.api.discardProjectGitFiles(project.id, repo.path, paths), 'Git could not discard these changes.');
}

/** Add a file or folder to .gitignore; with `untrack`, ask first and take it out of Git too. */
async function gitIgnore(project, state, repo, body, target, untrack) {
  if (state.busy) return;
  if (untrack && !(await gitChangesConfirm(GitChangeActionsLib().untrackQuestion(target.path.split('/').pop(), target.dir)))) return;
  await gitRunRowAction(project, state, body, () => window.api.ignoreProjectGitPaths(project.id, repo.path, [target.path], untrack), 'Git could not add this to .gitignore.');
}

/**
 * The right-click menu of a file or folder row on one side of the list:
 * stage or unstage, Discard Changes… (in "Changes" only), and the .gitignore
 * entries git-change-actions.js offers for it.
 */
function gitRowMenuItems(project, state, repo, body, side, target) {
  const lib = GitChangeActionsLib();
  const lists = gitSideLists(repo.changes);
  const inside = (lists[side] || []).filter(change => lib.inTarget(change.path, target));
  const items = [];
  if (gitCanStage() && inside.length) {
    const stage = side !== 'staged';
    items.push({
      label: side === 'staged' ? 'Unstage Changes' : side === 'merge' ? 'Stage (Mark as Resolved)' : 'Stage Changes',
      icon: stage ? GICONS.plus(14) : GICONS.minus(14),
      onClick: () => gitStageFiles(project, state, repo, body, inside, stage),
    });
  }
  if (side === 'unstaged' && gitCanDiscard() && lib.discardTargets(repo.changes, target).length) {
    items.push({ label: 'Discard Changes…', icon: GICONS.discard(14), danger: true, onClick: () => gitDiscard(project, state, repo, body, target) });
  }
  const options = gitCanIgnore() && side !== 'merge' ? lib.ignoreOptions(repo.changes, target) : { ignore: false, untrack: false };
  if ((options.ignore || options.untrack) && items.length) items.push({ sep: true });
  if (options.ignore) items.push({ label: 'Add to .gitignore', onClick: () => gitIgnore(project, state, repo, body, target, false) });
  if (options.untrack) items.push({ label: 'Add to .gitignore and Remove from Git…', danger: true, onClick: () => gitIgnore(project, state, repo, body, target, true) });
  return items;
}

/** Open a row's menu where it was right-clicked. */
function gitOpenRowMenu(event, project, state, repo, body, side, target) {
  if (typeof showContextMenu !== 'function') return;
  const items = gitRowMenuItems(project, state, repo, body, side, target);
  if (!items.length) return;
  event.preventDefault();
  event.stopPropagation();
  showContextMenu(items, { x: event.clientX, y: event.clientY });
}

/** Read the repositories again and redraw, keeping the selection and the scroll. */
async function refreshGitRepositories(project, state, body) {
  const scroll = gitScrollOf(body);
  let result;
  try { result = await window.api.getProjectGitInfo(project.id); } catch (err) { result = { ok: false, error: err.message }; }
  if (!result?.ok) return;
  for (const entry of state.diffs.values()) entry.stale = true;
  state.repositories = result.repositories || [];
  if (!body.isConnected) return;
  paintGitRepository(project, state, body);
  body.scrollTop = scroll;
}

function gitNaturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// Folders before files; a folder whose only child is a folder is merged into
// one row ("src/app"), like VS Code's compact folders.
function gitSortTreeLevel(nodes) {
  const sorted = nodes.map((node) => {
    if (node.kind !== 'folder') return node;
    let name = node.name;
    let children = gitSortTreeLevel(node.children);
    while (children.length === 1 && children[0].kind === 'folder') {
      name = `${name}/${children[0].name}`;
      children = children[0].children;
    }
    return { kind: 'folder', name, children };
  });
  sorted.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return gitNaturalCompare(a.name, b.name);
  });
  return sorted;
}

// Git reports paths with '/' on every platform; renames sit at their new path.
function buildGitChangeTree(changes) {
  const root = new Map();
  for (const change of changes) {
    const parts = String(change.path || '').split('/').filter(Boolean);
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let node = level.get(part);
      if (!node || node.kind !== 'folder') {
        node = { kind: 'folder', name: part, children: new Map() };
        level.set(part, node);
      }
      level = node.children;
    }
    const fileName = parts[parts.length - 1] || change.path;
    level.set(`\0${fileName}`, { kind: 'file', name: fileName, change });
  }
  const toArray = (map) => [...map.values()].map(node => node.kind === 'folder' ? { ...node, children: toArray(node.children) } : node);
  return gitSortTreeLevel(toArray(root));
}

function gitTreeFileCount(node) {
  let count = 0;
  for (const child of node.children) count += child.kind === 'file' ? 1 : gitTreeFileCount(child);
  return count;
}

// Visible rows in display order; collapsed folders keep their own row only.
function gitTreeRows(tree, collapsedSet, keyPrefix, depth = 0) {
  const rows = [];
  for (const node of tree) {
    const key = keyPrefix ? `${keyPrefix}/${node.name}` : node.name;
    if (node.kind === 'folder') {
      const collapsed = collapsedSet.has(key);
      rows.push({ kind: 'folder', depth, name: node.name, key, count: gitTreeFileCount(node), collapsed });
      if (!collapsed) rows.push(...gitTreeRows(node.children, collapsedSet, key, depth + 1));
    } else {
      rows.push({ kind: 'file', depth, name: node.name, key, change: node.change });
    }
  }
  return rows;
}

/** A changed file's row: its letter for this side, icon, name, and the stage / unstage button. */
function createGitFileRow(project, state, repo, body, list, change, isSelected, opts) {
  const tree = !!(opts && opts.tree);
  const side = (opts && opts.side) || 'unstaged';
  const row = document.createElement('div');
  row.className = 'git-file-row' + (tree ? ' tree' : '') + (isSelected ? ' selected' : '');
  row.tabIndex = 0;
  row.setAttribute('role', 'treeitem');
  row.dataset.key = gitSelectionKey(side, change.path);
  if (tree) row.style.setProperty('--depth', String(opts.depth || 0));
  const renamed = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
  const meta = gitChangeMeta(change);
  const staging = gitCanStage();
  row.title = staging ? `${renamed}\n${gitDiffSideLabel(side, change)}` : (tree ? `${renamed}\n${meta}` : renamed);
  const code = staging ? gitSideCode(change, side) : gitChangeCode(change);
  const codeClass = staging ? gitCodeClass(code) : change.status;
  const name = (opts && opts.name) || pathBasename(change.path) || change.path;
  const dir = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';
  const icon = typeof fileIconHtml === 'function' ? fileIconHtml(name) : '';
  const editing = !!(state.editors && state.editors.has(gitEditKey(repo, change.path)));
  const pencil = editing ? `<span class="git-file-editing" title="In edit mode">${GICONS.edit(11)}</span>` : '';
  if (editing) row.classList.add('is-editing');
  let action = '';
  if (staging) {
    action = side === 'staged'
      ? `<button type="button" class="git-row-act" data-act="unstage" title="Unstage Changes" aria-label="Unstage ${escapeHtml(name)}">${GICONS.minus(13)}</button>`
      : `<button type="button" class="git-row-act" data-act="stage" title="${side === 'merge' ? 'Stage (Mark as Resolved)' : 'Stage Changes'}" aria-label="Stage ${escapeHtml(name)}">${GICONS.plus(13)}</button>`;
    if (side === 'unstaged' && gitCanDiscard()) action = `<button type="button" class="git-row-act" data-act="discard" title="Discard Changes" aria-label="Discard changes in ${escapeHtml(name)}">${GICONS.discard(13)}</button>${action}`;
  }
  // Without staging (an old main process), the row still says which state the file is in.
  const marker = !staging && tree && change.status !== 'untracked' && change.status !== 'conflicted'
    ? `<span class="git-file-meta">${escapeHtml(meta)}</span>` : '';
  if (tree) {
    row.innerHTML = `<span class="git-file-code ${escapeHtml(codeClass)}">${escapeHtml(code)}</span>${icon}<span class="git-file-path mono">${escapeHtml(opts.name || change.path)}</span>${pencil}${marker}<span class="git-row-acts">${action}</span>`;
  } else if (staging) {
    row.innerHTML = `<span class="git-file-code ${escapeHtml(codeClass)}">${escapeHtml(code)}</span>${icon}<span class="git-file-path mono">${escapeHtml(name)}</span>${pencil}<span class="git-file-dir">${escapeHtml(dir)}</span><span class="git-row-acts">${action}</span>`;
  } else {
    row.innerHTML = `<span class="git-file-code ${escapeHtml(change.status)}">${gitChangeCode(change)}</span>
        <span class="git-file-text"><span class="git-file-path mono">${escapeHtml(change.path)}</span><span class="git-file-meta">${escapeHtml(meta)}</span></span>`;
  }
  const select = () => {
    state.selectedFiles.set(repo.path, row.dataset.key);
    list.querySelectorAll('.git-file-row').forEach(el => el.classList.toggle('selected', el === row));
    paintGitDiff(project, state, repo, body, { side, change });
  };
  row.onclick = (event) => {
    const act = event && event.target && event.target.closest ? event.target.closest('.git-row-act') : null;
    if (act) {
      event.stopPropagation();
      if (act.dataset.act === 'discard') gitDiscard(project, state, repo, body, { path: change.path, dir: false });
      else gitStageFiles(project, state, repo, body, [change], act.dataset.act === 'stage', { side, change });
      return;
    }
    select();
  };
  if (staging) row.oncontextmenu = (event) => gitOpenRowMenu(event, project, state, repo, body, side, { path: change.path, dir: false });
  row.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rows = [...list.querySelectorAll('.git-file-row, .git-folder-row')];
      const next = rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) { next.focus(); if (next.classList.contains('git-file-row')) next.click(); }
    }
  };
  return row;
}

/**
 * A folder of the tree. In a list that stages (`opts.side`), it also has the
 * buttons and the right-click menu of the files inside it: Discard and Stage
 * in "Changes", Unstage in "Staged Changes".
 */
function createGitFolderRow(project, state, repo, body, collapsedSet, row, holdsSelected, opts) {
  const side = opts && opts.side;
  const folderPath = opts && opts.folderPath;
  const el = document.createElement('div');
  el.className = 'git-folder-row' + (holdsSelected ? ' selected' : '');
  el.tabIndex = 0;
  el.setAttribute('role', 'treeitem');
  el.dataset.key = row.key;
  el.style.setProperty('--depth', String(row.depth));
  el.setAttribute('aria-expanded', row.collapsed ? 'false' : 'true');
  const name = row.name.split('/').pop();
  const icon = typeof fileIconHtml === 'function' ? fileIconHtml(name, { dir: true, open: !row.collapsed }) : `<span class="git-folder-icon">${PICONS.folder(13)}</span>`;
  let actions = '';
  if (side && gitCanStage()) {
    const label = escapeHtml(row.name);
    if (side === 'unstaged' && gitCanDiscard()) actions += `<button type="button" class="git-row-act" data-act="discard" title="Discard Changes" aria-label="Discard changes in ${label}">${GICONS.discard(13)}</button>`;
    actions += side === 'staged'
      ? `<button type="button" class="git-row-act" data-act="unstage" title="Unstage Changes" aria-label="Unstage ${label}">${GICONS.minus(13)}</button>`
      : `<button type="button" class="git-row-act" data-act="stage" title="${side === 'merge' ? 'Stage (Mark as Resolved)' : 'Stage Changes'}" aria-label="Stage ${label}">${GICONS.plus(13)}</button>`;
  }
  el.innerHTML = `
    <span class="git-folder-chevron">${row.collapsed ? PICONS.chevronRight(11) : PICONS.chevronDown(11)}</span>
    ${icon}
    <span class="git-folder-name mono">${escapeHtml(row.name)}</span>
    ${row.count ? `<span class="git-folder-count">${row.count}</span>` : ''}${actions ? `<span class="git-row-acts">${actions}</span>` : ''}`;
  const target = folderPath ? { path: folderPath, dir: true } : null;
  const toggle = () => {
    if (collapsedSet.has(row.key)) collapsedSet.delete(row.key); else collapsedSet.add(row.key);
    paintGitChanges(project, state, repo, body, { repaintDiff: false });
    // The list was rebuilt, so put keyboard focus back on the new copy of this row.
    [...body.querySelectorAll('.git-folder-row')].find(item => item.dataset.key === row.key)?.focus();
  };
  el.onclick = (event) => {
    const act = event && event.target && event.target.closest ? event.target.closest('.git-row-act') : null;
    if (act && target) {
      event.stopPropagation();
      if (act.dataset.act === 'discard') { gitDiscard(project, state, repo, body, target); return; }
      const inside = (gitSideLists(repo.changes)[side] || []).filter(change => GitChangeActionsLib().inTarget(change.path, target));
      gitStageFiles(project, state, repo, body, inside, act.dataset.act === 'stage');
      return;
    }
    toggle();
  };
  el.onkeydown = (event) => {
    if (event.target !== el) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
  };
  if (side && target) el.oncontextmenu = (event) => gitOpenRowMenu(event, project, state, repo, body, side, target);
  return el;
}

/** A list's heading: its name, how many files, and Stage All / Unstage All. */
function createGitGroupRow(project, state, repo, body, side, label, changes) {
  const head = document.createElement('div');
  head.className = 'git-file-group';
  const staging = gitCanStage();
  let action = '';
  if (staging && side === 'staged') action = `<button type="button" class="git-row-act" data-act="unstage-all" title="Unstage All Changes" aria-label="Unstage All Changes">${GICONS.minus(13)}</button>`;
  else if (staging) action = `<button type="button" class="git-row-act" data-act="stage-all" title="${side === 'merge' ? 'Stage All Merge Changes' : 'Stage All Changes'}" aria-label="Stage All">${GICONS.plus(13)}</button>`;
  if (staging && side === 'unstaged' && gitCanDiscard()) action = `<button type="button" class="git-row-act" data-act="discard-all" title="Discard All Changes" aria-label="Discard All Changes">${GICONS.discard(13)}</button>${action}`;
  head.innerHTML = `<span class="git-file-group-label">${escapeHtml(label)}</span><span class="git-file-group-count">${changes.length}</span><span class="git-row-acts">${action}</span>`;
  head.onclick = (event) => {
    const act = event && event.target && event.target.closest ? event.target.closest('.git-row-act') : null;
    if (!act) return;
    if (act.dataset.act === 'discard-all') { gitDiscard(project, state, repo, body, null); return; }
    gitStageFiles(project, state, repo, body, changes, act.dataset.act === 'stage-all');
  };
  return head;
}

function paintGitChanges(project, state, repo, body, { repaintDiff = true } = {}) {
  const list = body.querySelector('#git-file-list');
  if (!list) return;
  // A file in edit mode that is no longer changed (saved back as it was
  // staged, say) leaves edit mode, unless it has text that is not saved.
  if (state.editors) {
    for (const [key, session] of state.editors) {
      if (!key.startsWith(`${repo.path}\0`) || repo.changes.some(c => gitEditKey(repo, c.path) === key) || gitEditDirty(session)) continue;
      state.editors.delete(key);
      gitDropEditDraft(session);
      gitDropEditSession(session);
    }
  }
  const tree = gitChangesViewMode() === 'tree';
  const collapsedSet = gitCollapsedSet(state, repo.path);
  list.replaceChildren();

  if (!gitCanStage()) {
    // Read-only: the old grouping by kind of change.
    const groupOrder = ['conflicted', 'modified', 'added', 'deleted', 'renamed', 'untracked'];
    const groupLabels = { conflicted: 'Conflicted', modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'Untracked' };
    const selectedPath = state.selectedFiles.get(repo.path);
    const selected = repo.changes.find(change => change.path === selectedPath) || repo.changes[0] || null;
    if (selected) state.selectedFiles.set(repo.path, selected.path);
    for (const kind of groupOrder) {
      const changes = repo.changes.filter(change => change.status === kind);
      if (!changes.length) continue;
      const label = document.createElement('div');
      label.className = 'git-file-group';
      label.textContent = groupLabels[kind];
      list.appendChild(label);
      if (!tree) {
        for (const change of changes) list.appendChild(createGitFileRow(project, state, repo, body, list, change, selected?.path === change.path, { tree: false }));
        continue;
      }
      for (const row of gitTreeRows(buildGitChangeTree(changes), collapsedSet, kind)) {
        if (row.kind === 'folder') {
          const folderPath = row.key.slice(kind.length + 1);
          const holdsSelected = row.collapsed && selected?.status === kind && selected.path.startsWith(`${folderPath}/`);
          list.appendChild(createGitFolderRow(project, state, repo, body, collapsedSet, row, holdsSelected));
        } else {
          list.appendChild(createGitFileRow(project, state, repo, body, list, row.change, selected?.path === row.change.path, { tree: true, depth: row.depth, name: row.name }));
        }
      }
    }
    if (repaintDiff) paintGitDiff(project, state, repo, body, selected);
    return;
  }

  const lists = gitSideLists(repo.changes);
  const items = GIT_SIDES.flatMap(({ side }) => lists[side].map(change => ({ side, change })));
  const selected = gitSelectedItem(state, repo, items);
  if (selected) state.selectedFiles.set(repo.path, gitSelectionKey(selected.side, selected.change.path));
  const isSelected = (side, change) => !!selected && selected.side === side && selected.change.path === change.path;

  for (const { side, label } of GIT_SIDES) {
    const changes = lists[side];
    if (!changes.length) continue;
    list.appendChild(createGitGroupRow(project, state, repo, body, side, label, changes));
    if (!tree) {
      for (const change of changes) list.appendChild(createGitFileRow(project, state, repo, body, list, change, isSelected(side, change), { tree: false, side }));
      continue;
    }
    for (const row of gitTreeRows(buildGitChangeTree(changes), collapsedSet, side)) {
      if (row.kind === 'folder') {
        // A collapsed folder hiding the selected file stands in for it.
        const folderPath = row.key.slice(side.length + 1);
        const holdsSelected = row.collapsed && selected?.side === side && selected.change.path.startsWith(`${folderPath}/`);
        list.appendChild(createGitFolderRow(project, state, repo, body, collapsedSet, row, holdsSelected, { side, folderPath }));
      } else {
        list.appendChild(createGitFileRow(project, state, repo, body, list, row.change, isSelected(side, row.change), { tree: true, depth: row.depth, name: row.name, side }));
      }
    }
  }
  if (repaintDiff) paintGitDiff(project, state, repo, body, selected);
}

function gitViewToggleHtml(mode) {
  const btn = (view, label, icon) => `<button type="button" class="git-view-btn${mode === view ? ' on' : ''}" data-view="${view}" title="${label}" aria-label="${label}" aria-pressed="${mode === view}">${icon}</button>`;
  return `<span class="git-view-toggle" role="group" aria-label="Changes view">
    ${btn('list', 'View as list', PICONS.list(13))}
    ${btn('tree', 'View as tree', PICONS.tree(13))}
  </span>`;
}

/**
 * The top of the Changes tab: one tab per repository (only when there are
 * several), then the chosen one's path right under them, with "Read only" at
 * its end when nothing can be staged. The repository's name is already on its
 * tab, so it is not repeated above.
 */
function gitRepoHeaderHtml(repositories, repo, { readOnly = false } = {}) {
  const picker = repositories.length > 1 ? `
    <div class="git-repo-picker" role="tablist" aria-label="Repositories">
      ${repositories.map((item, index) => `<button type="button" class="git-repo-option ${item.path === repo.path ? 'active' : ''}" data-index="${index}">${escapeHtml(gitRepoName(item))}</button>`).join('')}
    </div>` : '';
  const badge = readOnly ? '<span class="git-readonly">Read only</span>' : '';
  return `${picker}
        <div class="git-tab-pathline"><span class="git-tab-path mono">${escapeHtml(repo.path)}</span>${badge}</div>`;
}

function paintGitRepository(project, state, body) {
  const repositories = state.repositories || [];
  if (!repositories.length) {
    body.innerHTML = '<div class="git-empty-state"><div class="git-empty-title">No folders attached</div><div>Git information will appear here when this project has an attached repository.</div></div>';
    return;
  }

  let repo = repositories.find(item => item.path === state.selectedRepo);
  if (!repo) repo = repositories.find(item => item.git) || repositories[0];
  state.selectedRepo = repo.path;

  if (!repo.git) {
    body.innerHTML = `
      <div class="git-tab-shell">
        ${gitRepoHeaderHtml(repositories, repo, { readOnly: true })}
        <div class="git-empty-state"><div class="git-empty-title">Not a Git repository</div><div>${escapeHtml(repo.path)}</div></div>
      </div>`;
  } else {
    const changed = repo.changes.length;
    body.innerHTML = `
      <div class="git-tab-shell">
        ${gitRepoHeaderHtml(repositories, repo, { readOnly: !gitCanStage() })}
        ${gitOverviewHtml(repo)}
        <section class="git-section">
          <div class="git-section-heading"><span>Changes</span><span class="git-heading-right">${changed && typeof knImpactButtonHtml === 'function' && knIsAttached(project, repo.path) ? knImpactButtonHtml() : ''}${changed ? gitViewToggleHtml(gitChangesViewMode()) : ''}<span class="git-section-meta">${changed ? `${changed} file${changed === 1 ? '' : 's'}` : 'Working tree clean'}</span></span></div>
          ${changed ? '<div class="git-changes"><div class="git-file-list" id="git-file-list" role="tree" aria-label="Changed files"></div><div class="git-diff-pane" id="git-diff-pane"></div></div>' : '<div class="git-empty-row">There are no staged, unstaged, or untracked files.</div>'}
        </section>
      </div>`;
    if (changed) paintGitChanges(project, state, repo, body);
    // Impact (Node Knowledge), drawn only for an attached folder with changes.
    if (changed && typeof knOpenImpact === 'function' && knIsAttached(project, repo.path)) {
      const impact = body.querySelector('[data-kn-act="git-impact"]');
      if (impact) impact.onclick = () => knOpenImpact(project, repo.path, 'uncommitted');
    }
  }

  body.querySelectorAll('.git-repo-option').forEach(button => {
    const item = repositories[Number(button.dataset.index)];
    if (!item) return;
    button.title = item.path;
    button.onclick = () => {
      state.selectedRepo = item.path;
      paintGitRepository(project, state, body);
    };
  });

  body.querySelectorAll('.git-view-btn').forEach(button => {
    button.onclick = () => {
      setGitChangesViewMode(button.dataset.view);
      // Read back what was stored so the buttons match what gets rendered.
      const effective = gitChangesViewMode();
      body.querySelectorAll('.git-view-btn').forEach(btn => {
        const on = btn.dataset.view === effective;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
      });
      paintGitChanges(project, state, repo, body, { repaintDiff: false });
    };
  });
}

function renderProjectGitTab(project, body) {
  const state = gitTabState(project.id);
  body.className = 'git-workspace-view git-tab-body';
  if (state.repositories) paintGitRepository(project, state, body);
  else body.innerHTML = '<div class="git-loading"><span class="git-loading-dot"></span>Reading repository…</div>';

  const request = ++state.request;
  state.error = '';
  window.api.getProjectGitInfo(project.id).then((result) => {
    if (request !== state.request) return;
    if (!result?.ok) throw new Error(result?.error || 'Could not read Git information.');
    for (const entry of state.diffs.values()) entry.stale = true;
    state.repositories = result.repositories || [];
    if (body.isConnected && selectedProject()?.id === project.id && projectTab(project) === 'git' && projectGitView(project) === 'changes') {
      const scroll = body.scrollTop;
      paintGitRepository(project, state, body);
      body.scrollTop = scroll;
    }
  }).catch((err) => {
    if (request !== state.request) return;
    state.error = err?.message || 'Could not read Git information.';
    if (body.isConnected) body.innerHTML = `<div class="git-empty-state"><div class="git-empty-title">Git information unavailable</div><div>${escapeHtml(state.error)}</div></div>`;
  });
}
