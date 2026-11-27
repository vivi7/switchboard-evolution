#!/usr/bin/env node
// Copy the modules in packages/shared into the two apps, which load them as
// plain files for now: the desktop from public/ (a classic script in the
// renderer, a CommonJS module in main) and the mobile app from
// src/shared/vendor/. packages/shared is the only place to change them.
//
//   node scripts/sync-shared.mjs          write the copies
//   node scripts/sync-shared.mjs --check  exit 1 if a copy is out of date

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

// module → where the desktop keeps its copy (the mobile app keeps all of them,
// with their .d.ts, in src/shared/vendor/).
const modules = {
  'remote-protocol.js': 'apps/desktop/remote-protocol.js',
  'session-config.js': 'apps/desktop/public/session-config.js',
  'plan-parser.js': 'apps/desktop/public/plan-parser.js',
  'snooze.js': 'apps/desktop/public/snooze.js',
  'git-graph-layout.js': 'apps/desktop/public/git-graph-layout.js',
  'git-diff-model.js': 'apps/desktop/public/git-diff-model.js',
  'text-search.js': 'apps/desktop/public/text-search.js',
  'file-icons.js': 'apps/desktop/public/file-icons.js',
  'usage-chart.js': 'apps/desktop/public/usage-chart.js',
  'file-selection.js': 'apps/desktop/public/file-selection.js',
  'git-change-actions.js': 'apps/desktop/public/git-change-actions.js',
  'star-tints.js': 'apps/desktop/public/star-tints.js',
  'donate.js': 'apps/desktop/public/donate.js',
  'knowledge-model.js': 'apps/desktop/public/knowledge-model.js',
  'actions-model.js': 'apps/desktop/public/actions-model.js',
  'repo-colors.js': 'apps/desktop/public/repo-colors.js',
  'repo-selection.js': 'apps/desktop/public/repo-selection.js',
  'action-icons.js': 'apps/desktop/public/action-icons.js',
  'pinned-order.js': 'apps/desktop/public/pinned-order.js',
  'command-catalog-model.js': 'apps/desktop/public/command-catalog-model.js',
  'env-files-model.js': 'apps/desktop/public/env-files-model.js',
  'prompt-improver-model.js': 'apps/desktop/public/prompt-improver-model.js',
  'settings-model.js': 'apps/desktop/public/settings-model.js',
  'markdown-links.js': 'apps/desktop/public/markdown-links.js',
};

const header = (file) =>
  `// Copied from packages/shared/${file} by scripts/sync-shared.mjs.\n` +
  `// Do not edit: change it in packages/shared and run npm run sync-shared.\n\n`;

const targets = [];
for (const [file, desktopCopy] of Object.entries(modules)) {
  const source = readFileSync(join(root, 'packages/shared', file), 'utf8');
  targets.push([desktopCopy, header(file) + source]);
  targets.push([`apps/mobile/src/shared/vendor/${file}`, header(file) + source]);
  const types = file.replace(/\.js$/, '.d.ts');
  if (existsSync(join(root, 'packages/shared', types))) {
    targets.push([
      `apps/mobile/src/shared/vendor/${types}`,
      header(types) + readFileSync(join(root, 'packages/shared', types), 'utf8'),
    ]);
  }
}

let stale = 0;
for (const [target, content] of targets) {
  const path = join(root, target);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === content) continue;
  if (check) {
    console.error(`out of date: ${target}`);
    stale++;
  } else {
    writeFileSync(path, content);
    console.log(`packages/shared → ${target}`);
  }
}
if (check && stale) {
  console.error('Run npm run sync-shared and commit the copies.');
  process.exit(1);
}
