import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from 'react-native';

import { ErrorText } from '@/components/form';
import { ROUTES } from '@/components/RoutePicker';
import { usePromptImproverInfo } from '@/prompt-improver/queries';
import { routesOffered } from '@/remote/client';
import { useKnowledgeBinary, useKnowledgeConfig } from '@/settings/knowledge';
import { useGlobalSettings } from '@/settings/queries';
import { settingsEntries, type SettingsEntry } from '@/settings/search';
import type { PhoneSettingsTab } from '@/settings/tabs';
import { SEARCH_GROUPS, searchParts, searchSettings, searchStatus } from '@/shared/vendor/settings-model';
import { useConnection } from '@/store/connection';
import { colors, spacing } from '@/theme';

/** The search box above Settings' tabs. */
export function SettingsSearchBar({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <View style={styles.bar}>
      <View style={styles.field}>
        <Ionicons name="search" size={16} color={colors.textFaint} />
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="Search settings"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search settings"
        />
        {value ? (
          <Pressable onPress={() => onChange('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear the search">
            <Ionicons name="close-circle" size={18} color={colors.textDim} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** The rows of the shown tabs, as far as the computer's settings are read. */
function useSettingsEntries(tabs: readonly { key: PhoneSettingsTab; label: string }[]) {
  const desktop = useConnection((s) => s.desktop);
  const status = useConnection((s) => s.status);
  const global = useGlobalSettings();
  const binary = useKnowledgeBinary();
  const config = useKnowledgeConfig(!!binary.data?.found?.ok);
  const improver = usePromptImproverInfo();
  const hello = status.state === 'online' ? status.hello : null;
  const routes = desktop ? routesOffered(desktop.internet, desktop.route ?? 'lan') : [];
  const entries = settingsEntries(tabs, {
    computer: desktop ? {
      desktop,
      routes: routes.map((route) => ROUTES[route].label),
      hello: hello ? { appVersion: hello.appVersion, deviceName: hello.device.name } : null,
      offline: status.state === 'offline',
      mobileVersion: Constants.expoConfig?.version ?? null,
    } : undefined,
    global: global.data,
    binary: binary.data,
    config: config.data,
    improver: improver.data,
  });
  const queries = [global, binary, config, improver];
  return {
    entries,
    online: status.state === 'online',
    loading: queries.some((q) => q.isLoading),
    failed: queries.some((q) => q.isError && !q.data),
  };
}

/** What the search finds, in place of the tabs: a tap leads to the setting on its tab. */
export function SettingsSearchResults({ tabs, query, onPick }: {
  tabs: readonly { key: PhoneSettingsTab; label: string }[];
  query: string;
  onPick: (entry: SettingsEntry) => void;
}) {
  const { entries, online, loading, failed } = useSettingsEntries(tabs);
  const found = searchSettings(entries, query);
  const count = found.titles.length + found.descriptions.length;
  const list = useRef<ScrollViewInstance>(null);
  // Each new query shows from the top, where the title matches are.
  useEffect(() => {
    list.current?.scrollTo({ y: 0, animated: false });
  }, [query]);
  return (
    <ScrollView ref={list} style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      <View style={styles.status}>
        {loading ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        {/* Not "nothing matches" while there is still something to read. */}
        <Text style={styles.statusText} accessibilityLiveRegion="polite">{loading && !count ? 'Reading the computer\'s settings…' : searchStatus(query, count)}</Text>
      </View>
      {/* Offline there is no tab but Computer. */}
      {online ? null : <Text style={styles.statusText}>Not connected: only the Computer tab is searched.</Text>}
      {failed ? <ErrorText>Some of the computer&apos;s settings could not be read.</ErrorText> : null}
      {SEARCH_GROUPS.map(({ key, label }) => (found[key].length ? (
        <View key={key} style={styles.group}>
          <Text style={styles.heading} accessibilityRole="header">{label}</Text>
          {found[key].map((entry) => (
            <Pressable
              key={`${entry.tab}:${entry.id}`}
              onPress={() => onPick(entry)}
              style={({ pressed }) => [styles.result, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityHint="Shows the setting on its tab"
            >
              <Text style={styles.where}>{entry.where}</Text>
              <Marked text={entry.title} query={query} style={styles.title} />
              {entry.description ? <Marked text={entry.description} query={query} style={styles.description} /> : null}
            </Pressable>
          ))}
        </View>
      ) : null))}
    </ScrollView>
  );
}

/** A text with the words searched for marked. */
function Marked({ text, query, style }: { text: string; query: string; style: object }) {
  return (
    <Text style={style}>
      {searchParts(text, query).map((part, i) => (part.match ? <Text key={i} style={styles.match}>{part.text}</Text> : part.text))}
    </Text>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: colors.surface },
  field: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.md, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  input: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, paddingVertical: 6 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: 48 },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusText: { flexShrink: 1, color: colors.textDim, fontSize: 12.5 },
  group: { gap: spacing.sm, marginTop: spacing.sm },
  heading: { color: colors.textDim, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  result: { backgroundColor: colors.surface, borderRadius: 10, padding: spacing.md, gap: 3 },
  pressed: { opacity: 0.7 },
  where: { color: colors.textDim, fontSize: 11.5 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  description: { color: colors.textDim, fontSize: 12.5, lineHeight: 17 },
  match: { color: '#ffffff', backgroundColor: 'rgba(128,136,255,0.35)' },
});
