import { useMemo, useState, type ComponentRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Markdown, { type RenderRules } from 'react-native-markdown-display';

import { fileLinkPress, markdownParser, pathCodeRule, taskItemRule } from '@/components/chat/ChatMarkdown';
import { openPath } from '@/components/chat/OpenFile';
import { markdownStyles } from '@/components/ChatView';
import { FONT_DEFAULT, scaleTextStyles, useEditorFont } from '@/editor/font';
import { joinPath, parentRelative } from '@/files/model';
import { sectionScroller } from '@/files/section-scroller';
import { useCapability } from '@/store/connection';
import { spacing } from '@/theme';

type Sections = ReturnType<typeof sectionScroller<ComponentRef<typeof View>>>;

/** The headings as the library draws them, each known by its anchor, to be scrolled to. */
function headingRules(sections: Sections): RenderRules {
  const heading: NonNullable<RenderRules['heading1']> = (node, children, _parent, mdStyles) => (
    <View key={node.key} ref={(view) => sections.setHeading(node.attributes.anchor, view)} collapsable={false} style={mdStyles[`_VIEW_SAFE_${node.type}`]}>
      {children}
    </View>
  );
  return { heading1: heading, heading2: heading, heading3: heading, heading4: heading, heading5: heading, heading6: heading };
}

/**
 * A Markdown file formatted, at the text size of the editors (the styles are
 * made for the default size and scaled with it). Paths in it open the files
 * they name, relative ones from the file's folder, when the computer can find
 * them: a plan names the files it changes. A link to a section scrolls to its
 * heading; with `section` the file opens there.
 */
export function MarkdownPreview({ root, path, content, section }: { root: string; path: string; content: string; section?: string }) {
  const canLocate = useCapability('locate-file');
  const size = useEditorFont((s) => s.size);
  const styles = useMemo(() => scaleTextStyles(markdownStyles, size / FONT_DEFAULT), [size]);
  const [sections] = useState(() => sectionScroller<ComponentRef<typeof View>>(section));
  const links = useMemo(() => {
    const openFile = canLocate && root ? (ref: string, anchor?: string) => { openPath(ref, joinPath(root, parentRelative(path || '')), anchor); } : null;
    return {
      rules: { code_inline: pathCodeRule(openFile), list_item: taskItemRule, ...headingRules(sections) },
      onLinkPress: fileLinkPress(openFile, (anchor) => sections.show(anchor)),
    };
  }, [canLocate, root, path, sections]);
  return (
    <ScrollView ref={(view) => sections.setScroller(view)} contentContainerStyle={layout.content}>
      <View ref={(view) => sections.setBody(view)} collapsable={false} onLayout={() => sections.laidOut()}>
        <Markdown style={styles} rules={links.rules} onLinkPress={links.onLinkPress} markdownit={markdownParser}>{content}</Markdown>
      </View>
    </ScrollView>
  );
}

const layout = StyleSheet.create({ content: { padding: spacing.lg } });
