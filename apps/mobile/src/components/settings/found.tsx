import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ScrollViewInstance, type ScrollViewProps, type StyleProp, type ViewInstance, type ViewStyle } from 'react-native';

import { colors, spacing } from '@/theme';

// How a settings search result leads to its row: the screen says which row was
// picked (FoundSetting), the tab's page (SettingsScroll) scrolls to it, and the
// row (SettingRow) is marked while it is the picked one.

/** The row a search result led to, until its mark goes: a new object at each pick. */
export const FoundSetting = createContext<{ id: string } | null>(null);

const Reveal = createContext<(row: ViewInstance) => void>(() => {});

/** The space left above the row scrolled to. */
const ABOVE = spacing.xl;

/** A Settings tab's page: it scrolls, and brings the picked row into view. */
export function SettingsScroll({ children, ...props }: ScrollViewProps) {
  const scroller = useRef<ScrollViewInstance>(null);
  const content = useRef<ViewInstance>(null);
  const reveal = useCallback((row: ViewInstance) => {
    if (!content.current) return;
    row.measureLayout(content.current, (_x, y) => scroller.current?.scrollTo({ y: Math.max(0, y - ABOVE), animated: true }));
  }, []);
  return (
    <ScrollView ref={scroller} innerViewRef={content} {...props}>
      <Reveal.Provider value={reveal}>{children}</Reveal.Provider>
    </ScrollView>
  );
}

/**
 * A row of a tab, by the id the search knows it by (settings/search.ts). A
 * result opens its tab afresh, so the row is reached when it is laid out.
 */
export function SettingRow({ id, style, children }: { id: string; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const found = useContext(FoundSetting)?.id === id;
  const reveal = useContext(Reveal);
  const row = useRef<ViewInstance>(null);
  return (
    // Kept as a view of its own on Android, to be measured.
    <View ref={row} collapsable={false} style={style} onLayout={() => { if (found && row.current) reveal(row.current); }}>
      {children}
      {found ? <View pointerEvents="none" style={styles.mark} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Over the row, a little outside it, so nothing moves when it comes and goes.
  mark: {
    position: 'absolute',
    top: -spacing.xs,
    bottom: -spacing.xs,
    left: -spacing.sm,
    right: -spacing.sm,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.accent,
    backgroundColor: 'rgba(128,136,255,0.1)',
  },
});
