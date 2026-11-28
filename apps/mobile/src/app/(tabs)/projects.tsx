import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { Redirect, router, Tabs, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ConnectionBanner } from '@/components/ConnectionBanner';
import { DonateBox } from '@/components/DonateBox';
import { HeaderButton } from '@/components/HeaderButton';
import { ProjectActions } from '@/components/project/ProjectActions';
import {
  ArchivedToggle, CardEnd, DrawerSessionRow, FolderHead, GroupHead, MoreRow, NoneRow, ProjectListRow, SectionLabel, SectionToggle,
} from '@/components/projects/ListRows';
import { usePullRefresh } from '@/components/PullRefresh';
import { ReorderCell, ReorderItem, ReorderProvider } from '@/components/reorder/Reorder';
import { SearchStopBar } from '@/components/SearchStopBar';
import { SessionActions } from '@/components/SessionActions';
import { SessionRow } from '@/components/SessionRow';
import { Sheet } from '@/components/Sheet';
import { TextPrompt } from '@/components/TextPrompt';
import { GROUP_MODES, projectListRows, sessionEventTime, sessionsWithoutProject, type DrawerState, type ListRow } from '@/projects/drawer';
import { chooseProjectIcon } from '@/projects/icon';
import { pinnedGroup, STARRED, type OrderGroup } from '@/projects/order';
import { saveOrder } from '@/projects/save-order';
import { useListUi } from '@/projects/list-ui';
import { groupProjects, projectRowStats, projectSessions, rollupState, type Project } from '@/projects/model';
import { openSessionFromTabs } from '@/projects/open-session';
import { useSessionMemory } from '@/processes/session-memory';
import { act, useMinute, useProjectPlan, useProjectTree } from '@/projects/queries';
import { relativeTime, rowState, type Folder, type Session } from '@/sessions/model';
import { isLive, projectSearchResults, runningAmong } from '@/sessions/search-stop';
import { useSessionSearch } from '@/sessions/useSessionSearch';
import { projectSnoozed, snoozeWakeDescription } from '@/shared/vendor/snooze';
import { request, useCapability, useConnection } from '@/store/connection';
import { useDonate, useDonateBoxDue } from '@/store/donate';
import { colors, spacing } from '@/theme';

/**
 * Projects, as the desktop's sidebar lists them: active, then Snoozed and Done
 * folded, then the sessions of no project. The chevron before a project opens
 * a drawer under it with its sessions, grouped by time, track or state (the
 * combo beside the search); a session there opens on the project's Session
 * tab. On a Surface Duo the list stays on the left and the project opens on
 * the right. A long press on a project shows its actions, the ones the ⋯ of
 * its page shows. The Starred section, and each drawer's Pinned group, are
 * put in order by dragging their rows by the handle at their end.
 */
