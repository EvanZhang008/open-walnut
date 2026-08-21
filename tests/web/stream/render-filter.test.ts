/**
 * Tests for web/src/stream/render-filter.ts — the non-destructive absorption
 * core of the single-timeline model.
 *
 * Semantics carried over from the destructive promote-blocks era (its tests
 * pin the matching rules; these pin the FILTER policy on top):
 *  · absorbed = hidden, never deleted — late history means brief double-render
 *  · live tail (last main-lane block while streaming) is never hidden
 *  · watermark bounds content matching; ids match at any scope
 *  · reset only when EVERYTHING is absorbed and no turn is live
 */
import { describe, it, expect } from 'vitest';
import { computeHiddenBlocks, allBlocksAbsorbed } from '@/stream/render-filter';
import type { StreamingBlock } from '@/stream/stream-reducer';
import type { SessionHistoryMessage } from '@/types/session';

const text = (content: string, msgId?: string, parentToolUseId?: string): StreamingBlock => ({
  type: 'text', content, ...(msgId ? { msgId } : {}), ...(parentToolUseId ? { parentToolUseId } : {}),
});
const toolCall = (toolUseId: string, opts?: { parentToolUseId?: string }): StreamingBlock => ({
  type: 'tool_call', toolUseId, name: 'Bash', status: 'done',
  ...(opts?.parentToolUseId ? { parentToolUseId: opts.parentToolUseId } : {}),
});
const msg = (over: Partial<SessionHistoryMessage>): SessionHistoryMessage =>
  ({ role: 'assistant', text: '', timestamp: '', ...over }) as SessionHistoryMessage;

