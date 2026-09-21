# Engine settings

Walnut lets you edit each coding-agent engine's own settings: the rows Claude
Code's `/config` screen edits, and the top-level keys of Codex's `config.toml`.
Two surfaces share one implementation: Settings → Engines edits a host's
user-wide files, and the composer's "+" menu in a session opens the same rows
for that session (its engine, host and working directory), where a change can
also be scoped to that project only. Walnut writes the engine's own files on the
host where that engine's sessions run, so a terminal on that host and every
Walnut session see the same values.

## How it fits together

```text
Settings → Engines (host picker)      Session composer "+" → Engine settings (this session)
        │  GET/PATCH /api/engines/:id/settings?host=          ?sessionId=&scope=default|project
        ▼
src/web/routes/engines.ts            resolves host + cwd (from the session), wires the daemon transport
        ▼
src/core/agents/engine-settings-service.ts     engine-agnostic read / layers / read-modify-write
        │  schema = engineCaps(id).settings
        ├─ src/core/agents/engine-settings/claude.ts    data: 50+ rows → file + key + type + default + env
        ├─ src/core/agents/engine-settings/codex.ts     data: config.toml top-level keys
        └─ src/core/agents/config-file-edit.ts          JSON dotted paths; TOML top-level line edits
        ▼
daemon on the host: fs.read, fs.write {atomic, expectSha256}   ('fs-write-atomic-v1')
                    git.ensureExcluded                          ('git-exclude-v1')
```

Nothing outside `src/core/agents/` knows a vendor. An engine gets a settings
surface by declaring `settings` on its registry descriptor
(`src/core/agents/engine-registry.ts`); the route, the service and the web
section render whatever the schema says. The ratchet test that forbids
`engine === 'claude'` branches applies here as everywhere.

## What a row declares

Each item in a schema (`engine-settings-schema.ts`) names the file it lives in,
the dotted key inside it, its type (`boolean`, `select`, `text`, `number`), the
engine's default when the key is absent (or `null` when the engine decides and
Walnut cannot name it), which environment variables override it, and its scope:

- `sessions`: read by the engine's non-interactive runtime, so it shapes
  Walnut's sessions as well as the terminal.
- `terminal`: read only by the engine's interactive UI. Still the same file, so
  still worth editing here; the UI keeps this group collapsed.
- `updates`: the engine's self-updater.

## Claude Code facts the data encodes

Verified against Claude Code 2.1.258:

- Most `/config` rows are stored in the user settings file
  `~/.claude/settings.json`. Sixteen keys that older versions kept in
  `~/.claude.json` (theme, editorMode, verbose, autoCompactEnabled, …) are still
  read from there as a fallback; each declares that under `legacy`, and Walnut
  only ever writes the user file. A value that shows as "older location" in the
  UI is being read from that fallback.
- A few terminal preferences (respect .gitignore, copy on select, the agents
  view, IDE and Chrome integration, workflow size) are still stored in
  `~/.claude.json`; those rows say so in their help.
- The CLI's own screen writes four rows (Show tips, Reduce motion, Output style,
  Default view) to the project's `.claude/settings.local.json`; the data marks
  them `cliWritesTo`. With a working directory known, Walnut's default scope
  follows the CLI and writes them there too; without one (Settings → Engines)
  they go to the user file as the user-wide default.
- Precedence, highest first: managed settings, CLI flags, the project's local
  file `<cwd>/.claude/settings.local.json`, the project's shared file
  `<cwd>/.claude/settings.json`, the user file, the legacy `~/.claude.json`.
  A running session watches all of them, including a local file that did not
  exist when it started (the watcher waits for `.claude/` to appear), and
  applies most keys on its next turn; keys under `env` apply to new sessions
  only.
- The CLI keeps `.claude/settings.local.json` out of git by adding a rule to
  the user's global excludes file, which does nothing when `core.excludesFile`
  points elsewhere. Walnut does not depend on it: see "Project scope" below.
- `--permission-mode` and `--dangerously-skip-permissions` beat
  `permissions.defaultMode`. Walnut passes `--permission-mode` on every launch,
  so that row changes terminal sessions only; the mode pill in a Walnut session
  is the control for Walnut sessions. The row's help says this.
- `CLAUDE_CONFIG_DIR` relocates both files; `CODEX_HOME` relocates Codex's.
  Resolved from the Walnut server's own environment on the local host. That is
  a known limit: a variable exported only in a shell rc file is seen by the
  engine (the daemon sources the rc before spawning it) but not by the server,
  so a `CLAUDE_CONFIG_DIR` set that way makes Walnut edit the default paths
  while the CLI reads the relocated ones. The footer names the exact path that
  was edited, and a remote host's environment is not visible at all, so env
  overrides are not reported there (`envChecked: false` in the payload; the UI
  says so above the rows). Moving path resolution into the daemon, which has
  the engine's environment, is the follow-up that closes this.
