// The find and replace bar, as VS Code's find widget, and the go-to-line bar.
//
// Find: Match Case, Match Whole Word, Use Regular Expression (text-search.js,
// the same rules as the Files tab's Search), Find in Selection, a history of
// what was searched (Up and Down), a query of several lines (Ctrl+Enter), and
// the matches marked on the scrollbar. Replace, in an editable editor: the
// current match or all of them, undoable, with $1 and \u \U \l \L for a
// regular expression and Preserve Case. Alt+Enter turns the matches into
// cursors. The same bar searches a rendered preview (a DOM target), without
// Replace.
//
// Keys (bindings in the scope 'sb-editor-keys', which a panel around an
// editor runs for its own toolbar with runEditorKeys):
//   Cmd/Ctrl+F find, ⌥⌘F (Ctrl+H elsewhere) replace,
//   F3 / Shift+F3 and on macOS Cmd+G / Shift+Cmd+G the next and previous match,
//   Cmd+E (macOS) the selection as what to find, Ctrl+G go to line,
//   Cmd/Ctrl+S a 'cm-save' event for the panel around the editor.
import { EditorView, ViewPlugin, Decoration, keymap, runScopeHandlers } from '@codemirror/view';
import { StateField, StateEffect, EditorSelection } from '@codemirror/state';
import TextSearchLib from '../text-search.js';

const MATCH_LIMIT = TextSearchLib.MATCH_LIMIT;
const HISTORY_LIMIT = 50;
const LARGE_DOC = 1024 * 1024;
const KEY_SCOPE = 'sb-editor-keys';

const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// The document's matches and where to go next are text-search.js's (shared with
// the phone's editor, scripts/editor-page/find.js there).
const editorRegExp = TextSearchLib.documentRegExp;
const findMatches = TextSearchLib.findAllMatches;
const firstMatchAfter = TextSearchLib.firstMatchAfter;
const nextMatchIndex = TextSearchLib.nextMatchIndex;

// ── The query in the editor's state ─────────────────────────────────

const setSearchQuery = StateEffect.define(); // { regex, scope } | null

const searchState = StateField.define({
  create() { return null; },
  update(value, tr) {
    let query = value ? { regex: value.regex, scope: value.scope } : null;
    let set = false;
    for (const e of tr.effects) if (e.is(setSearchQuery)) { query = e.value; set = true; }
    if (!query) return null;
    if (!set && !tr.docChanged) return value;
    // The scope follows the edits, a replaced match inside it included.
    const scope = !set && query.scope
      ? query.scope.map(r => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) })).filter(r => r.to > r.from)
      : query.scope || null;
    return { regex: query.regex, scope, matches: findMatches(tr.state.doc.toString(), query.regex, scope) };
  },
});

const matchMark = Decoration.mark({ class: 'cm-find-match' });
const activeMark = Decoration.mark({ class: 'cm-find-match cm-find-match-active' });
const scopeMark = Decoration.mark({ class: 'cm-find-scope' });

const searchHighlighter = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged
      || update.state.field(searchState) !== update.startState.field(searchState)) {
      this.decorations = this.build(update.view);
    }
  }
  build(view) {
    const search = view.state.field(searchState);
    if (!search) return Decoration.none;
    const sel = view.state.selection.main;
    const marks = (search.scope || []).map(r => scopeMark.range(r.from, r.to));
    for (const { from, to } of view.visibleRanges) {
      for (let i = firstMatchAfter(search.matches, from); i < search.matches.length && search.matches[i].from <= to; i++) {
        const m = search.matches[i];
        marks.push((m.from === sel.from && m.to === sel.to ? activeMark : matchMark).range(m.from, m.to));
      }
    }
    return Decoration.set(marks, true);
  }
}, { decorations: v => v.decorations });

