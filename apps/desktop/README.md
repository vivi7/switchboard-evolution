> **Switchboard Evolution note.** This README is upstream Switchboard's, which this app is derived from: for Switchboard Evolution, start from the [README at the root of the repository](../../README.md). The release downloads and the Slack community linked below are Doctly's, for the official app. This page will be rewritten for Switchboard Evolution.

# Switchboard

Your command center for CLI coding sessions.

Switchboard is a desktop app that puts every Claude Code, Codex and OpenCode session, across every project, in one window. Launch, resume, fork, and monitor sessions without juggling terminal tabs or digging through `~/.claude/projects` and `~/.codex/sessions` for that one conversation from last week.

![Switchboard](build/screenshot.png)

**[Download the latest release](https://github.com/doctly/switchboard/releases/latest)** · **[Join the Slack community](https://join.slack.com/t/doctly-ai/shared_invite/zt-4948uf70i-_WeI229ehttWfvjWvGxl3Q)**

## Contents

- [Install](#install)
- [Supported CLIs](#supported-clis)
- [Features at a glance](#features-at-a-glance)
- [Sessions](#sessions)
- [Projects](#projects)
- [Project Tasks and Server Logs](#project-tasks-and-server-logs)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Development](#development)
- [Further reading](#further-reading)

## Install

Grab the release for your platform from the [releases page](https://github.com/doctly/switchboard/releases/latest):

| Platform | Package |
|---|---|
| macOS | `.dmg` (Apple Silicon and Intel) |
| Windows | `.exe` installer |
| Linux | `.AppImage`, `.deb`, or `.pacman` (Arch/Manjaro) |

On Arch the package is named **`switchboard-doctly`**. The app is still called Switchboard everywhere you see it. Uninstall with `sudo pacman -R switchboard-doctly`.

Packaged builds check GitHub Releases for updates on launch and every 4 hours, download in the background, and show a toast when an update is ready. Restart to install immediately, or dismiss and it installs on next quit. To build from source instead, see [Development](#development).

In a terminal, `-h` or `--help` lists the program's options and `-v` or `--version` prints its version, for example `switchboard-e --version` on Linux. Neither opens the app.

## Supported CLIs

| | Claude Code (`claude`) | Codex (`codex`) | OpenCode (`opencode`) |
|---|---|---|---|
| Browse and search history | ✅ | ✅ | ✅ |
| Resume a session | ✅ | ✅ | ✅ |
| Start a new session | ✅ | ✅ | ✅ |
| Fork a session | ✅ | ✅ | — |
| Read in the message viewer | ✅ | ✅ | ✅ |
| Status and activity indicators | ✅ | ✅ | ✅ |
| Session names from `/rename` | ✅ | — | ✅ (OpenCode's own titles) |
| IDE emulation (diff review) | ✅ | — | — |
| Plans and memory files | ✅ | — | — |

Sessions from all the CLIs share one sidebar, each row marked with its CLI's logo. A fork runs on the CLI that wrote the session being forked.

OpenCode means OpenCode 2.x. It keeps its sessions in one database rather than a file each (`~/.local/share/opencode/opencode.db`, or what `OPENCODE_DB` names), which Switchboard reads without writing to it. Its working and waiting states come from the status reports its terminal interface sends.

Turn any CLI off under **CLI Agents** in Settings. A switched-off CLI is not scanned, not watched, and not offered when you start a session, and its sessions are hidden. Its history is kept, so switching it back on restores everything immediately. At least one CLI always stays on.

## Features at a glance

- **Session browser** — Every session from every supported CLI, organized by folder, searchable by content.
- **Fork and resume** — Branch off from any point in a session's history.
- **Built-in terminal** — Connect to running sessions or launch new ones without leaving the app. `Ctrl` + mouse wheel (or `Cmd` + wheel on macOS, or a touchpad pinch) makes the terminals' text larger or smaller, apart from the app's own zoom in the View menu.
- **Status notifications** — In-app alerts when a session is waiting for permission approval or user input.
- **Session grid** — Live terminals for all open sessions on one screen.
- **Prompt improver** — A button next to Commands in a session's terminal (Cmd/Ctrl+Shift+P) reads the prompt you are typing to the CLI, has it rewritten with the commands, skills and MCP servers the session has, and puts the result back in its place (or inserts or copies it); nothing is sent. It runs the CLI you are signed in to (`claude -p`, `codex exec --ephemeral`, `opencode run`) once and out of sight, on your subscription, with no API key, and leaves no session behind. The window says which session the prompt goes into and stays tied to it: Expand it, or open it in a window of its own, and Insert or Replace still go there even after you switch to another session. The rewriting instructions are yours to edit in Settings › Prompt improver; the phone has the same button beside "/".
- **Per-CLI launch options** — Permission mode, worktree, sandbox, approval policy, model, and effort, set per session, per project, or globally.
- **IDE emulation** (Claude only) — Review and edit Claude's proposed diffs in a side panel before they land.
- **Projects** — Group work by what it is, not where it lives: a folder on disk, a brief the agent reads, a plan, a todo list, and the sessions filed under it.
- **Worktrees tab** — Every git worktree of a project's repositories in one list: create, open, lock, move, prune, and remove them, and start a session in any of them.
- **Pull Requests and Actions** — In the Git tab, through the GitHub CLI: pull requests as GitHub shows them, and GitHub Actions as its Actions tab does (workflows, runs, the job graph, logs as each step finishes, Run workflow, re-run, cancel, deployments to review, caches, runners).
- **Node Knowledge tab** — The project's repositories as code graphs ([codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)): architecture, search, call traces, the impact of a change, Cypher queries, decision records, coverage, the 3D Lens, and the graph's tools in the project's agent sessions.
- **Project tasks and server logs** — Run `.vscode/tasks.json` commands and keep their logs beside your sessions.
- **Scheduled tasks** — Start a session with a prompt on a timer, in a project, a track, or any folder.
- **Plans and memory** (Claude only) — Browse and edit plan files and `CLAUDE.md` in one place. Plans can be grouped by project, folder or date, filtered by project, folder, date or session, and sorted by edit date, creation date or title.
- **Activity stats** — Heatmap of your coding activity across all projects.

## Sessions

The **Sessions** tab lists every session grouped by the folder it runs in. Full-text search finds a session by what was discussed, not just when it happened. Any session can be resumed, forked from any point in its history, or read in the message viewer.

### Launch options

Each CLI exposes its own options when you start or resume a session:

| CLI | Options |
|---|---|
| Claude Code | Permission mode, worktree, Chrome, model, effort |
| Codex | Sandbox policy, approval policy, model, reasoning effort |
| OpenCode | Auto-approve permissions (`--auto`); the model is chosen in OpenCode |

Set them per session, per project, or globally in Settings. Model and effort are chosen per session or per schedule (Codex's model can also be set in Settings); left blank, each CLI uses its own default.

The optional settings (model, effort, allowed tools, additional system prompt, pre-launch command, and additional directories) sit under **More options**, and show on their own once they have a value. Codex's reasoning effort is limited to what the chosen model supports, read from Codex's own model list: choosing a model that does not support the current effort sets it back to Default.

### Scheduled tasks

A scheduled task starts a session with a prompt on a timer: every 15 or 30 minutes, every hour, every day, on weekdays, or every week. Create one with **New scheduled task…** from a project's right-click menu, the **Schedules** button on a project's page, or the clock on a folder in the Sessions tab. Each task's menu shows when it runs next and can edit it, run it now, turn it off, or delete it. Sessions a schedule started are marked with a clock.

Schedules use the same CLI-specific configuration form as **New Session → Configure**. Choose **Use folder defaults** to follow the current settings at each run, or **Customize** to save individual overrides. Each customized field can be reset to its folder default, and Claude and Codex choices are kept separately when switching CLIs.

Legacy schedule imports keep permission mode, allowed tools, additional directories, appended system instructions, and the model, with the old runner's defaults saved explicitly. Budget is intentionally omitted, and effort is left unset. Successfully imported schedules are left alone on later scans.

For Project View schedules, defaults come from the track's starting folder, then the project's default starting folder, then the Switchboard project folder. The schedule dialog shows the resolved folder. Attached project folders are supplied automatically; additional directories in the form are optional extras.

### Status notifications

Switchboard watches every session in the background, whichever CLI runs it, and shows status in the sidebar so you can tell at a glance which sessions need attention while you work in a different one.

![Status Notifications](build/screenshot-notifications.png)

- **Waiting for input** — A session that needs your response is highlighted.
- **Permission approval** — A session blocked on a permission grant or approval gets a badge immediately. Switchboard reads each CLI's own wording, so Claude's permission prompts, Codex's approval requests and OpenCode's permission and question prompts all register.
- **Activity indicators** — See which sessions are running, idle, or finished.

### Session grid

Toggle the grid from the sidebar for a bird's-eye view of all open sessions, grouped by project.

![Session Grid Overview](build/screenshot-grid.png)

- **Live terminals** — Every open session renders its full terminal in a card, whichever CLI it runs.
- **Status at a glance** — Each card shows a running/stopped/busy dot and last-activity time.
- **Click to focus, double-click to expand** — Click a card header to focus it. Double-click to return to the single-terminal view for that session.
- **Persistent** — The grid preference survives restarts.

### IDE emulation and file preview (Claude only)

Switchboard can act as an IDE for Claude Code. It speaks Claude CLI's own IDE protocol, so Codex sessions launch without it. When enabled, Claude's file opens and proposed edits appear in a side panel next to the terminal instead of going to an external editor.

![IDE Emulation](build/screenshot-ide.png)

- **Diff review** — A proposed change shows up as a diff. Accept or reject it in place.
- **Inline and side-by-side** — Toggle between unified and side-by-side views. The choice is remembered.
- **Partial acceptance** — In inline mode, accept or reject individual chunks, then submit the result.
- **File viewer** — Clickable file links in terminal output (OSC 8 hyperlinks) open in the side panel. Code gets syntax highlighting; images, PDFs, and PowerPoint decks open as previews; HTML opens in a sandboxed preview; and JSON and JSONC files open as a collapsible tree that keeps key order, exact numbers, and duplicate keys, with a jump to the line where a broken file goes wrong.

To let Claude use VS Code, Cursor, or another editor instead, uncheck **IDE Emulation** in **Global Settings**. Switchboard then stops registering as an IDE and Claude CLI discovers your real editor. The change applies to new sessions only.

## Projects

The Sessions tab groups sessions by the folder they run in. The **Projects** tab groups them by the work they belong to.

| | What it is |
|---|---|
| **Project** | A piece of work with a folder on disk. Everything else about it is optional. |
| **Track** | A line of effort inside a project, with its own sessions. Optional. |
| **Session** | A session as it is today, plus the project it belongs to. |
| **Folder** | What the Sessions tab shows: a path on disk. A project can attach any number. |

![Project View overview](build/project-view-overview.png)

### The project folder and brief

Every project gets a real folder under `~/Switchboard/` (change it under **Projects Folder** in Global Settings). Switchboard writes a starter brief into `CLAUDE.md` and `AGENTS.md` there. The brief tells the agent where the project's files go, and the agent creates them when it first needs them:

| File | Purpose |
|---|---|
| `plan.md` | The plan, in whatever form fits the work |
| `plan-tracker.md` | Phases with checkboxes, so Switchboard can show progress |
| `todos.md` | Follow-ups and ideas |
| `memory.md` | Anything worth remembering across sessions |

None of these is read at the start of a session, only when the plan or the todos come up. The brief also lists the attached folders and tells the agent to read each folder's own instructions before changing files there. Attaching or detaching a folder updates that list. The rest of the brief is yours to edit.

### Where sessions start

Sessions start in the project folder by default. A project or a track can choose an attached folder instead. Wherever a project session starts, Switchboard passes the project folder and every attached folder to the CLI as extra directories, so the agent can read and edit all of them.

The CLIs handle this differently:

- **Claude** loads the `CLAUDE.md` from each of those directories.
- **Codex** only reads `AGENTS.md` from the folder it starts in, so a Codex session that starts in an attached folder does not see the project brief. Codex also refuses extra directories unless its sandbox is `workspace-write` or `danger-full-access`, so Switchboard's global default for Codex is `workspace-write`. Choose "Default" in Settings to hand the choice back to Codex's own config. Under `read-only` the extra directories are left off, since read-only can read every path anyway.
- **OpenCode** has no option for extra directories, so none are passed: it works in the folder the session starts in.

### Overview, Session tab and sessions drawer

The Projects tab lists projects. Selecting one opens its **Overview**: the plan's progress, open todos, the newest files in the project folder, attached folders, files you've dropped in, and one card per track with its latest sessions. A file opens in the **Files** tab, which browses the whole project folder in the same viewer.

Opening a session, from the Overview or from the sidebar, opens the project's **Session** tab, right after Overview: the page header and tabs stay on top and the terminal fills the rest. Switching to another tab leaves the session running, and the Session tab brings it back.

Each project row's second line shows numbers only: plan phases done of all, todos open of all, tracks, sessions, then the latest activity (`43/60 · 26/26 · — · 2 · just now`). Pointing at a number shows what it counts ("Plan 43/60"); a long dash means none.

The chevron before a project in the sidebar opens its **sessions drawer** under the row: a + for a new session, then the project's sessions as one list. Drawers start closed; only the chevron opens or closes them, and "Show all sessions" on a track card opens the drawer on that track.

- **Search** — The field on top searches projects and sessions. A project with matching sessions shows with its drawer open and only those sessions in it, archived ones included.
- **No project** — The last row, "No project", holds the sessions that belong to no project, by folder like the Sessions tab.

![Project View session workspace](build/project-view-session.png)

- **Grouping** — The combo beside the search field groups every drawer by **Time** (today, yesterday, this week...), **Track**, or **State** (needs input, running, idle).
- **Rows** — Each row shows the title, the track, the CLI, its age, and message count. Right-click a project, track, or session for its actions.
- **Ordering** — Projects and sessions are ordered by their last event: a new session started, a turn finished, or the CLI asked for something. Opening or resuming a session does not move it, so the list holds still under a click. A session that is still working does not move while its transcript grows, so two working sessions hold their places instead of leapfrogging.
- **Archived** — Archived sessions sit in a closed "Archived" line at the foot of the list and under each track card. One click opens them, dimmed, in place.

The project's **Settings** tab is a list of rows: the name, the start folder, folders, the worktree branch, and the tracks. Changes save as you make them. Folder rows show the branch each folder is on, read from git when the page opens, and "modified" when there are uncommitted changes.

### Creating and organizing projects

![Project View new session menu](build/project-view-new-session-menu.png)

- **New project** — Name it, pick a template, and attach the folders it works in. The dialog shows what Create will make: the project folder and its files, each worktree on its branch, and the tracks the template adds. Sessions started from the overview are filed under the project and still show under their folder in the Sessions tab.
- **Tracks** — Optional lines of work inside a project, each with its own sessions, start folder, and CLI. A track card's "Resume latest" reopens its most recent session. "New" starts one there.
- **Move to project** — Any session row has a move action. Nothing is filed until you launch it from a project or move it there.
- **Mark as done** — Done projects drop to the bottom, collapsed. Removing a project only forgets it. The folder and the sessions stay on disk.
- **Snooze** — Right-click a project and choose **Snooze**: in 1 hour, in 3 hours, this evening, tomorrow, next week, or a time you pick. It moves to a collapsed **Snoozed** section below Active, and its sessions keep running. It comes back at that time, or sooner if a session needs your input, marked with a violet dot until you open it. **Wake now** brings it back early. A project waiting on your input can't be snoozed.

![Project View snooze](build/project-view-snooze.png)

### Plan and Todos tabs

![Project View plan and todos](build/project-view-plan.png)

The Plan tab shows the phases in `plan-tracker.md` with their items, the Todos tab the todos in `todos.md`, and both show which sessions started or finished each one. Tick items in place, or start a session on a phase or a todo: it opens with that item as its first prompt, filed under the project. A plan written in Claude Code's plan mode can be adopted into a project from the Plans list.

### Worktrees

Attaching a plain folder uses it where it is. Attaching a git repository asks how the project should work in it:

- **As it is**, on whatever branch is checked out.
- **With its own checkout** under the project folder at `repos/<name>`, on one branch shared by every worktree in the project, or one you name per repository.

A worktree inherits the repository's `.vscode/tasks.json`. Switchboard keeps its generated `CLAUDE.md` and `AGENTS.md` in the project folder; it does not add instruction overrides or ignore rules to attached repositories. Marking a project done asks whether to keep its worktrees on disk (the default, so the project can be reopened as it was) or delete them. Branches stay.

The project's **Worktrees** tab lists every worktree of the project's repositories, wherever it came from: made here, by `claude --worktree` (`.claude/worktrees`), by Codex, or by hand. An attached folder that is not a repository is searched a few levels down for the ones it holds. Each row shows the branch, the folder (the full path is in its tooltip), whether it is locked, missing, or has uncommitted changes, how far it is ahead of or behind its upstream, its last commit, and the sessions running in it. Filter the list or sort it by name or creation time.

- **New worktree** — On a new branch (from HEAD or any branch), an existing branch, a remote branch (a local branch that tracks it), or a detached commit. The folder comes from a template, next to the repository by default (`<repo>.worktrees/<branch>`), and can be changed every time. Optionally attach it to the project, copy the repository's `.env` files, and open a Claude or Codex session or a terminal in it right away.
- **Remove** — Asks before discarding uncommitted changes, unlocks a locked worktree if you say so, and can delete the branch too. A branch that is not merged is only deleted after a second confirmation.
- **Maintenance** — Lock (with a reason) and unlock, move (the project's folder, default folder and track folders follow), repair one worktree or a whole repository, repair a folder moved by hand, prune the records of worktrees whose folder is gone, and remove the worktrees whose branch is already merged.
- **Worktree settings** — The folder template (`$BASE_PATH`, `$BASE_ROOT`, `$BASE_NAME`, `$REF_NAME`, `$INDEX`, `$PROJECT_ROOT`), patterns of files to copy into a new worktree, and commands to run after creating one (such as `npm install`) and before removing one. The commands run in your login shell, in the worktree, and come only from these settings, never from a file in a repository. If the command before removing fails, the worktree stays.

### Node Knowledge

The **Node Knowledge** tab shows each attached folder as a code graph, built and kept by [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (CBM, MIT) on this computer; the graph stays there (the app only asks GitHub which CBM release is the latest). Switchboard uses the CBM your coding agents already use (registered in `~/.claude.json`, or found in `~/.local/bin`, Homebrew or `PATH`; `SWITCHBOARD_CBM` names another); CBM wants one build and one cache for every process, so the app never brings its own copy. When there is none, the tab downloads the pinned release (`CBM_VERSION` in `cbm-locator.js`), checks it against the release's checksums, and lets it install itself into CBM's usual folder without touching any agent's configuration.

- **Overview** — Each folder's graph (nodes, links, when it was indexed, cross-repo links, files left out) and the architecture of the one picked: languages, packages, entry points, hotspots, routes, layers, boundaries, clusters and call cycles. A symbol opens in the Files tab at its line.
- **Search** — Symbols by name, words or meaning, with kind and file filters, or text in the source; a symbol opens beside the results with its code, its callers and callees, and the outline of its file.
- **Trace** — Who calls a function and what it calls, with the risk of a change to each: a graph that opens one step at a time, or a list by hop, in CBM's modes (calls, data flow, across services, topology, deploy, run). Runtime call paths can be imported from a JSON file.
- **Impact** — What uncommitted work, a branch against its base, or the commits since a ref touch, and everything that depends on them, step by step, with the call each was reached by. Also from the Git tab (Changes, a commit in History) and from a worktree.
- **Query** — Read-only Cypher over the graph or over its coverage gaps, with examples and saved queries.
- **ADR** — The folder's architecture decision record, kept by CBM beside the graph (8,000 bytes).
- **Coverage** — Files read in part (with their lines), skipped, or left out on purpose, and a check of given paths. Edit `.cbmignore` from Settings.
- **Compare** — Two indexed folders of the project side by side.
- **Lens** — CBM's own web view (the 3D Galaxy, Architecture, ADR, Coverage, System), shown in the tab. It has no login and listens on 127.0.0.1 only; it is never offered to a phone.
- **Settings** — **Use the code graph** keeps the project's indexes fresh as its repositories change (a commit, a checkout, saved files), writes a *Code graph* section into the managed block of `CLAUDE.md` and `AGENTS.md`, and gives the project's Claude and Codex sessions CBM's MCP server on their command line when the agent has none of its own (with all tools, the analysis ones, or the scout ones). Also how much to read, cross-repo linking, sharing a folder's graph with the team (`.codebase-memory/graph.db.zst`), re-index and delete.

**Ask an agent** starts a session on CBM's graph-first exploration or change-review prompt. Settings › Node Knowledge shows the program in use and CBM's own settings (watchers, automatic indexing, limits, the Lens and its port), and can run CBM's installer for every agent after showing what it would change. A paired phone has the same tab, but the Lens and these global settings.

## Project Tasks and Server Logs

Switchboard runs the commands in a project's `.vscode/tasks.json` without needing a debugger. Use it for dev servers, workers, asset watchers, test suites, or any long-running command whose output you want next to your coding sessions.

- **Task launcher** — A play button appears in each project header. In worktree headers it sits between the hide and new-session buttons on hover, and stays visible while a task runs. A project's menu combines the tasks from every attached folder.
- **Live, retained logs** — Running a task keeps the menu open and shows its state on the row. Clicking a task that has run opens its terminal in the main pane, or beside the session list inside a project. Output is kept when you switch away, and the selected task view is restored after a renderer reload.
- **Independent lifecycle** — Tasks run separately from Claude and Codex sessions. Stop or restart them from the terminal header without touching an agent transcript.
- **Project and worktree scope** — Commands run with the selected project or worktree as `${workspaceFolder}`. A worktree inherits its parent project's tasks when it has no `.vscode/tasks.json` of its own. A worktree-local file overrides the inherited one.
- **Compound stacks** — `dependsOn` tasks start several services in parallel, so one click can bring up API + worker + frontend. Stopping the compound stops its children.

Example:

```jsonc
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "API server",
      "type": "process",
      "command": "${workspaceFolder}/.venv/bin/python",
      "args": ["-m", "uvicorn", "app.main:app", "--reload"],
      "options": { "cwd": "${workspaceFolder}" },
      "isBackground": true
    },
    {
      "label": "Frontend",
      "type": "npm",
      "script": "dev",
      "isBackground": true
    },
    {
      "label": "Full stack",
      "dependsOn": ["API server", "Frontend"],
      "dependsOrder": "parallel"
    }
  ]
}
```

**Supported:** JSON with comments and trailing commas; `shell`, `process`, and `npm` tasks; `dependsOn` and `dependsOrder`; task working directories and environment variables; platform overrides; an optional `options.envFile`; and the common workspace, home, path-separator, and `${env:NAME}` variables.

**Out of scope:** debug adapters, breakpoints, VS Code command and input variables, and problem-matcher diagnostics. The feature is deliberately focused on running commands and seeing their logs.

## Keyboard shortcuts

Every place that shows or edits a file or a piece of code (the Files tab and a file's own window, Plans, Notes, the session's side panel, a project's Files tab, the Git tab's editor, Git History, Compare, Actions, Node Knowledge) uses the same editor, with VS Code's keys. macOS first, then Windows and Linux.

| Shortcut | Action |
|---|---|
| `Cmd+F` / `Ctrl+F` | Find in the file (in the terminal too; in a Markdown or JSON preview, in the rendered text) |
| `Cmd+Alt+F` / `Ctrl+H` | Find and replace |
| `Enter`, `Shift+Enter`, `F3`, `Shift+F3`, `Cmd+G`, `Shift+Cmd+G` | Next and previous match |
| `Cmd+Alt+C` `W` `R` / `Alt+C` `W` `R` | Match case, whole word, regular expression |
| `Cmd+Alt+L` / `Alt+L` | Find in selection |
| `Cmd+Alt+P` / `Alt+P` | Preserve case when replacing |
| `Alt+Enter` | Select every match, as cursors |
| `Up`, `Down` in the find fields | Earlier and later searches |
| `Ctrl+Enter` in the find fields | A new line in the query |
| `Cmd+Enter` / `Ctrl+Alt+Enter` | Replace all |
| `Cmd+E` (macOS) | Use the selection to find |
| `Ctrl+G` | Go to line (`line:column` too) |
| `Cmd+Shift+O` / `Ctrl+Shift+O` | Go to a symbol of the file (functions, classes, headings, keys) |
| `Cmd+D`, `Cmd+Shift+L` / `Ctrl+D`, `Ctrl+Shift+L` | Add the next occurrence, select every occurrence |
| `Alt+click`, `Shift+Alt+drag`, `Cmd+Alt+Up/Down` / `Ctrl+Alt+Up/Down`, `Shift+Alt+I` | More cursors: at a click, in a column, above or below, at the end of each selected line |
| `Shift+Alt+Cmd+Arrows`, `PageUp/PageDown` / `Ctrl+Shift+Alt+Arrows` | Column selection: a cursor (or a selection) on each line of a growing box |
| `F12`, `Cmd+click` / `F12`, `Ctrl+click` | Go to Definition (the language server's, else the code graph's) |
| `Ctrl+-`, `Ctrl+Shift+-` / `Alt+Left`, `Alt+Right` | Go Back, Go Forward |
| `F2` | Rename Symbol (with a language server; files not open are changed after asking) |
| `Shift+Alt+F` | Format Document |
| `Cmd+K Cmd+F` / `Ctrl+K Ctrl+F` | Format Selection |
| `Ctrl+Space` | Suggestions (they also show while typing, except in Markdown) |
| `Cmd+/`, `Shift+Alt+A` | Toggle a line comment, a block comment |
| `Ctrl+J` (macOS) | Join lines |
| `Cmd+K Cmd+X` / `Ctrl+K Ctrl+X` | Trim trailing whitespace |
| `Cmd+K Cmd+0`, `Cmd+K Cmd+J` / `Ctrl+K Ctrl+0`, `Ctrl+K Ctrl+J` | Fold all, unfold all |
| `Cmd+S` / `Ctrl+S` | Save |

The editor's right-click menu also sorts lines, deletes duplicate lines, and changes case. Its status bar shows the cursor's line and column, the indentation (found in the file; change it or convert it there), the line breaks (a CRLF file stays CRLF), the encoding and the language (change it there), and switches whitespace, the minimap and sticky scroll on and off (the right-click menu and Settings › Editor do too, with Vim mode and the language servers). Besides the languages built in, it colours PHP, C#, Ruby, SCSS, Sass, Less, Vue, Svelte, Liquid, Jinja, Elixir, Terraform, Zig, Kotlin, Scala, Dart, Objective-C, Lua, Swift, Haskell, OCaml, F#, PowerShell, Erlang, Julia, R, Groovy and Perl, loading each the first time a file of it is shown. With Vim mode on, the status bar shows the mode and `:w` saves; the app's find, save, go to line and go to symbol keys stay the app's.

The editor uses the language servers installed on the computer (TypeScript, Python, Go, Rust, C/C++, Java, Kotlin, C#, Ruby, PHP, Swift and others; nothing is downloaded) for the files of a project: each project's Settings tab lists them, turned on for the languages found when a folder joins the project, with how to install the missing ones. A server starts with the first file of its language and stops 5 minutes after the last one closes. One switch, Language servers in Settings › Editor (or the server's item in the status bar), turns them all off: none starts, in any project, and the running ones stop. They give hover, errors, suggestions, Go to Definition and Rename, and format the languages Prettier does not; Format Document uses the project's own Prettier when it has one, else the app's. JSON and YAML syntax errors show without a server. The project's Files tab (each project with its own tabs), the sidebar's Files tab and a session's side panel keep every file you open in a tab of its own; a tab says the file's name, adding folders (and the project) only when two open files have the same name. Unsaved text is never lost: the app keeps a copy of it in its data folder as you type, so it is still there after you switch tab or page, close a window, quit or restart; the sidebar's Files tab lists the files with unsaved changes first. In that tab a project's group can be pinned above the others (drag its header to reorder the pinned ones), and Ctrl/Cmd+click or Shift+click selects several files to open together. It also lists every file open in the app (the projects' Files tabs, the sessions' panels, its own tabs) until you close it: "All files" keeps them together under Opened, each after its project's name, pinned ones first in the order you drag them into, and "Opened files" groups them by project. The star on a file keeps it at the top of its project's group. If a copy cannot be written, the app says so and asks before closing. A file with unsaved changes has a dot on its tab (or after its name), and closing it asks whether to save them. When an agent changes the file on disk, the editor takes the change in place, keeping the cursor; with unsaved changes it asks instead: Reload, Keep Mine or Compare.

## Development

### Prerequisites

- **Node.js** 20+
- **npm** 10+
- Build tools for native modules (node-pty, better-sqlite3):
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `build-essential` and `python3` (`sudo apt install build-essential python3`)
  - **Windows**: Visual Studio Build Tools or `npm install -g windows-build-tools`

### Running from source

```bash
npm install      # installs dependencies and runs postinstall
npm start        # bundles CodeMirror, then launches Electron
```

After the first run, skip the bundle step for faster iteration:

```bash
npm run electron
```

To keep a development instance's data separate from the installed app, set `SWITCHBOARD_DATA_DIR`:

```bash
npm run electron-dev    # uses ~/.switchboard-dev
```

Run the test suite with:

```bash
npm test
```

### Building

Every build command bundles CodeMirror first, then runs electron-builder. Output goes to `dist/`.

```bash
npm run build           # current platform
npm run build:mac       # DMG + zip (arm64 + x64)
npm run build:win       # NSIS installer (x64 + arm64)
npm run build:linux     # AppImage + deb + pacman (x64 + arm64)
```

**Arch / Manjaro:** the `deb` and `pacman` targets use the `fpm` binary bundled with electron-builder, which links against `libcrypt.so.1`. Arch ships `libxcrypt` without that legacy ABI, so install the compat shim once. `AppImage` builds without it.

```bash
sudo pacman -S libxcrypt-compat
```

### Code signing

Set these environment variables for signed distribution builds:

| Platform | Variables |
|---|---|
| macOS | `CSC_LINK` (p12 certificate) and `CSC_KEY_PASSWORD`, or sign via Keychain |
| Windows | `CSC_LINK` and `CSC_KEY_PASSWORD` for EV/OV code signing |
| Any | `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing (CI artifact builds) |

The macOS build uses custom entitlements in `build/entitlements.mac.plist` to allow JIT and unsigned memory execution, which the native modules require.

### Releasing

Releases are driven by git tags. The GitHub Actions workflow builds for all platforms and publishes to GitHub Releases:

```bash
git tag v0.1.0
git push origin v0.1.0
```

To release locally instead, set `GH_TOKEN` to a GitHub personal access token with `repo` scope and run:

```bash
npm run release
```

### Project structure

```
main.js            Electron main process
preload.js         Context bridge (IPC bindings)
db.js              SQLite session cache and metadata
harnesses/         Per-CLI modules (claude, codex, opencode) and registry
public/            Renderer (HTML/CSS/JS)
templates/         Built-in project templates (feature, research, customer)
workers/           Background workers
scripts/           Build and postinstall scripts
test/              Node test suite (npm test)
build/             Icons, entitlements, screenshots, builder resources
.github/workflows/ CI/CD
```

## Further reading

- [`docs/customizing-colors.md`](docs/customizing-colors.md) — changing the app's colors and applying a light theme (in French).

## License

MIT. See [LICENSE](LICENSE).
