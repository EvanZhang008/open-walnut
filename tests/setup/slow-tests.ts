/**
 * The measured slow-test list — files that take >2s and therefore cannot live in
 * the fast feedback tier (`npm run test:quick`).
 *
 * This list is DATA, not judgement: it was produced by running the whole suite
 * with `--reporter=json` and taking every file whose wall-clock exceeded 2000ms
 * (2026-07-25). Slowness here is almost always "this file starts a real process"
 * — a local daemon, a `claude` CLI, an ssh preamble, a git subprocess — or waits
 * on a real timeout. Those are exactly the tests that must still run, just not on
 * every keystroke.
 *
 * Keeping it in one module (rather than inline in a config) means:
 *   - `test:quick` excludes it, and
 *   - `test:slow` includes EXACTLY it,
 * so the two tiers are complementary by construction and no file can silently
 * fall out of both. tests/setup/quick-tier.test.ts asserts that partition.
 *
 * Maintenance: re-measure rather than hand-edit. See docs/reference/testing-pipeline.md.
 */

/**
 * NOTE (2026-07-26): tests/web/routes/sessions.test.ts left this list — it went 60s
 * -> 1.1s. Two of its tests each burned the full 30s WAIT_TIMEOUT_MS in
 * src/web/routes/sessions.ts's /execute handler waiting for a SESSION_START that no
 * subscriber would ever answer (the tests literally assert
 * `bus.has('session-runner') === false` first). That fix is a ONE-LINE early bail in
 * the route and is NOT committed here, because sessions.ts has uncommitted work from
 * another agent. If this file creeps back to 60s, that guard was lost.
 */

