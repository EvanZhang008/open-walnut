# Logs and debugging

Where every log lands, the log investigation toolkit, the stall flight recorder, debugging send latency, and debugging the Claude Code CLI itself.

_Moved from the root `AGENTS.md` on 2026-11-11; the root file keeps a one-line summary of each rule._

## Frontend logging

Use the structured logger (`log.info('subsystem', 'message', { sessionId, taskId })`): never raw `console.log`. IDs must be **full, never truncated** so `grep <sessionId>` traces across browser + server. The logger routes through `console.log`/`warn`/`error` which the browser-logger monkey-patch forwards to `/tmp/open-walnut/`. Never use `console.debug` (invisible to forwarder).

## Where logs land (browser crashes included)

| What | Where |
|---|---|
| Server structured JSON (+ forwarded browser console) | `/tmp/open-walnut/open-walnut-<date>.log`: filter browser lines with `jq 'select(.subsystem=="browser")'` or `open-walnut logs -s browser` |
| Every HTTP request (method/path/status/ms/reqId) | same file, `subsystem=web` (request-logger middleware) |
| Uncaught JS exceptions / unhandled rejections / React render crashes | forwarded as `subsystem=browser` `[uncaught]` / `[unhandledrejection]` / `[react]` / `[error-boundary]` entries. Delivery: WS RPC when connected; REST `POST /api/browser-logs` fallback when WS is down (e.g. crash before mount) |
| Daemon logs | `~/.cache/open-walnut/daemon-d-*.log` (the daemon's own dir; `/tmp/open-walnut` on an install whose daemon still runs from there). `scripts/walnut-logs.sh daemon <sid>` reads both |
| Server exit trace | `/tmp/open-walnut-exit.log` |

Two dirs, chosen apart (`src/lib/daemon-dir.ts`; `scripts/lib/daemon-dir.sh`, which
`walnut-logs.sh` sources, is its sh twin, and `tests/scripts/daemon-dir-sh.test.ts` runs both on
the same cases):

- **The log dir**, the server's scratch (logs, pasted pictures, incident bundles, terminal
  sockets): `/tmp/open-walnut`, where the system's temp cleanup removing what nobody touched for
  days is wanted. It belongs to the first Unix user who starts Walnut on a machine; anyone else's
  Walnut uses `~/.cache/open-walnut` (the exit trace is `exit.log` inside it).
- **The daemon's dir**, the local session daemon's own files (`daemon.port`, `daemon.pid`,
  `daemon.instance`, `sessions.json`, its sockets, programs, trigger state and logs):
  `~/.cache/open-walnut`, which no temp cleanup empties. It was `/tmp/open-walnut` until
  2026-11-26: the temp cleanup (macOS: files untouched for 3 days; systemd-tmpfiles: 10 days) then
  removed a running daemon's files, and whoever looked for the daemon by them started a second
  one that gave way to the first, so no session started. Nothing that runs is moved: a running
  daemon keeps its dir, so does the dir a login service pins, and so does the dir a daemon wrote
  its files in since the machine booted (its sessions may still run), so an existing install
  changes dir at its next reboot. `/tmp/open-walnut` is still the daemon's dir when the home dir
  cannot hold it (its socket paths would be too long, or it cannot be written). The daemon ages
  its own scratch there (old daemons' logs after 14 days, pictures nobody read for 10 days:
  `pruneDaemonScratch` in `src/providers/daemon-core.ts`). A release from before the move starts
  its daemon in `/tmp/open-walnut` whenever it sees none running (after a downgrade, or beside a
  newer server), so the home daemon also holds that dir's instance lock and leaves
  `/tmp/open-walnut/sessions.json` there as a link to its registry
  (`src/providers/daemon-older-release-door.ts`): the older daemon gives way while the home one
  runs, and adopts the sessions that still run once it stopped, instead of cutting them off. The
  dir rule never counts a link as a daemon's file.

