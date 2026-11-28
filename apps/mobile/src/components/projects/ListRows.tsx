import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { Fragment, memo, useState, type ComponentProps, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ReorderHandle } from '@/components/reorder/Reorder';
import { LeaveOutButton } from '@/components/SearchStopBar';
import { RamText, StarButton, STATE_COLORS } from '@/components/SessionRow';
import { markTint, projectInitials, trackTint, type DrawerGroup } from '@/projects/drawer';
import type { Project, RowStat } from '@/projects/model';
import { useProjectIcon } from '@/projects/queries';
import { cliLabel, relativeTime, sessionTitle, shortProjectPath, type RowState, type Session } from '@/sessions/model';
import { colors, spacing } from '@/theme';

// The rows of the Projects tab, drawn as the desktop's sidebar draws them
// (public/style.css: .proj-row, .proj-drawer, .pane-sec, .pane-session). An
// open project row and its drawer read as one card.

const CARD_BORDER = 'rgba(128,136,255,0.22)';
const CARD_FILL = '#141419';
const SECTION = '#6a6a82';
const HIT = { top: 6, bottom: 6, left: 6, right: 6 };

/** A chevron that turns down when open, as the desktop's does. */
function Chevron({ open, size = 14, color = colors.textFaint }: { open: boolean; size?: number; color?: string }) {
  return <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={size} color={color} />;
}

/** "ACTIVE" over the projects that are. */
export function SectionLabel({ title }: { title: string }) {
  return <Text style={styles.section} accessibilityRole="header">{title}</Text>;
}

/** "▸ SNOOZED · 3", "▸ DONE · 12", "▸ NO PROJECT · 40": a section that folds. */
export function SectionToggle({ title, count, open, onPress }: { title: string; count: number; open: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.toggle, pressed && styles.pressed]} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${title}, ${count}`}>
      <Chevron open={open} size={12} color={open ? colors.textDim : SECTION} />
      <Text style={[styles.section, styles.toggleText, open && styles.toggleOpen]}>{`${title} · ${count}`}</Text>
    </Pressable>
  );
}

/**
 * The project's mark: its own picture, else two letters on its own colour. With
 * `onPress` it is a button of its own, which picks that picture.
 */
export function ProjectMark({ project, size = 30, onPress, onLongPress }: {
  project: Pick<Project, 'id' | 'name' | 'icon'>;
  size?: number;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const tint = markTint(project.id);
  const picture = useProjectIcon(project);
  const box = { width: size, height: size, borderRadius: size * 0.25 };
  const mark = picture ? (
    <Image source={{ uri: picture }} style={[styles.mark, box]} contentFit="cover" cachePolicy="memory" accessibilityIgnoresInvertColors />
  ) : (
    <View style={[styles.mark, box, { backgroundColor: tint.bg }]}>
      <Text style={[styles.markText, { color: tint.fg, fontSize: Math.round(size * 0.4) }]}>{projectInitials(project.name)}</Text>
    </View>
  );
  if (!onPress) return mark;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={HIT}
      style={({ pressed }) => pressed && styles.markPressed}
      accessibilityRole="button"
      accessibilityLabel={`Change the icon of ${project.name}`}
    >
      {mark}
    </Pressable>
  );
}

/**
 * A project row: the chevron that opens its drawer, its mark, its name over
 * its numbers (tap one to see what it counts), and on the right its + (a new
 * session in the project) over how many of its sessions run and its state
 * dot. The rest of the row opens the project, and a long press on it shows
 * the project's actions. A tap on the mark picks the project's picture. In the
 * Starred section a handle at its end drags it among the others
 * (components/reorder).
 */
export const ProjectListRow = memo(function ProjectListRow({ project, open, dim, state, running, stats, tail, onToggle, onOpen, onLongPress, onNewSession, onPickIcon, onLeaveOut, handle }: {
  project: Project;
  open: boolean;
  /** Snoozed or done: quieter, as on the desktop. */
  dim: boolean;
  state: RowState;
  running: number;
  stats: RowStat[];
  tail: string;
  onToggle: () => void;
  onOpen: () => void;
  onLongPress?: () => void;
  onNewSession?: () => void;
  /** Only with a desktop that takes a picture from a phone. */
  onPickIcon?: () => void;
  onLeaveOut?: () => void;
  /** The drag handle, inside a ReorderItem. */
  handle?: boolean;
}) {
  const [named, setNamed] = useState<RowStat['key'] | null>(null);
  const spoken = [...stats.map((stat) => `${stat.label} ${stat.value}`), tail].filter(Boolean).join(', ');
  return (
    <View style={[styles.projectWrap, open && styles.projectOpen]}>
      <Pressable
        onPress={onToggle}
        hitSlop={HIT}
        style={({ pressed }) => [styles.expand, pressed && styles.expandPressed]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? `Hide the sessions of ${project.name}` : `Show the sessions of ${project.name}`}
      >
        <Chevron open={open} size={16} color={open ? '#a6abff' : colors.textFaint} />
      </Pressable>
      <Pressable
        onPress={onOpen}
        onLongPress={onLongPress}
        style={({ pressed }) => [styles.projectRow, dim && styles.dim, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${project.name}${project.starred ? ', starred' : ''}, ${spoken}`}
      >
        <ProjectMark project={project} onPress={onPickIcon} onLongPress={onLongPress} />
        <View style={styles.text}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>{project.name}</Text>
            {project.starred ? <Text style={styles.projectStar}>★</Text> : null}
          </View>
          <View style={styles.metaRow}>
            {stats.map((stat, i) => (
              <Fragment key={stat.key}>
                {i ? <Text style={styles.sep}> · </Text> : null}
                <Pressable
                  onPress={() => setNamed((current) => (current === stat.key ? null : stat.key))}
                  // The numbers are part of the row: a long press there too shows the actions.
                  onLongPress={onLongPress}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  accessibilityRole="button"
                  accessibilityLabel={`${stat.label} ${stat.value}`}
                >
                  <Text style={[styles.meta, named === stat.key && styles.metaNamed]}>{named === stat.key ? `${stat.label} ${stat.value}` : stat.value}</Text>
                </Pressable>
              </Fragment>
            ))}
            {tail ? <Text style={[styles.meta, styles.tail]} numberOfLines={1}>{` · ${tail}`}</Text> : null}
          </View>
        </View>
        {/* Centred as one block: alone, the + sits mid-row; with the status line under it, both move to make room. */}
        <View style={styles.side}>
          {/* Its own Pressable, so tapping it does not open the project. */}
          {onNewSession ? <Plus label={`New session in ${project.name}`} onPress={onNewSession} /> : null}
          {running || state !== 'idle' ? (
            <View style={styles.status}>
              {running ? <Text style={styles.count}>{running}</Text> : null}
              <View style={[styles.dot, { backgroundColor: STATE_COLORS[state], borderColor: state === 'idle' ? colors.border : STATE_COLORS[state] }]} />
            </View>
          ) : null}
        </View>
        {onLeaveOut ? <LeaveOutButton label={project.name} onPress={onLeaveOut} /> : null}
        {handle ? <ReorderHandle label={project.name} /> : null}
      </Pressable>
    </View>
  );
});

