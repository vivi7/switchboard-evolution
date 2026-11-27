// Sticky scroll, as VS Code's: while you scroll through a block (a class, a
// function, an object, a Markdown section), the line that opens it stays at
// the top of the editor, up to MAX_LINES of them, outermost first. A click on
// one goes to that line. The innermost line slides away as its block ends.
//
// Which lines: in a language with a syntax tree, the blocks that can fold
// (foldNodeProp) around the first line on screen; in Markdown, the headings
// above it, one per level; elsewhere (shell, TOML, plain text …) VS Code's
// indentation model: the lines above with less indentation.
import { EditorView, ViewPlugin } from '@codemirror/view';
import { syntaxTree, foldNodeProp, language as languageFacet, StreamLanguage, highlightingFor } from '@codemirror/language';
import { getStyleTags } from '@lezer/highlight';
import { languageNameField } from './languages.mjs';
import { leadingColumns } from './indentation.mjs';

const MAX_LINES = 5;
const INDENT_LOOKBACK = 500;
const HEADING_LOOKBACK = 5000;

// ── Which lines: pure, for the tests ───────────────────────────────

/** The line numbers of the blocks around line `top` (1-based), outermost first, at most `max`. */
function stickyScopeLines(state, top, max = MAX_LINES) {
  if (top <= 1 || top > state.doc.lines) return [];
  const name = state.field(languageNameField, false);
  let lines;
  if (name === 'Markdown') lines = headingLines(state, top);
  else {
    const lang = state.facet(languageFacet);
    lines = !lang || lang instanceof StreamLanguage ? indentationLines(state, top) : treeLines(state, top);
  }
  return lines.slice(0, max);
}

/** The lines that open the foldable nodes around the start of line `top`. */
function treeLines(state, top) {
  const doc = state.doc;
  const pos = doc.line(top).from;
  const found = new Set();
  // From the deepest node at the line's first non-blank character outwards.
  const text = doc.line(top).text;
  const at = pos + (text.length - text.trimStart().length);
  for (let node = syntaxTree(state).resolveInner(at, 1); node; node = node.parent) {
    const fold = node.type.prop(foldNodeProp);
    if (!fold) continue;
    const range = fold(node, state);
    if (!range || range.to <= range.from) continue;
    const startLine = doc.lineAt(range.from).number;
    const endLine = doc.lineAt(range.to).number;
    if (startLine < top && endLine >= top) found.add(startLine);
  }
  return [...found].sort((a, b) => a - b);
}

/** The headings above line `top`, each of a higher level than the next. */
function headingLines(state, top) {
  const doc = state.doc;
  const tree = syntaxTree(state);
  const lines = [];
  let level = 7;
  for (let n = top - 1; n >= 1 && n >= top - HEADING_LOOKBACK && level > 1; n--) {
    const line = doc.line(n);
    if (!line.text.startsWith('#')) continue;
    // A heading in the tree, not a "#" in a code block.
    let node = tree.resolveInner(line.from, 1);
    while (node && !/^ATXHeading\d$/.test(node.name)) node = node.parent;
    if (!node) continue;
    const headingLevel = Number(node.name.slice(-1));
    if (headingLevel < level) {
      lines.unshift(n);
      level = headingLevel;
    }
  }
  return lines;
}

/** The lines above `top` with less indentation than the one below them (VS Code's indentation model). */
function indentationLines(state, top) {
  const doc = state.doc;
  const tabSize = state.tabSize;
  // The indentation of the first non-blank line from `top` on.
  let level = null;
  for (let n = top; n <= doc.lines && n < top + 50; n++) {
    const text = doc.line(n).text;
    if (text.trim()) { level = leadingColumns(text, tabSize); break; }
  }
  if (!level) return [];
  const lines = [];
  for (let n = top - 1; n >= 1 && n >= top - INDENT_LOOKBACK && level > 0; n--) {
    const text = doc.line(n).text;
    if (!text.trim()) continue;
    const indent = leadingColumns(text, tabSize);
    if (indent < level) {
      lines.unshift(n);
      level = indent;
    }
  }
  return lines;
}

/** The last line of the block line `opener` opens, for the slide: the fold's end, or the indentation's. */
function blockEnd(state, opener) {
  const doc = state.doc;
  const line = doc.line(opener);
  for (let node = syntaxTree(state).resolveInner(line.to, -1); node; node = node.parent) {
    const fold = node.type.prop(foldNodeProp);
    const range = fold && fold(node, state);
    if (range && doc.lineAt(range.from).number === opener) return doc.lineAt(range.to).number;
  }
  return null;
}

// ── The header at the top of the editor ────────────────────────────

const stickyTheme = EditorView.theme({
  '.cm-sticky-scroll': {
    position: 'absolute',
    left: 0,
    zIndex: 5,
    overflow: 'hidden',
    backgroundColor: 'var(--cm-sticky-bg, #282a36)',
    boxShadow: '0 3px 4px -2px rgba(0, 0, 0, 0.55)',
  },
  '.cm-sticky-line': {
    display: 'flex',
    whiteSpace: 'pre',
    cursor: 'pointer',
    overflow: 'hidden',
  },
  '.cm-sticky-line:hover': { backgroundColor: 'rgba(255, 255, 255, 0.05)' },
  '.cm-sticky-number': {
    flex: 'none',
    boxSizing: 'border-box',
    textAlign: 'right',
    color: 'rgba(255, 255, 255, 0.35)',
    paddingRight: '3px',
  },
  '.cm-sticky-text': { flex: 'none' },
});

