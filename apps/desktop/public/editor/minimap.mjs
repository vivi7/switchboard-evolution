// The minimap, as VS Code's: the whole file drawn small at the right of the
// editor, each line LINE_HEIGHT pixels high and each character a pixel wide,
// in the colours of its tokens. A translucent slider shows the part on screen:
// drag it to scroll, or click elsewhere to go there. Marks on it: the matches
// of the find bar (the current one brighter), the changes of a diff (a strip on
// the left: added, changed, deleted), the errors and warnings, the selections.
// When the file is taller than the minimap, the minimap scrolls with the
// editor, in proportion. It sits beside the scroller, which makes room for it,
// so that no text ever goes under it; the wheel over it scrolls the text. It is
// not drawn in an editor narrower than MIN_EDITOR_WIDTH.
import { EditorView, ViewPlugin } from '@codemirror/view';
import { syntaxTree, highlightingFor } from '@codemirror/language';
import { getStyleTags } from '@lezer/highlight';
import { getChunks } from '@codemirror/merge';
import { forEachDiagnostic } from '@codemirror/lint';
import { searchState } from './find.mjs';

const WIDTH = 80;
const LINE_HEIGHT = 2;
const CHAR_WIDTH = 1;
const MIN_EDITOR_WIDTH = 420;
const MAX_COLUMNS = Math.floor((WIDTH - 6) / CHAR_WIDTH);

const COLORS = {
  added: '#50fa7b',
  changed: '#8be9fd',
  deleted: '#ff5555',
  match: 'rgba(234, 165, 73, 0.75)',
  matchActive: '#EAA549',
  error: '#ff5555',
  warning: '#f1fa8c',
  selection: 'rgba(255, 255, 255, 0.18)',
  slider: 'rgba(255, 255, 255, 0.10)',
  sliderActive: 'rgba(255, 255, 255, 0.18)',
};

// ── Where things are: pure, so the tests can check them ────────────

/**
 * The minimap's place for an editor: `lines` in the file, the minimap's
 * `height`, the editor's scroll (`scrollTop`, `scrollHeight`, `clientHeight`)
 * and the first and last lines on screen. Returns the minimap's own scroll
 * (`offset`, in pixels), the slider (`sliderTop`, `sliderHeight`) and the
 * lines it draws (`firstDrawn`, `lastDrawn`, 1-based).
 */
function minimapLayout({ lines, height, scrollTop, scrollHeight, clientHeight, firstVisible, lastVisible, lineHeight = LINE_HEIGHT }) {
  const total = lines * lineHeight;
  const scrollable = Math.max(0, scrollHeight - clientHeight);
  const fraction = scrollable > 0 ? Math.min(1, Math.max(0, scrollTop / scrollable)) : 0;
  const offset = total > height ? Math.round(fraction * (total - height)) : 0;
  const sliderTop = (firstVisible - 1) * lineHeight - offset;
  const sliderHeight = Math.max(lineHeight * 2, (lastVisible - firstVisible + 1) * lineHeight);
  const firstDrawn = Math.max(1, Math.floor(offset / lineHeight) + 1);
  const lastDrawn = Math.min(lines, Math.ceil((offset + height) / lineHeight));
  return { offset, sliderTop, sliderHeight, firstDrawn, lastDrawn, total };
}

/** The line (1-based) at `y` pixels from the minimap's top. */
function lineAtY(layout, y, lines, lineHeight = LINE_HEIGHT) {
  return Math.max(1, Math.min(lines, Math.floor((y + layout.offset) / lineHeight) + 1));
}

/** The find bar's matches as [{ line, fromCol, toCol, active }]. */
function searchMarks(state) {
  const search = state.field(searchState, false);
  if (!search || !search.matches || !search.matches.length) return [];
  const sel = state.selection.main;
  return search.matches.map((m) => {
    const line = state.doc.lineAt(m.from);
    return { line: line.number, fromCol: m.from - line.from, toCol: Math.max(m.from - line.from + 1, Math.min(line.length, m.to - line.from)), active: m.from === sel.from && m.to === sel.to };
  });
}

