import Ionicons from '@expo/vector-icons/Ionicons';
import { Fragment, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Chips, ErrorText, Field, Hint, Label, MONO, SelectRow, SwitchRow } from '@/components/form';
import { Section } from '@/components/project/Section';
import { SettingRow, SettingsScroll } from '@/components/settings/found';
import {
  KEPT_ON,
  TEMPLATES_AFTER,
  choiceKey,
  choicesFor,
  commitField,
  fieldText,
  fieldsFor,
  harnessesOff,
  lastHarnessOn,
  noteAfterSave,
  savedValue,
  terminalEngineNow,
  textAfterSave,
  type CatalogTabKey,
  type CommitResult,
  type FieldInput,
  type SaveNote,
  type SettingsField,
} from '@/settings/model';
import { currentGlobalSettings, saveGlobalSettings, useGlobalSettings } from '@/settings/queries';
import { TEMPLATES, harnessHelp } from '@/settings/rows';
import type { GlobalSettingsInfo } from '@/settings/types';
import { ACCENT_PRESETS } from '@/shared/vendor/settings-model';
import { useConnection } from '@/store/connection';
import { colors, spacing } from '@/theme';

const SAVED_MS = 1600;
/** Up to this many choices show as chips, more in a list. */
const CHIPS_AT_MOST = 4;
// The desktop panel's placeholders.
const PLACEHOLDERS: Record<string, string> = {
  worktreeName: 'auto',
  addDirs: '/path/to/dir1, /path/to/dir2',
  codexModel: 'default',
  preLaunchCmd: 'e.g. aws-vault exec profile --',
  projectsRoot: '~/Switchboard',
};

type Note = SaveNote;
type Change = (field: SettingsField, raw: FieldInput, options?: { id?: string; shown?: boolean }) => Promise<CommitResult>;
type ControlProps = { field: SettingsField; info: GlobalSettingsInfo; pending: Record<string, FieldInput>; notes: Record<string, Note>; change: Change };

/**
 * Settings' Application, Agents and Editor tabs: the paired computer's global
 * settings, in the desktop panel's sections and order, each saved as it
 * changes (a switch or a choice when tapped, a text when its editing ends).
 * A refused value says why under its field, which shows the saved value
 * again; the values follow changes made elsewhere, except in a field being typed in.
 */
export function CatalogTab({ tab }: { tab: CatalogTabKey }) {
  const query = useGlobalSettings();
  const online = useConnection((s) => s.status.state === 'online');
  const saves = useSaves();
  const info = query.data;

  if (!info) {
    return (
      <View style={styles.center}>
        {query.isError
          ? <Text style={styles.message}>{(query.error as Error)?.message || 'The computer did not answer.'}</Text>
          : online ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.message}>Not connected to the computer.</Text>}
      </View>
    );
  }

  // A section with nothing to show is left out, as on the desktop (CLI Agents without CLIs).
  const sections = fieldsFor(tab)
    .map(({ section, fields }) => ({ section, fields: fields.filter((f) => f.kind !== 'harnesses' || info.options.harnesses.length > 0) }))
    .filter((s) => s.fields.length > 0);

  return (
    <SettingsScroll style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      {sections.map(({ section, fields }) => (
        <Section key={section} title={section}>
          {fields.map((field) => (
            <Fragment key={field.key}>
              {/* The CLIs have a row each (HarnessControls). */}
              {field.kind === 'harnesses'
                ? <Control field={field} info={info} {...saves} />
                : <SettingRow id={field.key}><Control field={field} info={info} {...saves} /></SettingRow>}
              {field.key === TEMPLATES_AFTER ? <Templates dir={info.options.templatesDir} /> : null}
            </Fragment>
          ))}
        </Section>
      ))}
    </SettingsScroll>
  );
}

/**
 * The saves of a tab: one at a time per setting, so a quick second change is
 * compared with what the first saved. A switch or a choice shows its new state
 * (`pending`) until its save is done and the settings are read again; a
 * control's note is "Saved" for a moment, or why its value was not saved.
 */
