---
name: walnut-testing
description: Testing details for the Walnut repo — 5-tier pyramid (unit/integration/e2e/browser/live), per-tier vitest configs & parallelism, how to judge if YOUR change caused a failure (isolated run + HEAD baseline diff), known pre-existing failures, mock-constants helper, live test pattern, Playwright modes. Use when running tests, adding tests, or triaging test failures.
---

# Testing — Implementation Details

For testing philosophy, run commands, and anti-patterns, see project `CLAUDE.md`.
For the layered pipeline (which tier to run when), see
[docs/reference/testing-pipeline.md](../../../docs/reference/testing-pipeline.md).

## Run the cheap layer (start here)

```bash
npm run test:quick          # 306 pure-logic files, ~51s — the default
npm run test:focus <path>   # one file/dir, 0.3-30s
npm run test:baseline       # ⭐ the honest verdict: fails ONLY on NEW failures
npm run test:pre-commit     # maps your diff → affected tiers
```

**`npm run test:baseline` is how you judge a change.** The suite carries **118
pre-existing failures on `main`** (recorded in `tests/setup/known-failures.json`,
measured in a clean clone of `844dc84`). The baseline gate ignores those and fails
only on failures absent from the list, so you get a yes/no answer instead of
eyeballing an aggregate. Fixed some? `npm run test:baseline:record`.

⚠️ **Never raise the worker budget** (`tests/setup/worker-budget.ts`, 2 workers
locally). Uncapped fan-out hard-crashed the dev Mac twice in July 2026. `npm test`
runs tiers *sequentially* for the same reason — don't "optimise" it back to parallel.

### The mergeConfig trap (cost 2× suite runtime for months)

`mergeConfig` **CONCATENATES** `include`/`exclude` arrays. Passing `include`
through its second argument appends to the base's `tests/**` instead of replacing
it — so `vitest.unit.config.ts` and `vitest.integration.config.ts` each collected
~336 files (the whole suite) and `npm test` ran nearly every test **twice** (349s +
397s). Both now assign `config.test.include` *after* the merge;
`tests/setup/quick-tier.test.ts` guards the invariant. **Any new narrowing config
must do the same.**

## Testing Pyramid (5 tiers)

```
                  ┌──────────────────┐
                  │  Live (real APIs) │  *.live.test.ts — real Bedrock/MS-To-Do, $$$
                  ├──────────────────┤
                  │  Browser (PW)    │  tests/e2e/browser/ — Playwright
                  ├──────────────────┤
                │    E2E (vitest)      │  tests/e2e/ — real server + WS, 4 workers
                ├──────────────────────┤
              │   Integration (super)    │  tests/web/routes/ — supertest, parallel
              ├──────────────────────────┤
            │       Unit (vitest)           │  tests/core/, tests/agent/ — parallel
            └──────────────────────────────┘
```

| Tier | Location | What's real | What's mocked |
|---|---|---|---|
| **Unit** | `tests/core/`, `tests/agent/` | Logic, data structures | File paths → tmpdir |
| **Integration** | `tests/web/routes/` | Express app, middleware | File paths → tmpdir |
| **E2E** | `tests/e2e/` | Server, WS, bus, disk I/O | `constants.js` → tmpdir, Claude CLI → mock script |
| **Browser** | `tests/e2e/browser/` | Browser, server, full SPA | `constants.js` → tmpdir, Claude CLI → mock script |
| **Live** | `tests/**/*.live.test.ts` | Everything real (LLM, MS To-Do API) | File paths only |

## Test Configs & Parallelism

Each tier has its own config. All tiers except Live run in parallel.

All tiers share ONE worker budget: `tests/setup/worker-budget.ts` (2 locally, 4 in CI).

| Tier | Config File | Files | Time | Timeout |
|---|---|---|---|---|
| **Quick** ⭐ | `vitest.quick.config.ts` | 306 | 51s @4w | 15s |
| **Slow** | `vitest.slow.config.ts` | 26 | 311s | 60s |
| **Unit** | `vitest.unit.config.ts` | 224 | — | 30s |
| **Integration** | `vitest.integration.config.ts` | 112 | — | 60s |
| **E2E** | `vitest.e2e.config.ts` | 103 | ~120s | 60s |
| **Browser** | `playwright.config.ts` | — | — | 30s |
| **Live** | `vitest.live.config.ts` | 11 | — | 300s (costs money) |

**quick + slow = an exact partition** (306 + 26 = 332, zero overlap, zero orphans)
of everything except e2e/commands/live/frontend-rooted. Membership is decided by
*measured* time — the >2s list lives in `tests/setup/slow-tests.ts`. Re-measure
rather than hand-editing it.

`scripts/test-parallel.mjs` runs the tiers **sequentially** (it used to be
`Promise.all`, which multiplied the worker cap by 6 and crashed the machine).
`*.live.test.ts` is excluded from all non-live configs — never runs accidentally.

## Judging whether YOUR change caused a failure (read before you panic)

The suite has a meaningful baseline of **pre-existing failures** — a full `npm test` /
full-integration run reports a large, scary aggregate number that is mostly NOT your fault.
Do **not** judge regressions from the aggregate count. Instead:

1. **Run the touched file(s) in isolation** — `npx vitest run --config <tier>.config.ts <file>`.
2. **Diff against a clean HEAD baseline** — stash-free method (project policy blocks `git
   stash`): `cp` your working files aside, `git checkout HEAD -- <src>`, run the same isolated
   file, then restore your files. If the failure count + the failing test *names* are identical
   on HEAD, the failure is pre-existing and not yours.