/** The matches as marks on the scrollbar, as VS Code's overview ruler. */
const matchRuler = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-find-ruler';
    this.dom.setAttribute('aria-hidden', 'true');
    this.dom.style.display = 'none';
    view.dom.appendChild(this.dom);
    this.schedule();
  }
  update(update) {
    if (update.docChanged || update.geometryChanged || update.selectionSet
      || update.state.field(searchState) !== update.startState.field(searchState)) this.schedule();
  }
  schedule() {
    this.view.requestMeasure({ key: this, read: view => this.measure(view), write: rows => this.draw(rows) });
  }
  measure(view) {
    const search = view.state.field(searchState);
    if (!search || !search.matches.length) return null;
    const scroller = view.scrollDOM;
    const height = scroller.clientHeight;
    const total = Math.max(scroller.scrollHeight, 1);
    const padding = view.documentPadding ? view.documentPadding.top : 0;
    const sel = view.state.selection.main;
    const rows = new Map(); // pixel row → whether the current match is on it
    for (const m of search.matches) {
      const y = Math.min(height - 2, Math.floor((view.lineBlockAt(m.from).top + padding) / total * height));
      rows.set(y, rows.get(y) || (m.from === sel.from && m.to === sel.to));
    }
    // On the scrollbar, which has the minimap at its right when there is one.
    const right = view.dom.clientWidth - scroller.offsetLeft - scroller.offsetWidth;
    return { top: scroller.offsetTop, right, height, rows };
  }
  draw(measured) {
    if (!measured) { this.dom.style.display = 'none'; this.dom.replaceChildren(); return; }
    this.dom.style.display = '';
    this.dom.style.top = `${measured.top}px`;
    this.dom.style.right = `${measured.right}px`;
    this.dom.style.height = `${measured.height}px`;
    const marks = [];
    for (const [y, active] of measured.rows) {
      const mark = document.createElement('div');
      mark.className = active ? 'cm-find-ruler-mark active' : 'cm-find-ruler-mark';
      mark.style.top = `${y}px`;
      marks.push(mark);
    }
    this.dom.replaceChildren(...marks);
  }
  destroy() { this.dom.remove(); }
});

const searchTheme = EditorView.theme({
  '.cm-find-match': { backgroundColor: '#515C6A', borderRadius: '2px' },
  '.cm-find-match-active': { backgroundColor: '#EAA549', color: '#171717', borderRadius: '2px' },
  '.cm-find-scope': { backgroundColor: 'rgba(98, 114, 164, 0.22)' },
});

// ── History of what was searched and what replaced it ──────────────

const historyCache = {};

function readHistory(kind) {
  if (!historyCache[kind]) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(`editorFindHistory:${kind}`) || '[]'); } catch {}
    historyCache[kind] = Array.isArray(list) ? list.filter(v => typeof v === 'string') : [];
  }
  return historyCache[kind];
}

/** `value` as the latest entry of the `kind` history (once, at the end), at most HISTORY_LIMIT. */
function pushHistory(kind, value) {
  if (!value) return;
  const list = readHistory(kind).filter(v => v !== value);
  list.push(value);
  historyCache[kind] = list.slice(-HISTORY_LIMIT);
  try { localStorage.setItem(`editorFindHistory:${kind}`, JSON.stringify(historyCache[kind])); } catch {}
}

// ── Targets: an editor, or a rendered preview ──────────────────────

/** What the bar searches in an editor: the matches are the editor state's. */
function editorTarget(view) {
  return {
    view,
    canReplace: () => view.state.facet(EditorView.editable) && !view.state.readOnly,
    seed() {
      const sel = view.state.selection.main;
      if (!sel.empty) {
        const text = view.state.sliceDoc(sel.from, sel.to);
        return text.includes('\n') ? '' : text;
      }
      const word = view.state.wordAt(sel.head);
      return word ? view.state.sliceDoc(word.from, word.to) : '';
    },
    scopeFromSelection() {
      const ranges = view.state.selection.ranges.filter(r => !r.empty).map(r => ({ from: r.from, to: r.to }));
      if (ranges.length) return ranges;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      return [{ from: line.from, to: line.to }];
    },
    setQuery(regex, scope) { view.dispatch({ effects: setSearchQuery.of(regex ? { regex, scope } : null) }); },
    matches() { const s = view.state.field(searchState, false); return s ? s.matches : []; },
    selection() { return view.state.selection.main; },
    activeIndex(matches) {
      const sel = view.state.selection.main;
      return matches.findIndex(m => m.from === sel.from && m.to === sel.to);
    },
    reveal(match) {
      view.dispatch({ selection: { anchor: match.from, head: match.to }, effects: EditorView.scrollIntoView(match.from, { y: 'center' }) });
    },
    selectAll(matches, main) {
      if (!matches.length) return;
      view.dispatch({
        selection: EditorSelection.create(matches.map(m => EditorSelection.range(m.from, m.to)), Math.max(0, main)),
        effects: EditorView.scrollIntoView(matches[Math.max(0, main)].from, { y: 'center' }),
        userEvent: 'select',
      });
      view.focus();
    },
    text: () => view.state.doc.toString(),
    textOf: m => view.state.sliceDoc(m.from, m.to),
    replace(changes, userEvent) { view.dispatch({ changes, userEvent }); },
    large: () => view.state.doc.length > LARGE_DOC,
    focus: () => view.focus(),
    gotoLine: () => openGotoLine(view),
    save: () => view.dom.dispatchEvent(new CustomEvent('cm-save', { bubbles: true })),
  };
}

/**
 * What the bar searches in rendered text (a Markdown or JSON preview): the
 * text nodes under `root`, marked with the CSS Custom Highlight API. Text in
 * scripts, styles and buttons is left out.
 */
