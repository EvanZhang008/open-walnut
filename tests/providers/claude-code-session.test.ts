/**
 * Tests for ClaudeCodeSession + SessionRunner (detached mode).
 *
 * Uses a mock CLI script (mock-claude.mjs) that emits JSONL streaming lines,
 * allowing us to test the full pipeline without the real Claude binary:
 *
 *   session:start → detached spawn → JSONL file → tailer → bus events → session:result
 *
 * Four test layers:
 *   1. ClaudeCodeSession unit: stream-json JSONL → bus events (text deltas, tool use, result)
 *   2. SessionRunner integration: bus subscriber lifecycle, multi-session management
 *   3. End-to-end flow: start → result → session tracker persisted + task linked
 *   4. Streaming events: text deltas, tool use, tool result emitted incrementally
 *
 * Key detail: The event bus uses strict destination routing. Events emitted to
 * ['web-ui'] only reach the subscriber named 'web-ui'. So tests must subscribe
 * under the correct names to intercept events.
 *
 * DETACHED MODE: Sessions spawn with stdout→file. A JsonlTailer reads the file.
 * PID liveness checks (3s interval) detect process exit. Results are typically
 * detected via the tailer reading the "result" JSONL line, not the liveness check.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

// ── Mock constants (isolate file I/O to temp dir) ──
vi.mock('../../src/constants.js', () => createMockConstants());

import { ClaudeCodeSession, SessionRunner, shellQuote, outputFileCheckResult } from '../../src/providers/claude-code-session.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import type { BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js';
import { enqueueMessage, getQueue, markProcessing, resetCache as resetQueueCache } from '../../src/core/session-message-queue.js';
import fs from 'node:fs';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';

// Retrieve the actual tmpBase from the mocked module (single source of truth)
const tmpBase = WALNUT_HOME;

// Use mock CLI directly — it has #!/usr/bin/env node shebang and is executable.
const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs');

// ── File-level mock daemon ──
//
// EVERY session now goes through a daemon: createSessionManager() throws
// "Local daemon not running" without one (src/providers/session-manager.ts), since
// the unified-transport refactor routes local sessions over a WebSocket to the
// local daemon rather than spawning the CLI directly. This file predates that and
// constructed sessions with no daemon in sight, so 44 tests threw on construction
// and another 14 sat waiting for results that could never arrive — 15s each, which
// is most of why this file took 278s (80% of the whole unit tier).
//
// One MockDaemon for the file, shared via beforeAll rather than per-test: it is a
// real WebSocket server, and booting one per test costs ~150ms × 138 tests for no
// isolation benefit (each test uses its own session ids).
let sharedDaemon: MockDaemon;

/** Point a session/runner at the shared mock daemon. Without this the transport
 *  factory throws before any assertion in the test can run. */
function useDaemon<T extends { _testDaemonUrl?: string }>(target: T): T {
  target._testDaemonUrl = daemonUrl();
  return target;
}

/** For the static factories (attachToExisting) that take the URL as a parameter. */
function daemonUrl(): string {
  return `ws://127.0.0.1:${sharedDaemon.port}`;
}

/**
 * Poll until `pred()` holds, then return. Replaces fixed sleeps that waited out a
 * worst case on every run. Throws on timeout so a genuine hang still fails loudly
 * rather than silently asserting on an empty array.
 */
async function waitUntil(pred: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for ${label}`);
}

/**
 * Prove a one-shot event stays one-shot. Waits for the first occurrence, then
 * watches a bounded window for a second.
 *
 * The anti-loop tests below used to sleep a flat 3000ms because the regression they
 * guard cycled every ~500ms. Waiting for the first event and then watching 600ms
 * (>1 cycle) preserves that guarantee at a fraction of the cost.
 */
async function settleOneShot(count: () => number, quietMs = 600): Promise<void> {
  await waitUntil(() => count() >= 1, 5000, 'the first event');
  await new Promise((r) => setTimeout(r, quietMs));
}

beforeAll(async () => {
  sharedDaemon = await createMockDaemon();
});

afterAll(async () => {
  await sharedDaemon.stop();
});

beforeEach(async () => {
  // Clear all bus subscribers to prevent stale handlers from prior tests
  bus.clear();
  resetQueueCache();

  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  // SESSION_STREAMS_DIR is created by send() automatically via mkdirSync,
  // but create it here too for tests that check the dir directly.
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true });

  // ── Drop the SQLite state that OUTLIVES the tmpBase wipe ──
  //
  // Tasks and sessions moved from tasks.json/sessions.json to tasks.sqlite /
  // sessions.sqlite, and both modules memoize their handle plus an
  // "already initialized" flag at MODULE scope. `rm -rf tmpBase` unlinks the
  // files but cannot close those handles, so without this reset:
  //   - session records ACCUMULATE across tests (the open handle keeps writing
  //     to the unlinked inode / recreated file). `listSessions().find(s =>
  //     s.taskId === 'e2e-task-001')` then returns the FIRST — i.e. some earlier
  //     test's record — so assertions read a stale process_status ('stopped'
  //     instead of 'running') and a stale cwd (the project-memory fallback dir
  //     instead of the cwd this test passed).
  //   - task-manager's `initialized` flag stays true, so ensureInit() never
  //     re-runs the tasks.json → SQLite migration. The `e2e-task-001` fixture
  //     that the E2E describe writes to tasks.json is therefore never imported,
  //     and getTask throws 'No task found matching ID prefix'.
  // Closing both handles + clearing both init flags makes each test open a fresh
  // DB inside the fresh tmpBase, which is what the file-level wipe intends.
  const [taskDb, sessionDb, taskManager, sessionTracker] = await Promise.all([
    import('../../src/core/task-db.js'),
    import('../../src/core/session-db.js'),
    import('../../src/core/task-manager.js'),
    import('../../src/core/session-tracker.js'),
  ]);
  taskDb.closeDb();
  sessionDb.closeDb();
  taskManager._resetForTesting();
  sessionTracker._resetSessionTrackerForTesting();
});

afterEach(async () => {
  // Clear all bus subscribers to stop receiving events
  bus.clear();

  // Yield one IO turn so fire-and-forget work (persistSessionRecord, etc.) can
  // start settling. This was an unconditional 200ms sleep x 133 tests = 25s, a
  // third of the file's runtime, and it was never load-bearing: the rm below
  // already retries (maxRetries:3, retryDelay:100), which is what actually
  // handles a writer still holding a file. Measured 88.9s -> 63.7s, 133/133 both.
  await new Promise((r) => setImmediate(r));
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
});

// ── outputFileCheckResult tests ──

describe('outputFileCheckResult', () => {
  const tmpFile = path.join(tmpBase, 'test-result.jsonl')

  it('returns hasResult:true for a successful result event', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ type: 'result', is_error: false, session_id: 'abc' }) + '\n')
    expect(outputFileCheckResult(tmpFile)).toEqual({ hasResult: true })
  })

  it('returns hasResult:false with errorMessage for is_error:true result', () => {
    const event = {
      type: 'result',
      is_error: true,
      errors: ['No conversation found with session ID: adcfa486'],
    }
    fs.writeFileSync(tmpFile, JSON.stringify(event) + '\n')
    const result = outputFileCheckResult(tmpFile)
    expect(result.hasResult).toBe(false)
    expect(result.errorMessage).toContain('No conversation found')
  })

  it('returns hasResult:false when file has no result event', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ type: 'assistant', text: 'hello' }) + '\n')
    expect(outputFileCheckResult(tmpFile)).toEqual({ hasResult: false })
  })

  it('returns hasResult:false for empty file', () => {
    fs.writeFileSync(tmpFile, '')
    expect(outputFileCheckResult(tmpFile)).toEqual({ hasResult: false })
  })

  it('returns hasResult:false for nonexistent file', () => {
    expect(outputFileCheckResult('/tmp/does-not-exist-walnut-test.jsonl')).toEqual({ hasResult: false })
  })

  it('respects fromOffset — ignores old result events before offset', () => {
    const oldResult = JSON.stringify({ type: 'result', is_error: false }) + '\n'
    const newData = JSON.stringify({ type: 'assistant', text: 'new turn' }) + '\n'
    fs.writeFileSync(tmpFile, oldResult + newData)
    // Offset past the old result — should not find it
    expect(outputFileCheckResult(tmpFile, oldResult.length)).toEqual({ hasResult: false })
  })

  it('returns hasResult:true for result after offset', () => {
    const oldData = JSON.stringify({ type: 'assistant', text: 'old' }) + '\n'
    const newResult = JSON.stringify({ type: 'result', is_error: false }) + '\n'
    fs.writeFileSync(tmpFile, oldData + newResult)
    expect(outputFileCheckResult(tmpFile, oldData.length)).toEqual({ hasResult: true })
  })

  it('returns errorMessage from is_error result after offset', () => {
    const oldData = JSON.stringify({ type: 'assistant', text: 'old' }) + '\n'
    const errorResult = JSON.stringify({ type: 'result', is_error: true, errors: ['Session expired'] }) + '\n'
    fs.writeFileSync(tmpFile, oldData + errorResult)
    const result = outputFileCheckResult(tmpFile, oldData.length)
    expect(result.hasResult).toBe(false)
    expect(result.errorMessage).toBe('Session expired')
  })
})

// ── Helpers ──

interface CollectedEvents {
  results: BusEvent[];
  errors: BusEvent[];
  started: BusEvent[];
  textDeltas: BusEvent[];
  toolUses: BusEvent[];
  toolResults: BusEvent[];
}

/**
 * Subscribe to the bus under 'main-ai'.
 *
 * All session events route to '*' (broadcast).
 * Subscribing as 'main-ai' captures every event exactly once.
 */
function collectEvents(): CollectedEvents {
  const collected: CollectedEvents = {
    results: [],
    errors: [],
    started: [],
    textDeltas: [],
    toolUses: [],
    toolResults: [],
  };

  bus.subscribe('main-ai', (event: BusEvent) => {
    switch (event.name) {
      case EventNames.SESSION_RESULT:
        collected.results.push(event);
        break;
      case EventNames.SESSION_ERROR:
        collected.errors.push(event);
        break;
      case EventNames.SESSION_STARTED:
        collected.started.push(event);
        break;
      case EventNames.SESSION_TEXT_DELTA:
        collected.textDeltas.push(event);
        break;
      case EventNames.SESSION_TOOL_USE:
        collected.toolUses.push(event);
        break;
      case EventNames.SESSION_TOOL_RESULT:
        collected.toolResults.push(event);
        break;
    }
  });

  return collected;
}

