---
name: import-external-sessions
description: >-
  Import coding-agent sessions started outside Walnut (terminal `claude`,
  Claude Desktop, codex TUI, other SDK apps) into Walnut as tasks. Use when the
  user says "import my sessions", "find sessions opened outside Walnut", asks
  why a session id isn't in Walnut, or wants the external-session scan run NOW
  instead of waiting for the background tick.
---

# Import External Sessions

Walnut automatically imports sessions that were started outside it (someone ran
`claude` in a terminal, used Claude Desktop or the codex TUI, or another SDK
app spawned sessions). A background job runs every 10 minutes; this skill is
the on-demand path.

Each imported session becomes **its own task**, titled with the session's
auto-generated name, grouped under a per-host project: **"Imported from this
Mac"** / **"Imported from \<host\>"**.

## Run an import now

```bash
curl -s -X POST http://localhost:3456/api/sessions/import-external \
  -H 'Content-Type: application/json' -d '{"days":30}'
```

- `days` widens/narrows the lookback window (default 30).
- Response fields: `imported` (new tasks created), `skipped` (already tracked),
  `hostsScanned` / `hostsSkipped` (a skipped host = its daemon isn't connected
  or is too old — it self-heals on the next daemon auto-deploy),
  `truncated` (hit the 100-per-run cap — **run the command again** until
  `imported` is 0 and `truncated` is false to drain a big backlog).

## Check whether a specific session made it in

```bash
walnut sessions --json | grep <session-id-prefix>
```

If it's missing after an import run, the usual reasons:

1. **Host not scanned** — check `hostsSkipped` in the response. The host's
   daemon must be connected and advertise `external-scan-v1`.
2. **Older than the window** — re-run with a bigger `days`.
3. **Temp-dir session** — programmatic (SDK) sessions running under /tmp or
   test directories are deliberately skipped as test debris. Human sessions
   (terminal/desktop) are always imported regardless of directory.

## What gets imported

| Source | Imported? |
|---|---|
| Terminal `claude` / Claude Desktop | Always |
| codex TUI / Codex Desktop | Always |
| Other SDK apps (agent orchestrators) | Only from real (non-temp) directories |
| Walnut's own sessions | Never (already tracked) |
| Subagent sidechains, temp-dir test runs | Never |

Everything is read-only on the transcripts; importing never modifies the
original session files, and re-running is always safe (already-imported
sessions are skipped).
