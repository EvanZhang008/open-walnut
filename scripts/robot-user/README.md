# Robot user — iOS soak test

A synthetic user that drives the Walnut iOS app on a **dedicated simulator** for a long stretch, doing what real people do (type, send, attach photos, scroll, churn the keyboard, hop tabs, background/foreground the app, pause to think) and checking **invariants** after every single action instead of scripted step assertions.

That difference is the whole point: a random walk cannot have per-step expectations, but the app must *always* satisfy things like "the timeline that had messages a second ago still has messages" and "the app never claims offline while the server answers 200". The walk finds the state; the oracles say it is broken; the journal makes it replayable.

## Usage

```bash
scripts/robot-user/robot.sh --device <udid> --minutes 30
scripts/robot-user/robot.sh --device <udid> --minutes 60 --seed 7 --driver ai
scripts/robot-user/robot.sh --device <udid> --minutes 10 --server http://localhost:3456 --no-judge

# Harness self-test — no simulator involved, stubbed driver:
node scripts/robot-user/episode.mjs --dry-run --seed 1 --steps 20
```

Exit code: `0` = clean, `2` = anomalies found, `1` = setup error. `Ctrl-C` is forwarded so the journal is finished cleanly instead of truncated.

The app must already be installed on the simulator — the harness deliberately never installs anything, so it can never overwrite the build you meant to soak-test. It will boot a shut-down simulator, but nothing more.

Environment:

| Var | Purpose |
|---|---|
| `MAESTRO_CLI` | path to the maestro CLI (default `~/.claude/skills/maestro-as-cli/scripts/maestro`) |
| `WALNUT_ROBOT_TOKEN` | Bearer token for `GET /api/v1/status` (used by the `offlineWhileHealthy` oracle) |
| `WALNUT_ROBOT_CLAUDE` | override the `claude` binary used by the ai driver / judge |

## Oracles (run after every action)

| Oracle | Flags when |
|---|---|
| `freezeTelemetry` | a NEW `subsystem=freeze` "main thread unresponsive" or `subsystem=crash` line appears in `/tmp/open-walnut/ios-client/<device-name>-<date>.log` (offsets are primed at episode start, so only new lines count; both today's and yesterday's file are checked because a run can straddle midnight) |
| `crashArtifacts` | a new `*Walnut*` report lands in `~/Library/Logs/DiagnosticReports` after the episode started |
| `blankTimeline` | we are on a chat-like screen (`chat.composer` present), the scroll area has no text rows, and we previously saw more than 3 rows on that screen — the blank-screen bug class. A never-populated screen is not reported |
| `responsiveness` | the post-action hierarchy read exceeded `max(3000ms, baseline * 2.5)`, or two consecutive actions timed out — freeze suspicion. The baseline is the median of 3 idle reads taken before step 1 and is recorded in `summary.json`; see *Calibration* below |
| `stuckPending` | a `Waiting for reply` / `pending` marker survives more than 6 consecutive checks (~2 min) |
| `offlineWhileHealthy` | the UI shows "unreachable — read-only" / "offline" while `GET /api/v1/status` returns 200 |
| `visualJudge` | the screenshot judge calls the screen broken (blank content area, error dialog, garbled layout, half-rendered rows) |

A flagged oracle never stops the episode — it appends to `anomalies[]` and captures a screenshot plus the raw hierarchy, so the run keeps producing evidence for the whole window.

## Calibration (why the first pilot cried wolf 18 times)

The first real-simulator pilot reported 18 anomalies on a healthy app. Both causes were harness bugs, and both are now regression-tested in the dry run — if you touch either oracle, keep those cases green:

- **`responsiveness` measured the tooling, not the app.** Every `inspectHierarchy` pays a maestro runner spawn plus an MCP roundtrip, which is 3–20 s on a real device before the app is even consulted. A hardcoded 3000 ms therefore flagged 17 of 17 steps. Fixed by calibrating per rig: median of 3 idle reads before step 1, then flag only above `max(3000, baseline * 2.5)`. Against pilot 1's actual timings this drops the false positives from 17 to 0 while still catching its four genuine 10–20 s outliers.
- **`freezeTelemetry` replayed a stale freeze from three hours before the episode.** The client names its log file with the **UTC** date; the harness predicted a **local** one. A run starting 23:48 local (06:48 UTC) primed `…-07-24.log` and never primed the `…-07-25.log` the device was actually writing — so when local midnight passed, that file entered the candidate list unprimed at offset 0 and the whole day replayed as "new". Fixed three ways: the directory is **globbed** instead of filename-predicted, any file first seen mid-run is primed to EOF (never read from 0), and each line's `ts` must be `>= startedAt` regardless of offsets. The third one matters independently: the client can append telemetry for a stall it detected before the episode began, which no byte offset can reject.