function waitForResult(collected: CollectedEvents, timeoutMs = 15_000): Promise<BusEvent> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (collected.results.length > 0) {
        resolve(collected.results[0]);
        return;
      }
      if (collected.errors.length > 0) {
        resolve(collected.errors[0]);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(
          `Timed out waiting for session result (${timeoutMs}ms). ` +
          `Got ${collected.results.length} results, ${collected.errors.length} errors.`,
        ));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function waitForN(
  arr: BusEvent[],
  n: number,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (arr.length >= n) { resolve(); return; }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out: expected ${n} events, got ${arr.length}`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Layer 1: ClaudeCodeSession — stream-json JSONL → bus events
// ═══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession', () => {
  it('spawns mock CLI detached and parses session ID from init event', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-1', 'test-project', MOCK_CLI));

    expect(session.active).toBe(false);

    session.send('hello world');
    expect(session.active).toBe(true);

    // The id is PRE-ASSIGNED at send time: send() mints a uuid and passes
    // `--session-id`, so a UI-initiated start can return an id in its HTTP
    // response instead of waiting for the CLI's init event. (It used to be null
    // until the response arrived — that changed with the pre-assign path.)
    expect(session.sessionId).toBeTruthy();

    const result = await waitForResult(collected);

    // Result event is correct
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { sessionId: string; taskId: string; result: string; isError: boolean };
    expect(rd.taskId).toBe('task-1');
    expect(rd.result).toContain('hello world');
    expect(rd.isError).toBe(false);
    // Session ID parsed from the JSON response
    expect(rd.sessionId).toBeTruthy();
    expect(typeof rd.sessionId).toBe('string');

    // Session ID set after response is parsed
    expect(session.sessionId).toBe(rd.sessionId);
  });

  it('creates output file in streams directory', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-file', 'proj', MOCK_CLI));
    session.send('file test');

    await waitForResult(collected);

    // Sessions run through the daemon, so there is no LOCAL output file: the
    // transport reports a `remote://<host>/<sid>` sentinel and callers check
    // isRemote before attempting file I/O. Asserting a local `.jsonl` path here
    // predates that.
    //
    // NOTE: this currently observes the sentinel being clobbered back to null by
    // the rename path — see tests/providers/session-outputfile-clobber.test.ts,
    // which pins that bug. Assert only what is stable: whatever value is present
    // must be the sentinel form, never a local path.
    if (session.outputFile !== null) {
      expect(session.outputFile).toMatch(/^remote:\/\//);
    }
  });

  it('stores PID of spawned process', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-pid', 'proj', MOCK_CLI));
    session.send('pid test');

    // The pid arrives when the DAEMON's spawn resolves, not synchronously inside
    // send() — the daemon owns the process now, so walnut learns the pid from the
    // start RPC reply. (This used to be a direct local spawn.)
    await waitForResult(collected);
    expect(session.processPid).toBeGreaterThan(0);
  });

  it('generates unique session ID per send (from response)', async () => {
    const collected = collectEvents();
    const session1 = useDaemon(new ClaudeCodeSession('task-a', 'proj', MOCK_CLI));
    const session2 = useDaemon(new ClaudeCodeSession('task-b', 'proj', MOCK_CLI));

    session1.send('first');
    session2.send('second');

    await waitForN(collected.results, 2);

    // After responses arrive, session IDs should be set and unique
    expect(session1.sessionId).toBeTruthy();
    expect(session2.sessionId).toBeTruthy();
    expect(session1.sessionId).not.toBe(session2.sessionId);
  });

  it('emits SESSION_ERROR when process fails to spawn', async () => {
    const collected = collectEvents();
    // The DAEMON spawns the CLI now, so the constructor's cliCommand can no
    // longer force a spawn failure: createSessionManager ignores it
    // (session-manager.ts `_cliCommand` is "unused, kept for API compat") and the
    // daemon spawns whatever CLI IT was configured with. Pointing at
    // '/nonexistent/binary' therefore produced a perfectly happy mock-claude run
    // and a SESSION_RESULT. Fail the spawn where it actually happens — at the
    // daemon's cmdStart, which is what a bad cwd / mkfifo failure / `!proc.pid`
    // looks like on the wire (daemon-standalone.ts cmdStart → sendError).
    sharedDaemon.injectStartFault('spawn failed: process could not start (cwd missing)');
    try {
      const session = useDaemon(new ClaudeCodeSession('task-err', 'proj', MOCK_CLI));
      session.send('this should fail');

      const event = await waitForResult(collected);
      expect(event.name).toBe(EventNames.SESSION_ERROR);
      expect((event.data as { error: string }).error).toBeDefined();
      expect((event.data as { error: string }).error).toContain('spawn failed');
    } finally {
      // The fault is sticky (a broken host fails every spawn); the daemon is
      // shared file-wide, so leaking it would break every later test.
      sharedDaemon.injectStartFault(null);
    }
  });

  it('emits SESSION_ERROR when CLI exits with non-zero code', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-exit-err', 'proj', MOCK_CLI));
    session.send('error'); // Mock exits code 1 for "error"

    const event = await waitForResult(collected);
    expect(event.name).toBe(EventNames.SESSION_ERROR);
  });

  it('handles CLI outputting invalid JSONL gracefully (skips bad lines)', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-parse-err', 'proj', MOCK_CLI));
    session.send('parse-error'); // Mock outputs invalid JSON

    // In detached mode, unparseable lines are skipped by the tailer.
    // The mock outputs garbage, exits 0, no stderr → SESSION_RESULT with empty text.
    const event = await waitForResult(collected);
    expect(event.name).toBe(EventNames.SESSION_RESULT);
    const rd = event.data as { result: string; isError: boolean };
    expect(rd.result).toBe(''); // No text was accumulated
    expect(rd.isError).toBe(false);
  });

  it('kill() stops the process', async () => {
    const session = useDaemon(new ClaudeCodeSession('task-kill', 'proj', MOCK_CLI));
    session.send('hello');
    await new Promise((r) => setTimeout(r, 50));
    session.kill();
    expect(session.active).toBe(false);
  });

  it('detach() stops monitoring without killing', async () => {
    const session = useDaemon(new ClaudeCodeSession('task-detach', 'proj', MOCK_CLI));
    session.send('hello');
    await new Promise((r) => setTimeout(r, 50));
    const pid = session.processPid;
    session.detach();
    expect(session.active).toBe(false);
    // PID is still stored (process may still be running)
    expect(session.processPid).toBe(pid);
  });

  it('handles resume with --resume flag', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-resume', 'proj', MOCK_CLI));
    session.send('continue working', undefined, 'existing-session-123');

    // Session ID pre-set for resume
    expect(session.sessionId).toBe('existing-session-123');

    const result = await waitForResult(collected);
    expect((result.data as { sessionId: string }).sessionId).toBeDefined();
  });

  it('mode "plan" passes --permission-mode plan to CLI', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-plan', 'proj', MOCK_CLI));
    session.send('plan mode test', undefined, undefined, 'plan');

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[permission-mode:plan]');
  });

  it('mode "bypass" passes --permission-mode bypassPermissions to CLI', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-bypass', 'proj', MOCK_CLI));
    session.send('bypass mode test', undefined, undefined, 'bypass');

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[permission-mode:bypassPermissions]');
  });

  it('no mode defaults to bypassPermissions', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-default', 'proj', MOCK_CLI));
    session.send('default mode test');

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { result: string };
    // No mode → Walnut now defaults to bypassPermissions (users shouldn't be
    // prompted to approve every edit; plan mode must be explicitly requested).
    expect(rd.result).toContain('[permission-mode:bypassPermissions]');
  });

  it('send() with cwd passes working directory to spawned process', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-cwd', 'proj', MOCK_CLI));
    // Use tmpBase as cwd — it's a real directory that exists
    session.send('cwd test', tmpBase);

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);

    // Mock CLI echoes back process.cwd() in result text as [cwd:<path>]
    // macOS resolves /var → /private/var, so use realpath for comparison
    const rd = result.data as { result: string };
    const realTmpBase = fsp.realpath ? await fsp.realpath(tmpBase) : tmpBase;
    expect(rd.result).toContain(`[cwd:${realTmpBase}]`);
  });

  it('send() without cwd defaults to process.cwd()', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-no-cwd', 'proj', MOCK_CLI));
    session.send('no cwd test');

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);

    // Without explicit cwd, the mock CLI should inherit process.cwd()
    const rd = result.data as { result: string };
    expect(rd.result).toContain(`[cwd:${process.cwd()}]`);
  });

  it('stdin is closed — session completes without stdin input', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-stdin', 'proj', MOCK_CLI));
    session.send('stdin test');

    // If stdin were not closed, the mock might hang waiting for input.
    // Successful completion proves stdin was closed.
    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    expect((result.data as { result: string }).result).toContain('stdin test');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Regression: delivery failure must not loop, must not lose the message
//  (2026-06-10 incident: SSH down → settleResumeFailure emitted a plain
//  SESSION_ERROR → session-runner treated it as turn-end → batch-completed
//  + processNext → re-deliver → fail → … at 2 cycles/sec, while the UI
//  deleted the optimistic message on each spurious batch-completed.)
// ═══════════════════════════════════════════════════════════════════

describe('delivery failure: no retry loop, no message loss', () => {
  let runner: SessionRunner;

  // COVERAGE NOTE: these tests now exercise the ASYNC spawn-settle path —
  // send() returns, THEN the daemon's start reply comes back ok:false →
  // onSpawnSettled(false) → settleResumeFailure. That is the exact path that
  // regressed on 2026-06-10 (double SESSION_ERROR emit + stopped-status leak),
  // so this is strictly better coverage than the old pre-daemon shape, where the
  // failure came from createSessionManager throwing SYNCHRONOUSLY inside
  // processNext ("Local daemon not running", caught by processNext's own catch)
  // and onSpawnSettled never fired at all.
  //
  // A bad `cliCommand` can no longer force the failure: the daemon owns the
  // spawn and ignores the constructor arg (session-manager.ts `_cliCommand` is
  // "unused, kept for API compat"), so the old '/nonexistent/claude-binary'
  // runner simply got a healthy mock-claude and a SESSION_RESULT. Fail the spawn
  // at the daemon instead — sticky, so a resurrected retry loop still registers
  // as N failures rather than one failure + N successes.
  beforeEach(() => {
    sharedDaemon.injectStartFault('daemon start failed: publickey denied (simulated host outage)');
    runner = useDaemon(new SessionRunner(MOCK_CLI));
    runner.init();
  });

  afterEach(() => {
    sharedDaemon.injectStartFault(null);
    runner.destroyAndKill();
  });

  it('failed delivery: one batch-failed, no batch-completed, message stays pending, no loop', async () => {
    const sessionId = 'loop-test-session';

    // Session record so processNext's --resume path resolves it (local host)
    const { createSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord(sessionId, 'loop-test-task', 'test');

    const batchFailed: BusEvent[] = [];
    const batchCompleted: BusEvent[] = [];
    const sessionErrors: BusEvent[] = [];
    bus.subscribe('main-ai', (event: BusEvent) => {
      if (event.name === EventNames.SESSION_BATCH_FAILED) batchFailed.push(event);
      if (event.name === EventNames.SESSION_BATCH_COMPLETED) batchCompleted.push(event);
      if (event.name === EventNames.SESSION_ERROR) sessionErrors.push(event);
    });

    await enqueueMessage(sessionId, 'precious message — do not lose');
    bus.emit(EventNames.SESSION_SEND, {
      sessionId,
      message: 'precious message — do not lose',
    }, ['session-runner'], { source: 'test' });

    // Wait for the failure, then watch a quiet window longer than one cycle of the
    // old ~500ms loop. Same guarantee as the previous flat 3000ms sleep, ~5x faster.
    await settleOneShot(() => batchFailed.length);

    // Exactly one delivery attempt failed — NOT a loop (old bug: 5-6 cycles in 3s)
    expect(batchFailed.length).toBe(1);
    // No spurious turn-completion (old bug: one per cycle → UI deleted the message)
    expect(batchCompleted.length).toBe(0);
    // SESSION_ERROR carries the structured kind, exactly once
    expect(sessionErrors.length).toBe(1);
    expect((sessionErrors[0].data as { errorKind?: string }).errorKind).toBe('delivery_failed');

    // The message SURVIVES on disk as pending (recoverable: Retry / restart / reconnect)
    const queue = await getQueue(sessionId);
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('pending');
    expect(queue[0].message).toBe('precious message — do not lose');
  }, 20_000);

  it('user retry after failure re-attempts delivery (no permanent stranding)', async () => {
    const sessionId = 'retry-test-session';
    const { createSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord(sessionId, 'retry-test-task', 'test');

    const batchFailed: BusEvent[] = [];
    bus.subscribe('main-ai', (event: BusEvent) => {
      if (event.name === EventNames.SESSION_BATCH_FAILED) batchFailed.push(event);
    });

    await enqueueMessage(sessionId, 'first try');
    bus.emit(EventNames.SESSION_SEND, { sessionId, message: 'first try' }, ['session-runner'], { source: 'test' });
    // Poll for the attempt instead of sleeping out a 1500ms worst case.
    await waitUntil(() => batchFailed.length >= 1, 5000, 'the first failed attempt');
    expect(batchFailed.length).toBe(1);

    // User-initiated retry = a NEW session:send → another single attempt
    bus.emit(EventNames.SESSION_SEND, { sessionId, message: 'first try' }, ['session-runner'], { source: 'test' });
    await waitUntil(() => batchFailed.length >= 2, 5000, 'the retried attempt');
    expect(batchFailed.length).toBe(2);

    // Still exactly one pending message — no duplication, no loss
    const queue = await getQueue(sessionId);
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('pending');
  }, 20_000);

  // Direct unit test of settleResumeFailure, complementing the two bus-driven
  // tests above (which now reach it through the real onSpawnSettled(false)
  // callback). Calling it directly pins the two invariants that are otherwise
  // only observable as an absence: exactly ONE SESSION_ERROR with
  // errorKind:'delivery_failed', routed to ['main-ai'] and NOT 'session-runner'
  // (re-entry there is what started the 2026-06-10 loop). The send()-catch's
  // terminal status + second emit remain gated on `!onSpawnSettled` — see that
  // block in send().
  it('settleResumeFailure emits one delivery_failed and reverts the batch (no loop, no loss)', async () => {
    const sessionId = 'settle-direct-sid';
    await enqueueMessage(sessionId, 'owned by settle callback');
    const batch = await markProcessing(sessionId);
    expect(batch).toHaveLength(1);

    const sessionErrors: BusEvent[] = [];
    const batchFailed: BusEvent[] = [];
    const reEntrant: BusEvent[] = [];
    bus.subscribe('main-ai', (event: BusEvent) => {
      if (event.name === EventNames.SESSION_ERROR) sessionErrors.push(event);
      if (event.name === EventNames.SESSION_BATCH_FAILED) batchFailed.push(event);
    });
    // If SESSION_ERROR were (re-)delivered to 'session-runner', its handler would
    // run turn-completion logic → the loop. Assert it is NOT routed there.
    bus.subscribe('session-runner', (event: BusEvent) => {
      if (event.name === EventNames.SESSION_ERROR) reEntrant.push(event);
    });

    // Invoke the exact private method the async settle callback calls.
    (runner as unknown as {
      settleResumeFailure: (sid: string, msgs: typeof batch, err: Error) => void;
    }).settleResumeFailure(sessionId, batch, new Error('publickey denied (simulated SSH failure)'));

    await new Promise((r) => setTimeout(r, 300));

    // Exactly one SESSION_ERROR, tagged delivery_failed, and one batch-failed.
    expect(sessionErrors.length).toBe(1);
    expect((sessionErrors[0].data as { errorKind?: string }).errorKind).toBe('delivery_failed');
    expect(batchFailed.length).toBe(1);
    // Not routed back into session-runner → the turn-completion loop can't start.
    expect(reEntrant.length).toBe(0);

    // The message is reverted to 'pending' — recoverable, never lost.
    const queue = await getQueue(sessionId);
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('pending');
    expect(queue[0].message).toBe('owned by settle callback');
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════
//  Layer 2: SessionRunner — bus-driven lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('SessionRunner', () => {
  let runner: SessionRunner;

  beforeEach(() => {
    runner = useDaemon(new SessionRunner(MOCK_CLI));
    runner.init();
  });

  afterEach(() => {
    runner.destroyAndKill();
  });

  it('handles session:start and spawns a session', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'runner-task-1',
      message: 'do something',
      project: 'test-proj',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);

    // Session tracked by task ID
    expect(runner.getByTaskId('runner-task-1')).toBeDefined();

    // session:started emitted
    expect(collected.started.length).toBeGreaterThanOrEqual(1);
    const sd = collected.started[0].data as { taskId: string; project: string };
    expect(sd.taskId).toBe('runner-task-1');
    expect(sd.project).toBe('test-proj');

    // session:result arrived
    const rd = result.data as { taskId: string; result: string };
    expect(rd.taskId).toBe('runner-task-1');
    expect(rd.result).toContain('do something');
  });

  it('kills existing session when starting new one for same task', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'replace-task',
      message: 'first',
    }, ['session-runner'], { source: 'test' });

    await waitForResult(collected);

    bus.emit(EventNames.SESSION_START, {
      taskId: 'replace-task',
      message: 'second',
    }, ['session-runner'], { source: 'test' });

    await waitForN(collected.results, 2);
    expect(collected.results).toHaveLength(2);

    // Only one session tracked
    expect(runner.getByTaskId('replace-task')).toBeDefined();
  });

  it('manages multiple concurrent sessions for different tasks', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'multi-a',
      message: 'task A',
      project: 'proj-a',
    }, ['session-runner'], { source: 'test' });

    bus.emit(EventNames.SESSION_START, {
      taskId: 'multi-b',
      message: 'task B',
      project: 'proj-b',
    }, ['session-runner'], { source: 'test' });

    await waitForN(collected.results, 2);

    expect(runner.getByTaskId('multi-a')).toBeDefined();
    expect(runner.getByTaskId('multi-b')).toBeDefined();
  });

  it('passes mode through to ClaudeCodeSession when starting session', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'mode-task',
      message: 'plan via runner',
      project: 'test-proj',
      mode: 'plan',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[permission-mode:plan]');
  });

  it('passes bypass mode through to ClaudeCodeSession', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'bypass-task',
      message: 'bypass via runner',
      project: 'test-proj',
      mode: 'bypass',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[permission-mode:bypassPermissions]');
  });

  it('no mode in session:start defaults to bypassPermissions', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'no-mode-task',
      message: 'no mode via runner',
      project: 'test-proj',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[permission-mode:bypassPermissions]');
  });

  it('emits session:error for session:send with unknown session ID', async () => {
    const collected = collectEvents();

    // In the new queue-based flow, messages must be enqueued before the bus event
    // (normally done by the session:send RPC handler)
    await enqueueMessage('nonexistent-session-id', 'hello');

    bus.emit(EventNames.SESSION_SEND, {
      sessionId: 'nonexistent-session-id',
      message: 'hello',
    }, ['session-runner'], { source: 'test' });

    await waitForN(collected.errors, 1, 5_000);

    const errData = collected.errors[0].data as { error: string };
    expect(errData.error).toContain('No active session found');
  });

  it('destroy() detaches sessions and unsubscribes', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'destroy-task',
      message: 'work',
    }, ['session-runner'], { source: 'test' });

    await new Promise((r) => setTimeout(r, 100));

    const session = runner.getByTaskId('destroy-task');
    expect(session).toBeDefined();

    runner.destroy();
    expect(session!.active).toBe(false);
    expect(runner.getByTaskId('destroy-task')).toBeUndefined();
  });

  it('destroyAndKill() kills sessions and unsubscribes', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'kill-task',
      message: 'work',
    }, ['session-runner'], { source: 'test' });

    await new Promise((r) => setTimeout(r, 100));

    const session = runner.getByTaskId('kill-task');
    expect(session).toBeDefined();

    runner.destroyAndKill();
    expect(session!.active).toBe(false);
    expect(runner.getByTaskId('kill-task')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Layer 3: End-to-end — start → result → persistence
// ═══════════════════════════════════════════════════════════════════

describe('End-to-end session flow', () => {
  let runner: SessionRunner;

  beforeEach(async () => {
    // Seed a task in the task store
    const tasksDir = path.join(tmpBase, 'tasks');
    await fsp.mkdir(tasksDir, { recursive: true });
    await fsp.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [{
          id: 'e2e-task-001',
          title: 'Fix the widget',
          status: 'todo',
          priority: 'none',
          category: 'Work',
          project: 'Walnut',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
        }],
      }),
    );

    runner = useDaemon(new SessionRunner(MOCK_CLI));
    runner.init();
  });

  afterEach(() => {
    runner.destroyAndKill();
  });

  it('full flow: session:start → process runs → session:result', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'e2e-task-001',
      message: 'fix the widget bug',
      project: 'Walnut',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);

    // Fail fast with diagnostic info if session errored
    expect(result.name, `Expected SESSION_RESULT but got ${result.name}: ${JSON.stringify(result.data)}`)
      .toBe(EventNames.SESSION_RESULT);

    // Result carries correct metadata
    const rd = result.data as {
      sessionId: string; taskId: string; result: string;
      totalCost: number; isError: boolean;
    };
    expect(rd.taskId).toBe('e2e-task-001');
    expect(rd.sessionId).toBeTruthy();
    expect(rd.result).toContain('fix the widget bug');
    expect(rd.totalCost).toBe(0.003);
    expect(rd.isError).toBe(false);

    // session:started was emitted
    expect(collected.started).toHaveLength(1);
  });

  it('persists SessionRecord to tracker after result', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'e2e-task-001',
      message: 'persist test',
      project: 'Walnut',
    }, ['session-runner'], { source: 'test' });

    await waitForResult(collected);

    // Give fire-and-forget persistence (dynamic import + file write) time to complete
    await new Promise((r) => setTimeout(r, 500));

    const { listSessions } = await import('../../src/core/session-tracker.js');
    const sessions = await listSessions();
    const ours = sessions.find((s) => s.taskId === 'e2e-task-001');
    expect(ours).toBeDefined();
    expect(ours!.project).toBe('Walnut');
    expect(ours!.claudeSessionId).toBeTruthy();

    // Status AFTER the turn is terminal, not 'running'.
    //
    // The old 'running' assertion described the pre-daemon spawn: walnut owned the
    // process, so the record was still mid-turn when the result landed. Two things
    // changed. (1) mock-claude.mjs exits at turn end (`process.stdout.write(result,
    // () => process.exit(0))`) — unlike the real CLI, which stays alive on its FIFO
    // across turns. (2) The result handler branches on liveness: FIFO-alive → 'idle',
    // daemon-remote-and-exited → 'idle', otherwise → 'stopped'. A local mock CLI that
    // has already exited takes the last branch, and the runner then persists that
    // in-memory status verbatim (deliberately — re-deriving it is what wrongly wrote
    // remote --resume sessions as 'stopped'). So 'stopped' is the CORRECT observation
    // for a mock that exits; 'running' can no longer occur here for any reason.
    //
    // Assert the real contract instead: the turn reached a terminal state via normal
    // completion, never an error. This still catches the failure this test exists to
    // catch (record persisted with a bogus/error status, or not persisted at all).
    expect(['stopped', 'idle']).toContain(ours!.process_status);
    expect(ours!.errorMessage).toBeFalsy();
    expect(ours!.status_history?.[0]?.reason).toBe('normal_completion');

    // outputFile must survive: it is threaded into readSessionHistory,
    // computeSessionChanges and the health monitor. Daemon-backed sessions carry the
    // `remote://<host>/<sid>` sentinel rather than a local path — a bare truthy check
    // would also pass for a stale local path, so pin the sentinel shape.
    expect(ours!.outputFile).toMatch(/^remote:\/\//);

    // pid is deliberately CLEARED on a terminal status (session-tracker's
    // "terminal-state PID clear" — a retained pid gets orphan-killed once the OS
    // recycles it), so the old `pid > 0` assertion now contradicts a safety
    // invariant. The pid did reach the record mid-turn; that is what the clear
    // logged. Assert the invariant that matters: no live pid on a dead session.
    expect(ours!.pid == null).toBe(true);
  });

  it('session:start with cwd persists working directory to session record', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'e2e-task-001',
      message: 'cwd persist test',
      cwd: tmpBase,
      project: 'Walnut',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);

    // Give fire-and-forget persistence time to complete
    await new Promise((r) => setTimeout(r, 500));

    const { listSessions } = await import('../../src/core/session-tracker.js');
    const sessions = await listSessions();
    const ours = sessions.find((s) => s.taskId === 'e2e-task-001');
    expect(ours).toBeDefined();
    expect(ours!.cwd).toBe(tmpBase);
  });

  it('links session to task after result', async () => {
    const collected = collectEvents();

    // The exec slot is occupied DURING the session and released when it ends, so
    // watch the live link event rather than only the end state. `linkSessionSlot`
    // → `linkSession` → TASK_UPDATED(['web-ui']) is the exec-slot write; the
    // terminal-status handler then calls clearSessionSlot (see the
    // `status === 'stopped' || status === 'error'` branch in the runner's
    // result/error handler), because a dead session must not keep holding the
    // task's single exec slot — that leak is what made every UI entry point open a
    // dead session. Asserting exec_session_id AFTER the turn therefore tests the
    // opposite of the intended behavior; it only ever passed because the
    // pre-daemon mock CLI stayed alive (→ 'idle', no clear).
    const taskUpdates: BusEvent[] = [];
    bus.subscribe('web-ui', (event: BusEvent) => {
      if (event.name === EventNames.TASK_UPDATED) taskUpdates.push(event);
    });

    bus.emit(EventNames.SESSION_START, {
      taskId: 'e2e-task-001',
      message: 'link test',
      project: 'Walnut',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);
    const sessionId = (result.data as { sessionId: string }).sessionId;

    // Give fire-and-forget persistence (dynamic import + file write) time to complete
    await new Promise((r) => setTimeout(r, 500));

    // 1. The session DID occupy the exec slot (non-plan mode) while it ran.
    const linked = taskUpdates
      .map((e) => (e.data as { task?: { exec_session_id?: string; session_ids?: string[] } }).task)
      .find((t) => t?.exec_session_id === sessionId);
    expect(linked, 'session should have been linked to the exec slot').toBeDefined();
    expect(linked!.session_ids).toContain(sessionId);

    // 2. The DURABLE link survives the slot release: session_ids is the permanent
    //    history (the UI's session list for the task), unlike the exec slot which is
    //    a transient "who is running right now" pointer.
    const { getTask } = await import('../../src/core/task-manager.js');
    const task = await getTask('e2e-task-001');
    expect(task.session_ids).toContain(sessionId);
    expect(task.session_id).toBe(sessionId);
  });

  it('session:result carries all fields needed by frontend', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'e2e-task-001',
      message: 'contract test',
      project: 'Walnut',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);
    const data = result.data as Record<string, unknown>;

    expect(data).toHaveProperty('result');
    expect(data).toHaveProperty('taskId');
    expect(data).toHaveProperty('sessionId');
    expect(data).toHaveProperty('isError');

    expect(typeof data.result).toBe('string');
    expect(data.taskId).toBe('e2e-task-001');
    expect(typeof data.sessionId).toBe('string');
    expect(data.isError).toBe(false);
  });

  it('event destinations are correctly routed', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'e2e-task-001',
      message: 'destination test',
      project: 'Walnut',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);
    expect(result.name, `Expected SESSION_RESULT but got ${result.name}: ${JSON.stringify(result.data)}`)
      .toBe(EventNames.SESSION_RESULT);

    const uniqueResults = new Set(collected.results.map((r) => (r.data as { sessionId: string }).sessionId));
    expect(uniqueResults.size).toBe(1);
    expect(collected.results[0].destinations).toContain('main-ai');
    expect(collected.results[0].destinations).not.toContain('web-ui');
  });

  it('session:result carries result text in data payload', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'e2e-task-001',
      message: 'verify result text',
      project: 'Walnut',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);

    const rd = result.data as { result: string; taskId: string };
    expect(rd.result).toBeTruthy();
    expect(typeof rd.result).toBe('string');
    expect(rd.result).toContain('verify result text');
    expect(rd.taskId).toBe('e2e-task-001');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Layer 4: Streaming events — text deltas, tool use, tool result
