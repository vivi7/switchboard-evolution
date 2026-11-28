// What the sidebar's Files tab lists, and in which sections (files-view.js
// draws them):
//   1. the pinned files of no project, in the order the user gave;
//   2. the pinned projects' groups, in the order the user gave;
//   3. the files opened by dropping them on the sidebar and those with a tab in
//      any editor of the app;
//   4. the agent files (CLAUDE.md, AGENTS.md, memory…), Global and by project,
//      as main.js get-memories finds them.
// A pinned file stays in the group of its project, ahead of the others, with
// every filter. The filter combo shows the opened files, the agent files or
// both. "All" lists every opened file under "Opened", with its project's name,
// next to the row its group has: the pinned ones first, in the order the user
// gave, then the others, by project then file name. "Opened files" groups them
// by the project they are in, pinned projects first; those of no project stay
// under "Opened". A search narrows every section.
// No DOM, so node --test loads it as well.

const FILES_FILTERS = [
  ['all', 'All files'],
  ['agents', 'Agent files'],
  ['opened', 'Opened files'],
];
const FILES_FILTER_KEY = 'files.filter';

function validFilesFilter(value) {
  return FILES_FILTERS.some(([key]) => key === value) ? value : 'all';
}

/** The project's folders that hold the file, the deepest first. */
function foldersAround(project, filePath) {
  return [project.root, ...(project.folders || []).map(folder => folder && folder.path)]
    .filter(root => root && (filePath.startsWith(`${root}/`) || filePath.startsWith(`${root}\\`)))
    .sort((a, b) => b.length - a.length);
}

/**
 * The project a file is listed under: the one whose Files tab has it open,
 * else the one with the deepest folder around it; null for none.
 */
function projectOfFile(projects, filePath, projectId) {
  const opened = projects.find(project => projectId != null && String(project.id) === String(projectId));
  if (opened) return opened;
  let found = null;
  let depth = 0;
  for (const project of projects) {
    const [root] = foldersAround(project, filePath);
    if (root && root.length > depth) { found = project; depth = root.length; }
  }
  return found;
}

/**
 * An open file that is in no list, as a row shows it: its folder from the
 * project's, with the attached folder's name for a file of one.
 */
function openFileEntry(filePath, project) {
  const at = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const folder = filePath.slice(0, Math.max(at, 0));
  const filename = filePath.slice(at + 1);
  const [root] = project ? foldersAround(project, filePath) : [];
  if (!root) return { filePath, filename, displayPath: folder };
  const attached = root === project.root ? '' : root.split(/[\\/]/).filter(Boolean).pop();
  const inside = [attached, folder.slice(root.length + 1)].filter(Boolean).join('/');
  return { filePath, filename, displayPath: inside ? `${inside}/` : './' };
}

/** The deepest of the agent groups whose folder holds the file: { group, depth }. */
function agentGroupAround(agentProjects, filePath) {
  let group = null;
  let depth = 0;
  for (const project of agentProjects) {
    const [root] = foldersAround({ root: project.projectPath }, filePath);
    if (root && root.length > depth) { group = project; depth = root.length; }
  }
  return { group, depth };
}

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** By project name, then file name; the files of no project last. */
function compareOpenRows(a, b) {
  return (!a.projectName - !b.projectName) || byName(a.projectName, b.projectName)
    || byName(a.filename, b.filename) || byName(a.filePath, b.filePath);
}

/** The filter last chosen, kept across restarts. */
function loadFilesFilter(storage) {
  try { return validFilesFilter(storage && storage.getItem(FILES_FILTER_KEY)); } catch { return 'all'; }
}

function saveFilesFilter(storage, value) {
  try { if (storage) storage.setItem(FILES_FILTER_KEY, validFilesFilter(value)); } catch {}
}

/** Every agent file by path, the first place it is found winning. */
function agentFilesByPath(agents) {
  const byPath = new Map();
  const add = (file) => { if (file && file.filePath && !byPath.has(file.filePath)) byPath.set(file.filePath, file); };
  for (const file of (agents && agents.global && agents.global.files) || []) add(file);
  for (const project of (agents && agents.projects) || []) for (const file of project.files || []) add(file);
  return byPath;
}

