# walnut-trigger: a session attaches a check script to itself, the daemon runs it

## Executive summary

A trigger is a routine plus a `check` script. From any session, `/walnut-trigger` lets the agent write a small script that says whether something happened, and tell Walnut what to do when it does. The daemon on the session's host owns the clock and runs the script; the server stores the routine, pushes it to the daemon, receives fire events, and delivers the prompt into the session (restarting it on the same task if it died). Nothing new is invented on the outcome side: fires reuse the existing executors, so "Trigger is a superset of Routine" is literally true. The model-driven watcher executor (v1) stays as the fallback for sources that have no script-able API.

Four calls made here:

1. **The daemon owns the clock and the run.** A check is host work: it reads that host's files, runs that host's `gh`/`curl`, and must keep polling while the server restarts or the tunnel flaps. The server never runs a script and never ticks a check job; it only stores, pushes, receives, delivers, and displays.
2. **The server owns delivery and policy.** Task-to-session resolution, mid-turn queueing, restart-on-task, notifications, run history and auto-disable already live in one place. Duplicating them in two daemon twins would be the anti-pattern this repo keeps paying for. A fire crosses the tunnel as a few hundred bytes of JSON.
3. **Short scripts run repeatedly; no long-running scripts.** A resident process is something to babysit (crashes, sleeps, daemon restarts, pid leaks). `every: 30s` covers "keep watching"; a script that must block can `timeout 25s wait ...` and return.
4. **A trigger is stored as a routine.** No new store, no new page. The Routines page shows it, the enable toggle is the kill switch, run history is the existing history.

This supersedes the `command` probe half of `docs/plan/task-watchers.md`; the `agent` probe half shipped as the watcher executor.

## Architecture

```
 agent in a session                      Walnut server                          daemon on the session's host
 ──────────────────                ────────────────────────────────            ─────────────────────────────
 /walnut-trigger "tell me when             (API, storage, delivery, UI)              (clock, run, dedup state)
   someone comments on my PR"
   │ reads the skill, writes check.sh
   │ trigger_test ─────────────────▶ POST /routines/check-test ──▶ triggers.test ──▶ sh -c run (no state write)
   │                                 ◀── parsed output, wouldFire ◀──────────────────
   │ trigger_create ───────────────▶ POST /routines {schedule, check, executor}
                                     │ store; push set to that host ──▶ triggers.configure {triggers:[...]}
                                     │                                    │ persist triggers.json, arm timers
                                     │                                    │ every N: sh -c run, stdin {state}
                                     │                                    │   fire:false → trigger.checked quiet
                                     │                                    │   fire:true  → dedup items[].id (seen)
                                     │                                    │      nothing new → quiet
                                     │ ◀── trigger.fired {items,input} ◀──┘      new → mark seen, queue, send
                                     │ build <walnut-message kind="trigger">
                                     │ runExecutor(job, executor, message)
                                     │   session    : live or stopped session on task → send (stopped = cold resume); none → new session on task
                                     │   claude-code: a new session per fire
                                     │   watcher    : the model looks itself (no check; v1 fallback)
                                     │ applyJobResult, history, auto-disable ──▶ triggers.ack {triggerId, seq}
```

Ownership in one line: **daemon = when and whether, server = who and what.**

## The interface (three things)

### when

The existing `schedule`. A check trigger uses `every` (a poll is an interval, not a wall clock). `cron` expressions stay on the server engine for time-only routines; a check trigger with a `cron` schedule is refused at save time with the reason. Phase 2 may bundle a cron parser into the daemon.

### check

```jsonc
{
  "run": "bash ~/.open-walnut/triggers/pr-comments/check.sh",   // any shell command; keep credentials in the script, never in run
  "cwd": "/path/to/repo",        // default: the creating session's cwd
  "host": "__local__",           // default: the creating session's host; the daemon that runs it
  "timeoutSeconds": 30           // max 300
}
```

The script receives on stdin one JSON object: `{"state": <last state or null>, "lastFireAt": "<ISO>" | null, "now": "<ISO>"}`. It prints one JSON object as the LAST line of stdout:

```jsonc
{"fire": true,
 "items": [{"id": "PR-123#c9", "title": "...", "url": "..."}],   // optional; ids are deduped by the daemon
 "input": "free text the AI receives with the prompt this run",   // optional, max 8 KB
 "state": {"cursor": "2026-09-11T10:00:00Z"}}                      // optional; stored verbatim, fed to the next check
{"fire": false, "state": {...}}
```

`input` and `state` point in opposite directions and are never merged: `state` is the script talking to its next run, `input` is the script talking to the AI this run. Non-zero exit, timeout, no JSON on the last line, or stdout over 64 KB is a check error.