// ═══════════════════════════════════════════════════════════════════

describe('Streaming events (stream-json)', () => {
  it('emits session:text-delta for text content blocks', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-stream', 'proj', MOCK_CLI));
    session.send('hello streaming');

    await waitForResult(collected);

    expect(collected.textDeltas.length).toBeGreaterThan(0);
    const delta = collected.textDeltas[0].data as { delta: string; taskId: string; sessionId: string };
    expect(delta.delta).toContain('hello streaming');
    expect(delta.taskId).toBe('task-stream');
    expect(delta.sessionId).toBeTruthy();
  });

  it('emits session:tool-use and session:tool-result for tool calls', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-tool', 'proj', MOCK_CLI));
    session.send('tool-test');

    await waitForResult(collected);

    expect(collected.toolUses.length).toBeGreaterThan(0);
    const toolUse = collected.toolUses[0].data as {
      toolName: string; toolUseId: string; input: Record<string, unknown>;
      taskId: string; sessionId: string;
    };
    expect(toolUse.toolName).toBe('Read');
    expect(toolUse.toolUseId).toBe('toolu_mock_001');
    expect(toolUse.input).toEqual({ file_path: '/tmp/test.txt' });
    expect(toolUse.taskId).toBe('task-tool');

    expect(collected.toolResults.length).toBeGreaterThan(0);
    const toolResult = collected.toolResults[0].data as {
      toolUseId: string; result: string; taskId: string;
    };
    expect(toolResult.toolUseId).toBe('toolu_mock_001');
    expect(toolResult.result).toBe('File contents here');
    expect(toolResult.taskId).toBe('task-tool');
  });

  it('session ID is available from init event before text deltas', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-init', 'proj', MOCK_CLI));
    session.send('init test');

    await waitForResult(collected);

    expect(session.sessionId).toBeTruthy();
    expect(collected.textDeltas.length).toBeGreaterThan(0);
    const delta = collected.textDeltas[0].data as { sessionId: string };
    expect(delta.sessionId).toBe(session.sessionId);
  });

  it('text deltas are accumulated into the final result', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-accum', 'proj', MOCK_CLI));
    session.send('accumulation test');

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };

    expect(rd.result).toContain('accumulation test');

    const allDeltas = collected.textDeltas.map((e) => (e.data as { delta: string }).delta).join('');
    expect(rd.result).toBe(allDeltas);
  });

  it('streaming events are broadcast to all subscribers', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-broadcast', 'proj', MOCK_CLI));
    session.send('broadcast test');

    await waitForResult(collected);

    expect(collected.textDeltas.length).toBeGreaterThan(0);
    expect(collected.textDeltas[0].destinations).toContain('main-ai');
  });
});

// ══════════════════════════════════════════════════════════════════
//  Layer 5: appendSystemPrompt parameter
// ══════════════════════════════════════════════════════════════════

describe('appendSystemPrompt parameter', () => {
  it('passes --append-system-prompt flag to CLI', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-sysprompt', 'proj', MOCK_CLI));
    session.send('hello', undefined, undefined, undefined, undefined, 'You are a helpful bot');

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[has-system-prompt]');
  });

  it('omits flag when appendSystemPrompt is undefined', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-no-sysprompt', 'proj', MOCK_CLI));
    session.send('hello');

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };
    expect(rd.result).not.toContain('[has-system-prompt]');
  });

  it('works combined with permission mode', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-combo', 'proj', MOCK_CLI));
    session.send('combo test', undefined, undefined, 'plan', undefined, 'You are a planner');

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[permission-mode:plan]');
    expect(rd.result).toContain('[has-system-prompt]');
  });

  it('message is always last arg regardless of flags', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-order', 'proj', MOCK_CLI));
    session.send('order test', undefined, undefined, 'bypass', undefined, 'System context here');

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('order test');
  });
});

