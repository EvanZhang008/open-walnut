/**
 * session-cache folds a run of main-lane deltas once, and the result is exactly
 * what folding each delta gave.
 *
 * The cache used to fold every text and thinking delta into its blocks (a copy
 * of the whole array and a new block each time, about 20 times a second while a
 * session streams). It now buffers a run of same-kind, same-message deltas and
 * folds it when anything else happens to the session or the state is read
 * (web/src/cache/session-cache.ts bufferMainDelta / settle). The equivalence
 * check replays seeded random streams against the old per-delta fold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { wsListeners, mockOnEvent, reducerCalls } = vi.hoisted(() => {
  const wsListeners = new Map<string, Set<(data: unknown) => void>>();
  const mockOnEvent = vi.fn((name: string, cb: (data: unknown) => void) => {
    let set = wsListeners.get(name);
    if (!set) { set = new Set(); wsListeners.set(name, set); }
    set.add(cb);
  });
  return { wsListeners, mockOnEvent, reducerCalls: { thinking: 0, text: 0 } };
});

vi.mock('@/api/ws', () => ({ wsClient: { onEvent: mockOnEvent, sendRpc: vi.fn() } }));
vi.mock('@/api/sessions', () => ({ fetchSessionHistory: vi.fn(), HISTORY_TAIL_LIMIT: 400 }));
vi.mock('@/api/chat', () => ({ isToolResultError: (r: string | undefined) => !!r && r.startsWith('Error:') }));
vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/stream/stream-reducer', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/stream/stream-reducer')>();
  return {
    ...real,
    appendMainThinking: (...args: Parameters<typeof real.appendMainThinking>) => { reducerCalls.thinking++; return real.appendMainThinking(...args); },
    applyMainTextDelta: (...args: Parameters<typeof real.applyMainTextDelta>) => { reducerCalls.text++; return real.applyMainTextDelta(...args); },
  };
});

import { trackSession, getStreamState, __resetForTesting } from '@/cache/session-cache';
import * as R from '@/stream/stream-reducer';
import type { StreamingBlock } from '@/stream/stream-reducer';

const SID = 'sid-batch-0000-0000-000000000000';

function fire(name: string, data: Record<string, unknown>): void {
  for (const cb of wsListeners.get(name) ?? []) cb({ sessionId: SID, ...data });
}

type Ev = { name: string; data: Record<string, unknown> };

/** The cache's handlers as they were, one delta at a time: the reference. */
function referenceFold(events: Ev[]) {
  let blocks: StreamingBlock[] = [];
  let textBuffer = '';
  let completedLen = 0;
  const interrupt = () => {
    const msgId = R.lastMainLaneText(blocks, completedLen)?.msgId;
    const r = R.flushMainTextForInterrupt(blocks, textBuffer, msgId, completedLen);
    blocks = r.blocks;
    textBuffer = r.carry;
  };
  for (const { name, data: d } of events) {
    const msgId = d.msgId as string | undefined;
    const lane = d.parentToolUseId as string | undefined;
    if (name === 'session:text-delta') {
      if (lane) blocks = R.appendLaneText(blocks, { delta: d.delta as string, msgId, parentToolUseId: lane });
      else { const n = R.applyMainTextDelta(blocks, textBuffer, d.delta as string, msgId, completedLen); blocks = n.blocks; textBuffer = n.textBuffer; }
    } else if (name === 'session:thinking-delta') {
      if (lane) blocks = R.appendLaneThinking(blocks, { delta: d.delta as string, msgId, parentToolUseId: lane });
      else blocks = R.appendMainThinking(blocks, d.delta as string, msgId, completedLen);
    } else if (name === 'session:tool-use') {
      if (!lane) interrupt();
      blocks = R.appendToolCall(blocks, { toolUseId: d.toolUseId as string, toolName: d.toolName as string, input: d.input as Record<string, unknown> | undefined, parentToolUseId: lane });
    } else if (name === 'session:tool-result') {
      blocks = R.backfillToolResult(blocks, d.toolUseId as string, d.result as string, false);
    } else if (name === 'session:user-line') {
      interrupt();
      blocks = R.appendUserLineBlock(blocks, d.uuid as string);
    } else if (name === 'session:result') {
      blocks = R.flushMainTextBuffer(blocks, textBuffer, completedLen);
      textBuffer = '';
      completedLen = blocks.length;
    }
  }
  return { blocks, textBuffer, completedLen };
}

