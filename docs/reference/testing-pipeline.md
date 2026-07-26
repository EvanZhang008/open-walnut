# Testing pipeline

Four layers, chosen so the one you run most often is the one that costs least. Run `npm run test:quick` on every change, `npm run test:pre-commit` before a bigger commit, and let GitHub Actions run everything on push — Actions is free for this repo (public repos get unlimited minutes on GitHub-hosted runners).

| Layer | Command | Scope | Time | When |
|---|---|---|---|---|
| **L1 quick** | `npm run test:quick` | 306 pure-logic files | **51 s** (4 workers) / 93 s (2 workers) | every code change |
| **L2 focus** | `npm run test:focus <path>` | whatever you name | 0.3–30 s | while working on one module |
| **L3 pre-commit** | `npm run test:pre-commit` | the tiers your diff can break | 1–6 min | before a larger commit |
| **L4 CI** | GitHub Actions, automatic | everything + lint + build | ~6 min wall-clock, free | every push and PR |

## L1 — the fast tier

`vitest.quick.config.ts` runs everything EXCEPT the 26 files measured over 2 s (`tests/setup/slow-tests.ts`), the two end-to-end-heavy directories (`tests/e2e`, `tests/commands`), and the four frontend-rooted ones under `tests/web/` whose deps live in `web/node_modules`. Those 26 are slow because they start something real — a `claude` CLI, a local daemon, a git subprocess, an HTTP server — so they are exactly the wrong thing to run on every save.

The split is by **measured time**, not by a hand-drawn "unit vs integration" line. A new fast test is therefore included automatically; only a test that actually becomes slow needs a list entry. `npm run test:slow` runs exactly the complement, and `tests/setup/quick-tier.test.ts` asserts the two sets partition the suite with no overlap and no orphans (306 + 26 = 332).

## L2 — focus one path

```bash
npm run test:focus tests/core/task-manager.test.ts   # one file
npm run test:focus tests/core                        # one directory
npm run test:focus -- -t 'reorder'                   # one test by name
```

## L3 — only the tiers your diff touches

`scripts/test-changed.mjs` maps changed paths to tiers, then runs them sequentially:

| Changed path | Tiers run |
|---|---|
| `src/providers/**`, `src/web/{server,ws}*` | quick + slow + e2e |
| `src/**`, `tests/**` | quick + slow |
| `tests/e2e/**` | e2e |
| `web/src/**` | all four frontend configs (plus Playwright, run separately) |
| `vitest.*.config.ts`, `tests/setup/**` | quick + slow |
| `package.json` / lockfile | quick + slow + frontend |
| `docs/**`, `site/**`, `ios-native/**`, `infra/**`, `.github/**`, assets | none |

`npm run test:changed` narrows the quick tier to the diff's module graph; `npm run test:pre-commit` runs the affected tiers in full. An unrecognised path always falls back to running the quick tier rather than skipping.

## L4 — CI (free)

`.github/workflows/ci.yml`: a `build` gate (type-check + build), then two jobs of test tiers as **parallel matrices** — each leg gets its own runner, so wall-clock is the slowest single tier rather than the sum. Locally the tiers are forced sequential because they share one machine; on CI parallel is free.

Blocking tiers (`quick`, `frontend`) and report-only ones (`slow`, `e2e`) are **separate jobs**, not one matrix with `continue-on-error: ${{ matrix.blocking == false }}`. Job-level `continue-on-error` has murky interaction with `needs.<job>.result` — a tolerated failure can still surface as `success` downstream — and the single check branch protection depends on must not rest on ambiguous semantics.

Branch protection should require the **`CI OK`** job, not individual matrix legs — leg names change whenever the matrix does, which silently orphans a required-check rule.

### Why some tiers are report-only

Measured 2026-07-25 against a clean clone of `main` (`844dc84`): the quick tier has **118 pre-existing failures on the committed tree** — stale test imports of exports deleted in 2026-05, tests that need a real `claude` CLI or daemon, assorted contract drift, and a few load-dependent flakes. A tier with a non-zero baseline cannot be a pass/fail gate: it would paint `main` permanently red, and an always-red check teaches everyone to ignore it.

So the quick tier goes through a **baseline gate** instead:

```bash
npm run test:baseline          # fails ONLY on failures absent from the baseline
npm run test:baseline:record   # re-snapshot (do this when you fix some)
```

`tests/setup/known-failures.json` is committed, so a PR that adds entries is visibly making things worse. The slow and e2e tiers stay report-only until they get the same treatment. **Move a tier into the blocking `test` job once its baseline reaches zero.**

Two properties make this gate trustworthy rather than decorative:

- **Collection failures count.** A file that dies at import time reports `status: "failed"` with an *empty* `assertionResults` array, so harvesting only assertion results made the most likely regression of a refactor — a broken import — produce zero new keys and pass. The gate now synthesizes a `<file failed to load or collect>` key for those.
- **A truncated run is never a pass.** If fewer than 290 files ran (real count: 306), the gate refuses to render a verdict, so a config that matches nothing can't read as green.

## How you learn CI failed, and how it gets fixed

GitHub emails the pusher on a failed run and shows a red X on the commit; the mobile app pushes a notification. To bring a failure down to where an AI can act on it:

```bash
scripts/ci-status.sh            # last 10 runs, one line each
scripts/ci-status.sh watch      # block until the in-flight run finishes
scripts/ci-status.sh fail       # failing steps of the latest failed run
scripts/ci-status.sh brief      # paste-ready digest: commit, failed jobs, error lines only
```

`brief` distils a ~10 000-line raw log down to the handful of real diagnostic lines, then tells you to hand it to a local session. **This keeps fixing free**: no API key, no paid AI action inside CI. The runners do the detecting; a local Claude Code session does the fixing.

## Machine safety

The suite is capped at **2 worker processes locally** (`tests/setup/worker-budget.ts`), tiers run sequentially (`scripts/test-parallel.mjs`), and a machine-wide gate admits one run group at a time (`tests/setup/test-gate.ts`). These caps exist because uncapped fan-out hard-crashed this Mac twice in July 2026. CI lifts the worker cap to 4 because a runner is an isolated single-purpose box.

Do not raise the local budget to "speed things up" — run L1, or L2 on the file you're editing.

## Full-suite anatomy (measured)

| Tier | Files | Time | Notes |
|---|---|---|---|
| quick | 306 | 51 s @4w | the every-change layer |
| slow | 26 | 311 s | real daemons/CLIs/servers |
| focus | any | — | `vitest.focus.config.ts` — runs whatever you name, incl. slow/e2e files |
| unit | 224 | — | `tests/{core,providers,agent,utils,logging,hooks,unit}` |
| integration | 112 | — | `tests/{web,integrations,commands,session-server}` |
| frontend | 11 | 10 s | 158 tests, baseline **zero** → blocks CI |
| e2e | 103 | ~120 s | own tier, own config |

Before 2026-07-25 the unit and integration tiers each collected ~336 files — the whole suite — because `mergeConfig` **concatenates** `include` arrays instead of replacing them, so each tier's narrowing list was appended to the base's `tests/**`. `npm test` therefore ran nearly every test twice (349 s + 397 s). Both configs now assign `include`/`exclude` after the merge; `tests/setup/quick-tier.test.ts` guards against the regression.