// ══════════════════════════════════════════════════════════════════
//  Layer 6: SessionRunner context enrichment
// ══════════════════════════════════════════════════════════════════

describe('SessionRunner context enrichment', () => {
  // buildSessionContext is a no-op as of 2026-06-18 — starting a session for a
  // task no longer injects a system prompt. The session must still start and
  // deliver the message; it just carries no [has-system-prompt] marker.
  it('handleStart starts the session without injecting a system prompt', async () => {
    const tasksDir = path.join(tmpBase, 'tasks');
    await fsp.mkdir(tasksDir, { recursive: true });
    await fsp.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [{
          id: 'ctx-runner-1', title: 'Context test task', status: 'todo',
          priority: 'none', category: 'Test', project: 'Test',
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          subtasks: [], source: 'ms-todo',
          session_ids: [],
          description: '', summary: '', note: '',
        }],
      }),
    );

    const collected = collectEvents();
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    runner.init();

    bus.emit('session:start', {
      taskId: 'ctx-runner-1',
      project: 'Test',
      message: 'context enrichment test',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };

    expect(rd.result).not.toContain('[has-system-prompt]');
    expect(rd.result).toContain('context enrichment test');

    runner.destroyAndKill();
  });

  it('session starts even if buildSessionContext fails', async () => {
    const collected = collectEvents();
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    runner.init();

    bus.emit('session:start', {
      taskId: 'nonexistent-task',
      project: 'Test',
      message: 'should still work',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };

    expect(rd.result).toContain('should still work');
    // buildSessionContext is a no-op now, so no system prompt is injected for a
    // task with no explicit appendSystemPrompt — the session must still start.
    expect(rd.result).not.toContain('[has-system-prompt]');

    runner.destroyAndKill();
  });
});

// ══════════════════════════════════════════════════════════════════
//  Layer 7: attachToExisting (reconnection)
// ══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession.attachToExisting', () => {
  it('creates a session from a SessionRecord without spawning', async () => {
    const session = await ClaudeCodeSession.attachToExisting({
      claudeSessionId: 'test-session-id',
      taskId: 'task-123',
      project: 'proj',
      process_status: 'running',
      mode: 'default',
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: 1,
      pid: 99999,  // Fake PID — doesn't need to be alive for construction
      outputFile: '/tmp/nonexistent.jsonl',
    }, MOCK_CLI, daemonUrl());

    expect(session.sessionId).toBe('test-session-id');
    expect(session.taskId).toBe('task-123');
    expect(session.processPid).toBe(99999);
    expect(session.outputFile).toBe('/tmp/nonexistent.jsonl');
    expect(session.active).toBe(true);

    // Clean up
    session.detach();
  });

  it('restores host field from SessionRecord', async () => {
    const session = await ClaudeCodeSession.attachToExisting({
      claudeSessionId: 'ssh-session-id',
      taskId: 'task-ssh',
      project: 'proj',
      process_status: 'running',
      mode: 'default',
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: 1,
      pid: 99999,
      outputFile: '/tmp/ssh-session.jsonl',
      host: 'remote-dev',
    }, MOCK_CLI, daemonUrl());

    expect(session.host).toBe('remote-dev');
    expect(session.sessionId).toBe('ssh-session-id');

    session.detach();
  });

  it('host is null when not in SessionRecord', async () => {
    const session = await ClaudeCodeSession.attachToExisting({
      claudeSessionId: 'local-session-id',
      taskId: 'task-local',
      project: 'proj',
      process_status: 'running',
      mode: 'default',
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: 1,
      pid: 99999,
      outputFile: '/tmp/local-session.jsonl',
    }, MOCK_CLI, daemonUrl());

    expect(session.host).toBeNull();

    session.detach();
  });
});

// ══════════════════════════════════════════════════════════════════
//  Layer 7b: isSessionStillAlive (rehydrate decision)
// ══════════════════════════════════════════════════════════════════

describe('SessionRunner.isSessionStillAlive', () => {
  it('returns true for a local record whose PID is the current process', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    try {
      const record = {
        claudeSessionId: 'alive-test',
        taskId: 't',
        project: 'p',
        process_status: 'running',
        mode: 'default',
        startedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 0,
        pid: process.pid,
      } as any;
      const result = await (runner as any).isSessionStillAlive(record);
      expect(result).toBe(true);
    } finally {
      runner.destroy();
    }
  });

  it('returns false for a local record with an obviously dead PID', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    try {
      const record = {
        claudeSessionId: 'dead-test',
        taskId: 't',
        project: 'p',
        process_status: 'running',
        mode: 'default',
        startedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 0,
        pid: 2 ** 22, // absurdly high PID that won't exist
      } as any;
      const result = await (runner as any).isSessionStillAlive(record);
      expect(result).toBe(false);
    } finally {
      runner.destroy();
    }
  });

  it('returns false for a local record with no PID', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    try {
      const record = {
        claudeSessionId: 'nopid-test',
        taskId: 't',
        project: 'p',
        process_status: 'running',
        mode: 'default',
        startedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 0,
      } as any;
      const result = await (runner as any).isSessionStillAlive(record);
      expect(result).toBe(false);
    } finally {
      runner.destroy();
    }
  });

  it('routes remote records through probeDaemonSession', async () => {
    vi.resetModules();
    const probeMock = vi.fn().mockResolvedValue({ alive: true });
    vi.doMock('../../src/providers/daemon-connection.js', () => ({
      probeDaemonSession: probeMock,
      isDaemonConnected: () => false,
      getDaemonDisconnectedSince: () => null,
      getDaemonConnection: vi.fn(),
      DaemonConnection: class {},
    }));

    const { SessionRunner: FreshRunner } = await import('../../src/providers/claude-code-session.js');
    const runner = new FreshRunner(MOCK_CLI);
    try {
      const record = {
        claudeSessionId: 'remote-test',
        taskId: 't',
        project: 'p',
        process_status: 'running',
        mode: 'default',
        startedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 0,
        host: 'clouddev',
        pid: 12345,
      } as any;
      const result = await (runner as any).isSessionStillAlive(record);
      expect(result).toBe(true);
      expect(probeMock).toHaveBeenCalledWith('clouddev', 'remote-test');

      probeMock.mockResolvedValueOnce({ alive: false });
      const result2 = await (runner as any).isSessionStillAlive(record);
      expect(result2).toBe(false);

      probeMock.mockResolvedValueOnce(null); // daemon unreachable
      const result3 = await (runner as any).isSessionStillAlive(record);
      expect(result3).toBe(false);
    } finally {
      runner.destroy();
      vi.doUnmock('../../src/providers/daemon-connection.js');
      vi.resetModules();
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  Layer 8: SSH helpers — shellQuote
//  (buildRemoteCommand suite deleted 2026-07-25: the symbol no longer exists.
//   The daemon-transport refactor stopped walnut building `ssh claude …` strings —
//   the daemon spawns the CLI on the remote host itself. See session-io.test.ts.)
// ══════════════════════════════════════════════════════════════════

describe('shellQuote', () => {
  it('wraps a simple string in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes with close-escape-reopen pattern', () => {
    expect(shellQuote("it's a test")).toBe("'it'\\''s a test'");
  });

  it('handles strings with multiple single quotes', () => {
    expect(shellQuote("don't say 'hi'")).toBe("'don'\\''t say '\\''hi'\\'''");
  });

  it('handles empty string', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('handles string that is a single quote', () => {
    expect(shellQuote("'")).toBe("''\\'''");
  });

  it('handles special characters (spaces, semicolons, pipes)', () => {
    expect(shellQuote('foo bar; rm -rf /')).toBe("'foo bar; rm -rf /'");
  });

  it('handles dollar signs and backticks', () => {
    expect(shellQuote('$HOME `whoami`')).toBe("'$HOME `whoami`'");
  });

  it('handles newlines in strings', () => {
    expect(shellQuote('line1\nline2')).toBe("'line1\nline2'");
  });
});

// ══════════════════════════════════════════════════════════════════
//  Layer 9: SSH session — host field on send()
// ══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession SSH host', () => {
  it('stores host key when provided to send()', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-ssh-host', 'proj', MOCK_CLI));

    // send() with host but no sshTarget will just store the host key
    // and spawn locally (since sshTarget is not provided, it uses local spawn)
    session.send('test message', tmpBase, undefined, undefined, undefined, undefined, 'remote-dev');
    expect(session.host).toBe('remote-dev');

    await waitForResult(collected);
  });

  it('host is null when not provided to send()', async () => {
    const collected = collectEvents();
    const session = useDaemon(new ClaudeCodeSession('task-no-host', 'proj', MOCK_CLI));
    session.send('test');

    expect(session.host).toBeNull();

    await waitForResult(collected);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Category C — Streaming event dedup regression
//
//  Uses mock-claude-replay.mjs to simulate daemon reconnect replaying
//  JSONL N times. Verifies handleStreamLine deduplicates repeated events.
// ═══════════════════════════════════════════════════════════════════

const MOCK_REPLAY_CLI = path.resolve(import.meta.dirname, 'mock-claude-replay.mjs');

describe('Category C: Streaming event dedup regression', () => {
  // Needs its OWN daemon: the CLI is chosen by the daemon that spawns it, not by
  // the ClaudeCodeSession constructor argument. Under the shared file-level daemon
  // these tests silently ran the ordinary mock-claude and asserted against the
  // replay mock's output — which is what the dedup logic under test needs.
  let replayDaemon: MockDaemon;

  beforeEach(async () => {
    replayDaemon = await createMockDaemon();
    replayDaemon.setCliCommand(MOCK_REPLAY_CLI);
  });

  afterEach(async () => {
    delete process.env.MOCK_REPLAY_COUNT;
    await replayDaemon.stop();
  });

  /** Point a session at the replay daemon instead of the shared one. */
  const useReplayDaemon = <T extends { _testDaemonUrl?: string }>(t: T): T => {
    t._testDaemonUrl = `ws://127.0.0.1:${replayDaemon.port}`;
    return t;
  };

  // C1–C3: parameterized text replay (2x, 4x, 8x)
  for (const replayCount of [2, 4, 8]) {
    it(`C1-C3: ${replayCount}x text replay → exactly 1 text delta`, async () => {
      process.env.MOCK_REPLAY_COUNT = String(replayCount);
      const collected = collectEvents();
      const session = useReplayDaemon(new ClaudeCodeSession(`task-replay-${replayCount}x`, 'proj', MOCK_REPLAY_CLI));
      session.send('Hello');

      await waitForResult(collected);

      // Despite N replays, only 1 unique text block should be emitted
      expect(collected.textDeltas).toHaveLength(1);
      expect(collected.textDeltas[0].data.delta).toBe('Processed: Hello');
    });
  }

  it('C4: 4x tool_use replay → exactly 1 tool use event', async () => {
    process.env.MOCK_REPLAY_COUNT = '4';
    const collected = collectEvents();
    const session = useReplayDaemon(new ClaudeCodeSession('task-replay-tool', 'proj', MOCK_REPLAY_CLI));
    session.send('tool-test');

    await waitForResult(collected);

    expect(collected.toolUses).toHaveLength(1);
    expect(collected.toolUses[0].data.toolUseId).toBe('toolu_mock_001');
  });

  it('C5: 4x mixed content → textDeltas=2 (pre-tool + post-tool), toolUses=1', async () => {
    process.env.MOCK_REPLAY_COUNT = '4';
    const collected = collectEvents();
    const session = useReplayDaemon(new ClaudeCodeSession('task-replay-mixed', 'proj', MOCK_REPLAY_CLI));
    session.send('tool-test');

    await waitForResult(collected);

    // Pre-tool text ("Let me read that file.") + post-tool text ("Processed: tool-test")
    expect(collected.textDeltas).toHaveLength(2);
    expect(collected.toolUses).toHaveLength(1);
  });

  it('C6: different texts in same message are NOT deduped', async () => {
    process.env.MOCK_REPLAY_COUNT = '2';
    const collected = collectEvents();
    const session = useReplayDaemon(new ClaudeCodeSession('task-replay-twotexts', 'proj', MOCK_REPLAY_CLI));
    session.send('two-texts');

    await waitForResult(collected);

    // Two genuinely different text blocks in the same message → both emitted
    expect(collected.textDeltas).toHaveLength(2);
    expect(collected.textDeltas[0].data.delta).toBe('First distinct text.');
    expect(collected.textDeltas[1].data.delta).toBe('Second distinct text.');
  });

  it('C7: fullText does not contain repeated content after 4x replay', async () => {
    process.env.MOCK_REPLAY_COUNT = '4';
    const collected = collectEvents();
    const session = useReplayDaemon(new ClaudeCodeSession('task-replay-fulltext', 'proj', MOCK_REPLAY_CLI));
    session.send('Hello');

    await waitForResult(collected);

    // fullText should contain the response text exactly once
    const expectedText = 'Processed: Hello';
    expect(session.fullText).toBe(expectedText);
    // Double-check: no duplication
    expect(session.fullText).not.toBe(expectedText + expectedText);
  });
});

// ── Side question ("/btw") control protocol round-trip ──
// Verifies the OUTBOUND direction of the stream-json control protocol: Walnut
// writes a control_request{subtype:side_question} to the CLI FIFO and resolves the
// answer when the matching control_response arrives — WITHOUT touching the transcript.
// We stub the transport's writeRaw to capture the envelope, then feed the CLI's
// reply through the private handleStreamLine (same path the live JSONL tailer uses).
describe('ClaudeCodeSession.askSideQuestion', () => {
  /** Minimal transport stub that captures writeRaw payloads. */
  function makeSessionWithStubTransport() {
    const session = useDaemon(new ClaudeCodeSession('task-btw', 'proj', MOCK_CLI));
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._transport = {
      writeRaw: (json: string) => { writes.push(json); return Promise.resolve(true); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._active = true;
    return { session, writes };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj));

  it('sends a side_question control_request with a unique request_id', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    void session.askSideQuestion('what did I ask?');
    // Give the microtask that calls writeRaw a tick to run.
    await new Promise((r) => setTimeout(r, 5));

    expect(writes.length).toBe(1);
    const env = JSON.parse(writes[0]!);
    expect(env.type).toBe('control_request');
    expect(env.request.subtype).toBe('side_question');
    expect(env.request.question).toBe('what did I ask?');
    expect(typeof env.request_id).toBe('string');
    expect(env.request_id.startsWith('sq-')).toBe(true);
  });

  it('resolves with the answer when the matching control_response arrives', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.askSideQuestion('recall');
    await new Promise((r) => setTimeout(r, 5));
    const requestId = JSON.parse(writes[0]!).request_id as string;

    // Simulate the CLI replying (answer nested 3 levels, per the protocol).
    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { response: 'You asked X', synthetic: false } },
    });

    await expect(promise).resolves.toBe('You asked X');
  });

  it('does NOT add the side-question answer to the transcript', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.askSideQuestion('q');
    await new Promise((r) => setTimeout(r, 5));
    const requestId = JSON.parse(writes[0]!).request_id as string;
    const before = session.fullText;

    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { response: 'a side answer' } },
    });
    await promise;

    // The main conversation text must be untouched by the side answer.
    expect(session.fullText).toBe(before);
    expect(session.fullText).not.toContain('a side answer');
  });

  it('rejects on an error control_response', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.askSideQuestion('q');
    await new Promise((r) => setTimeout(r, 5));
    const requestId = JSON.parse(writes[0]!).request_id as string;

    feed(session, {
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: 'no cache yet' },
    });

    await expect(promise).rejects.toThrow('no cache yet');
  });

  it('ignores a control_response with an unknown request_id (stale replay)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.askSideQuestion('q');
    await new Promise((r) => setTimeout(r, 5));
    const realId = JSON.parse(writes[0]!).request_id as string;

    // A replayed/foreign response must not resolve our pending promise.
    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: 'sq-someone-else', response: { response: 'wrong' } },
    });
    // The real one still resolves correctly afterwards.
    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: realId, response: { response: 'right' } },
    });

    await expect(promise).resolves.toBe('right');
  });

  it('rejects immediately when gracefulStop replaces the transport', async () => {
    const { session } = makeSessionWithStubTransport();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._transport.stop = vi.fn(async () => {});
    (session as any)._transport.stopTail = vi.fn();
    const pending = session.askSideQuestion('summarize this turn', 10_000);
    await new Promise((r) => setTimeout(r, 5));

    await session.gracefulStop(true);

    await expect(pending).rejects.toMatchObject({ code: 'SESSION_TRANSPORT_REPLACED' });
  });
});

