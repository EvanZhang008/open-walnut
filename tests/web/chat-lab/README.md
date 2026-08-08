# Chat Lab — replicate the "stale thing pinned at the bottom" family without a browser

The recurring incident shape: the conversation is over, but something stale (a user bubble, a subagent box, streamed text) still renders below the last message — **and a refresh clears it**. That last property is the definition the lab is built on: at quiescence, the live view must equal a fresh mount. Anything extra is the bug.

## What runs where

| Piece | File | What it is |
|---|---|---|
| Scripted server | `scripted-server.ts` | Canonical JSONL store + `/history` serving. Delta resolution is the **real** `src/core/history-delta.ts`. Fault knobs replay pre-fix contracts (`legacyCountDelta`, `noUnsettledStamp`, `dropRevisions`) and the whale sliding window (`evict`). |
| Headless client | `headless-client.ts` | The browser pipeline with React removed — every rule is the **real production module**: `stream-reducer` (accumulation), `history-merge` (delta folding), `history-anchor` (request shape), `render-filter` (absorption), `group-blocks` (lane grouping), `optimistic-dedup` (bubbles). |
| Oracles | `oracles.ts` | 1. **refresh equivalence** at quiescence (the user's own bug definition); 2. **never vanish** (every canonical assistant text visible). Designed residuals (redacted thinking) are allowlisted explicitly, never silently. |
| Scenarios | `scenarios.test.ts` | Named incident replays + stress orderings + 25 seeded random interleavings. |

Run: `WALNUT_VITEST_GATE=0 npx vitest run tests/web/chat-lab/ --config vitest.integration.config.ts` (~0.5 s).

## The loop (how every future incident goes through here)

1. **Capture** — production already dumps the *flight trace* when the render-filter tripwire fires ("N completed blocks had no delta twin"): grep the browser-forwarded log for `flight trace` (`/tmp/open-walnut/open-walnut-<date>.log`, `subsystem=browser`). The trace is the ordered list of WS events + history fetches (ids/shapes, no content) this client actually consumed — recorded by `web/src/stream/flight-recorder.ts`.
2. **REPRODUCE** — script the trace's event order as a scenario. If the defect is in an already-fixed contract, turn on the matching fault knob and assert the artifact **is present** (`refreshResiduals(...).length > 0`). A fix without a reproducing scenario is not accepted; a scenario that can't reproduce means the root cause is not yet understood.
3. **PROVE** — the same event order with the shipped contract must satisfy both oracles.
4. Ship fix + both scenarios together. The REPRODUCE test pins the pre-fix behavior forever (it fails if someone "simplifies" a fault knob away); the PROVE test is the regression guard.

## Scenario axes to compose (what "different scenarios" means)

- turn shape: long single response / rapid multi-turn / merged batches
- subagents: background (late `task-notification`), sync inline, orphan lanes, agent still running at quiescence (expected residual — a live box must render)
- transport: archive lag (empty deltas), sliding whale window (`evict`), compaction shrink (rewrite `server.canonical`), reconnect sweeps (duplicate `batchCompleted` + `deltaFetch`)
- machine: sleep/wake = coalesced signal bursts; load = deltas arriving in unusual orders (property mode covers this via seeds)

## Layer boundaries (be honest about what the lab can't catch)

L0 (this lab) proves the **client pipeline logic** against any input ordering. It cannot catch: server-side parse bugs (covered by `tests/core/session-history*`), transport races inside React's scheduler (covered by the Playwright fault-injection specs in `tests/e2e/browser/`), or daemon/CLI lifecycle bugs (covered by the daemon-fold simulator). When a lab replay of a production trace does NOT reproduce the artifact, the bug is in one of those layers — that is itself a triage result.