function useSaves() {
  const [pending, setPending] = useState<Record<string, FieldInput>>({});
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const queues = useRef<Record<string, Promise<unknown>>>({});
  const counts = useRef<Record<string, number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const pendingTimers = timers.current;
    return () => {
      mounted.current = false;
      Object.values(pendingTimers).forEach(clearTimeout);
    };
  }, []);

  const note = (id: string, value: Note | null) => {
    clearTimeout(timers.current[id]);
    if (!mounted.current) return;
    setNotes((all) => {
      const next = { ...all };
      if (value) next[id] = value;
      else delete next[id];
      return next;
    });
    if (value && 'saved' in value) timers.current[id] = setTimeout(() => note(id, null), SAVED_MS);
  };

  const change: Change = (field, raw, options = {}) => {
    const key = field.key;
    const id = options.id ?? key;
    const count = (counts.current[key] = (counts.current[key] || 0) + 1);
    if (options.shown) setPending((p) => ({ ...p, [key]: raw }));
    const job = async (): Promise<CommitResult> => {
      const result = await commitField(field, raw, currentGlobalSettings(), saveGlobalSettings);
      // The computer keeps one CLI on: its answer compared with what was sent, as the desktop does.
      const after = noteAfterSave(field, raw, result);
      if (after) note(id, after);
      return result;
    };
    const run = (queues.current[key] || Promise.resolve()).then(job);
    queues.current[key] = run.catch(() => {}).then(() => {
      // The last change of this setting is done: show the values as read again.
      if (counts.current[key] !== count || !mounted.current) return;
      setPending((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    });
    return run.catch((err) => ({ saved: false, error: String(err?.message || err) }));
  };

  return { pending, notes, change };
}

function Control(props: ControlProps) {
  switch (props.field.kind) {
    case 'bool': return <BoolControl {...props} />;
    case 'choice': return <ChoiceControl {...props} />;
    case 'color': return <AccentControl {...props} />;
    case 'harnesses': return <HarnessControls {...props} />;
    default: return <TextControl {...props} />;
  }
}

function shownValue({ field, info, pending }: ControlProps): unknown {
  return field.key in pending ? pending[field.key] : savedValue(field, info);
}

function BoolControl(props: ControlProps) {
  const { field, notes, change } = props;
  return (
    <>
      <SwitchRow label={field.label} help={field.help} value={!!shownValue(props)} onChange={(on) => change(field, on, { shown: true })} />
      <FieldNote note={notes[field.key]} />
    </>
  );
}

function ChoiceControl(props: ControlProps) {
  const { field, info, notes, change } = props;
  const items = choicesFor(field, info);
  const selected = field.key in props.pending ? String(props.pending[field.key]) : choiceKey(savedValue(field, info));
  const pick = (key: string) => { if (key !== selected) change(field, key, { shown: true }); };
  // The desktop says beside Terminal Engine which one runs the sessions now.
  const help = field.key === 'terminalEngine' ? `${field.help} ${terminalEngineNow(info.options.terminalEngine)}` : field.help;
  return (
    <>
      <Label>{field.label}</Label>
      <Hint>{help}</Hint>
      <View style={styles.control}>
        {items.length <= CHIPS_AT_MOST
          ? <Chips items={items} selected={selected} onSelect={pick} />
          : <SelectRow title={field.label} choices={items.map(({ key, label }) => ({ key, label }))} selected={selected} onSelect={pick} />}
      </View>
      <FieldNote note={notes[field.key]} />
    </>
  );
}

/** The accent's presets as swatches; a colour picked on the computer outside them shows beside them. */
function AccentControl(props: ControlProps) {
  const { field, notes, change } = props;
  const current = String(shownValue(props));
  const custom = !ACCENT_PRESETS.some((p) => p.color === current);
  return (
    <>
      <Label>{field.label}</Label>
      <Hint>{field.help}</Hint>
      <View style={[styles.control, styles.swatches]} accessibilityRole="radiogroup" accessibilityLabel={field.label}>
        {ACCENT_PRESETS.map((preset) => {
          const on = preset.color === current;
          return (
            <Pressable
              key={preset.color}
              onPress={() => { if (!on) change(field, preset.color, { shown: true }); }}
              hitSlop={4}
              style={[styles.swatch, { backgroundColor: preset.color }, on && styles.swatchOn]}
              accessibilityRole="radio"
              accessibilityLabel={preset.label}
              accessibilityState={{ selected: on }}
            />
          );
        })}
        {custom ? (
          <View style={styles.custom} accessibilityLabel={`Custom, ${current}`}>
            <View style={[styles.swatch, styles.swatchOn, { backgroundColor: current }]} />
            <Text style={styles.customText}>Custom {current}</Text>
          </View>
        ) : null}
      </View>
      <FieldNote note={notes[field.key]} />
    </>
  );
}

/** A switch per CLI of the computer; the last one on is locked, with the desktop's words. */
function HarnessControls(props: ControlProps) {
  const { field, info, pending, notes, change } = props;
  const harnesses = info.options.harnesses;
  const off = (pending[field.key] as readonly string[] | undefined) ?? info.values.disabledHarnesses;
  const last = lastHarnessOn(harnesses, off);
  return (
    <>
      {harnesses.map((h) => {
        const id = `harness:${h.id}`;
        const locked = last === h.id;
        return (
          <SettingRow key={h.id} id={id}>
            <SwitchRow
              label={h.label}
              help={locked ? KEPT_ON : harnessHelp(h.id)}
              value={!off.includes(h.id)}
              disabled={locked}
              onChange={(on) => change(field, harnessesOff(harnesses, off, h.id, on), { id, shown: true })}
            />
            <FieldNote note={notes[id]} />
          </SettingRow>
        );
      })}
    </>
  );
}

/**
 * A text, path or number field. It keeps what is typed until its editing
 * ends, even when the value changes elsewhere meanwhile; then it saves, and
 * shows the value read back: the one saved, or the one in force when nothing
 * was saved (unchanged or refused).
 */
function TextControl(props: ControlProps) {
  const { field, info, notes, change } = props;
  const shown = fieldText(field, info);
  const [text, setText] = useState(shown);
  const editing = useRef(false);
  const typed = useRef(false);
  // The saved value, for a save that ends after a later render.
  const latest = useRef(shown);

  // A change from elsewhere, or this field's own save read again.
  useEffect(() => {
    latest.current = shown;
    if (!editing.current) setText(shown);
  }, [shown]);

  // Return, then leaving the field, both end the editing: it is saved once.
  const end = (value: string) => {
    if (!editing.current) return;
    editing.current = false;
    if (!typed.current) { setText(latest.current); return; }
    typed.current = false;
    // Then the value read back after the save (or in force), even when it is
    // the one shown before: the computer may have saved another than typed.
    change(field, value).then(() => {
      const next = textAfterSave(field, currentGlobalSettings(), latest.current, editing.current);
      if (next !== null) setText(next);
    });
  };

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
          placeholder={PLACEHOLDERS[field.key]}
          keyboardType={field.kind === 'int' ? 'number-pad' : 'default'}
          returnKeyType="done"
          maxLength={field.maxLength}
          mono={field.kind === 'path'}
          accessibilityLabel={field.label}
        />
      </View>
      <FieldNote note={notes[field.key]} />
    </>
  );
}

/** Project Templates: where the computer keeps them, read only (the Finder stays on the desktop). */
function Templates({ dir }: { dir: string | null }) {
  return (
    <SettingRow id="templates">
      <Label>{TEMPLATES.label}</Label>
      <Hint>{TEMPLATES.help}</Hint>
      <Text style={styles.path} selectable>{dir || TEMPLATES.none}</Text>
    </SettingRow>
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
  control: { marginTop: spacing.sm },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: colors.text },
  custom: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  customText: { color: colors.textDim, fontSize: 12 },
  path: { color: colors.textDim, fontFamily: MONO, fontSize: 12.5, marginTop: spacing.sm, marginBottom: spacing.sm },
  saved: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: spacing.xs },
  savedText: { color: colors.running, fontSize: 12 },
});
