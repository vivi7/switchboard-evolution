# @switchboard-e/shared

Modules both apps use, written once here:

- `remote-protocol.js`: the phone handshake and encryption.
- `session-config.js`: the options of a new session.
- `plan-parser.js`: `plan-tracker.md` and `todos.md` as data.
- `snooze.js`: snooze times.
- `git-graph-layout.js`: the lanes of the Git graph.
- `git-diff-model.js`, `text-search.js`, `file-icons.js`: staging part of a diff, find and replace, file icons.
- `usage-chart.js`: the Task Manager's memory and disk rings and the status bar's RAM and disk line.
- `file-selection.js`: ticking files in the Files tab and trashing them together.
- `git-change-actions.js`: discarding changes and adding to `.gitignore` from the Git tab's Changes, with the dialog texts.
- `star-tints.js`: the color of each pinned session's star.
- `pinned-order.js`: the order you give the starred projects and each project's pinned sessions by dragging them.
- `donate.js`: the amounts of the donation box and the PayPal page each one opens.
- `knowledge-model.js`: the Node Knowledge tab's view of codebase-memory-mcp's answers (tables, symbols, the trace tree and its layout, impact, architecture, comparison).
- `actions-model.js`: the Git tab's Actions view (states and their words, what started a run, the run search, the job graph from the workflow file, the "Run workflow" fields, log lines).
- `repo-colors.js`: the color of each repository of a project, the same in every view of the Git tab and on both apps.
- `repo-selection.js`: which repositories the Git tab shows (one or several), and how their commits or pull requests merge into one list.
- `action-icons.js`: the icons of the actions that open something (a folder in the app, the file manager, the default application, a window of its own).
- `command-catalog-model.js`: the command catalog of a session (its tabs, the search, what a pick types into the session, when Run is allowed and what it asks first).
- `env-files-model.js`: the `local.env.sh` of a project and of its folders (the name, what a new one holds, and the loading rules the Env tab shows).
- `prompt-improver-model.js`: the prompt improver (its settings and their checks, the improver prompt and its placeholders, the context block the app adds, reading the rewritten prompt from the reply).
- `markdown-links.js`: what a link of a Markdown file points at (a file, a section, the web), and the anchors of its headings.

Each one runs as a classic browser script, a CommonJS module and an ES import, so for now the apps keep a copy:
the desktop in `public/` (and `remote-protocol.js` at its root), the mobile app in `src/shared/vendor/` with the
`.d.ts` files. Change them here, then run `npm run sync-shared` at the repository root; `npm run check-shared` fails
when a copy is out of date.
