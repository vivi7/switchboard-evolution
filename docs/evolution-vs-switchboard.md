# Switchboard Evolution compared with Switchboard

`apps/desktop` started from [Switchboard](https://github.com/doctly/switchboard) by Doctly and still contains all of it: every upstream commit up to `e594fa9` (Switchboard 0.0.37) is in, as is or adapted, and the [Upstream sync](../.github/workflows/upstream-sync.yml) workflow brings in the later ones. This page lists what Switchboard Evolution adds on top, as of version 1.21.0 (November 2026).

## At a glance

| | |
|---|---|
| Features and fixes of its own | about 120 |
| Window ↔ main process channels (IPC) | 169, of which **71 exist only in Evolution** (upstream has 98) |
| Methods a phone can call | 130 (upstream has no phone access) |
| Desktop test files | over 100 (upstream has 50) |
| Mobile app | 27 screens, 47 test files |
| Offered upstream | 3 merged pull requests, 8 open (see [Upstream](../README.md#upstream)) |

To see the size of the difference today, from the root of this repository:

```bash
git diff --shortstat e594fa9 HEAD:apps/desktop
```

## The name

| When | Name | What happened |
|---|---|---|
| 30 Sep 2026 | (a branch of the fork) | First work: the full Git Graph inside a project tab. |
| 1–4 Nov | Fork 1.x | Phone access, Internet tunnels, a version of its own, kept in step with the mobile app. |
| 13 Nov | OmniboardV 1.5.0 to 1.6.5 | An app of its own: own name, app id and icon. It installs next to the official Switchboard. |
| 16 Nov | **Switchboard Evolution** 1.6.6 | The final name, and this monorepo with the desktop and the mobile app. |
| 20 Nov | Switchboard Evolution 1.7.0 | One version for the desktop and the phone app, and the repository goes public. |
| 20 Nov | Switchboard Evolution 1.8.0 | A Note for each project, text size in the editor, the RAM of each session on its row, and tabs in a project's window. |
| 21 Nov | Switchboard Evolution 1.9.0 | New icons for both apps: the computer's terminal with the phone in front of it. In the phone's Files tab, upload several files from the phone, and download several ticked files and folders at once. |
| 22 Nov | Switchboard Evolution 1.9.1 | OpenCode as the third CLI, beside Claude Code and Codex, on the desktop and the phone. A project's plan and its todos on two tabs of their own. |
| 22 Nov | Switchboard Evolution 1.10.0 | The sidebar's Agent Files tab becomes Files: drop any file on the sidebar to open it there or in a window of its own, and pin files at the top. |
| 23 Nov | Switchboard Evolution 1.11.0 | A Pull Requests view in the Git tab, on the desktop and the phone: every open pull request with its files and diffs, merge, draft, ready and close. The app carries the GitHub CLI for a computer without one. |
| 23 Nov | Switchboard Evolution 1.12.0 | A pull request's files as a tree, every diff closed. Before Merge, four icons copy its address and open its page on GitHub inside the app, in a panel or a window of its own, or in the browser, on the desktop and the phone. |
| 23 Nov | Switchboard Evolution 1.14.0 | The Node Knowledge tab: the project's repositories as code graphs with codebase-memory-mcp (architecture, search, call traces, the impact of a change, Cypher queries, decision records, coverage, the 3D Lens), and the graph's tools in the project's agent sessions. An open pull request shown as GitHub does: Conversation, Commits, Checks and Files changed, and changed from there, on the desktop and the phone. |
| 23 Nov | Switchboard Evolution 1.14.1 | The Plans tab groups its plans by project, folder or date, filters them by project, folder, date or session, and sorts them by edit, creation or title. A session row in the Projects tab can be forked, and the Task Manager and Global settings tabs light up like the others. |
| 24 Nov | Switchboard Evolution 1.15.0 | An Actions view in the Git tab, as on GitHub, on the desktop and the phone: the workflows and their runs with filters, Run workflow with its inputs, a run's jobs graph, annotations and artifacts, each job's steps and logs, re-run, cancel and delete, and Caches, Runners and Deployments. A worktree in a project with the code graph on gets a graph of its own, and new projects start with the code graph on. |
| 24 Nov | Switchboard Evolution 1.15.1 | A star on each project of the sidebar's Projects tab: starred projects get a section of their own above Active, on the desktop and the phone. |
| 25 Nov | Switchboard Evolution 1.16.0 | Several repositories at once in the Git tab: History as one table of their commits by date with a Repository column, Pull Requests as one list with each repository's name after the number, and Worktrees filtered by repository, each repository in its own color, on the desktop and the phone. The Git tab opens on History, the branch each repository is on shows in its toolbar, the project header gives the folder chips the whole width, and opening a folder, the file manager, a default application or a window each have their own icon. |
| 25 Nov | Switchboard Evolution 1.17.0 | One editor everywhere a file or a piece of code is shown or edited, with VS Code's find and replace (find in selection, preserve case, history, several lines, Alt+Enter, the matches on the scrollbar), F3 and Cmd+G for the next match, Ctrl+G for a line, Go to Symbol, closing brackets, suggestions, indentation guides, commands on lines and case, a right-click menu and a status bar. Cmd/Ctrl+F always reaches it, in a Markdown or JSON preview too; a CRLF file stays CRLF; unsaved changes show a dot, are asked about before another file opens, and are never overwritten by a change on disk. |
| 25 Nov | Switchboard Evolution 1.17.1 | On the phone, a commit's details in History start after the lines beside it and take the screen's width when the graph leaves them little room, scrolling into sight; a pull request's diffs show their code in the editor's colours, on their green and red lines. |
| 25 Nov | Switchboard Evolution 1.18.0 | A Commands palette in the terminal (Cmd/Ctrl+Shift+K) and a "/" button in the phone's composers, with what the session's CLI understands: its slash commands and flags, skills, commands and MCP servers. In the editor: a minimap, sticky scroll, the computer's language servers chosen per project (hover, errors, suggestions, Go to Definition, Rename), formatting, Vim and more languages; find and replace in the phone's editor. Node Knowledge gives every file one graph: the project folder is a graph of its own, no folder is indexed twice, nested modules can be attached, and Coverage says all that was left out. In the Sessions tab a session names its project and opens on that project's Session tab, on the desktop and the phone, whose pull request diffs colour Shell, TOML, Dockerfile, Diff and SQL too. |
| 25 Nov | Switchboard Evolution 1.18.1 | A session's row reads alike on the desktop and the phone, on three lines: its title and star; its project, its folder in a list without folder headers, and what the live session uses at the right; its CLI, status, age, messages and buttons. The phone's Projects tab shows what each session uses too. The Commands palette has a pin that keeps it open in the page and a button that opens it in a window of its own, on the desktop and the phone. |
| 26 Nov | Switchboard Evolution 1.18.2 | The phone's project Overview lists its sessions with the rows of the project's drawer, as the desktop's track cards do: the title and star, then the state, the CLI, the age, the messages and what the session uses. The desktop carries gh 2.106.0. |
| 26 Nov | Switchboard Evolution 1.19.0 | The Env tab, on the desktop and the phone: every project has a `local.env.sh` in its project folder, and each attached folder can have one. Before a session or a terminal starts, its shell sources them after the user's own startup files: in the project folder only the project's, in an attached folder the project's and then the folder's, so the folder wins. |
| 26 Nov | Switchboard Evolution 1.19.1 | In the desktop's Pull Requests view, a text file that GitHub takes for binary (one with a NUL byte, as a prompt template that uses NULs as delimiters) shows its diff: the app reads its two versions from GitHub and compares them, each NUL shown as ␀. |
| 26 Nov | Switchboard Evolution 1.20.0 | A prompt improver beside Commands (Cmd/Ctrl+Shift+P) and after "/" in the phone's composers: the prompt being written to a session's CLI is rewritten by that CLI, run once and out of sight on the user's own subscription with no API key, with the session's last turns and its commands, skills and MCP servers and how to call them. On the desktop it is read from the CLI's input box and put back in its place, never sent; on the phone it takes the field's place, with Undo. The rewriting instructions are editable in Settings, on the desktop and the phone. |
| 27 Nov | Switchboard Evolution 1.20.1 | The desktop's Improve prompt window says which session the prompt goes into and stays tied to it: Expand makes it nearly as large as the app's window, and it opens in a window of its own, from which Insert and Replace still go into that session, even after switching to another one, and the main window then shows it. |
| 27 Nov | Switchboard Evolution 1.21.0 | Settings in tabs, alike on the desktop and the phone: Application (with Updates and Support), Agents, Editor, Node Knowledge and Prompt Improver, and every setting is saved as it changes, with no Save button. The phone's Settings opens on a Computer tab with the pairing, then has the desktop's tabs and changes the computer's settings, codebase-memory-mcp's included; a change made on one shows on the other. The improver's instruction to look for a fitting command, skill or MCP server is part of its fixed prompt, no longer of the editable one. |

What "an app of its own" means:

- App id `io.github.vivi7.switchboard-e`, installed as `Switchboard Evolution.app`. Phones pair through the `switchboard-e://` scheme.
- It runs next to the official Switchboard. Both can be open at once and share `~/.switchboard` (projects, session index), while their window settings stay apart.
- It has no auto-update feed, so an official release never replaces it.
- Its version is its own (1.21.0, the same for the desktop and the phone app), far from upstream's 0.0.x. Upstream's build workflow exists only on `main`, so a tag on `master` never starts it.
- At its first start it copies OmniboardV's settings.

## What it adds, by area

### 1. The phone as a second seat (mobile app and remote access)

- A remote-access server with an encrypted protocol (tweetnacl). Pairing uses a QR code that works once and for two minutes. Paired devices are listed with their state and can be removed.
- The phone sees and drives terminals: it starts Claude, Codex or OpenCode sessions, types, fits the terminal to its screen, attaches files and photos, and reads the tail of a long conversation.
- Unread and needs-you marks are shared between window and phone. A session open on the phone counts as seen.
- Projects, plans, todos, schedules and files work from the phone: upload, rename, trash, a safe save that refuses if the file changed meanwhile, and download of any file.
- The phone's file editor has find and replace as the desktop's find bar (case, whole word, regular expression, Preserve Case, Replace and Replace All), in a file, a Git diff being edited and the project's note; the Files tab's search and replace keeps the case of each match too.
- The Git Graph with all its actions, worktrees, pull requests, GitHub Actions, project tasks, the Task Manager, search and replace, and staging also work from the phone.
- IDE diffs can be answered from the phone. The first answer wins, and the window says the phone answered.
- Internet access goes through Cloudflare or ngrok tunnels, set up from the devices dialog. Secrets are encrypted with the system keychain, and only a phone holding the access key gets in through a tunnel.
- With remote access on, closing the window only hides it and sessions keep running. The computer stays awake while a session works.
- The phone's Settings page has the same tabs as the desktop's Global Settings (Application, Agents, Editor, Node Knowledge, Prompt Improver), after a Computer tab with the pairing details. Each change is saved on the computer as it is made, and an open Settings page on the desktop shows it at once. That includes the Pre-launch Command, the Projects Folder, the default permission mode and the sandbox, which a paired phone could already reach by typing into a terminal or starting a session. The Lens, choosing or downloading the codebase-memory-mcp program, its installer for the agents and Check for Updates stay on the desktop.

### 2. Sessions that survive quitting

- The **herdr-core** terminal engine: sessions keep running when the app quits and re-attach at the next start. It is chosen in Settings ("Terminal Engine").
- "Quit and Stop All Sessions…" stops everything when you want to. A note says when a kept session lost its IDE server.
- The Claude session Switchboard Evolution was started from stays out of new sessions.

### 3. Git

- **History is a full Git Graph**, on par with the VS Code Git Graph extension:
  - menus for commits, local and remote branches, tags and stashes
  - checkout, cherry-pick, revert, drop, merge, rebase (interactive in a terminal too), reset, zip/tar archives
  - remotes (add, edit, delete, fetch with prune) and user details
  - repository settings and global preferences
  - avatars, issue links and Markdown in messages
  - commit details under the row or beside the graph, with a Code Review mode
  - every action runs through one whitelisted dispatcher, shows a spinner and can be retried after a failure
- **Compare 2–4 commits** step by step (A→B, B→C, …), in a popup or a window of its own, with a tree view and commit titles.
- **Staging** of files, folders, single hunks or chosen lines. A diff that changed meanwhile is refused and reloaded.
- One tab per repository of the project, in Changes and History, with the repository path under the tab.
- **Worktrees**:
  - a list with state, ahead/behind and running sessions
  - a guided New worktree (new, existing or remote branch, folder, local files to copy, a command after creating)
  - Lock, Move, Repair, Prune, "Remove merged…"
  - new sessions started right in a worktree
- **Pull Requests**, through the GitHub CLI (`gh`): the one installed on the computer, or the one every build carries when there is none:
  - one tab per repository; every open pull request, drafts too, newest first
  - a filter for Open, Draft, Closed and Merged; closed and merged ones 10 at a time
  - an open row shows the pull request as GitHub does, in four tabs: Conversation (the description and every comment and review, review threads, events, reactions, the reviewers, assignees and labels), Commits, Checks (with a finished job's log) and Files changed (with Viewed)
  - the title edited in place; the description, comments and replies written, edited, hidden or deleted where GitHub allows; conversations resolved; reviews (Comment, Approve, Request changes); reviewers, assignees and labels changed; the branch updated with its base; failed jobs run again
  - Merge (the repository's merge methods, the branch deleted on GitHub if you want), Convert to draft, Ready for review, Change base, Close and Reopen, each asked first; the local checkout is never touched
  - the same on the phone, on a screen of its own
- **Actions**, GitHub Actions as GitHub's own Actions tab shows it, through the same `gh`:
  - the workflows and Management (caches, deployments, the repository's self-hosted runners; attestations and metrics open GitHub's page in the app)
  - the runs, filtered with GitHub's qualifiers (`is:failure branch:main`…) and the Event, Status, Branch and Actor menus, read again every 30 seconds
  - Run workflow with the workflow's inputs, Re-run (all, failed, one job, with debug logging), Cancel, Delete, Disable and Enable, a status badge
  - a run's page: what started it, the graph of its jobs, annotations, artifacts, the deployments waiting for a review (Approve, Reject), its usage and workflow file
  - a job's steps and their logs as each step finishes, folded groups, search, timestamps, downloads, and GitHub's live log for the step running now
  - "Open in Actions" from a pull request's checks
  - the same on the phone

### 4. Files

- An explorer for the project folder and each attached folder:
  - VS Code-style actions and shortcuts: new, duplicate, copy, cut, paste, rename, trash, copy path
  - Open to the Side, Open With…, a file's commit Timeline, and comparing two files
  - "Add file to Chat" hands a file to a session
- File-type icons from Material Icon Theme, in the Git lists too.
- A project-wide **Search** view (case, whole word, regex, include and exclude globs). **Replace** works in one file or all files, with a preview, and keeps open editor edits safe.
- Find and replace in the editor (CodeMirror). The editor bundles only the languages it highlights: 1.67 MB down to 0.98 MB.
- One editor everywhere a file or a piece of code is shown or edited (`public/editor/`, `createCodeEditor`), with VS Code's find widget (find in selection, preserve case, history, several lines, Alt+Enter, the matches on the scrollbar, `\U$1` in a replacement), Cmd+G and F3, Ctrl+G for a line, Go to Symbol, closing brackets, suggestions, indentation guides, commands on lines and case, a right-click menu and a status bar. A CRLF file stays CRLF; unsaved changes show a dot, are asked about before a file closes, and are never overwritten by a change on disk (Reload, Keep Mine, Compare).
- Several files open at once, each in a tab (the project's Files tab, with a set for each project, the sidebar's Files tab, a session's side panel), with short labels that add folders and the project only to tell files of one name apart. Unsaved text is kept in the app's data folder as you type and comes back after switching page, closing or restarting.
- In the same editor: a minimap with the find bar's matches and a diff's changes, sticky scroll, column selection from the keyboard (Shift+Alt+Cmd+Arrows), the language servers installed on the computer chosen per project, with one switch for the whole app in Settings › Editor (hover, errors, suggestions, Go to Definition with Go Back, Rename also in files not open), Go to Definition through the code graph without a server, Format Document and Format Selection (the project's Prettier, else the app's, else the language server's), an optional Vim mode, JSON and YAML syntax errors, and 28 more languages coloured (PHP, C#, Ruby, SCSS and Sass, Less, Vue, Svelte, Liquid, Jinja, Elixir, Terraform and Zig with their own grammar; Kotlin, Swift, Dart, Lua, Haskell, F#, R, Julia and others with a legacy mode), on the phone too. The bundle is 1.16 MB; Vim (125 KB), the language-server client (30 KB), the legacy modes (78 KB) and each grammar (5 to 150 KB) are bundles of their own, loaded the first time they are needed. The phone's editor page carries the legacy modes (1084 KB, from 972); the app puts a grammar in the page when a file of it is shown.
- Multi-select with one-step trash; Expand All and Collapse All.
- In the viewer toolbar: Share (the macOS share menu), Reveal in Finder, Open in default app, and A− / A+ for the text size of the editor and the Markdown preview (on the phone too).
- The sidebar's **Files** tab (Agent Files upstream): the agent files and any file dropped on the sidebar from any tab. The drop zone has two halves: open the file here, in the tab's editor, or in a window of its own. A filter shows All, Agent files or Opened files; any file can be pinned with a star, which keeps it at the top of its project's group (files of no project in a Pinned group), in an order changed by dragging, in sight with every filter. A project's group can be pinned above the others, in an order changed by dragging too, and several files selected with Ctrl/Cmd+click or Shift+click open together. Every file open in the app is listed until closed: together under Opened in All files, with its project's name, pinned ones first in your order, then sorted by project then file, and grouped by project under Opened files. An opened file can be taken off the list.

### 5. Projects and sessions

- Each project has a drawer with its sessions, grouped by time, track or state. A **Session** tab holds a terminal, a transcript or a task log under the project header.
- Numbers on each project row: plan done/total, open todos, tracks, sessions.
- Search in the Projects tab finds sessions too. A "No project" row gathers sessions no project claims. An X leaves a result out of the search, and "Stop n running" stops the sessions found.
- Rename from the session menu; a live terminal keeps its name and star across refreshes.
- A **Prompt improver** next to Commands (Cmd/Ctrl+Shift+P) and after "/" on the phone: the prompt being written, read from the CLI's input box, is rewritten by the session's CLI (Claude Code, Codex or OpenCode) run once and out of sight on the user's own subscription, with the session's last turns and its commands, skills and MCP servers; the result replaces the prompt, nothing is sent, and no session is left behind. The rewriting instructions are editable in Settings on the desktop and the phone.
- A **Commands** palette in the terminal header (Cmd/Ctrl+Shift+K) and a "/" button in the phone's composers list what the session's CLI understands: Claude Code's, Codex's or OpenCode's built-in slash commands and flags (read from their docs, refreshed once a day), the user's, the project's and the plugins' skills and commands, MCP servers, keyboard shortcuts. A pick types the command without Enter; Run, for one with no required argument, presses Enter too and asks first for the ones that end the session or replace the conversation. On the phone, typing `/` (or `$`, `@` for Codex's and OpenCode's skills) in a composer suggests the commands that complete it.
- Attached folders can be detached from the Overview card (with an offer to remove the worktree) and trusted for Claude Code once.
- At start, the project of the reopened session opens.
- A **Note** for each project (its `note.md`, made empty when first opened), from the project's header and menu: the file editor in a panel floating over the app, moved and resized, that opens again where it was left and saves itself as you type. It can move to a window of its own (on the phone: a DeX or tablet window).
- An **Env** tab before Settings, on the desktop and the phone: the `local.env.sh` of the project folder (every project starts with one) and of each attached folder (made with +), edited in place, with the rules of what loads where. Before a session or a terminal starts, its shell sources them after the user's own startup files: in the project folder only the project's file, in an attached folder the project's and then the folder's, so the folder wins. A file Git would commit is flagged, with "Ignore in this clone" (`.git/info/exclude`).

### 6. Task Manager and resources

- A Task Manager with the RAM each session and task uses, and the processes inside them, with Kill and Force kill. Memory and disk rings show the space each project takes.
- RAM and disk in the status bar, turning amber and then red near their limits.
- Each live session's RAM on its row, under its star and archive button, amber from 1 GB and red from 2 GB as in the Task Manager.

### 7. Windows

- Global Settings is a bar of tabs (Application, Agents, Editor, Node Knowledge, Prompt Improver) and every setting is saved as it changes, with a short "Saved" beside it, a refused value showing its error and going back to the saved one, and a Close button in place of Save Settings and Cancel. Folder Settings save as they change too. The editor's preferences (minimap, sticky scroll, whitespace, Vim, language servers) are the same in every window and on the phone.
- One strip of sidebar tabs: Projects, Sessions, Plans, Files, Stats, Task Manager, Settings.
- Stats and the Task Manager open in windows of their own, with a pin that keeps them on top.
- Every project tab (Overview, Plan, Todos, Files, Git, Settings) can open in a window of its own, whose header has the other tabs to move it to one of them (on the phone too). Open windows come back at the next start.

### 8. Under the hood

- One broadcaster for main-process events serves both the window and the phones.
- Indexing, transcript reading and file search run in workers, off the main thread.
- The auto-updater turns off in builds without an update feed. Settings migrate between app names.

## Coming next

A new interface (React, TypeScript, Vite), a new brand, light and dark themes, and a data folder of its own with an import from Switchboard. [parity.md](parity.md) lists the features, over 300, that the redesign must keep.

## Offered upstream

| Pull request | State | What it brings |
|---|---|---|
| [#98](https://github.com/doctly/switchboard/pull/98) | merged | List/tree toggle in the Git tab's Changes |
| [#99](https://github.com/doctly/switchboard/pull/99) | merged | Read-only repository history in the Git tab |
| [#109](https://github.com/doctly/switchboard/pull/109) | merged | The window no longer slides up under the title bar |
| [#105](https://github.com/doctly/switchboard/pull/105) | open | Reveal in Finder in the file viewer |
| [#106](https://github.com/doctly/switchboard/pull/106) | open | Rename in the session menu |
| [#107](https://github.com/doctly/switchboard/pull/107) | open | Worktrees tab |
| [#108](https://github.com/doctly/switchboard/pull/108) | open | Detach attached folders from the Overview card |
| [#110](https://github.com/doctly/switchboard/pull/110) | open | A commit's details under its row in History |
| [#111](https://github.com/doctly/switchboard/pull/111) | open | Keep the session Switchboard was started from out of new sessions |
| [#112](https://github.com/doctly/switchboard/pull/112) | open | Share button in the file viewer |
| [#113](https://github.com/doctly/switchboard/pull/113) | open | Task Manager with each session's RAM |

Not offered yet: phone access and the mobile app, herdr-core, the Git Graph actions, the Files explorer with search and replace, staging, commit compare, separate windows, the resource bar.