describe('turn-complete self-report across restart', () => {
  it('waits for an already-running restart before asking the replacement session', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    const sid = 'self-report-restart-session';
    let finishRestart!: () => void;
    const restarting = new Promise<void>((resolve) => { finishRestart = resolve; });
    const askSideQuestion = vi.fn().mockResolvedValue('EXEC_SUMMARY: recovered after restart');
    const fake = { sessionId: sid, askSideQuestion };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runner as any).sessions.set('restart-task', fake);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runner as any).nativeSessionReinitializations = new Map([[sid, restarting]]);

    const report = runner.requestTurnCompleteSelfReport(sid, 'report prompt', 10_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(askSideQuestion).not.toHaveBeenCalled();
    finishRestart();

    await expect(report).resolves.toBe('EXEC_SUMMARY: recovered after restart');
    expect(askSideQuestion).toHaveBeenCalledOnce();
  });

  it('does not retry a transport replacement without an explicit restart barrier', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    const sid = 'self-report-cold-resume-session';
    const askSideQuestion = vi.fn().mockRejectedValue(Object.assign(
      new Error('session transport replaced'),
      { code: 'SESSION_TRANSPORT_REPLACED' },
    ));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runner as any).sessions.set('resume-task', { sessionId: sid, askSideQuestion });

    await expect(runner.requestTurnCompleteSelfReport(sid, 'report prompt', 10_000))
      .rejects.toMatchObject({ code: 'SESSION_TRANSPORT_REPLACED' });
    expect(askSideQuestion).toHaveBeenCalledOnce();
  });

  it('retries once when restart interrupts an in-flight self-report', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    const sid = 'self-report-interrupted-session';
    const restarting = Promise.resolve();
    const askSideQuestion = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('session transport replaced'), {
        code: 'SESSION_TRANSPORT_REPLACED',
      }))
      .mockResolvedValueOnce('EXEC_SUMMARY: recovered after restart');
    const fake = { sessionId: sid, askSideQuestion };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runner as any).sessions.set('restart-task', fake);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runner as any).nativeSessionReinitializations = new Map([[sid, restarting]]);

    await expect(runner.requestTurnCompleteSelfReport(sid, 'report prompt', 10_000))
      .resolves.toBe('EXEC_SUMMARY: recovered after restart');
    expect(askSideQuestion).toHaveBeenCalledTimes(2);
  });

  it('routes a mid-turn send through the restart barrier, never the dying FIFO', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    const sid = 'mid-turn-message-during-restart';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runner as any).activeProcessing.add(sid);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runner as any).nativeSessionReinitializations = new Map([[sid, new Promise<void>(() => {})]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processNext = vi.spyOn(runner as any, 'processNext').mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const injectMidTurn = vi.spyOn(runner as any, 'injectMidTurn').mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (runner as any).handleSend({ sessionId: sid, message: 'wait for replacement' });
    await new Promise((r) => setTimeout(r, 0));

    expect(processNext).toHaveBeenCalledWith(sid, undefined);
    expect(injectMidTurn).not.toHaveBeenCalled();
  });

  it('keeps messages pending until an explicit restart is ready', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    const sid = 'message-during-restart';
    let finishRestart!: () => void;
    const restarting = new Promise<void>((resolve) => { finishRestart = resolve; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runner as any).nativeSessionReinitializations = new Map([[sid, restarting]]);
    const writeMessage = vi.fn(async () => true);
    const fake = {
      sessionId: sid,
      writeMessage,
      writeSyntheticUserEvent: vi.fn(),
      hasPendingPermission: false,
      hasPipe: true,
      active: true,
      processPid: 123,
      host: null,
      lastMessageDeliveryAt: 0,
      // processNext awaits the spawn barrier before it may conclude "no live
      // pipe" (a session is interactive while the CLI is still booting, so
      // skipping the wait used to SIGINT a starting CLI). A duck-typed fake
      // missing this member makes processNext throw
      // "targetSession.awaitSpawn is not a function", which its own catch turns
      // into a silent delivery_failed — the message is reverted and writeMessage
      // is never reached. That looks exactly like the restart barrier holding
      // forever, so the assertion below would pass for the wrong reason.
      awaitSpawn: async () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runner as any).sessions.set('restart-message-task', fake);
    await enqueueMessage(sid, 'must reach the replacement process');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delivery = (runner as any).processNext(sid) as Promise<void>;
    await new Promise((r) => setTimeout(r, 10));
    expect(writeMessage).not.toHaveBeenCalled();
    expect((await getQueue(sid))[0]?.status).toBe('pending');

    finishRestart();
    await delivery;
    expect(writeMessage).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent explicit restarts for the same session', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    let finishRestart!: () => void;
    const operation = new Promise<void>((resolve) => { finishRestart = resolve; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perform = vi.spyOn(runner as any, 'performNativeReinitialize').mockReturnValue(operation);

    const first = runner.reinitialize('same-session');
    const second = runner.reinitialize('same-session');
    await new Promise((r) => setTimeout(r, 0));

    expect(second).toBe(first);
    expect(perform).toHaveBeenCalledOnce();
    finishRestart();
    await first;
  });

  it('queues a concurrent mode override after the current restart', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    let finishRestart!: () => void;
    let finishModeRestart!: () => void;
    const firstOperation = new Promise<void>((resolve) => { finishRestart = resolve; });
    const secondOperation = new Promise<void>((resolve) => { finishModeRestart = resolve; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perform = vi.spyOn(runner as any, 'performNativeReinitialize')
      .mockReturnValueOnce(firstOperation)
      .mockReturnValueOnce(secondOperation);

    const first = runner.reinitialize('mode-session');
    const modeChange = runner.reinitialize('mode-session', 'bypass');
    const waiting = (runner as any).awaitNativeReinitialization('mode-session') as Promise<void>;
    let barrierSettled = false;
    void waiting.then(() => { barrierSettled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(perform).toHaveBeenCalledTimes(1);

    finishRestart();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(perform).toHaveBeenCalledTimes(2);
    expect(perform).toHaveBeenLastCalledWith('mode-session', 'bypass');
    expect(barrierSettled).toBe(false);

    finishModeRestart();
    await modeChange;
    await waiting;
    expect(barrierSettled).toBe(true);
  });

  it('bounds restart waiting by the original self-report timeout', async () => {
    vi.useFakeTimers();
    try {
      const runner = useDaemon(new SessionRunner(MOCK_CLI));
      const sid = 'self-report-stuck-restart';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runner as any).nativeSessionReinitializations = new Map([[sid, new Promise<void>(() => {})]]);

      const report = runner.requestTurnCompleteSelfReport(sid, 'report prompt', 100);
      const assertion = expect(report).rejects.toThrow('timed out during session restart');
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  applyEffort — mid-session reasoning-effort change via the
//  apply_flag_settings control_request (OUTBOUND ack, no respawn).
//  Same transport/feed harness as askSideQuestion above; the ack
//  branch is checked BEFORE the side-question branch in the handler.
// ═══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession.applyEffort', () => {
  function makeSessionWithStubTransport() {
    const session = useDaemon(new ClaudeCodeSession('task-eff', 'proj', MOCK_CLI));
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._transport = {
      writeRaw: (json: string) => { writes.push(json); return Promise.resolve(true); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._active = true;
    return { session, writes };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj));

  it('sends an apply_flag_settings control_request carrying the effort level', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    void session.applyEffort('low');
    await new Promise((r) => setTimeout(r, 5));

    expect(writes.length).toBe(1);
    const env = JSON.parse(writes[0]!);
    expect(env.type).toBe('control_request');
    expect(env.request.subtype).toBe('apply_flag_settings');
    expect(env.request.settings.effortLevel).toBe('low');
    expect(typeof env.request_id).toBe('string');
    expect(env.request_id.startsWith('eff-')).toBe(true);
  });

  it('reflects the new effort immediately (for the badge / persistence) before the ack', () => {
    const { session } = makeSessionWithStubTransport();
    void session.applyEffort('medium');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._effort).toBe('medium');
  });

  it('resolves true when a success control_response arrives', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.applyEffort('high');
    await new Promise((r) => setTimeout(r, 5));
    const requestId = JSON.parse(writes[0]!).request_id as string;

    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId },
    });

    await expect(promise).resolves.toBe(true);
  });

  it('rejects on an error control_response', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.applyEffort('low');
    await new Promise((r) => setTimeout(r, 5));
    const requestId = JSON.parse(writes[0]!).request_id as string;

    feed(session, {
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: 'bad effort' },
    });

    await expect(promise).rejects.toThrow('bad effort');
  });

  it('throws synchronously when the session has no transport', async () => {
    const session = useDaemon(new ClaudeCodeSession('task-eff-dead', 'proj', MOCK_CLI));
    await expect(session.applyEffort('low')).rejects.toThrow('session not started');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  applyModel — mid-session model change via the SAME apply_flag_settings
//  control_request as effort (live-verified on 2.1.170: {model:'sonnet'}
//  flips the NEXT turn's assistant model; [1m] suffixes round-trip; a
//  garbage value is ACKed but ignored → read-back is mandatory).
//  Replaces the old pendingModel → interrupt + --resume respawn path.
// ═══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession.applyModel', () => {
  function makeSessionWithStubTransport() {
    const session = useDaemon(new ClaudeCodeSession('task-mdl', 'proj', MOCK_CLI));
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._transport = {
      writeRaw: (json: string) => { writes.push(json); return Promise.resolve(true); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._active = true;
    return { session, writes };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj));

  it('sends an apply_flag_settings control_request carrying the CLI model value', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    void session.applyModel('sonnet[1m]');
    await new Promise((r) => setTimeout(r, 5));

    expect(writes.length).toBe(1);
    const env = JSON.parse(writes[0]!);
    expect(env.type).toBe('control_request');
    expect(env.request.subtype).toBe('apply_flag_settings');
    expect(env.request.settings.model).toBe('sonnet[1m]');
    expect((env.request_id as string).startsWith('mdl-')).toBe(true);
  });

  it('reflects the new cliModel immediately (for resume persistence) before the ack', () => {
    const { session } = makeSessionWithStubTransport();
    void session.applyModel('haiku');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._cliModel).toBe('haiku');
  });

  it('resolves true when a success control_response arrives', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.applyModel('sonnet');
    await new Promise((r) => setTimeout(r, 5));
    const requestId = JSON.parse(writes[0]!).request_id as string;

    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId },
    });

    await expect(promise).resolves.toBe(true);
  });

  it('throws when the session has no transport', async () => {
    const session = useDaemon(new ClaudeCodeSession('task-mdl-dead', 'proj', MOCK_CLI));
    await expect(session.applyModel('sonnet')).rejects.toThrow('session not started');
  });

  it('refreshAppliedSettings reconciles the live model from applied.model (read-back)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).claudeSessionId = 'sid-mdl';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._model = 'claude-opus-4-8';
    const promise = session.refreshAppliedSettings('test');
    await new Promise((r) => setTimeout(r, 5));
    const gs = writes.map(w => JSON.parse(w)).find(e => e.request?.subtype === 'get_settings');
    expect(gs).toBeTruthy();
    feed(session, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: gs.request_id,
        // Verbatim 2.1.170 shape after apply_flag_settings{model:'sonnet[1m]'}
        response: { applied: { model: 'us.anthropic.claude-sonnet-4-6[1m]', effort: 'high', ultracode: false } },
      },
    });
    const result = await promise;
    expect(result?.model).toBe('us.anthropic.claude-sonnet-4-6[1m]');
    // _model reconciled to the short display form; _initModel keeps the full ID
    // so 1M-context detection follows the switch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._model).toBe('claude-sonnet-4-6[1m]');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._initModel).toBe('us.anthropic.claude-sonnet-4-6[1m]');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  applyPermissionMode — mid-session permission-mode change via the
