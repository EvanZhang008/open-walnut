/**
 * Tests for web/src/stream/render-filter.ts — the non-destructive absorption
 * core of the single-timeline model.
 *
 * Semantics carried over from the destructive promote-blocks era (its tests
 * pin the matching rules; these pin the FILTER policy on top):
 *  · absorbed = hidden, never deleted — late history means brief double-render
 *  · live tail (last main-lane block while streaming) is never hidden — except
 *    an Agent/Task call, whose exact-id twin is the card we want
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

  it('an Agent tool_call at the live tail IS hidden on its id twin (the persisted card is the anchor)', () => {
    // Sync subagent: the Agent call blocks the turn, so it is the last
    // main-lane block for the whole run, still 'calling'. The turn-start
    // refetch lands its persisted row (complete tool_use line) → one card.
    const agent: StreamingBlock = { type: 'tool_call', toolUseId: 'tu-agent', name: 'Agent', status: 'calling', input: { description: 'dig' } };
    const blocks = [text('Launching.', 'msg-1'), agent, text('sub line', 'msg-s', 'tu-agent')];
    const messages = [msg({ text: 'Launching.', msgId: 'msg-1', tools: [{ name: 'Agent', toolUseId: 'tu-agent', input: {} }] } as Partial<SessionHistoryMessage>)];
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: true });
    expect(hidden.has(0)).toBe(true);
    expect(hidden.has(1)).toBe(true);  // Agent tail absorbed
    expect(hidden.has(2)).toBe(false); // running lane → kept silently (ledger reads it)
  });

  it('a plain tool_call at the live tail is still protected (its twin is result-less until it returns)', () => {
    const bash: StreamingBlock = { type: 'tool_call', toolUseId: 'tu-bash', name: 'Bash', status: 'calling', input: { command: 'sleep 30' } };
    const blocks = [text('Running it.', 'msg-1'), bash];
    const messages = [msg({ text: 'Running it.', msgId: 'msg-1', tools: [{ name: 'Bash', toolUseId: 'tu-bash', input: {} }] } as Partial<SessionHistoryMessage>)];
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: true });
    expect(hidden.has(0)).toBe(true);
    expect(hidden.has(1)).toBe(false); // live Bash card stays until the turn moves on
    expect(computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: false }).has(1)).toBe(true);
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

describe('pending permission card is never absorbed (2026-09-16 AskUserQuestion hidden on open)', () => {
  // The CLI persists the AskUserQuestion tool_use row BEFORE the control_request
  // reaches walnut, so history always holds the twin of every block around the
  // card. Opening the session >5 min later, the server's stale-running rule
  // answered isStreaming=false, the live-tail guard fell away, and the fully
  // matched window took the card down with it.
  const askCall = (): StreamingBlock => ({
    type: 'tool_call', toolUseId: 'tu-ask', name: 'AskUserQuestion', status: 'calling',
    input: { questions: [{ question: 'Which one?', options: [] }] },
  });
  const pendingCard = (status?: 'pending'): StreamingBlock => ({
    type: 'permission', requestId: 'req-ask', toolName: 'AskUserQuestion',
    ...(status ? { status } : {}),
  });
  const history = [
    msg({ text: 'Let me ask you.', msgId: 'msg-ask' }),
    msg({ tools: [{ name: 'AskUserQuestion', toolUseId: 'tu-ask', input: {} }] }),
  ];

  it('stays visible when the turn around it is fully absorbed and no turn is live (the incident)', () => {
    for (const status of [undefined, 'pending'] as const) {
      const blocks = [text('Let me ask you.', 'msg-ask'), askCall(), pendingCard(status)];
      const hidden = computeHiddenBlocks({ blocks, messages: history, watermark: 0, isStreaming: false });
      expect(hidden.has(0)).toBe(true);
      expect(hidden.has(1)).toBe(true);
      expect(hidden.has(2)).toBe(false);
      // …and the array is not reclaimed underneath the open question.
      expect(allBlocksAbsorbed(blocks, hidden, false)).toBe(false);
    }
  });

  it('stays visible while streaming too (the <5 min case — live tail)', () => {
    const blocks = [text('Let me ask you.', 'msg-ask'), askCall(), pendingCard('pending')];
    const hidden = computeHiddenBlocks({ blocks, messages: history, watermark: 0, isStreaming: true });
    expect(hidden.has(2)).toBe(false);
  });

  it('a SETTLED card is still reclaimed with its fully matched window (memory GC unchanged)', () => {
    for (const status of ['allowed', 'denied'] as const) {
      const blocks: StreamingBlock[] = [
        text('Let me ask you.', 'msg-ask'), askCall(),
        { type: 'permission', requestId: 'req-ask', toolName: 'AskUserQuestion', status },
      ];
      const hidden = computeHiddenBlocks({ blocks, messages: history, watermark: 0, isStreaming: false });
      expect(hidden.has(2)).toBe(true);
      expect(allBlocksAbsorbed(blocks, hidden, false)).toBe(true);
    }
  });

  it('a pending card does not shield a settled sibling or a system notice from GC', () => {
    const blocks: StreamingBlock[] = [
      text('Let me ask you.', 'msg-ask'), askCall(),
      { type: 'system', variant: 'info', message: 'hook ran' },
      { type: 'permission', requestId: 'req-old', toolName: 'Bash', status: 'allowed' },
      pendingCard('pending'),
    ];
    const hidden = computeHiddenBlocks({ blocks, messages: history, watermark: 0, isStreaming: false });
    expect(hidden.has(2)).toBe(true);
    expect(hidden.has(3)).toBe(true);
    expect(hidden.has(4)).toBe(false);
  });
});

describe('the compaction row absorbs on its own id (2026-09-21: "Context compacted" shown twice)', () => {
  // Reported with a screenshot of three rows where one event happened:
  //   Context compacted (493K → 44K tokens) · auto  11:55 AM   ← history row
  //   Continuation summary ›                                   ← the CLI's summary
  //   Context compacted  493K → 44K tokens · auto              ← streaming row
  //
  // A system notice has no msgId/toolUseId, so it used to be absorbed ONLY as a
  // "pure-UI" block, which requires every matchable block in the window to have
  // found a twin. Compaction is precisely the event that makes that impossible:
  // it REWRITES history, so the text blocks streamed before the boundary lose
  // the messages they would have matched, `allMatchableMatched` goes false, and
  // the compaction row is pinned on screen next to its own persisted twin for
  // the rest of the session.
  //
  // The fix gives the row real id evidence: the CLI's `compact_boundary` line
  // uuid, which the parser already exposes as the history row's msgId.
  const compactBlock = (uuid?: string): StreamingBlock => ({
    type: 'system', variant: 'compact', message: 'Context compacted',
    detail: '493K → 44K tokens · auto', ...(uuid ? { uuid } : {}),
  });
  const compactRow = (uuid: string) => msg({
    role: 'system', systemVariant: 'compact', msgId: uuid,
    text: 'Context compacted (493K → 44K tokens) · auto',
  });

  it('hides the streaming row once its own compact_boundary uuid is in history', () => {
    const blocks = [compactBlock('boundary-uuid-1')];
    const hidden = computeHiddenBlocks({
      blocks, messages: [compactRow('boundary-uuid-1')], watermark: 0, isStreaming: false,
    });
    expect(hidden.has(0)).toBe(true);
  });

  it('THE REPORTED STATE: absorbs even though compaction wiped the surrounding evidence', () => {
    // Pre-boundary text that history no longer holds — the post-compaction
    // transcript starts from the summary. This is what kept the old pure-UI GC
    // from ever firing.
    const blocks = [text('a long pre-compaction answer', 'msg-gone'), compactBlock('boundary-uuid-1')];
    const messages = [compactRow('boundary-uuid-1')];
    const hidden = computeHiddenBlocks({ blocks, messages, watermark: 0, isStreaming: false });
    expect(hidden.has(1)).toBe(true);
    // The orphaned text block is still KEPT (append-only: never vanish content
    // just because its twin was compacted away).
    expect(hidden.has(0)).toBe(false);
  });

  it('does NOT hide a compaction row whose boundary has not persisted yet', () => {
    // Mid-compaction, and the boundary line of a DIFFERENT compaction: neither
    // may claim this row, or the live notice would disappear while it is the
    // only thing telling the user why the session went quiet.
    const blocks = [compactBlock('boundary-uuid-2')];
    expect(computeHiddenBlocks({ blocks, messages: [], watermark: 0, isStreaming: true }).size).toBe(0);
    expect(computeHiddenBlocks({
      blocks, messages: [compactRow('boundary-uuid-1')], watermark: 0, isStreaming: false,
    }).has(0)).toBe(false);
  });

  it('an id-less notice keeps the old pure-UI behaviour (older daemons send no uuid)', () => {
    // Absorbed only with a fully-matched window, exactly as before.
    const blocks = [text('answer', 'msg-1'), compactBlock()];
    const matched = [msg({ text: 'answer', msgId: 'msg-1' })];
    expect(computeHiddenBlocks({ blocks, messages: matched, watermark: 0, isStreaming: false }).has(1)).toBe(true);
    expect(computeHiddenBlocks({ blocks, messages: [], watermark: 0, isStreaming: false }).has(1)).toBe(false);
  });

  it('a system uuid never claims a text or tool block, and vice versa', () => {
    // Separate evidence namespace: a text message carrying the same id must not
    // absorb the notice (and the reverse), or one event could hide another.
    const blocks = [compactBlock('shared-id')];
    const asText = [msg({ role: 'assistant', text: 'unrelated', msgId: 'shared-id' })];
    expect(computeHiddenBlocks({ blocks, messages: asText, watermark: 0, isStreaming: false }).size).toBe(0);
    const textBlocks = [text('unrelated', 'shared-id')];
    const asSystem = [compactRow('shared-id')];
    expect(computeHiddenBlocks({ blocks: textBlocks, messages: asSystem, watermark: 0, isStreaming: false }).size).toBe(0);
  });
});
