import { useQuery } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CodeEditor, type CodeEditorHandle } from '@/components/files/CodeEditor';
import { CursorBar } from '@/components/files/CursorBar';
import { FindBar } from '@/components/files/FindBar';
import { FontSizeButtons } from '@/components/files/FontSizeButtons';
import { MarkdownPreview } from '@/components/files/MarkdownPreview';
import { ShareButton } from '@/components/files/ShareButton';
import { HeaderButton } from '@/components/HeaderButton';
import type { EditorState, FindResult } from '@/editor/bridge';
import { downloadSupported, type KnownContent } from '@/files/download';
import { act } from '@/projects/queries';
import { request, useConnection } from '@/store/connection';
import { colors, spacing } from '@/theme';

type FileData = { ok: boolean; error?: string; previewType?: 'text' | 'html' | 'image' | 'pdf' | 'pptx'; content?: string; mimeType?: string; base64?: string; version?: string };

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

const CLEAN: EditorState = { dirty: false, canUndo: false, canRedo: false, cursors: 1 };

/**
 * A project file: text and Markdown to read or edit, images to look at, and
 * any file to share. Text is shown in the code editor (CodeEditor), which
 * Edit makes editable in place; Markdown is shown formatted, or raw in the
 * editor. `inline` draws its own bar (beside the tree of the Files tab on a
 * wide screen); otherwise its buttons go in the screen's header.
 * While editing, the cursor bar sits over the keyboard (CursorBar). Find (the
 * magnifier, or Cmd/Ctrl+F on a keyboard) puts the find bar over the text,
 * with Replace while editing (FindBar).
 * Give it a `key` per file, so another file starts with no edit in progress.
 * With `line` (a search result) a text file opens scrolled to that line, which
 * is marked; a Markdown file then opens raw, where lines are lines. With
 * `section` (a link) the formatted Markdown opens at that heading.
 */