/**
 * A diff's changes in this editor's text as [{ fromLine, toLine, kind }]:
 * 'added' and 'changed' lines, and 'deleted' where lines went (one line).
 */
function diffMarks(state) {
  const result = getChunks(state);
  if (!result || !result.chunks.length || result.side === 'a') return [];
  const doc = state.doc;
  return result.chunks.map((chunk) => {
    const fromLine = doc.lineAt(Math.min(chunk.fromB, doc.length)).number;
    if (chunk.fromB >= chunk.toB) return { fromLine, toLine: fromLine, kind: 'deleted' };
    const toLine = doc.lineAt(Math.max(chunk.fromB, Math.min(chunk.toB, doc.length) - 1)).number;
    return { fromLine, toLine, kind: chunk.fromA >= chunk.toA ? 'added' : 'changed' };
  });
}

/** The errors and warnings as [{ fromLine, toLine, severity }]. */
function diagnosticMarks(state) {
  const marks = [];
  forEachDiagnostic(state, (d, from, to) => {
    marks.push({ fromLine: state.doc.lineAt(from).number, toLine: state.doc.lineAt(Math.max(from, to)).number, severity: d.severity === 'error' ? 'error' : 'warning' });
  });
  return marks;
}

// ── Drawing ─────────────────────────────────────────────────────────

const minimapTheme = EditorView.theme({
  '.cm-minimap': {
    position: 'absolute',
    right: 0,
    width: `${WIDTH}px`,
    zIndex: 3,
    cursor: 'default',
    backgroundColor: 'var(--cm-minimap-bg, #22232e)',
    borderLeft: '1px solid rgba(255, 255, 255, 0.05)',
    boxSizing: 'border-box',
  },
  '.cm-minimap canvas': { display: 'block' },
  '.cm-minimap-slider': {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: COLORS.slider,
    opacity: 0,
    transition: 'opacity 0.15s',
  },
  '.cm-minimap:hover .cm-minimap-slider, .cm-minimap-slider.cm-minimap-dragging': { opacity: 1 },
  '.cm-minimap-slider.cm-minimap-dragging': { backgroundColor: COLORS.sliderActive },
  '.cm-minimap-probe': { display: 'none' },
});

