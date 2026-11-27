import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { BackHandler, Keyboard, StyleSheet, View } from 'react-native';

import { TabBar } from '@/components/TabBar';
import { CatalogTab } from '@/components/settings/CatalogTab';
import { ComputerTab } from '@/components/settings/ComputerTab';
import { KnowledgeSettingsTab } from '@/components/settings/KnowledgeSettingsTab';
import { PromptImproverTab } from '@/components/settings/PromptImproverTab';
import { SettingsSearchBar, SettingsSearchResults } from '@/components/settings/SettingsSearch';
import { FoundSetting } from '@/components/settings/found';
import type { SettingsEntry } from '@/settings/search';
import { settingsTabs, type PhoneSettingsTab } from '@/settings/tabs';
import { useCapability, useConnection } from '@/store/connection';
import { colors } from '@/theme';

/** How long the setting a search result led to stays marked. */
const FOUND_MS = 2000;

/**
 * The Settings tab, with the desktop's tabs under a fixed bar: Computer (the
 * paired computer, always first and where the page starts), then, when the
 * computer offers them, Application, Agents, Editor, Node Knowledge and Prompt
 * Improver. A computer older than the global settings shows Computer and
 * the improver only. The tab's content scrolls under the bar. A search box
 * stays above them: while it holds something, its results take their place.
 */
export default function SettingsScreen() {
  const desktop = useConnection((s) => s.desktop);
  const global = useCapability('get-global-settings');
  const knowledge = useCapability('get-knowledge-config');
  const improver = useCapability('get-prompt-improver-settings');
  const [selected, setSelected] = useState<PhoneSettingsTab>('computer');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ id: string } | null>(null);
  const searching = !!query.trim();

  useEffect(() => {
    if (!found) return undefined;
    const timer = setTimeout(() => setFound(null), FOUND_MS);
    return () => clearTimeout(timer);
  }, [found]);

  // Android's back empties the search first, while this screen is the one in front.
  useFocusEffect(useCallback(() => {
    if (!searching) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setQuery('');
      return true;
    });
    return () => sub.remove();
  }, [searching]));

  if (!desktop) return null;
  const tabs = settingsTabs({ global, knowledge, improver });
  // A tab that is gone (the computer went offline, or is older) leaves Computer, which is always there.
  const tab = tabs.some((t) => t.key === selected) ? selected : 'computer';

  const open = (entry: SettingsEntry) => {
    Keyboard.dismiss();
    setQuery('');
    setSelected(entry.tab);
    setFound({ id: entry.id });
  };
  // A tab chosen by hand has no row to go to.
  const choose = (key: PhoneSettingsTab) => {
    setFound(null);
    setSelected(key);
  };

  return (
    <View style={styles.screen}>
      <SettingsSearchBar value={query} onChange={setQuery} />
      {searching ? <SettingsSearchResults tabs={tabs} query={query} onPick={open} /> : (
        <>
          <TabBar tabs={tabs} active={tab} onChange={choose} />
          <FoundSetting.Provider value={found}>
            <View style={styles.body}>{body(tab)}</View>
          </FoundSetting.Provider>
        </>
      )}
    </View>
  );
}

function body(tab: PhoneSettingsTab) {
  switch (tab) {
    case 'computer': return <ComputerTab />;
    case 'improver': return <PromptImproverTab />;
    case 'application':
    case 'agents':
    case 'editor': return <CatalogTab key={tab} tab={tab} />;
    case 'knowledge': return <KnowledgeSettingsTab />;
    default: return null;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1 },
});
