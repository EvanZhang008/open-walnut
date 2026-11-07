# Testing pipeline

## Two layers: the repository's own, and a maintainer's setup on top

Anyone develops Walnut with the repository alone: `bun install`, then `bun run test` while
working (the tests the change touches, about a minute), `bun run test:land` before a pull request
(every test the change needs, a few minutes), and GitHub's CI runs every tier on the pull request.
No remote machine, private script or GitHub run is needed to develop or test. The heavier tiers
(slow, e2e, browser, iOS, release rehearsals) belong on GitHub's runners, not on a laptop.

A maintainer's own setup (a land queue, a deploy, a test gate before a push to main) only adds
steps on top of those commands, never another copy of them: the light run happens wherever the
work is, the heavier ones on GitHub, then the merge. Nothing here chooses which machine runs a
test; the brakes that protect any computer (the Playwright lease on :3457 and its load wait, the
local worker budget) are in the repository and apply everywhere.

Layers chosen so the one you run most often is the one that costs least. Run `bun run test` (the same as `test:local`) on every change, `bun run test:land` before you land (the land runs it too), `bun run test:pre-commit` before a bigger commit, and let GitHub Actions run everything on push: Actions is free for this repo (public repos get unlimited minutes on GitHub-hosted runners). Cross-machine features additionally need the L5 live journey before they count as done.

| Layer | Command | Scope | Time | When |
|---|---|---|---|---|
| **L0 local** | `bun run test` / `test:local` | the tests of your change: its own tests, the fast direct importers, the cheapest scan tests | about a minute | every code change |
| **Land** | `bun run test:land` | every test the change needs, run to the end: its own tests (quick and slow tier), every quick test importing or naming a changed file, the scan tests up to 6 s; no timer, no budget | a few minutes | before a land; the land check runs it |
| **L1 quick** | `bun run test:quick` | the whole quick tier, ~3,200 files | ~10 min at 8 workers, much longer at 1 | when a change reaches far; the push gate runs it on GitHub |
| **L2 focus** | `bun run test:focus <path>` | whatever you name | 0.3 to 30 s | while working on one module |
| **L3 pre-commit** | `bun run test:pre-commit` | the tiers your diff can break | 1 to 6 min | before a larger commit |
| **Push gate** | `.husky/pre-push` (opt in: `git config walnut.pushGate true`) | CI's quick and frontend tiers, plus the browser specs the push touches, on GitHub's runners | ~25 min | every push to main |
| **L4 CI** | GitHub Actions, automatic | everything + lint + build | ~6 min wall-clock, free | every push and PR |
| **L5 live** | `bun run test:live:cloud` / `test:live:daemon` | real cloud + real daemon, zero mocks | ~25 s / ~2 min | cross-machine feature sign-off; part of `test:full` |
| **Fleet** | `bun run test:fleet` | the Mac + Linux host containers over real SSH, with link faults | ~3 min for both files once the image is cached | a change to how the Mac reaches, deploys to or hands over to a host; opt-in, never in CI |

