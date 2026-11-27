import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Chips, ErrorText, Field, Hint, Label, MONO, SwitchRow } from '@/components/form';
import { Section } from '@/components/project/Section';
import { SettingRow, SettingsScroll } from '@/components/settings/found';
import {
  binaryText,
  commitKnowledgeField,
  knowledgeControl,
  knowledgeFields,
  knowledgeTextAfterSave,
  saveKnowledgeConfig,
  useKnowledgeBinary,
  useKnowledgeConfig,
  type KnowledgeCommit,
  type KnowledgeKeyKind,
} from '@/settings/knowledge';
import type { KnowledgeConfigField } from '@/shared/vendor/settings-model';
import { useConnection } from '@/store/connection';
import { colors, spacing } from '@/theme';

const SAVED_MS = 1600;
const CONFIG_NOTE = 'codebase-memory-mcp\'s own settings: every CBM process reads them, your agents\' sessions too. Each one saves as it changes; the watcher ones apply when CBM\'s daemon next starts.';
const CLOSING = 'Choosing or downloading the program, setting it up for your agents and the Lens are in the computer\'s Settings.';

type Note = { saved: true } | { error: string };

/**
 * Settings' Node Knowledge tab: which codebase-memory-mcp the computer runs
 * (read only) and CBM's own settings, in the desktop's order, each saved as it
 * changes. A refused value says why under its field, which shows the saved
 * value again. Choosing the program, setting it up for the agents and the Lens
 * stay on the computer.
 */
export function KnowledgeSettingsTab() {
  const online = useConnection((s) => s.status.state === 'online');
  const binary = useKnowledgeBinary();
  const usable = !!binary.data?.found?.ok;
  const config = useKnowledgeConfig(usable);
  const saves = useSaves();

  if (!binary.data) {
    return (
      <View style={styles.center}>
        {binary.isError
          ? <Text style={styles.message}>{(binary.error as Error)?.message || 'The computer did not answer.'}</Text>
          : online ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.message}>Not connected to the computer.</Text>}
      </View>
    );
  }

  const text = binaryText(binary.data);
  const data = config.data;
  return (
    <SettingsScroll style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      <Section title="Node Knowledge">
        <SettingRow id="program">
          <Label>codebase-memory-mcp</Label>
          <Text style={styles.status}>
            {text.summary}
            {text.problem ? <Text style={styles.problem}>{` · ${text.problem}`}</Text> : null}
            {text.newer ? ` · ${text.newer}` : null}
          </Text>
          {text.path ? <Text style={styles.path} selectable>{text.path}</Text> : null}
        </SettingRow>
        {usable && config.isError ? <ErrorText>{(config.error as Error)?.message || 'The computer did not answer.'}</ErrorText> : null}
        {usable && !data && !config.isError ? <ActivityIndicator style={styles.loading} color={colors.accent} /> : null}
        {data ? (
          <>
            <Hint>{CONFIG_NOTE}</Hint>
            {knowledgeFields(data.keys).map((field) => (
              <SettingRow key={field.key} id={field.key}>
                <Control field={field} kind={data.keys[field.key]} value={data.values[field.key]} {...saves} />
              </SettingRow>
            ))}
          </>
        ) : null}
        <Text style={styles.closing}>{CLOSING}</Text>
      </Section>
    </SettingsScroll>
  );
}

type Saves = ReturnType<typeof useSaves>;
type ControlProps = Saves & { field: KnowledgeConfigField; kind: KnowledgeKeyKind | undefined; value: string | undefined };

/**
 * The saves of the tab. A switch or a choice shows its new state (`pending`)
 * until its save is done and the settings are read again, which is also how a
 * refused one goes back; a note says "Saved" for a moment, or why not.
 */
