import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { SettingRow, SettingsScroll } from '@/components/settings/found';
import { savePromptImproverSettings, usePromptImproverInfo } from '@/prompt-improver/queries';
import { IMPROVER, IMPROVER_INTRO, templateOwner } from '@/settings/rows';
import { cliLabel, type ImproverEngine, type ImproverMode, type PromptImproverSettings } from '@/shared/vendor/prompt-improver-model';
import { colors, spacing } from '@/theme';

const ENGINES: { key: ImproverEngine; label: string }[] = [
  { key: 'session', label: 'The session\'s CLI' },
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
];
const MODES: { key: ImproverMode; label: string }[] = [
  { key: 'recent', label: 'Prompt and last turns' },
  { key: 'none', label: 'Prompt only' },
];

/**
 * Settings' Prompt Improver tab: the improver's settings, as the computer keeps them (the same as
 * its Settings): on or off, the question first, the CLI that rewrites, the
 * context, how many turns, a model per CLI, the time limit, and the
 * improver prompt (prompt-improver-template). Each change is saved at once.
 */
export function PromptImproverTab() {
  const info = usePromptImproverInfo();
  const [saving, setSaving] = useState(false);
  const s = info.data?.settings;

  const save = async (changes: Partial<PromptImproverSettings>) => {
    setSaving(true);
    try {
      await savePromptImproverSettings(changes);
    } catch (err: any) {
      Alert.alert('Not saved', err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!s) {
    return (
      <View style={styles.center}>
        {info.isError
          ? <Text style={styles.help}>{(info.error as Error)?.message || 'The computer did not answer.'}</Text>
          : <ActivityIndicator color={colors.accent} />}
      </View>
    );
  }
  const clis = info.data?.clis || [];
  const custom = !!s.template;

  return (
    <SettingsScroll style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <SettingRow id="enabled" style={styles.enabled}>
        <Text style={styles.intro}>{IMPROVER_INTRO}</Text>
        <ToggleRow label={IMPROVER.enabled.label} value={s.enabled} onChange={(enabled) => save({ enabled })} disabled={saving} />
      </SettingRow>
      <SettingRow id="confirm">
        <ToggleRow label={IMPROVER.confirm.label} help={IMPROVER.confirm.help} value={s.confirm} onChange={(confirm) => save({ confirm })} disabled={saving} />
      </SettingRow>
      <SettingRow id="engine">
        <View style={styles.card}>
          <Text style={styles.label}>{IMPROVER.engine.label}</Text>
          <Text style={styles.help}>{IMPROVER.engine.help}</Text>
          <Chips
            items={ENGINES.filter((e) => e.key === 'session' || clis.includes(e.key) || e.key === s.engine)}
            value={s.engine}
            onChange={(engine) => save({ engine })}
            disabled={saving}
          />
        </View>
      </SettingRow>
      <SettingRow id="context">
        <View style={styles.card}>
          <Text style={styles.label}>{IMPROVER.context.label}</Text>
          <Chips items={MODES} value={s.context} onChange={(context) => save({ context })} disabled={saving} />
        </View>
      </SettingRow>
      <SettingRow id="turns">
        <Stepper label={IMPROVER.turns.label} help={IMPROVER.turns.help} value={s.recentTurns} min={0} max={20} step={1}
          onChange={(recentTurns) => save({ recentTurns })} disabled={saving} />
      </SettingRow>
      <SettingRow id="models">
        <View style={styles.card}>
          <Text style={styles.label}>{IMPROVER.models.label}</Text>
          <Text style={styles.help}>{IMPROVER.models.help}</Text>
          {(['claude', 'codex', 'opencode'] as const).map((cli) => (
            <ModelField key={`${cli}:${s.models[cli]}`} label={cliLabel(cli)} value={s.models[cli]} onSave={(m) => save({ models: { ...s.models, [cli]: m } })} />
          ))}
        </View>
      </SettingRow>
      <SettingRow id="timeout">
        <Stepper label={IMPROVER.timeout.label} help={IMPROVER.timeout.help} value={s.timeoutSec} min={20} max={600} step={10}
          onChange={(timeoutSec) => save({ timeoutSec })} disabled={saving} />
      </SettingRow>
      <SettingRow id="template">
        <Pressable
          onPress={() => router.push('/prompt-improver-template')}
          style={({ pressed }) => [styles.card, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Edit the improver prompt"
        >
          <Text style={styles.label}>{IMPROVER.template.label}</Text>
          <Text style={styles.value}>{templateOwner(custom)}</Text>
          <Text style={styles.help}>{IMPROVER.template.help}</Text>
        </Pressable>
      </SettingRow>
      {custom ? (
        <SettingRow id="reset">
          <Pressable onPress={() => save({ template: null })} style={styles.button} accessibilityRole="button" disabled={saving}>
            <Text style={styles.buttonText}>{IMPROVER.reset.label}</Text>
          </Pressable>
        </SettingRow>
      ) : null}
    </SettingsScroll>
  );
}

function ToggleRow({ label, help, value, onChange, disabled }: { label: string; help?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <View style={[styles.card, styles.toggle]}>
      <View style={styles.grow}>
        <Text style={styles.value}>{label}</Text>
        {help ? <Text style={styles.help}>{help}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} accessibilityLabel={label} />
    </View>
  );
}

function Chips<T extends string>({ items, value, onChange, disabled }: { items: { key: T; label: string }[]; value: T; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <View style={styles.chips}>
      {items.map((item) => {
        const on = item.key === value;
        return (
          <Pressable
            key={item.key}
            onPress={() => { if (!on) onChange(item.key); }}
            disabled={disabled}
            style={[styles.chip, on && styles.chipOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on, disabled }}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Stepper({ label, help, value, min, max, step, onChange, disabled }: {
  label: string; help: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <View style={[styles.card, styles.toggle]}>
      <View style={styles.grow}>
        <Text style={styles.value}>{label}</Text>
        <Text style={styles.help}>{help}</Text>
      </View>
      <Pressable onPress={() => set(value - step)} disabled={disabled || value <= min} style={styles.step} accessibilityRole="button" accessibilityLabel={`Less ${label.toLowerCase()}`}>
        <Text style={styles.stepText}>−</Text>
      </Pressable>
      <Text style={styles.number}>{value}</Text>
      <Pressable onPress={() => set(value + step)} disabled={disabled || value >= max} style={styles.step} accessibilityRole="button" accessibilityLabel={`More ${label.toLowerCase()}`}>
        <Text style={styles.stepText}>+</Text>
      </Pressable>
    </View>
  );
}

function ModelField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <View style={styles.model}>
      <Text style={styles.modelLabel}>{label}</Text>
      <TextInput
        value={text}
        onChangeText={setText}
        onEndEditing={() => { if (text.trim() !== value) onSave(text.trim()); }}
        placeholder="CLI's default"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        accessibilityLabel={`Model for ${label}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: colors.background },
  // The first setting's row: the switch and what it switches on.
  enabled: { gap: spacing.sm },
  intro: { color: colors.textDim, fontSize: 13, lineHeight: 18, marginBottom: spacing.xs },
  card: { backgroundColor: colors.surface, borderRadius: 10, padding: spacing.md, gap: 4 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  label: { color: colors.textFaint, fontSize: 12 },
  value: { color: colors.text, fontSize: 15 },
  help: { color: colors.textFaint, fontSize: 12, lineHeight: 16 },
  pressed: { opacity: 0.7 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  chip: { paddingHorizontal: spacing.md, paddingVertical: 7, borderRadius: 16, backgroundColor: colors.raised },
  chipOn: { backgroundColor: 'rgba(128,136,255,0.22)' },
  chipText: { color: colors.textDim, fontSize: 13 },
  chipTextOn: { color: colors.accent, fontWeight: '600' },
  step: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center' },
  stepText: { color: colors.text, fontSize: 18, fontWeight: '600' },
  number: { color: colors.text, fontSize: 15, minWidth: 32, textAlign: 'center' },
  model: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  modelLabel: { color: colors.textDim, fontSize: 13, width: 92 },
  input: { flex: 1, color: colors.text, fontSize: 14, backgroundColor: colors.raised, borderRadius: 8, paddingHorizontal: spacing.sm, paddingVertical: 7 },
  button: { backgroundColor: colors.surface, borderRadius: 10, padding: spacing.md, alignItems: 'center', marginTop: spacing.xs },
  buttonText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
});
