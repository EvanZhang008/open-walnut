/**
 * Boot-time healer for lane answers stranded by a mid-turn server death
 * (src/core/sessions/lane-orphan-recovery.ts + the chat-history primitives it
 * writes through).
 *
 * The confirmed instance this suite is built from: a deploy SIGTERMed the server
 * mid lane turn, the CLI finished and wrote a 437-char answer to its stream
 * JSONL, and nothing persisted it — the conversation was left with two
 * consecutive user messages, the second being the user retyping the SAME
 * question and getting a DIFFERENT (shorter) answer that did persist.
 *
 * The `ADVERSARIAL` block below encodes an independent review's constructions
 * (labelled A-G) against an earlier version that matched an orphan to ANY
 * similar-looking slot. Every one of them wrote a neighbouring turn's answer
 * into the user's conversation. The contract now under test is ordinal
 * alignment: the answer comes from the orphan's OWN slot or from nowhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { dirname as pathDirname } from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addUserMessage,
  addAIMessages,
  listStoreTurns,
  listOrphanTurnTails,
  adoptRecoveredAssistantMessage,
  getDisplayEntries,
  type StoreTurnRef,
} from '../../src/core/chat-history.js';
import {
  parseLaneStreamTurns,
  parseLaneStreamTurnsYielding,
  matchOrphanToAnswer,
  reconcileLaneOrphanTurns,
  streamTailStart,
  dropTornPrefix,
  RECOVERED_TURN_EVENT,
  type LaneRef,
} from '../../src/core/sessions/lane-orphan-recovery.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { getActiveConversationId } from '../../src/core/conversations.js';
import type { MessageParam } from '../../src/agent/model.js';

const AGENT = 'general';
const SESSION_ID = 'bb7aa950-lane-session';
let convId: string;

/** The stranded turn, in shape from the real stream file. */
const Q = 'which one is better';
const STRANDED_ANSWER = 'B (do nothing) — you already failed at A once, and A is the one that scores you.';
const RETYPED_ANSWER = 'B, do nothing. One-line reason: A makes you grade yourself.';

const T0 = '2026-08-31T08:19:01.709Z'; // store persist of the stranded turn
const M0 = '2026-08-31T08:19:01.812Z'; // its delivery marker in the stream (+103ms, real)
const T1 = '2026-08-31T08:26:51.829Z'; // store persist of the retyped turn
const M1 = '2026-08-31T08:26:52.587Z'; // its delivery marker (+470878ms from T0, real)

function userLine(text: string, timestamp?: string): string {
  return JSON.stringify({
    type: 'user', subtype: 'walnut-injected', ...(timestamp ? { timestamp } : {}),
    message: { role: 'user', content: text },
  });
}
function resultLine(result: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 12_781,
    session_id: SESSION_ID, result, ...extra,
  });
}
function errorResultLine(): string {
  return JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'boom' });
}
function stateLine(state: string): string {
  return JSON.stringify({ type: 'system', subtype: 'session_state_changed', state });
}
function initLine(): string {
  return JSON.stringify({ type: 'system', subtype: 'init' });
}

/** The real file's shape: two identically-worded turns, different answers. */
function twoTurnStream(): string {
  return [
    stateLine('running'), userLine(Q, M0), initLine(), resultLine(STRANDED_ANSWER), stateLine('idle'),
    userLine(Q, M1), initLine(), resultLine(RETYPED_ANSWER, { duration_ms: 5_656 }), stateLine('idle'),
    '',
  ].join('\n');
}

/** StoreTurnRef builder for the pure-matcher tests. */
function turn(text: string, turnId: string, timestamp: string, orphan = false): StoreTurnRef {
  return { text, turnId, timestamp, orphan };
}
/** The store sequence matching twoTurnStream(). */
function twoTurnStoreTurns(): StoreTurnRef[] {
  return [turn(Q, 'turn-stranded', T0, true), turn(Q, 'turn-retyped', T1)];
}
const strandedOrphan = { turnId: 'turn-stranded', text: Q, timestamp: T0 };

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  convId = await getActiveConversationId(AGENT);
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Store fixtures ──────────────────────────────────────────────────────────

async function persistUser(text: string, turnId: string): Promise<void> {
  await addUserMessage(text, { displayText: text, turnId, agentId: AGENT, conversationId: convId });
}
async function persistAssistant(text: string): Promise<void> {
  await addAIMessages(
    [{ role: 'assistant', content: [{ type: 'text', text }] }] as MessageParam[],
    { agentId: AGENT, conversationId: convId },
  );
}
async function rawEntries(): Promise<Array<Record<string, unknown>>> {
  const { conversationFile } = await import('../../src/constants.js');
  const raw = JSON.parse(await fsp.readFile(conversationFile(AGENT, convId), 'utf-8'));
  return raw.entries ?? [];
}

const fixtureUser = (text: string, turnId: string, timestamp: string) =>
  ({ tag: 'ai', role: 'user', content: text, displayText: text, turnId, timestamp });