class MinimapView {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-minimap';
    this.dom.setAttribute('aria-hidden', 'true');
    this.canvas = document.createElement('canvas');
    this.slider = document.createElement('div');
    this.slider.className = 'cm-minimap-slider';
    this.probe = document.createElement('span');
    this.probe.className = 'cm-minimap-probe';
    this.dom.append(this.canvas, this.slider, this.probe);
    view.dom.appendChild(this.dom);
    // Room at once, for a scroll to the cursor that comes before the first measure.
    this.makeRoom(true);
    this.colors = new Map(); // highlight class → its colour
    this.layout = null;
    this.onScroll = () => this.schedule();
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.dom.addEventListener('pointerdown', e => this.pointerDown(e));
    this.dom.addEventListener('wheel', e => this.wheel(e), { passive: false });
    this.schedule();
  }

  /** The scroller ends where the minimap starts, or fills the editor without one. */
  makeRoom(shown) {
    this.view.scrollDOM.style.marginRight = shown ? `${WIDTH}px` : '';
  }

  /** The wheel over the minimap scrolls the text; at its end, whatever is around the editor. */
  wheel(event) {
    if (event.ctrlKey) return;
    const scroller = this.view.scrollDOM;
    const { scrollTop, scrollLeft } = scroller;
    scroller.scrollBy(event.deltaX, event.deltaY);
    if (scroller.scrollTop !== scrollTop || scroller.scrollLeft !== scrollLeft) event.preventDefault();
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.geometryChanged || update.selectionSet
      || update.focusChanged || update.transactions.some(tr => tr.effects.length || tr.reconfigured)
      || syntaxTree(update.startState) !== syntaxTree(update.state)) this.schedule();
  }

  schedule() {
    this.view.requestMeasure({ key: this, read: view => this.measure(view), write: measured => this.draw(measured) });
  }

  measure(view) {
    const scroller = view.scrollDOM;
    const shown = view.dom.clientWidth >= MIN_EDITOR_WIDTH;
    if (!shown) return { shown };
    const height = scroller.clientHeight;
    // documentTop already follows the scroll: the document's height at the scroller's top edge.
    const visibleTop = scroller.getBoundingClientRect().top - view.documentTop;
    const top = view.lineBlockAtHeight(Math.max(0, visibleTop + 1));
    const bottom = view.lineBlockAtHeight(Math.max(0, visibleTop + height - 1));
    const doc = view.state.doc;
    return {
      shown,
      top: scroller.offsetTop,
      height,
      dpr: window.devicePixelRatio || 1,
      layout: minimapLayout({
        lines: doc.lines,
        height,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: height,
        firstVisible: doc.lineAt(top.from).number,
        lastVisible: doc.lineAt(Math.min(doc.length, bottom.to)).number,
      }),
      textColor: getComputedStyle(view.contentDOM).color,
    };
  }

  colorOf(cls) {
    if (!this.colors.has(cls)) {
      this.probe.className = `cm-minimap-probe ${cls}`;
      this.colors.set(cls, getComputedStyle(this.probe).color);
    }
    return this.colors.get(cls);
  }

  draw(measured) {
    this.makeRoom(measured.shown);
    if (!measured.shown) { this.dom.style.display = 'none'; this.layout = null; return; }
    this.dom.style.display = '';
    const { top, height, dpr, layout } = measured;
    this.layout = layout;
    this.dom.style.top = `${top}px`;
    this.dom.style.height = `${height}px`;
    if (this.canvas.width !== WIDTH * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = WIDTH * dpr;
      this.canvas.height = height * dpr;
      this.canvas.style.width = `${WIDTH}px`;
      this.canvas.style.height = `${height}px`;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WIDTH, height);
    const { state } = this.view;
    const y = line => (line - 1) * LINE_HEIGHT - layout.offset;

    // The selections, under the text.
    ctx.fillStyle = COLORS.selection;
    for (const range of state.selection.ranges) {
      if (range.empty) continue;
      const from = state.doc.lineAt(range.from).number;
      const to = state.doc.lineAt(range.to).number;
      if (to < layout.firstDrawn || from > layout.lastDrawn) continue;
      ctx.fillRect(4, y(from), WIDTH - 4, (to - from + 1) * LINE_HEIGHT);
    }

    this.drawText(ctx, state, layout, y, measured.textColor);

    for (const m of searchMarks(state)) {
      if (m.line < layout.firstDrawn || m.line > layout.lastDrawn) continue;
      ctx.fillStyle = m.active ? COLORS.matchActive : COLORS.match;
      const x = 4 + Math.min(MAX_COLUMNS - 2, m.fromCol) * CHAR_WIDTH;
      ctx.fillRect(x, y(m.line), Math.max(2, (m.toCol - m.fromCol) * CHAR_WIDTH), LINE_HEIGHT);
    }
    for (const d of diffMarks(state)) {
      if (d.toLine < layout.firstDrawn || d.fromLine > layout.lastDrawn) continue;
      ctx.fillStyle = COLORS[d.kind];
      ctx.fillRect(0, y(d.fromLine), 3, Math.max(LINE_HEIGHT, (d.toLine - d.fromLine + 1) * LINE_HEIGHT));
    }
    for (const d of diagnosticMarks(state)) {
      if (d.toLine < layout.firstDrawn || d.fromLine > layout.lastDrawn) continue;
      ctx.fillStyle = COLORS[d.severity];
      ctx.fillRect(WIDTH - 4, y(d.fromLine), 3, Math.max(LINE_HEIGHT, (d.toLine - d.fromLine + 1) * LINE_HEIGHT));
    }

    this.slider.style.top = `${layout.sliderTop}px`;
    this.slider.style.height = `${layout.sliderHeight}px`;
  }

  /** Each line's characters as blocks, coloured by the syntax highlighting where there is one. */
  drawText(ctx, state, layout, y, textColor) {
    const tree = syntaxTree(state);
    const doc = state.doc;
    if (layout.firstDrawn > layout.lastDrawn) return;
    for (let n = layout.firstDrawn; n <= layout.lastDrawn; n++) {
      const line = doc.line(n);
      const text = line.text.length > MAX_COLUMNS * 2 ? line.text.slice(0, MAX_COLUMNS * 2) : line.text;
      const top = y(n);
      // Plain text first, dimmed.
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = textColor;
      this.drawRuns(ctx, text, 0, text.length, top);
      ctx.globalAlpha = 0.85;
      // Then the tokens in their colours.
      tree.iterate({
        from: line.from,
        to: line.from + text.length,
        enter: (node) => {
          const style = getStyleTags(node);
          if (!style) return;
          const cls = highlightingFor(state, style.tags);
          if (!cls) return;
          const from = Math.max(node.from, line.from) - line.from;
          const to = Math.min(node.to, line.from + text.length) - line.from;
          if (to <= from) return;
          ctx.fillStyle = this.colorOf(cls);
          this.drawRuns(ctx, text, from, to, top);
        },
      });
      ctx.globalAlpha = 1;
    }
  }

  /** The non-blank characters of text[from, to) as blocks, tabs as four columns. */
  drawRuns(ctx, text, from, to, top) {
    let col = 0;
    for (let i = 0; i < from; i++) col += text.charCodeAt(i) === 9 ? 4 - (col % 4) : 1;
    let runStart = -1;
    for (let i = from; i <= to; i++) {
      const code = i < to ? text.charCodeAt(i) : 32;
      const blank = code === 32 || code === 9;
      if (!blank && runStart < 0) runStart = col;
      if (blank && runStart >= 0) {
        if (runStart < MAX_COLUMNS) ctx.fillRect(4 + runStart * CHAR_WIDTH, top, (Math.min(col, MAX_COLUMNS) - runStart) * CHAR_WIDTH, LINE_HEIGHT - 0.5);
        runStart = -1;
      }
      if (i < to) col += code === 9 ? 4 - (col % 4) : 1;
      if (col > MAX_COLUMNS && runStart < 0) break;
    }
  }

  pointerDown(event) {
    if (event.button !== 0 || !this.layout) return;
    event.preventDefault();
    const view = this.view;
    const scroller = view.scrollDOM;
    const rect = this.dom.getBoundingClientRect();
    const layout = this.layout;
    const onSlider = event.clientY - rect.top >= layout.sliderTop && event.clientY - rect.top <= layout.sliderTop + layout.sliderHeight;
    if (!onSlider) {
      // Go there: the clicked line in the middle of the editor.
      const line = view.state.doc.line(lineAtY(layout, event.clientY - rect.top, view.state.doc.lines));
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    }
    // Then drag: the slider follows the pointer, the editor in proportion.
    const startY = event.clientY;
    const startScroll = scroller.scrollTop;
    const ratio = () => {
      const l = this.layout || layout;
      const travel = Math.max(1, Math.min(l.total, rect.height) - l.sliderHeight);
      return Math.max(0, scroller.scrollHeight - scroller.clientHeight) / travel;
    };
    this.slider.classList.add('cm-minimap-dragging');
    this.dom.setPointerCapture(event.pointerId);
    const move = (e) => { if (onSlider) scroller.scrollTop = startScroll + (e.clientY - startY) * ratio(); };
    const up = () => {
      this.slider.classList.remove('cm-minimap-dragging');
      this.dom.removeEventListener('pointermove', move);
      this.dom.removeEventListener('pointerup', up);
      this.dom.removeEventListener('pointercancel', up);
    };
    this.dom.addEventListener('pointermove', move);
    this.dom.addEventListener('pointerup', up);
    this.dom.addEventListener('pointercancel', up);
  }

  destroy() {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.makeRoom(false);
    this.dom.remove();
  }
}

const minimapPlugin = ViewPlugin.fromClass(MinimapView);

/** The minimap of an editor. */
function minimap() {
  return [minimapPlugin, minimapTheme];
}

export { minimap, MinimapView, minimapLayout, lineAtY, searchMarks, diffMarks, diagnosticMarks, WIDTH as MINIMAP_WIDTH, LINE_HEIGHT as MINIMAP_LINE_HEIGHT, MIN_EDITOR_WIDTH };