function useSaves() {
  const [pending, setPending] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const counts = useRef<Record<string, number>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const live = timers.current;
    return () => {
      mounted.current = false;
      Object.values(live).forEach(clearTimeout);
    };
  }, []);

  const note = (key: string, value: Note | null) => {
    clearTimeout(timers.current[key]);
    if (!mounted.current) return;
    setNotes((all) => {
      const next = { ...all };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
    if (value && 'saved' in value) timers.current[key] = setTimeout(() => note(key, null), SAVED_MS);
  };

  /** Save `value` for `key`; true when it was saved. `shown` keeps it on screen until the save is done. */
  const change = async (key: string, value: string, shown: boolean): Promise<boolean> => {
    const count = (counts.current[key] = (counts.current[key] || 0) + 1);
    if (shown) setPending((p) => ({ ...p, [key]: value }));
    let saved = false;
    try {
      await saveKnowledgeConfig(key, value);
      saved = true;
      note(key, { saved: true });
    } catch (err) {
      note(key, { error: (err instanceof Error && err.message) || 'Not saved' });
    }
    if (shown && counts.current[key] === count && mounted.current) {
      setPending((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    }
    return saved;
  };

  /** End the edit of a count or limit field; `saved` is the value in force. */
  const commit = async (key: string, kind: KnowledgeKeyKind | undefined, raw: string, saved: string | undefined): Promise<KnowledgeCommit> => {
    const result = await commitKnowledgeField(key, kind, raw, saved, saveKnowledgeConfig);
    if (result.error) note(key, { error: result.error });
    else if (result.saved) note(key, { saved: true });
    return result;
  };

  return { pending, notes, change, commit };
}

function Control(props: ControlProps) {
  switch (knowledgeControl(props.kind)) {
    case 'switch': return <SwitchControl {...props} />;
    case 'chips': return <ChipsControl {...props} />;
    default: return <FieldControl {...props} />;
  }
}

function SwitchControl({ field, value, pending, notes, change }: ControlProps) {
  const on = (field.key in pending ? pending[field.key] : value) === 'true';
  return (
    <>
      <SwitchRow label={field.label} help={field.help} value={on} onChange={(next) => change(field.key, String(next), true)} />
      <FieldNote note={notes[field.key]} />
    </>
  );
}

function ChipsControl({ field, kind, value, pending, notes, change }: ControlProps) {
  const selected = field.key in pending ? pending[field.key] : value ?? null;
  const items = (kind as readonly string[]).map((v) => ({ key: v, label: v }));
  return (
    <>
      <Label>{field.label}</Label>
      <Hint>{field.help}</Hint>
      <View style={styles.control}>
        <Chips items={items} selected={selected} onSelect={(v) => { if (v !== selected) change(field.key, v, true); }} />
      </View>
      <FieldNote note={notes[field.key]} />
    </>
  );
}

/**
 * A count or a limit. It keeps what is typed until its editing ends, then
 * saves; it shows the value the computer read back, or the one in force when
 * nothing was saved. Nothing is ever sent empty: an emptied field says why
 * under it (a limit is turned off by typing "off").
 */
function FieldControl({ field, kind, value, notes, commit }: ControlProps) {
  const shown = value ?? '';
  const [text, setText] = useState(shown);
  const editing = useRef(false);
  const typed = useRef(false);
  const latest = useRef(shown);

  useEffect(() => {
    latest.current = shown;
    if (!editing.current) setText(shown);
  }, [shown]);

  // Return, then leaving the field, both end the editing: it is saved once.
  const end = (raw: string) => {
    if (!editing.current) return;
    editing.current = false;
    if (!typed.current) { setText(latest.current); return; }
    typed.current = false;
    // Then the value the computer read back after the save (or the one in
    // force), even when it is the one shown before: 99999999999 is capped.
    commit(field.key, kind, raw, latest.current).then((result) => {
      const next = knowledgeTextAfterSave(field.key, result, latest.current, editing.current);
      if (next !== null) setText(next);
    });
  };

  // A limit also takes "off", so it gets the full keyboard; a count only digits.
  const limit = kind === 'limit';
  return (
    <>
      <Label>{field.label}</Label>
      <Hint>{field.help}</Hint>
      <View style={styles.control}>
        <Field
          value={text}
          onChangeText={(t) => { typed.current = true; setText(t); }}
          onFocus={() => { editing.current = true; typed.current = false; }}
          onSubmitEditing={(e) => end(e.nativeEvent.text)}
          onEndEditing={(e) => end(e.nativeEvent.text)}
          placeholder={limit ? 'off' : undefined}
          keyboardType={limit ? 'default' : 'number-pad'}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          maxLength={64}
          accessibilityLabel={field.label}
        />
      </View>
      <FieldNote note={notes[field.key]} />
    </>
  );
}

function FieldNote({ note }: { note?: Note }) {
  if (!note) return null;
  if ('error' in note) return <ErrorText>{note.error}</ErrorText>;
  return (
    <View style={styles.saved} accessibilityLiveRegion="polite">
      <Ionicons name="checkmark" size={12} color={colors.running} />
      <Text style={styles.savedText}>Saved</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: colors.background },
  message: { color: colors.textFaint, fontSize: 13, textAlign: 'center' },
  status: { color: colors.textDim, fontSize: 13, lineHeight: 18, marginTop: spacing.xs },
  problem: { color: colors.danger },
  path: { color: colors.textDim, fontFamily: MONO, fontSize: 12.5, marginTop: spacing.xs, marginBottom: spacing.sm },
  loading: { marginVertical: spacing.md },
  control: { marginTop: spacing.sm },
  closing: { color: colors.textFaint, fontSize: 12, lineHeight: 17, marginTop: spacing.lg, marginBottom: spacing.sm },
  saved: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: spacing.xs },
  savedText: { color: colors.running, fontSize: 12 },
});