const fixtureAssistant = (text: string, timestamp: string) =>
  ({ tag: 'ai', role: 'assistant', content: [{ type: 'text', text }], timestamp });

/** Write a store file directly. Used where the TIMESTAMPS are the thing under
 *  test — writes issued inside one test tick would be milliseconds apart, and
 *  the real incident's two identically-worded turns were 7 minutes apart. Entry
 *  shapes mirror addUserMessage/addAIMessages exactly (the listOrphanTurnTails
 *  block below uses the real writers to keep that honest). */
async function seedStore(entries: unknown[]): Promise<void> {
  const { conversationFile } = await import('../../src/constants.js');
  const file = conversationFile(AGENT, convId);
  await fsp.mkdir(pathDirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({
    version: 2, lastUpdated: '2026-08-31T08:36:54.887Z',
    compactionCount: 0, compactionSummary: null, entries,
  }, null, 2), 'utf-8');
}

/** The exact conversation the incident left behind. Note the FIRST turn has no
 *  stream slot (the lane's first message rides the spawn, which writes no
 *  delivery marker) — the window floor must exclude it or every ordinal shifts. */
async function seedIncidentStore(): Promise<void> {
  await seedStore([
    fixtureUser('how do I start meditating', 'turn-first', '2026-08-31T02:22:54.971Z'),
    fixtureAssistant('Sixty minutes a day, doing nothing.', '2026-08-31T02:23:35.347Z'),
    fixtureUser('what about walking', 'turn-earlier', '2026-08-31T08:05:52.591Z'),
    fixtureAssistant('Walking is the better entry point for you.', '2026-08-31T08:06:08.566Z'),
    fixtureUser(Q, 'turn-stranded', T0),                       // ← orphan, mid-list
    fixtureUser(Q, 'turn-retyped', T1),
    fixtureAssistant(RETYPED_ANSWER, '2026-08-31T08:26:59.019Z'),
    fixtureUser('any better method', 'turn-later', '2026-08-31T08:27:16.325Z'),
    fixtureAssistant('Changing method matters less than doing it daily.', '2026-08-31T08:27:41.712Z'),
  ]);
}

// ── parseLaneStreamTurns ────────────────────────────────────────────────────

describe('parseLaneStreamTurns', () => {
  it('splits the stream into one slot per turn, each holding its own result', () => {
    const slots = parseLaneStreamTurns(twoTurnStream());
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ text: Q, timestamp: M0, answer: STRANDED_ANSWER, errored: false });
    expect(slots[1]).toMatchObject({ text: Q, timestamp: M1, answer: RETYPED_ANSWER, errored: false });
    expect(slots[0].durationMs).toBe(12_781);
  });

  it('drops a result whose turn opened before the window (no slot to own it)', () => {
    const slots = parseLaneStreamTurns([resultLine('orphaned tail result'), stateLine('idle')].join('\n'));
    expect(slots).toHaveLength(0);
  });

  it('ignores torn lines, tool_result echoes and subagent user lines', () => {
    const tail = [
      '{"type":"user","subty',                                        // torn
      userLine(Q, M0),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
      }),
      JSON.stringify({
        type: 'user', parent_tool_use_id: 'tu_2',
        message: { role: 'user', content: 'subagent chatter' },
      }),
      resultLine(STRANDED_ANSWER),
    ].join('\n');
    const slots = parseLaneStreamTurns(tail);
    expect(slots).toHaveLength(1);
    expect(slots[0].answer).toBe(STRANDED_ANSWER);
  });

  it('keeps the LAST successful result of a slot (intermediate workflow results lose)', () => {
    const tail = [
      userLine(Q, M0), resultLine('intermediate subagent summary'),
      stateLine('running'), resultLine(STRANDED_ANSWER),
    ].join('\n');
    expect(parseLaneStreamTurns(tail)[0].answer).toBe(STRANDED_ANSWER);
  });

  it('marks an errored turn and never carries an answer for it', () => {
    const tail = [userLine(Q, M0), errorResultLine()].join('\n');
    expect(parseLaneStreamTurns(tail)[0]).toMatchObject({ answer: null, errored: true });
  });

  it('an error result AFTER a success clears the success (the turn failed)', () => {
    const tail = [userLine(Q, M0), resultLine(STRANDED_ANSWER), errorResultLine()].join('\n');
    expect(parseLaneStreamTurns(tail)[0]).toMatchObject({ answer: null, errored: true });
  });

  it('the yielding parse agrees with the sync one across chunk boundaries', async () => {
    // > PARSE_LINE_CHUNK (1000) lines, so the yield path is really exercised.
    const filler = Array.from({ length: 1_500 }, () => stateLine('running'));
    const tail = [...filler, userLine(Q, M0), ...filler, resultLine(STRANDED_ANSWER)].join('\n');
    const sync = parseLaneStreamTurns(tail);
    const async_ = await parseLaneStreamTurnsYielding(tail);
    expect(async_).toEqual(sync);
    expect(async_).toHaveLength(1);
    expect(async_[0].answer).toBe(STRANDED_ANSWER);
  });
});