export default function ProjectsScreen() {
  const loaded = useConnection((s) => s.loaded);
  const desktop = useConnection((s) => s.desktop);
  const online = useConnection((s) => s.status.state === 'online');
  const live = useConnection((s) => s.live);
  const notices = useConnection((s) => s.notices);
  // What each live session uses, at the right of its row, as on the desktop.
  const memory = useSessionMemory();
  const navigation = useNavigation();
  const tree = useProjectTree();
  const now = useMinute();
  const ui = useListUi();
  const [creating, setCreating] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [actionsFor, setActionsFor] = useState<Session | null>(null);
  const [projectActionsFor, setProjectActionsFor] = useState<Project | null>(null);
  const [dragging, setDragging] = useState(false);
  // A desktop older than the order has no handles.
  const canOrderStarred = useCapability('set-starred-order');
  const canOrderPinned = useCapability('set-pinned-order');
  const canSetIcon = useCapability('import-project-icon');
  const donateDue = useDonateBoxDue();
  const closeDonate = useDonate((s) => s.close);

  const projects = useMemo(() => tree.data?.projects || [], [tree.data]);
  // The folders of the Sessions tab, for the sessions no project claims.
  const folders = useQuery({ queryKey: ['projects'], queryFn: () => request<Folder[]>('get-projects', [false]), enabled: online });
  const otherAll = useMemo(() => sessionsWithoutProject(folders.data || [], projects), [folders.data, projects]);
  // Archived sessions come with the full tree, read only while a drawer is open.
  const anyDrawer = Object.keys(ui.expanded).length > 0 || Object.values(ui.searchOverride).some(Boolean);
  const treeAll = useQuery({
    queryKey: ['project-tree', 'all'],
    queryFn: () => request<{ projects: Project[] }>('get-project-tree', [true]),
    enabled: online && anyDrawer,
  });

  // A search finds projects by name and sessions by what was said or their title, in projects or not.
  const allSessions = useMemo(() => [...projects.flatMap(projectSessions), ...otherAll.flatMap((f) => f.sessions)], [projects, otherAll]);
  const { query, setQuery, search, searching, matchIds, excludedSessions, excludedProjects, leftOut, leaveOut, restore } = useSessionSearch('projects', allSessions);
  const isRunning = useCallback((id: string) => isLive(live[id]), [live]);
  const clearSearchOverrides = useListUi((s) => s.clearSearchOverrides);
  useEffect(() => { if (!matchIds) clearSearchOverrides(); }, [matchIds, clearSearchOverrides]);

  const stateOf = useCallback((id: string): DrawerState => {
    if (rowState(id, live[id], notices) === 'attention') return 'attention';
    return isLive(live[id]) ? 'running' : '';
  }, [live, notices]);

  const rows = useMemo(() => {
    const found = matchIds
      ? new Map(projectSearchResults(projects, { query: search, matchIds, excludedProjects, excludedSessions, isRunning }).map((r) => [r.project.id, r.sessions]))
      : null;
    const other = matchIds
      ? sessionsWithoutProject(folders.data || [], projects, (s) => matchIds.has(s.sessionId) && !excludedSessions.has(s.sessionId))
      : otherAll;
    const archivedOf = (projectId: string) => {
      const full = treeAll.data?.projects.find((p) => p.id === projectId);
      return full ? projectSessions(full).filter((s) => s.archived).sort((a, b) => sessionEventTime(b) - sessionEventTime(a)) : [];
    };
    return projectListRows({ groups: groupProjects(projects, { now, live, notices }), found, other, ui, stateOf, archivedOf, now });
  }, [projects, folders.data, otherAll, treeAll.data, matchIds, search, excludedProjects, excludedSessions, isRunning, now, live, notices, ui, stateOf]);

  // Each group ordered by dragging, its ids in the order on screen.
  const orderIds = useMemo(() => {
    const groups = new Map<OrderGroup, string[]>();
    const add = (group: OrderGroup, id: string) => groups.set(group, [...(groups.get(group) || []), id]);
    for (const row of rows) {
      if (row.kind === 'project' && row.ordered) add(STARRED, row.project.id);
      if (row.kind === 'session' && row.ordered && row.project) add(pinnedGroup(row.project.id), row.session.sessionId);
    }
    return groups;
  }, [rows]);

  // What the search shows, for the bar's count and Stop: only the rows drawn.
  const shown = useMemo(() => rows.flatMap((row) => (row.kind === 'found' || (row.kind === 'session' && !row.project) ? [row.session] : [])), [rows]);
  const running = useMemo(() => runningAmong(shown, isRunning), [shown, isRunning]);

  const openProject = useCallback((project: Project) => router.push({ pathname: '/project/[id]', params: { id: project.id } }), []);
  // A session opens on its project's Session tab, here on any phone (the list is its project's).
  const openSession = useCallback((session: Session, project: Project | null) => {
    openSessionFromTabs(navigation, session, project?.id ?? null, { inProject: true });
  }, [navigation]);

  // The session open on the right: highlighted, and scrolled into sight when it changes.
  const selected = useListUi((s) => s.selectedSession);
  const listRef = useRef<FlatList<ListRow>>(null);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || scrolledTo.current === selected) return;
    const index = rows.findIndex((row) => (row.kind === 'session' || row.kind === 'found') && row.session.sessionId === selected);
    if (index < 0) return;
    scrolledTo.current = selected;
    listRef.current?.scrollToIndex({ index, viewPosition: 0.4, animated: true });
  }, [selected, rows]);
  const newSession = (target: string) => router.push({ pathname: '/new', params: { target } });

  const create = async (name: string) => {
    if (!name) return;
    try {
      const result = await act<{ project: Project }>('create-project', [{ name }]);
      tree.refetch();
      router.push({ pathname: '/project/[id]', params: { id: result.project.id } });
    } catch (err: any) {
      Alert.alert('Could not create the project', err.message);
    }
  };

  const renderItem = ({ item, index }: { item: ListRow; index: number }) => {
    switch (item.kind) {
      case 'section':
        return <SectionLabel title={item.title} />;
      case 'toggle':
        return <SectionToggle title={item.title} count={item.count} open={item.open} onPress={() => ui.toggleSection(item.section, searching)} />;
      case 'project': {
        const ordered = !!item.ordered && canOrderStarred;
        const row = (
          <ProjectRow
            project={item.project}
            open={item.open}
            now={now}
            onToggle={() => ui.toggleDrawer(item.project.id, searching)}
            onOpen={openProject}
            onLongPress={setProjectActionsFor}
            onNewSession={() => newSession(`p:${item.project.id}`)}
            onPickIcon={canSetIcon ? () => {
              chooseProjectIcon(item.project.id).catch((err: Error) => Alert.alert('Could not change the icon', err.message));
            } : undefined}
            onLeaveOut={searching ? () => leaveOut({ projectId: item.project.id }) : undefined}
            handle={ordered}
          />
        );
        return ordered
          ? <ReorderItem group={STARRED} id={item.project.id} ids={orderIds.get(STARRED) || []} rowKey={item.key}>{row}</ReorderItem>
          : row;
      }
      case 'head': {
        const { project, group } = item;
        const plus = item.plus === 'track' && group.track ? () => newSession(`t:${group.track!.id}`) : undefined;
        return <GroupHead project={project} group={group} onPlus={plus} />;
      }
      case 'none':
        return <NoneRow />;
      case 'session': {
        const ordered = !!item.ordered && !!item.project && canOrderPinned;
        const row = (
          <DrawerSessionRow
            session={item.session}
            project={item.project}
            here={item.session.sessionId === selected}
            state={rowState(item.session.sessionId, live[item.session.sessionId], notices)}
            showTrack={item.showTrack}
            archived={item.archived}
            ram={memory.get(item.session.sessionId)}
            onPress={(session) => openSession(session, item.project)}
            onLongPress={setActionsFor}
            handle={ordered}
          />
        );
        if (!ordered || !item.project) return row;
        const group = pinnedGroup(item.project.id);
        return <ReorderItem group={group} id={item.session.sessionId} ids={orderIds.get(group) || []} rowKey={item.key}>{row}</ReorderItem>;
      }
      case 'more':
        return <MoreRow label={item.label} onPress={() => ui.showWhole(item.listKey)} />;
      case 'archived':
        return <ArchivedToggle count={item.count} open={item.open} onPress={() => ui.toggleArchived(item.project.id)} />;
      case 'folder':
        return (
          <FolderHead
            projectPath={item.projectPath}
            count={item.count}
            open={item.open}
            top={rows[index - 1]?.kind === 'toggle'}
            onPress={() => ui.toggleFolder(item.projectPath, item.open)}
            onPlus={() => newSession(`f:${item.projectPath}`)}
          />
        );
      case 'end':
        return <CardEnd />;
      case 'found':
        return (
          <View style={[styles.nested, item.session.sessionId === selected && styles.here]}>
            <SessionRow
              session={item.session}
              state={rowState(item.session.sessionId, live[item.session.sessionId], notices)}
              ram={memory.get(item.session.sessionId)}
              onPress={(session) => openSession(session, item.project)}
              onLongPress={setActionsFor}
              onLeaveOut={(session) => leaveOut({ sessionId: session.sessionId })}
            />
          </View>
        );
      case 'empty':
        return <Text style={styles.empty}>{!online ? '' : tree.isLoading ? 'Loading projects…' : item.text}</Text>;
    }
  };

  const pull = usePullRefresh(() => Promise.all([tree.refetch(), folders.refetch()]));

  if (!loaded) return <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>;
  if (!desktop) return <Redirect href="/pair" />;

  const mode = GROUP_MODES.find((m) => m.key === ui.groupMode) ?? GROUP_MODES[0];
  return (
    <View style={styles.screen}>
      <Tabs.Screen
        options={{
          headerRight: () => (
            <HeaderButton icon="add" label="New" variant="primary" accessibilityLabel="New project" disabled={!online} onPress={() => setCreating(true)} />
          ),
        }}
      />
      <ConnectionBanner />
      <View style={styles.controls}>
        <View style={styles.searchRow}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search projects and sessions…"
            placeholderTextColor={colors.textFaint}
            style={styles.search}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
          <Pressable
            onPress={() => setGrouping(true)}
            style={({ pressed }) => [styles.group, pressed && styles.groupPressed]}
            accessibilityRole="button"
            accessibilityLabel={`Group sessions by ${mode.label}`}
          >
            <Text style={styles.groupText}>{mode.label}</Text>
            <Ionicons name="chevron-down" size={13} color={colors.textDim} />
          </Pressable>
        </View>
        {searching ? <SearchStopBar shown={shown.length} running={running} leftOut={leftOut} query={search} onRestore={restore} /> : null}
      </View>
      <ReorderProvider onOrder={(group, ids) => { saveOrder(group as OrderGroup, ids); }} onDragChange={setDragging}>
        <FlatList
          ref={listRef}
          data={rows}
          // The row being dragged rises above the cells after it; the list stays still meanwhile.
          CellRendererComponent={ReorderCell}
          scrollEnabled={!dragging}
          // Rows differ in height: a row not drawn yet is reached in two steps.
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
            setTimeout(() => listRef.current?.scrollToIndex({ index, viewPosition: 0.4, animated: true }), 120);
          }}
          keyExtractor={(row) => row.key}
          renderItem={renderItem}
          initialNumToRender={30}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          refreshControl={pull}
        />
      </ReorderProvider>
      {/* Pinned below the list, which gets the height left (src/store/donate.ts says when). */}
      {donateDue ? <DonateBox onClose={closeDonate} style={styles.donate} /> : null}
      <TextPrompt visible={creating} title="New project" confirm="Create" onClose={() => setCreating(false)} onSubmit={create} />
      <Sheet
        visible={grouping}
        title="Group each project's sessions by"
        options={GROUP_MODES.map((m) => ({ label: m.label, hint: m.key === ui.groupMode ? 'current' : undefined, onPress: () => ui.setGroupMode(m.key) }))}
        onClose={() => setGrouping(false)}
      />
      <SessionActions session={actionsFor} onClose={() => setActionsFor(null)} />
      <ProjectActions project={projectActionsFor} now={now} onClose={() => setProjectActionsFor(null)} />
    </View>
  );
}