One simulator uploads under **several names** (its simctl display name *and* the name the build was paired with, e.g. `iPhone 16 Pro Stress2` and `sim-stress2`). The harness derives the display-name variants automatically; pass `--also-device-name sim-stress2` for a pairing name it cannot guess. `summary.json` records `logFilesWatched` — **check it if a freeze you expected never showed up**, because a name the oracle isn't watching is a silent false negative, which is worse than the false positives above.

## Journal

`/tmp/walnut-robot/<epoch>-seed<seed>/`

| File | What |
|---|---|
| `journal.jsonl` | one line per observe / oracle / action / screenshot / judge / anomaly event |
| `screenshots/` | `stepNNNN.png` every 5 steps, plus `stepNNNN-<oracle>.png` and `.hierarchy.json` on every anomaly |
| `summary.json` | `{ steps, anomalies[], durationMs, seed, device, driver, actionCounts, baseline, logFilesWatched }` |
| `replay.yaml` | every maestro command actually executed, concatenated under one `appId` header |

## Replaying an anomaly

Two levels, cheapest first:

1. **Same seed** — the PRNG (mulberry32) fully determines the action sequence, so `robot.sh --device <udid> --seed <same>` walks the same path. Use this when the bug is about *sequence*.
2. **`replay.yaml`** — the literal flow, no PRNG, no oracles. Feed it to maestro:

```bash
CLI=~/.claude/skills/maestro-as-cli/scripts/maestro
echo '{}' > ~/.maestro/device_locks.json          # always, before every CLI call
"$CLI" tools call run-flow-files "$(jq -n --arg d "<udid>" --arg f "/tmp/walnut-robot/<dir>/replay.yaml" \
  '{device_id:$d, flow_files:[$f]}')"
```

Trim `replay.yaml` down to the commands around the failing step (the journal's `step` number maps to the flow in order) to get a minimal repro.

## Drivers

- **`hybrid`** (default) — weighted random pick over the catalog, filtered by preconditions. Deterministic, free, and what you want for long soaks.
- **`ai`** — asks a small model for the next action, validates the name against the catalog and re-checks its preconditions, and falls back to the hybrid pick on any parse / unknown-action / precondition / timeout failure (20 s cap). Useful for shorter, more "intentional" runs; the fallback means a misbehaving model degrades to `hybrid` rather than stalling the run.

## Cost

- The **judge** is the only unavoidable model spend: one small-model screenshot read every 10 steps, plus one per anomaly, 30 s cap. `--no-judge` removes all model calls in `hybrid` mode.
- The **ai driver** adds one small-model call per step. Do not use it for hour-long soaks.

## Adding an action

Append to `ACTIONS` in `actions.mjs`:

```js
{
  name: 'myAction',
  weight: 8,                                  // relative to the other weights
  preconditions: (rows, state) => hasId(rows, IDS.composer),
  async run(driver, ctx) {                    // ctx = { prng, state, sleep, driver }
    const steps = [];
    steps.push(await driver.tapId(IDS.composer));
    await ctx.sleep(randInt(ctx.prng, 300, 900));
    return { steps, detail: { anything: 'journaled' } };
  },
}
```

Rules that keep replay honest: take **all** randomness from `ctx.prng` (never `Math.random`), return every driver result in `steps` so failures are journaled, and return `{ skipped: 'reason' }` instead of throwing when the screen is not what you assumed. The dry run exercises every action body, so a new action is covered automatically.

## Adding an oracle

Add a function inside `createOracles()` in `oracles.mjs` returning `ok(name, detail)` or `bad(name, detail, { capture: true })`, include it in `runAll()`, and export it so it can be checked against a fixture. Then add a fixture hierarchy to `FIXTURE_CSV` in `episode.mjs` plus a case in `dryRunSelfCheck()` asserting both directions — it must flag the broken fixture **and** stay quiet on the healthy one. An oracle with only a positive test is how false-positive storms get shipped.

## Notes on the driver

- Every maestro CLI invocation resets `~/.maestro/device_locks.json` to `{}` first: each call can leave behind a lock whose owner pid is already dead, and the next call then fails with "DEVICE LOCKED - in use by another agent".
- Screenshots go through `xcrun simctl io <udid> screenshot` — maestro's own screenshot tool is broken.
- Background/foreground churn is `simctl terminate` + `launch`, then a poll until the hierarchy repopulates. It is the reliable primitive; the home button is not.
- Tab switching uses point taps at y ≈ 94% (Chat 18%, Notes 39%, Tasks 60%, Settings 81%) — tapping tab bar items by text silently no-ops.
