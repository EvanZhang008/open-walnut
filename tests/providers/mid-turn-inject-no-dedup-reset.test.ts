/**
 * REGRESSION: mid-turn FIFO injection must NOT reset stream-dedup state.
 *
 * Incident inc-1783315267620 (2026-07-06): while an assistant message was
 * streaming (SSE text_delta accumulating in _lastEmittedText), the user sent a
 * mid-turn message. injectMidTurn → writeMessage() ran the "fresh turn" reset,
 * wiping _lastEmittedText/_emittedStreamKeys. When the CLI then persisted the
 * final `assistant` JSONL line for the SAME message, the dedup handler saw
 * previousText='' and re-emitted the FULL text — the paragraph rendered twice
 * in the UI (and got cached twice via the stream buffer).
 *
 * The fix: writeMessage() only performs the fresh-turn reset on idle→running.
 * When _processStatus is already 'running' (mid-turn injection), dedup state is
 * preserved; keys are per-msgId so carrying them to end-of-turn is harmless.
 *
 * What's real: ClaudeCodeSession's handleStreamLine pipeline + bus emission.
 * What's mocked: the transport (writeMessage always succeeds; no process).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import type { BusEvent } from '../../src/core/event-bus.js';

// Minimal transport double: FIFO write always succeeds, everything else inert.
function mockTransport() {
  return {
    writeMessage: () => true,
    writeRaw: () => true,
    writeSyntheticUserEvent: () => {},
    deletePipe: () => {},
    kill: () => {},
    stop: async () => {},
    hasPipe: true,
    fileSize: 0,
    pid: 12345,
  };
}

/** Feed a JSONL line into the session's private stream handler. */
function feed(session: ClaudeCodeSession, obj: unknown) {
  (session as unknown as { handleStreamLine(line: string): void }).handleStreamLine(JSON.stringify(obj));
}

function collectTextDeltas(): string[] {
  const deltas: string[] = [];
  bus.subscribe('main-ai', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_TEXT_DELTA) {
      deltas.push((event.data as { delta: string }).delta);
    }
  });
  return deltas;
}

beforeEach(() => { bus.clear(); });
afterEach(() => { bus.clear(); });

describe('mid-turn injection does not reset stream dedup', () => {
  function makeRunningSession(): ClaudeCodeSession {
    const session = new ClaudeCodeSession('task-dedup', 'proj', '/bin/true');
    const s = session as unknown as {
      _transport: unknown; _processStatus: string; _active: boolean; claudeSessionId: string | null;
    };
    s._transport = mockTransport();
    s._processStatus = 'running'; // a turn is live
    s._active = true;
    s.claudeSessionId = 'sess-dedup-1';
    return session;
  }

  const MSG_ID = 'msg_bdrk_dedup_test_001';
  const PARAGRAPH = '你说的是我的记忆文件里还在用 project/<category> 这种描述,对吧?';

  it('SSE deltas + mid-turn writeMessage + final assistant line → paragraph emitted ONCE', async () => {
    const session = makeRunningSession();
    const deltas = collectTextDeltas();

    // 1. SSE: message_start + progressive text deltas for the streaming message
    feed(session, { type: 'stream_event', event: { type: 'message_start', message: { id: MSG_ID } } });
    const half = Math.floor(PARAGRAPH.length / 2);
    feed(session, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: PARAGRAPH.slice(0, half) } } });
    feed(session, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: PARAGRAPH.slice(half) } } });

    // 2. USER SENDS MID-TURN → injectMidTurn → writeMessage while status='running'
    const ok = await session.writeMessage('btw, one more thing');
    expect(ok).toBe(true);

    // 3. CLI persists the final assistant line for the SAME message
    feed(session, { type: 'assistant', message: { id: MSG_ID, role: 'assistant', content: [{ type: 'text', text: PARAGRAPH }] } });

    // The paragraph must appear exactly once across all emitted deltas.
    const joined = deltas.join('');
    const occurrences = joined.split(PARAGRAPH).length - 1;
    expect(occurrences).toBe(1);
  });

  it('idle → writeMessage still performs the fresh-turn reset (new turn baseline)', async () => {
    const session = makeRunningSession();
    const s = session as unknown as { _processStatus: string; _lastEmittedText: Map<string, string> };
    s._processStatus = 'idle'; // between turns
    s._lastEmittedText.set('stale-key', 'stale-value');

    const ok = await session.writeMessage('next turn');
    expect(ok).toBe(true);
    expect(s._lastEmittedText.size).toBe(0); // reset happened
    expect(s._processStatus).toBe('running');
  });

  it('mid-turn injection twice in a row still dedups the final assistant line', async () => {
    const session = makeRunningSession();
    const deltas = collectTextDeltas();

    feed(session, { type: 'stream_event', event: { type: 'message_start', message: { id: MSG_ID } } });
    feed(session, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: PARAGRAPH } } });

    // Two rapid mid-turn injections (matches the incident: 3 sends in 30s)
    await session.writeMessage('first interjection');
    await session.writeMessage('second interjection');

    feed(session, { type: 'assistant', message: { id: MSG_ID, role: 'assistant', content: [{ type: 'text', text: PARAGRAPH }] } });

    const joined = deltas.join('');
    expect(joined.split(PARAGRAPH).length - 1).toBe(1);
  });
});