- Running CLIs watch `settings.json` and reload it, which is why the write is
  atomic (a torn write would be read as invalid JSON) and conditional (see
  below).

## Project scope: layers and where a write goes

A schema may declare project-scoped files (`scope: 'project'`, path starting
with `<cwd>/`) and list them as `projectOverlays`, highest precedence first.
Claude declares two: the local file (writable) and the shared file (read-only;
it is committed with the repo, so Walnut never edits a teammate's choices and
overrides them through the local file instead). Project files are consulted
only when a working directory is known: the route takes it from `?cwd=` or
from the session named by `?sessionId=` (its host as well). Without one the
view is the host-wide one Settings → Engines shows.

Every row in the view says which layer holds the value in force (`source`:
`file`, `overlay` with the overlay named, `legacy`, `default`) and where a save
would land (`writeTarget`, with `holds` telling whether a Reset has anything to
remove there). The write scope is a request parameter:

- `scope=default` (what the composer opens with) follows the engine's own
  config screen. A key already set in a project layer is changed there (if that
  layer is writable, otherwise in the writable overlay above it); a `cliWritesTo`
  key goes to the file the CLI would use; everything else goes to the user file.
- `scope=project` sends every write to the first writable overlay
  (`<cwd>/.claude/settings.local.json`), creating it when missing. Reset removes
  the key from that file only, so the user-wide value shows through again.

When a save creates a project file, the daemon's `git.ensureExcluded` appends
`/<relative path>` to the repository's `.git/info/exclude` unless git already
ignores or tracks the file; the response reports `gitExclude: {path, outcome}`
(`added`, `already`, `not-a-repo`, `unavailable` on a daemon that predates
`git-exclude-v1`, or `failed` with `error` when the daemon has the command but
could not run it). It never touches `.gitignore`, which is the user's and often
committed. The daemon compares paths after resolving symlinks on both sides:
`git rev-parse --show-toplevel` answers `/private/var/...` for a `/var/...`
checkout on macOS, and without that step every repository under `/tmp` or
`/var` read as "outside the repository".

A schema also says when a change is felt (`appliesOn`: `next-turn` for Claude,
whose running sessions watch every settings layer; `new-session` for Codex,
which reads `config.toml` at start). It rides on the view and on every row, so
the UI's "applies on the next turn" sentence comes from the engine's data, not
from a per-engine table in the client. A shared project file that sets a key with nothing writable above it
is reported as `overriddenBy`, so the UI can say "edit that file by hand"
instead of offering a control whose save would change nothing.

`cwd` must be absolute (or `~`-relative) with no `..` segments; `scope=project`
without a working directory, or for an engine with no writable project file, is
a 400.

## Writing safely

A save is a read-modify-write of one file:

1. Read the file through the daemon, remember its sha256.
2. JSON: parse, set or delete the addressed dotted keys, serialize with the
   file's own indentation and trailing newline (2-space and none when there is
   nothing to learn from, the shape Claude Code itself writes) and the original
   key order. Every sibling at every level is carried over, so
   `permissions.allow` survives a change to `permissions.defaultMode`, and
   hooks, model overrides and keys Walnut never declared are untouched.
   TOML: replace or append top-level `key = value` lines only; comments,
   layout, arrays, multi-line strings and every `[table]` are returned
   byte-for-byte. A key whose current value the line scanner does not
   understand (a multi-line string, an array) is refused rather than replaced,
   because dropping its first line would strand the rest.
3. Write through `fs.write {atomic: true, expectSha256}`. The daemon resolves a
   symlink to its target first (a dotfiles-managed `settings.json` stays a
   link), checks that the target is a regular file below the read ceiling and
   that its bytes still hash to what was read, then writes a temp sibling,
   fsyncs, preserves the old mode and renames it over the target. A hash
   mismatch (the CLI rewrote the file in between) is retried once from a fresh
   read, then reported as a 409 conflict. Nothing is ever overwritten blind.
4. The response is a fresh read, so the UI shows what landed.

The hash is taken over the file's exact bytes on both sides, never over decoded
text, so a stray non-UTF-8 byte cannot make a file permanently unwritable. Files
above 4 MB (`MAX_SETTINGS_FILE_BYTES`) and files that cannot be parsed are shown
as unreadable and refused as a write target until fixed by hand. Walnut never
rewrites bytes it could not read, and never creates an empty file just to remove
a key from one that does not exist.