// ── Tail window bounds ──────────────────────────────────────────────────────

describe('stream tail window', () => {
  it('reads only the last 4 MB, and the whole file when it is smaller', () => {
    expect(streamTailStart(1_000)).toBe(0);
    expect(streamTailStart(4 * 1024 * 1024)).toBe(0);
    expect(streamTailStart(10 * 1024 * 1024)).toBe(6 * 1024 * 1024);
    // The confirmed instance: the orphan's user line sat 1.62 MB from the end of
    // a 2.6 MB file, so the window must reach at least that far back.
    expect(2_629_807 - streamTailStart(2_629_807)).toBeGreaterThan(1_620_000);
  });

  it('drops the torn first line of a mid-file window, and nothing when at byte 0', () => {
    const torn = '"type":"user"} garbage\n{"type":"result"}\n';
    expect(dropTornPrefix(torn, 1_000)).toBe('{"type":"result"}\n');
    expect(dropTornPrefix(torn, 0)).toBe(torn);
    // A window with no newline at all is entirely one torn line → nothing usable.
    expect(dropTornPrefix('half a line with no newline', 1_000)).toBe('');
  });

  it('a torn prefix can never be re-joined into a bogus slot', () => {
    const start = 500;
    const content = `pe":"user","subtype":"walnut-injected"}\n${userLine(Q, M0)}\n${resultLine(STRANDED_ANSWER)}`;
    const slots = parseLaneStreamTurns(dropTornPrefix(content, start));
    expect(slots).toHaveLength(1);
    expect(slots[0].text).toBe(Q);
  });
});

// ── matchOrphanToAnswer: the contract ───────────────────────────────────────

describe('matchOrphanToAnswer', () => {
  const slots = parseLaneStreamTurns(twoTurnStream());

  it('picks the orphan\'s OWN slot by ordinal, not the last result in the file', () => {
    const match = matchOrphanToAnswer(strandedOrphan, slots, twoTurnStoreTurns());
    expect(match?.slotIndex).toBe(0);
    expect(match?.answer).toBe(STRANDED_ANSWER);
    expect(match?.answer).not.toBe(RETYPED_ANSWER);
  });

  it('resolves the later identically-worded turn to the later slot', () => {
    const match = matchOrphanToAnswer(
      { turnId: 'turn-retyped', text: Q, timestamp: T1 }, slots, twoTurnStoreTurns(),
    );
    expect(match?.slotIndex).toBe(1);
    expect(match?.answer).toBe(RETYPED_ANSWER);
  });

  it('reports an honest completion time (delivery marker + turn duration)', () => {
    const match = matchOrphanToAnswer(strandedOrphan, slots, twoTurnStoreTurns());
    expect(match?.completedAt).toBe(new Date(Date.parse(M0) + 12_781).toISOString());
  });

  it('ignores store turns older than the window, so ordinals do not shift', () => {
    // The lane's first message rides the spawn and leaves NO marker, so the store
    // legitimately has one more turn than the stream has slots. Counting it would
    // make the families unequal and refuse a valid heal.
    const withPreWindowTurn = [
      turn(Q, 'turn-ancient', '2026-08-30T01:00:00.000Z'), // same text, long before the window
      ...twoTurnStoreTurns(),
    ];
    const match = matchOrphanToAnswer(strandedOrphan, slots, withPreWindowTurn);
    expect(match?.slotIndex).toBe(0);
    expect(match?.answer).toBe(STRANDED_ANSWER);
  });

  it('returns null when no slot answers that question', () => {
    expect(matchOrphanToAnswer(
      { turnId: 'turn-x', text: 'a question never asked', timestamp: T0 },
      slots, [turn('a question never asked', 'turn-x', T0, true)],
    )).toBeNull();
  });

  it('REFUSES when the two sequences disagree about how many such turns exist', () => {
    // Store knows of one "which one is better"; the stream shows two. We cannot
    // tell which slot is the orphan's, so nothing is adopted.
    const match = matchOrphanToAnswer(strandedOrphan, slots, [turn(Q, 'turn-stranded', T0, true)]);
    expect(match).toBeNull();
  });

  it('REFUSES when the stream window carries no delivery markers at all', () => {
    const unmarked = parseLaneStreamTurns([userLine(Q), resultLine(STRANDED_ANSWER)].join('\n'));
    expect(unmarked).toHaveLength(1);
    expect(unmarked[0].timestamp).toBeUndefined();
    expect(matchOrphanToAnswer(strandedOrphan, unmarked, [turn(Q, 'turn-stranded', T0, true)])).toBeNull();
  });

  it('matches a message delivered with an image-context prefix (line-aligned, long enough)', () => {
    const prefixed = parseLaneStreamTurns([
      userLine(`The user attached an image. Read this file for visual context:\n/tmp/a.png\n\n${Q}`, M0),
      resultLine(STRANDED_ANSWER),
    ].join('\n'));
    const match = matchOrphanToAnswer(strandedOrphan, prefixed, [turn(Q, 'turn-stranded', T0, true)]);
    expect(match?.answer).toBe(STRANDED_ANSWER);
  });

  it('accepts a marker at the edge of the proximity window and rejects one past it', () => {
    const at = (deltaMs: number) => parseLaneStreamTurns([
      userLine(Q, new Date(Date.parse(T0) + deltaMs).toISOString()), resultLine(STRANDED_ANSWER),
    ].join('\n'));
    const store = [turn(Q, 'turn-stranded', T0, true)];
    expect(matchOrphanToAnswer(strandedOrphan, at(119_000), store)?.answer).toBe(STRANDED_ANSWER);
    expect(matchOrphanToAnswer(strandedOrphan, at(121_000), store)).toBeNull();
    // Backwards is clock jitter only: the store write provably precedes delivery.
    expect(matchOrphanToAnswer(strandedOrphan, at(-59_000), store)?.answer).toBe(STRANDED_ANSWER);
    expect(matchOrphanToAnswer(strandedOrphan, at(-61_000), store)).toBeNull();
  });
});

