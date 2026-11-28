// Projects as the desktop's Projects tab shows them (public/projects-view.js
// in switchboard): grouped by state, rolled up from their sessions, with the
// same prompts for starting a session on part of the plan.

import { rowState, type LiveState, type Notices, type RowState, type Session } from '@/sessions/model';
import { compareByRank } from '@/shared/vendor/pinned-order';
import { projectSnoozed } from '@/shared/vendor/snooze';

export type Track = { id: string; name: string; status: 'active' | 'done'; cwd: string | null; cli: string | null; sessions: Session[] };
export type ProjectFolder = { path: string; mode: 'in-place' | 'worktree'; sourcePath?: string | null; branch?: string | null };

export type Schedule = {
  id: string; name: string; prompt: string; projectId: string | null; trackId: string | null; cwd: string | null;
  every: '15m' | '30m' | 'hour' | 'day' | 'weekdays' | 'week' | 'cron';
  atHour: number | null; atMinute: number | null; weekday: number | null; cron: string | null;
  cli: string | null; enabled: boolean; lastRunAt: string | null; sessionConfig?: Record<string, Record<string, unknown>>;
};

/** A node of get-project-tree. */
export type Project = {
  id: string; name: string; root: string; status: 'active' | 'done';
  snoozedUntil: string | null; defaultCwd: string | null;
  /** Starred: listed above Active, and first on the Snoozed and Done shelves. */
  starred?: boolean;
  /** Its place in the Starred section (pinned-order.js); null until a drag, none from an older desktop. */
  starRank?: number | null;
  /** The version of its picture (get-project-icon); null when it shows initials, none from an older desktop. */
  icon?: string | null;
  /** The project folder's name, and the worktree branch when none is set. */
  slug?: string;
  /** One branch for every worktree of the project (branchName, else the slug), or each worktree names its own. */
  sharedBranch?: boolean; branchName?: string | null;
  folders: ProjectFolder[]; tracks: Track[]; schedules: Schedule[]; sessions: Session[];
  lastActivity?: string | null; modified?: string | null;
};

export type PlanItem = { line: number; text: string; done: boolean };
export type Phase = { title: string; line: number; headingDone: boolean | null; items: PlanItem[]; ticked: number; done: boolean; single?: boolean };

/** get-project-plan: phases from plan-tracker.md, todos from todos.md. */
export type ProjectPlan = {
  plan: { phases: Phase[]; done: number; total: number; next: Phase | null };
  todos: PlanItem[];
  planPath: string; trackerPath: string; todosPath: string;
  hasPlan: boolean; hasTracker: boolean; hasTodos: boolean;
};

export function projectSessions(project: Project): Session[] {
  return [...project.sessions, ...project.tracks.flatMap((track) => track.sessions)];
}

export type RowStat = { key: 'plan' | 'todos' | 'tracks' | 'sessions'; label: string; value: string };

/**
 * The numbers on a project row's second line, as the desktop's Projects tab
 * shows them: plan phases done of all, todos open of all, open tracks, and
 * sessions that are not archived. A long dash means none, so there is still
 * something to tap; "…" means the plan has not arrived yet (undefined), and a
 * plan that could not be read (null) counts as none.
 */
export function projectRowStats(project: Project, plan: Pick<ProjectPlan, 'plan' | 'todos'> | null | undefined): RowStat[] {
  const ratio = (part: number, whole: number) => (plan === undefined ? '…' : whole ? `${part}/${whole}` : '—');
  const phases = plan?.plan.phases.length ?? 0;
  const todos = plan?.todos ?? [];
  const tracks = project.tracks.filter((t) => t.status !== 'done').length;
  const sessions = projectSessions(project).filter((s) => !s.archived).length;
  return [
    { key: 'plan', label: 'Plan', value: ratio(plan?.plan.done ?? 0, phases) },
    { key: 'todos', label: 'Todos', value: ratio(todos.filter((t) => !t.done).length, todos.length) },
    { key: 'tracks', label: 'Tracks', value: tracks ? String(tracks) : '—' },
    { key: 'sessions', label: 'Sessions', value: sessions ? String(sessions) : '—' },
  ];
}

const URGENCY: RowState[] = ['attention', 'busy', 'subagent', 'unread', 'running', 'idle'];

/** The most urgent state among sessions, as a project's dot shows it. */
export function rollupState(sessions: Session[], live: Record<string, LiveState>, notices: Notices): RowState {
  let best = URGENCY.length - 1;
  for (const session of sessions) best = Math.min(best, URGENCY.indexOf(rowState(session.sessionId, live[session.sessionId], notices)));
  return URGENCY[best];
}

/**
 * Starred (the starred ones at work), active, snoozed (until it wakes, or a
 * session needs you) and done, as the desktop's sidebar: a snoozed or
 * finished project keeps its shelf, starred ones first there. Starred is in
 * the order it was dragged into; one starred since comes after, in the
 * desktop's order.
 */