function domTarget(root) {
  let matches = [];
  let active = -1;
  const clear = () => {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete('editor-preview-find');
      CSS.highlights.delete('editor-preview-find-active');
    }
  };
  return {
    canReplace: () => false,
    seed() {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || !root.contains(selection.anchorNode)) return '';
      const text = selection.toString();
      return text.includes('\n') ? '' : text;
    },
    scopeFromSelection: () => null,
    setQuery(regex) {
      clear();
      matches = [];
      active = -1;
      if (!regex) return;
      const nodes = [];
      let text = '';
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        if (node.parentElement && node.parentElement.closest('script, style, button')) continue;
        nodes.push({ node, start: text.length });
        text += node.nodeValue;
      }
      let first = 0;
      for (const { from, to } of findMatches(text, regex)) {
        while (first + 1 < nodes.length && nodes[first + 1].start <= from) first++;
        let last = first;
        while (last + 1 < nodes.length && nodes[last + 1].start < to) last++;
        const range = document.createRange();
        range.setStart(nodes[first].node, from - nodes[first].start);
        range.setEnd(nodes[last].node, to - nodes[last].start);
        matches.push({ from, to, range });
      }
      if (matches.length && typeof Highlight !== 'undefined') {
        CSS.highlights.set('editor-preview-find', new Highlight(...matches.map(m => m.range)));
      }
    },
    matches: () => matches,
    selection: () => (active >= 0 && matches[active] ? matches[active] : { from: 0, to: 0 }),
    activeIndex: () => active,
    reveal(match) {
      active = matches.indexOf(match);
      if (typeof Highlight !== 'undefined') CSS.highlights.set('editor-preview-find-active', new Highlight(match.range));
      const rect = match.range.getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      root.scrollBy({ top: rect.top - bounds.top - bounds.height / 2, behavior: 'instant' });
    },
    selectAll() {},
    text: () => '',
    textOf: () => '',
    replace() {},
    large: () => false,
    focus() { root.focus({ preventScroll: true }); },
    gotoLine() {},
    save() {},
    clear,
  };
}

// ── The bar ─────────────────────────────────────────────────────────

const FIND_ICONS = {
  chevronRight: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  chevronDown: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  matchCase: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 12.5h-1.2l-.9-2.6H2.3l-.9 2.6H.2L3.2 4h1.3zm-2.5-3.6L3.9 5.6 2.7 8.9zM14.5 12.5h-1.1v-.8c-.5.6-1 1-1.9 1-1.1 0-1.9-.7-1.9-1.8 0-1.1.8-1.8 2.3-1.9l1.5-.1v-.4c0-.7-.4-1.1-1.2-1.1-.6 0-1.1.2-1.6.6l-.5-.8c.6-.5 1.3-.8 2.2-.8 1.4 0 2.2.7 2.2 2zm-1.1-2.7-1.3.1c-.9.1-1.3.4-1.3.9 0 .6.4.9 1 .9.9 0 1.6-.6 1.6-1.4z"/></svg>',
  wholeWord: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 11h1v2h14v-2h1v3H0z"/><path d="M6.8 10.5h-1v-.6c-.4.5-.9.7-1.6.7-1 0-1.6-.6-1.6-1.4 0-.9.7-1.5 2-1.6l1.2-.1v-.3c0-.6-.3-.9-1-.9-.5 0-.9.2-1.3.5l-.4-.7c.5-.4 1.1-.6 1.8-.6 1.2 0 1.9.6 1.9 1.7zm-1-2.3-1 .1c-.7.1-1.1.3-1.1.8 0 .4.3.7.8.7.8 0 1.3-.5 1.3-1.2zM9 10.5H8V3h1v3.6c.4-.5.9-.8 1.6-.8 1.2 0 2 1 2 2.4 0 1.5-.8 2.5-2.1 2.5-.6 0-1.1-.3-1.5-.8zm0-1.9c0 .7.5 1.3 1.3 1.3s1.3-.6 1.3-1.6-.4-1.6-1.2-1.6S9 7.3 9 8.1z"/></svg>',
  regex: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 1.5h1v2.3l2-1.2.5.9-2 1.1 2 1.1-.5.9-2-1.2v2.3h-1V5.4l-2 1.2-.5-.9 2-1.1-2-1.1.5-.9 2 1.2zM2 11h3v3H2z"/></svg>',
  inSelection: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3h14v1H1zm0 9h14v1H1zM3 6h10v1H3zm0 3h7v1H3z"/><path d="M1 5.5h1v5H1zm13 0h1v5h-1z" opacity=".6"/></svg>',
  preserveCase: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.6 11.5h-1.2l-.7-2H1.2l-.7 2H-.6L2 3.8h1.1zM3.4 8.4 2.5 5.6l-1 2.8zM7 3.8h2.7c1.6 0 2.4.7 2.4 1.9 0 .8-.4 1.3-1.1 1.6.9.2 1.4.9 1.4 1.8 0 1.5-1 2.4-2.7 2.4H7zm1.1 3.2h1.4c.9 0 1.4-.4 1.4-1.1s-.5-1.1-1.4-1.1H8.1zm0 3.5h1.6c1 0 1.6-.5 1.6-1.3s-.6-1.2-1.6-1.2H8.1z"/><path d="M13 13h3v1h-3z"/></svg>',
  replaceOne: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.6 2.7 10.5 1.6l.7-.7 2.3 2.3-2.3 2.3-.7-.7 1.1-1.1H9.5a2 2 0 0 0-2 2v.5h-1v-.5a3 3 0 0 1 3-3zM3 9h4v1H3zm6 0h4v5H9zm1 1v3h2v-3zM3 11h4v1H3zm0 2h4v1H3z"/></svg>',
  replaceAll: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.6 2.7 10.5 1.6l.7-.7 2.3 2.3-2.3 2.3-.7-.7 1.1-1.1H9.5a2 2 0 0 0-2 2v.5h-1v-.5a3 3 0 0 1 3-3zM1 9h6v1H1zm0 2h6v1H1zm0 2h6v1H1zm8-4h6v6H9zm1 1v4h4v-4z"/></svg>',
};