// ── ADVERSARIAL: an independent review's constructions A-G ──────────────────
// Every case below adopted a NEIGHBOUR's answer under the earlier text+closest
// -timestamp matcher. C and D are the observed production shape (the same user
// text at two store positions) with one variable flipped.

describe('matchOrphanToAnswer — adversarial (must all refuse)', () => {
  const T = T0;
  const plus = (ms: number) => new Date(Date.parse(T) + ms).toISOString();
  /** A question long enough to clear the needle floor, used by the N-cases. */
  const NQ = 'what should I do about this?';

  it('A: a short orphan "ok" must not ride a later "sounds good ok" turn', () => {
    const slots = parseLaneStreamTurns([
      userLine('ok', plus(100)), errorResultLine(),
      userLine('sounds good ok', plus(600_000)), resultLine('ANSWER-FOR-THE-OTHER-TURN'),
    ].join('\n'));
    const store = [turn('ok', 'orphan', T, true), turn('sounds good ok', 'other', plus(600_000))];
    expect(matchOrphanToAnswer({ turnId: 'orphan', text: 'ok', timestamp: T }, slots, store)).toBeNull();
  });

  it('B: orphan "continue" must not ride a later "please continue" turn', () => {
    const slots = parseLaneStreamTurns([
      userLine('continue', plus(100)),
      userLine('please continue', plus(120_000)), resultLine('ANSWER-FOR-PLEASE-CONTINUE'),
    ].join('\n'));
    const store = [turn('continue', 'orphan', T, true), turn('please continue', 'other', plus(120_000))];
    expect(matchOrphanToAnswer({ turnId: 'orphan', text: 'continue', timestamp: T }, slots, store)).toBeNull();
  });

  it('C: identical text, own slot ERRORED → refuse (never take the retyped answer)', () => {
    const slots = parseLaneStreamTurns([
      userLine(Q, plus(100)), errorResultLine(),
      userLine(Q, plus(470_000)), resultLine('ANSWER-OF-THE-RETYPED-TURN'),
    ].join('\n'));
    const store = [turn(Q, 'orphan', T, true), turn(Q, 'retyped', plus(470_000))];
    expect(matchOrphanToAnswer({ turnId: 'orphan', text: Q, timestamp: T }, slots, store)).toBeNull();
  });

  it('D: identical text, own slot has NO result (CLI died too) → refuse', () => {
    const slots = parseLaneStreamTurns([
      userLine(Q, plus(100)),
      userLine(Q, plus(470_000)), resultLine('ANSWER-OF-THE-RETYPED-TURN'),
    ].join('\n'));
    const store = [turn(Q, 'orphan', T, true), turn(Q, 'retyped', plus(470_000))];
    expect(matchOrphanToAnswer({ turnId: 'orphan', text: Q, timestamp: T }, slots, store)).toBeNull();
  });

  it('E (control): own slot answered → adopts ITS answer, not the neighbour\'s', () => {
    const slots = parseLaneStreamTurns([
      userLine(Q, plus(100)), resultLine('RIGHT-ANSWER'),
      userLine(Q, plus(470_000)), resultLine('WRONG-ANSWER'),
    ].join('\n'));
    const store = [turn(Q, 'orphan', T, true), turn(Q, 'retyped', plus(470_000))];
    const match = matchOrphanToAnswer({ turnId: 'orphan', text: Q, timestamp: T }, slots, store);
    expect(match?.slotIndex).toBe(0);
    expect(match?.answer).toBe('RIGHT-ANSWER');
  });

  it('F: a sole candidate 5h59m away → refuse (proximity floor)', () => {
    const far = plus(5 * 3_600_000 + 59 * 60_000);
    const slots = parseLaneStreamTurns([userLine(Q, far), resultLine('ANSWER-FROM-6H-LATER')].join('\n'));
    const store = [turn(Q, 'orphan', T, true)];
    expect(matchOrphanToAnswer({ turnId: 'orphan', text: Q, timestamp: T }, slots, store)).toBeNull();
  });

  it('G: a single-character orphan "?" must not match an unrelated question', () => {
    const slots = parseLaneStreamTurns([
      userLine('what should I do next?', plus(200_000)), resultLine('ANSWER-TO-A-DIFFERENT-QUESTION'),
    ].join('\n'));
    const store = [turn('?', 'orphan', T, true), turn('what should I do next?', 'other', plus(200_000))];
    expect(matchOrphanToAnswer({ turnId: 'orphan', text: '?', timestamp: T }, slots, store)).toBeNull();
  });

  // ── The suffix arm's own collision (found by the same review, round 2) ──
  // The arm exists for the image-context prefix, but ANY longer message ending
  // with '\n' + the orphan's text passes it. The natural shape is a user whose
  // question goes unanswered pasting an error log that closes with that same
  // question. Exact ownership now claims such a slot for the turn whose message
  // it literally is, so it can neither fabricate an answer (N1, N3) nor inflate
  // the count and suppress a real heal (N2).
  const LOG_TAIL = `Here is the error log:\n\nTypeError: x is not a function\n  at foo (bar.ts:12)\n\n${NQ}`;

  it('N1: orphan delivery lost + a later log ending with the same question → refuse', () => {
    const slots = parseLaneStreamTurns([
      userLine(LOG_TAIL, plus(45_000)), resultLine('ANSWER-ABOUT-THE-PASTED-LOG'),
    ].join('\n'));
    const store = [turn(NQ, 'orphan', T, true), turn(LOG_TAIL, 'pasted-log', plus(45_000))];
    expect(matchOrphanToAnswer({ turnId: 'orphan', text: NQ, timestamp: T }, slots, store)).toBeNull();
  });

  it('N2 (companion): the same shape WITH the orphan delivered still heals', () => {
    const slots = parseLaneStreamTurns([
      userLine(NQ, plus(103)), resultLine('THE-REAL-ANSWER'),
      userLine(LOG_TAIL, plus(45_000)), resultLine('ANSWER-ABOUT-THE-PASTED-LOG'),
    ].join('\n'));
    const store = [turn(NQ, 'orphan', T, true), turn(LOG_TAIL, 'pasted-log', plus(45_000))];
    const match = matchOrphanToAnswer({ turnId: 'orphan', text: NQ, timestamp: T }, slots, store);
    expect(match?.slotIndex).toBe(0);
    expect(match?.answer).toBe('THE-REAL-ANSWER');
  });

  it('N3: a 2-member family whose ordinal 0 lands on a compound slot → refuse', () => {
    const q2 = 'summarize the notes for me now';
    const compound = `please\n${q2}`;
    const slots = parseLaneStreamTurns([
      userLine(compound, plus(10_000)), resultLine('ANSWER-FOR-THE-COMPOUND-TURN'),
      userLine(q2, plus(90_000)), resultLine('ANSWER-FOR-THE-SECOND-EXACT-TURN'),
    ].join('\n'));
    const store = [
      turn(compound, 'compound', plus(10_000)),
      turn(q2, 'orphan', T, true),
      turn(q2, 'later-exact', plus(90_000)),
    ];
    expect(matchOrphanToAnswer({ turnId: 'orphan', text: q2, timestamp: T }, slots, store)).toBeNull();
  });

  it('a SHORT message delivered with an image prefix refuses (min-needle floor)', () => {
    // Same legitimate prefix shape as the accepted case above, but the needle is
    // 'ok' — too short to prove the tail is the message and not a coincidence.
    const slots = parseLaneStreamTurns([
      userLine('The user attached an image. Read this file for visual context:\n/tmp/a.png\n\nok', M0),
      resultLine('ANSWER'),
    ].join('\n'));
    const store = [turn('ok', 'orphan', T0, true)];
    expect(matchOrphanToAnswer({ turnId: 'orphan', text: 'ok', timestamp: T0 }, slots, store)).toBeNull();
  });
});

