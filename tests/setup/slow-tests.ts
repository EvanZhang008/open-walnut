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
  'tests/providers/session-io.test.ts', // 2.5s (was 9s — dead RemoteIO suites + afterEach sleep)
  'tests/providers/acp-daemon.test.ts', // 7s
  'tests/providers/session-background-workflow.test.ts', // 0.3s (was 5s — afterEach sleep was 90% of it)
  'tests/providers/daemon-transport-unit.test.ts', // 3s
  'tests/providers/remote-session-manager-session-state.test.ts', // 2s
  'tests/integration/agent-gateway.test.ts', // ~10s — real daemon per test + a 2s hub timeout
  'tests/agent/tools/exec-tool.test.ts', // real shell subprocesses + a 1s timeout case
  'tests/core/cloud-setup/cli-exec.test.ts', // real shell/node subprocesses
  'tests/integration/cloud-setup-e2e.test.ts', // real cloud-mode HTTP server + git sync

  // ── Real git subprocesses (repo creation, history rewrite, packing) ─────────
  'tests/integrations/git-compaction.test.ts', // 67s
  // 13-19s per test at idle load: 5 real repos + a bare hub, ~480 real commits,
  // a force-with-lease push, and `git gc --prune=now`. It sat in the quick tier
  // straddling that tier's 15s timeout, so which of its tests failed shifted run
  // to run — a margin, not a logic bug. Measured, not guessed.
  'tests/integrations/git-compaction-remote.test.ts', // 13-19s
  'tests/integrations/git-sync.test.ts', // 11s
  'tests/integrations/git-sync-mass-revert-guard.test.ts', // many real repos and commits
  'tests/core/git-versioning.test.ts', // 5s

  // ── Real HTTP server + session plumbing ────────────────────────────────────
  'tests/scripts/devprod-render-check.test.ts', // ~25s — launches a headless Chromium per verdict
  'tests/web/routes/bug-report.test.ts', // 5s
  'tests/web/routes/task-hook-maintainer.test.ts', // 5s
  'tests/web/routes/chat-plan-mode.test.ts', // 5s
  'tests/web/routes/chat-engine-provider.test.ts', // 9s — boots a server per engine flag
  'tests/web/routes/producers-engine-provider.test.ts', // 17s — boots a server per producer × engine flag
  'tests/web/routes/api-v1-lane-engine.test.ts', // boots a server per test × engine flag (SSE contract)
  'tests/web/routes/chat-background-review.test.ts', // 3s
  'tests/web/routes/chat-task-context.test.ts', // 3.3s
  'tests/web/routes/notes-v2.test.ts', // 2s
  'tests/web/routes/api-v1-notes-extras.test.ts', // real QMD note indexing
  'tests/web/routes/sessions-compare-modes-diverge.test.ts', // 2s
  'tests/web/routes/sessions-git-diff.test.ts', // 2s
  'tests/web/human-inbox-routes.test.ts', // boots a real server (route mount + ops parity)

  // ── Real timers / pollers / plugin discovery ───────────────────────────────
  'tests/unit/subagent-poller.test.ts', // 15s
  'tests/core/session-hooks-triage-debounce.test.ts', // 9s
  'tests/core/plugin-sources.test.ts', // 3s
  'tests/agent/loop-newmessages.test.ts', // 2s
] as const

/**
 * Directories that are heavy END TO END — every file inside starts a server or a
 * browser, so the quick tier skips the whole directory instead of enumerating it.
 * (tests/e2e is 97/103 heavy; tests/commands is 2/2; tests/mcp starts a real
 * server + an in-process MCP client pair, ~13s.)
 */
export const SLOW_TEST_DIRS = ['tests/e2e/**', 'tests/commands/**', 'tests/mcp/**'] as const