export function groupProjects(projects: Project[], { now = Date.now(), live = {}, notices }: { now?: number; live?: Record<string, LiveState>; notices: Notices }) {
  const groups: { starred: Project[]; active: Project[]; snoozed: Project[]; done: Project[] } = { starred: [], active: [], snoozed: [], done: [] };
  for (const project of projects) {
    if (project.status === 'done') groups.done.push(project);
    else if (projectSnoozed(project, now, rollupState(projectSessions(project), live, notices) === 'attention')) groups.snoozed.push(project);
    else (project.starred ? groups.starred : groups.active).push(project);
  }
  const starFirst = (a: Project, b: Project) => Number(!!b.starred) - Number(!!a.starred);
  groups.starred.sort(compareByRank((p: Project) => p.starRank, () => 0));
  groups.snoozed.sort(starFirst);
  groups.done.sort(starFirst);
  return groups;
}

/** Where a session for the project (or one of its tracks) starts. */
export function launchTarget(project: Project, track: Track | null) {
  return { projectPath: track?.cwd || project.defaultCwd || project.root, projectId: project.id, trackId: track?.id || null };
}

export function phasePrompt(plan: Pick<ProjectPlan, 'trackerPath' | 'planPath' | 'hasPlan'>, phase: Phase): string {
  const lines = [`Work on this phase of the plan. The tracker is ${plan.trackerPath}` + (plan.hasPlan ? ` and the plan itself is ${plan.planPath}.` : '.'), '', `Phase: ${phase.title}`];
  const open = phase.items.filter((item) => !item.done);
  if (open.length) { lines.push('', 'Open items:'); for (const item of open) lines.push(`- ${item.text}`); }
  lines.push('', 'When an item is finished, tick it in the tracker. Tick the phase heading once the whole phase is done.');
  return lines.join('\n');
}

export function phaseItemPrompt(plan: Pick<ProjectPlan, 'trackerPath'>, phase: Phase, item: PlanItem): string {
  return `Work on this item from phase "${phase.title}" of the plan. The tracker is ${plan.trackerPath}.\n\n${item.text}\n\nWhen it is done, tick it in the tracker.`;
}

export function todoPrompt(plan: Pick<ProjectPlan, 'todosPath'>, item: PlanItem): string {
  return `Work on this todo from ${plan.todosPath}:\n\n${item.text}\n\nWhen it is done, tick it in todos.md.`;
}

const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const pad = (n: number | null | undefined) => String(n ?? 0).padStart(2, '0');

/** "Every day at 09:30", "Mondays at 09:00"… */
export function scheduleSummary(schedule: Schedule): string {
  const at = `${pad(schedule.atHour ?? 9)}:${pad(schedule.atMinute)}`;
  const when = {
    '15m': 'Every 15 minutes',
    '30m': 'Every 30 minutes',
    hour: `Every hour at :${pad(schedule.atMinute)}`,
    day: `Every day at ${at}`,
    weekdays: `Weekdays at ${at}`,
    week: `${WEEKDAYS[schedule.weekday ?? 1]} at ${at}`,
    cron: `Cron ${schedule.cron || ''}`.trim(),
  }[schedule.every] || schedule.every;
  return schedule.enabled ? when : `${when} (paused)`;
}

export type ScheduleForm = {
  name: string; prompt: string; every: Exclude<Schedule['every'], 'cron'>;
  time: string; minute: string; weekday: number; trackId: string | null; cli: string | null; enabled: boolean;
  /** Whether the timing was touched: a schedule's own timing (a cron, say) is kept otherwise. */
  timingChanged: boolean;
};

/** "9:30" → [9, 30]; null when it is not a time. */
function parseTime(text: string): [number, number] | null {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  return hour <= 23 && minute <= 59 ? [hour, minute] : null;
}

/** What create-schedule or update-schedule gets from the form, or what is wrong with it. */
export function scheduleFields(existing: Schedule | undefined, form: ScheduleForm): { fields: Record<string, unknown>; error?: undefined } | { error: string; fields?: undefined } {
  if (!form.name.trim() || !form.prompt.trim()) return { error: 'A schedule needs a name and a prompt' };
  const fields: Record<string, unknown> = { name: form.name.trim(), prompt: form.prompt.trim(), trackId: form.trackId, cli: form.cli, enabled: form.enabled };
  if (existing && !form.timingChanged) return { fields };
  fields.every = form.every;
  if (form.every === 'hour') {
    const minute = Number(form.minute);
    if (!/^\d{1,2}$/.test(form.minute.trim()) || minute > 59) return { error: 'The minute goes from 0 to 59' };
    fields.atMinute = minute;
  } else if (form.every === 'day' || form.every === 'weekdays' || form.every === 'week') {
    const at = parseTime(form.time);
    if (!at) return { error: 'Write the time as 9:30' };
    [fields.atHour, fields.atMinute] = at;
    if (form.every === 'week') fields.weekday = form.weekday;
  }
  return { fields };
}