/** The number of lines of a textarea's text, to size it (at most 5 shown). */
function sizeToLines(textarea) {
  textarea.rows = Math.min(5, Math.max(1, textarea.value.split('\n').length));
}

/** Insert a new line at the caret of a textarea, as Ctrl+Enter does in VS Code's find. */
function insertNewline(textarea) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  textarea.value = value.slice(0, start) + '\n' + value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + 1;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function caretOnFirstLine(textarea) { return !textarea.value.slice(0, textarea.selectionStart).includes('\n'); }
function caretOnLastLine(textarea) { return !textarea.value.slice(textarea.selectionEnd).includes('\n'); }

/**
 * A find bar in `parent` for `target` (editorTarget or domTarget). With
 * `onReplaceInSource`, the replace toggle of a target that cannot replace
 * (a preview) asks for the source instead.
 */
function createFindBar(parent, target, { onReplaceInSource = null } = {}) {
  const mac = isMacPlatform();
  const keyHint = (m, o) => (mac ? m : o);
  const bar = document.createElement('div');
  bar.className = 'terminal-search-bar cm-find-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <button type="button" class="cm-find-toggle" title="Toggle Replace" aria-label="Toggle Replace" aria-expanded="false">${FIND_ICONS.chevronRight}</button>
    <div class="cm-find-rows">
      <div class="cm-find-row">
        <span class="cm-find-box">
          <textarea rows="1" wrap="off" class="terminal-search-input cm-find-input" placeholder="Find" aria-label="Find" spellcheck="false" title="Find (↑↓ for history, Ctrl+Enter for a new line)"></textarea>
          <button type="button" class="cm-find-opt" data-opt="matchCase" title="Match Case (${keyHint('⌥⌘C', 'Alt+C')})" aria-pressed="false">${FIND_ICONS.matchCase}</button>
          <button type="button" class="cm-find-opt" data-opt="wholeWord" title="Match Whole Word (${keyHint('⌥⌘W', 'Alt+W')})" aria-pressed="false">${FIND_ICONS.wholeWord}</button>
          <button type="button" class="cm-find-opt" data-opt="isRegex" title="Use Regular Expression (${keyHint('⌥⌘R', 'Alt+R')})" aria-pressed="false">${FIND_ICONS.regex}</button>
        </span>
        <span class="terminal-search-count" aria-live="polite"></span>
        <button type="button" class="terminal-search-prev" title="Previous Match (Shift+Enter, ${keyHint('⇧⌘G', 'Shift+F3')})" aria-label="Previous Match">&#x25B2;</button>
        <button type="button" class="terminal-search-next" title="Next Match (Enter, ${keyHint('⌘G', 'F3')})" aria-label="Next Match">&#x25BC;</button>
        <button type="button" class="cm-find-opt cm-find-in-selection" data-opt="inSelection" title="Find in Selection (${keyHint('⌥⌘L', 'Alt+L')})" aria-pressed="false">${FIND_ICONS.inSelection}</button>
        <button type="button" class="terminal-search-close" title="Close (Escape)" aria-label="Close">&times;</button>
      </div>
      <div class="cm-find-row cm-replace-row" hidden>
        <span class="cm-find-box">
          <textarea rows="1" wrap="off" class="terminal-search-input cm-replace-input" placeholder="Replace" aria-label="Replace" spellcheck="false" title="Replace (↑↓ for history, Ctrl+Enter for a new line)"></textarea>
          <button type="button" class="cm-find-opt" data-opt="preserveCase" title="Preserve Case (${keyHint('⌥⌘P', 'Alt+P')})" aria-pressed="false">${FIND_ICONS.preserveCase}</button>
        </span>
        <button type="button" class="cm-replace-one" title="Replace (Enter)" aria-label="Replace">${FIND_ICONS.replaceOne}</button>
        <button type="button" class="cm-replace-all" title="Replace All (${keyHint('⌘Enter', 'Ctrl+Alt+Enter')})" aria-label="Replace All">${FIND_ICONS.replaceAll}</button>
      </div>
    </div>
  `;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  parent.appendChild(bar);

  const input = bar.querySelector('.cm-find-input');
  const replaceInput = bar.querySelector('.cm-replace-input');
  const replaceRow = bar.querySelector('.cm-replace-row');
  const toggle = bar.querySelector('.cm-find-toggle');
  const countEl = bar.querySelector('.terminal-search-count');
  const options = { matchCase: false, wholeWord: false, isRegex: false, inSelection: false, preserveCase: false };
  const historyAt = { find: -1, replace: -1 };
  let regex = null;
  let scope = null;
  let inputTimer = null;

  const isOpen = () => bar.style.display !== 'none';
  const matches = () => target.matches();

  function buildRegex() {
    if (!input.value) return null;
    try {
      countEl.title = '';
      return editorRegExp({ query: input.value, isRegex: options.isRegex, matchCase: options.matchCase, wholeWord: options.wholeWord });
    } catch (err) {
      countEl.title = err.message;
      return undefined;
    }
  }

  function countText(list = matches()) {
    if (!regex) return regex === undefined ? 'Invalid' : '';
    if (!list.length) return 'No results';
    const idx = target.activeIndex(list);
    const total = list.length >= MATCH_LIMIT ? `${MATCH_LIMIT}+` : String(list.length);
    return idx >= 0 ? `${idx + 1} of ${total}` : `${total} found`;
  }

  /** Search again for what is typed, with the options, and say how many there are. */
  function findAll() {
    clearTimeout(inputTimer);
    inputTimer = null;
    regex = buildRegex();
    bar.classList.toggle('is-invalid', regex === undefined);
    target.setQuery(regex || null, options.inSelection ? scope : null);
    countEl.textContent = countText();
  }

  function goTo(idx) {
    const list = matches();
    if (!list.length) { countEl.textContent = countText(list); return; }
    const i = ((idx % list.length) + list.length) % list.length;
    target.reveal(list[i]);
    countEl.textContent = countText();
  }

  function step(direction) {
    if (inputTimer !== null) findAll();
    const list = matches();
    if (!list.length) return;
    const sel = target.selection();
    goTo(nextMatchIndex(list, sel.from, sel.to, direction));
    pushHistory('find', input.value);
  }

  /** The first match at or after `pos` (round the end), as the bar shows when it opens or the query changes. */
  function goToFrom(pos) {
    const list = matches();
    if (!list.length) { countEl.textContent = countText(list); return; }
    const idx = list.findIndex(m => m.from >= pos);
    goTo(idx < 0 ? 0 : idx);
  }

  function replacementFor(match, text) {
    return TextSearchLib.documentReplacement(regex, options, text, match, replaceInput.value);
  }

  function replaceOne() {
    if (!target.canReplace() || !regex) return;
    const list = matches();
    if (!list.length) return;
    const current = target.activeIndex(list);
    // The first press selects the match, as VS Code does when the cursor is elsewhere.
    if (current < 0) { goToFrom(target.selection().from); return; }
    const match = list[current];
    const insert = replacementFor(match, target.text());
    target.replace({ from: match.from, to: match.to, insert }, 'input.replace');
    pushHistory('find', input.value);
    pushHistory('replace', replaceInput.value);
    goToFrom(match.from + insert.length);
  }

  function replaceAll() {
    if (!target.canReplace() || !regex) return;
    const list = matches();
    if (!list.length) return;
    const text = target.text();
    const changes = list.map(m => ({ from: m.from, to: m.to, insert: replacementFor(m, text) }));
    target.replace(changes, 'input.replace.all');
    pushHistory('find', input.value);
    pushHistory('replace', replaceInput.value);
    countEl.textContent = `Replaced ${changes.length}`;
  }

  function selectAllMatches() {
    if (inputTimer !== null) findAll();
    const list = matches();
    if (!list.length) return;
    pushHistory('find', input.value);
    target.selectAll(list, target.activeIndex(list));
  }

  function showReplace(show) {
    const on = show && target.canReplace();
    replaceRow.hidden = !on;
    toggle.innerHTML = on ? FIND_ICONS.chevronDown : FIND_ICONS.chevronRight;
    toggle.setAttribute('aria-expanded', String(on));
    bar.classList.toggle('has-replace', on);
  }

  function setOption(opt, value = !options[opt]) {
    options[opt] = value;
    const button = bar.querySelector(`.cm-find-opt[data-opt="${opt}"]`);
    if (button) {
      button.classList.toggle('on', value);
      button.setAttribute('aria-pressed', String(value));
    }
    if (opt === 'preserveCase') return;
    if (opt === 'inSelection') scope = value ? target.scopeFromSelection() : null;
    findAll();
    if (opt !== 'inSelection' && matches().length) goToFrom(target.selection().from);
  }

  /**
   * Show the bar: with what is selected (or the word at the cursor) as what
   * to find when `seed`, on the first match from the cursor when `reveal`,
   * the focus in its field when `focus`.
   */
  function open({ replace = false, seed = true, reveal = true, focus = true } = {}) {
    const canReplace = target.canReplace();
    toggle.style.display = canReplace || onReplaceInSource ? '' : 'none';
    bar.querySelector('.cm-find-in-selection').style.display = target.scopeFromSelection() ? '' : 'none';
    const wasOpen = isOpen();
    bar.style.display = 'flex';
    if (replace) showReplace(true);
    if (!wasOpen && options.inSelection) setOption('inSelection', false);
    const seeded = seed ? target.seed() : '';
    if (seeded) input.value = seeded;
    sizeToLines(input);
    historyAt.find = -1;
    findAll();
    if (reveal && matches().length) goToFrom(target.selection().from);
    if (!focus) return;
    const field = replace && input.value && canReplace ? replaceInput : input;
    field.focus();
    field.select();
  }

  function close({ focus = true } = {}) {
    if (!isOpen()) return;
    pushHistory('find', input.value);
    clearTimeout(inputTimer);
    inputTimer = null;
    bar.style.display = 'none';
    regex = null;
    target.setQuery(null);
    countEl.textContent = '';
    if (focus) target.focus();
  }

  /** Next or previous match from the editor's keys: the bar opens again with what was last searched. */
  function findNext(direction) {
    if (!input.value) { open(); return; }
    if (!isOpen()) open({ seed: false, reveal: false, focus: false });
    step(direction);
  }

  /** Cmd+E: the selection (or the word at the cursor) becomes what to find, without opening the bar. */
  function useSelection() {
    const seeded = target.seed();
    if (!seeded) return;
    input.value = seeded;
    sizeToLines(input);
    if (isOpen()) findAll();
  }

  /** Up and Down in a field: the earlier and later entries of its history. */
  function browseHistory(field, kind, direction) {
    const list = readHistory(kind);
    if (!list.length) return false;
    let at = historyAt[kind];
    if (at < 0) at = list.length;
    at = Math.max(0, Math.min(list.length, at + direction));
    historyAt[kind] = at;
    field.value = at === list.length ? '' : list[at];
    sizeToLines(field);
    field.selectionStart = field.selectionEnd = field.value.length;
    if (field === input) findAll();
    return true;
  }

  function onKey(e) {
    const mod = mac ? e.metaKey : e.ctrlKey;
    const optKey = mac ? (e.altKey && e.metaKey && !e.ctrlKey) : (e.altKey && !e.ctrlKey && !e.metaKey);
    const field = e.target === input || e.target === replaceInput ? e.target : null;
    if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); return; }
    if (optKey && e.code === 'KeyC') { setOption('matchCase'); e.preventDefault(); return; }
    if (optKey && e.code === 'KeyW') { setOption('wholeWord'); e.preventDefault(); return; }
    if (optKey && e.code === 'KeyR') { setOption('isRegex'); e.preventDefault(); return; }
    if (optKey && e.code === 'KeyL' && target.scopeFromSelection()) { setOption('inSelection'); e.preventDefault(); return; }
    if (optKey && e.code === 'KeyP' && target.canReplace()) { setOption('preserveCase'); e.preventDefault(); return; }
    if (e.key === 'g' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { target.gotoLine(); e.preventDefault(); return; }
    if (e.key === 's' && mod && !e.shiftKey && !e.altKey) { target.save(); e.preventDefault(); return; }
    if (mac && e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyG') { step(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
    if (e.key === 'F3') { step(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
    if ((mac ? (e.key === 'f' || e.code === 'KeyF') && e.metaKey && e.altKey : e.key === 'h' && e.ctrlKey && !e.altKey)) {
      if (target.canReplace()) { showReplace(true); replaceInput.focus(); replaceInput.select(); } else if (onReplaceInSource) onReplaceInSource();
      e.preventDefault();
      return;
    }
    if (e.key === 'f' && mod && !e.altKey) { input.focus(); input.select(); e.preventDefault(); return; }
    if (field && e.key === 'Enter' && e.ctrlKey && !e.altKey && !e.metaKey) { insertNewline(field); e.preventDefault(); return; }
    if (field === replaceInput && e.key === 'Enter' && (mac ? e.metaKey : (e.ctrlKey && e.altKey))) { replaceAll(); e.preventDefault(); return; }
    if (field === replaceInput && e.key === 'Enter' && !e.shiftKey && !e.altKey) { replaceOne(); e.preventDefault(); return; }
    if (field === input && e.key === 'Enter' && e.altKey) { selectAllMatches(); e.preventDefault(); return; }
    if (field && e.key === 'ArrowUp' && !e.shiftKey && caretOnFirstLine(field)) {
      if (browseHistory(field, field === input ? 'find' : 'replace', -1)) e.preventDefault();
      return;
    }
    if (field && e.key === 'ArrowDown' && !e.shiftKey && caretOnLastLine(field)) {
      if (browseHistory(field, field === input ? 'find' : 'replace', 1)) e.preventDefault();
      return;
    }
    if (field === input && e.key === 'Enter') { step(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
    // Only Ctrl+Enter puts a new line in a field.
    if (field && e.key === 'Enter') e.preventDefault();
  }

  input.addEventListener('input', () => {
    sizeToLines(input);
    historyAt.find = -1;
    const run = () => { findAll(); if (matches().length) goToFrom(target.selection().from); };
    clearTimeout(inputTimer);
    // A large document is searched once the typing pauses.
    if (target.large()) inputTimer = setTimeout(run, 200);
    else run();
  });
  replaceInput.addEventListener('input', () => { sizeToLines(replaceInput); historyAt.replace = -1; });
  bar.addEventListener('keydown', onKey);
  toggle.addEventListener('click', () => {
    if (target.canReplace()) showReplace(replaceRow.hidden);
    else if (onReplaceInSource) onReplaceInSource();
  });
  bar.querySelectorAll('.cm-find-opt').forEach(b => b.addEventListener('click', () => setOption(b.dataset.opt)));
  bar.querySelector('.terminal-search-next').addEventListener('click', () => step(1));
  bar.querySelector('.terminal-search-prev').addEventListener('click', () => step(-1));
  bar.querySelector('.terminal-search-close').addEventListener('click', () => close());
  bar.querySelector('.cm-replace-one').addEventListener('click', replaceOne);
  bar.querySelector('.cm-replace-all').addEventListener('click', replaceAll);

  return {
    open, close, findNext, useSelection, isOpen, bar,
    /** The editor's text changed: the count follows (the matches are already the state's). */
    refreshCount() { if (isOpen()) countEl.textContent = countText(); },
    /** The rendered text was drawn again: search it again. */
    refresh() { if (isOpen()) findAll(); },
  };
}

// ── The bars of an editor ───────────────────────────────────────────
// Kept on the editor's parent element (as _cmSearchBar and _cmGotoLine), so
// that a panel that creates a new editor in the same element clears them.

function searchBarOf(view) {
  const parent = view.dom.parentElement;
  if (!parent._cmSearchBar) parent._cmSearchBar = createFindBar(parent, editorTarget(view));
  return parent._cmSearchBar;
}

function openSearch(view, opts = {}) {
  const parent = view.dom.parentElement;
  if (!parent) return false;
  if (parent._cmGotoLine) parent._cmGotoLine.close({ focus: false });
  searchBarOf(view).open(opts);
  return true;
}

function closeSearch(view) {
  const bar = view.dom.parentElement && view.dom.parentElement._cmSearchBar;
  if (!bar || !bar.isOpen()) return false;
  bar.close();
  return true;
}

const findNext = view => { if (!view.dom.parentElement) return false; searchBarOf(view).findNext(1); return true; };
const findPrevious = view => { if (!view.dom.parentElement) return false; searchBarOf(view).findNext(-1); return true; };
const useSelectionForFind = view => { if (!view.dom.parentElement) return false; searchBarOf(view).useSelection(); return true; };
const saveCommand = view => { view.dom.dispatchEvent(new CustomEvent('cm-save', { bubbles: true })); return true; };

// ── Go to line (Ctrl+G) ─────────────────────────────────────────────

/** "12", "12:5" or "12,5" as { line, column }, null for anything else. */
function parseLineTarget(text) {
  const m = /^\s*:?\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(String(text || ''));
  if (!m) return null;
  return { line: Number(m[1]), column: m[2] ? Number(m[2]) : 1 };
}

function createGotoLineBar(parent, view) {
  const bar = document.createElement('div');
  bar.className = 'terminal-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Go to line (line:column)" aria-label="Go to line" style="width:160px" />
    <span class="terminal-search-count"></span>
    <button type="button" class="terminal-search-close" title="Close (Escape)" aria-label="Close">&times;</button>
  `;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  parent.appendChild(bar);

  const input = bar.querySelector('.terminal-search-input');
  const countEl = bar.querySelector('.terminal-search-count');

  function goTo() {
    const targetLine = parseLineTarget(input.value);
    if (!targetLine || targetLine.line < 1) { countEl.textContent = 'Invalid'; return; }
    const doc = view.state.doc;
    if (targetLine.line > doc.lines) { countEl.textContent = `Max: ${doc.lines}`; return; }
    const line = doc.line(targetLine.line);
    const pos = line.from + Math.min(Math.max(0, targetLine.column - 1), line.length);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    close();
  }

  function open() {
    bar.style.display = 'flex';
    input.value = '';
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    countEl.textContent = `${line.number} of ${view.state.doc.lines}`;
    input.focus();
  }

  function close({ focus = true } = {}) {
    if (bar.style.display === 'none') return;
    bar.style.display = 'none';
    input.value = '';
    countEl.textContent = '';
    if (focus) view.focus();
  }

  const mac = isMacPlatform();
  input.addEventListener('keydown', (e) => {
    const mod = mac ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'f' && mod) { openSearch(view, { replace: mac ? e.altKey : false }); e.preventDefault(); }
    else if (e.key === 's' && mod) { saveCommand(view); e.preventDefault(); }
    else if (e.key === 'Enter') { goTo(); e.preventDefault(); }
  });
  bar.querySelector('.terminal-search-close').addEventListener('click', () => close());

  return { open, close };
}