class StickyScrollView {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-sticky-scroll';
    this.dom.style.display = 'none';
    view.dom.appendChild(this.dom);
    this.shown = '';
    this.onScroll = () => this.schedule();
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.dom.addEventListener('mousedown', e => this.click(e));
    this.schedule();
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.geometryChanged
      || update.transactions.some(tr => tr.reconfigured) || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.shown = '';
      this.schedule();
    }
  }

  schedule() {
    this.view.requestMeasure({ key: this, read: view => this.measure(view), write: m => this.draw(m) });
  }

  measure(view) {
    const scroller = view.scrollDOM;
    if (scroller.scrollTop <= 0) return null;
    const lineHeight = view.defaultLineHeight;
    const scrollerRect = scroller.getBoundingClientRect();
    const editorRect = view.dom.getBoundingClientRect();
    const docTopAt = scrollerRect.top - view.documentTop; // the document's height at the scroller's top edge
    const doc = view.state.doc;
    // The blocks around the first line under the header, as VS Code finds them:
    // again with the header as tall as what it found, until that is the same.
    let lines = [];
    for (let i = 0; i < 4; i++) {
      const block = view.lineBlockAtHeight(Math.max(0, docTopAt + lines.length * lineHeight + 1));
      const next = stickyScopeLines(view.state, doc.lineAt(block.from).number);
      const same = next.length === lines.length && next.every((n, j) => n === lines[j]);
      lines = next;
      if (same) break;
    }
    if (!lines.length) return null;
    // The innermost line slides up as its block's last line reaches it.
    let slide = 0;
    const end = blockEnd(view.state, lines[lines.length - 1]);
    if (end !== null) {
      const endBottom = view.lineBlockAt(doc.line(end).from).bottom - docTopAt;
      const headerBottom = lines.length * lineHeight;
      if (endBottom < headerBottom) slide = Math.max(-lineHeight, endBottom - headerBottom);
    }
    const gutters = view.scrollDOM.querySelector('.cm-gutters');
    return {
      lines,
      slide,
      lineHeight,
      top: scrollerRect.top - editorRect.top,
      width: scroller.clientWidth,
      gutterWidth: gutters ? gutters.offsetWidth : 0,
      textLeft: view.contentDOM.getBoundingClientRect().left - scrollerRect.left + scroller.scrollLeft
        + parseFloat(getComputedStyle(view.contentDOM).paddingLeft || '0') - (gutters ? gutters.offsetWidth : 0),
      scrollLeft: scroller.scrollLeft,
      font: getComputedStyle(view.contentDOM).font,
    };
  }

  draw(m) {
    if (!m) { this.dom.style.display = 'none'; this.shown = ''; return; }
    this.dom.style.display = '';
    this.dom.style.top = `${m.top}px`;
    this.dom.style.width = `${m.width}px`;
    this.dom.style.height = `${m.lines.length * m.lineHeight + m.slide}px`;
    const key = `${m.lines.join(',')}|${m.gutterWidth}|${m.textLeft}`;
    if (key !== this.shown) {
      this.shown = key;
      this.dom.replaceChildren(...m.lines.map(n => this.row(n, m)));
    }
    // The text follows a sideways scroll, the numbers stay.
    for (const text of this.dom.querySelectorAll('.cm-sticky-text')) text.style.transform = `translateX(${-m.scrollLeft}px)`;
    const last = this.dom.lastElementChild;
    if (last) last.style.marginTop = m.slide ? `${m.slide}px` : '';
  }

  row(n, m) {
    const { state } = this.view;
    const line = state.doc.line(n);
    const row = document.createElement('div');
    row.className = 'cm-sticky-line';
    row.dataset.line = String(n);
    row.style.height = row.style.lineHeight = `${m.lineHeight}px`;
    row.style.font = m.font;
    const number = document.createElement('span');
    number.className = 'cm-sticky-number';
    number.style.width = `${m.gutterWidth}px`;
    number.textContent = String(n);
    const text = document.createElement('span');
    text.className = 'cm-sticky-text';
    text.style.paddingLeft = `${Math.max(0, m.textLeft)}px`;
    text.append(...highlightedLine(state, line));
    row.append(number, text);
    return row;
  }

  click(event) {
    const row = event.target.closest('.cm-sticky-line');
    if (!row || event.button !== 0) return;
    event.preventDefault();
    const line = this.view.state.doc.line(Number(row.dataset.line));
    const indent = line.text.length - line.text.trimStart().length;
    this.view.dispatch({ selection: { anchor: line.from + indent }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
    this.view.focus();
  }

  destroy() {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.dom.remove();
  }
}

/** A line's text as spans with the editor's highlighting classes (a long line is cut). */
function highlightedLine(state, line) {
  const text = line.text.slice(0, 400);
  const end = line.from + text.length;
  const classes = new Array(text.length).fill('');
  syntaxTree(state).iterate({
    from: line.from,
    to: end,
    enter(node) {
      const style = getStyleTags(node);
      if (!style) return;
      const cls = highlightingFor(state, style.tags);
      if (!cls) return;
      for (let i = Math.max(node.from, line.from); i < Math.min(node.to, end); i++) classes[i - line.from] = cls;
    },
  });
  const spans = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || classes[i] !== classes[start]) {
      const span = document.createElement('span');
      if (classes[start]) span.className = classes[start];
      span.textContent = text.slice(start, i);
      spans.push(span);
      start = i;
    }
  }
  return spans;
}

const stickyScrollPlugin = ViewPlugin.fromClass(StickyScrollView);

/** Sticky scroll for an editor. */
function stickyScroll() {
  return [stickyScrollPlugin, stickyTheme];
}

export { stickyScroll, stickyScopeLines, MAX_LINES as STICKY_MAX_LINES };