/**
 * The sections of the tab.
 * @param {object} input
 * @param {object} input.agents   - get-memories: { global: { files }, projects: [{ folder, projectPath, shortName, files }] }
 * @param {object} input.opened   - get-opened-files: { opened: [file], pinned: [file], pinnedProjects: [key] }
 * @param {string} input.filter   - 'all' | 'agents' | 'opened'
 * @param {Set<string>|null} input.matchIds - paths a search found, or null without a search
 * @param {Array<{ filePath, projectId }>} input.open - the files with a tab in an editor
 * @param {Array<{ id, name, root, folders }>} input.projects - the project tree's projects, in its order
 * @param {string} input.query    - the search's words: an open file is also found by its path
 * @returns {{ pinned: object[], pinnedGroups: Array<{ key, pinKey, label, files }>,
 *            opened: object[], groups: Array<{ key, pinKey, label, files }>, filter: string }}
 */
function buildFilesSections({ agents, opened, filter, matchIds = null, open = [], projects = [], query = '' } = {}) {
  const show = validFilesFilter(filter);
  const matches = (filePath) => !matchIds || matchIds.has(filePath);
  const agentFiles = agentFilesByPath(agents);
  const globalFiles = (agents && agents.global && agents.global.files) || [];
  const agentProjects = (agents && agents.projects) || [];
  const openedFiles = new Map(((opened && opened.opened) || []).map(file => [file.filePath, file]));
  const pinnedFiles = new Map(((opened && opened.pinned) || [])
    .filter(file => file && file.filePath).map(file => [file.filePath, file]));
  const openFiles = new Map(open.map(file => [file.filePath, file]));
  // The search index has no open file as such: its path is looked at too.
  const words = query.trim().toLowerCase();
  const matchesListed = (filePath) => matches(filePath)
    || (!!words && openFiles.has(filePath) && filePath.toLowerCase().includes(words));
  const projectFor = (filePath) => projectOfFile(projects, filePath, openFiles.get(filePath)?.projectId);
  // A pinned file open somewhere keeps what is known of it (found or not, when changed).
  const entry = (filePath, project) => openedFiles.get(filePath) || agentFiles.get(filePath)
    || { ...pinnedFiles.get(filePath), ...openFileEntry(filePath, project) };
  const listingGroup = (filePath) => agentProjects.find(p => (p.files || []).some(f => f.filePath === filePath));
  const isGlobal = (filePath) => globalFiles.some(f => f.filePath === filePath);

  // The groups, in the order they show.
  const cards = new Map();
  const card = (key, pinKey, label) => {
    if (!cards.has(key)) cards.set(key, { key, pinKey, label, pins: [], files: [] });
    return cards.get(key);
  };
  const agentCard = (group) => card(group.folder, group.folder, group.shortName);
  const rootGroup = (project) => agentProjects.find(p => p.projectPath === project.root);
  // One pin for a project, whether the agent files or its opened ones show it.
  const projectCard = (project) => card(`open:${project.id}`, rootGroup(project)?.folder || project.root, project.name);
  if (show !== 'opened') {
    if (globalFiles.length) card('__global__', null, 'Global');
    for (const group of agentProjects) agentCard(group);
  }
  for (const project of projects) if (show === 'opened' || !rootGroup(project)) projectCard(project);

  /** The group a pinned file stays in; null for a file of no project. */
  const homeOf = (filePath) => {
    const project = projectFor(filePath);
    if (show === 'opened') return project ? projectCard(project) : null;
    if (isGlobal(filePath)) return cards.get('__global__');
    const listing = listingGroup(filePath);
    if (listing) return agentCard(listing);
    // The agent group of the folder around it, or its project's: the deeper folder wins.
    const around = agentGroupAround(agentProjects, filePath);
    const [folder] = project ? foldersAround(project, filePath) : [];
    if (around.group && (!project || around.depth >= (folder || '').length)) return agentCard(around.group);
    if (!project) return null;
    const group = rootGroup(project);
    return group ? agentCard(group) : projectCard(project);
  };

  const pinned = [];
  for (const [filePath, file] of pinnedFiles) {
    if (!matchesListed(filePath)) continue;
    const agent = agentFiles.get(filePath);
    // An agent file keeps the place its group shows (~/.claude, dev/app/), and
    // a project's file says its folder from the project's.
    const project = projectFor(filePath);
    const row = agent ? { ...file, ...agent }
      : openedFiles.get(filePath) || (project ? { ...file, ...openFileEntry(filePath, project) } : file);
    const home = homeOf(filePath);
    (home ? home.pins : pinned).push(row);
  }

  const unpinned = (files) => (files || []).filter(file => !pinnedFiles.has(file.filePath) && matches(file.filePath));
  if (show !== 'opened') {
    if (globalFiles.length) cards.get('__global__').files = unpinned(globalFiles);
    for (const group of agentProjects) agentCard(group).files = unpinned(group.files);
  }

  // The dropped files, then the others open somewhere.
  const listed = show === 'agents' ? []
    : [...new Set([...openedFiles.keys(), ...openFiles.keys()])].filter(matchesListed);
  // The pinned files in the user's order, ahead of every other one.
  const pinnedOrder = [...pinnedFiles.keys()];
  const pinRank = (file) => (pinnedFiles.has(file.filePath) ? pinnedOrder.indexOf(file.filePath) : pinnedOrder.length);
  let openedList = [];
  if (show === 'opened') {
    for (const filePath of listed) {
      if (pinnedFiles.has(filePath)) continue;
      const project = projectFor(filePath);
      if (project) projectCard(project).files.push(entry(filePath, project));
      else openedList.push(entry(filePath, null));
    }
  } else {
    openedList = listed.map((filePath) => {
      const project = projectFor(filePath);
      const projectName = project ? project.name : isGlobal(filePath) ? 'Global'
        : (listingGroup(filePath) || agentGroupAround(agentProjects, filePath).group)?.shortName || '';
      return { ...entry(filePath, project), projectName };
    }).sort((a, b) => (pinRank(a) - pinRank(b)) || compareOpenRows(a, b));
  }

  const order = (opened && opened.pinnedProjects) || [];
  const groups = [];
  const pinnedGroups = [];
  for (const { key, pinKey, label, pins, files } of cards.values()) {
    if (!pins.length && !files.length) continue;
    const group = { key, ...(pinKey ? { pinKey } : {}), label, files: [...pins, ...files] };
    (pinKey && order.includes(pinKey) ? pinnedGroups : groups).push(group);
  }
  pinnedGroups.sort((a, b) => order.indexOf(a.pinKey) - order.indexOf(b.pinKey));

  return { pinned, pinnedGroups, opened: openedList, groups, filter: show };
}

