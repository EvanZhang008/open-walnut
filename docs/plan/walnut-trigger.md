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
   │ trigger_create ───────────────▶ POST /routines {schedule, check, executor, description}
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
| server → daemon | `triggers.configure {config: {version: 1, triggers: [{id, name, everyMs, check: {run, cwd, timeoutSeconds}, limits: {maxFiresPerDay}, deliver?: {home, taskId, prompt}}]}}` | The authoritative set for that host. Sent on daemon connect and after every routine mutation that touches a check job on that host; hash-skipped when nothing changed (the `hooks.configure` precedent). A trigger missing from the set is disarmed but its state file is kept (pruned by age after 30 days), so disable then enable, or a foreign empty push, does not lose `seen`, the cursor, or unacked fires. |
| server → daemon | `triggers.test {check, triggerId?}` | Run once with no state read or write; returns `{ok, exitCode, durationMs, stdoutTail, stderrTail, parsed, wouldFire, newItemCount}`. Backs `trigger_test` and the form's Test button. |
| server → daemon | `triggers.run {triggerId}` | Start one armed trigger's check now, through the normal path (state, dedup, events); answers `{ran, started}` at once and the outcome arrives as an event. Backs "Run now". |
| server → daemon | `triggers.ack {triggerId, seq}` | The fire was processed; the daemon drops it from `pendingFires`. Withheld for a fire whose delivery failed transiently (the daemon then replays it) and for a fire whose routine this server never pushed (it may be another server's). |
| server → daemon | `triggers.claim {triggerId, epoch?, seqs}` | Sent the moment a fire arrives (capability `trigger-claim-v1`). Answers `{claimed, unknown, host, busy, foreign?}`: a claimed or unknown seq is this server's to deliver; a `host` seq was already delivered by the host (record it); `busy` is being written by the host right now and `foreign` means another Walnut's socket asked, so the server neither delivers nor acks and the replay asks again. A claim that gets no answer is treated the same way, never as permission. |
| daemon → server | `trigger.checked {id, atMs, outcome: "quiet" \| "error", reason?, error?, durationMs, nextRunAtMs, consecutiveErrors}` | History, the card's "checked 3m ago, quiet", consecutive-error counting. `reason` is `fire-false`, `all-seen`, or `rate-limited`. |
| daemon → server | `trigger.fired {id, epoch, seq, atMs, items, input?, itemsTruncated?, durationMs, nextRunAtMs, host?, replay?}` | The fire, sent to every trusted client. `host: {atMs, sessionId, messageId, seqs}` marks a fire the host delivered itself (below). At-least-once: persisted in the daemon's `pendingFires` until acked, replayed after `triggers.configure` and about once a minute while unacked. The server dedups on `(id, epoch, seq)`; `epoch` is minted with the state file, so a daemon whose counter restarted (the file was recreated) does not have its next fires swallowed as replays. |

The trigger id rides `triggerId`, never `id`: a daemon frame is `{id, cmd, ...params}` where `id` is the RPC correlation slot, so a trigger id sent as `id` overwrites it and the reply can never be matched.

Daemon state lives in its own directory (`triggers.json` for the set, `trigger-state/<id>.json` for `seen`, `state`, `fires today`, `pendingFires`, `consecutiveErrors`). Loaded at boot so checks keep running while the server is down; the next `triggers.configure` replaces the set. The per-trigger files must outlive a reboot, which the production runtime dir (`/tmp/open-walnut`) does not: the production daemon keeps them in `~/.open-walnut/tmp/trigger-state/`, a service daemon in its state dir, an isolated daemon dir inside itself. A file still in the old dir is moved the first time its trigger is armed. (2026-10-06: a reboot emptied `/tmp`, and a watch re-reported every item it had already reported and restarted the week its script was counting.) Capability `triggers-v1`; an older daemon makes `trigger_create` for that host answer 400 with "upgrade the daemon on <host> (it auto-deploys on the next send)".

### Who delivers a fire: the daemon decides

Delivery used to need the server, so a fire waited in `pendingFires` while the Mac slept, even when the target session ran on the same host. On 2026-10-05 a one-minute chat monitor fired five times between 20:59Z and 21:33Z while the Mac was in clamshell sleep; its target session sat idle on that host the whole time, and the fires arrived together at 21:40 during one dark wake, up to 42 minutes late.

Now every fire has one owner, chosen by the daemon (`trigger-claim-v1`):

1. The server claims each fire as it arrives (`triggers.claim`, batched per trigger). A claimed fire is the server's for good; the host never delivers it, however late the ack.
2. A fire no server claimed within `HOST_DELIVERY_GRACE_MS` (30s from the fire, or from when this daemon armed the trigger after a restart) is delivered by the host when the def carries `deliver` and the target task has a live session of that Walnut on this host (the offline host's copy, `deliverTrigger`). Every due fire of one trigger goes as one envelope, built by the same `buildTriggerMessage` the server uses (`src/providers/trigger-envelope-core.ts`, shipped to the source twin in the `trigger-check-core.cjs` sidecar). The fire stays in `pendingFires` with `host` set.
3. The replay carries `host`, so the server records the fire (history row "<host> sent it to session …", the host's time, a WAITING target woken unless it was parked again after that delivery) and acks it. Nothing is delivered twice.

What stays with the server: a target with no live session here (resuming or starting one needs the launch recipe), a COMPLETE target (the server refuses and tells the user), and any fire made while the def had no `deliver` (`arbitrated` is unset on it: an older server may have delivered it without claiming). A failed host write is retried after `HOST_DELIVERY_RETRY_MS`. Covered by `tests/integration/trigger-host-delivery-daemon.test.ts` (both twins), `tests/e2e/trigger-host-delivery.test.ts` and `tests/providers/trigger-host-delivery.test.ts`.

Server side, a check job is never ticked by the cron timer (`findMissedJobs` skips jobs with `check`); its `nextRunAtMs` is whatever the daemon last reported. Fires and check errors go through the existing `applyJobResult`, so run history, `consecutiveErrors` and the events feed are the same as every other routine. Quiet checks update `state.lastCheck` only. Five consecutive check errors disable the routine and notify; the next push removes it from the daemon.

## Limits (cron storms have burned this repo)

| Limit | Default | On breach |
|---|---|---|
| check timeout | 30s (max 300) | kill the process group, check error |
| stdout | 64 KB | check error (never guess from a truncated line) |
| `input` | 8 KB | truncated with a marker |
| fire budget per trigger (`maxFiresPerDay`) | 24 in a burst, refilling 24 per 24h (0 = no cap) | daemon reports `quiet` with `reason: "rate-limited"` and holds the fire: no delivery, no seen ids, and the script's `state` from that run is NOT saved, so the next allowed check reports the same items again; the server notifies the user once a day |
| consecutive check errors | 5 | server disables the routine and notifies |
| overlapping runs | never | a check still running when the next tick lands is skipped |
| delivery attempts per fire | 3 | a transient delivery failure (throw, timeout, host unreachable) leaves the fire unacked so the daemon replays it; after three the fire is recorded as failed, acked, and the user notified |
| `seen` set | 2000 ids, 30 days | oldest evicted |
| `pendingFires` | 50 | the oldest fire the host already delivered is dropped first, then the oldest |

The fire budget used to be a counter per calendar day on the host, and a held fire still saved the script's new cursor. On 2026-10-01 a chat monitor checked every 5 minutes spent its 24 fires by mid-afternoon; its host runs on UTC, so it went dark from 17:00 Pacific until midnight UTC, and every message in that window was lost, because the cursor had already moved past them. The budget (`budget: {used, atMs}` in the state file, `fireBudgetNextAtMs` in `trigger-check-core.ts`) now drains continuously, the spend is clamped to the cap so a lowered cap holds a trigger for one refill rather than days, and a held run keeps the old cursor. Holding makes backlogs longer, so the per-fire item cap (200) now applies to NEW items after dedup, and a fire that could not carry them all keeps the old cursor as well: the next check reports the rest. A stored `0` ("no limit") is sent to the daemon as `FIRE_BUDGET_UNLIMITED` (`wireFireCap` in `trigger-push.ts`), since every daemon refuses a cap below 1; a cap sized to the cadence would hold a once-a-day trigger after a Run now.

## The skill: `/walnut-trigger`

Shipped at `src/data/skills/walnut-trigger/SKILL.md`. The `/` palette lists every shipped skill by directory name and sends "Apply your walnut-trigger skill now. Request: ...", so no CLI-side install is needed. The skill tells the agent: the contract above, two templates (bash + jq, node), and the order of operations: write the script under `~/.open-walnut/triggers/<slug>/`, run `trigger_test` until it parses, tell the user in one line what will be watched and how often, then `trigger_create` with a required `description` (one or two sentences for the user: what is watched, when it fires, what the session does; at most 600 characters, shown on the trigger card), then report the id and the next check time. Default cadence when the user gave none: every 5 minutes. The composer's "+" menu has a "Set up a trigger" row that starts the message with `/walnut-trigger `.

Ops (`src/ops/triggers.ts`, rendered as CLI, MCP and the in-session gateway by the registry): `trigger_create`, `trigger_list`, `trigger_test`, `trigger_pause`, `trigger_resume`, `trigger_delete`.

## UI

Routines card: a Trigger badge when `check` is set, the `run` command (truncated), host, and the last check (`fired, 2 items, 3m ago` / `quiet, 3m ago` / `error: ...`). The form gains an optional Check section (run, timeout, host) with a Test button, so the manual path exists next to the agent path.

## Pause and resume

A trigger is armed (polling), paused (switched off by a person or an agent: `enabled:false` with `state.pausedAtMs`, stamped by the cron service's `toggle` and `update`), stopped (switched off by the server after `MAX_CONSECUTIVE_CHECK_ERRORS` failed checks in a row, which never passes through `toggle`/`update`, so it carries no `pausedAtMs`), or wait-ended (switched off by the snooze wait it ended, `state.waitEndedAtMs`; `task_wait` with the same `routine_id` re-arms it, and the task card never shows it). A trigger switched off before `pausedAtMs` existed reads as paused unless its errors reached the limit. The one rule is `triggerRunState` (`src/core/cron/trigger-run-state.ts`, shared by `trigger_list` and the web).

Pausing only drops the trigger from the host's `triggers.configure` set, so the daemon disarms it and KEEPS its state file (seen ids, script cursor, unacked fires). A check already running when the pause lands still reports; the server records it but shows no next run and never stops (auto-disables) a paused trigger for it.

Resume: deliver once, no storm. Re-arming reads the kept state file, so the first check (about 5 seconds after resume) runs with the saved cursor and sees everything that appeared while paused; `decideCheck` turns it into ONE fire carrying all the new items (up to `CHECK_ITEMS_CAP` = 200; the unseen rest fire on the next check), drops ids seen in the last 30 days (`SEEN_TTL_MS`, 2000 ids), and still spends the fire budget (a spent budget holds the backlog, unseen and with the old cursor, until the next allowed check). Unacked fires from before the pause are replayed once and deduped on `(id, epoch, seq)`. The state file is pruned when it has not been written for 30 days, counted from the last check before the pause and applied at the next configure or daemon start, so a pause past that may lose the memory: the trigger then starts over like a new one (its first check may fire on everything the script reports). Resuming a paused trigger starts its error count over (a late failing check from before the pause does not count); resuming a stopped one keeps it, so one more failure stops it again.

UI: the task keeps showing a paused or stopped trigger. The TRIGGER pill always reads `TRIGGER` (no count, no PAUSED): solid while something on the task polls, dashed and muted when nothing does, and in a narrow task column it folds to `T`; the flyout row carries a Paused/Stopped badge, no next run, and Resume in place of Pause and Run check now. The routine behind an ended snooze wait is switched off by the wait itself and stays hidden, as before. The Routines card's switch reads On / Paused / Stopped.

## Boundaries (not in this slice)

Long-running scripts; webhook or event sources; an MCP client; `cron` schedules on check triggers; resuming or starting a session from the host when the server is down (a fire for a task with no live session on its host waits for the server).

## Phases

1. Contract and daemon: shared pure logic in `src/providers/trigger-check-core.ts` (parse, dedup, limits), then both daemon twins (`triggers.configure`, `triggers.test`, `triggers.run`, `triggers.ack`, the scheduler, the runner, events, persistence, boot reload), capability `triggers-v1`.
2. Server: `check` on `CronJob` with save-time validation, the timer skip, the push module, the event handlers, the `session` executor, `POST /routines/check-test`, ops, the skill.
3. UI: card badge and last check, form Check section.
4. Later: daemon-side cron parsing, showing the last fire's items on the card. (`trigger_pause` / `trigger_resume` shipped; see Pause and resume below.)

## Acceptance matrix

| Layer | Scenarios |
|---|---|
| unit (core) | parse: valid / multi-line stdout takes the last JSON line / not JSON / empty / 64 KB cap; dedup: all seen → quiet, some new → only new delivered, no items → fire; state round trip; `input` cap; 24 fires per day; consecutive errors; overlap skip |
| daemon (real binary, isolated dir) | configure → tick → `trigger.fired` arrives; quiet second tick on the same items; timeout kills the process group; boot reload from `triggers.json`; pending fire replayed after reconnect; ack clears it |
| API e2e (`startServer`, mock CLI, real local daemon) | `trigger_create` with `this` resolves to the caller's task; a fire delivers the envelope to the mock CLI's stdin; session stopped → resumed, not replaced; no resumable session → a new one on the same task; task COMPLETE → error + notification; `cron` schedule on a check job → 400; old daemon → 400 with the upgrade hint; `check-test` writes no state; 5 errors → disabled + notified |
| Playwright (Chromium + WebKit) | `/` palette lists `walnut-trigger` and sends the skill message; the card shows the badge and all three last-check states; the form's Check section round-trips; a fire envelope in a transcript renders as a trigger card, never as a raw tag (`session-provenance-card.spec.ts`) |
| live | a real session runs `/walnut-trigger`, the agent writes and tests a script, a file appears in the watched directory, the card lands in the session transcript |