/** Inside a drawer's card: its sides and fill. `top` closes the card above (the "No project" one). */
function Card({ children, top }: { children: ReactNode; top?: boolean }) {
  return <View style={[styles.card, top && styles.cardTop]}>{children}</View>;
}

/** The bottom edge of a drawer's card. */
export function CardEnd() {
  return <View style={styles.cardEnd} />;
}

/** A + that starts a session, flat and blue as in the desktop's drawers. */
function Plus({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={HIT} style={({ pressed }) => [styles.plus, pressed && styles.plusPressed]} accessibilityRole="button" accessibilityLabel={label}>
      <Ionicons name="add" size={18} color={colors.accent} />
    </Pressable>
  );
}

/** A group's heading in a drawer: "TODAY 4", a track's name in its colour, "NEEDS INPUT 1"… with its + when it is a track's. */
export function GroupHead({ project, group, onPlus }: { project: Project; group: DrawerGroup; onPlus?: () => void }) {
  const color = group.track !== undefined ? trackTint(project, group.track).fg : group.tone === 'attention' ? colors.attention : group.tone === 'running' ? colors.running : SECTION;
  return (
    <Card>
      <View style={[styles.head, group.done && styles.dim]}>
        <Text style={[styles.headTitle, { color }]} numberOfLines={1}>{group.title}</Text>
        <Text style={styles.headCount}>{group.sessions.length}</Text>
        <View style={styles.flex} />
        {onPlus ? <Plus label={group.track ? `New session in ${group.track.name}` : 'New session'} onPress={onPlus} /> : null}
      </View>
    </Card>
  );
}

/** "No sessions yet." where a drawer or a track has none. */
export function NoneRow() {
  return (
    <Card>
      <View style={styles.none}>
        <Text style={styles.noneText}>No sessions yet.</Text>
      </View>
    </Card>
  );
}