/** Whether the sections hold no file at all. */
function filesSectionsEmpty(sections) {
  return !sections.pinned.length && !sections.pinnedGroups.length && !sections.opened.length && !sections.groups.length;
}

/** Where a pinned file goes when moved one step up (-1) or down (+1); null when it cannot. */
function pinnedStep(pinnedPaths, filePath, step) {
  const from = pinnedPaths.indexOf(filePath);
  const to = from + step;
  if (from < 0 || to < 0 || to >= pinnedPaths.length) return null;
  return to;
}

/**
 * Where a pinned project or file goes when moved one step up or down among
 * those in sight (a file: among the pinned ones of its group): the index, among
 * all the pinned ones, of the neighbour it passes. Null when it cannot.
 */
function pinnedShownStep(allKeys, shownKeys, key, step) {
  const to = pinnedStep(shownKeys, key, step);
  if (to === null) return null;
  const index = allKeys.indexOf(shownKeys[to]);
  return index < 0 || !allKeys.includes(key) ? null : index;
}

/**
 * The rows selected after a click that holds a modifier: Ctrl/Cmd adds or
 * takes one, Shift takes every row from the last one clicked (`anchor`).
 * `order` are the paths of the rows as they show.
 */
function selectionAfterClick({ selected, order, anchor, clicked, range = false }) {
  const next = new Set(selected);
  if (range) {
    const from = order.indexOf(anchor);
    const to = order.indexOf(clicked);
    if (from < 0 || to < 0) next.add(clicked);
    else for (const filePath of order.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(filePath);
    return { selected: next, anchor: from < 0 ? clicked : anchor };
  }
  if (next.has(clicked)) next.delete(clicked);
  else next.add(clicked);
  return { selected: next, anchor: clicked };
}

/**
 * Where a pinned file dragged onto another pinned one goes: before it, or
 * after it when dropped on its lower half. The index is the one the file
 * takes once moved (main.js move-pinned-file); null when nothing moves.
 */
function pinnedDropIndex(pinnedPaths, fromPath, targetPath, after) {
  const from = pinnedPaths.indexOf(fromPath);
  const target = pinnedPaths.indexOf(targetPath);
  if (from < 0 || target < 0 || from === target) return null;
  let to = after ? target + 1 : target;
  if (from < to) to -= 1;
  return to === from ? null : to;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FILES_FILTERS, FILES_FILTER_KEY, validFilesFilter, loadFilesFilter, saveFilesFilter,
    buildFilesSections, filesSectionsEmpty, pinnedStep, pinnedDropIndex,
    pinnedShownStep, selectionAfterClick,
  };
}