// ── listStoreTurns / listOrphanTurnTails ────────────────────────────────────

describe('listStoreTurns', () => {
  it('returns every turn-starting user message in order, orphan-flagged', async () => {
    await seedIncidentStore();
    const turns = await listStoreTurns(AGENT, convId);
    expect(turns.map((t) => t.turnId)).toEqual([
      'turn-first', 'turn-earlier', 'turn-stranded', 'turn-retyped', 'turn-later',
    ]);
    expect(turns.map((t) => t.orphan)).toEqual([false, false, true, false, false]);
  });

  it('keeps a turn with no turnId — it still holds an ordinal', async () => {
    await seedStore([
      { tag: 'ai', role: 'user', content: 'cron prompt', timestamp: T0 },
      fixtureAssistant('cron answer', M0),
      fixtureUser(Q, 'turn-stranded', T1),
    ]);
    const turns = await listStoreTurns(AGENT, convId);
    expect(turns).toHaveLength(2);
    expect(turns[0].turnId).toBeUndefined();
    // ...but it is never offered for adoption (no key to adopt against).
    expect((await listOrphanTurnTails(AGENT, convId)).map((o) => o.turnId)).toEqual(['turn-stranded']);
  });
});

describe('listOrphanTurnTails', () => {
  it('finds the mid-list gap AND the trailing user message, and nothing else', async () => {
    await seedIncidentStore();
    await persistUser('one more question', 'turn-tail');   // trailing orphan
    const orphans = await listOrphanTurnTails(AGENT, convId);
    expect(orphans.map((o) => o.turnId)).toEqual(['turn-stranded', 'turn-tail']);
    expect(orphans[0]).toMatchObject({ text: Q });
  });

  it('treats a persisted error verdict as answered (a different defect)', async () => {
    await persistUser(Q, 'turn-errored');
    await addAIMessages(
      [{ role: 'assistant', content: [{ type: 'text', text: '[Error: timed out]' }] }] as MessageParam[],
      { source: 'agent-error', agentId: AGENT, conversationId: convId },
    );
    expect(await listOrphanTurnTails(AGENT, convId)).toEqual([]);
  });

  it('is bounded: only the most recent maxScan turns are considered', async () => {
    for (let i = 0; i < 6; i++) await persistUser(`q${i}`, `turn-${i}`);
    const orphans = await listOrphanTurnTails(AGENT, convId, { maxScan: 2 });
    expect(orphans.map((o) => o.turnId)).toEqual(['turn-4', 'turn-5']);
  });
});

