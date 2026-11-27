// settings-search.js — the search box of the Settings page (settings-panel.js
// calls bindSettingsSearch): the settings that have what is typed in their
// title come first, then the ones that need their description to match. A
// result leads to its setting, in its tab. The settings are read from the page
// as it is drawn, so the sections that draw themselves (Editor, Node
// Knowledge, Prompt improver) are searched too.

// How long the setting a result led to stays marked.
const SETTINGS_SEARCH_FOUND_MS = 2000;

// What matches, and in which order: the shared model's (settings-model.js), as on the phone.
const settingsSearchModel = typeof module !== 'undefined' && module.exports ? require('./settings-model') : window.SettingsModel;

const settingsSearchEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `text` as HTML, with the words of `query` marked. */
function settingsSearchMark(text, query) {
  return settingsSearchModel.searchParts(text, query)
    .map(p => (p.match ? `<mark>${settingsSearchEsc(p.text)}</mark>` : settingsSearchEsc(p.text))).join('');
}

/**
 * The results' HTML: the title matches, then the description matches. Each
 * result's `data-index` is its place in the two lists one after the other.
 */
function settingsSearchResultsHtml(found, query) {
  let index = 0;
  const group = (heading, entries) => (entries.length ? `<div class="settings-section-title">${heading}</div>
    <div class="settings-search-group">${entries.map(e => `<button type="button" class="settings-search-result" data-index="${index++}">
      <span class="settings-search-where">${settingsSearchEsc(e.where)}</span>
      <span class="settings-label">${settingsSearchMark(e.title, query)}</span>
      <span class="settings-description">${settingsSearchMark(e.description, query)}</span>
    </button>`).join('')}</div>` : '');
  return settingsSearchModel.SEARCH_GROUPS.map(({ key, label }) => group(label, found[key])).join('');
}

/** An element's text on one line. */
function settingsSearchText(el) {
  if (!el) return '';
  const copy = el.cloneNode(true);
  // A locked CLI toggle says why it is locked in place of its description (syncHarnessLock).
  if (el.dataset.originalText) copy.innerHTML = el.dataset.originalText;
  copy.querySelectorAll('br').forEach(br => br.replaceWith(' '));
  return copy.textContent.replace(/\s+/g, ' ').trim();
}

/** The settings the page has, in its order: tab by tab, then from the top of each. */
function settingsSearchEntries(form) {
  return [...form.querySelectorAll('.settings-field')].map((field) => {
    const pane = field.closest('.settings-pane');
    const tab = pane && form.querySelector(`.settings-tab[data-tab="${pane.dataset.tab}"]`);
    // Left out: what a tab or a section with nothing to show holds. A pane is
    // hidden whenever its tab is not the chosen one, which leaves nothing out.
    if (tab?.hidden || field.closest('[hidden]:not(.settings-pane)')) return null;
    const tabName = tab ? tab.textContent.trim() : '';
    const section = field.closest('.settings-section')?.querySelector('.settings-section-title')?.textContent.trim() || '';
    return {
      field,
      title: settingsSearchText(field.querySelector('.settings-label')),
      description: settingsSearchText(field.querySelector('.settings-description')),
      where: settingsSearchModel.searchWhere(tabName, section),
    };
  }).filter(Boolean);
}

/**
 * Wire the search box of the page drawn in `form`. While it holds something,
 * the results take the place of the tabs and the settings (`searching` on the
 * form). A result shows its setting again, in its tab, and marks it.
 */
function bindSettingsSearch(form) {
  const input = form.querySelector('.settings-search-input');
  const status = form.querySelector('.settings-search-status');
  const results = form.querySelector('.settings-search-results');
  const scroller = form.parentElement;
  let found = [];
  let drawn = '';
  const buttons = () => [...results.querySelectorAll('.settings-search-result')];

  function update() {
    const query = input.value.trim();
    // The result with the keyboard focus, if one has it, and its place.
    const focused = buttons().indexOf(document.activeElement);
    const was = found[focused];
    form.classList.toggle('searching', !!query);
    results.hidden = !query;
    const lists = settingsSearchModel.searchSettings(query ? settingsSearchEntries(form) : [], query);
    found = [...lists.titles, ...lists.descriptions];
    const say = settingsSearchModel.searchStatus(query, found.length);
    if (status.textContent !== say) status.textContent = say;
    const html = settingsSearchResultsHtml(lists, query);
    if (html === drawn) return;
    results.innerHTML = drawn = html;
    if (!was || !query) return;
    // Drawn again under the keyboard (a section changed): the focus stays on
    // the same setting, which may have moved down, or else at the same place.
    const same = found.findIndex(e => e.where === was.where && e.title === was.title);
    (buttons()[same >= 0 ? same : Math.min(focused, found.length - 1)] || input).focus();
  }

  function clear() {
    input.value = '';
    update();
    scroller.scrollTop = 0;
  }

  function show({ field }) {
    clear();
    const pane = field.closest('.settings-pane');
    if (pane) {
      const tab = form.querySelector(`.settings-tab[data-tab="${pane.dataset.tab}"]`);
      tab.click();
      // A narrow window's tab bar scrolls sideways: the chosen tab is brought in.
      const own = tab.getBoundingClientRect();
      const bar = tab.parentElement.getBoundingClientRect();
      tab.parentElement.scrollLeft += Math.max(0, own.right - bar.right) + Math.min(0, own.left - bar.left);
    }
    // The page's own scroll only: scrollIntoView would move what is around it too.
    // Centred in what the head leaves of the page; a taller setting starts below the head.
    const head = form.querySelector('.settings-head').offsetHeight;
    const box = field.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    scroller.scrollTop += box.top - view.top - head - Math.max(0, (view.height - head - box.height) / 2);
    // The focus goes to the setting, not its control: Tab reaches that, and a
    // key still held cannot press a button.
    field.tabIndex = -1;
    field.focus({ preventScroll: true });
    clearTimeout(field._foundTimer);
    field.classList.add('settings-field-found');
    field._foundTimer = setTimeout(() => field.classList.remove('settings-field-found'), SETTINGS_SEARCH_FOUND_MS);
  }

  input.addEventListener('input', () => { update(); scroller.scrollTop = 0; });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); clear(); return; }
    if (!found.length) return;
    if (e.key === 'Enter') { e.preventDefault(); show(found[0]); }
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons()[0].focus(); }
  });
  results.addEventListener('click', (e) => {
    const button = e.target.closest('.settings-search-result');
    if (button) show(found[Number(button.dataset.index)]);
  });
  results.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clear(); input.focus(); return; }
    // With a modifier the arrows are the app's (session navigation).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const all = buttons();
    const i = all.indexOf(document.activeElement);
    const next = { ArrowDown: all[i + 1] || all[i], ArrowUp: all[i - 1] || input }[e.key];
    if (i < 0 || !next) return;
    e.preventDefault();
    // Not also for a page behind this one (the Git history's arrows).
    e.stopPropagation();
    next.focus();
  });

  // A section that draws itself, or again, while a search is on.
  const observer = new MutationObserver(() => { if (form.classList.contains('searching')) update(); });
  form.querySelectorAll('.settings-tabs, .settings-pane, .settings-form > .settings-section').forEach((part) => {
    observer.observe(part, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  });
}

if (typeof module !== 'undefined') module.exports = { settingsSearchMark, settingsSearchResultsHtml };