//  dedicated set_permission_mode control_request (NO respawn). The third
//  member of the live-settings family after model/effort. Live-verified on
//  2.1.170: the response ECHOES the new mode ({"mode":"plan"}) and the CLI
//  emits a system/status event with the new permissionMode (which the
//  existing status handler reconciles). Replaces pendingMode → --resume.
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
//  forceSettlePermissionRequests — retiring an archived plan session must
//  deny its pending permissions (ExitPlanMode etc.), stop the 60s re-emit
//  timers, and emit SESSION_PERMISSION_RESOLVED so the notification feed
//  stamps the record. Regression for the "archived plan session spams
//  'needs permission approval' every 60s forever" bug.
// ═══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession.forceSettlePermissionRequests', () => {
  function makePendingPermissionSession() {
    const session = useDaemon(new ClaudeCodeSession('task-settle', 'proj', MOCK_CLI));
    const writes: string[] = [];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (session as any)._transport = {
      writeRaw: (json: string) => { writes.push(json); return Promise.resolve(true); },
      stopTail: () => {},
      kill: () => {},
      detach: () => {},
    };
    (session as any)._active = true;
    (session as any).claudeSessionId = 'settle-sid-1';
    (session as any)._mode = 'default';
    // Feed a real control_request through handleStreamLine so the pending map
    // and the re-emit timer are populated by production code, not by hand.
    (session as any).handleStreamLine(JSON.stringify({
      type: 'control_request',
      request_id: 'req-settle-1',
      request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'x' } },
    }));
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return { session, writes };
  }

  it('denies pending requests, clears timers, and emits permission-resolved', async () => {
    const { session, writes } = makePendingPermissionSession();
    expect(session.hasPendingPermission).toBe(true);
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    expect((session as any)._permissionReEmitTimers.size).toBe(1);

    const resolved: BusEvent[] = [];
    bus.subscribe('test-settle', (e) => { resolved.push(e); },
      { global: true, interest: [EventNames.SESSION_PERMISSION_RESOLVED] });

    session.forceSettlePermissionRequests('Plan archived — executing in a new session');

    expect(session.hasPendingPermission).toBe(false);
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    expect((session as any)._permissionReEmitTimers.size).toBe(0);

    // Deny was written to the CLI as a control_response
    const denyLine = writes.map((w) => JSON.parse(w)).find((w) => w.type === 'control_response');
    expect(denyLine).toBeTruthy();
    expect(denyLine.response.request_id).toBe('req-settle-1');
    expect(denyLine.response.response.behavior).toBe('deny');

    const ev = resolved.find((e) => e.name === EventNames.SESSION_PERMISSION_RESOLVED);
    expect(ev).toBeTruthy();
    expect((ev!.data as { requestId: string }).requestId).toBe('req-settle-1');
    expect((ev!.data as { allowed: boolean }).allowed).toBe(false);
    bus.unsubscribe('test-settle');
  });

  it('does not re-queue when the transport is gone (unlike resolvePermissionRequest)', () => {
    const { session } = makePendingPermissionSession();
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    (session as any)._transport = null;

    session.forceSettlePermissionRequests('Session archived');

    // Pending map and timers must be empty even though the deny could not be delivered
    expect(session.hasPendingPermission).toBe(false);
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    expect((session as any)._permissionReEmitTimers.size).toBe(0);
  });

  it('kill() also clears pending permissions and timers', () => {
    const { session } = makePendingPermissionSession();
    session.kill();
    expect(session.hasPendingPermission).toBe(false);
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    expect((session as any)._permissionReEmitTimers.size).toBe(0);
  });
});

describe('ClaudeCodeSession.applyPermissionMode', () => {
  function makeSessionWithStubTransport() {
    const session = useDaemon(new ClaudeCodeSession('task-pmode', 'proj', MOCK_CLI));
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._transport = {
      writeRaw: (json: string) => { writes.push(json); return Promise.resolve(true); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._active = true;
    return { session, writes };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj));

  it('sends set_permission_mode with the CLI vocabulary (bypass → bypassPermissions)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    void session.applyPermissionMode('bypass');
    await new Promise((r) => setTimeout(r, 5));

    expect(writes.length).toBe(1);
    const env = JSON.parse(writes[0]!);
    expect(env.type).toBe('control_request');
    expect(env.request.subtype).toBe('set_permission_mode');
    expect(env.request.mode).toBe('bypassPermissions');
    expect((env.request_id as string).startsWith('pmode-')).toBe(true);
  });

  it('resolves true when the CLI echoes the mode back (verbatim 2.1.170 shape)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.applyPermissionMode('plan');
    await new Promise((r) => setTimeout(r, 5));
    const requestId = JSON.parse(writes[0]!).request_id as string;

    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { mode: 'plan' } },
    });

    await expect(promise).resolves.toBe(true);
    // Optimistic in-memory mode set immediately.
    expect(session.mode).toBe('plan');
  });

  it('resolves false when the echo does not match (unconfirmed switch)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.applyPermissionMode('accept');
    await new Promise((r) => setTimeout(r, 5));
    const requestId = JSON.parse(writes[0]!).request_id as string;

    // CLI answered but with a different (or missing) mode → not confirmed.
    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    });

    await expect(promise).resolves.toBe(false);
  });

  it('throws when the session has no transport', async () => {
    const session = useDaemon(new ClaudeCodeSession('task-pmode-dead', 'proj', MOCK_CLI));
    await expect(session.applyPermissionMode('plan')).rejects.toThrow('session not started');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  getContextUsage / getUsage / getBinaryVersion — payload-carrying reads
//  over the same control_request plumbing (shared _pendingPayloadReads).
//  Shapes verbatim from a 2.1.170 live probe.
// ═══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession payload reads (context usage / usage / version)', () => {
  function makeSessionWithStubTransport() {
    const session = useDaemon(new ClaudeCodeSession('task-reads', 'proj', MOCK_CLI));
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._transport = {
      writeRaw: (json: string) => { writes.push(json); return Promise.resolve(true); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._active = true;
    return { session, writes };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj));

  it('getContextUsage normalizes categories/totals from the get_context_usage payload', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.getContextUsage();
    await new Promise((r) => setTimeout(r, 5));
    const env = JSON.parse(writes[0]!);
    expect(env.request.subtype).toBe('get_context_usage');

    // Verbatim 2.1.170 probe shape (gridRows and colors dropped by normalizer).
    feed(session, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: env.request_id,
        response: {
          categories: [
            { name: 'System prompt', tokens: 6219, color: 'promptBorder' },
            { name: 'MCP tools', tokens: 120132, color: 'cyan' },
            { name: 'Free space', tokens: 5479, color: 'promptBorder' },
          ],
          totalTokens: 111177, maxTokens: 200000, rawMaxTokens: 200000, percentage: 56,
          gridRows: [[]],
        },
      },
    });

    const result = await promise;
    expect(result).toEqual({
      categories: [
        { name: 'System prompt', tokens: 6219 },
        { name: 'MCP tools', tokens: 120132 },
        { name: 'Free space', tokens: 5479 },
      ],
      totalTokens: 111177, maxTokens: 200000, percentage: 56,
    });
  });

  it('getContextUsage seeds _cliContextWindow via seedCliContextWindow (context% denominator)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any).seedCliContextWindow('test');
    await new Promise((r) => setTimeout(r, 5));
    const env = JSON.parse(writes[0]!);
    feed(session, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: env.request_id,
        // env CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000 clamps a sonnet[1m] session
        // to an effective 400K — the exact case the string-guess can't see.
        response: { categories: [], totalTokens: 36762, maxTokens: 400000, percentage: 9 },
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._cliContextWindow).toBe(400000);
  });

  it('getUsage resolves the session block (cost + per-model usage)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.getUsage();
    await new Promise((r) => setTimeout(r, 5));
    const env = JSON.parse(writes[0]!);
    expect(env.request.subtype).toBe('get_usage');

    feed(session, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: env.request_id,
        response: {
          session: {
            total_cost_usd: 0.139,
            model_usage: { 'us.anthropic.claude-haiku-4-5-20251001-v1:0': { inputTokens: 10, outputTokens: 86, contextWindow: 200000 } },
          },
          subscription_type: null,
        },
      },
    });

    const result = await promise;
    expect(result?.total_cost_usd).toBe(0.139);
    expect((result?.model_usage as Record<string, unknown>)['us.anthropic.claude-haiku-4-5-20251001-v1:0']).toBeTruthy();
  });

  it('getBinaryVersion resolves {version, buildTime}; errors resolve null (untrusted)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const p1 = session.getBinaryVersion();
    await new Promise((r) => setTimeout(r, 5));
    const env1 = JSON.parse(writes[0]!);
    expect(env1.request.subtype).toBe('get_binary_version');
    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: env1.request_id, response: { version: '2.1.170', buildTime: '2026-06-09T15:09:09Z' } },
    });
    await expect(p1).resolves.toEqual({ version: '2.1.170', buildTime: '2026-06-09T15:09:09Z' });

    const p2 = session.getContextUsage();
    await new Promise((r) => setTimeout(r, 5));
    const env2 = JSON.parse(writes[1]!);
    feed(session, {
      type: 'control_response',
      response: { subtype: 'error', request_id: env2.request_id, error: 'unknown subtype' },
    });
    await expect(p2).resolves.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  getSettings — read the CLI's TRUE runtime effort via get_settings.
//  The apply_flag_settings ACK can't be trusted (CLI silently overrides
//  via env / downgrades unsupported levels and still ACKs success), so
//  we read back response.response.applied.effort — the runtime-resolved
//  value. Verified verbatim against binary 2.1.170.
// ═══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession.getSettings (effort read-back)', () => {
  function makeSessionWithStubTransport() {
    const session = useDaemon(new ClaudeCodeSession('task-gs', 'proj', MOCK_CLI));
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._transport = {
      writeRaw: (json: string) => { writes.push(json); return Promise.resolve(true); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._active = true;
    return { session, writes };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj));

  it('sends a get_settings control_request', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    void session.getSettings();
    await new Promise((r) => setTimeout(r, 5));
    expect(writes.length).toBe(1);
    const env = JSON.parse(writes[0]!);
    expect(env.type).toBe('control_request');
    expect(env.request.subtype).toBe('get_settings');
    expect((env.request_id as string).startsWith('gs-')).toBe(true);
  });

  it('preserves applied runtime settings and the effective configured default', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.getSettingsSnapshot();
    await new Promise((r) => setTimeout(r, 5));
    const requestId = JSON.parse(writes[0]!).request_id as string;
    // Real shape (verbatim 2.1.170): response.response.applied.effort is the
    // runtime truth; effective.effortLevel is the disk merge (ignored here).
    feed(session, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          effective: { effortLevel: 'xhigh' },
          sources: { effortLevel: 'userSettings' },
          applied: { model: 'claude-opus-4-8', effort: 'high', ultracode: false }, // env override → high
        },
      },
    });
    // `sources` in the CLI payload is intentionally NOT plumbed through — no
    // consumer reads it; the snapshot carries only applied + effective.
    await expect(promise).resolves.toEqual({
      applied: { model: 'claude-opus-4-8', effort: 'high', ultracode: false },
      effective: { effortLevel: 'xhigh' },
    });
  });

  it('resolves null on an error control_response (untrusted — never clobber)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.getSettings();
    await new Promise((r) => setTimeout(r, 5));
    const requestId = JSON.parse(writes[0]!).request_id as string;
    feed(session, {
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: 'nope' },
    });
    await expect(promise).resolves.toBeNull();
  });

  it('resolves null (not throw) when there is no transport', async () => {
    const session = useDaemon(new ClaudeCodeSession('task-gs-dead', 'proj', MOCK_CLI));
    await expect(session.getSettings()).resolves.toBeNull();
  });

  it('refreshEffectiveEffort reconciles _effectiveEffort from applied.effort and flags override', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).claudeSessionId = 'sid-gs';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._effort = 'xhigh';         // requested xhigh
    const promise = session.refreshEffectiveEffort('test');
    await new Promise((r) => setTimeout(r, 5));
    // find the get_settings write (refreshEffectiveEffort calls getSettings internally)
    const gs = writes.map(w => JSON.parse(w)).find(e => e.request?.subtype === 'get_settings');
    expect(gs).toBeTruthy();
    feed(session, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: gs.request_id,
        response: { applied: { model: 'claude-opus-4-8', effort: 'high' } }, // env forced high
      },
    });
    const eff = await promise;
    expect(eff).toBe('high');                    // true runtime value
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._effectiveEffort).toBe('high');
    // requested xhigh ≠ effective high ⇒ this is the "overridden" case the badge flags
  });

  // Regression: the read-back must be PUSHED to the browser, not only persisted.
  // The panel fetches the session record once at mount, but the session-start
  // read-back lands ~1.5s later — with no event, the composer's effort pill kept
  // rendering its own guess while the picker (which live-pulls get_settings on
  // open) showed the CLI's real level. Two surfaces, one truth: the event is the
  // delivery path (effectiveEffort is not part of SessionStatusSnapshot).
  it('emits session:settings-applied with the read-back so the composer pill matches the picker', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).claudeSessionId = 'sid-push';
    // No requested effort — the real-world case: the level lives in the CLI's own
    // settings.json (effortLevel: xhigh), which Walnut never asked for.
    const pushed: BusEvent[] = [];
    bus.subscribe('web-ui', (event: BusEvent) => {
      if (event.name === EventNames.SESSION_SETTINGS_APPLIED) pushed.push(event);
    });
    const promise = session.refreshAppliedSettings('session-start');
    await new Promise((r) => setTimeout(r, 5));
    const gs = writes.map(w => JSON.parse(w)).find(e => e.request?.subtype === 'get_settings');
    feed(session, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: gs.request_id,
        response: { applied: { model: 'global.anthropic.claude-fable-5[1m]', effort: 'xhigh' } },
      },
    });
    await promise;
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.data).toMatchObject({
      sessionId: 'sid-push',
      effectiveEffort: 'xhigh',      // what the pill must now render
      requestedEffort: null,         // nothing was requested — the guess had no basis
      model: 'global.anthropic.claude-fable-5[1m]',
    });
  });

  // An UNTRUSTED read (old CLI / timeout / error) must not emit: pushing a null
  // here would clobber a known-good badge with "unknown" on every hiccup.
  it('does not emit session:settings-applied when the read is untrusted', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).claudeSessionId = 'sid-untrusted';
    const pushed: BusEvent[] = [];
    bus.subscribe('web-ui', (event: BusEvent) => {
      if (event.name === EventNames.SESSION_SETTINGS_APPLIED) pushed.push(event);
    });
    const promise = session.refreshAppliedSettings('session-start');
    await new Promise((r) => setTimeout(r, 5));
    const gs = writes.map(w => JSON.parse(w)).find(e => e.request?.subtype === 'get_settings');
    feed(session, {
      type: 'control_response',
      response: { subtype: 'error', request_id: gs.request_id, error: 'unsupported' },
    });
    await expect(promise).resolves.toBeNull();
    expect(pushed).toEqual([]);
  });
});