Every failed write also says what it did to the file (`outcome` in the body):
`not-written` for a refusal, `written` when the change landed but a later step
failed (the read-back), `unknown` when the transport died mid-write or the
deadline fired. The UI puts a control back only on `not-written`; otherwise it
keeps the banner and reloads the truth from disk, because a reverted toggle on a
write that did land shows the opposite of the file.

## Errors the UI shows verbatim

| Status | Meaning |
|---|---|
| 400 | unknown host or session, a relative or traversing `cwd`, `scope=project` without a cwd, unknown key, or a value outside the declared type or options |
| 404 | the engine has no settings surface |
| 409 | conflict after the retry, or the file is unreadable |
| 501 | the daemon on that host predates `fs-write-atomic-v1`; it upgrades itself on the next session message to that host |
| 502 | the daemon could not read or write the file (`outcome` says whether the write may have landed) |
| 504 | the host did not answer within the deadline (`outcome: unknown`) |

## Composer popover

Every session column has the same settings one click away: the composer's "+"
menu ends its Shortcuts block with an "Engine settings" row (its own separator
above it) whenever the engine catalog says the session's engine has a settings
surface. The row's tooltip names the engine, the session's working directory
and the host. Selecting it closes the menu and opens a dialog next to the
composer, portalled to `document.body` and placed by `useMenuPlacement`, so it
never leaves the viewport; the rows scroll inside a fixed-height panel. Files:
`web/src/components/sessions/EngineSettingsPopover.tsx`, `EngineSettingsPopoverBody.tsx`,
`useEngineSettingsEntry.tsx`, styles in `web/src/styles/engine-settings-popover.css`.

What the dialog shows:

- The header says which engine, host and directory it is about. The subtitle
  keeps the last segment of the directory (the repo) whole and shortens the
  head, so two sessions in different repos never read alike. The GET is
  `?sessionId=<id>` (plus `scope=project` when that scope is remembered for
  this engine, host and directory), so the server resolves the session's own
  host and cwd.
