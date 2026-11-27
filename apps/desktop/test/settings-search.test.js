// settings-search.js — the Settings page's search: title matches first, then
// the settings that need their description, each in the page's order.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { searchSettings, searchStatus, searchWhere } = require('../public/settings-model');
const { settingsSearchMark, settingsSearchResultsHtml } = require('../public/settings-search');

const ENTRIES = [
  { title: 'Accent Color', description: 'The color of buttons, selections and active tabs.', where: 'Application' },
  { title: 'Shell Profile', description: 'Shell used for terminal and Claude sessions.', where: 'Application' },
  { title: 'Terminal Theme', description: 'Color theme for terminal sessions', where: 'Application' },
  { title: 'Terminal Engine', description: 'Where sessions run.', where: 'Application' },
  { title: 'Worktree', description: 'Enable worktree for new sessions', where: 'Agents › Claude CLI Options' },
];
const titles = list => list.map(e => e.title);
const find = query => {
  const found = searchSettings(ENTRIES, query);
  return { titles: titles(found.titles), descriptions: titles(found.descriptions) };
};

test('title matches come apart from, and before, description matches, in the page\'s order', () => {
  assert.deepEqual(find('terminal'), { titles: ['Terminal Theme', 'Terminal Engine'], descriptions: ['Shell Profile'] });
  assert.deepEqual(find('color'), { titles: ['Accent Color'], descriptions: ['Terminal Theme'] });
});

test('a setting that matches in both is listed once, with the titles', () => {
  const found = find('worktree');
  assert.deepEqual(found, { titles: ['Worktree'], descriptions: [] });
});

test('the case does not matter, nor the spaces around', () => {
  assert.deepEqual(find('  TERMINAL  '), find('terminal'));
});

test('every word has to be found, in the title or else with the description\'s help', () => {
  assert.deepEqual(find('engine terminal'), { titles: ['Terminal Engine'], descriptions: [] });
  assert.deepEqual(find('terminal color'), { titles: [], descriptions: ['Terminal Theme'] });
  assert.deepEqual(find('terminal nothing'), { titles: [], descriptions: [] });
});

test('a blank query finds nothing', () => {
  assert.deepEqual(find(''), { titles: [], descriptions: [] });
  assert.deepEqual(find('   '), { titles: [], descriptions: [] });
});

test('the words found are marked, and the text stays text', () => {
  assert.equal(settingsSearchMark('Terminal Theme', 'theme TERM'), '<mark>Term</mark>inal <mark>Theme</mark>');
  assert.equal(settingsSearchMark('themes', 'them hemes'), '<mark>them</mark><mark>es</mark>');
  assert.equal(settingsSearchMark('Run <b> & "x"', 'b'), 'Run &lt;<mark>b</mark>&gt; &amp; &quot;x&quot;');
  assert.equal(settingsSearchMark('Nothing here', 'zzz'), 'Nothing here');
});

test('a result says its tab and section once, and the line above them how many there are', () => {
  assert.equal(searchWhere('Agents', 'Claude CLI Options'), 'Agents › Claude CLI Options');
  assert.equal(searchWhere('Prompt Improver', 'Prompt improver'), 'Prompt Improver');
  assert.equal(searchWhere('', 'Session Launch'), 'Session Launch');
  assert.equal(searchStatus('  ', 0), '');
  assert.equal(searchStatus(' zzz ', 0), 'No setting matches “zzz”.');
  assert.equal(searchStatus('a', 1), '1 setting found');
  assert.equal(searchStatus('a', 4), '4 settings found');
});

test('the results show the title matches first, numbered across the two lists', () => {
  const html = settingsSearchResultsHtml(searchSettings(ENTRIES, 'terminal'), 'terminal');
  const order = ['Found in titles', 'data-index="0"', 'data-index="1"', 'Found in descriptions', 'data-index="2"'].map(s => html.indexOf(s));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `out of order: ${order}`);
  assert.ok(html.indexOf('Shell Profile') > html.indexOf('Found in descriptions'));
});

test('an empty list has no heading, and nothing found has no results', () => {
  const html = settingsSearchResultsHtml(searchSettings(ENTRIES, 'worktree'), 'worktree');
  assert.ok(html.includes('Found in titles'));
  assert.ok(!html.includes('Found in descriptions'));
  assert.equal(settingsSearchResultsHtml(searchSettings(ENTRIES, 'zzz'), 'zzz'), '');
});

test('the page draws the search box, wires it, and loads the search before the panel', () => {
  const panel = fs.readFileSync(path.join(__dirname, '../public/settings-panel.js'), 'utf8');
  assert.match(panel, /class="settings-input settings-search-input"/);
  assert.match(panel, /class="settings-search-results" hidden/);
  assert.match(panel, /bindSettingsSearch\(form\);/);
  const page = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const search = page.indexOf('<script src="settings-search.js">');
  assert.ok(search >= 0 && search < page.indexOf('<script src="settings-panel.js">'));
});
