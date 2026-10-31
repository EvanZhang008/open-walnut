/**
 * A lead answering the user in English though his reply language is Chinese (2026-10-31: the
 * Walnut lead's chat, 12 of 45 visible replies, every one sent with the reply-language hint on the
 * message, most started by a worker's notice). Two gaps closed here, each pinned on the pattern of
 * that transcript (wording invented):
 *  - the drift sensor read only the turn's final reply, so an English progress line between two
 *    tool calls (the user reads those in the chat too) was never judged;
 *  - after a drift the next message carried the same reminder it always carried, nothing saying
 *    the last reply broke it. Now it leads with a correction, once.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionRecord } from '../../../src/core/types.js';

const records = new Map<string, SessionRecord>();
const RULE = 'Talk to the user in Chinese; code, commits, UI strings and repo docs stay English.';
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ session: { reply_language: RULE } }) }));
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (sid: string) => records.get(sid),
  updateSessionRecordConditionally: async (sid: string, patch: Partial<SessionRecord>) => {
    records.set(sid, { ...records.get(sid)!, ...patch });
    return true;
  },
}));

import { EventNames } from '../../../src/core/event-bus.js';
import { deriveSessionHookPoints, type SessionState } from '../../../src/core/session-hooks/derive/session.js';
import { hintDriftHook } from '../../../src/core/hints/hint-drift.js';
import { effectiveHints, replyLanguageCorrection } from '../../../src/core/hints/hint-registry.js';
import { advanceHintState, planHints } from '../../../src/core/hints/hint-send.js';

// The shapes of the lead's turn: a Chinese line, then an English one between two tool calls, then
// a Chinese final reply; and a final reply in English.
const ZH_LINE = '日志和其余 9 个 artifact 都是 0 命中，所以审计报的就是 iOS 结果包里那个误报。下面整理 worker 要的失败日志。';
const EN_PROGRESS = 'Two artifacts downloaded in full. Deleting the public copies now, then scanning them locally.';
const ZH_FINAL = '四个红分别属于四个任务：主机一览（2 个红）、按负载放置、@ Sources、文件夹已删除。都已转给各自负责的任务。';
const EN_FINAL = 'Since you left:\n\n- The four things from the org review went to their owners.\n- The morning report goes out at 7:30.';

const ev = (name: string, data: Record<string, unknown>) => ({ name, data: { sessionId: 'lead', ...data }, source: 'session-runner' }) as never;
const chunks = (msgId: string, text: string, extra: Record<string, unknown> = {}) =>
  [text.slice(0, 20), text.slice(20)].map((delta) => ev(EventNames.SESSION_TEXT_DELTA, { delta, msgId, ...extra }));

function runTurn(states: Map<string, SessionState>, events: unknown[]) {
  const out = events.flatMap((e) => deriveSessionHookPoints(e as never, states, () => {}));
  return out.filter((p) => p.hookPoint === 'onTurnComplete').map((p) => p.extraPayload);
}

describe('the turn-end hooks see every message the user saw', () => {
  it('main-lane messages by id, not a subagent lane or a replay; the next turn starts empty', () => {
    const states = new Map<string, SessionState>();
    const [done] = runTurn(states, [
      ev(EventNames.SESSION_SEND, { message: 'notice' }),
      ...chunks('m1', ZH_LINE),
      ev(EventNames.SESSION_TOOL_USE, { toolName: 'Bash', toolUseId: 't1' }),
      ...chunks('m2', EN_PROGRESS),
      ...chunks('sub', 'A subagent writes English in its own lane.', { parentToolUseId: 't1' }),
      ...chunks('old', 'An old message replayed on reattach.', { replayed: true }),
      ...chunks('m3', ZH_FINAL),
      ev(EventNames.SESSION_RESULT, { result: ZH_FINAL }),
    ]);
    expect(done.replies).toEqual([ZH_LINE, EN_PROGRESS, ZH_FINAL]);
    const [next] = runTurn(states, [ev(EventNames.SESSION_SEND, { message: 'x' }), ...chunks('m4', ZH_FINAL), ev(EventNames.SESSION_RESULT, { result: ZH_FINAL })]);
    expect(next.replies).toEqual([ZH_FINAL]);
  });

  it('a result withheld for background work keeps the turn going; an interrupted turn is dropped', () => {
    const states = new Map<string, SessionState>();
    expect(runTurn(states, [ev(EventNames.SESSION_SEND, {}), ...chunks('m1', EN_PROGRESS), ev(EventNames.SESSION_RESULT, { result: '', backgroundActive: true })])).toEqual([]);
    const [done] = runTurn(states, [...chunks('m2', ZH_FINAL), ev(EventNames.SESSION_RESULT, { result: ZH_FINAL })]);
    expect(done.replies).toEqual([EN_PROGRESS, ZH_FINAL]);
    runTurn(states, [ev(EventNames.SESSION_SEND, {}), ...chunks('m3', EN_PROGRESS), ev(EventNames.SESSION_RESULT, { interrupted: true })]);
    const [after] = runTurn(states, [ev(EventNames.SESSION_SEND, {}), ...chunks('m4', ZH_FINAL), ev(EventNames.SESSION_RESULT, { result: ZH_FINAL })]);
    expect(after.replies).toEqual([ZH_FINAL]);
  });
});

describe('the drift sensor', () => {
  const told = { sends: 3, told: { 'reply-language': { send: 3, hash: 'x', at: '2026-10-31T00:00:00Z' } }, lastSendBy: 'agent' as const };
  beforeEach(() => records.clear());
  const judge = async (payload: Record<string, unknown>, state: Record<string, unknown> = told) => {
    records.set('lead', { claudeSessionId: 'lead', hintState: state } as unknown as SessionRecord);
    await hintDriftHook.handler({ sessionId: 'lead', task: { org_role: 'lead' }, ...payload } as never, {} as never);
    return records.get('lead')!.hintState?.drift?.['reply-language'];
  };

  it('an English line mid-turn is drift though the final reply is Chinese', async () => {
    expect(await judge({ result: ZH_FINAL, replies: [ZH_LINE, EN_PROGRESS, ZH_FINAL] })).toBeTruthy();
  });
  it('an English final reply is drift; a Chinese turn with identifiers and hashes is not', async () => {
    expect(await judge({ result: EN_FINAL, replies: [EN_FINAL] })).toBeTruthy();
    expect(await judge({ result: ZH_FINAL, replies: [ZH_LINE, ZH_FINAL] })).toBeUndefined();
    // A turn that only wrote the agent-ack line or a short English word is never judged.
    expect(await judge({ result: '<walnut-turn status="agent-ack"/>', replies: ['<walnut-turn status="agent-ack"/>', 'Done.'] })).toBeUndefined();
  });
  it('a notice turn that ended on the no-action line is hidden in the chat: its English lines are not judged', async () => {
    const ACK = '<walnut-turn status="agent-ack"/>';
    const hidden = { result: ACK, replies: ["Let me check the worker's current status before deciding what to do with it.", ACK] };
    expect(await judge(hidden)).toBeUndefined();
    // A person started it: the chat shows it, so it is judged.
    expect(await judge(hidden, { ...told, lastSendBy: 'person' })).toBeTruthy();
  });
  it('a later turn in his language clears an old mark; one that cannot tell keeps it', async () => {
    const marked = { ...told, drift: { 'reply-language': '2026-10-31T15:12:00Z' } };
    expect(await judge({ result: ZH_FINAL, replies: [ZH_FINAL] }, marked)).toBeUndefined();
    expect(records.get('lead')!.hintState?.drift).toBeUndefined();
    expect(await judge({ result: 'Done.', replies: ['Done.'] }, marked)).toBe('2026-10-31T15:12:00Z');
  });
});

describe('the next message leads with a correction, once', () => {
  type Rec = { claudeSessionId: string; output_mode: 'markdown'; hintState?: never };
  const config = { session: { reply_language: RULE } } as never;
  const send = (rec: Rec, sentBy: 'agent' | 'person' = 'agent') => {
    const p = planHints({ hints: effectiveHints(config), target: { sessionId: rec.claudeSessionId, role: 'lead' }, record: rec as never, config, sentBy });
    rec.hintState = advanceHintState(rec.hintState, rec as never, p.told, { now: Date.now(), sentBy }) as never;
    return p.carried.filter((h) => h.kind === 'reply-language').map((h) => h.text);
  };

  it('a worker notice after a drifted turn says so; the one after carries the rule alone', () => {
    const rec: Rec = { claudeSessionId: 'lead-c', output_mode: 'markdown' };
    const [plain] = send(rec);
    expect(plain.startsWith('Talk to the user in Chinese')).toBe(true);
    // The sensor marks the turn that just ended.
    const at = new Date(Date.now() + 1000).toISOString();
    rec.hintState = { ...(rec.hintState as object), drift: { 'reply-language': at } } as never;
    const [corrected] = send(rec);
    expect(corrected).toBe(`${replyLanguageCorrection(at)} ${plain}`);
    expect(corrected).toMatch(/^Correction: your last reply the user read \(the turn that ended \d{2}:\d{2} UTC\) was not in his language\./);
    expect(corrected).toContain('also when the message you answer, a tool result or your own notes are in English');
    expect(send(rec)).toEqual([plain]);
  });

  it('the user\'s own message after a drift carries it too', () => {
    const rec: Rec = { claudeSessionId: 'lead-p', output_mode: 'markdown' };
    send(rec);
    rec.hintState = { ...(rec.hintState as object), drift: { 'reply-language': new Date(Date.now() + 1000).toISOString() } } as never;
    expect(send(rec, 'person')[0]).toMatch(/^Correction: /);
  });
});
