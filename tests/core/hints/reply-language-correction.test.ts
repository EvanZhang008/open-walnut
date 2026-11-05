/**
 * A lead answering the user in English though his reply language is Chinese (2026-10-31: the
 * Walnut lead's chat, 12 of 45 visible replies, most started by a worker's notice). Two gaps
 * closed here, each pinned on the pattern of that transcript (wording invented):
 *  - the drift sensor read only the turn's final reply, so an English progress line between two
 *    tool calls (the user reads those in the chat too) was never judged;
 *  - after a drift the next message said nothing about the last reply breaking the rule. Now it
 *    carries the rule led by a correction, once.
 * 2026-11-05, the user ("I said don't do this every round"): the rule is never sent on every
 * message, whoever wrote it, and Walnut writes no lines of its own in the user's language; the
 * correction is Walnut's English sentence in front of the user's own rule.
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
import { REPLY_LANGUAGE_SCOPE } from '../../../src/core/hints/hint-origin.js';
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
  it('a worker turn nobody of his started is judged whole (2026-11-02: a notice turn was English throughout)', async () => {
    const worker = async (replies: string[], state: Record<string, unknown>) => {
      records.set('wk', { claudeSessionId: 'wk', hintState: state } as unknown as SessionRecord);
      await hintDriftHook.handler({ sessionId: 'wk', task: { parent_task_id: 'p' }, result: replies.at(-1), replies } as never, {} as never);
      return records.get('wk')!.hintState?.drift?.['reply-language'];
    };
    expect(await worker([EN_PROGRESS, ZH_FINAL], told)).toBeTruthy();
    expect(await worker([ZH_LINE, EN_FINAL], told)).toBeTruthy();
    expect(await worker([ZH_LINE, ZH_FINAL], told)).toBeUndefined();
    // A turn in his language clears an old mark.
    const marked = { ...told, drift: { 'reply-language': '2026-11-02T03:55:00Z' } };
    expect(await worker([ZH_FINAL], marked)).toBeUndefined();
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

  it('a worker notice after a drifted turn says so in English; the ones before and after carry nothing', () => {
    const rec: Rec = { claudeSessionId: 'lead-c', output_mode: 'markdown' };
    // At start: the user's rule and Walnut's scope, nothing in front of it.
    expect(send(rec)).toEqual([`${RULE} ${REPLY_LANGUAGE_SCOPE}`]);
    // A later plain message: nothing (2026-11-05: never on every message).
    expect(send(rec)).toEqual([]);
    // The sensor marks the turn that just ended.
    const at = new Date(Date.now() + 1000).toISOString();
    rec.hintState = { ...(rec.hintState as object), drift: { 'reply-language': at } } as never;
    expect(send(rec)).toEqual([`${replyLanguageCorrection(at)} ${RULE} ${REPLY_LANGUAGE_SCOPE}`]);
    expect(send(rec)).toEqual([]);
  });

  it('every language gets the same English correction naming the turn', () => {
    for (const rule of ['Answer in French.', 'Reply in Japanese.', 'Reply in Korean.', 'Reply in Russian.']) {
      const cfg = { session: { reply_language: rule } } as never;
      const rec: Rec = { claudeSessionId: `lead-${rule}`, output_mode: 'markdown' };
      const plan = () => planHints({ hints: effectiveHints(cfg), target: { sessionId: rec.claudeSessionId, role: 'lead' }, record: rec as never, config: cfg, sentBy: 'agent' });
      rec.hintState = advanceHintState(undefined, rec as never, plan().told, { now: Date.now(), sentBy: 'agent' }) as never;
      const at = new Date(Date.now() + 1000).toISOString();
      rec.hintState = { ...(rec.hintState as object), drift: { 'reply-language': at } } as never;
      const [text] = plan().carried.filter((h) => h.kind === 'reply-language').map((h) => h.text);
      expect(text, rule).toBe(`${replyLanguageCorrection(at)} ${rule} ${REPLY_LANGUAGE_SCOPE}`);
      expect(text).toContain('also when the message you answer, a tool result or your own notes are in English');
    }
  });

  it('the user\'s own message after a drift carries it too', () => {
    const rec: Rec = { claudeSessionId: 'lead-p', output_mode: 'markdown' };
    send(rec);
    const at = new Date(Date.now() + 1000).toISOString();
    rec.hintState = { ...(rec.hintState as object), drift: { 'reply-language': at } } as never;
    expect(send(rec, 'person')).toEqual([`${replyLanguageCorrection(at)} ${RULE} ${REPLY_LANGUAGE_SCOPE}`]);
  });
});

describe('a person\'s own message does not carry the rule by itself', () => {
  // 2026-11-05, the user: the block under every message of his is gone. Only the hint's own
  // triggers send it (start, compaction, a change, a drift), in a worker's chat as in a lead's.
  type Rec = { claudeSessionId: string; output_mode: 'markdown'; hintState?: never };
  const config = { session: { reply_language: RULE } } as never;
  const send = (rec: Rec, sentBy: 'agent' | 'person', cfg: never = config) => {
    const p = planHints({ hints: effectiveHints(cfg), target: { sessionId: rec.claudeSessionId, role: 'worker' }, record: rec as never, config: cfg, sentBy });
    rec.hintState = advanceHintState(rec.hintState, rec as never, p.told, { now: Date.now(), sentBy }) as never;
    return p.carried.some((h) => h.kind === 'reply-language');
  };
  it('a worker: at start only, then neither his messages nor another task\'s', () => {
    const rec: Rec = { claudeSessionId: 'worker-p', output_mode: 'markdown' };
    expect(send(rec, 'person')).toBe(true);
    for (const by of ['agent', 'agent', 'person', 'person', 'agent'] as const) expect(send(rec, by)).toBe(false);
  });
  it('triggers set by hand decide alone: every_turn sends it every time, session_start once', () => {
    const every = { session: { reply_language: RULE, hints: { 'reply-language': { triggers: ['every_turn'] } } } } as never;
    const rec: Rec = { claudeSessionId: 'worker-e', output_mode: 'markdown' };
    for (const by of ['person', 'agent', 'person'] as const) expect(send(rec, by, every)).toBe(true);
    const own = { session: { reply_language: RULE, hints: { 'reply-language': { triggers: ['session_start'] } } } } as never;
    const once: Rec = { claudeSessionId: 'worker-o', output_mode: 'markdown' };
    expect(send(once, 'person', own)).toBe(true);
    expect(send(once, 'person', own)).toBe(false);
  });
});

describe('a message of his in another language gets no line of Walnut\'s own', () => {
  // 2026-11-02 Walnut put a line in the user's language (Chinese, Japanese, Korean, Russian) in
  // front of the rule under a message in another language; 2026-11-05 the user removed it: no
  // official Walnut product writes its own words in his language. The rule is his setting, as is.
  const text = (rule: string, message: string, sentBy: 'agent' | 'person' = 'person') => {
    const config = { session: { reply_language: rule } } as never;
    return planHints({ hints: effectiveHints(config), target: { sessionId: 'w-msg', role: 'worker' }, record: { claudeSessionId: 'w-msg', output_mode: 'markdown' } as never, config, sentBy, message })
      .carried.find((h) => h.kind === 'reply-language')!.text;
  };
  it('an English message from him or another task: the rule and the scope, in ASCII only', () => {
    for (const rule of [RULE, 'Reply in Japanese.', 'Reply in Korean.', 'Reply in Russian.', 'Answer in French.']) {
      for (const [message, by] of [["chinse, I don't know what happened", 'person'], ['Team update: a worker finished its review and is waiting on CI.', 'agent']] as const) {
        const t = text(rule, message, by);
        expect(t, `${rule} / ${message}`).toBe(`${rule} ${REPLY_LANGUAGE_SCOPE}`);
        expect(t).toMatch(/^[\x00-\x7f]*$/);
      }
    }
  });
  it('a Chinese message gets the same text', () => {
    // Test data: "why is a new project not local by default?" in Chinese.
    const zh = '\u4e3a\u4ec0\u4e48\u65b0\u9879\u76ee\u9ed8\u8ba4\u4e0d\u662f\u672c\u5730\u7684\uff1f';
    expect(text(RULE, zh)).toBe(`${RULE} ${REPLY_LANGUAGE_SCOPE}`);
  });
});