function openGotoLine(view) {
  const parent = view.dom.parentElement;
  if (!parent) return false;
  if (parent._cmSearchBar) parent._cmSearchBar.close({ focus: false });
  if (!parent._cmGotoLine) parent._cmGotoLine = createGotoLineBar(parent, view);
  parent._cmGotoLine.open();
  return true;
}

// ── Keys ────────────────────────────────────────────────────────────

/**
 * The bars' keys, in the editor and in KEY_SCOPE (runEditorKeys). Escape
 * closes the find bar first; with it closed it does nothing here.
 */
function findKeymap() {
  const scope = `editor ${KEY_SCOPE}`;
  return keymap.of([
    { key: 'Mod-f', run: view => openSearch(view), scope, preventDefault: true },
    { mac: 'Mod-Alt-f', win: 'Ctrl-h', linux: 'Ctrl-h', run: view => openSearch(view, { replace: true }), scope, preventDefault: true },
    { key: 'F3', run: findNext, shift: findPrevious, scope, preventDefault: true },
    { mac: 'Mod-g', run: findNext, shift: findPrevious, scope, preventDefault: true },
    { mac: 'Mod-e', run: useSelectionForFind, scope, preventDefault: true },
    { key: 'Ctrl-g', run: view => openGotoLine(view), scope, preventDefault: true },
    { key: 'Mod-s', run: saveCommand, scope, preventDefault: true },
    { key: 'Escape', run: closeSearch },
  ]);
}