// Verifies the per-session model catalog: getModelCatalog() sends ONE
// `list_models` control_request (the CLI's read-only catalog query, 2.1.199+),
// falls back to `initialize` when the CLI errors it (old builds answer with a
// fast explicit "Unsupported control request subtype"), sanitizes the
// response's models[] (the CLI's own allowlist-filtered picker source), caches
// it on the session, shares an in-flight fetch between parallel callers, and
// drops the cache on the documented invalidation events. Same stub-transport
// pattern as getSettings.
describe('ClaudeCodeSession.getModelCatalog', () => {
  function makeSessionWithStubTransport() {
    const session = useDaemon(new ClaudeCodeSession('task-cat', 'proj', MOCK_CLI));
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._transport = {
      writeRaw: (json: string) => { writes.push(json); return Promise.resolve(true); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._active = true;
    return { session, writes };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj));

  // Real 2.1.199 list_models/initialize response shape (trimmed — the two
  // subtypes serve models[] from the same function in the CLI).
  const CLI_MODELS = [
    { value: 'default', resolvedModel: 'global.anthropic.claude-fable-5', displayName: 'Default' },
    {
      value: 'global.anthropic.claude-fable-5', resolvedModel: 'global.anthropic.claude-fable-5',
      displayName: 'Fable', description: 'Fast & capable',
      supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'global.anthropic.claude-opus-4-8[1m]', resolvedModel: 'global.anthropic.claude-opus-4-8[1m]',
      displayName: 'Opus (1M context)', disabled: true,
    },
  ];

  async function fetchWithReply(session: ClaudeCodeSession, writes: string[], models: unknown) {
    const promise = session.getModelCatalog();
    await new Promise((r) => setTimeout(r, 5));
    const env = writes.map((w) => JSON.parse(w)).find((e) => e.request?.subtype === 'list_models');
    expect(env).toBeTruthy();
    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: env.request_id, response: { models } },
    });
    return promise;
  }

  it('sends a list_models control_request and returns the sanitized catalog', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const catalog = await fetchWithReply(session, writes, CLI_MODELS);
    expect(writes.length).toBe(1);
    expect((JSON.parse(writes[0]!).request_id as string).startsWith('lm-')).toBe(true);
    expect(catalog).not.toBeNull();
    expect(catalog!.models.map((m) => m.value)).toEqual([
      'default', 'global.anthropic.claude-fable-5', 'global.anthropic.claude-opus-4-8[1m]',
    ]);
    expect(catalog!.models[1]).toMatchObject({
      displayName: 'Fable', supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(catalog!.models[2].disabled).toBe(true);
    expect(typeof catalog!.fetchedAt).toBe('number');
  });

  it('drops malformed rows and filters bogus effort levels', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const catalog = await fetchWithReply(session, writes, [
      { value: '', displayName: 'no value' },              // dropped
      { displayName: 'missing value' },                    // dropped
      { value: 'm1' },                                     // dropped (no displayName)
      { value: 'ok', displayName: 'OK', supportedEffortLevels: ['high', 'ultra', 42] },
    ]);
    expect(catalog!.models).toHaveLength(1);
    expect(catalog!.models[0].supportedEffortLevels).toEqual(['high']);
  });

  it('resolves null when models is missing or empty after sanitize (old CLI)', async () => {
    const a = makeSessionWithStubTransport();
    expect(await fetchWithReply(a.session, a.writes, undefined)).toBeNull();
    const b = makeSessionWithStubTransport();
    expect(await fetchWithReply(b.session, b.writes, [{ displayName: 'junk only' }])).toBeNull();
  });

  it('falls back to initialize when the CLI errors list_models (old build)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.getModelCatalog();
    await new Promise((r) => setTimeout(r, 5));
    // Old CLI: fast explicit error on the unknown subtype…
    const lmId = JSON.parse(writes[0]!).request_id as string;
    expect(lmId.startsWith('lm-')).toBe(true);
    feed(session, { type: 'control_response', response: { subtype: 'error', request_id: lmId, error: 'Unsupported control request subtype: list_models' } });
    await new Promise((r) => setTimeout(r, 5));
    // …must trigger a second write: the initialize fallback.
    expect(writes.length).toBe(2);
    const initEnv = JSON.parse(writes[1]!);
    expect(initEnv.request?.subtype).toBe('initialize');
    expect((initEnv.request_id as string).startsWith('init-')).toBe(true);
    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: initEnv.request_id, response: { pid: 1, models: CLI_MODELS } },
    });
    const catalog = await promise;
    expect(catalog!.models).toHaveLength(3);
  });

  it('resolves null when both subtypes error, and with no transport', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.getModelCatalog();
    await new Promise((r) => setTimeout(r, 5));
    feed(session, { type: 'control_response', response: { subtype: 'error', request_id: JSON.parse(writes[0]!).request_id, error: 'nope' } });
    await new Promise((r) => setTimeout(r, 5));
    feed(session, { type: 'control_response', response: { subtype: 'error', request_id: JSON.parse(writes[1]!).request_id, error: 'nope' } });
    await expect(promise).resolves.toBeNull();
    expect(writes.length).toBe(2);

    const bare = useDaemon(new ClaudeCodeSession('task-cat-dead', 'proj', MOCK_CLI));
    await expect(bare.getModelCatalog()).resolves.toBeNull();
  });

  it('does NOT fall back to initialize when list_models times out (CLI unresponsive)', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    // Tiny budget, no reply: the list_models wait consumes it all — a second
    // attempt against an unresponsive CLI would just hang the same way.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (session as any).fetchModelCatalog(80);
    expect(result).toBeNull();
    expect(writes.length).toBe(1);
    expect(JSON.parse(writes[0]!).request?.subtype).toBe('list_models');
  });

  it('caches: second call answers from cache with zero extra writes', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    await fetchWithReply(session, writes, CLI_MODELS);
    const again = await session.getModelCatalog();
    expect(writes.length).toBe(1);
    expect(again!.models).toHaveLength(3);
  });

  it('parallel callers share ONE in-flight initialize write', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const p1 = session.getModelCatalog();
    const p2 = session.getModelCatalog();
    await new Promise((r) => setTimeout(r, 5));
    expect(writes.length).toBe(1);
    const requestId = JSON.parse(writes[0]!).request_id as string;
    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { models: CLI_MODELS } },
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1!.models).toHaveLength(3);
    expect(r2!.models).toHaveLength(3);
  });

  it('invalidateModelCatalog forces a refetch; force:true bypasses a warm cache', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    await fetchWithReply(session, writes, CLI_MODELS);

    session.invalidateModelCatalog();
    const p2 = session.getModelCatalog();
    await new Promise((r) => setTimeout(r, 5));
    expect(writes.length).toBe(2); // cache dropped → second initialize write
    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: JSON.parse(writes[1]!).request_id, response: { models: CLI_MODELS.slice(0, 2) } },
    });
    expect((await p2)!.models).toHaveLength(2);

    const p3 = session.getModelCatalog({ force: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(writes.length).toBe(3); // warm cache bypassed
    feed(session, {
      type: 'control_response',
      response: { subtype: 'success', request_id: JSON.parse(writes[2]!).request_id, response: { models: CLI_MODELS } },
    });
    expect((await p3)!.models).toHaveLength(3);
  });

  it('teardown (_rejectAllSideQuestions path) clears the cache', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    await fetchWithReply(session, writes, CLI_MODELS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._rejectAllSideQuestions('teardown');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._modelCatalog).toBeNull();
  });

  it('ignores an old transport catalog result without clearing the new fetch', async () => {
    const { session } = makeSessionWithStubTransport();
    let resolveOld!: (models: typeof CLI_MODELS) => void;
    let resolveNew!: (models: typeof CLI_MODELS) => void;
    const oldFetch = new Promise<typeof CLI_MODELS>((resolve) => { resolveOld = resolve; });
    const newFetch = new Promise<typeof CLI_MODELS>((resolve) => { resolveNew = resolve; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(session as any, 'fetchModelCatalog')
      .mockReturnValueOnce(oldFetch)
      .mockReturnValueOnce(newFetch);

    const oldRequest = session.getModelCatalog();
    // Simulate transport replacement: generation advances and the new process gets
    // its own independent catalog fetch while the old Promise is still settling.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._transportGeneration++;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._modelCatalogInflight = null;
    const newRequest = session.getModelCatalog();

    resolveOld(CLI_MODELS);
    await expect(oldRequest).resolves.toBeNull();
    // Old finally must not clear the replacement process's in-flight fetch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._modelCatalogInflight).not.toBeNull();

    const replacementModels = CLI_MODELS.slice(0, 1);
    resolveNew(replacementModels as typeof CLI_MODELS);
    await expect(newRequest).resolves.toMatchObject({ models: replacementModels });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._modelCatalog.models).toEqual(replacementModels);
  });

  // ── Eager catalog side effects: every REAL fetch emits SESSION_MODEL_CATALOG
  // (clients render without a per-open pull) and writes the host-level store
  // (feeds the quick-session dropdown / dead-session pickers). Cache hits do
  // neither — the push would be redundant.
  it('a real fetch emits session:model-catalog and writes the host store; a cache hit does not re-emit', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).claudeSessionId = 'sid-cat-push';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._cwd = '/tmp/proj';

    const events: BusEvent[] = [];
    bus.subscribe('main-ai', (e) => { if (e.name === EventNames.SESSION_MODEL_CATALOG) events.push(e); });

    await fetchWithReply(session, writes, CLI_MODELS);
    await new Promise((r) => setTimeout(r, 50)); // dynamic import + write chain

    expect(events).toHaveLength(1);
    const data = events[0]!.data as { sessionId: string; host?: string; models: unknown[]; fetchedAt: string };
    expect(data.sessionId).toBe('sid-cat-push');
    expect(data.host).toBeUndefined(); // local session → no host field
    expect(data.models).toHaveLength(3);
    expect(typeof data.fetchedAt).toBe('string');

    // Host store written under the local key, cwd recorded.
    const { getHostModelCatalog, _resetHostModelCatalogCache } = await import('../../src/core/host-model-catalog.js');
    _resetHostModelCatalogCache(); // force a disk read — proves persistence, not just memory
    const stored = await getHostModelCatalog(null);
    expect(stored?.models).toHaveLength(3);
    expect(stored?.cwd).toBe('/tmp/proj');

    // Cache hit → no second emit, no extra write.
    await session.getModelCatalog();
    expect(events).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  it('handleStreamLine init event triggers ONE deferred eager fetch (list_models write)', async () => {
    vi.useFakeTimers();
    try {
      const { session, writes } = makeSessionWithStubTransport();
      // The init branch renames the transport's stream file to the real session
      // id — the minimal stub needs those members or the branch throws before
      // reaching the eager-fetch scheduling.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Object.assign((session as any)._transport, {
        renameForSession: () => {},
        outputFile: '/tmp/stub-output.jsonl',
      });
      // Init event: the CLI announcing itself — must schedule the eager fetch.
      feed(session, { type: 'system', subtype: 'init', session_id: 'sid-eager-1', model: 'claude-fable-5' });
      expect(writes).toHaveLength(0); // deferred, not immediate (CLI still wiring ask())
      await vi.advanceTimersByTimeAsync(1600);
      const lm = writes.map((w) => JSON.parse(w)).filter((e) => e.request?.subtype === 'list_models');
      expect(lm).toHaveLength(1);

      // A second init (new TURN, same process, catalog cached) must NOT refetch.
      feed(session, {
        type: 'control_response',
        response: { subtype: 'success', request_id: JSON.parse(writes[writes.length - 1]!).request_id, response: { models: CLI_MODELS } },
      });
      await vi.advanceTimersByTimeAsync(10)
      feed(session, { type: 'system', subtype: 'init', session_id: 'sid-eager-1', model: 'claude-fable-5' });
      await vi.advanceTimersByTimeAsync(1600);
      const lmAfter = writes.map((w) => JSON.parse(w)).filter((e) => e.request?.subtype === 'list_models');
      expect(lmAfter).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Turn-ledger live round-trip — SessionRunner.currentTurn() through a REAL
//  daemon (MockDaemon), not a stubbed transport. Proves the promissory note
//  opened by setActiveProcessing (processNext) settles with the outcome
//  clearActiveProcessing's call sites already decide, end-to-end through the
//  same daemon/session-manager plumbing production code uses.
// ═══════════════════════════════════════════════════════════════════

describe('SessionRunner.currentTurn — live daemon round-trip', () => {
  let daemon: MockDaemon;
  let runner: SessionRunner;

  beforeEach(async () => {
    daemon = await createMockDaemon();
    runner = useDaemon(new SessionRunner(MOCK_CLI));
    runner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`);
    runner.init();
  });

  afterEach(async () => {
    runner.destroyAndKill();
    await daemon.stop();
  });

  it('currentTurn resolves with the result outcome once the real turn completes', async () => {
    const collected = collectEvents();
    const sessionId = 'ledger-live-task';

    bus.emit(EventNames.SESSION_START, {
      taskId: sessionId,
      message: 'hello ledger',
      project: 'test-proj',
    }, ['session-runner'], { source: 'test' });

    // handleStart's `this.sessions.set(mapKey, session)` runs asynchronously
    // after SESSION_START is emitted (it's inside an async bus handler) — poll
    // until the session object exists before awaiting its sessionReady.
    let liveSession: ClaudeCodeSession | undefined;
    for (let i = 0; i < 200 && !liveSession; i++) {
      liveSession = runner.getByTaskId(sessionId);
      if (!liveSession) await new Promise((r) => setTimeout(r, 10));
    }
    expect(liveSession).toBeDefined();
    const claudeSessionId = await liveSession!.sessionReady;
    expect(claudeSessionId).toBeTruthy();

    // By the time sessionReady resolves the FIRST turn may already be settling
    // (init arrives before result). Wait for its result before starting a fresh,
    // independently-observable second turn on the same session.
    await waitForResult(collected);

    // Re-drive a second turn on the SAME session and observe currentTurn
    // transition open → settled live, through the real daemon round-trip.
    const collected2 = collectEvents();
    await enqueueMessage(claudeSessionId, 'second turn');
    bus.emit(EventNames.SESSION_SEND, {
      sessionId: claudeSessionId,
      message: 'second turn',
    }, ['session-runner'], { source: 'test' });

    // Poll until the turn opens (processNext's setActiveProcessing runs async).
    let openPromise: Promise<import('../../src/providers/turn-ledger.js').TurnOutcome> | undefined;
    const pollStart = Date.now();
    while (!openPromise && Date.now() - pollStart < 5000) {
      openPromise = runner.currentTurn(claudeSessionId);
      if (!openPromise) await new Promise((r) => setTimeout(r, 10));
    }
    expect(openPromise).toBeDefined();

    await waitForResult(collected2);

    const outcome = await openPromise!;
    expect(outcome).toEqual({ kind: 'result', isError: false });
    // Settled — no longer open.
    expect(runner.currentTurn(claudeSessionId)).toBeUndefined();
  });

  it('currentTurn rejects with a stopped outcome when the turn is interrupted', async () => {
    const collected = collectEvents();
    const sessionId = 'ledger-live-interrupt-task';

    // The INITIAL spawn (SESSION_START → handleStart → session.send()) is not
    // ledger-tracked — only the activeProcessing chokepoints (processNext /
    // injectMidTurn, reached via SESSION_SEND) open a turn. So first let the
    // initial turn complete, then drive a second, ledger-tracked turn we can
    // interrupt mid-flight.
    bus.emit(EventNames.SESSION_START, {
      taskId: sessionId,
      message: 'hello',
      project: 'test-proj',
    }, ['session-runner'], { source: 'test' });

    let liveSession: ClaudeCodeSession | undefined;
    for (let i = 0; i < 200 && !liveSession; i++) {
      liveSession = runner.getByTaskId(sessionId);
      if (!liveSession) await new Promise((r) => setTimeout(r, 10));
    }
    expect(liveSession).toBeDefined();
    const claudeSessionId = await liveSession!.sessionReady;
    expect(claudeSessionId).toBeTruthy();
    await waitForResult(collected);

    const collected2 = collectEvents();
    await enqueueMessage(claudeSessionId, 'slow:2000 second turn');
    bus.emit(EventNames.SESSION_SEND, {
      sessionId: claudeSessionId,
      message: 'slow:2000 second turn',
    }, ['session-runner'], { source: 'test' });

    // Poll until the second turn opens (processNext's setActiveProcessing).
    let openPromise: Promise<import('../../src/providers/turn-ledger.js').TurnOutcome> | undefined;
    const pollStart = Date.now();
    while (!openPromise && Date.now() - pollStart < 5000) {
      openPromise = runner.currentTurn(claudeSessionId);
      if (!openPromise) await new Promise((r) => setTimeout(r, 10));
    }
    expect(openPromise).toBeDefined();

    bus.emit(EventNames.SESSION_SEND, {
      sessionId: claudeSessionId,
      message: '',
      interrupt: true,
    }, ['session-runner'], { source: 'test' });

    const outcome = await openPromise!;
    expect(outcome).toEqual({ kind: 'stopped' });

    // Drain the still-running mock CLI's eventual result so it doesn't leak
    // into the next test's bus subscribers.
    await waitForResult(collected2).catch(() => {});
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════
//  REGRESSION inc-1785091339102 — the 60s activeProcessing safety timeout used
//  to DELETE batchMessageIds. A normal turn routinely runs longer than 60s (228s
//  in the incident), so the eventual SESSION_BATCH_COMPLETED fired WITHOUT ids
//  (`ids=0` in the logs). That demoted the frontend from exact-id bubble removal
//  to the count fallback and left the user's message pinned at the bottom of the
//  timeline for 20 minutes.
//
//  Invariant pinned here: the timeout may clear the in-flight FLAG (its job), but
//  the batch's message ids must SURVIVE so a late result still names them.
// ═══════════════════════════════════════════════════════════════════

describe('activeProcessing safety timeout — batch ids survive for a late result', () => {
  // White-box on purpose: the regression is one line inside setActiveProcessing's
  // timeout body, and the observable consequence (SESSION_BATCH_COMPLETED carrying
  // ids) is produced by the result handler reading `batchMessageIds` MINUTES later.
  // Driving a >60s real turn would mean a 60s test; asserting the map directly pins
  // the exact invariant the incident violated.
  interface RunnerInternals {
    setActiveProcessing(sessionId: string, batchCount: number, messageIds?: string[]): void
    activeProcessing: Set<string>
    batchCounts: Map<string, number>
    batchMessageIds: Map<string, string[]>
    activeProcessingTimers: Map<string, ReturnType<typeof setTimeout>>
  }

  it('the timeout clears the in-flight flag but KEEPS the batch messageIds', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    const internal = runner as unknown as RunnerInternals;
    const sid = 'timeout-keeps-ids';

    try {
      vi.useFakeTimers();
      internal.setActiveProcessing(sid, 1, ['qm-late-1']);
      // The ledger promise rejects on abortTurn — observe it so the abort below
      // doesn't surface as an unhandled rejection.
      const turn = runner.currentTurn(sid);
      expect(turn).toBeDefined();
      const settled = turn!.then(() => 'resolved').catch(() => 'rejected');

      expect(internal.activeProcessing.has(sid)).toBe(true);
      expect(internal.batchMessageIds.get(sid)).toEqual(['qm-late-1']);

      // Turn outlives 60s (228s in the incident) — the safety timeout fires first.
      await vi.advanceTimersByTimeAsync(60_000);

      // Flag cleared: that IS the timeout's job (unblock routing).
      expect(internal.activeProcessing.has(sid)).toBe(false);
      expect(internal.batchCounts.has(sid)).toBe(false);
      // THE ASSERTION — pre-fix this was deleted, so the late result's
      // SESSION_BATCH_COMPLETED fired with `ids=0` and the frontend fell back to
      // count matching, pinning the user's bubble at the bottom of the timeline.
      expect(internal.batchMessageIds.get(sid)).toEqual(['qm-late-1']);

      expect(await settled).toBe('rejected');
    } finally {
      vi.useRealTimers();
      runner.destroyAndKill();
    }
  });

  it('a later batch overwrites the retained ids (no unbounded staleness)', async () => {
    const runner = useDaemon(new SessionRunner(MOCK_CLI));
    const internal = runner as unknown as RunnerInternals;
    const sid = 'timeout-ids-overwritten';

    try {
      vi.useFakeTimers();
      internal.setActiveProcessing(sid, 1, ['qm-old']);
      const first = runner.currentTurn(sid)!.catch(() => 'rejected');
      await vi.advanceTimersByTimeAsync(60_000);
      await first;
      expect(internal.batchMessageIds.get(sid)).toEqual(['qm-old']);

      // Next batch replaces the entry wholesale — retained ids can never
      // accumulate or leak across turns.
      internal.setActiveProcessing(sid, 2, ['qm-new-a', 'qm-new-b']);
      const second = runner.currentTurn(sid)!.catch(() => 'rejected');
      expect(internal.batchMessageIds.get(sid)).toEqual(['qm-new-a', 'qm-new-b']);
      await vi.advanceTimersByTimeAsync(60_000);
      await second;
    } finally {
      vi.useRealTimers();
      runner.destroyAndKill();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Result-text fallback — the turn answered on `result` alone
//
//  Port of upstream ACP fix #858 (issue #453). A cache-replayed turn can
//  generate zero output tokens and skip streaming entirely: no stream_event
//  deltas, no consolidated `assistant` message, the answer only on `result`.
//  Walnut's UI treats session:result as a pure turn boundary (it never renders
//  the text) and history parsing keeps only user/assistant roles, so that
//  answer was lost in BOTH surfaces — the turn rendered empty.
//
//  The naive check (output_tokens === 0 && result non-empty) double-emits when
//  the answer already streamed, so the guard pairs it with a per-turn
//  "did any main-lane text reach the UI" flag set at the emit sites.
// ═══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession result-text fallback (#858)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj));

  /** A session wired far enough to run handleStreamLine's result case. */
  function makeSession(id: string) {
    const session = useDaemon(new ClaudeCodeSession(`task-${id}`, 'proj', MOCK_CLI));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any)._active = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).claudeSessionId = id;
    const deltas: string[] = [];
    const results: string[] = [];
    bus.subscribe('main-ai', (event: BusEvent) => {
      const d = event.data as { sessionId?: string; delta?: string; result?: string };
      if (d.sessionId !== id) return;
      if (event.name === EventNames.SESSION_TEXT_DELTA) deltas.push(d.delta ?? '');
      if (event.name === EventNames.SESSION_RESULT) results.push(d.result ?? '');
    });
    return { session, deltas, results };
  }

  const resultLine = (id: string, text: string, outputTokens: number, extra: Record<string, unknown> = {}) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: id,
    num_turns: 1,
    usage: { input_tokens: 4, output_tokens: outputTokens },
    ...extra,
  });

  it('forwards the result text when nothing else carried it', () => {
    const id = 'fb-silent';
    const { session, deltas } = makeSession(id);

    // No assistant message, no stream_event — the replayed-turn signature.
    feed(session, resultLine(id, 'The cached answer.', 0));

    // The answer reached the UI stream instead of vanishing.
    expect(deltas.join('')).toContain('The cached answer.');
  });

  it('does NOT re-emit when a consolidated assistant message already delivered it', () => {
    const id = 'fb-assistant';
    const { session, deltas } = makeSession(id);

    feed(session, {
      type: 'assistant',
      message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Streamed answer.' }] },
    });
    // The CLI's result line is a trailing COPY of the same text.
    feed(session, resultLine(id, 'Streamed answer.', 0));

    // Exactly once — the naive output_tokens check double-emits here.
    expect(deltas.filter((d) => d.includes('Streamed answer.')).length).toBe(1);
  });

  it('does NOT re-emit when stream_event deltas already delivered it', () => {
    const id = 'fb-sse';
    const { session, deltas } = makeSession(id);

    feed(session, { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2' } } });
    feed(session, {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SSE answer.' } },
    });
    feed(session, resultLine(id, 'SSE answer.', 0));

    expect(deltas.filter((d) => d.includes('SSE answer.')).length).toBe(1);
  });

  it('does NOT forward when the turn generated output tokens (normal turn)', () => {
    const id = 'fb-tokens';
    const { session, deltas } = makeSession(id);

    // Non-zero output tokens = a real generation, so the result is a trailing
    // copy even if our delta paths somehow saw nothing.
    feed(session, resultLine(id, 'Generated answer.', 128));

    expect(deltas.join('')).not.toContain('Generated answer.');
  });

  it('does NOT forward an error result (already surfaced as the error message)', () => {
    const id = 'fb-error';
    const { session, deltas } = makeSession(id);

    feed(session, resultLine(id, 'API Error: 400 bad request', 0, { is_error: true }));

    expect(deltas.join('')).not.toContain('API Error: 400 bad request');
  });

  it('does NOT forward a task-notification followup (background prose)', () => {
    const id = 'fb-tasknotif';
    const { session, deltas } = makeSession(id);

    // A background followup runs alongside a user turn — its output must never
    // be injected into that turn's feed.
    feed(session, resultLine(id, 'Background agent finished.', 0, { origin: { kind: 'task-notification' } }));

    expect(deltas.join('')).not.toContain('Background agent finished.');
  });

  it('subagent text does not count as the turn answer (fallback still fires)', () => {
    const id = 'fb-subagent';
    const { session, deltas } = makeSession(id);

    // Subagent text lives in its own lane and is never the turn's answer.
    feed(session, {
      type: 'assistant',
      parent_tool_use_id: 'toolu_child',
      message: { id: 'msg_sub', role: 'assistant', content: [{ type: 'text', text: 'child prose' }] },
    });
    feed(session, resultLine(id, 'The real answer.', 0));

    expect(deltas.join('')).toContain('The real answer.');
  });

  it('a turn that streamed does not suppress the NEXT turn fallback', () => {
    const id = 'fb-nextturn';
    const { session, deltas } = makeSession(id);

    // Turn 1: streams normally, result is a trailing copy.
    feed(session, {
      type: 'assistant',
      message: { id: 'msg_t1', role: 'assistant', content: [{ type: 'text', text: 'turn one text' }] },
    });
    feed(session, resultLine(id, 'turn one text', 0));

    // A new init opens turn 2 (the auto-continuation / replay path that resets
    // the per-turn result guard).
    feed(session, { type: 'system', subtype: 'init', session_id: id });

    // Turn 2 is the silent replayed one — its fallback MUST still fire.
    feed(session, resultLine(id, 'turn two cached answer.', 0));

    expect(deltas.join('')).toContain('turn two cached answer.');
    expect(deltas.filter((d) => d.includes('turn one text')).length).toBe(1);
  });

  it('does not forward an empty or whitespace-only result', () => {
    const id = 'fb-empty';
    const { session, deltas } = makeSession(id);

    feed(session, resultLine(id, '   \n  ', 0));

    expect(deltas.join('').trim()).toBe('');
  });

  it('treats a missing usage object as the replay signature', () => {
    const id = 'fb-nousage';
    const { session, deltas } = makeSession(id);

    // Third-party backends have been observed omitting usage fields entirely,
    // and the replay lane was reported from exactly such a backend.
    feed(session, {
      type: 'result', subtype: 'success', is_error: false,
      result: 'Answer with no usage block.', session_id: id, num_turns: 1,
    });

    expect(deltas.join('')).toContain('Answer with no usage block.');
  });
});
