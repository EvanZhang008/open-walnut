# Testing pipeline

Five layers, chosen so the one you run most often is the one that costs least. Run `npm run test:quick` on every change, `npm run test:pre-commit` before a bigger commit, and let GitHub Actions run everything on push — Actions is free for this repo (public repos get unlimited minutes on GitHub-hosted runners). Cross-machine features additionally need the L5 live journey before they count as done.

| Layer | Command | Scope | Time | When |
|---|---|---|---|---|
| **L1 quick** | `npm run test:quick` | ~1,500 fast test files | ~3 min (1 worker, machine-wide default) | every code change |
| **L2 focus** | `npm run test:focus <path>` | whatever you name | 0.3–30 s | while working on one module |
| **L3 pre-commit** | `npm run test:pre-commit` | the tiers your diff can break | 1–6 min | before a larger commit |
| **L4 CI** | GitHub Actions, automatic | everything + lint + build | ~6 min wall-clock, free | every push and PR |
| **L5 live** | `npm run test:live:cloud` / `test:live:daemon` | real cloud + real daemon, zero mocks | ~25 s / ~2 min | cross-machine feature sign-off; part of `test:full` |

## L5 — live journeys (why mocked-green is not enough)

Born from the 2026-08-07 incident: every mock-level suite was green while the real phone couldn't send a single message to a session it had just created. Two bugs hid in seams no mock reproduces — the git-synced projection lags a cloud-relayed launch by 1–3 minutes (404 storm), and the CLI spawn is async so an immediate send hit the resume path and got 409. The live layer (`tests/e2e/cloud-mobile-journey.live.test.ts`) drives the phone's exact request sequence against the REAL cloud companion → daemon bridge → primary box → real `claude` CLI, and asserts on the model's actual reply text, not HTTP status codes. Its first-ever run caught the second bug.

Rules that keep it honest and cheap:

- **Zero secrets in the repo** — `scripts/run-live-cloud-tests.sh` derives the cloud URL + device token from the data repo's git remote and injects them via env (in-process derivation is impossible: under VITEST, `WALNUT_HOME` is force-pointed at a temp dir). No cloud companion configured → loud SKIPPED banner, exit 0, explicitly non-authoritative.
- **Assert the end effect** — the journey passes only when the CLI's reply contains the unique marker the test sent. Anything less lets "accepted but never delivered" slip through.
- **Feed catches back down the pyramid** — every bug the live layer finds must be pinned as a fast mocked regression too (the spawn race lives on as an integration case with a mock daemon that answers `exists=false` twice). Live is for discovery; the cheap tiers are for retention.

## L1 — the fast tier

`vitest.quick.config.ts` runs everything EXCEPT the 26 files measured over 2 s (`tests/setup/slow-tests.ts`), the two end-to-end-heavy directories (`tests/e2e`, `tests/commands`), and the four frontend-rooted ones under `tests/web/` whose deps live in `web/node_modules`. Those 26 are slow because they start something real — a `claude` CLI, a local daemon, a git subprocess, an HTTP server — so they are exactly the wrong thing to run on every save.

The split is by **measured time**, not by a hand-drawn "unit vs integration" line. A new fast test is therefore included automatically; only a test that actually becomes slow needs a list entry. `npm run test:slow` runs exactly the complement, and `tests/setup/quick-tier.test.ts` asserts the two sets partition the suite with no overlap and no orphans (311 + 26 = 337).

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

Every vitest tier now blocks: `quick` (three shards) and `frontend` (the `test` job), `slow` (`test-heavy`) and `e2e` (`test-e2e`, four shards). Quick runs serial and took 25 minutes in one leg, the longest blocking job, so it runs as `--shard=1/3`..`3/3`. The browser suite is the one informational job, and it stays a **separate job**, not one matrix with `continue-on-error: ${{ matrix.blocking == false }}`. Job-level `continue-on-error` has murky interaction with `needs.<job>.result` — a tolerated failure can still surface as `success` downstream — and the single check branch protection depends on must not rest on ambiguous semantics.

All CI jobs force CPU-only QMD on Linux so test workers do not launch doomed Vulkan builds. The quick, slow and e2e jobs run with one worker because four workers oversubscribed the 4-core runner and produced changing, unrelated timeout failures across successive runs. The slow and e2e jobs also name a daemon directory of their own (`WALNUT_DAEMON_DIR`); the harness gives every worker a subdirectory of it (`tests/setup/runtime-dir-choice.ts`), because one shared directory let a test file's server adopt the daemon another file had started, with that file's home. The lightweight frontend tier remains parallel.

Branch protection should require the **`CI OK`** job, not individual matrix legs — leg names change whenever the matrix does, which silently orphans a required-check rule.

### Baseline gates

The quick tier currently has **one known failure on the committed tree**. A tier with a non-zero baseline cannot be a raw pass/fail gate: it would paint `main` permanently red, and an always-red check teaches everyone to ignore it.

So the quick and e2e tiers go through a **baseline gate** instead:

