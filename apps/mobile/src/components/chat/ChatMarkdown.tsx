import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { memo, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Markdown, { MarkdownIt, renderRules, type ASTNode, type RenderRules } from 'react-native-markdown-display';

import { headingAnchors } from '@/files/heading-anchors';
import { taskLists } from '@/files/task-lists';
import { localLinkPath, looksLikePath } from '@/sessions/file-refs';
import { parseMarkdownLink } from '@/shared/vendor/markdown-links';
import { colors, spacing } from '@/theme';
import { useOpenFile } from './OpenFile';

// The platform's monospace font. The terminal's bundled font is a woff2
// inside its WebView page, which Android cannot load as an app font.
export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** A code block: a card with the language and Copy, the code unwrapped and scrolling sideways. */
export function CodeCard({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => { Clipboard.setStringAsync(code).then(() => setCopied(true), () => {}); };
  return (
    <View style={styles.code}>
      <View style={styles.codeHeader}>
        <Text style={styles.language} numberOfLines={1}>{language || 'code'}</Text>
        <Pressable onPress={copy} hitSlop={{ top: 4, bottom: 4 }} style={styles.copy} accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : 'Copy code'}>
          <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={colors.textDim} />
          <Text style={styles.copyText}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeBody}>
        <Text style={styles.codeText} selectable>{code}</Text>
      </ScrollView>
    </View>
  );
}

const COLUMN = 120;
const MIN_TABLE = 300;

function columnsOf(table: ASTNode): number {
  let most = 1;
  for (const part of table.children || []) for (const row of part.children || []) most = Math.max(most, row.children?.length || 0);
  return most;
}

const trimEnd = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text);

type OpenFile = ((path: string, section?: string) => void) | null;

/** `code` that names a file, as a link that opens it (with `openFile`); other `code` as usual. */
export function pathCodeRule(openFile: OpenFile): NonNullable<RenderRules['code_inline']> {
  return function codeInline(node, _children, _parent, mdStyles, inheritedStyles = {}) {
    if (!openFile || !looksLikePath(node.content)) return <Text key={node.key} style={[inheritedStyles, mdStyles.code_inline]}>{node.content}</Text>;
    return (
      <Text key={node.key} style={[inheritedStyles, mdStyles.code_inline, styles.pathCode]} onPress={() => openFile(node.content)} accessibilityRole="link" accessibilityHint="Opens the file">
        {node.content}
      </Text>
    );
  };
}

/** The parser for the app's markdown: the library's own, with task lists and headings' anchors. */
export const markdownParser = MarkdownIt({ typographer: true }).use(taskLists).use(headingAnchors);

/** A task list item ("- [ ] …", "- [x] …") with a checkbox for its bullet; other items as usual. */
export const taskItemRule: NonNullable<RenderRules['list_item']> = (node, children, parent, mdStyles, inheritedStyles) => {
  const task = node.attributes?.task;
  if (!task) return renderRules.list_item!(node, children, parent, mdStyles, inheritedStyles);
  const done = task === 'done';
  return (
    <View key={node.key} style={mdStyles._VIEW_SAFE_list_item}>
      <View style={styles.taskBox} accessible accessibilityLabel={done ? 'Done' : 'To do'}>
        <Ionicons name={done ? 'checkbox' : 'square-outline'} size={16} color={done ? colors.accent : colors.textDim} />
      </View>
      <View style={mdStyles._VIEW_SAFE_bullet_list_content}>{children}</View>
    </View>
  );
};

/**
 * Markdown's onLinkPress: a link to a file on the computer opens it here, at
 * the section it names; a section of this text is scrolled to (`showSection`);
 * a web link goes to the browser.
 */
export function fileLinkPress(openFile: OpenFile, showSection?: (section: string) => void) {
  return (url: string) => {
    const link = parseMarkdownLink(url);
    if (link.kind === 'anchor') {
      showSection?.(link.anchor);
      return false;
    }
    const path = openFile ? localLinkPath(url) : null;
    if (!path) return true;
    openFile!(path, link.kind === 'file' && link.anchor ? link.anchor : undefined);
    return false;
  };
}

