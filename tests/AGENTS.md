# Testing — Quick Reference

**Full implementation details: `.claude/skills/walnut-testing/SKILL.md`** (5-tier pyramid,
per-tier configs, known pre-existing failures, live test pattern, Playwright modes).

## Essentials

- Tiers: unit (`tests/core|agent`) → integration (`tests/web/routes`, supertest) → e2e
  (`tests/e2e`, real server on port 0) → browser (`tests/e2e/browser`, Playwright) → live
  (`*.live.test.ts`, real APIs, opt-in via `WALNUT_LIVE_TEST=1`).
- **Live cloud journeys** (`tests/e2e/cloud-mobile-journey.live.test.ts`): run via
  `npm run test:live:cloud` — the runner script derives the cloud URL + device token from the
  data repo's git remote and injects them via env (zero secrets in the repo; in-process
  derivation is impossible because VITEST forces `WALNUT_HOME` to a temp dir). Asserts the
  CLI's actual reply text, not status codes. Born from the 2026-08-07 incident: all mocked
  tiers were green while the phone couldn't use a session it had just created — cross-machine
  features need one zero-mock journey before they count as done.
- Every test file mocks constants to a unique tmpdir: `vi.mock('../../src/constants.js', () =>
  createMockConstants())` — no shared-state pollution between files.
- **The full suite has a pre-existing red baseline — never judge regressions from the aggregate
  count.** Run the touched file in isolation, then diff against a clean HEAD baseline (cp files
  aside → `git checkout HEAD -- <src>` → rerun → restore; `git stash` is banned). Identical
  failure names on HEAD = pre-existing, not yours. The known-failures list is in the skill.
- **Browser tier is serialized machine-wide.** One Chromium per worker (~385 MB), `workers`
  capped at 4, and an exclusive lease on :3457 so a second `npx playwright test` queues instead
  of colliding (specs hardcode that port; `reuseExistingServer` would otherwise let two runs
  share one fixture server). `[pw-concurrency] … Queuing` = working as designed. Debris from a
  killed run: `scripts/pw-cleanup.sh status|clean`. Details in the root AGENTS.md.
- **Timeout-shaped browser failures are usually machine load, not product bugs.** Check
  `scripts/pw-cleanup.sh status` first — at load 486 (14 cores) every spec failed on
  `page.waitForLoadState`. Fixture cold boot: ~20 s idle, ~70 s at load 133.

## iOS long-session rendering tests (`ios-native/WalnutTests` + `scripts/ios-perf-check.sh`)

Guards the class of bug behind the 2026-08-07 `0x8BADF00D` watchdog kills (opening/streaming a
long session stalled the iOS main thread >5s → iOS killed the app). The unit/perf layer is a
native XCTest target hosted by the app (`@testable import Walnut` — real code, no replicas);
`scripts/ios-perf-check.sh` is a thin wrapper around it plus the simulator smoke.

- **L1 (default, ~3-4 min)** — `xcodebuild test -scheme Walnut -only-testing:WalnutTests` on the
  iPhone 16 Pro sim (also runs from Xcode Cmd-U). Suites in `ios-native/WalnutTests/`:
  - `LiveMarkdownWindowTests` — window invariants (head+tail is always a suffix of the text,
    even fence count in head, giant single fence never split, head stable within a tailQuantum).
  - `MessageRowHelperTests` — the REAL `MessageRow.imageSendParts` (both wire formats),
    `ChatMarkdownBody.isBlockMarkdown`/`containsImageRef`, `MarkdownParser.isImagePath`.
  - `SessionConversationStoreTests` — `clipProvisional` (4K clip + "…").
  - `MarkdownPerfTests` — rendering perf gates: classify/coldParse/warmParse (full 400-row page,
    catches parse-cache thrash)/inline/live-turn budgets, fixtures generated in Swift
    (`TranscriptFixtures.swift` — no python step). Budgets are EXPLICIT in-code assertions on the
    measured median, NOT XCTest baselines: baselines live inside the .xcodeproj, which xcodegen
    regenerates (and wipes) from `project.yml` on every `xcodegen generate`. The load-immune gate
    is a RATIO assertion — a windowed live tick must beat a full unwindowed 2MB re-parse ≥10x.
  - `WatchdogRegressionTests` + `ScrollPerfTests` — build-34 field-crash reproductions (giant
    live-region attach, delta flush on multi-MB liveText, scroll materialization bursts, cache
    thrash on oversized rows) driven through the real store via `ScriptedSSE`. Sim is M-series,
    ~3-5x faster than the A-series phones — budgets are watchdog-scaled to 1s accordingly.
    **FIXED 2026-08-07 — the XCTExpectFailure wrappers are REMOVED and all four breaching
    assertions are now permanent HARD GATES** (red repro was: attach 200MB 1413ms; giant-liveText
    tick 882ms; polluted round-trip scroll 916ms; oversized-row round trip 25,027ms). The fix:
    stores retain only a capped liveText tail (`LiveMarkdownWindow.boundedTail`, ~96K chars, 2x
    the render window), large SSE snapshots decode OFF the MainActor (events queued mid-decode
    replay in arrival order), `MarkdownParser.parse` clips oversized (>16K chars) legacy rows,
    and the streaming tail parses with `cache: .skip` so one-shot tick strings can't evict the
    visible page from the shared cache. A red run here means the 0x8BADF00D bug class is back —
    never loosen the budgets, and never re-wrap the assertions.
- **L2 (`--sim`, ~5 min)** — end-to-end freeze smoke: builds the app, points it at a mock
  `/api/v1` server (`scripts/ios-perf/mock-server.mjs` — generates its own synthetic long
  transcript, no fixture files) plus an aggressive live SSE stream, opens the session via
  Maestro, and FAILS if the app's own MainThreadWatchdog logs `main thread unresponsive` (the
  exact line the field crashes emitted). One simulator, serial — never parallelize sims.
- The old shell-compiled `PerfHarness.swift` + `gen-transcripts.py` are DELETED — the XCTest
  target replaced them (it tests the real symbols, so there is no replica to keep in sync).
- Run L1 whenever MarkdownParser / MessageRow / LiveMarkdownWindow / SessionConversationStore
  render paths change; run `--sim` before iOS releases.