/** "+ 3 older": the rest of a group. */
export function MoreRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Card>
      <Pressable onPress={onPress} style={({ pressed }) => [styles.more, pressed && styles.pressed]} accessibilityRole="button">
        <Text style={styles.moreText}>{label}</Text>
      </Pressable>
    </Card>
  );
}

/** "▸ Archived · 4" at the foot of a drawer. */
export function ArchivedToggle({ count, open, onPress }: { count: number; open: boolean; onPress: () => void }) {
  return (
    <Card>
      <Pressable onPress={onPress} style={({ pressed }) => [styles.archived, pressed && styles.pressed]} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <Chevron open={open} size={12} />
        <Text style={styles.archivedText}>{`Archived · ${count}`}</Text>
      </Pressable>
    </Card>
  );
}

/** A folder of sessions no project claims: it folds, and its + starts a session there. */
export function FolderHead({ projectPath, count, open, top, onPress, onPlus }: { projectPath: string; count: number; open: boolean; top: boolean; onPress: () => void; onPlus: () => void }) {
  return (
    <Card top={top}>
      <Pressable onPress={onPress} style={({ pressed }) => [styles.head, styles.folder, pressed && styles.pressed]} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${projectPath}, ${count}`}>
        <Chevron open={open} size={12} />
        <Text style={styles.folderTitle} numberOfLines={1}>{shortProjectPath(projectPath)}</Text>
        <Text style={styles.headCount}>{count}</Text>
        <View style={styles.flex} />
        <Plus label="New session in this folder" onPress={onPlus} />
      </Pressable>
    </Card>
  );
}

const STATE_WORDS: Partial<Record<RowState, string>> = { attention: 'waiting for you', busy: 'working', subagent: 'a subagent is working', unread: 'unread', running: 'running' };

/**
 * A session of a project, as the desktop's rows of a project (drawer, track
 * card): its title and star, over one line with its state dot (when it runs
 * or waits), its track, the CLI, when it last moved, how many messages, and
 * at its right what it uses. In a drawer (DrawerSessionRow) and in the
 * project's Overview alike.
 */
export const ProjectSessionRow = memo(function ProjectSessionRow({ session, project, here, state, showTrack, archived, ram, onPress, onLongPress, handle }: {
  session: Session;
  project: Project | null;
  /** The session open on the right: highlighted, as the desktop marks the one on screen. */
  here?: boolean;
  state: RowState;
  showTrack: boolean;
  archived?: boolean;
  /** What the live session uses, in bytes. */
  ram?: number;
  onPress: (session: Session) => void;
  onLongPress: (session: Session) => void;
  /** The drag handle of a pinned one, inside a ReorderItem. */
  handle?: boolean;
}) {
  const track = project && session.trackId ? project.tracks.find((t) => t.id === session.trackId) ?? null : null;
  const tint = project ? trackTint(project, track) : null;
  const when = relativeTime(session.modified || session.created);
  const words = [STATE_WORDS[state], showTrack && project ? (track?.name ?? 'General') : null, cliLabel(session), when, session.messageCount ? `${session.messageCount} msgs` : null];
  const lit = state !== 'idle';
  return (
    <Pressable
      onPress={() => onPress(session)}
      onLongPress={() => onLongPress(session)}
      style={({ pressed }) => [styles.session, archived && styles.dim, here && styles.here, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!here }}
      accessibilityLabel={`${sessionTitle(session)}, ${[...words, session.starred ? 'pinned' : null].filter(Boolean).join(', ')}`}
    >
      <View style={styles.sessionText}>
        <View style={styles.sessionLine}>
          <Text style={[styles.sessionTitle, state === 'unread' && styles.unread]} numberOfLines={1}>{sessionTitle(session)}</Text>
          <StarButton session={session} />
        </View>
        <View style={styles.sessionMeta}>
          {lit ? <View style={[styles.smallDot, { backgroundColor: STATE_COLORS[state] }]} /> : null}
          {showTrack && tint ? (
            <Text style={[styles.tag, { color: tint.fg, backgroundColor: tint.bg }]} numberOfLines={1}>{track?.name ?? 'General'}</Text>
          ) : null}
          <Text style={[styles.sessionMetaText, (state === 'attention' || state === 'unread') && { color: STATE_COLORS[state] }]} numberOfLines={1}>
            {[lit ? STATE_WORDS[state] : null, cliLabel(session), when].filter(Boolean).join(' · ')}
            {session.messageCount ? ` · ${session.messageCount} msgs` : ''}
          </Text>
          <View style={styles.flex} />
          <RamText bytes={ram} />
        </View>
      </View>
      {handle ? <ReorderHandle label={sessionTitle(session)} /> : null}
    </Pressable>
  );
});

/** A session in a project's drawer: the project's row, in the drawer's card. */
export const DrawerSessionRow = memo(function DrawerSessionRow(props: ComponentProps<typeof ProjectSessionRow>) {
  return <Card><ProjectSessionRow {...props} /></Card>;
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { backgroundColor: 'rgba(255,255,255,0.05)' },
  dim: { opacity: 0.6 },
  section: { color: SECTION, fontSize: 11, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase', paddingHorizontal: spacing.lg + 4, paddingTop: spacing.md, paddingBottom: spacing.xs },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.lg + 2, minHeight: 40, marginTop: 4 },
  toggleText: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 },
  toggleOpen: { color: colors.textDim },

  projectWrap: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: spacing.sm, borderRadius: 10,
    borderWidth: 1, borderColor: 'transparent',
  },
  projectOpen: { borderColor: CARD_BORDER, borderBottomWidth: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, backgroundColor: 'rgba(255,255,255,0.03)' },
  expand: { width: 34, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8, marginStart: 2 },
  expandPressed: { backgroundColor: 'rgba(255,255,255,0.08)' },
  projectRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingEnd: spacing.md, paddingVertical: 10, borderRadius: 8 },
  mark: { alignItems: 'center', justifyContent: 'center' },
  markText: { fontWeight: '700', letterSpacing: 0.3 },
  markPressed: { opacity: 0.6 },
  text: { flex: 1, gap: 3, minWidth: 0 },
  name: { color: colors.text, fontSize: 15.5, fontWeight: '600', flexShrink: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  /** Gold, as the desktop's starred project. */
  projectStar: { color: '#f5be3c', fontSize: 13 },
  metaRow: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  meta: { color: colors.textFaint, fontSize: 12, fontVariant: ['tabular-nums'] },
  metaNamed: { color: colors.text },
  sep: { color: colors.textFaint, fontSize: 12 },
  tail: { flexShrink: 1 },
  side: { alignItems: 'flex-end', justifyContent: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 14 },
  count: { color: colors.textFaint, fontSize: 12, fontVariant: ['tabular-nums'] },
  dot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1 },

  card: { marginHorizontal: spacing.sm, backgroundColor: CARD_FILL, borderLeftWidth: 1, borderRightWidth: 1, borderColor: CARD_BORDER, paddingHorizontal: 4 },
  cardTop: { borderTopWidth: 1, borderTopLeftRadius: 10, borderTopRightRadius: 10, paddingTop: 2 },
  cardEnd: {
    marginHorizontal: spacing.sm, marginBottom: spacing.sm, height: 6, backgroundColor: CARD_FILL,
    borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 1, borderColor: CARD_BORDER, borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm + 2, paddingTop: 10, paddingBottom: 4, minHeight: 34 },
  headTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase', flexShrink: 1 },
  headCount: { color: SECTION, fontSize: 11, fontWeight: '500' },
  plus: { width: 30, height: 26, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  plusPressed: { backgroundColor: 'rgba(128,136,255,0.16)' },
  none: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm + 2, paddingVertical: 8, minHeight: 40 },
  noneText: { color: colors.textFaint, fontSize: 13 },
  more: { paddingHorizontal: spacing.sm + 2, paddingVertical: 10, borderRadius: 7 },
  moreText: { color: colors.textFaint, fontSize: 12.5 },
  archived: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.sm + 2, minHeight: 40, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  archivedText: { color: colors.textFaint, fontSize: 12.5 },
  folder: { minHeight: 40, paddingTop: 6, paddingBottom: 6, borderRadius: 7 },
  folderTitle: { color: colors.textDim, fontSize: 12.5, fontWeight: '600', flexShrink: 1 },

  session: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm + 2, paddingVertical: 8, borderRadius: 7, minHeight: 48 },
  sessionText: { flex: 1, minWidth: 0, gap: 3 },
  here: { backgroundColor: 'rgba(128,136,255,0.16)', borderLeftWidth: 2, borderLeftColor: colors.accent },
  sessionLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sessionTitle: { flex: 1, color: '#c8c8dc', fontSize: 14.5 },
  unread: { color: colors.unread, fontWeight: '600' },
  sessionMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, overflow: 'hidden' },
  smallDot: { width: 7, height: 7, borderRadius: 4 },
  tag: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: 'hidden', maxWidth: 120 },
  sessionMetaText: { color: '#7a7a90', fontSize: 11.5, flexShrink: 1 },
});