/**
 * The markdown parts the chat draws itself: code blocks as cards, tables
 * that scroll sideways, `code` that names a file as a link to open it, and
 * task lists with checkboxes.
 */
function chatRules(width: number, openFile: OpenFile): RenderRules {
  return {
    code_inline: pathCodeRule(openFile),
    list_item: taskItemRule,
    fence: (node) => <CodeCard key={node.key} code={trimEnd(node.content)} language={(node as ASTNode & { sourceInfo?: string }).sourceInfo?.trim().split(/\s+/)[0]} />,
    code_block: (node) => <CodeCard key={node.key} code={trimEnd(node.content)} />,
    table: (node, children, _parent, mdStyles) => (
      <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
        <View style={[mdStyles._VIEW_SAFE_table, { width: Math.max(width, columnsOf(node) * COLUMN, MIN_TABLE) }]}>{children}</View>
      </ScrollView>
    ),
  };
}

/** An assistant message: Claude's markdown at phone sizes, `width` wide. Paths to files open them. */
export const ChatMarkdown = memo(function ChatMarkdown({ text, width }: { text: string; width: number }) {
  const openFile = useOpenFile();
  const rules = useMemo(() => chatRules(width, openFile), [width, openFile]);
  const onLinkPress = useMemo(() => fileLinkPress(openFile), [openFile]);
  return <Markdown style={markdown} rules={rules} onLinkPress={onLinkPress} markdownit={markdownParser}>{text}</Markdown>;
});

const styles = StyleSheet.create({
  code: { marginVertical: spacing.sm, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.3)', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: 'hidden' },
  codeHeader: { height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingStart: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  language: { flex: 1, color: colors.textFaint, fontFamily: mono, fontSize: 11.5 },
  copy: { height: 36, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.md },
  copyText: { color: colors.textDim, fontSize: 12.5, fontWeight: '600' },
  codeBody: { paddingHorizontal: spacing.md, paddingVertical: 10 },
  codeText: { color: colors.text, fontFamily: mono, fontSize: 12, lineHeight: 18 },
  tableScroll: { marginVertical: spacing.sm },
  pathCode: { color: colors.accent, textDecorationLine: 'underline' },
  // On the first line of the item (the body's line is 22 high).
  taskBox: { height: 22, justifyContent: 'center', marginLeft: 2, marginRight: 8 },
});

const markdown = StyleSheet.create({
  body: { color: colors.text, fontSize: 15, lineHeight: 22 },
  paragraph: { marginTop: 0, marginBottom: spacing.sm },
  heading1: { fontSize: 18, lineHeight: 24, fontWeight: '700', marginTop: spacing.sm, marginBottom: spacing.xs },
  heading2: { fontSize: 16, lineHeight: 22, fontWeight: '700', marginTop: spacing.sm, marginBottom: spacing.xs },
  heading3: { fontSize: 15, lineHeight: 22, fontWeight: '700', marginTop: spacing.xs, marginBottom: 2 },
  heading4: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  strong: { fontWeight: '700' },
  code_inline: { fontFamily: mono, fontSize: 13, color: '#c8b0e0', backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 4, borderWidth: 0 },
  bullet_list: { marginBottom: spacing.sm },
  ordered_list: { marginBottom: spacing.sm },
  bullet_list_icon: { marginLeft: 4, marginRight: 10, color: colors.textDim },
  ordered_list_icon: { marginLeft: 0, marginRight: 8, color: colors.textDim },
  list_item: { marginBottom: 2 },
  blockquote: { backgroundColor: 'transparent', borderLeftWidth: 3, borderLeftColor: 'rgba(255,255,255,0.14)', marginLeft: 0, paddingHorizontal: spacing.md, paddingVertical: 2, marginBottom: spacing.sm },
  link: { color: colors.accent },
  hr: { backgroundColor: colors.border, marginVertical: spacing.md },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)', borderRadius: 10, overflow: 'hidden' },
  thead: { backgroundColor: 'rgba(255,255,255,0.04)' },
  tr: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, flexDirection: 'row' },
  th: { flex: 1, paddingHorizontal: spacing.md, paddingVertical: 9 },
  td: { flex: 1, paddingHorizontal: spacing.md, paddingVertical: 9 },
});
