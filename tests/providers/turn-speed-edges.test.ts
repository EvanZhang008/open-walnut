/**
 * The speed meter's less common edges, driven through ClaudeCodeSession's own
 * stream handler on an attached instance (no CLI):
 *
 *   1. a turn walnut did not deliver (the CLI's own session_state_changed
 *      {running}, as for a message injected straight into the daemon's FIFO)
 *      still starts a meter and gets a final readout;
 *   2. a process death mid-turn freezes the readout as interrupted instead of
 *      leaving it live forever;
 *   3. a stream replayed without positional evidence after the turn's result
 *      (old daemon, no watermark) does not feed a finished meter;
 *   4. a subagent's lane (whole assistant/user lines under parent_tool_use_id,
 *      the Agent's tool_result carrying its final answer, task_notification) is
 *      measured as its own row and keeps updating after the turn's result.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import type { SessionTurnSpeed } from '../../src/core/types.js';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs');
let daemon: MockDaemon;

interface Internals {
  _transport: unknown;
  _active: boolean;
  _processStatus: string;
  handleStreamLine(line: string, v?: number): void;
  handleProcessDeath(): void;
  detach(): void;
}

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const ev = (sid: string, event: Record<string, unknown>) => line({ type: 'stream_event', session_id: sid, event });
const state = (sid: string, s: 'running' | 'idle') => line({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: s });
const result = (sid: string, cost = 0.01) => line({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 900, num_turns: 1, result: 'Done',
  session_id: sid, total_cost_usd: cost, usage: { input_tokens: 10, output_tokens: 7 },
});

/** One API message: message_start, a delta, message_delta with the count,
 *  message_stop. `v` undefined streams it with no positional evidence. */