Dedup: `items[].id` goes into a per-trigger `seen` set (2000 ids, 30 days). `fire:true` with items that are all seen is quiet. `fire:true` with no `items` fires every time (the script did its own judging). Seen is written only after the fire is queued for delivery, never for a quiet run.

### then

`then` is the executor. New `session` executor:

```jsonc
{"type": "session", "config": {"target": "<taskId>", "prompt": "New review comments. Read each one; change code where it asks."}}
```

`trigger_create` accepts `session: "this"` and resolves it at creation time to the caller's task id (`x-walnut-caller-sid`, stamped by the ops executor from `WALNUT_SESSION_ID`), so the routine card shows what it points at and a fork or rewind cannot lose it. On fire: the session on that task gets `sendMessageToSession`, whether its CLI is alive (running or idle: the FIFO delivers into the turn) or STOPPED (the idle reaper killed the CLI after a couple of quiet hours; the transcript is intact and the send cold-resumes it, exactly as the user's own next message would). This matters because a trigger typically fires hours after the session that created it went quiet, and the conversation that asked for the watch is the one that should hear the result. Only when no resumable session exists (never had one, or the last one ended in `error`) and the task is still open does it get `quickStartSession({existingTaskId})`, a new session on the same task; a completed or deleted task is an error plus a notification, never a resurrected task. The pick is `pickDeliverySession` in `src/core/routines/session-target.ts`, shared with the watcher's singleton. "Open a small session per fire" is the existing `claude-code` executor.

The message is one envelope v2 tag, `<walnut-message kind="trigger" from="Trigger: <name>" note="fired <ISO>, N new items">`, body = `then.prompt`, then the items as JSON, then `input`. The web parser (`web/src/components/sessions/session-envelope.ts`) knows the `trigger` kind: the card's head reads "Trigger fired" (or "Routine ran on schedule" for a plain `session` run, `note="scheduled"`), the title is the routine's name, the status line is the daemon's note, the body is the delivery, and there is no session chip because a routine is not a session. Without that entry the tag degrades to raw text in the bubble on purpose (unknown kinds must never be guessed), which is exactly how a missing renderer would show.

## Server to daemon protocol