/** Files measured >2s. Paths are repo-root-relative, matching vitest's include/exclude. */
export const SLOW_TEST_FILES = [
  // ── Spawns a real `claude` CLI / local daemon (the heavyweights) ────────────
  // Was 278s — 80% of the old "unit" tier in one file. Two fixes, both root causes:
  // (a) no daemon existed to spawn sessions, so 44 tests threw on construction and
  // 14 more sat out a 15s timeout; a file-level MockDaemon fixed that. (b) an
  // unconditional 200ms sleep in afterEach x 133 tests, plus three flat 1.5-3s
  // sleeps waiting out an anti-loop window. Now 48s, and still here because it
  // spawns real mock-CLI processes.
  'tests/providers/claude-code-session.test.ts', // 48s
  'tests/providers/local-daemon.test.ts', // 41s
  'tests/providers/local-daemon-session-e2e.test.ts', // 29s
  'tests/providers/claude-stream-partial.e2e.test.ts', // 11s
  'tests/providers/acp-worker.test.ts', // 9s
  'tests/providers/pi-acp-bundle.test.ts', // 6.5s
  'tests/providers/session-io.test.ts', // 2.5s (was 9s — dead RemoteIO suites + afterEach sleep)
  // 3-5s: compiles desktop/SessionHost.swift once (the same file Walnut.app is
  // built from) and runs it — the only way to ask macOS who it holds responsible
  // for the processes below it.
  'tests/providers/session-host-native.test.ts',
  'tests/core/calendar-bridge-native.test.ts', // compiles the calendar protocol twice with swiftc
  'tests/core/reader-bridge-native.test.ts', // ~18s: compiles walnut-reader.swift twice with swiftc
  'tests/providers/acp-daemon.test.ts', // 7s
  // Starts real worker processes (built from source by tests/helpers/acp-worker-bundle.ts).
  'tests/providers/acp-straggler-sweep.test.ts',
  'tests/providers/session-background-workflow.test.ts', // 0.3s (was 5s — afterEach sleep was 90% of it)
  'tests/providers/daemon-transport-unit.test.ts', // 3s
  'tests/providers/daemon-triggers.test.ts', // ~35s: real daemon + real check processes on a 5s clock
  'tests/integration/trigger-checked-replay-twins.test.ts', // ~260s measured: the real daemon, offline checks, reboots and failure recovery
  'tests/integration/trigger-unsent-checks-daemon.test.ts', // ~72s measured: the real daemon checks on its 10s clock with no server, then a restart
  'tests/integration/trigger-host-delivery-daemon.test.ts', // ~60s: the daemon, real sessions, waits out the host grace and the 5s tick
  'tests/providers/remote-session-manager-session-state.test.ts', // 2s
  'tests/integration/agent-gateway.test.ts', // ~10s — real daemon per test + a 2s hub timeout
  'tests/integration/host-server-twins.test.ts', // ~40s: the daemon as a process, a 5s restart backoff, a daemon restart each
  'tests/integration/plugin-jobs-twins.test.ts', // ~30s: the daemon as a process runs plugin jobs, a 5s restart backoff, a 3s every job, a daemon restart each
  'tests/integration/bridge-stream-twins.test.ts', // ~20s: the daemon as a process dials a /bridge, streams to the primary (WP13)
  'tests/integration/replica-front-twins.test.ts', // ~4 min: the daemon supervises a real `web --replica` (tsx), a 6s quiet window, a crash loop to the fallback
  'tests/integration/clock-routine-twins.test.ts', // ~7 min: the daemon as a process, clock slots, daemon restarts, replays until acked, routine runs the host starts
  'tests/integration/journal-v2-twins.test.ts', // ~3 min: the daemon as a process, SIGKILL and reboot, a 1fe1fd194 daemon, 1,000 appends, a 30s quiet window
  'tests/integration/replica-local-routes-twins.test.ts', // the daemon as a process, the real startServer as its host replica, a 13 MB copy
  'tests/integration/note-journal-twins.test.ts', // the daemon as a process, a follower and a session saving one note, 120 autosaves, a drain (WP11)
  'tests/core/offline-merge/notes-property.test.ts', // ~90s: 1,000 seeded runs, three drain orders each, every one in a fresh temp vault (WP11)
  'tests/core/leader/permit/model-check.test.ts', // ~6 min: about 1,300 seeded 15-minute schedules of the write permission (op sends, two processes a machine), safe and with each safety part removed
  'tests/core/leader/permit/instance.test.ts', // ~11s: the instance lock between real processes (a crash, SIGSTOP past the stale time)
  'tests/core/leader/permit/net-slow-witness.test.ts', // ~3s: 10-minute simulated leaders with one slow witness, through the real network transport
  'tests/core/leader/switch/promote-daemon-runtime.test.ts', // a real daemon (on bun) writing in a home promoted twice around it
  'tests/core/leader/switch/witness-route.test.ts', // real leader doors on loopback sockets, witness records on disk
  'tests/core/leader/switch/witness-twin.test.ts', // a real host daemon runtime in a bun process relaying the leader's stream to a real leader door
  'tests/core/leader/switch/witness-setup.test.ts', // real witness doors on loopback sockets, three machines' records on disk
  'tests/core/leader/switch/witness-link-gate.test.ts', // a real permit runtime, the daemon link spied on, loopback witness doors
  'tests/core/leader/switch/witness-reader.test.ts', // a real permit runtime over three remote witness doors, and the route that reads them
  'tests/core/leader/switch/witness-transport.test.ts', // three witness machines on loopback sockets: a permit client over real HTTP, the renew round trip measured
  'tests/core/leader/switch/witness-door.test.ts', // three direct witness doors behind TLS on loopback: a permit client over them, every refusal, the renew round trip measured
  'tests/core/leader/switch/witness-ways.test.ts', // three witness machines on loopback sockets: way a and way c on one record
  'tests/core/leader/switch/retake-after-handover.test.ts', // ~35s: a real permit runtime waits out a handover's 20 s holds at two witnesses, one out of reach
  'tests/core/leader/permit/change-repair.test.ts', // ~4s: 35 ten-minute schedules of candidates racing for the permission (back-off)
  'tests/core/offline-merge/notes.test.ts', // ~3s: two 1 MB merges in a worker thread under the stall recorder, one waits out the 2 s deadline (WP11)
  'tests/integration/replica-ask-twins.test.ts', // the daemon as a process, mock CLIs spawned from the spawn template, a resume, ten asks an hour
  'tests/providers/follower-owner-scope-twins.test.ts', // the daemon as a process, two Walnuts and mock CLIs (WP6 owner scope)
  'tests/core/cloud-setup/cli-exec.test.ts', // real shell/node subprocesses
  'tests/providers/daemon-connection-upload-fake-ssh.test.ts', // ~5s idle, ~20s at load 27: a stand-in ssh process per chunk, ~90 of them
  'tests/utils/file-lock-multiprocess.test.ts', // ~1.5s idle, 3s+ under load: four real locker processes
  'tests/core/self-update/install-lock-multiprocess.test.ts', // updater processes and install.sh runs on one root
  'tests/core/self-update/startup-update-wait.test.ts', // a real process waits out a 1.5 s detached install
  'tests/integration/cloud-setup-e2e.test.ts', // real cloud-mode HTTP server + git sync

  // ── Real git subprocesses (repo creation, history rewrite, packing) ─────────
  'tests/integrations/git-compaction.test.ts', // 67s
  // ~21s: a fake slow git on PATH (1s per step) and a step cut at its deadline.
  'tests/integrations/git-compaction-recovery-async.test.ts',
  // 13-19s per test at idle load: 5 real repos + a bare hub, ~480 real commits,
  // a force-with-lease push, and `git gc --prune=now`. It sat in the quick tier
  // straddling that tier's 15s timeout, so which of its tests failed shifted run
  // to run — a margin, not a logic bug. Measured, not guessed.
  'tests/integrations/git-compaction-remote.test.ts', // 13-19s
  'tests/integrations/git-sync.test.ts', // 11s
  'tests/integrations/git-sync-mass-revert-guard.test.ts', // many real repos and commits
  'tests/integrations/git-sync-health.test.ts', // 6s: real repos, commits and ls-files
  'tests/core/plugins/linked-checkout.test.ts', // 4s: bare origin + publisher + linked clone
  'tests/providers/git-commit-core.test.ts', // ~46s at load 200: ~15 temp repos, hooks, bare remotes, real pushes
  'tests/providers/git-commit-twin-parity.test.ts', // ~2.5s at load 200: two temp repos + the full source-twin build
  'tests/providers/turn-snapshot-core.test.ts', // ~24s: 32 tests, each on its own temp repo with real snapshot refs
  'tests/providers/workspace-core.test.ts', // 10-19s: real git worktrees and provider processes in temp dirs
  'tests/providers/workspace-core-recheck.test.ts', // ~8s: real worktrees, bare remotes, fetches and the provider process
  'tests/providers/daemon-workspace-twins-e2e.test.ts', // 6-15s: boots the daemon and makes real worktrees
  'tests/providers/daemon-standalone-no-bash.test.ts', // ~2.5s: boots the daemon twice and starts a shim CLI under it

  // ── Real HTTP server + session plumbing ────────────────────────────────────
  'tests/scripts/devprod-render-check.test.ts', // ~25s — launches a headless Chromium per verdict
  'tests/scripts/cloud-ensure-harness.test.ts', // ~75s: 67 tests, mostly real runs of the harness script and setup.sh blocks (bash + node) in a sandbox
  'tests/scripts/companion-launch.test.ts', // ~13s: the companion launcher as a real process, with trial deadlines and signal waits
  'tests/scripts/release-promote-steps.test.ts', // ~10-40s: the release job's steps against a bare origin, real git pushes
  'tests/scripts/test-layers-run.test.ts', // ~5-10s: real vitest runs of a scratch project (the layer runner's verdicts, the duration reporter)
  'tests/scripts/install-sh.test.ts', // ~40s: 20 cases of real install.sh runs against a local release server, under sh and dash
  'tests/scripts/cli-fast-bytecode.test.ts', // ~5-15s: bun builds the real dist/cli-fast.js (20 MB), then a dozen CLI runs of it
  'tests/scripts/file-distribution.e2e.test.ts', // builds the real compiled file at two versions (minutes; cached by content), then install.sh, npm and self-update end to end
  'tests/scripts/test-baseline-shard-cut.test.ts', // ~5-15s: three real nested vitest runs, checking the gate's --shard cut
  'tests/lib/hybrid-search-embed-worker-process.test.ts', // ~5-15s: real node hosts and workers through tsx
  'tests/core/components/features.test.ts', // ~5-10s: packs the real component archives (gzip -9 of ~55 MB) and installs them
  'tests/providers/daemon-isolated-exit-reap-twins.test.ts', // ~15s: the daemon exits with live sessions; one case waits out the 5s SIGINT grace
  'tests/providers/daemon-link-liveness-twins-e2e.test.ts', // ~35s: the daemon, the bridge silence watchdog and the trusted-client keepalive on sub-second clocks
  'tests/providers/daemon-bridge-slow-link-twins-e2e.test.ts', // ~55s: three daemon runtimes, a 1 MB read across a rate-limited bridge link, and a dead link's teardown
  'tests/providers/daemon-bridge-wss-twins-e2e.test.ts', // ~15s: three daemon runtimes dialing wss://localhost with a certificate made by openssl at runtime
  'tests/providers/history-ready-twins-e2e.test.ts', // not measured yet: compiles the daemon binary (two entries) and boots three daemon runtimes
  'tests/web/routes/bug-report.test.ts', // 5s
  'tests/web/routes/task-hook-maintainer.test.ts', // 5s
  'tests/web/routes/chat-plan-mode.test.ts', // 5s
  'tests/web/routes/chat-engine-provider.test.ts', // 9s — boots a server per engine flag
  'tests/web/routes/producers-engine-provider.test.ts', // 17s — boots a server per producer × engine flag
  'tests/web/routes/api-v1-lane-engine.test.ts', // boots a server per test × engine flag (SSE contract)
  'tests/web/routes/chat-task-context.test.ts', // 3.3s
  'tests/web/routes/notes-v2.test.ts', // 2s
  'tests/web/routes/api-v1-notes-extras.test.ts', // real QMD note indexing
  'tests/web/routes/sessions-compare-modes-diverge.test.ts', // 2s
  'tests/web/routes/sessions-git-diff.test.ts', // 2s
  'tests/web/routes/companion-bases-wiring-cloud.test.ts', // 2s: the real startServer in CLOUD_MODE, a copy round over /bridge/replica (WP13)
  'tests/web/human-inbox-routes.test.ts', // boots a real server (route mount + ops parity)
  'tests/web/repo-size-recovery.test.ts', // ~70s: two real server boots, each waiting out one 30s git tick for the size sentinel
  // Boots a real server + a real notes vault and waits on the debounced notes
  // indexer, so it is seconds by construction rather than by accident.
  'tests/integration/tracking-note-ops.test.ts',

  // ── Real timers / pollers / plugin discovery ───────────────────────────────
  'tests/unit/subagent-poller.test.ts', // 15s
  'tests/core/session-hooks-triage-debounce.test.ts', // 9s
  'tests/core/stt-mlx-daemon-health.test.ts', // 11s: fake mlx daemons on real ports, slow-probe timings
  'tests/core/plugin-sources.test.ts', // 3s
  'tests/core/stt-daemon-source-stdin.test.ts', // 3s: spawns fake python daemons on real ports
  // 26k heart-rate buckets into a real SQLite store, then a full materialize drain.
  'tests/core/health/perf.test.ts', // 3.6s
  // Real inspector profiler around a real 1.8s loop block, on the 1s probe cadence.
  'tests/core/stall-recorder-profile.test.ts', // 4s
  // The stall recorder's hold span on real CPU: CPU burns up to 1.2 s, and a
  // running recorder through real 2 to 3 s stops of its loop, three runs each.
  'tests/core/stall-recorder-running.test.ts', // 30-33s
  // A host replica: the real startServer in-process with the replica env (WP1).
  'tests/replica/leader-door.test.ts',
  'tests/replica/env-scrub.test.ts',
  'tests/replica/search-helper-credential.test.ts', // ~25s: the real startServer as a host replica, and a stand-in CLI child
  'tests/replica/route-table-coverage.test.ts', // ~7s: boots the real startServer as a host replica to walk its routes
  'tests/web/api-v1-callers-exist.test.ts', // ~20s: boots the real startServer to walk its routes against every /api/v1 caller
  // The WP4 copies: 5,000 session rows through the real follower route into a real SQLite copy.
  'tests/core/replication/sessions-scale.test.ts',
  // A real `sleep` child whose pid the copied rows name (it must survive every process path).
  'tests/core/sessions/replica-process-guard.test.ts',
  // WP14: logs.tail and the running log cap on the daemon as a process (~30s).
  'tests/integration/replica-logs-twins.test.ts',
  // The companion's build door on a real tree: the host install script with real npm, real smoke boots.
  'tests/core/companion-build-box.test.ts',
  'tests/web/routes/bridge-build.test.ts', // ~3s: one real install through the route
  'tests/web/routes/bridge-build-cloud.test.ts', // ~3s: the real CLOUD_MODE startServer
  // 20k+ croner next-run comparisons against the shared schedule core (croner's own cost).
  'tests/core/cron/schedule-equiv.test.ts', // ~11s
] as const

/**
 * Directories that are heavy END TO END — every file inside starts a server or a
 * browser, so the quick tier skips the whole directory instead of enumerating it.
 * (tests/e2e is 97/103 heavy; tests/commands is 2/2; tests/mcp starts a real
 * server + an in-process MCP client pair, ~13s.)
 */
export const SLOW_TEST_DIRS = ['tests/e2e/**', 'tests/commands/**', 'tests/mcp/**'] as const
