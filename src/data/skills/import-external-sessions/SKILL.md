---
name: import-external-sessions
description: >-
  Import coding-agent sessions started outside Walnut (terminal `claude`,
  Claude Desktop, codex TUI, other SDK apps) into Walnut as tasks. Use when the
  user says "import my sessions", "find sessions opened outside Walnut", asks
  why a session id isn't in Walnut, asks what the "Imported" pill means or why
  an imported task completed itself, or wants the external-session scan run
  NOW instead of waiting for the background tick.
---

# Import External Sessions

Walnut automatically imports sessions that were started outside it (someone ran
`claude` in a terminal, used Claude Desktop or the codex TUI, or another SDK
app spawned sessions). A background job runs every 10 minutes; this skill is
the on-demand path.

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
still fixed) until a real title exists, and idle imports are swept.

## Run an import now

```bash
curl -s -X POST http://localhost:3456/api/sessions/import-external \
  -H 'Content-Type: application/json' -d '{"days":30}'
```

- `days` widens/narrows the lookback window (default 30).
- Response fields: `imported` new tasks, `retitled` placeholder titles replaced,
  `completed` idle imports auto-completed, `foldered` old imports filed into a
  cwd folder, `skipped` candidates already tracked or excluded. `hostsScanned` /
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
3. **Directory filter**: SDK sessions under temp directories are never imported;
   `external_session_import.excluded_cwds` (per host) applies to every entry
   point. A host with exclusions configured needs `external-scan-filter-v1`; an
   older daemon is skipped rather than allowed to ignore the rules.

## What gets imported

| Source | Imported? |
|---|---|
| Terminal `claude` / Claude Desktop | Yes, unless a directory rule excludes it |
| codex TUI / Codex Desktop | Yes, unless a directory rule excludes it |
| Other SDK apps | Yes, when the cwd is a real directory and no rule excludes it |
| Walnut's own sessions | Never (already tracked) |
| Subagent sidechains | Never |
| SDK runs under temp directories | Never; a `cli` run in a temp dir needs an explicit rule |

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

The `cli` entry point can be inherited by child processes, so it does not prove
a human started the session. Do not delete or merge records on that basis. A
retitle keeps the task id, filing, phase, notes, session links and timestamps;
the scan never modifies a transcript.