// ── adoptRecoveredAssistantMessage ──────────────────────────────────────────

describe('adoptRecoveredAssistantMessage', () => {
  const adopt = (turnId: string, text: string, timestamp?: string) =>
    adoptRecoveredAssistantMessage({
      agentId: AGENT, conversationId: convId, turnId, text, ...(timestamp ? { timestamp } : {}),
    });

  it('INSERTS the answer right after its user message, not at the end', async () => {
    await seedIncidentStore();
    expect(await adopt('turn-stranded', STRANDED_ANSWER, '2026-08-31T08:19:14.593Z')).toBe('adopted');

    const entries = await rawEntries();
    const idx = entries.findIndex((e) => e.turnId === 'turn-stranded' && e.role === 'user');
    const inserted = entries[idx + 1] as Record<string, unknown>;
    expect(inserted.role).toBe('assistant');
    expect(inserted.turnId).toBe('turn-stranded');
    expect(inserted.recovered).toBe(true);               // forensic marker
    expect(inserted.timestamp).toBe('2026-08-31T08:19:14.593Z'); // honest, not "now"
    expect((inserted.content as Array<{ text: string }>)[0].text).toBe(STRANDED_ANSWER);
    // The conversation's later turns are untouched and still last.
    expect((entries[entries.length - 1] as Record<string, unknown>).role).toBe('assistant');
    expect(entries.filter((e) => e.role === 'user')).toHaveLength(5);
  });

  it('is idempotent — a second pass adopts nothing', async () => {
    await seedIncidentStore();
    expect(await adopt('turn-stranded', STRANDED_ANSWER)).toBe('adopted');
    expect(await adopt('turn-stranded', STRANDED_ANSWER)).toBe('no-orphan');
    const texts = (await rawEntries())
      .filter((e) => e.role === 'assistant')
      .map((e) => (e.content as Array<{ text?: string }>)[0]?.text);
    expect(texts.filter((t) => t === STRANDED_ANSWER)).toHaveLength(1);
  });

  it('no-ops when the answer is already in the store under another turn', async () => {
    await seedIncidentStore();
    expect(await adopt('turn-stranded', RETYPED_ANSWER)).toBe('already-present');
  });

  it('no-ops when the turn already has an assistant reply', async () => {
    await persistUser(Q, 'turn-answered');
    await persistAssistant(RETYPED_ANSWER);
    expect(await adopt('turn-answered', STRANDED_ANSWER)).toBe('no-orphan');
  });

  it('reports turn-missing when the user entry is gone (history cleared)', async () => {
    expect(await adopt('turn-that-never-existed', STRANDED_ANSWER)).toBe('turn-missing');
  });

  it('the adopted answer is visible to the display/API read path', async () => {
    await seedIncidentStore();
    await adopt('turn-stranded', STRANDED_ANSWER);
    const { messages } = await getDisplayEntries(1, 100, AGENT, convId);
    const texts = messages.map((m) =>
      Array.isArray(m.content) ? (m.content as Array<{ text?: string }>)[0]?.text : String(m.content));
    expect(texts).toContain(STRANDED_ANSWER);
    expect(texts.indexOf(STRANDED_ANSWER)).toBeLessThan(texts.indexOf(RETYPED_ANSWER));
  });
});

// ── reconcileLaneOrphanTurns (whole pass, I/O seams injected) ───────────────