/** A project row with what it needs read: its plan's numbers, its state and running sessions. */
function ProjectRow({ project, open, now, onToggle, onOpen, onLongPress, onNewSession, onPickIcon, onLeaveOut, handle }: {
  project: Project;
  open: boolean;
  now: number;
  onToggle: () => void;
  onOpen: (project: Project) => void;
  onLongPress: (project: Project) => void;
  onNewSession: () => void;
  onPickIcon?: () => void;
  onLeaveOut?: () => void;
  handle?: boolean;
}) {
  const live = useConnection((s) => s.live);
  const notices = useConnection((s) => s.notices);
  const planQuery = useProjectPlan(project.id);
  const plan = planQuery.data && !planQuery.data.error ? planQuery.data : planQuery.isError || planQuery.data?.error ? null : undefined;
  const sessions = projectSessions(project);
  const snoozed = projectSnoozed(project, now);
  const tail = snoozed && project.snoozedUntil
    ? `snoozed until ${snoozeWakeDescription(project.snoozedUntil)}`
    : relativeTime(project.lastActivity || project.modified);
  return (
    <ProjectListRow
      project={project}
      open={open}
      dim={snoozed || project.status === 'done'}
      state={rollupState(sessions, live, notices)}
      running={sessions.filter((s) => isLive(live[s.sessionId])).length}
      stats={projectRowStats(project, plan)}
      tail={tail}
      onToggle={onToggle}
      onOpen={() => onOpen(project)}
      onLongPress={() => onLongPress(project)}
      onNewSession={onNewSession}
      onPickIcon={onPickIcon}
      onLeaveOut={onLeaveOut}
      handle={handle}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  controls: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs, gap: spacing.sm },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  search: { flex: 1, color: colors.text, backgroundColor: colors.surface, borderRadius: 8, paddingHorizontal: spacing.md, paddingVertical: 9, fontSize: 15 },
  // The grouping combo, as the desktop has it beside its search field.
  group: { height: 40, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.md, borderRadius: 8, backgroundColor: colors.surface },
  groupPressed: { opacity: 0.6 },
  groupText: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  list: { paddingBottom: spacing.xl },
  donate: { marginHorizontal: spacing.sm, marginBottom: spacing.sm },
  empty: { color: colors.textFaint, textAlign: 'center', marginTop: spacing.xl },
  // A session found by the search, under its project.
  nested: { paddingLeft: spacing.xl + spacing.lg },
  // The session open on the right, as the desktop marks the one on screen.
  here: { backgroundColor: 'rgba(128,136,255,0.14)' },
});
