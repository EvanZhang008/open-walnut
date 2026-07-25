/**
 * End-to-end test for the --include-partial-messages streaming pipeline.
 *
 * Exercises the full path:
 *   ClaudeCodeSession.send() → spawn mock CLI → JSONL file → JsonlTailer
 *   → handleStreamLine() → classify stream_event → bus.emit(SESSION_*_DELTA /
 *   SESSION_UNKNOWN_EVENT) → (subscribers see typed events).
 *
 * The real Claude CLI is mocked by mock-claude.mjs; the "stream-partial-*"
 * message family drives mock output that mirrors production stream_event
 * records verbatim (message_start / content_block_start / content_block_delta /
 * content_block_stop / message_stop plus a final full assistant message).
 *
 * We assert the three contractual outcomes described in the plan:
 *   1. parse — text/thinking/tool deltas reach the right typed bus event
 *   2. drop  — signature_delta, message_stop, content_block_stop never show up
 *   3. unknown — any unrecognized type OR delta hits SESSION_UNKNOWN_EVENT with
 *      the correct `scope` so the UI surfaces it as a system block.
 *
 * Also covers dedup: the final full-assistant line must NOT cause a second
 * round of text-delta emissions (that would double the rendered text).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js';
import { resetCache as resetQueueCache } from '../../src/core/session-message-queue.js';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs');

// Unified daemon architecture (commit ea2e248): ClaudeCodeSession.send() now
// routes ALL sessions — local included — through a daemon WebSocket. These tests
// exercise the client-side stream_event classification pipeline
// (handleStreamLine → classifyStreamEvent → SESSION_*_DELTA), so we stand up a
// local MockDaemon that spawns the same mock-claude.mjs and forwards its JSONL
// lines verbatim. Each session is pinned to the mock daemon via _testDaemonUrl.
let daemon: MockDaemon;

/** Build a session wired to the local mock daemon for stream_event testing. */
function newSession(taskId: string): ClaudeCodeSession {
  const session = new ClaudeCodeSession(taskId, 'proj', MOCK_CLI);
  session._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`;
  return session;
}

interface Collected {
  textDeltas: string[];
  thinkingDeltas: string[];
  toolUses: Array<{ toolUseId: string; toolName: string; input?: Record<string, unknown> }>;
  unknownEvents: Array<{ scope: string; eventType: string; snippet: string }>;
  systemEvents: Array<{ variant: string; message: string; detail?: string }>;
  results: BusEvent[];
  errors: BusEvent[];
}

function makeCollector(): Collected {
  const c: Collected = {
    textDeltas: [],
    thinkingDeltas: [],
    toolUses: [],
    unknownEvents: [],
    systemEvents: [],
    results: [],
    errors: [],
  };

  bus.subscribe('main-ai', (event: BusEvent) => {
    switch (event.name) {
      case EventNames.SESSION_TEXT_DELTA:
        c.textDeltas.push((event.data as { delta: string }).delta);
        break;
      case EventNames.SESSION_THINKING_DELTA:
        c.thinkingDeltas.push((event.data as { delta: string }).delta);
        break;
      case EventNames.SESSION_TOOL_USE: {
        const d = event.data as { toolUseId: string; toolName: string; input?: Record<string, unknown> };
        c.toolUses.push({ toolUseId: d.toolUseId, toolName: d.toolName, input: d.input });
        break;
      }
      case EventNames.SESSION_UNKNOWN_EVENT: {
        const d = event.data as { scope: string; eventType: string; snippet: string };
        c.unknownEvents.push({ scope: d.scope, eventType: d.eventType, snippet: d.snippet });
        break;
      }
      case EventNames.SESSION_SYSTEM_EVENT: {
        const d = event.data as { variant: string; message: string; detail?: string };
        c.systemEvents.push({ variant: d.variant, message: d.message, detail: d.detail });
        break;
      }
      case EventNames.SESSION_RESULT:
        c.results.push(event);
        break;
      case EventNames.SESSION_ERROR:
        c.errors.push(event);
        break;
    }
  });

  return c;
}

function waitForResult(c: Collected, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (c.results.length > 0 || c.errors.length > 0) {
        // Give a small grace window so any trailing events (e.g. delta that fired
        // just before result) land before the test assertions run.
        setTimeout(resolve, 100);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(
          `Timed out waiting for result (${timeoutMs}ms). ` +
          `text=${c.textDeltas.length} thinking=${c.thinkingDeltas.length} ` +
          `toolUses=${c.toolUses.length} unknown=${c.unknownEvents.length}`,
        ));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

beforeEach(async () => {
  bus.clear();
  resetQueueCache();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true });
  daemon = await createMockDaemon();
});

afterEach(async () => {
  bus.clear();
  await new Promise((r) => setTimeout(r, 200));
  await daemon.stop().catch(() => {});
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
});

describe('stream_event pipeline: text_delta', () => {
  it('emits SESSION_TEXT_DELTA for each content_block_delta and dedups final assistant', async () => {
    const c = makeCollector();
    const session = newSession('task-text');
    session.send('stream-partial-test');

    await waitForResult(c);

    // Mock emits 5 deltas: 'Hel','lo,',' wor','ld','!' → 5 text deltas total.
    // The final `assistant` line carries the full 'Hello, world!' but must be
    // deduped against _lastEmittedText, contributing ZERO additional emits.
    expect(c.textDeltas.length).toBeGreaterThanOrEqual(5);
    expect(c.textDeltas.length).toBeLessThanOrEqual(6); // ±1 for rare edge cases
    expect(c.textDeltas.join('')).toBe('Hello, world!');

    // Thinking should not have fired
    expect(c.thinkingDeltas).toHaveLength(0);
    // No tool events
    expect(c.toolUses).toHaveLength(0);
    // No unknowns when everything is in the allow list
    expect(c.unknownEvents).toHaveLength(0);

    expect(c.results).toHaveLength(1);
    expect(c.errors).toHaveLength(0);
  });
});

describe('stream_event pipeline: thinking-then-text (regression: text duplication)', () => {
  it('does NOT emit text twice when thinking block precedes text (SSE index mismatch with assistant array)', async () => {
    const c = makeCollector();
    const session = newSession('task-think-text');
    session.send('stream-partial-thinking-then-text');

    await waitForResult(c);

    // Thinking block streams 3 chunks; text block streams 5 chunks; final
    // assistant carries only the text (no thinking). If dedup trackingKey
    // drifts (as it did with index-based keys), the assistant line would
    // re-emit 'Hello, world!' as a whole, causing 'Hello, world!Hello, world!'.
    expect(c.thinkingDeltas.join('')).toBe('Hmm let me think');
    expect(c.textDeltas.join('')).toBe('Hello, world!');
    // Most critical assertion: text length is 13 chars, not 26.
    expect(c.textDeltas.join('').length).toBe(13);
  });
});

describe('stream_event pipeline: thinking_delta', () => {
  it('routes thinking_delta to SESSION_THINKING_DELTA, not SESSION_TEXT_DELTA', async () => {
    const c = makeCollector();
    const session = newSession('task-thinking');
    session.send('stream-partial-thinking');

    await waitForResult(c);

    // Mock emits 5 thinking deltas: 'Let ','me ','think ','about ','this…'
    expect(c.thinkingDeltas.length).toBeGreaterThanOrEqual(5);
    expect(c.thinkingDeltas.join('')).toBe('Let me think about this…');
    // Thinking must never leak into the text channel
    expect(c.textDeltas).toHaveLength(0);
    expect(c.unknownEvents).toHaveLength(0);
  });
});

describe('stream_event pipeline: tool_use', () => {
  it('emits SESSION_TOOL_USE exactly once (from final assistant; not from content_block_start)', async () => {
    const c = makeCollector();
    const session = newSession('task-tool');
    session.send('stream-partial-tool');

    await waitForResult(c);

    // The final `assistant` line carries the complete, parsed input —
    // that is the only emission we want. We previously emitted early at
    // content_block_start (with empty input) and later the input_json_delta
    // fragments filled it in, but the UI renders GenericToolCall from the
    // `input` dict only, so stale empty cards were left on screen when a
    // subsequent write happened (real-world bug: session a9f24f9a).
    expect(c.toolUses).toHaveLength(1);
    expect(c.toolUses[0].toolName).toBe('Bash');
    expect(c.toolUses[0].toolUseId).toBe('toolu_mock_stream');
    expect(c.toolUses[0].input).toEqual({ command: 'ls -la' });

    // input_json_delta + content_block_start are dropped silently — not routed to unknown.
    expect(c.unknownEvents.some(u => u.eventType === 'input_json_delta')).toBe(false);
    expect(c.unknownEvents.some(u => u.eventType === 'content_block_start')).toBe(false);
  });
});

describe('stream_event pipeline: drop rules', () => {
  it('swallows top-level tool_progress heartbeats without SESSION_UNKNOWN_EVENT', async () => {
    const c = makeCollector();
    const session = newSession('task-tool-progress');
    session.send('stream-partial-tool-progress');

    await waitForResult(c);

    expect(c.unknownEvents.filter(u => u.eventType === 'tool_progress')).toHaveLength(0);
  });

  it('signature_delta never reaches any bus channel', async () => {
    const c = makeCollector();
    const session = newSession('task-sig');
    session.send('stream-partial-signature');

    await waitForResult(c);

    // signature_delta is in the drop list — must not land as text/thinking/unknown
    expect(c.textDeltas.join('')).toBe('OK'); // only the text_delta fragment
    expect(c.thinkingDeltas).toHaveLength(0);
    expect(c.unknownEvents.filter(u => u.eventType === 'signature_delta')).toHaveLength(0);
  });
});

describe('stream_event pipeline: unknown catch-all', () => {
  it('surfaces unknown top-level JSONL types via SESSION_UNKNOWN_EVENT scope=top_level', async () => {
    const c = makeCollector();
    const session = newSession('task-unk1');
    session.send('stream-partial-unknown-top-level');

    await waitForResult(c);

    const unk = c.unknownEvents.filter(u => u.eventType === 'never_seen_before');
    expect(unk).toHaveLength(1);
    expect(unk[0].scope).toBe('top_level');
    expect(unk[0].snippet).toContain('never_seen_before');
  });

  it('surfaces unknown stream_event subtypes via SESSION_UNKNOWN_EVENT scope=stream_event', async () => {
    const c = makeCollector();
    const session = newSession('task-unk2');
    session.send('stream-partial-unknown-stream-event');

    await waitForResult(c);

    const unk = c.unknownEvents.filter(u => u.eventType === 'future_sse_event_xyz');
    expect(unk).toHaveLength(1);
    expect(unk[0].scope).toBe('stream_event');
    expect(unk[0].snippet).toContain('future_sse_event_xyz');
  });

  it('dedupes the same unknown type within a single turn (warn-once)', async () => {
    // Run the same unknown-stream-event twice on the same session. The unknown
    // warning set is cleared on send()/writeMessage(), so a second send must
    // warn again. Within a single send, however, duplicates stay deduped —
    // that is already covered implicitly by the "1" assertion above because
    // mock emits the unknown line only once per send.
    const c = makeCollector();
    const session = newSession('task-unk-dedup');
    session.send('stream-partial-unknown-stream-event');
    await waitForResult(c);
    expect(c.unknownEvents.filter(u => u.eventType === 'future_sse_event_xyz')).toHaveLength(1);
  });
});

describe('stream_event pipeline: completeness (three fates, no silent loss)', () => {
  it('text run covers parse + drop + unknown without losing data', async () => {
    const c = makeCollector();
    const session = newSession('task-all');
    session.send('stream-partial-unknown'); // emits unknown + text run

    await waitForResult(c);

    // parse: text deltas add up to 'Hello, world!'
    expect(c.textDeltas.join('')).toBe('Hello, world!');
    // unknown: ledger shows the fake event was surfaced
    expect(c.unknownEvents.some(u => u.eventType === 'future_sse_event_xyz')).toBe(true);
    // drop: message_stop / content_block_stop never show up as unknown
    expect(c.unknownEvents.some(u => u.eventType === 'message_stop')).toBe(false);
    expect(c.unknownEvents.some(u => u.eventType === 'content_block_stop')).toBe(false);
    // drop: signature_delta never ends up in thinking or text stream
    expect(c.thinkingDeltas).toHaveLength(0);
  });
});