```bash
npm run test:baseline          # fails ONLY on failures absent from the baseline
npm run test:baseline:record   # re-snapshot (do this when you fix some)

# the e2e tier, as CI judges it
WALNUT_BASELINE_CONFIG=vitest.e2e.config.ts WALNUT_BASELINE_FILE=tests/setup/known-failures-e2e.json \
  WALNUT_BASELINE_MIN_FILES=120 node scripts/test-baseline.mjs check --maxWorkers=1
```

`tests/setup/known-failures.json` (quick) and `tests/setup/known-failures-e2e.json` (e2e) are committed, so a PR that adds entries is visibly making things worse. Both gates run per shard on CI: each leg judges only the files it ran (a baseline entry from another shard is neither new nor "fixed" there), and uploads its own failures as the `known-failures-e2e-<shard>` artifact (`WALNUT_BASELINE_RUN_OUT`), so a new e2e baseline is the union of the four artifacts of one run, with no second run of the tier. The slow tier has no baseline: it blocks on any failure.

Two properties make this gate trustworthy rather than decorative:

- **Collection failures count.** A file that dies at import time reports `status: "failed"` with an *empty* `assertionResults` array, so harvesting only assertion results made the most likely regression of a refactor — a broken import — produce zero new keys and pass. The gate now synthesizes a `<file failed to load or collect>` key for those.
- **A truncated run is never a pass.** Before the run the gate asks `vitest list` for the tier's files and cuts the run's `--shard` slice the way vitest does (sha1 of the root-relative path, `ceil(total / n)` per slice); every file of that slice must be in the report, and the ones that are not are named. `WALNUT_BASELINE_MIN_FILES` is a floor on the whole tier's listed files (default 1400; quick listed 1529 on 2026-10-02), for an include glob that broke. The fixed floor this replaced had gone stale (290 against 1529 files), so most of the tier could have vanished unnoticed. `tests/scripts/test-baseline-shard-cut.test.ts` checks the cut against the real vitest.

### A superseded run is not red

A newer push cancels the run in progress (`concurrency` with `cancel-in-progress`). `CI OK` used to run under `if: always()` and judge the cancelled legs, so every quick re-push left a red run behind: 6 of the 9 red runs on main between 2026-10-02 and 10-04. It now runs under `if: ${{ !cancelled() }}`: a run that ends cancelled has no verdict, and `scripts/ci-gate.mjs` reads it as `cancelled`, never `red`. A job that hits its timeout does not cancel the run, so `CI OK` still runs and fails on it.

### Flake hunt

`.github/workflows/flake-hunt.yml` runs after every green CI push on main and reruns the blocking legs (quick 1/3..3/3, e2e 1/4..4/4, slow) on that same commit, with CI's own arguments, workers, retries and baselines. A failure there is a flake by definition: the code passed minutes ago. Flakes are what turned innocent pushes red on 2026-10-02 (an inode the filesystem reused within one millisecond) and 10-03 (a log flush racing a directory removal); the hunt finds them on a commit that is already green, before they cost a push.

The hunt never paints a commit red or mails anyone: its legs stay green (`continue-on-error`), and `scripts/flake-report.mjs` turns what a leg found into warning annotations titled `Flaky test (<leg>)` (or `Flake hunt (<leg>)` when the leg failed with nothing to name: no report, a missing file, a setup step). The release watch reads those annotations and wakes the session that owns the pipeline. `tests/scripts/flake-hunt.test.ts` pins the legs to CI's.

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

The suite is capped at **2 worker processes locally** (`tests/setup/worker-budget.ts`), tiers run sequentially (`scripts/test-parallel.mjs`), and a machine-wide gate admits one run group at a time (`tests/setup/test-gate.ts`). These caps exist because uncapped fan-out hard-crashed this Mac twice in July 2026. CI configs default to 4 workers, but quick, slow, and e2e explicitly override that to one; only the lightweight frontend tier keeps the parallel default.

Do not raise the local budget to "speed things up" — run L1, or L2 on the file you're editing.

## Full-suite anatomy (measured)

| Tier | Files | Time | Notes |
|---|---|---|---|
| quick | ~1,500 | ~25 min @1w on CI, as three legs | the every-change layer |
| slow | 26 | 311 s | real daemons/CLIs/servers |
| focus | any | — | `vitest.focus.config.ts` — runs whatever you name, incl. slow/e2e files |
| unit | 224 | — | `tests/{core,providers,agent,utils,logging,hooks,unit}` |
| integration | 112 | — | `tests/{web,integrations,commands,session-server}` |
| frontend | 11 | 10 s | 158 tests, baseline **zero** → blocks CI |
| e2e | 103 | ~120 s | own tier, own config |

Before 2026-07-25 the unit and integration tiers each collected ~336 files — the whole suite — because `mergeConfig` **concatenates** `include` arrays instead of replacing them, so each tier's narrowing list was appended to the base's `tests/**`. `npm test` therefore ran nearly every test twice (349 s + 397 s). Both configs now assign `include`/`exclude` after the merge; `tests/setup/quick-tier.test.ts` guards against the regression.