/** A seeded stream: runs of deltas across messages, lanes, tools, takes, turn ends. */
function randomStream(seed: number, length: number): Ev[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const events: Ev[] = [];
  let msg = 0;
  let tool = 0;
  for (let i = 0; i < length; i++) {
    const r = rnd();
    if (r < 0.05) msg++;
    const msgId = rnd() < 0.1 ? undefined : `m${msg}`;
    const lane = rnd() < 0.08 ? pick(['laneA', 'laneB']) : undefined;
    const delta = pick(['the ', 'reason ', 'so\n', '<div style="', 'x">', 'next ', 'été ']);
    if (r < 0.45) events.push({ name: 'session:thinking-delta', data: { delta, msgId, parentToolUseId: lane } });
    else if (r < 0.85) events.push({ name: 'session:text-delta', data: { delta, msgId, parentToolUseId: lane } });
    else if (r < 0.92) {
      const id = `t${tool++}`;
      events.push({ name: 'session:tool-use', data: { toolUseId: id, toolName: 'Bash', parentToolUseId: lane } });
      if (rnd() < 0.7) events.push({ name: 'session:tool-result', data: { toolUseId: id, result: 'ok' } });
    } else if (r < 0.96) events.push({ name: 'session:user-line', data: { uuid: `u${i}` } });
    else events.push({ name: 'session:result', data: {} });
  }
  return events;
}

describe('session-cache delta batching', () => {
  beforeEach(() => {
    __resetForTesting();
    reducerCalls.thinking = 0;
    reducerCalls.text = 0;
    trackSession(SID);
  });

  it('folds 300 thinking deltas of one message once', () => {
    let all = '';
    for (let i = 0; i < 300; i++) {
      const delta = `step ${i} `;
      all += delta;
      fire('session:thinking-delta', { delta, msgId: 'm1' });
    }
    expect(reducerCalls.thinking).toBe(0);
    const state = getStreamState(SID)!;
    expect(reducerCalls.thinking).toBe(1);
    expect(state.blocks).toEqual([{ type: 'thinking', content: all, msgId: 'm1' }]);
  });

  it('folds 300 text deltas of one message once, with the accumulator in step', () => {
    for (let i = 0; i < 300; i++) fire('session:text-delta', { delta: 'w ', msgId: 'm1' });
    const state = getStreamState(SID)!;
    expect(reducerCalls.text).toBe(1);
    expect(state.blocks).toEqual([{ type: 'text', content: 'w '.repeat(300), msgId: 'm1' }]);
    expect(state.textBuffer).toBe('w '.repeat(300));
  });

  it('lands a message\'s reasoning before the tool call it led to', () => {
    fire('session:thinking-delta', { delta: 'look at ', msgId: 'm1' });
    fire('session:thinking-delta', { delta: 'the file', msgId: 'm1' });
    fire('session:tool-use', { toolUseId: 't1', toolName: 'Read', input: {} });
    const types = getStreamState(SID)!.blocks.map((b) => b.type);
    expect(types).toEqual(['thinking', 'tool_call']);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])('equals the per-delta fold on random stream %i', (seed) => {
    const events = randomStream(seed, 600);
    for (const e of events) fire(e.name, e.data);
    const ref = referenceFold(events);
    const state = getStreamState(SID)!;
    expect(state.blocks).toEqual(ref.blocks);
    expect(state.textBuffer).toBe(ref.textBuffer);
    expect(state.completedLen).toBe(ref.completedLen);
  });

  it('equals the per-delta fold when the state is read in the middle of a run', () => {
    const events = randomStream(99, 400);
    events.forEach((e, i) => {
      fire(e.name, e.data);
      if (i % 37 === 0) getStreamState(SID);
    });
    const ref = referenceFold(events);
    expect(getStreamState(SID)!.blocks).toEqual(ref.blocks);
  });
});