function streamMessage(session: Internals, sid: string, v: number | undefined, tokens: number): number {
  const next = () => (v === undefined ? undefined : v++);
  session.handleStreamLine(ev(sid, { type: 'message_start', message: { id: `m${v ?? 'r'}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1 } } }), next());
  session.handleStreamLine(ev(sid, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello there.' } }), next());
  session.handleStreamLine(ev(sid, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: tokens } }), next());
  session.handleStreamLine(ev(sid, { type: 'message_stop' }), next());
  return v ?? 0;
}

async function attached(sid: string, pid = 4242): Promise<ClaudeCodeSession & Internals> {
  const record = await createSessionRecord(sid, `task-${sid}`, 'proj', '/tmp', { pid, outputFile: '/tmp/nonexistent.jsonl', messageCount: 1 });
  const session = await ClaudeCodeSession.attachToExisting(record, MOCK_CLI, `ws://127.0.0.1:${daemon.port}`) as ClaudeCodeSession & Internals;
  session._transport = {
    isRemote: false, hasPipe: true, processName: 'claude', pid, outputFile: '/tmp/nonexistent.jsonl', host: null,
    fileSize: 0, imageCache: new Map(), lastEventAt: 0, tailOffset: 0,
    stopTail() {}, startTail() {}, detach() {}, deletePipe() {}, flushTail() {},
  };
  session._active = true;
  session._processStatus = 'idle';
  return session;
}

function collectFrames(): SessionTurnSpeed[] {
  const frames: SessionTurnSpeed[] = [];
  bus.subscribe('web-ui', (e: BusEvent) => {
    if (e.name === EventNames.SESSION_TURN_SPEED) frames.push((e.data as { speed: SessionTurnSpeed }).speed);
  });
  return frames;
}

beforeAll(async () => { daemon = await createMockDaemon(); });
afterAll(async () => { await daemon.stop().catch(() => {}); });
beforeEach(async () => {
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true });
});
afterEach(async () => {
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
});

describe('turn speed meter edges', () => {
  it('a turn the CLI announces itself (state running, no writeMessage) is measured end to end', async () => {
    const sid = 'edge-fifo-turn';
    const session = await attached(sid);
    const frames = collectFrames();

    session.handleStreamLine(state(sid, 'running'), 10);
    // The edge itself emits the live turn-start frame.
    expect(frames.at(-1)).toMatchObject({ final: false, messages: 0, outputTokens: 0 });
    const v = streamMessage(session, sid, 11, 7);
    session.handleStreamLine(result(sid), v);

    await vi.waitFor(() => {
      const fin = frames.find((f) => f.final);
      expect(fin).toBeDefined();
      expect(fin).toMatchObject({ outputTokens: 7, turnOutputTokens: 7, messages: 1, model: 'claude-sonnet-5-5', durationMs: 900 });
      expect(fin!.ttftMs).not.toBeNull();
      expect(fin!.interrupted).toBeUndefined();
    });
    session.detach();
  });

  it('a second running edge for the same turn does not restart the meter', async () => {
    const sid = 'edge-double-edge';
    const session = await attached(sid);
    const frames = collectFrames();
    session.handleStreamLine(state(sid, 'running'), 10);
    const startedAt = frames.at(-1)!.startedAt;
    await new Promise((r) => setTimeout(r, 20));
    session.handleStreamLine(state(sid, 'running'), 11);
    expect(frames.at(-1)!.startedAt).toBe(startedAt);
    session.detach();
  });

  it('a process death mid-turn freezes the readout as interrupted', async () => {
    const sid = 'edge-death';
    const session = await attached(sid);
    const frames = collectFrames();
    session.handleStreamLine(state(sid, 'running'), 10);
    session.handleStreamLine(ev(sid, { type: 'message_start', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1 } } }), 11);
    session.handleStreamLine(ev(sid, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half an answ' } }), 12);
    expect(frames.at(-1)!.final).toBe(false);

    session.handleProcessDeath();
    const fin = frames.at(-1)!;
    expect(fin.final).toBe(true);
    expect(fin.interrupted).toBe(true);
    expect(fin.partial).toBe(true);
    // The streamed characters survive as an estimate (12 chars → 3 tokens).
    expect(fin.estimatedTokens).toBe(3);
    expect(fin.messages).toBe(1);
  });

  it('a replay without positions after the result does not reopen a finished meter', async () => {
    const sid = 'edge-replay';
    const session = await attached(sid);
    const frames = collectFrames();
    session.handleStreamLine(state(sid, 'running'), 10);
    const v = streamMessage(session, sid, 11, 7);
    session.handleStreamLine(result(sid), v);
    await vi.waitFor(() => expect(frames.some((f) => f.final)).toBe(true));
    const count = frames.length;

    // The daemon re-streams the turn with no `v` (no positional evidence).
    streamMessage(session, sid, undefined, 7);
    expect(frames.length).toBe(count);
    session.detach();
  });

  it("a subagent's lane is measured from the Agent call, counted by the Agent's result, and a backgrounded one outlives the turn", async () => {
    const sid = 'edge-lane';
    const session = await attached(sid);
    const frames = collectFrames();
    const AGENT = 'toolu_mock_agent';
    const lane = { parent_tool_use_id: AGENT, session_id: sid };
    let v = 10;
    session.handleStreamLine(state(sid, 'running'), v++);
    // Main message 1 ends in an Agent call.
    session.handleStreamLine(ev(sid, { type: 'message_start', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1 } } }), v++);
    session.handleStreamLine(ev(sid, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ask an agent.' } }), v++);
    session.handleStreamLine(line({ type: 'assistant', session_id: sid, message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: AGENT, name: 'Agent', input: { subagent_type: 'Explore', description: 'Find it', prompt: 'x' } }], usage: { input_tokens: 10, output_tokens: 2 } } }), v++);
    session.handleStreamLine(ev(sid, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 12 } }), v++);
    session.handleStreamLine(ev(sid, { type: 'message_stop' }), v++);
    session.handleStreamLine(line({ type: 'system', subtype: 'task_started', session_id: sid, task_id: 't1', tool_use_id: AGENT, description: 'Find it', subagent_type: 'Explore', task_type: 'local_agent', is_backgrounded: true }), v++);
    let f = frames.at(-1)!;
    expect(f.final).toBe(false);
    expect(f.lanes).toHaveLength(1);
    expect(f.lanes![0]).toMatchObject({ id: AGENT, label: 'Explore', status: 'running', messages: 0 });

    // The lane answers (two block lines of one message), gets a tool result, answers again.
    session.handleStreamLine(line({ type: 'assistant', ...lane, message: { id: 'L1', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Looking.' }], usage: { input_tokens: 1, output_tokens: 3 } } }), v++);
    session.handleStreamLine(line({ type: 'assistant', ...lane, message: { id: 'L1', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'tl', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 1, output_tokens: 3 } } }), v++);
    session.handleStreamLine(line({ type: 'user', ...lane, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tl', content: 'a b c' }] } }), v++);
    session.handleStreamLine(line({ type: 'assistant', ...lane, message: { id: 'L2', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Three files, listed with ls.' }], usage: { input_tokens: 1, output_tokens: 2 } } }), v++);
    // The lane's own placeholder usage never counts; the lane's model does. (The
    // tool result's frame is immediate; a lane's message lines share the delta throttle.)
    const live = frames.at(-1)!;
    expect(live.lanes![0]).toMatchObject({ model: 'claude-haiku-5-5', messages: 1, status: 'running' });
    expect(live.lanes![0]!.estimatedTokens).toBeGreaterThan(0);
    const estBefore = live.lanes![0]!.estimatedTokens;

    // Main message 2, then the result: the agent is still running (backgrounded,
    // so the runner does not hold the turn open for it).
    session.handleStreamLine(ev(sid, { type: 'message_start', message: { id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1 } } }), v++);
    session.handleStreamLine(ev(sid, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The agent works on.' } }), v++);
    session.handleStreamLine(ev(sid, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 8 } }), v++);
    session.handleStreamLine(ev(sid, { type: 'message_stop' }), v++);
    session.handleStreamLine(result(sid), v++);
    await vi.waitFor(() => expect(frames.some((x) => x.final)).toBe(true));
    const fin = frames.filter((x) => x.final).at(-1)!;
    expect(fin.lanes![0]).toMatchObject({ status: 'running', messages: 2 });
    expect(fin.model).toBe('claude-opus-5-5');

    // After the result: the Agent's own result (its 40-character answer; the
    // result's usage is a placeholder and is not read) and the notification.
    session.handleStreamLine(line({
      type: 'user', session_id: sid,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: AGENT, content: 'Three files sit in the directory: a b c.' }] },
      tool_use_result: { agentId: 'ag', status: 'completed', resolvedModel: 'global.anthropic.claude-haiku-5-5', totalDurationMs: 4321, totalToolUseCount: 1, usage: { input_tokens: 90, output_tokens: 3 } },
    }), v++);
    session.handleStreamLine(line({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: 't1', tool_use_id: AGENT, status: 'completed' }), v++);
    const after = frames.at(-1)!;
    expect(after.final).toBe(true);
    expect(after.lanes![0]).toMatchObject({ status: 'done', durationMs: 4321, model: 'claude-haiku-5-5', messages: 3 });
    expect(after.lanes![0]!.estimatedTokens).toBeGreaterThan(estBefore + 9);
    expect(after.outputTokens).toBe(20);
    session.detach();
  });
});
