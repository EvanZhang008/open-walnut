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

import { ClaudeCodeSession, SessionRunner, shellQuote, buildRemoteCommand } from '../../src/providers/claude-code-session.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import type { BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js';
import { enqueueMessage, resetCache as resetQueueCache } from '../../src/core/session-message-queue.js';

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

  it('no mode = no --permission-mode flag in CLI args', async () => {
    const collected = collectEvents();
    const session = new ClaudeCodeSession('task-default', 'proj', MOCK_CLI);
    session.send('default mode test');

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { result: string };
    // Result should NOT contain any permission-mode marker
    expect(rd.result).not.toContain('[permission-mode:');
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

  it('no mode in session:start = no permission flag in result', async () => {
    const collected = collectEvents();

    bus.emit(EventNames.SESSION_START, {
      taskId: 'no-mode-task',
      message: 'no mode via runner',
      project: 'test-proj',
    }, ['session-runner'], { source: 'test' });

    const result = await waitForResult(collected);
    expect(result.name).toBe(EventNames.SESSION_RESULT);
    const rd = result.data as { result: string };
    expect(rd.result).not.toContain('[permission-mode:');
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
  it('handleStart builds context and passes appendSystemPrompt to session', async () => {
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

    expect(rd.result).toContain('[has-system-prompt]');
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
    // server_safety block is always appended, so system prompt is always present
    expect(rd.result).toContain('[has-system-prompt]');

    runner.destroyAndKill();
  });
});

// ══════════════════════════════════════════════════════════════════
//  Layer 7: attachToExisting (reconnection)
// ══════════════════════════════════════════════════════════════════

describe('ClaudeCodeSession.attachToExisting', () => {
  it('creates a session from a SessionRecord without spawning', () => {
    const session = ClaudeCodeSession.attachToExisting({
      claudeSessionId: 'test-session-id',
      taskId: 'task-123',
      project: 'proj',
      process_status: 'running',
      work_status: 'in_progress',
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

  it('restores host field from SessionRecord', () => {
    const session = ClaudeCodeSession.attachToExisting({
      claudeSessionId: 'ssh-session-id',
      taskId: 'task-ssh',
      project: 'proj',
      process_status: 'running',
      work_status: 'in_progress',
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

  it('host is null when not in SessionRecord', () => {
    const session = ClaudeCodeSession.attachToExisting({
      claudeSessionId: 'local-session-id',
      taskId: 'task-local',
      project: 'proj',
      process_status: 'running',
      work_status: 'in_progress',
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