describe('reconcileLaneOrphanTurns', () => {
  const lane = (): LaneRef => ({
    sessionId: SESSION_ID, agentId: AGENT, conversationId: convId, host: null,
  });

  it('heals the incident end to end and picks the RIGHT of two identical turns', async () => {
    await seedIncidentStore();
    const adopted: string[] = [];
    const report = await reconcileLaneOrphanTurns({
      listLanes: async () => [lane()],
      readStreamTail: async () => twoTurnStream(),
      onAdopted: (a) => { adopted.push(a.answer); },
    });
    expect(report).toMatchObject({ lanesScanned: 1, orphansFound: 1, adopted: 1 });
    expect(adopted).toEqual([STRANDED_ANSWER]);

    const entries = await rawEntries();
    const idx = entries.findIndex((e) => e.turnId === 'turn-stranded' && e.role === 'user');
    expect((entries[idx + 1].content as Array<{ text: string }>)[0].text).toBe(STRANDED_ANSWER);
  });

  it('running twice adopts nothing new', async () => {
    await seedIncidentStore();
    const opts = { listLanes: async () => [lane()], readStreamTail: async () => twoTurnStream() };
    await reconcileLaneOrphanTurns(opts);
    const second = await reconcileLaneOrphanTurns(opts);
    // The strongest form of idempotency: the second pass finds no orphan at all,
    // so it never even reaches the adopt call.
    expect(second).toMatchObject({ lanesScanned: 1, orphansFound: 0, adopted: 0, skipped: {} });
  });

  it('refuses to re-write an answer the store already holds', async () => {
    await seedIncidentStore();
    // One slot, matching the orphan, carrying the text already persisted under
    // the retyped turn — the double-write guard must catch it.
    const duplicateStream = [userLine(Q, M0), resultLine(RETYPED_ANSWER)].join('\n');
    const report = await reconcileLaneOrphanTurns({
      listLanes: async () => [lane()],
      readStreamTail: async () => duplicateStream,
    });
    expect(report).toMatchObject({ orphansFound: 1, adopted: 0 });
    const dupes = (await rawEntries())
      .filter((e) => (e.content as Array<{ text?: string }>)[0]?.text === RETYPED_ANSWER);
    expect(dupes).toHaveLength(1);
  });

  it('adopts nothing when the turn has not finished yet (no result in its slot)', async () => {
    await seedIncidentStore();
    const stillRunning = [stateLine('running'), userLine(Q, M0), stateLine('running')].join('\n');
    const report = await reconcileLaneOrphanTurns({
      listLanes: async () => [lane()],
      readStreamTail: async () => stillRunning,
    });
    expect(report.adopted).toBe(0);
    expect(report.skipped['no-positional-match']).toBe(1);
  });

  it('a missing stream file is a skip, never a throw', async () => {
    await seedIncidentStore();
    const report = await reconcileLaneOrphanTurns({
      listLanes: async () => [lane()],
      readStreamTail: async () => null,
    });
    expect(report).toMatchObject({ adopted: 0, skipped: { 'no-stream': 1 } });
  });

  it('a stream read that throws is a skip, never a throw', async () => {
    await seedIncidentStore();
    const report = await reconcileLaneOrphanTurns({
      listLanes: async () => [lane()],
      readStreamTail: async () => { throw new Error('daemon offline'); },
    });
    expect(report).toMatchObject({ adopted: 0, skipped: { 'stream-read-failed': 1 } });
  });

  it('a failing lane listing degrades to an empty report', async () => {
    const report = await reconcileLaneOrphanTurns({
      listLanes: async () => { throw new Error('registry unavailable'); },
    });
    expect(report).toMatchObject({ lanesScanned: 0, orphansFound: 0, adopted: 0 });
  });

  it('never reads a stream for a conversation with no orphan tail', async () => {
    await persistUser(Q, 'turn-answered');
    await persistAssistant(RETYPED_ANSWER);
    let reads = 0;
    const report = await reconcileLaneOrphanTurns({
      listLanes: async () => [lane()],
      readStreamTail: async () => { reads++; return twoTurnStream(); },
    });
    expect(reads).toBe(0);
    expect(report).toMatchObject({ lanesScanned: 1, orphansFound: 0, adopted: 0 });
  });

  it('honours the lane cap', async () => {
    await seedIncidentStore();
    let seen = 0;
    await reconcileLaneOrphanTurns({
      listLanes: async () => [lane(), lane(), lane()],
      readStreamTail: async () => { seen++; return twoTurnStream(); },
      maxLanes: 1,
    });
    expect(seen).toBe(1);
  });

  it('heals at most MAX_ORPHANS_PER_LANE turns in one pass, newest first', async () => {
    // Seven orphans, each with its own slot and answer.
    const base = Date.parse('2026-08-31T09:00:00.000Z');
    const at = (i: number) => new Date(base + i * 60_000).toISOString();
    await seedStore(Array.from({ length: 7 }, (_, i) => fixtureUser(`question number ${i}`, `t-${i}`, at(i))));
    const stream = Array.from({ length: 7 }, (_, i) => [
      userLine(`question number ${i}`, new Date(base + i * 60_000 + 120).toISOString()),
      resultLine(`ANSWER-${i}`, { duration_ms: 1_000 }),
    ].join('\n')).join('\n');

    const report = await reconcileLaneOrphanTurns({
      listLanes: async () => [lane()],
      readStreamTail: async () => stream,
    });
    expect(report.orphansFound).toBe(7);
    expect(report.adopted).toBe(5);
    const adoptedTexts = (await rawEntries())
      .filter((e) => e.recovered === true)
      .map((e) => (e.content as Array<{ text: string }>)[0].text);
    // The tail slice keeps the NEWEST five; 0 and 1 wait for the next pass.
    expect(adoptedTexts.sort()).toEqual(['ANSWER-2', 'ANSWER-3', 'ANSWER-4', 'ANSWER-5', 'ANSWER-6']);
  });

  it('an onAdopted hook that throws does not undo the durable adoption', async () => {
    await seedIncidentStore();
    const report = await reconcileLaneOrphanTurns({
      listLanes: async () => [lane()],
      readStreamTail: async () => twoTurnStream(),
      onAdopted: () => { throw new Error('no client listening'); },
    });
    expect(report.adopted).toBe(1);
    const entries = await rawEntries();
    const idx = entries.findIndex((e) => e.turnId === 'turn-stranded' && e.role === 'user');
    expect((entries[idx + 1].content as Array<{ text: string }>)[0].text).toBe(STRANDED_ANSWER);
  });
});