describe('computeHiddenBlocks — absorption proof', () => {
  it('hides a text block whose msgId exists in history (any scope — id is watermark-immune)', () => {
    const blocks = [text('answer', 'msg-1')];
    const messages = [msg({ text: 'answer (rewritten)', msgId: 'msg-1' })];
    // watermark PAST the message: id evidence must still match
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 5, isStreaming: false });
    expect(hidden.has(0)).toBe(true);
  });

  it('hides an id-less text block only via content within the watermark window', () => {
    const blocks = [text('same text')];
    const oldOnly = [msg({ text: 'same text' })];
    // Twin sits BEFORE the watermark → old history must not claim a new block
    expect(computeHiddenBlocks({ blocks, messages: oldOnly, watermark: 1, isStreaming: false }).size).toBe(0);
    // Twin inside the window → hidden
    expect(computeHiddenBlocks({ blocks, messages: oldOnly, watermark: 0, isStreaming: false }).has(0)).toBe(true);
  });

  it('hides tool calls by toolUseId including tools moved into childMessages', () => {
    const blocks = [toolCall('tu-1'), toolCall('tu-sub', { parentToolUseId: 'tu-1' })];
    const messages = [msg({
      tools: [{ name: 'Agent', toolUseId: 'tu-1', input: {}, childMessages: [
        msg({ tools: [{ name: 'Bash', toolUseId: 'tu-sub', input: {} }] }),
      ] }],
    } as Partial<SessionHistoryMessage>)];
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: false });
    expect(hidden.has(0)).toBe(true);
    expect(hidden.has(1)).toBe(true);
  });

  it('INCIDENT inc-1786664172811: resubscribe-after-send snapshot — live-tail guard must not protect a FINISHED turn\'s final block', () => {
    // Send → markStreaming → resubscribe adopts the server snapshot BEFORE the
    // new turn's first delta: blocks = previous turn's retained pair,
    // isStreaming = true (next turn armed), completedLen = 2 (server stamped
    // them finished). History holds their twins. Without the completedLen
    // floor, the last text was excluded as "still accumulating" and rendered
    // as a duplicate below the user's new bubble for ~14s.
    const blocks = [toolCall('tu-old'), text('Old end message 1', 'msg-old')];
    const messages = [
      msg({ tools: [{ name: 'Bash', toolUseId: 'tu-old', input: {} }] } as Partial<SessionHistoryMessage>),
      msg({ text: 'Old end message 1', msgId: 'msg-old' }),
    ];
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: true, completedLen: 2 });
    expect(hidden.has(0)).toBe(true);
    expect(hidden.has(1)).toBe(true); // the old final text absorbs despite isStreaming
  });

  it('live-tail guard still protects the CURRENT turn\'s accumulating block (index >= completedLen)', () => {
    // Same shape but the last block belongs to the LIVE turn (completedLen=1):
    // its early-known msgId must NOT hide it mid-accumulation.
    const blocks = [text('finished turn text', 'msg-done'), text('partial live', 'msg-live')];
    const messages = [
      msg({ text: 'finished turn text', msgId: 'msg-done' }),
      msg({ text: 'partial live and then some', msgId: 'msg-live' }),
    ];
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: true, completedLen: 1 });
    expect(hidden.has(0)).toBe(true);  // finished block absorbs
    expect(hidden.has(1)).toBe(false); // live tail stays protected
  });

  it('keeps everything when history has not caught up (empty) — never vanishes', () => {
    const blocks = [text('a', 'msg-1'), toolCall('tu-1'), text('b', 'msg-2')];
    const hidden = computeHiddenBlocks({ blocks, messages: [], watermark: 0, isStreaming: false });
    expect(hidden.size).toBe(0);
  });

  it('LIVE TAIL: the accumulating main-lane block is never hidden while streaming', () => {
    // Partial content transiently equals a persisted message + msgId known
    // from message_start — both must not hide the block mid-accumulation.
    const blocks = [text('finished turn', 'msg-1'), text('partial acc', 'msg-2')];
    const messages = [
      msg({ text: 'finished turn', msgId: 'msg-1' }),
      msg({ text: 'partial acc', msgId: 'msg-2' }), // e.g. duplicate emit path
    ];
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: true });
    expect(hidden.has(0)).toBe(true);   // finished block absorbs normally
    expect(hidden.has(1)).toBe(false);  // live tail protected
    // Turn over → same evidence now hides it
    const after = computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: false });
    expect(after.has(1)).toBe(true);
  });

  it('live-tail protection anchors to the last MAIN-lane block, not blocks[len-1]', () => {
    // Trailing lane block (background subagent) after the live main text:
    // main text is still the live tail; lane block follows its own lane rule.
    const blocks = [text('main acc', 'msg-1'), text('sub line', 'msg-s', 'parent-1')];
    const messages = [msg({ text: 'main acc', msgId: 'msg-1' })];
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: true });
    expect(hidden.has(0)).toBe(false); // live main tail protected
    expect(hidden.has(1)).toBe(false); // running lane parent → kept silently
  });

  it('hides lane blocks once the parent Agent is bgTaskFinished', () => {
    const blocks = [text('bg output', 'msg-s', 'tu-agent')];
    const messages = [msg({
      tools: [{ name: 'Agent', toolUseId: 'tu-agent', input: {}, bgTaskFinished: true }],
    } as Partial<SessionHistoryMessage>)];
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: false });
    expect(hidden.has(0)).toBe(true);
  });

  it('/compact shrink: watermark past array end → empty content window, ids still match, nothing crashes', () => {
    const blocks = [text('id-less'), text('with id', 'msg-1')];
    const messages = [msg({ text: 'with id', msgId: 'msg-1' })]; // rewritten short history
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 400, isStreaming: false });
    expect(hidden.has(0)).toBe(false); // content matching paused (window empty)
    expect(hidden.has(1)).toBe(true);  // id immune to the watermark
  });

  it('hides nested-agent lane blocks via transported finishedAgentIds (no history row exists)', () => {
    // inc-1786496042099: the nested Agent's tool_use never reaches the
    // canonical JSONL — history is EMPTY of both the id and any bgTaskFinished
    // row. The server-transported id is the only possible proof.
    const blocks = [text('grandchild output', 'msg-gc', 'tu-nested')];
    const withIds = computeHiddenBlocks({
      blocks, messages: [], watermark: 0, isStreaming: false,
      finishedAgentIds: new Set(['tu-nested']),
    });
    expect(withIds.has(0)).toBe(true);
    // Without the transported proof: kept (still-running nested agent).
    const without = computeHiddenBlocks({ blocks, messages: [], watermark: 0, isStreaming: false });
    expect(without.has(0)).toBe(false);
  });
});

describe('allBlocksAbsorbed — reset gate', () => {
  const blocks = [text('a', 'msg-1'), text('b', 'msg-2')];
  it('true only when every block is hidden AND not streaming', () => {
    expect(allBlocksAbsorbed(blocks, new Set([0, 1]), false)).toBe(true);
    expect(allBlocksAbsorbed(blocks, new Set([0]), false)).toBe(false);
    expect(allBlocksAbsorbed(blocks, new Set([0, 1]), true)).toBe(false);
    expect(allBlocksAbsorbed([], new Set(), false)).toBe(false); // nothing to reset
  });
});
