const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdownLink, headingSlug, headingSlugs } = require('../public/markdown-links');

test('a path in a link is a file, decoded, with its section apart', () => {
  const file = (href) => parseMarkdownLink(href);
  assert.deepEqual(file('setup-script.md'), { kind: 'file', path: 'setup-script.md', anchor: '' });
  assert.deepEqual(file('docs/my%20file.md'), { kind: 'file', path: 'docs/my file.md', anchor: '' });
  assert.deepEqual(file('../guide.md#the-cluster'), { kind: 'file', path: '../guide.md', anchor: 'the-cluster' });
  assert.deepEqual(file('report%231.md'), { kind: 'file', path: 'report#1.md', anchor: '' });
  assert.deepEqual(file('docs/'), { kind: 'file', path: 'docs/', anchor: '' });
});

test('a link to a line keeps the line in its path', () => {
  assert.equal(parseMarkdownLink('src/app.js#L12-L30').path, 'src/app.js#L12-L30');
  assert.equal(parseMarkdownLink('src/app.js#L12-L30').anchor, '');
  assert.equal(parseMarkdownLink('src/app.js:12:5').path, 'src/app.js:12:5');
  assert.equal(parseMarkdownLink('README.md:3').path, 'README.md:3');
});

test('file URLs are local paths; another computer\'s is nothing', () => {
  assert.equal(parseMarkdownLink('file:///Users/me/My%20Plan.md').path, '/Users/me/My Plan.md');
  assert.equal(parseMarkdownLink('file://localhost/tmp/a.md').path, '/tmp/a.md');
  assert.equal(parseMarkdownLink('file:///C:/work/a.md').path, 'C:/work/a.md');
  assert.equal(parseMarkdownLink('C:/work/a.md').path, 'C:/work/a.md');
  assert.deepEqual(parseMarkdownLink('file://server/share/a.md'), { kind: 'none' });
});

test('sections, web addresses and empty links', () => {
  assert.deepEqual(parseMarkdownLink('#2-set%C3%A9'), { kind: 'anchor', anchor: '2-seté' });
  for (const url of ['https://example.com/a.md#x', 'mailto:a@b.c', 'vscode://file/a', '//example.com/a', 'javascript:alert(1)']) {
    assert.deepEqual(parseMarkdownLink(url), { kind: 'external', url });
  }
  for (const empty of ['', '  ', undefined]) assert.deepEqual(parseMarkdownLink(empty), { kind: 'none' });
});

test('headings get the anchors GitHub gives them', () => {
  assert.equal(headingSlug('1. Generate the password'), '1-generate-the-password');
  assert.equal(headingSlug('The example.test cluster'), 'the-exampletest-cluster');
  assert.equal(headingSlug('Città: `a_b` & co'), 'città-a_b--co');
  assert.deepEqual(headingSlugs(['Setup', 'Setup', 'setup-1', 'Setup']), ['setup', 'setup-1', 'setup-1-1', 'setup-2']);
});