Every layer runs on bun (1.4.4 or newer), and none needs Node. The package scripts start vitest as `bun --bun vitest`, by its bare name, so bun also puts its own `node` shim first on PATH and every `node` a test starts is bun too. `npx vitest` starts vitest on Node, and the global setup refuses that run (`tests/setup/runtime-deps.ts`). On macOS it also refuses a run whose databases would not open on Walnut's own SQLite build, the `vendor/sqlite/darwin/libsqlite3.dylib` that `bun install` compiles with DQS=0 (`bun scripts/build-sqlite-dylib.mjs` builds it again): the Apple build bun:sqlite loads otherwise fails every test that deletes an open database. Linux bun's own SQLite reads a double-quoted name that is no column as a string, so `tests/lib/sqlite-double-quote-ratchet.test.ts` keeps double quotes out of SQL strings in src/. CI's build and test jobs remove the runner image's Node before they install (`scripts/ci-remove-node.sh`), so a step that still needs Node fails there instead of on a machine without one; `tests/scripts/ci-bun-only.test.ts` pins that. What stays on Node is what a user runs on Node. The Playwright runner (the fixture servers it starts run on bun). The plugin package check, which packs, installs and tests the plugin packages with npm the way an outside plugin author does. The npm channel tests (`npm install -g open-walnut`, npm's own file lists), which skip where there is no npm (`tests/helpers/npm-on-path.ts`). And the daemon's JS twin, which a host without the compiled daemon runs on its own Node: every test that starts it runs it on the real Node when the machine has one, else on bun (`SOURCE_TWIN.file`, `tests/helpers/source-twin.ts`). CI runs all of these in the blocking `node-side` job (`test:plugin-packages`, `test:npm-channel`, `test:source-twin-node`, `test:source-twin-node-suites`; WALNUT_REQUIRE_NPM and WALNUT_REQUIRE_NODE turn a skip there into a failure), and the Playwright runner in the browser shards. Inside a vitest run the first `node` on PATH is bun's shim, so a test that needs the real Node finds it with `scripts/outside-node.mjs`.

## L5 — live journeys (why mocked-green is not enough)

Born from the 2026-08-07 incident: every mock-level suite was green while the real phone couldn't send a single message to a session it had just created. Two bugs hid in seams no mock reproduces — the git-synced projection lags a cloud-relayed launch by 1–3 minutes (404 storm), and the CLI spawn is async so an immediate send hit the resume path and got 409. The live layer (`tests/e2e/cloud-mobile-journey.live.test.ts`) drives the phone's exact request sequence against the REAL cloud companion → daemon bridge → primary box → real `claude` CLI, and asserts on the model's actual reply text, not HTTP status codes. Its first-ever run caught the second bug.

Rules that keep it honest and cheap:

- **Zero secrets in the repo** — `scripts/run-live-cloud-tests.sh` derives the cloud URL + device token from the data repo's git remote and injects them via env (in-process derivation is impossible: under VITEST, `WALNUT_HOME` is force-pointed at a temp dir). No cloud companion configured → loud SKIPPED banner, exit 0, explicitly non-authoritative.
- **Assert the end effect** — the journey passes only when the CLI's reply contains the unique marker the test sent. Anything less lets "accepted but never delivered" slip through.
- **Feed catches back down the pyramid** — every bug the live layer finds must be pinned as a fast mocked regression too (the spawn race lives on as an integration case with a mock daemon that answers `exists=false` twice). Live is for discovery; the cheap tiers are for retention.

## Fleet: separate machines on one Mac (opt-in)

The in-process cluster (`tests/helpers/replica-cluster.ts`) runs every piece as a process on this machine: one filesystem, one clock, and a test transport where a real host has SSH. The fleet (`tests/fleet/`, see its README) keeps the Mac on this machine as an isolated server child (its own data, daemon and temp dirs, HOME and port) and puts each host in its own Linux container, which the Mac reaches the way it reaches a real host: OpenSSH with a key and config made for the run, the daemon deployed over that SSH (nothing is preinstalled), the ControlMaster, the tunnel and the bulk lane, all through a fault proxy on 127.0.0.1. The host's `claude` is a mock, so no model is called.

Faults are methods of the fleet: the lid (SIGSTOP and SIGCONT of the Mac processes the run started and pinned), `docker pause` of a host, a link cut silent, severed or dropped, a slow link, a cap on bytes per connection, and a clock offset on a host (libfaketime). Assertions read the stores themselves: the Mac's `tasks.sqlite` (read only) and its log, and the host's stream, journal and copy files through `docker exec`.

| File | What it proves | Time |
|---|---|---|
| `tests/fleet/mac-and-host.fleet.ts` | add a host, deploy over SSH, a session answers; notes and memory reach the host copy without the folder it does not keep; a write made while the lid is closed, and one made across a cut link, is journaled on the host and applied once | ~1 min |
| `tests/fleet/host-faults.fleet.ts` | a deploy through a link that cuts large transfers falls back to chunks; a host frozen mid-turn delivers its write and reply once; a host 10 minutes behind journals a write that the Mac applies once | ~2 min (70 s of it is the chunked deploy) |

When to run it: a change to how the Mac deploys to or reaches a host (`daemon-connection.ts`, `ssh-control-master.ts`, the deploy), to the offline host and its journal, or to what a host keeps. Not on every change, and never in CI: it needs Docker. Without Docker each file prints a SKIPPED line and the script exits 0, which proves nothing.

Cost: the first run pulls `node:22-bookworm-slim` and builds the host image (a minute or two); both are cached after that, until `bash scripts/run-fleet-tests.sh clean`. Each container is capped at 1 GB, 1.5 CPUs and 512 processes, and binds on 127.0.0.1 only. It holds a Walnut server, its daemons and one container per host, so run one fleet at a time, on a machine that is not already busy.

What it caught that the cluster could not (2026-10-23): the ControlMaster socket path limit was 100, but `ssh -M` binds `<ControlPath>.<16 random chars>` before renaming it into place, so on macOS (104 bytes) any path of 87 to 100 characters failed with `too long for Unix domain socket`, and that host ran without a master. The cluster has no SSH, so it could never see it.

## L0 and the land layer: the tests of one change

`scripts/test-layers.mjs` picks the tests a change can break, from the quick tier only (never the slow, quarantined, e2e or live files), and runs them (`run local|land`; `plan` lists them with the reason for each, `--base <ref>` is the diff base, `--changed-from <file>` reads the changed paths from a file, `--json <file>` writes the verdict). It reads the per-file times of `tests/setup/test-durations.json` (`bun scripts/test-layers.mjs measure [--maxWorkers=N]` runs the whole quick tier and rewrites it; a file's cost counts its worker start, environment, setup files and imports as well as its tests, through `scripts/lib/duration-reporter.mjs`, since vitest's JSON report times only the tests). A layer is the union of:

- the changed test files of the quick tier;
- the tests importing a changed file directly, and the tests naming a changed path (`scripts/test-changed-refs.mjs`): all of them in the land layer, whatever they cost; the local layer takes only those under 1.5 s, at most 60, cheapest first, and leaves the rest to the land;
- the change's own test files in the slow tier, run with `vitest.slow.config.ts`, one at a time;
- the scan tests: a test named `*ratchet*` or `*guard*`, or one that reads the source tree and starts no server, up to 0.5 s each local (the cheapest third, a cost counting the file's worker start and imports) and 6 s for a land. They are rule checks over the whole tree, so any change can break one, and in the land history of 2026-11-01..07 they caught most of the real problems;
- for a change to the test setup (a vitest config, `tests/setup/`, `package.json`, `bun.lock`), the setup's own tests.

A file that fails is run once more, alone: failing again fails the run, passing alone is reported as flaky and does not; a file that never reports counts as failed, and so does a vitest exit with an error no file explains (an unhandled rejection: the JSON report leaves those out). A deleted or renamed module still selects the tests that import it. Replayed on the refused lands of 2026-11-05..07, the land layer still selects a real failing test for 24 of 25 real refusals (the files of 4 more were deleted since).

## Quarantine

`tests/setup/quarantine.ts` lists test files that fail at random: on a clean main, or in the land checks of four or more unrelated tasks, and never for a real problem. A listed file leaves the quick tier (so local runs, land checks and the push gate) and runs in the slow tier, which CI runs on every push with retries, so it still runs while it is being fixed. Every entry names its date, reason and evidence; `bun scripts/test-layers.mjs report` names entries older than 21 days. Scan tests are never quarantined: a rule check that times out is made faster. `tests/setup/quick-tier.test.ts` keeps the partition whole.

## L1 — the fast tier

`vitest.quick.config.ts` runs everything EXCEPT the files measured over 2 s (`tests/setup/slow-tests.ts`), the three heavy directories (`tests/e2e`, `tests/commands`, `tests/mcp`), and the four frontend-rooted ones under `tests/web/` whose deps live in `web/node_modules`. The slow files are slow because they start something real (a `claude` CLI, a local daemon, a git subprocess, an HTTP server), so they are exactly the wrong thing to run on every save.

The split is by **measured time**, not by a hand-drawn "unit vs integration" line. A new fast test is therefore included automatically; only a test that actually becomes slow needs a list entry. `bun run test:slow` runs exactly the complement: the slow list plus `tests/commands` and `tests/mcp` (`tests/e2e` has its own tier). `tests/setup/quick-tier.test.ts` asserts that every test file lands in exactly one tier, by the real configs' globs: quick, slow, e2e, live, or one of the four frontend configs. Until 2026-10-24 the slow config named only the file list, so the 18 files of `tests/commands` and `tests/mcp` ran in no CI job.

## L2 — focus one path

```bash
bun run test:focus tests/core/task-manager.test.ts   # one file
bun run test:focus tests/core                        # one directory
bun run test:focus -- -t 'reorder'                   # one test by name
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

`bun run test:changed` narrows every vitest tier it runs, slow and e2e included, and `bun run test:pre-commit` runs the affected tiers in full. Narrowing runs `vitest related` on the changed files plus every test-side file that names one of them by path (`scripts/test-changed-refs.mjs`), so vitest keeps a tier's tests whose import graph reaches either. The second half matters because many tests reach code without importing it: the twins suites start `src/providers/daemon-standalone.ts` as a child process, a ratchet reads a file as text, a test runs `scripts/dev-prod.sh`. For a change to the daemon alone, the import graph picks none of the 92 slow files, and the path scan adds the 21 that run it. Each tier prints how many files it selected before it runs (`scripts/vitest-selection-reporter.mjs`). A tier that selected none prints that nothing ran, and is never reported as passed. `bun scripts/test-changed.mjs --plan` prints what would run and runs nothing. An unrecognised path always falls back to running the quick tier rather than skipping.

Narrowing alone does not make `test:changed` short for most `src/` changes: nearly every module sits in the import component the server pulls in, so a change to `src/core/types.ts` or `src/web/server.ts` still reaches about 1,360 of the 2,315 quick files, 66 of the 92 slow-list files and 183 of the 192 e2e files (static estimate, 2026-10-24). What it saves is the tiers a change cannot reach at all, such as a test-only change, a script, or the daemon. The quick tier's own size is set by the measured split below.

## L4 — CI (free)

`.github/workflows/ci.yml`: a `build` gate (type-check + build), then two jobs of test tiers as **parallel matrices** — each leg gets its own runner, so wall-clock is the slowest single tier rather than the sum. Locally the tiers are forced sequential because they share one machine; on CI parallel is free.

Every vitest tier now blocks: `quick` (eight shards) and `frontend` (the `test` job), `slow` (`test-heavy`) and `e2e` (`test-e2e`, six shards). Quick runs serial and took 25 minutes in one leg, the longest blocking job, so it runs as `--shard=1/8`..`8/8`. The browser suite is the one informational job, and it stays a **separate job**, not one matrix with `continue-on-error: ${{ matrix.blocking == false }}`. Job-level `continue-on-error` has murky interaction with `needs.<job>.result` — a tolerated failure can still surface as `success` downstream — and the single check branch protection depends on must not rest on ambiguous semantics.

All CI jobs force CPU-only QMD on Linux so test workers do not launch doomed Vulkan builds. The quick, slow and e2e jobs run with one worker because four workers oversubscribed the 4-core runner and produced changing, unrelated timeout failures across successive runs. The slow and e2e jobs also name a daemon directory of their own (`WALNUT_DAEMON_DIR`); the harness gives every worker a subdirectory of it (`tests/setup/runtime-dir-choice.ts`), because one shared directory let a test file's server adopt the daemon another file had started, with that file's home. The lightweight frontend tier remains parallel.

Branch protection should require the **`CI OK`** job, not individual matrix legs — leg names change whenever the matrix does, which silently orphans a required-check rule.

### Baseline gates

The quick tier currently has **one known failure on the committed tree**. A tier with a non-zero baseline cannot be a raw pass/fail gate: it would paint `main` permanently red, and an always-red check teaches everyone to ignore it.

So the quick and e2e tiers go through a **baseline gate** instead:

```bash
bun run test:baseline          # fails ONLY on failures absent from the baseline
bun run test:baseline:record   # re-snapshot (do this when you fix some)

# the e2e tier, as CI judges it
WALNUT_BASELINE_CONFIG=vitest.e2e.config.ts WALNUT_BASELINE_FILE=tests/setup/known-failures-e2e.json \
  WALNUT_BASELINE_MIN_FILES=120 bun scripts/test-baseline.mjs check --maxWorkers=1
```

`tests/setup/known-failures.json` (quick) and `tests/setup/known-failures-e2e.json` (e2e) are committed, so a PR that adds entries is visibly making things worse. Both gates run per shard on CI: each leg judges only the files it ran (a baseline entry from another shard is neither new nor "fixed" there), and uploads its own failures as the `known-failures-e2e-<shard>` artifact (`WALNUT_BASELINE_RUN_OUT`), so a new e2e baseline is the union of the six artifacts of one run, with no second run of the tier. A failure absent from the baseline gets one more chance before it fails a gate: its file runs again alone, and a test that passes there is named as a flaky-test warning (`::warning` on GitHub) and not counted, the land check's rule for a timing failure under load (2026-11-08: two pushes were refused on one-off timing failures that every later commit passed). `WALNUT_BASELINE_RERUN=0` turns that off. The slow tier has no baseline: it blocks on any failure.

Two properties make this gate trustworthy rather than decorative:

- **Collection failures count.** A file that dies at import time reports `status: "failed"` with an *empty* `assertionResults` array, so harvesting only assertion results made the most likely regression of a refactor — a broken import — produce zero new keys and pass. The gate now synthesizes a `<file failed to load or collect>` key for those.
- **A truncated run is never a pass.** Before the run the gate asks `vitest list` for the tier's files and cuts the run's `--shard` slice the way vitest does (sha1 of the root-relative path, `ceil(total / n)` per slice); every file of that slice must be in the report, and the ones that are not are named. `WALNUT_BASELINE_MIN_FILES` is a floor on the whole tier's listed files (default 1400; quick listed 1529 on 2026-10-02), for an include glob that broke. The fixed floor this replaced had gone stale (290 against 1529 files), so most of the tier could have vanished unnoticed. `tests/scripts/test-baseline-shard-cut.test.ts` checks the cut against the real vitest.

### The browser suite's baseline

The Playwright suite (`tests/e2e/browser/`, sixteen CI shards) has its own list, `tests/setup/known-failures-browser.json`, keyed `spec file :: describe › title`. First recorded 2026-10-31 from two CI runs: 516 tests, the union of what failed in either. Each shard only reports; the `Browser baseline` job reads the `browser-report-<n>` artifacts and fails on a failure the list does not name, or on an error outside a test (a spec that does not load, a fixture server that does not start):

```bash
bun scripts/browser-baseline.mjs check <reports dir | report.json>...           # judge reports (what CI does)
bun scripts/browser-baseline.mjs record [--prune] <reports dir | report.json>... # update the list from them
bun run test:browser:baseline [playwright args]                                 # run the suite here, then judge
```

A test counts as failed only when it failed on every retry: flaky is a pass, and a test that never ran (skipped, or cut off by a shard's 45-minute `--global-timeout`) is neutral. `record` only adds: new failures go in, and a test gone from a spec file that ran goes out. A known failure that passes stays, because about 86 of them came and went between two CI runs of one day; after fixing one, prune it from a run that repeats the fixed specs: `bun scripts/browser-baseline.mjs record --prune --run --repeat-each=3 <specs>`. With eight shards, six ran out of time and about 760 tests never ran in two runs in a row; sixteen fit. `Browser baseline` is not in `CI OK`, so a release never waits on it, but its red turns the run red. Fix the clusters at the root; a spec that tests a removed feature is deleted, with the reason in its commit.

### The iOS app's tests

The `iOS app` job (`ios` in `ci.yml`, two legs on `macos-26`) runs the phone app's tests on a simulator for every push to main and every pull request: `unit` runs `xcodebuild test -only-testing:WalnutTests`, `ui` runs WalnutUITests through `ios-native/tests/ui/run-ui-tests.sh` at its offline pairing (a dead loopback port). It reads no secret and signs nothing; a TestFlight build needs the signing certificate and the App Store Connect key, which are the owner's to add. It is not in `CI OK`. The `unit` leg was in it for a day (2026-10-31) and left after two failures, one of them with nothing readable without a login; it goes back after five green runs in a row now that each failed test is an annotation (`ios-native/tests/failed-tests.py`), which the public API serves with no login. The `ui` leg may fail without failing the run (`continue-on-error`). Two lists in the job's `env` leave work to the Mac: `IOS_CI_SKIP_UNIT` skips the perf gates whose wall-clock budgets a shared runner misses (run 41198110591: a 150 ms tick took 193 ms, a 762 ms parse 1586 ms), and `IOS_CI_SKIP_UI` skips the UI classes that need their own fixture server (`run-media-ui.sh`, `run-inbox-items-ui.sh`, the peer and stub servers, a voice model) and fail by design on the offline pairing, and the classes that drive the home screen (SpringBoard), whose animations stalled 60 s at a time on a runner (run 41225175176, VoiceQuickActionUITests). `tests/scripts/ci-ios.test.ts` pins that shape, and fails when a new timing class, a new fixture class or a new home screen class is in neither list nor marked as fine on a runner. Unit tests wait by the clock, never by a count of `Task.yield()`, and UI tests wait for a menu entry before they tap it; the same file fails on a new wait of either shape.

### A superseded run is not red

A newer push to a pull request cancels its run in progress (`concurrency` with `cancel-in-progress`). A run on main is never cancelled: a run takes about an hour and main takes a push every 13 minutes or so, so on 2026-10-31 40 of 40 runs on main had been cancelled and no commit could be released. GitHub keeps the newest pending run per group, so main gets a verdict about every hour. The binary matrix gives each push to main a group of its own commit, so the commit CI passed always has its own matrix verdict too. `CI OK` used to run under `if: always()` and judge the cancelled legs, so every quick re-push left a red run behind: 6 of the 9 red runs on main between 2026-10-02 and 10-04. It now runs under `if: ${{ !cancelled() }}`: a run that ends cancelled has no verdict, and `scripts/ci-gate.mjs` reads it as `cancelled`, never `red`. A job that hits its timeout does not cancel the run, so `CI OK` still runs and fails on it.

### Flake hunt

`.github/workflows/flake-hunt.yml` runs after every green CI push on main and reruns the blocking legs (quick 1/8..8/8, e2e 1/6..6/6, slow) on that same commit, with CI's own arguments, workers, retries and baselines. A failure there is a flake by definition: the code passed minutes ago. Flakes are what turned innocent pushes red on 2026-10-02 (an inode the filesystem reused within one millisecond) and 10-03 (a log flush racing a directory removal); the hunt finds them on a commit that is already green, before they cost a push.

The hunt never paints a commit red or mails anyone: its legs stay green (`continue-on-error`), and `scripts/flake-report.mjs` turns what a leg found into warning annotations titled `Flaky test (<leg>)` (or `Flake hunt (<leg>)` when the leg failed with nothing to name: no report, a missing file, a setup step). The release watch reads those annotations and wakes the session that owns the pipeline. `tests/scripts/flake-hunt.test.ts` pins the legs to CI's.

### The test gate before a push to main

Every team pushed to main without CI's checks, so one team's red test turned every later run red and mailed "Run failed" each hour for a day (2026-11-04: most of those failures were new ratchets and guards that CI's quick tier catches). `scripts/push-gate.sh`, run by `.husky/pre-push` after the type check and the leak scan, runs the blocking checks on the commit being pushed before main moves: the quick tier (`scripts/test-baseline.mjs check`, judged against `tests/setup/known-failures.json` as CI judges it), the frontend tier (`test:frontend:ci`), and the browser specs the push touches (a changed spec, or a spec importing a changed browser helper) through `scripts/browser-baseline.mjs check --run` with CI's one retry. A push that fails is refused, and the gate prints the failing tests and every commit the push carries, so the committer knows whose test it is.

It runs on GitHub's own runners: the hook pushes the commit to `refs/gate/<sha>-<push time>` of the same remote, a ref GitHub shows nowhere (a `gate/<sha>` branch put a "Compare & pull request" banner on the repository's page for each run), and dispatches `.github/workflows/push-gate.yml` on main for that commit, which runs ci.yml's quick and frontend legs on it command for command (`tests/scripts/push-gate-workflow.test.ts` pins that) plus the touched browser specs, and writes commit statuses, one per tier and `walnut/push-gate` for the whole. The hook waits for that one (75 minutes at most, `WALNUT_PUSH_GATE_TIMEOUT`), deletes the ref (also when a signal stops it), and pushes main only on success. A commit that changes the gate workflow, or a main whose workflow takes no dispatch yet, runs on a `gate/<sha>` branch instead, so it runs its own copy. `scripts/push-gate-sweep.sh` removes a gate ref whose run ended over an hour ago (a hook that was killed cannot delete its own); the hook starts it in the background and `.github/workflows/push-gate-sweep.yml` runs it every hour. A pass is kept on this machine by the files it judged (`~/.cache/walnut-push-gate/<tree>`, 14 days), so the same files pushed as another commit pass at once. `walnut-cloud push` runs the gate before it takes its push lock (`push-gate.sh --run <url> <commit>`), so no push waits behind another's tests: since the Mac's main and GitHub's carry the same files under other commits, `--run` sends the commit's files as one new commit on GitHub's main, never the Mac's own history, and the push's hook then finds the verdict for those files. A failing test never fails the gate's run (the test steps may fail; the verdict is a status), so the gate mails nobody. Run on a shared dev host instead, the same tiers took 41 minutes and reported 15 failures, all but one from that host's load and toolchain, which is why the gate uses CI's runners.

It judges only a push to `refs/heads/main`, and it is off unless asked for, so an outside contributor's push is unchanged (GitHub's CI judges a pull request). Turn it on where main is pushed (it needs `gh` signed in there):

```bash
git config --global walnut.pushGate true
```

`git config walnut.testRunner '<prefix>'` runs the tiers through a command prefix on a test host instead (the push must then come from a clean checkout of the commit, since the runner tests that checkout; it exits 255 when it could not run them). A gate that cannot judge (no answer in time, an unreachable runner) refuses the push, because an unchecked push is what the gate stops. `WALNUT_PUSH_GATE=0` skips it for one push (say why in the task), `WALNUT_PUSH_GATE=1` turns it on for one push. Browser specs a side config owns (`tests/e2e/browser/side-config-specs.ts`), a change to the shared fixture or a config, a helper no spec imports directly, and a helper so shared that it maps to more than 30 specs are left to CI's browser shards, and the gate prints which. A flaky test is fixed at its cause, never retried past: the gate's one browser retry is CI's own. `tests/scripts/push-gate.test.ts` pins the gate's behavior with a stub `gh`, a local remote and a stub runner.

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

The suite is capped at **1 worker process locally** (`tests/setup/worker-budget.ts`), tiers run sequentially (`scripts/test-parallel.mjs`), and a machine-wide gate admits one run group at a time (`tests/setup/test-gate.ts`). These caps exist because uncapped fan-out hard-crashed this Mac twice in July 2026. CI configs default to 4 workers, but quick, slow, and e2e explicitly override that to one; only the lightweight frontend tier keeps the parallel default.

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

`bun run test:ci` (`scripts/test-parallel.mjs`) runs exactly the set CI runs, one tier after another: quick, slow, e2e, then the four frontend configs through `scripts/test-frontend.mjs`. Until 2026-10-24 it ran unit + integration + e2e + three frontend configs instead, which missed 201 files that CI runs (`tests/scripts`, `tests/lib`, `tests/replica`, `tests/setup`, `tests/integration` and others) and the notes-roundtrip config. Every unit and integration file is in quick or slow, so nothing dropped out. `bun run test:unit` and `test:integration` still run those two configs on their own.

Before 2026-07-25 the unit and integration tiers each collected ~336 files — the whole suite — because `mergeConfig` **concatenates** `include` arrays instead of replacing them, so each tier's narrowing list was appended to the base's `tests/**`. `npm test` therefore ran nearly every test twice (349 s + 397 s). Both configs now assign `include`/`exclude` after the merge; `tests/setup/quick-tier.test.ts` guards against the regression.