export function FileView({ root, path, line, section, inline = false }: { root: string; path: string; line?: number; section?: string; inline?: boolean }) {
  const online = useConnection((s) => s.status.state === 'online');
  const file = useQuery({
    queryKey: ['file', root, path],
    queryFn: () => request<FileData>('read-project-file', [root, path]),
    enabled: online && !!root && !!path,
  });
  const [raw, setRaw] = useState(!!line);
  const editor = useRef<CodeEditorHandle>(null);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<EditorState>(CLEAN);
  const [saving, setSaving] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [found, setFound] = useState<FindResult | null>(null);
  const name = (path || '').split('/').pop() || 'File';
  const data = file.data;
  const isText = data?.previewType === 'text' || data?.previewType === 'html';
  const isMarkdown = /\.(md|markdown)$/i.test(name);
  // Find works where the text is in the editor (not the formatted Markdown).
  const canFind = isText && (!isMarkdown || raw);
  const closeFind = () => { setFindOpen(false); setFound(null); };
  const findButton = canFind ? (
    <HeaderButton icon="search-outline" accessibilityLabel={findOpen ? 'Close find' : 'Find in file'} onPress={() => (findOpen ? closeFind() : setFindOpen(true))} />
  ) : null;

  // Markdown is edited raw.
  const startEditing = () => {
    setRaw(true);
    setEditing(true);
  };

  const cancel = () => {
    editor.current?.revert();
    setEditing(false);
  };

  const save = async () => {
    if (!editing || !editor.current) return;
    setSaving(true);
    try {
      const text = await editor.current.getText();
      await act('save-project-file', [root, path, text, ...(data?.version ? [data.version] : [])]);
      // The saved file read back goes into the editor, which starts its history again.
      await file.refetch();
      setEditing(false);
    } catch (err: any) {
      Alert.alert('Could not save', err.message);
    } finally {
      setSaving(false);
    }
  };

  // Text and images go as shown; any other file comes down from the computer first.
  const known: KnownContent | undefined = isText ? { text: data?.content ?? '' }
    : data?.previewType === 'image' && data.base64 ? { base64: data.base64 } : undefined;
  const canShare = !!data && downloadSupported();

  const buttons = () => {
    if (editing) {
      const canSave = edit.dirty && !saving;
      return (
        <View style={styles.textButtons}>
          <Pressable onPress={cancel} disabled={saving} hitSlop={10} accessibilityRole="button"><Text style={styles.headerButtonDim}>Cancel</Text></Pressable>
          {findButton}
          <FontSizeButtons />
          <HeaderButton icon="arrow-undo-outline" accessibilityLabel="Undo" onPress={() => editor.current?.undo()} disabled={!edit.canUndo || saving} />
          <HeaderButton icon="arrow-redo-outline" accessibilityLabel="Redo" onPress={() => editor.current?.redo()} disabled={!edit.canRedo || saving} />
          <Pressable onPress={save} disabled={!canSave} hitSlop={10} accessibilityRole="button" accessibilityState={{ disabled: !canSave }}>
            <Text style={[styles.headerButton, !canSave && !saving && styles.off]}>{saving ? 'Saving…' : 'Save'}</Text>
          </Pressable>
        </View>
      );
    }
    if (!isText && !canShare) return null;
    return (
      <View style={styles.headerButtons}>
        {findButton}
        {isText ? <FontSizeButtons /> : null}
        {isText && isMarkdown ? (
          <HeaderButton
            icon={raw ? 'document-text-outline' : 'code-slash-outline'}
            accessibilityLabel={raw ? 'Show formatted' : 'Show raw Markdown'}
            onPress={() => { closeFind(); setRaw((r) => !r); }}
          />
        ) : null}
        {canShare ? <ShareButton root={root} path={path} name={name} known={known} /> : null}
        {isText ? <HeaderButton icon="create-outline" accessibilityLabel={`Edit ${name}`} onPress={startEditing} /> : null}
      </View>
    );
  };

  let body;
  if (file.isLoading) body = <ActivityIndicator style={{ margin: spacing.xl }} color={colors.accent} />;
  else if (!data?.ok) body = <Text style={styles.error}>{data?.error || 'Could not open the file.'}</Text>;
  else if (data.previewType === 'image' && data.base64) {
    body = <ScrollView maximumZoomScale={4} minimumZoomScale={1} contentContainerStyle={styles.imageBox}><Image source={{ uri: `data:${data.mimeType};base64,${data.base64}` }} style={styles.image} resizeMode="contain" /></ScrollView>;
  } else if (isText && isMarkdown && !raw) {
    body = <MarkdownPreview root={root} path={path} content={data.content || ''} section={section} />;
  } else if (isText) {
    body = (
      <View style={styles.editorBox}>
        {findOpen ? <FindBar editor={editor} result={found} canReplace={editing} textLength={(data.content ?? '').length} onClose={closeFind} /> : null}
        <CodeEditor
          ref={editor}
          text={data.content ?? ''}
          filename={name}
          editable={editing}
          line={line}
          wrap={isMarkdown}
          onState={setEdit}
          onFind={setFound}
          onOpenFind={() => setFindOpen(true)}
        />
      </View>
    );
  } else {
    body = <Text style={styles.error}>This kind of file opens on the computer only.</Text>;
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 100 : 0}>
      {inline ? (
        <View style={styles.bar}>
          <View style={styles.barText}>
            <Text style={styles.barName} numberOfLines={1}>{name}</Text>
            <Text style={styles.barPath} numberOfLines={1}>{path}</Text>
          </View>
          {buttons()}
        </View>
      ) : (
        <Stack.Screen options={{ title: name, headerRight: buttons }} />
      )}
      {body}
      {/* Over the keyboard while editing: VS Code's multiple cursors. */}
      {editing && isText ? <CursorBar cursors={edit.cursors} onAction={(action) => editor.current?.cursors(action)} /> : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  editorBox: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
  barText: { flex: 1, minWidth: 0 },
  barName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  barPath: { color: colors.textFaint, fontSize: 11, fontFamily: mono },
  headerButtons: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  textButtons: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.sm },
  headerButton: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  headerButtonDim: { color: colors.textDim, fontSize: 16 },
  off: { opacity: 0.4 },
  imageBox: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', aspectRatio: 1 },
  error: { color: colors.textDim, padding: spacing.lg },
});