- A write-scope switch (`Save changes to`): "Same as Claude Code" mirrors what
  the CLI's own config screen does, which is the user file for most keys and the
  project's local file for the few keys the CLI keeps per project (output
  style). "This project only" sends `scope=project`: every row then saves to
  `<cwd>/.claude/settings.local.json`, created on first save and added to the
  repo's exclude list. The sentence under the switch says exactly this, in
  plain words (the default sentence leads with what the engine itself would do,
  names the per-project exception, and points at each row's "Saves to" line),
  and the footer sentence after a save names the
  file and the directory (never the exclude list's path). The last scope is
  remembered per engine, host and directory and asked for on the first request;
  a remembered scope the server refuses falls back to the default once and is
  forgotten. A row whose key has no per-project layer (`projectLayer: false`
  from the server) is locked in project scope with the reason in its tooltip,
  rather than offered a control whose save would be refused.
- Only the rows of the `sessions` group, in server order, each through the
  shared `EngineSettingRow`: status line ("Set in user settings", "Set in this
  project (local)", "Default"), the "Saves to ..." line when the write lands
  elsewhere, Reset when the target file holds the key. A filter box narrows by
  label or key, and falls back to help text with the match marked.
- The other groups (updates, terminal only) are one link away: the footer link
  text is built from the response ("Updates and Terminal only settings (34) are
  in Settings › Engines"; a neutral "Settings › Engines" until the view answers)
  and shares its line with "Files (N)" (a chevron marks the disclosure), which lists
  every file the engine reads, paths under the cwd shortened and wrapped only
  after a slash, clickable paths styled as links, with "(not created yet)" and
  "created just now" as they change.
- The footer's first block is a status slot: the saved sentence, a Reset's
  "Removed X from <file>; the <layer> value applies again", or a failed save
  (verbatim server sentence, with Dismiss). One line is reserved at rest; a
  landed sentence may take up to three lines (the footer grows from the bottom,
  so the rows' top and every control above stay put) and a longer one is
  clamped there with a visible More/Less control. Whenever a write created a
  project file, the sentence says so and whether git ignores it, under either
  switch position. An error is never clamped.
- The uncommitted-draft warning ("Press Enter to save the value first, or
  Escape to discard.") is drawn over the scope sentence, right under the
  switch whose click it answers, for three seconds.
- "About these settings" is an (i) glyph next to Close, after the switch in
  Tab order. Its panel opens as an overlay over the rows, never in the flow,
  and reads: which file the switch's current position writes, the group's
  help sentence, then the engine's own note.

Placement details that matter: the dialog is start-aligned on the "+" and
`edgeOverflow: 'clamp'` keeps it at the viewport margin when the column is the
rightmost one (it never jumps over the neighbouring column). Its bottom edge
clears the composer box while that box is a line or two of draft
(`verticalAnchorRef`, so the textarea stays visible and a click into it is the
outside click that closes the dialog and lands the caret); a taller draft
would squeeze the rows, so past `COMPOSER_ANCHOR_MAX_PX` the bottom sits on
the "+" row instead. The chrome above the rows (header, switch, two sentences,
filter) stays under 240px and the rows get more than half of the box at
1280x800. The block under
the switch reserves only the default scope's height; the project note is a
line longer and reflows once on the switch, and the scroller restores the
first visible row by its offset so only the rows' own new "Saves to" lines
move. Focus never gets stranded: Chromium drops focus to `<body>` when a
saving row's fieldset disables and WebKit does not focus a button on click at
all, so a document-level listener handles Escape and Tab while focus is
outside the dialog, and a finished save puts focus on its row's control unless
another control already has it. Escape in a text input first discards a
draft; with the input clean it closes the dialog.

Optimistic rows never invent a layer: a `set` shows the write target's layer
at once, but a Reset shows "Default" only when the key leaves the row's own
file and no other layer is known to hold it. A Reset of a project overlay
keeps the row as it is until the answer names the layer that takes over (the
user file or the default), because that layer is not in the view.

When a change is felt (the copy under the switch says this once, from
`view.appliesOn`):

- Claude Code (verified live on 2.1.258): a running session watches its
  settings files, including a `<cwd>/.claude/settings.local.json` that did not
  exist when it started, and applies most keys on its next turn. Keys under
  `env` apply only to new sessions; the row help says so where it matters.
- Codex reads `config.toml` when it starts, so changes apply to the next
  session ("Changes here apply to new Codex sessions").

Two more per-row facts come from the schema, so no surface has to branch on a
key name or read a file label:

- `launchOverride` on an item means Walnut's own launch outranks the stored value
  for the sessions it drives (`--permission-mode` for the permission mode,
  `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` for checkpoints). The view turns it
  into `honoredHere: false` plus the name, and the popover says "Does not change
  this session." in the row card. The model row is deliberately NOT marked:
  Walnut passes `--model` only when the picker chose one, so the file's value is
  what an "Auto" session uses.
- Overlays are declared per FILE (`EngineSettingsFile.overlays`), not per schema,
  because a layer belongs to one file family: `~/.claude/settings.json` layers
  per project, `~/.claude.json` does not. A key kept in a file without a writable
  overlay reports `projectLayer: false` whenever the project scope is on offer,
  a `scope=project` write for it is refused with a 400 that names the file, and
  the popover locks that row instead of writing where the engine would never
  read.

One gap stays open (recorded, not fixed here): `envOverride` for the local host
is read from the Walnut server's own process environment, not from the daemon
that spawns the CLI. The popover words it as "in Walnut's own environment"; the
check should move to the daemon.

## Adding a setting or an engine

- New Claude or Codex row: add one entry to the engine's data file. The schema
  sanity test (`tests/core/engine-settings-schema.test.ts`) fails on a
  duplicate key, an unknown file id, a select without options or a default
  outside them.
- New engine: declare `settings` on its descriptor with its own files and
  items. JSON and top-level TOML are the supported formats; a format that needs
  a parser which would lose comments should get a line-level editor like the
  TOML one rather than a parse-and-reserialize.

## Tests

- `tests/core/engine-settings-schema.test.ts`: every registered schema is
  problem-free; the Claude data covers the `-p`-relevant rows and declares the
  legacy fallbacks.
- `tests/core/config-file-edit.test.ts`: JSON siblings survive; TOML comments,
  multi-line arrays and tables are byte-identical after an edit.
- `tests/core/engine-settings-service.test.ts`: attribution (file, overlay,
  legacy, default, env), the write target under both scopes, project file
  creation and the git exclude hand-off, write-through, conflict retry and
  refusal, validation, `cwd` validation.
- `tests/web/routes/engine-settings.test.ts`: the route's host, session, cwd
  and scope resolution, error statuses and `outcome`, and the response shapes.
- `tests/providers/daemon-git-ensure-excluded.test.ts`: `git.ensureExcluded`
  against real `git init` repositories (append, already ignored, tracked,
  outside the repo, not a repo, `~` expansion).
- `tests/providers/daemon-fs-write-atomic.test.ts`: the daemon's `~`
  expansion, atomic rename through a symlink, mode preservation, the
  `expectSha256` guard, the regular-file and size gates, and the sweep of temp
  siblings an interrupted write left behind. Runs the source twin's function
  text; the bun twin is held to the same step ORDER by
  `daemon-standalone-vs-source-parity.test.ts`.
- `tests/e2e/browser/engine-settings.spec.ts` and
  `engine-settings.webkit.spec.ts`: the real Settings page against a dense
  fixture `settings.json` and `config.toml`, asserting on the files on disk.
  The fixture server starts the daemon binary under `dist/daemon-binaries/`, so
  run `bash scripts/build-daemon.sh` after touching either daemon twin; an old
  binary does not advertise `fs-write-atomic-v1` and every save answers 501.
- `tests/e2e/browser/engine-settings-popover.spec.ts` (chromium): the "+"
  menu row, the dialog's request shape, header, scope switch copy, row set and
  order, a user-file save with its footer sentence, viewport fit at four sizes,
  fixed height while loading, filtering and switching scope, pointer and focus
  rules, filter, footer link and Files list, the slow-load note, theme shots
  and a source hygiene check (no emoji, no hex colours, no `console.log`).
  Helpers: `engine-settings-popover-helpers.ts` (sessions started in fresh
  directories under the fixture's projects dir, network stubs that mutate the
  real response, disk readers, screenshots under
  `/tmp/engine-settings/ux-slice/shots/`).
- `tests/e2e/browser/engine-settings-popover-scope.spec.ts`: the disk-writing
  half. "This project only" in a real `git init` checkout creates the local
  file and the exclude line while the user file stays put; Reset removes the
  key; the footer sentence persists; a plain directory gets the "not a git
  checkout" sentence and no `.git`; a session without a cwd keeps the project
  side reachable but inert; a key held by the shared project file is shown as
  such and the change lands in the local file with the shared file
  byte-identical; text drafts revert on Escape, commit on an outside click and
  guard the scope switch; two columns show one dialog at a time; a closed
  column takes its dialog along; the scope memory per host and directory.
- `tests/e2e/browser/engine-settings-popover-failures.spec.ts`: unchecked
  environment, empty sessions group, first load 502 with Retry, refused save
  (`not-written`) reverting without a re-read, unknown save re-reading with
  the current scope, a pending save locking the switch and already reading as
  the project layer, an unparsable user file, a failed rescope, the global-only
  row lock, a Codex-shaped view, the row extras (`honoredHere`, environment
  wording) and the engine catalog being slow or down.
- `tests/e2e/browser/engine-settings-popover-fixes.spec.ts` and
  `engine-settings-popover-r2.spec.ts`: the two review rounds, each nitpick
  pinned by the measurement that found it: rows area over half the box and
  three rows visible at 1280x800, the repo segment of the subtitle whole at
  every width and different for two sessions, the About glyph after the switch
  with its scope line, the saved sentence inside the box (More/Less when it
  needs a fourth line), a default-scope write that created a project file
  saying so, a long error wrapping with Dismiss in reach, Escape from a clean
  input closing, the draft guard under the switch, focus on the toggled switch
  after a save, a scope switch keeping the scroll offset, a project Reset never
  reading "Default" while in flight (sampled every 40ms against a delayed
  answer), and the source hygiene gate (files under 500 lines, no dashes).
- `tests/e2e/browser/engine-settings-popover.webkit.spec.ts` and
  `engine-settings-popover-r2.webkit.spec.ts`: the WKWebView
  half (`PW_WEBKIT=1 ... --project=webkit`): Escape from a focused native
  select does not close the dialog, a keyboard change through the select lands,
  and a text draft commits on the outside click that closes the dialog.
- Manual, Mac app only (C61): open the Output style select with the mouse and
  dismiss it by clicking outside; the dialog must stay open. Playwright cannot
  reproduce the native popup, so the result is recorded by hand.
- Running these files together: Playwright puts every spec file in its own
  worker, and the Settings page spec plus the three popover files all flip
  keys in the fixture's one `HOME/.claude/settings.json`. Each file takes
  `lockUserSettingsFile` (engine-settings-helpers.ts) in `beforeAll` and
  releases it in `afterAll` (the popover files through `claimUserFile` /
  `restoreSeed`), so the files queue on the user file while every other spec
  keeps running in parallel. A `beforeAll` that waits a minute or two is the
  lock working, not a hang.