| Direction | Message | Purpose |
|---|---|---|
| server → daemon | `triggers.configure {config: {version: 1, triggers: [{id, name, everyMs, check: {run, cwd, timeoutSeconds}, limits: {maxFiresPerDay}}]}}` | The authoritative set for that host. Sent on daemon connect and after every routine mutation that touches a check job on that host; hash-skipped when nothing changed (the `hooks.configure` precedent). A trigger missing from the set is disarmed but its state file is kept (pruned by age after 30 days), so disable then enable, or a foreign empty push, does not lose `seen`, the cursor, or unacked fires. |
| server → daemon | `triggers.test {check, triggerId?}` | Run once with no state read or write; returns `{ok, exitCode, durationMs, stdoutTail, stderrTail, parsed, wouldFire, newItemCount}`. Backs `trigger_test` and the form's Test button. |
| server → daemon | `triggers.run {triggerId}` | Start one armed trigger's check now, through the normal path (state, dedup, events); answers `{ran, started}` at once and the outcome arrives as an event. Backs "Run now". |
| server → daemon | `triggers.ack {triggerId, seq}` | The fire was processed; the daemon drops it from `pendingFires`. Withheld for a fire whose delivery failed transiently (the daemon then replays it) and for a fire whose routine this server never pushed (it may be another server's). |
| daemon → server | `trigger.checked {id, atMs, outcome: "quiet" \| "error", reason?, error?, durationMs, nextRunAtMs, consecutiveErrors}` | History, the card's "checked 3m ago, quiet", consecutive-error counting. `reason` is `fire-false`, `all-seen`, or `rate-limited`. |
| daemon → server | `trigger.fired {id, epoch, seq, atMs, items, input?, itemsTruncated?, durationMs, nextRunAtMs, replay?}` | The fire, sent to every trusted client. At-least-once: persisted in the daemon's `pendingFires` until acked, replayed after `triggers.configure` and about once a minute while unacked. The server dedups on `(id, epoch, seq)`; `epoch` is minted with the state file, so a daemon whose counter restarted (the file was recreated) does not have its next fires swallowed as replays. |

The trigger id rides `triggerId`, never `id`: a daemon frame is `{id, cmd, ...params}` where `id` is the RPC correlation slot, so a trigger id sent as `id` overwrites it and the reply can never be matched.

Daemon state lives in its own directory (`triggers.json` for the set, `trigger-state/<id>.json` for `seen`, `state`, `fires today`, `pendingFires`, `consecutiveErrors`). Loaded at boot so checks keep running while the server is down; the next `triggers.configure` replaces the set. Capability `triggers-v1`; an older daemon makes `trigger_create` for that host answer 400 with "upgrade the daemon on <host> (it auto-deploys on the next send)".

Server side, a check job is never ticked by the cron timer (`findMissedJobs` skips jobs with `check`); its `nextRunAtMs` is whatever the daemon last reported. Fires and check errors go through the existing `applyJobResult`, so run history, `consecutiveErrors` and the events feed are the same as every other routine. Quiet checks update `state.lastCheck` only. Five consecutive check errors disable the routine and notify; the next push removes it from the daemon.

## Limits (cron storms have burned this repo)

| Limit | Default | On breach |
|---|---|---|
| check timeout | 30s (max 300) | kill the process group, check error |
| stdout | 64 KB | check error (never guess from a truncated line) |
| `input` | 8 KB | truncated with a marker |
| fires per day per trigger | 24 (0 = no cap) | daemon reports `quiet` with `reason: "rate-limited"`, no delivery |
| consecutive check errors | 5 | server disables the routine and notifies |
| overlapping runs | never | a check still running when the next tick lands is skipped |
| delivery attempts per fire | 3 | a transient delivery failure (throw, timeout, host unreachable) leaves the fire unacked so the daemon replays it; after three the fire is recorded as failed, acked, and the user notified |
| `seen` set | 2000 ids, 30 days | oldest evicted |
| `pendingFires` | 50 | oldest dropped, logged |

## The skill: `/walnut-trigger`

Shipped at `src/data/skills/walnut-trigger/SKILL.md`. The `/` palette lists every shipped skill by directory name and sends "Apply your walnut-trigger skill now. Request: ...", so no CLI-side install is needed. The skill tells the agent: the contract above, two templates (bash + jq, node), and the order of operations: write the script under `~/.open-walnut/triggers/<slug>/`, run `trigger_test` until it parses, tell the user in one line what will be watched and how often, then `trigger_create`, then report the id and the next check time. Default cadence when the user gave none: every 5 minutes.

Ops (`src/ops/triggers.ts`, rendered as CLI, MCP and the in-session gateway by the registry): `trigger_create`, `trigger_list`, `trigger_test`, `trigger_delete`.

## UI

Routines card: a Trigger badge when `check` is set, the `run` command (truncated), host, and the last check (`fired, 2 items, 3m ago` / `quiet, 3m ago` / `error: ...`). The form gains an optional Check section (run, timeout, host) with a Test button, so the manual path exists next to the agent path.

## Boundaries (not in this slice)

Long-running scripts; webhook or event sources; an MCP client; `cron` schedules on check triggers; direct daemon-to-FIFO delivery when the server is down (the daemon queues the fire instead).

## Phases

1. Contract and daemon: shared pure logic in `src/providers/trigger-check-core.ts` (parse, dedup, limits), then both daemon twins (`triggers.configure`, `triggers.test`, `triggers.run`, `triggers.ack`, the scheduler, the runner, events, persistence, boot reload), capability `triggers-v1`.
2. Server: `check` on `CronJob` with save-time validation, the timer skip, the push module, the event handlers, the `session` executor, `POST /routines/check-test`, ops, the skill.
3. UI: card badge and last check, form Check section.
4. Later: daemon-side cron parsing, `trigger_pause`, showing the last fire's items on the card.

## Acceptance matrix

| Layer | Scenarios |
|---|---|
| unit (core) | parse: valid / multi-line stdout takes the last JSON line / not JSON / empty / 64 KB cap; dedup: all seen → quiet, some new → only new delivered, no items → fire; state round trip; `input` cap; 24 fires per day; consecutive errors; overlap skip |
| daemon (real binary, isolated dir) | configure → tick → `trigger.fired` arrives; quiet second tick on the same items; timeout kills the process group; boot reload from `triggers.json`; pending fire replayed after reconnect; ack clears it |
| API e2e (`startServer`, mock CLI, real local daemon) | `trigger_create` with `this` resolves to the caller's task; a fire delivers the envelope to the mock CLI's stdin; session stopped → resumed, not replaced; no resumable session → a new one on the same task; task COMPLETE → error + notification; `cron` schedule on a check job → 400; old daemon → 400 with the upgrade hint; `check-test` writes no state; 5 errors → disabled + notified |
| Playwright (Chromium + WebKit) | `/` palette lists `walnut-trigger` and sends the skill message; the card shows the badge and all three last-check states; the form's Check section round-trips; a fire envelope in a transcript renders as a trigger card, never as a raw tag (`session-provenance-card.spec.ts`) |
| live | a real session runs `/walnut-trigger`, the agent writes and tests a script, a file appears in the watched directory, the card lands in the session transcript |