/**
 * Run the editor's own keys (find, replace, go to line, save, go to symbol)
 * for a key pressed outside its text: on the panel's toolbar, or when the
 * editor is read-only and its frame has the focus. True when one ran.
 */
function runEditorKeys(view, event) {
  return runScopeHandlers(view, event, KEY_SCOPE);
}

/**
 * The find bar's count follows edits, and in a read-only editor the keys work
 * from anywhere inside it (its text and gutters are not the content's focus).
 */
const findSupport = [
  searchState,
  searchHighlighter,
  matchRuler,
  searchTheme,
  EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const bar = update.view.dom.parentElement && update.view.dom.parentElement._cmSearchBar;
    if (bar) bar.refreshCount();
  }),
];

/**
 * Keys pressed on an editor's frame (its gutters, or the whole of a read-only
 * viewer that took the focus) reach the bindings too. The frame can take the
 * focus with a click, not with Tab.
 */
const frameKeys = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.handler = (event) => {
      if (event.defaultPrevented) return;
      if (runEditorKeys(view, event)) event.preventDefault();
    };
    if (!view.dom.hasAttribute('tabindex')) view.dom.setAttribute('tabindex', '-1');
    view.dom.addEventListener('keydown', this.handler);
  }
  destroy() { this.view.dom.removeEventListener('keydown', this.handler); }
});

/** A find bar over rendered text (a preview), in `host`: find only. */
function createPreviewFind(host, root, opts = {}) {
  const target = domTarget(root);
  const bar = createFindBar(host, target, opts);
  return { ...bar, clear: target.clear };
}

export {
  MATCH_LIMIT, KEY_SCOPE, editorRegExp, findMatches, nextMatchIndex, firstMatchAfter, parseLineTarget,
  searchState, setSearchQuery, findSupport, frameKeys, findKeymap, runEditorKeys,
  openSearch, closeSearch, openGotoLine, findNext, findPrevious, useSelectionForFind, saveCommand,
  createFindBar, editorTarget, createPreviewFind, pushHistory, readHistory,
};
