---
name: walnut-import-external-sessions
description: >-
  Import coding-agent sessions a person started outside Walnut (terminal
  `claude`, Claude Desktop, the VS Code extension, codex TUI) into Walnut as
  tasks. Use when the user says "import my sessions", "find sessions opened
  outside Walnut", asks why a session id isn't in Walnut (a script's
  `claude -p` runs are left out on purpose), asks what the "Imported" pill means
  or why an imported task completed itself, or wants the external-session scan
  run NOW instead of waiting for the background tick.
---

# Import External Sessions

Walnut automatically imports sessions a person started outside it (someone ran
`claude` in a terminal, used Claude Desktop, the VS Code extension or the codex
TUI). A session a program started (a script's `claude -p`, an Agent SDK app) is
that program's work and is left out, unless a plugin claims it. A background
job runs every 10 minutes; this skill is the on-demand path.

Each imported session becomes **its own task**, titled with the session's own
name, grouped under a per-host project: **"Imported from this Mac"** /
**"Imported from \<host\>"**. Inside that project the tasks sit in **one
sub-folder per working directory** (label = the cwd's last two segments, home
collapsed to `~`: `myCode/walnut`, `src/server`, `~/.claude`).

## The imported type (the "Imported" pill)

An imported task carries the tag `walnut:external-sessions`. That tag is the
task's **type**, shown in the task list as an `Imported` pill, and it drives
three automatic behaviours. All of them run inside the same 10-minute tick;
there is no extra timer and no model call.

| Rule | What happens |
|---|---|
| Title | `custom-title` (a `/rename`) beats `ai-title` beats the first user message that is neither a meta line nor a compaction summary, exactly the CLI's own rule. A task still titled with a placeholder (`Claude session 1a2b3c4d` or a compaction summary) is renamed in place the tick its transcript yields a real title. |
| Idle auto-complete | A task whose session has had no activity for `auto_complete_after_days` (default 7) is marked COMPLETE. Rolling: a task imported today is completed the tick it crosses the line. At most 300 per tick, oldest idle first. Only tasks still in an "Imported from …" project: one you moved into your own project is left alone. |
| Adoption | The first message anyone sends to the session removes the tag. The task keeps its project and folder but leaves the imported type: no pill, never auto-completed. Sending to a completed task also reopens it (normal `session:input` rule). |

Existing installs converge on their own: old imports without a folder are filed
into their cwd folder (at most 300 per tick), placeholder titles are re-read by
id (`sessions.describeExternal`, so a transcript older than the scan window is
still fixed) until a real title exists, imports an older scanner took in by
mistake (Walnut's own sessions per the spawn journal, forks, reply-less probes,
runs a program started) are removed together with their session row (each import is
re-read once per server start, and again once its host's daemon learns a newer
rule, at most 100 per tick, open tasks first), and idle imports are swept.

## Run an import now

```bash
curl -s -X POST http://localhost:3456/api/sessions/import-external \
  -H 'Content-Type: application/json' -d '{"days":30}'
```

- `days` widens/narrows the lookback window (default 30).
- Response fields: `imported` new tasks, `retitled` placeholder titles replaced,
  `completed` idle imports auto-completed, `foldered` old imports filed into a
  cwd folder, `removed` imports that were never outside sessions, `skipped` candidates already tracked or excluded. `hostsScanned` /
  `hostsSkipped` say whether a host was reached; a daemon that is not connected
  or too old is skipped. `truncated` means a cap was hit, not that the import is
  finished.

## Check whether a specific session made it in

```bash
walnut sessions --json | grep <session-id-prefix>
```

If it's missing after an import run, the usual reasons:

1. **Host not scanned**: check `hostsSkipped` in the response. The host's
   daemon must be connected and advertise `external-scan-v1`.
2. **Older than the window**: re-run with a bigger `days`.
3. **A program started it**: see "Who started it" below. Bring it in by id
   (next section), or have the program's plugin claim its runs.
4. **Directory filter**: `external_session_import.excluded_cwds` (per host)
   applies to every entry point. A host with exclusions configured needs
   `external-scan-filter-v1`; an older daemon is skipped rather than allowed to
   ignore the rules.

## Import specific sessions by id

```bash
curl -s -X POST http://localhost:3456/api/sessions/import-external \
  -H 'Content-Type: application/json' \
  -d '{"host":"__local__","sessionIds":["<session-id>"]}'
```

Imports exactly those sessions (`host` is a host alias, default this machine),
whoever started them and however old they are, into the same "Imported from …"
project and cwd folder. Someone asked for them, so they are not the imported
type: no pill, no idle sweep. The answer lists `imported` ids and `skipped` ones
with a reason (`already-tracked`, `not-found`, or `walnut-spawned` / `fork` /
`walnut-driven` for Walnut's own sessions and copies of them). At most 300 ids.

## What gets imported

| Source | Imported? |
|---|---|
| Terminal `claude` / Claude Desktop / VS Code extension | Yes, unless a directory rule excludes it |
| codex TUI / Codex Desktop | Yes, unless a directory rule excludes it |
| A program's runs (`claude -p`, Agent SDK apps, `codex exec`) | Only when a plugin claims them by id (`sessionImports.include`, how a plugin that owns such a program puts its runs on the board). Otherwise never: see "Who started it". Needs `external-human-v1` on the host's daemon; an older one still imports them |
| Walnut's own sessions | Never. It is answered by id, not by guessing. The daemon on each host keeps a **spawn journal**, `~/.open-walnut/local/spawn-journal.jsonl`: one append-only JSON line per session it ever started, under the CLI's own session id, saying how (`new`, `fork` with its `parent`, `resume`) and for whom (the asking Walnut's data dir as `home`, and the `task`). So a session started by ANY Walnut instance on that host (prod, a dev server, an ephemeral test server whose own database is gone) is skipped even when this server holds no record of it, and a removal names who started it. The file stays on its host (git-sync ignores `local/`); at startup the daemon folds older records into it (the per-id marker files it replaced, and its streams captures). Text rules back it up for transcripts older than any record: a programmatic fork (its first message predates earlier lines, copied history), or a Walnut envelope in a user turn (the side-thread cache warm-up, the output-mode reminder) |
| Sessions with no real reply | Never, when the whole transcript was read: a probe or a first turn that only errored has nothing to adopt |
| Subagent sidechains | Never |

## Who started it

The CLI records who started every session, and the scan reads that record
rather than guessing from timing or prompts. Every user line carries the
`entrypoint`: `cli` (the terminal UI), `claude-desktop`, `claude-vscode` are
surfaces a person types into; `sdk-cli` (`claude -p`), `sdk-ts` / `sdk-py` (the
Agent SDKs), `mcp` and the CI action are programs. A child process inherits the
entrypoint, so `claude -p` run from a shell inside an interactive session
records `cli` too; the CLI also stamps each submitted prompt with its source
(`promptSource`: `typed`, `queued`, `sdk`, ...), and `cli` whose first prompt is
`sdk` is a program's run. The desktop app and the IDE extension drive the CLI
over the SDK themselves, so their prompts read `sdk` as well and their
entrypoint alone decides. For codex, the rollout's `originator` names the
surface the same way. A transcript the scan skips for this reason is answered
`programmatic` by describe, and the audit removes such imports from the
"Imported from …" projects unless a plugin claims them.

## Configuration

Both keys live under `external_session_import` in the config. Read the existing
section before writing so other hosts' rules survive.

```json
{
  "external_session_import": {
    "auto_complete_after_days": 7,
    "excluded_cwds": { "__local__": ["/tmp/walnut-probes"], "buildbox": ["/home/dev/probes"] }
  }
}
```

- `auto_complete_after_days`: idle window for the sweep; `0` disables it.
- `excluded_cwds`: host alias (`__local__` for this machine) to absolute
  directories. A rule matches the directory and everything under it, not a
  sibling with a similar name. No globs. Rules never delete an already imported
  task or its history; remove a rule and the next scan imports again. One-shot
  Claude probes should run with `--print --no-session-persistence` so they never
  produce a transcript to import.

Do not delete or merge records by hand on the strength of an entrypoint. A
retitle keeps the task id, filing, phase, notes, session links and timestamps;
the scan never modifies a transcript.