The server always names the daemon's dir to its daemon
(`WALNUT_DAEMON_DIR`); both daemon builds treat either dir as production. A second user's remote terminal
sockets go to `/tmp/open-walnut/term-<local uid>` on the remote host. 2026-10-30: a second user's server exited at
boot with `EACCES: permission denied, mkdir '/tmp/open-walnut/streams'`.

**"Blank page" triage:** grep the local-date AND previous-day files (UTC timestamps vs local filename!) for `error-boundary`, `\[react\]`, `\[uncaught\]`, and `JSON parse failed`. A repeated crash self-heals via `web/src/utils/crash-recovery.ts` (clears sessionStorage → then walnut localStorage keys + skips one prefs merge); the heals also log `[crash-recovery]`.

## Browser main-thread block reports

`[perf] main-thread block` (`subsystem=browser`) comes from `web/src/utils/main-thread-tracer.ts`:
a 100 ms sampler that reports a wakeup 250 ms or more late, at most 12 a minute per tab. Each report
names what ran in its window: `activePhases` / `endedDuringBlock` (code bracketed with
`tracePhase`), `slowCallbacks` (any timer, frame, WebSocket or MessagePort callback of 100 ms or
more; `port:onmessage` is React's scheduler, so a render). A block nothing traced explains carries
instead (`web/src/utils/block-context.ts`): `draws` (the components that drew in it, top three, from
`countRender`), `domMutations` (child and text changes), `focused` (the window had focus) and
`sinceInputMs` (time since the last pointer, key, wheel or touch input). Such a block is usually
style, layout and paint after a DOM change, a promise continuation, or garbage collection, none of
which runs inside a traced callback.

WebKit timer alignment is not a block. The Mac app's WKWebView aligns a visually idle page's
timers to whole seconds on one fixed sub-second phase per page load, but only timers nested 10
deep. While the page may be in use, the sampler re-arms from a MessageChannel message (nesting
level 0), so WebKit never aligns it. That costs about 10 wakeups a second where WebKit would
coalesce to about 1, so a hidden page, or an unfocused window with no input for 30 s, re-arms
from its timer and lets the browser throttle and align it; focus or input brings the message
back at the next sample. `web/src/utils/timer-alignment.ts` counts aligned wakeups in
`[perf] timers throttled (page idle)` / `timers throttled ended` and never reports them: a quiet
late wakeup (nothing traced, no input in the second before, at most 1015 ms late) is held for one
tick; the next tick exactly one second later makes both alignment and teaches the phase
(`phaseMs`); within the run, a quiet wakeup within 15 ms of that phase is alignment, and so is the
early release of a timer held for the next aligned point. The phase is forgotten when its run
ends, except in the unfocused idle mode, where the next run's first tick is caught by the phase
alone. A block with anything traced, during input, or later than 1015 ms is always reported. A
quiet block is reported one tick late, or on `pagehide`, which also sends it. 2026-11-23: 158
reports in a day in the Mac app, mostly alignment while nobody used the window. Tests:
`tests/web/main-thread-tracer-throttle.test.ts`.

The browser log forwarder folds consecutive identical messages into one line with a `count` field
that keeps only the first line's arguments, so count reports by `count`, not by lines.

## Log investigation toolkit: scripts/walnut-logs.sh

One entry point for digging through Walnut logs (structured JSON at `/tmp/open-walnut/open-walnut-<date>.log`). Needs `jq`.

```bash
scripts/walnut-logs.sh diagnose [sid] [mins]  # ⭐⭐ START HERE for "message is slow": auto-labels each send's cause
scripts/walnut-logs.sh busstorm [sid] [mins]  # ⭐ streaming fan-out per subscriber (verify interest-set / spot a storm)
scripts/walnut-logs.sh trace <sid>       # per-message timeline dispatch→RPC→enqueue→route→delivered + Δms/hasPipe/path
scripts/walnut-logs.sh pipe <sid>        # hasPipe / lifecycle transitions: why a send was queued
scripts/walnut-logs.sh session <sid>     # full timeline for a session
scripts/walnut-logs.sh delivery [sid]    # message enqueue→delivered latency (deliveryMs)
scripts/walnut-logs.sh slow [ms]         # deliveries slower than ms (default 3000): find lag
scripts/walnut-logs.sh daemon <sid>      # which daemon-d-*.log serves a sid
scripts/walnut-logs.sh jsonl <sid>       # tail the session's CLI .jsonl stream
scripts/walnut-logs.sh file <substr>     # ⭐ ONE timeline for ONE file: reads + writes + refusals + the editor's decisions
scripts/walnut-logs.sh stalls [mins]     # ⭐ "the server froze": stall flight records (verdict, loop CPU vs hold, GC, paging) + kept CPU profiles
scripts/walnut-logs.sh req <id> | task <id> | errors [n] | tail [n]
```

**When the whole server froze, run `stalls` before anything else.** The stall flight recorder
(`src/core/stall-recorder.ts`) keeps a CPU profile of every hold of 2 s or more and tags it with a
verdict; `bun scripts/stall-profile-summary.mjs` (newest profile, or a path) prints the functions
the loop was in during the hold, with file:line. `cpu` means Walnut code held the loop, also on a
busy machine (`loadStretched: true` then says the load made it longer). Fix that code first. The
hold itself (`holdCpuMs`, `holdFromMs` to `holdToMs` around the deadline) runs from the last CPU
checkpoint before the deadline to the first one after it; checkpoints are the previous probe tick and a
100 ms timer, so a stop is a gap between two of them. The rules (`holdVerdict` in `src/core/stall-recorder-hold.ts`): the thread ran a
stall's worth of CPU (250 ms) in the hold and the kept profile, when it sampled the hold, mostly
shows code there (`profileHold`, with its top frames; time the sampler missed counts as nothing and
`coverage` says how much it saw); or it ran 250 ms up to the probe (`afterHoldCpuMs` is the part
after the hold, `profileAfter` the profile's view of it), counting only the part after the span when
it ran under half of a span of 250 ms or more, and only past the largest turn the loop ran normally
(`baseTurnMs`) when the span was shorter than that; or it ran 60% of the window. The first two count
only the CPU past the backlog of time the loop did not run its work: a pause right before the hold
(`afterWaitMs`) or between the hold and the probe (`afterHoldPauseMs`), each a second or more the
thread ran under a tenth of and under 250 ms in, in poll or not (more is a block load stretched, not
a pause), a wait in poll inside the hold of a second or more or most of it (`loopIdleMs`), a span
the thread barely ran in. Each owes twice the loop's own rate in its normal turns over the 10 s
before (`baseCpuShare`; read further back, up to a minute, when blocks and pauses filled those 10 s)
times its length, and all of its CPU when that rate is unknown. Trust the profile's functions only
for `cpu` or `gc`: profiles sample on a wall clock, so a `starved` thread (runnable, not run, and
with little of its own to run: the loop thread ran a few ms of the hold) is sampled wherever it
stopped. `starved`, or `paging`/`off-cpu` with a large `decompressions` or `swapins` count, is the
machine (CPU load, memory) rather than a Walnut code path. The recorder costs the loop thread 1.7 to
4.8 ms of CPU a second when idle, 3 to 10.6 ms in a loop of 1 ms timers, 7.7 to 19.6 ms in a loop
reading a socket (measured 2026-10-07 against no recorder).

The shorter stalls (250 ms and up, no profile) are the `event-loop stall detected (histogram)`
lines, one per 5 s window (`src/core/event-loop-monitor.ts`). `suspectSection` is the longest-open
critical section, or `boot` when none is open in the first two minutes after start (`sinceStartS`);
an open section only means the stall fell while it ran, so read `openSections` (wall vs the loop
thread's CPU; `sectionAwaiting` when it mostly waited) and `closedSections` (those that ended inside
the window). A section's `loopCpu` is everything the loop ran while it was open, not its own work:
a section that awaits 14 s on a loop busy half the time shows 7 s (2026-11-25: change-watch showed
4.7 s a run, about 10 ms of it its own). What used the CPU is in the kept profiles. `loopCpuMs` is the loop thread's CPU in the window: `offCpu: true` (under half the
stall) means no Walnut code can have held it that long, so it is the machine (`invCtxSwitches`) or a
blocking call (`blocking`: the synchronous SQLite and child-process calls of 20 ms or more, with
their call sites). `stalls` counts the `offCpu` windows.

**"Who overwrote my file?" starts with `file <path-substring>`.** Every read logs `file read`
(status 200/304, the hash the client now holds, the token it quoted, `track`, size, ms), every
write logs `file write` (writer user/live/merge, origin, hash before/after, the token presented,
size before/after, `shrankBy`), and every refusal logs `file write refused` with a `reason` that
matters: `stale-lock` is the guard working (two writers raced, the editor will merge), while
`unlocked-machine-write` means a client bug reached the server and should be ZERO. The browser side
logs `[file-editor] buffer installed` (which path replaced the buffer, the generation, the lock
before and after) and `[file-editor] live write sending` (`armedMs`, `armedGen` vs `currentGen`), so
the causal chain reads in order: a read teaches the editor a hash, the lock advances, a write goes
out under it. That chain is exactly what the 2026-09-05 stale-write-back incident had to be
reconstructed by hand from three message shapes across two files. A `live`/`merge` write with a
large `shrankBy` is that bug's signature.

**When a user reports "message send is slow", run `diagnose <sid>` first.** It pairs each message's enqueue→route→delivered by `messageId` and prints a labelled cause per message + p50/p90, so you don't hand-grep. Labels it distinguishes (these are the known distinct root causes: don't conflate them):
- **BUG D: mid-turn stall**: `injectMidTurn` on a stale `hasPipe=False` (remote sessions). The felt 30 to 50s QUEUED. Fixed by delegating to processNext; if this label reappears, the fix regressed.
- **EVENT-LOOP STARVATION**: dispatch→enqueue blocked. Was caused by streaming fan-out to global subscribers; fixed by the event-bus `interest` set. Cross-check with `busstorm`.
- **SLOW RESUME**: CLI dead, cold `--resume` path (inherently slower, not a bug).
- **SLOW DELIVER / STUCK**: catch-alls; fall back to `trace`/`pipe` for the timeline.

Both `diagnose` and `busstorm` default to a **30-min window** (so old historical stalls don't masquerade as "happening now"); pass a 3rd arg `mins` (e.g. `120`, or `0` for all-time) to widen it. Timestamps are UTC.

Message-send latency is logged as `message delivered {deliveryMs, path, messageId}` at every delivery point (`path` = stdin / mid-turn / resume). `messageId` (`qm-…`) is the cross-layer request id: grep it to trace one message end-to-end.

## Debugging send/delivery latency (quick refs)

**Debugging send/delivery latency (quick refs):**
- Both local (`__local__`) AND remote sessions go through the daemon / `RemoteSessionManager`. There is no separate "local" transport: don't assume a stall is SSH-specific.
- Logs: structured JSON at `/tmp/open-walnut/open-walnut-<date>.log`: but **timestamps are UTC** while the **filename is local date**, so a UTC-morning event lands in the *previous* local-day file. Filter by the UTC prefix, not the filename date.
- Daemon's own logs: `/tmp/open-walnut/daemon-d-*.log` (JSON). `state_transition` + `reconcile-adopt` show the long-running process being re-adopted across daemon restarts (proof of long-running CLI).
- Measure end-to-end honestly: `browser [send] dispatching` and `web session message via RPC` share the **same server-logger clock**, so pair them by `sessionId` (not by external `date`/bash time). Stages: `dispatching`→`session message via RPC`→`message enqueued`→`messages batched`→`message delivered`. The `deliveryMs` field only covers enqueue→delivered, so it *misses* any pre-enqueue event-loop lag.
- `scripts/walnut-logs.sh diagnose [sid] | busstorm [sid] | trace <sid> | pipe <sid> | session <sid> | delivery [sid] | slow [ms] | daemon <sid>`: see the log-toolkit section below. **For "send is slow", start with `diagnose <sid>`: it auto-labels the cause (Bug D mid-turn stall / event-loop starvation / slow resume).**

## Debugging the Claude Code CLI (stuck or silent sessions)

When a session goes `idle` with no output, gets stuck mid-turn, or the CLI appears hung, check **Claude Code's own trace log**. Walnut passes `--debug` to every `claude -p` spawn by default, so this log is always available.

```bash
WALNUT_CLAUDE_DEBUG=0 bun run dev:prod    # opt out if you need to
```

The flag is added in `src/providers/claude-code-session.ts`. Works for both local and remote (daemon) sessions; args are forwarded through the daemon unchanged.

**Where logs land:**

| Session type | Path |
|---|---|
| Local | `~/.claude/debug/<claude-session-id>.txt` |
| Remote (daemon on clouddev etc.) | `~/.claude/debug/<claude-session-id>.txt` **on the remote host** |

A `latest` symlink in the same dir always points at the most recent file.

```bash
tail -F ~/.claude/debug/latest                         # follow local
ssh clouddev tail -F '~/.claude/debug/latest'          # follow remote
```

**Verbosity knobs** (also env vars: export them before `bun run dev:prod`; for remote, set them where the daemon was started):

- `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose`: include high-volume diagnostics (statusLine, shell, cwd, stdout/stderr). Default is `debug`, which filters those out.
- `CLAUDE_CODE_DEBUG_LOGS_DIR=/some/path`: override the `~/.claude/debug/` directory.
- `OTEL_LOG_TOOL_DETAILS=1`: capture full tool input/output in OTEL spans (separate from the `--debug` file).

**CLI flags** the fork supports (in case you want to invoke `claude` manually to repro):

- `--debug` / `-d`: enable debug mode (what Walnut injects)
- `--debug-file <path>`: write to a specific file (implicitly enables debug)
- `--debug-to-stderr` / `-d2e`: write debug to stderr instead of a file

The implementation lives in the CLI's `src/utils/debug.ts`: `logForDebugging()` is called throughout the CLI. All flags are already compiled into `fork-2.1.88`; no rebuild required.

## The "malware reminder" on every file read

If you're seeing `<system-reminder>Whenever you read a file, you should consider whether it would be considered malware…</system-reminder>` appended to every `Read` tool result, that's **not Walnut**: it's `@anthropic-ai/claude-agent-sdk`'s `CYBER_RISK_MITIGATION_REMINDER`. The SDK injects it unless the active main-loop model is in a hardcoded exempt set. Upstream only lists `claude-opus-4-6`; newer models (4.7, Sonnet, …) get the reminder on every read, eating context.

We keep a bun patch at `patches/@anthropic-ai%2Fclaude-agent-sdk@<version>.patch` (listed under `patchedDependencies` in `package.json`) that **disables the reminder for all models**: it rewrites the ternary `X4z()?j4z:""` in the minified bundle to just `""`, so no file read ever appends the reminder regardless of main-loop model. `bun install` applies it. When bumping the SDK version: run `bun patch @anthropic-ai/claude-agent-sdk`, re-apply the edit to `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` (grep for `considered malware` to locate the template literal, then find and rewrite the ternary that conditionally appends it), and save it with `bun patch --commit @anthropic-ai/claude-agent-sdk`.
