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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

// ── Mock constants (isolate file I/O to temp dir) ──
vi.mock('../../src/constants.js', () => createMockConstants());

import { ClaudeCodeSession, SessionRunner, shellQuote, buildRemoteCommand, outputFileCheckResult } from '../../src/providers/claude-code-session.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import type { BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js';
import { enqueueMessage, getQueue, markProcessing, resetCache as resetQueueCache } from '../../src/core/session-message-queue.js';
import fs from 'node:fs';

// Retrieve the actual tmpBase from the mocked module (single source of truth)
const tmpBase = WALNUT_HOME;

// Use mock CLI directly — it has #!/usr/bin/env node shebang and is executable.
const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs');

beforeEach(async () => {
  // Clear all bus subscribers to prevent stale handlers from prior tests
  bus.clear();
  resetQueueCache();

  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  // SESSION_STREAMS_DIR is created by send() automatically via mkdirSync,
  // but create it here too for tests that check the dir directly.
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true });
});

afterEach(async () => {
  // Clear all bus subscribers to stop receiving events
  bus.clear();

  // Allow fire-and-forget operations (persistSessionRecord, etc.) to settle
  await new Promise((r) => setTimeout(r, 200));
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
    const session = new ClaudeCodeSession('task-1', 'test-project', MOCK_CLI);

    expect(session.active).toBe(false);

    session.send('hello world');
    expect(session.active).toBe(true);

    // For new sessions, session ID is null until response arrives
    expect(session.sessionId).toBeNull();

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
    const session = new ClaudeCodeSession('task-file', 'proj', MOCK_CLI);
    session.send('file test');

    await waitForResult(collected);

    // Output file should have been created (and renamed to session ID)
    expect(session.outputFile).toBeTruthy();
    expect(session.outputFile!.endsWith('.jsonl')).toBe(true);
  });

  it('stores PID of spawned process', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-pid', 'proj', MOCK_CLI);
    session.send('pid test');

    // PID should be set immediately after send
    expect(session.processPid).toBeGreaterThan(0);

    await waitForResult(collected);
  });

  it('generates unique session ID per send (from response)', async () => {
    const collected = collectEvents();
    const session1 = new ClaudeCodeSession('task-a', 'proj', MOCK_CLI);
    const session2 = new ClaudeCodeSession('task-b', 'proj', MOCK_CLI);

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
    const session = new ClaudeCodeSession('task-err', 'proj', '/nonexistent/binary');
    session.send('this should fail');

    const event = await waitForResult(collected);
    expect(event.name).toBe(EventNames.SESSION_ERROR);
    expect((event.data as { error: string }).error).toBeDefined();
  });

  it('emits SESSION_ERROR when CLI exits with non-zero code', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-exit-err', 'proj', MOCK_CLI);
    session.send('error'); // Mock exits code 1 for "error"

    const event = await waitForResult(collected);
    expect(event.name).toBe(EventNames.SESSION_ERROR);
  });

  it('handles CLI outputting invalid JSONL gracefully (skips bad lines)', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-parse-err', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-kill', 'proj', MOCK_CLI);
    session.send('hello');
    await new Promise((r) => setTimeout(r, 50));
    session.kill();
    expect(session.active).toBe(false);
  });

  it('detach() stops monitoring without killing', async () => {
    const session = new ClaudeCodeSession('task-detach', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-resume', 'proj', MOCK_CLI);
    session.send('continue working', undefined, 'existing-session-123');

    // Session ID pre-set for resume
    expect(session.sessionId).toBe('existing-session-123');

    const result = await waitForResult(collected);
    expect((result.data as { sessionId: string }).sessionId).toBeDefined();
  });

  it('mode "plan" passes --permission-mode plan to CLI', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-plan', 'proj', MOCK_CLI);
    session.send('plan mode test', undefined, undefined, 'plan');

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[permission-mode:plan]');
  });

  it('mode "bypass" passes --permission-mode bypassPermissions to CLI', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-bypass', 'proj', MOCK_CLI);
    session.send('bypass mode test', undefined, undefined, 'bypass');

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[permission-mode:bypassPermissions]');
  });

  it('no mode defaults to bypassPermissions', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-default', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-cwd', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-no-cwd', 'proj', MOCK_CLI);
    session.send('no cwd test');

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);

    // Without explicit cwd, the mock CLI should inherit process.cwd()
    const rd = result.data as { result: string };
    expect(rd.result).toContain(`[cwd:${process.cwd()}]`);
  });

  it('stdin is closed — session completes without stdin input', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-stdin', 'proj', MOCK_CLI);
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

  // COVERAGE NOTE: with no local daemon running in the test env, the delivery
  // failure surfaces inside processNext (createSessionManager throws "Local
  // daemon not running") and is caught by processNext's own catch block — that
  // is the path these unit tests exercise. The sibling async path
  // (send()'s onSpawnSettled(false) → settleResumeFailure, where the SSH deploy
  // rejects AFTER send() returns) is the one that historically double-emitted
  // SESSION_ERROR; it is covered end-to-end by the ephemeral attach-only E2E
  // (log proof: "resume spawn failed — reverting batch to pending"). Both paths
  // now emit errorKind:'delivery_failed' and revert-to-pending identically.
  beforeEach(() => {
    runner = new SessionRunner('/nonexistent/claude-binary-for-loop-test');
    runner.init();
  });

  afterEach(() => {
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

    // Give the failure path time to settle — and time for a loop to manifest
    // if the regression came back (the old loop cycled every ~500ms).
    await new Promise((r) => setTimeout(r, 3000));

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
    await new Promise((r) => setTimeout(r, 1500));
    expect(batchFailed.length).toBe(1);

    // User-initiated retry = a NEW session:send → another single attempt
    bus.emit(EventNames.SESSION_SEND, { sessionId, message: 'first try' }, ['session-runner'], { source: 'test' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(batchFailed.length).toBe(2);

    // Still exactly one pending message — no duplication, no loss
    const queue = await getQueue(sessionId);
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('pending');
  }, 20_000);

  // The ASYNC spawn-settle failure path (send() returns, then the spawn rejects
  // later → onSpawnSettled(false) → settleResumeFailure) is the one that
  // regressed on 2026-06-10 (double SESSION_ERROR emit + stopped-status leak).
  // It can't be reached in this unit env: send() throws SYNCHRONOUSLY at
  // createSessionManager ("Local daemon not running") before any spawn is
  // attempted, so onSpawnSettled never fires. The path is covered end-to-end by
  // the ephemeral attach-only E2E (log proof: a single "resume spawn failed —
  // reverting batch to pending" per send, message stays 'pending', one chat
  // notification). The invariants it guards are asserted structurally here
  // instead: settleResumeFailure emits exactly one SESSION_ERROR with
  // errorKind:'delivery_failed' to ['main-ai'] (no 'session-runner' re-entry →
  // no loop), and the send()-catch's terminal status/second-emit are gated on
  // `!onSpawnSettled` (verified by reading the source — see the
  // `if (!onSpawnSettled)` block in send()).
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
    runner = new SessionRunner(MOCK_CLI);
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

    runner = new SessionRunner(MOCK_CLI);
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
    expect(ours!.process_status).toBe('running');
    expect(ours!.project).toBe('Walnut');
    expect(ours!.claudeSessionId).toBeTruthy();
    // Detached mode persists PID and output file
    expect(ours!.pid).toBeGreaterThan(0);
    expect(ours!.outputFile).toBeTruthy();
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

    bus.emit(EventNames.SESSION_START, {
      taskId: 'e2e-task-001',
      message: 'link test',
      project: 'Walnut',
    }, ['session-runner'], { source: 'test' });

    await waitForResult(collected);

    // Give fire-and-forget persistence (dynamic import + file write) time to complete
    await new Promise((r) => setTimeout(r, 500));

    const { getTask } = await import('../../src/core/task-manager.js');
    const task = await getTask('e2e-task-001');
    // Session should be linked to exec slot (non-plan mode)
    expect(task.exec_session_id).toBeTruthy();
    expect(task.session_ids).toContain(task.exec_session_id);
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
    const session = new ClaudeCodeSession('task-stream', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-tool', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-init', 'proj', MOCK_CLI);
    session.send('init test');

    await waitForResult(collected);

    expect(session.sessionId).toBeTruthy();
    expect(collected.textDeltas.length).toBeGreaterThan(0);
    const delta = collected.textDeltas[0].data as { sessionId: string };
    expect(delta.sessionId).toBe(session.sessionId);
  });

  it('text deltas are accumulated into the final result', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-accum', 'proj', MOCK_CLI);
    session.send('accumulation test');

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };

    expect(rd.result).toContain('accumulation test');

    const allDeltas = collected.textDeltas.map((e) => (e.data as { delta: string }).delta).join('');
    expect(rd.result).toBe(allDeltas);
  });

  it('streaming events are broadcast to all subscribers', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-broadcast', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-sysprompt', 'proj', MOCK_CLI);
    session.send('hello', undefined, undefined, undefined, undefined, 'You are a helpful bot');

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[has-system-prompt]');
  });

  it('omits flag when appendSystemPrompt is undefined', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-no-sysprompt', 'proj', MOCK_CLI);
    session.send('hello');

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };
    expect(rd.result).not.toContain('[has-system-prompt]');
  });

  it('works combined with permission mode', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-combo', 'proj', MOCK_CLI);
    session.send('combo test', undefined, undefined, 'plan', undefined, 'You are a planner');

    const result = await waitForResult(collected);
    const rd = result.data as { result: string };
    expect(rd.result).toContain('[permission-mode:plan]');
    expect(rd.result).toContain('[has-system-prompt]');
  });

  it('message is always last arg regardless of flags', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-order', 'proj', MOCK_CLI);
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
    const runner = new SessionRunner(MOCK_CLI);
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
    const runner = new SessionRunner(MOCK_CLI);
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
    });

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
    });

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
    });

    expect(session.host).toBeNull();

    session.detach();
  });
});