This is byte-for-byte reliable because each test file mocks `constants.js` to a **unique random
tmpdir** (`createMockConstants()` uses `Date.now()`+random) and resets module singletons
(`_resetForTesting()`). **There is no shared-`WALNUT_HOME` cross-file data pollution** — verified:
a file's failing-test set is identical run-alone vs run-in-the-full-suite. Aggregate numbers look
noisy only because of (a) the pre-existing failures below and (b) real **resource contention**
when many forks spawn real sessions at once (`Timed out waiting for session result (15000ms)`),
which is a perf artifact, not a correctness one.

### Known pre-existing failures (NOT regressions — don't chase these)

**These are now enumerated machine-readably in `tests/setup/known-failures.json`
(118 entries, measured 2026-07-25 in a clean clone of `844dc84`), so prefer
`npm run test:baseline` over the manual HEAD-baseline dance below** — it does the
same comparison automatically and exits non-zero only on genuinely new failures.
The prose below explains *why* the big clusters fail.

- **`tests/providers/claude-code-session.test.ts`, `tests/providers/session-io.test.ts`,
  `tests/e2e/ssh-session.test.ts`** import `buildRemoteCommand` (and `session-io.test.ts` also
  `RemoteIO`, `transferImagesForRemoteSession`) — **these symbols no longer exist in
  `src/providers/session-io.ts`** (a 2026-05-26 refactor, commit `3970344`, removed them while the
  2026-03-28 tests still reference them). The bad import throws, failing **every** test in the
  file (~57 in claude-code-session, ~22 in session-io). Fix is to update the test imports to the
  surviving exports (`shellQuote`, `buildRemotePreamble`, `wrapInLoginShell`, `REMOTE_BASE_PATH`,
  `createSessionIO`) — owned by the sessions subsystem, tracked separately.
- **`claude-code-session.test.ts`** also needs a running local daemon
  (`Local daemon not running. Call localDaemon.ensureRunning()`); ~37 fail without it under a bare
  `npx vitest` invocation.
- Assorted contract-drift assertions (e.g. `context-inspector` expecting model `claude-opus-4-6`;
  task DELETE expecting `200` vs actual `204`).

Bottom line: a clean change can sit on top of a red full-suite run. Trust the isolated +
HEAD-baseline diff, not the aggregate.

## Mock Constants

Use the shared `createMockConstants()` helper instead of inline mock blocks:

```typescript
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants());
```

This generates all constants pointing to a unique tmpdir. Prefer this over inline mock boilerplate.

## Live Test Pattern

Live tests hit real external APIs (Bedrock, MS To-Do). They are expensive and opt-in only.

```typescript
import { isLiveTest, hasAwsCredentials } from '../helpers/live.js';

describe.skipIf(!isLiveTest() || !hasAwsCredentials())('Bedrock live', () => {
  it('sends a real prompt to Claude', async () => { /* ... */ });
});
```

- `isLiveTest()` — checks `WALNUT_LIVE_TEST=1` or `LIVE=1` env var
- `hasAwsCredentials()` — checks AWS env vars or `aws sts get-caller-identity`
- `hasMsGraphCredentials()` — checks MS To-Do token env vars

## Feature Coverage

| Feature | Unit | Integration | E2E (vitest) | Browser (PW) | Live |
|---|---|---|---|---|---|
| Task CRUD | `tests/core/task-manager.test.ts` | `tests/web/routes/tasks.test.ts` | `tests/e2e/web-app.test.ts` | `tests/e2e/browser/app.spec.ts` | — |
| Toggle complete | `tests/core/toggle-complete.test.ts` | `tests/web/routes/toggle-complete.test.ts` | `tests/e2e/todo-panel-fixes.test.ts` | `tests/e2e/browser/app.spec.ts` | — |
| Favorites | — | `tests/web/routes/favorites.test.ts` | `tests/e2e/todo-panel-fixes.test.ts` | — | — |
| Slash parsing | — | — | `tests/e2e/todo-panel-fixes.test.ts` | — | — |
| Sessions (lifecycle) | `tests/providers/claude-code-session.test.ts` | — | `tests/e2e/session-lifecycle.test.ts` | — | — |
| Session WS streaming | `tests/providers/claude-code-session.test.ts` | — | `tests/e2e/session-lifecycle.test.ts` | — | — |
| Memory + search | `tests/core/memory*.test.ts` | — | `tests/e2e/memory-lifecycle.test.ts` | — | — |
| Dashboard | — | — | `tests/e2e/web-app.test.ts` | — | — |
| Config | — | — | `tests/e2e/web-app.test.ts` | — | — |
| WS event delivery | — | — | `tests/e2e/web-app.test.ts` | `tests/e2e/browser/app.spec.ts` | — |
| Context Inspector | — | `tests/web/routes/context-inspector.test.ts` | `tests/e2e/context-inspector.test.ts` | `tests/e2e/browser/context-inspector.spec.ts` | — |
| Task reorder (DnD) | `tests/core/task-manager.test.ts` | `tests/web/routes/tasks.test.ts` | — | — | — |

## Playwright

Two modes:

1. **Automated code tests** (`tests/e2e/browser/`): Run with `npx playwright test`. Playwright config starts the web server automatically. Parallel workers (half CPUs locally, 4 in CI), each test creates unique data. Tests are standard `@playwright/test` specs.

2. **Manual MCP verification** (final human-in-the-loop step): After automated tests pass, use Playwright MCP tools for visual spot-checks:
   ```
   mcp__playwright__browser_navigate → http://localhost:3456
   mcp__playwright__browser_snapshot → verify DOM structure
   mcp__playwright__browser_take_screenshot → visual verification
   ```
   This is documented as "the AI's final manual step" — automated tests catch regressions, MCP screenshots confirm visual correctness.