// ── Recovery must never SETTLE a live turn ──────────────────────────────────
// A recovered turn ended minutes-to-hours ago. Every terminal frame this server
// can send is addressed to "the turn running on this conversation NOW": the SSE
// mirror re-stamps frames with the armed turnId (settling the live relayed turn
// with the old answer and dropping its real terminal frame), and the iOS
// message-end handler ignores turnId entirely. So the recovery path may emit only
// an advisory nobody treats as terminal.

describe('recovery emits an advisory, never a terminal frame', () => {
  const TERMINAL_NAMES = ['message-end', 'agent:response', 'agent:error', 'chat:history-updated'];

  it('emits exactly one advisory bus event per adoption, and nothing terminal', async () => {
    const { bus } = await import('../../src/core/event-bus.js');
    await seedIncidentStore();
    const seen: string[] = [];
    bus.subscribe('web-ui', (event) => { seen.push(event.name); });
    try {
      const report = await reconcileLaneOrphanTurns({
        listLanes: async () => [lane()],
        readStreamTail: async () => twoTurnStream(),
      });
      expect(report.adopted).toBe(1);
    } finally {
      bus.unsubscribe('web-ui');
    }
    expect(seen).toContain(RECOVERED_TURN_EVENT);
    expect(seen.filter((n) => n === RECOVERED_TURN_EVENT)).toHaveLength(1);
    for (const terminal of TERMINAL_NAMES) expect(seen).not.toContain(terminal);
  });

  const lane = (): LaneRef => ({
    sessionId: SESSION_ID, agentId: AGENT, conversationId: convId, host: null,
  });

  it('the advisory name is not a name any client treats as a turn ending', () => {
    expect(RECOVERED_TURN_EVENT).toBe('chat:turn-recovered');
    expect(TERMINAL_NAMES).not.toContain(RECOVERED_TURN_EVENT);
  });

  it('RATCHET: the recovery path cannot reach the SSE turn channel', async () => {
    const src = await fsp.readFile('src/core/sessions/lane-orphan-recovery.ts', 'utf-8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    for (const forbidden of ['message-end', 'emitSse', 'AGENT_RESPONSE', 'mirrorRelayedChatFrame']) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('RATCHET: the server boot pass cannot reach the turn channel inline', async () => {
    // The two ratchets above guard the recovery MODULE and one deleted function
    // name. The first version of this feature settled live turns from an emit
    // written INLINE in server.ts's pass, which neither would catch, so pin the
    // pass block itself.
    const lines = (await fsp.readFile('src/web/server.ts', 'utf-8')).split('\n');
    const start = lines.findIndex((l) => l.includes('laneOrphanPassesMs'));
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && /^ {2}\}$/.test(l));
    expect(end).toBeGreaterThan(start);
    const block = lines.slice(start, end).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(block).toContain('reconcileLaneOrphanTurns'); // we sliced the right block
    for (const forbidden of ['emitSse', 'mirrorRelayedChatFrame', 'message-end', 'AGENT_RESPONSE', 'broadcastEvent']) {
      expect(block).not.toContain(forbidden);
    }
  });

  it('RATCHET: api-v1 exposes no recovery emitter to call by accident', async () => {
    const src = await fsp.readFile('src/web/routes/api-v1.ts', 'utf-8');
    expect(src).not.toMatch(/export function emitRecoveredLaneTurn/);
    // The reasoning stays in the file so the next person does not re-add it.
    expect(src).toContain('No recovery emitter lives here');
  });
});
