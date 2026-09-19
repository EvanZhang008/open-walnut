# Engine settings

Settings → Engines lets you edit each coding-agent engine's own settings from
Walnut: the rows Claude Code's `/config` screen edits, and the top-level keys of
Codex's `config.toml`. Walnut writes the engine's own files on the host where
that engine's sessions run, so a terminal on that host and every Walnut session
see the same values.

## How it fits together

```text
Settings → Engines (host picker, one tab per engine, rows rendered from a schema)
        │  GET  /api/engines/:id/settings?host=      PATCH … {set, unset}
        ▼
src/web/routes/engines.ts            validates the host, wires the daemon transport, maps errors
        ▼
src/core/agents/engine-settings-service.ts     engine-agnostic read / validate / read-modify-write
        │  schema = engineCaps(id).settings
        ├─ src/core/agents/engine-settings/claude.ts    data: 50+ rows → file + key + type + default + env
        ├─ src/core/agents/engine-settings/codex.ts     data: config.toml top-level keys
        └─ src/core/agents/config-file-edit.ts          JSON dotted paths; TOML top-level line edits
        ▼
daemon on the host: fs.read, fs.write {atomic, expectSha256}   ('fs-write-atomic-v1')
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
  Default view) to the project's `.claude/settings.local.json`. Every settings
  source shares one schema, so Walnut writes them to the user file as the
  user-wide default; a project's own file still wins when it sets the key.
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
| 400 | unknown host, unknown key, or a value outside the declared type or options |
| 404 | the engine has no settings surface |
| 409 | conflict after the retry, or the file is unreadable |
| 501 | the daemon on that host predates `fs-write-atomic-v1`; it upgrades itself on the next session message to that host |
| 502 | the daemon could not read or write the file (`outcome` says whether the write may have landed) |
| 504 | the host did not answer within the deadline (`outcome: unknown`) |

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
- `tests/core/engine-settings-service.test.ts`: attribution (file, legacy,
  default, env), write-through, conflict retry and refusal, validation.
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