// ══════════════════════════════════════════════════════════════════
//  Layer 7b: isSessionStillAlive (rehydrate decision)
// ══════════════════════════════════════════════════════════════════

describe('SessionRunner.isSessionStillAlive', () => {
  it('returns true for a local record whose PID is the current process', async () => {
    const runner = new SessionRunner(MOCK_CLI);
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
    const runner = new SessionRunner(MOCK_CLI);
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
    const runner = new SessionRunner(MOCK_CLI);
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
//  Layer 8: SSH helpers — shellQuote + buildRemoteCommand
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

describe('buildRemoteCommand', () => {
  it('builds command without cwd', () => {
    const result = buildRemoteCommand(['-p', '--output-format', 'stream-json', '--verbose', 'hello world']);
    expect(result).toContain("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude '-p' '--output-format' 'stream-json' '--verbose' 'hello world'");
    expect(result).toContain('$HOME/.local/bin');
  });

  it('prepends cd when cwd is provided', () => {
    const result = buildRemoteCommand(['-p', 'test msg'], '/home/user/project');
    expect(result).toContain("cd '/home/user/project' &&");
    expect(result).toContain("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude '-p' 'test msg'");
  });

  it('quotes cwd with special characters', () => {
    const result = buildRemoteCommand(['-p', 'msg'], "/home/user/my project's dir");
    expect(result).toContain("cd '/home/user/my project'\\''s dir'");
  });

  it('includes CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 in the command', () => {
    const result = buildRemoteCommand(['-p', 'msg']);
    expect(result).toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1');
  });

  it('shell-quotes all arguments for safety', () => {
    const result = buildRemoteCommand(['-p', '--resume', 'session-id; rm -rf /']);
    // The dangerous argument should be safely quoted
    expect(result).toContain("'session-id; rm -rf /'");
  });
});

// ══════════════════════════════════════════════════════════════════
//  Layer 9: SSH session — host field on send()
// ══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession SSH host', () => {
  it('stores host key when provided to send()', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-ssh-host', 'proj', MOCK_CLI);

    // send() with host but no sshTarget will just store the host key
    // and spawn locally (since sshTarget is not provided, it uses local spawn)
    session.send('test message', tmpBase, undefined, undefined, undefined, undefined, 'remote-dev');
    expect(session.host).toBe('remote-dev');

    await waitForResult(collected);
  });

  it('host is null when not provided to send()', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-no-host', 'proj', MOCK_CLI);
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
  afterEach(() => {
    delete process.env.MOCK_REPLAY_COUNT;
  });

  // C1–C3: parameterized text replay (2x, 4x, 8x)
  for (const replayCount of [2, 4, 8]) {
    it(`C1-C3: ${replayCount}x text replay → exactly 1 text delta`, async () => {
      process.env.MOCK_REPLAY_COUNT = String(replayCount);
      const collected = collectEvents();
      const session = new ClaudeCodeSession(`task-replay-${replayCount}x`, 'proj', MOCK_REPLAY_CLI);
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
    const session = new ClaudeCodeSession('task-replay-tool', 'proj', MOCK_REPLAY_CLI);
    session.send('tool-test');

    await waitForResult(collected);

    expect(collected.toolUses).toHaveLength(1);
    expect(collected.toolUses[0].data.toolUseId).toBe('toolu_mock_001');
  });

  it('C5: 4x mixed content → textDeltas=2 (pre-tool + post-tool), toolUses=1', async () => {
    process.env.MOCK_REPLAY_COUNT = '4';
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-replay-mixed', 'proj', MOCK_REPLAY_CLI);
    session.send('tool-test');

    await waitForResult(collected);

    // Pre-tool text ("Let me read that file.") + post-tool text ("Processed: tool-test")
    expect(collected.textDeltas).toHaveLength(2);
    expect(collected.toolUses).toHaveLength(1);
  });

  it('C6: different texts in same message are NOT deduped', async () => {
    process.env.MOCK_REPLAY_COUNT = '2';
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-replay-twotexts', 'proj', MOCK_REPLAY_CLI);
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
    const session = new ClaudeCodeSession('task-replay-fulltext', 'proj', MOCK_REPLAY_CLI);
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
    const session = new ClaudeCodeSession('task-btw', 'proj', MOCK_CLI);
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
});

// ═══════════════════════════════════════════════════════════════════
//  applyEffort — mid-session reasoning-effort change via the
//  apply_flag_settings control_request (OUTBOUND ack, no respawn).
//  Same transport/feed harness as askSideQuestion above; the ack
//  branch is checked BEFORE the side-question branch in the handler.
// ═══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession.applyEffort', () => {
  function makeSessionWithStubTransport() {
    const session = new ClaudeCodeSession('task-eff', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-eff-dead', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-mdl', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-mdl-dead', 'proj', MOCK_CLI);
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

describe('ClaudeCodeSession.applyPermissionMode', () => {
  function makeSessionWithStubTransport() {
    const session = new ClaudeCodeSession('task-pmode', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-pmode-dead', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-reads', 'proj', MOCK_CLI);
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
    const session = new ClaudeCodeSession('task-gs', 'proj', MOCK_CLI);
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

  it('resolves the applied block (model + true effort) from the nested response', async () => {
    const { session, writes } = makeSessionWithStubTransport();
    const promise = session.getSettings();
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
          effective: { effortLevel: 'xhigh' },   // disk value — NOT what we read
          applied: { model: 'claude-opus-4-8', effort: 'high', ultracode: false }, // env override → high
        },
      },
    });
    await expect(promise).resolves.toEqual({ model: 'claude-opus-4-8', effort: 'high', ultracode: false });
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
    const session = new ClaudeCodeSession('task-gs-dead', 'proj', MOCK_CLI);
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
});
