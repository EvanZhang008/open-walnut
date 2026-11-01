/**
 * The reply language corrected inside the turn (src/core/hints/hint-drift-live.ts), replayed on
 * the shape of a real turn (2026-11-01, a worker's chat, the turn after the user typed "what the
 * hack?"): a Chinese first line, then English progress lines between Bash calls to the end. The
 * turn-end check named it only on his next message. Now the first English line gets one
 * correction, sent mid-turn right at the tool call that follows it, once per turn, and only in a
 * turn a person started on a native Claude Code session.
 *
 * Would fail if reverted: without the live module no correction goes out in the turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/core/types.js';

const RULE = 'Talk to the user in Chinese.';
const records = new Map<string, SessionRecord>();
const delivered: Array<{ sid: string; text: string; source: string }> = [];
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ session: { reply_language: RULE } }) }));
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (sid: string) => records.get(sid),
  updateSessionRecordConditionally: async (sid: string, patch: Partial<SessionRecord>) => {
    records.set(sid, { ...records.get(sid)!, ...patch });
    return true;
  },
}));
vi.mock('../../../src/core/sessions/session-send-core.js', () => ({
  deliverToSession: async (rec: SessionRecord, o: { enqueueText: string; source: string }) => {
    delivered.push({ sid: rec.claudeSessionId, text: o.enqueueText, source: o.source });
    return { delivery: 'queued' };
  },
}));

import { bus, EventNames } from '../../../src/core/event-bus.js';
import { LIVE_CORRECTION_TEXT, _settledForTest, startLiveDrift, stopLiveDrift, takeLiveCorrection } from '../../../src/core/hints/hint-drift-live.js';
import { hintDriftHook } from '../../../src/core/hints/hint-drift.js';

// The real turn's lines, in order; '' = a message that was only a tool call.
const TURN = [
  '是慢得离谱。我直接拆开看那 1 秒花在哪：',
  '',
  "The machine load just dropped from about 90 to 26, so I'm re-measuring old vs new back to back under the same conditions:",
  '',
  "Under the same load: old version about 0.5 s per click (process launch included), new about 1.15 s per click. Splitting out the new version's time:",
  'Breakdown: process launch 0.12 s, daemon connection about 0.3 s, and the click itself 0.5 s inside the daemon. Next I will look at what it waits on:',
  'The daemon is almost completely idle, so the 0.5 s is spent waiting, not computing. Checking what it waits on:',
];

const emit = (name: string, sid: string, data: Record<string, unknown>) => bus.emit(name as never, { sessionId: sid, ...data } as never, ['main-ai'], { source: 'session-runner' });
const settle = () => _settledForTest();

/** One turn: the send that starts it (none = the CLI's own turn), its lines, each followed by a Bash call. */
async function replay(sid: string, lines: readonly string[], end = true, source: string | null = 'ui') {
  if (source) bus.emit(EventNames.SESSION_SEND as never, { sessionId: sid, message: 'what the hack?' } as never, ['session-runner'], { source });
  let n = 0;
  for (const line of lines) {
    const msgId = `msg_${++n}`;
    if (line) for (const delta of [line.slice(0, 15), line.slice(15)]) emit(EventNames.SESSION_TEXT_DELTA, sid, { delta, msgId });
    emit(EventNames.SESSION_TOOL_USE, sid, { toolName: 'Bash', toolUseId: `tu_${n}` });
    await settle();
  }
  if (end) { emit(EventNames.SESSION_RESULT, sid, { result: '', isError: false }); await settle(); }
}

const session = (sid: string, o: Partial<SessionRecord> = {}) => records.set(sid, {
  claudeSessionId: sid, taskId: 't-' + sid, process_status: 'running', engine: 'claude',
  hintState: { sends: 4, told: {}, lastSendBy: 'person' }, ...o,
} as unknown as SessionRecord);

beforeEach(() => { records.clear(); delivered.length = 0; startLiveDrift(); });
afterEach(() => stopLiveDrift());

describe('a person\'s turn with an English progress line', () => {
  it('gets one correction at the tool call right after the first English line, and none again', async () => {
    session('w1');
    await replay('w1', TURN.slice(0, 3), false);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ sid: 'w1', source: 'walnut-notify' });
    expect(delivered[0].text).toContain(LIVE_CORRECTION_TEXT);
    expect(delivered[0].text).toContain(RULE);
    expect(delivered[0].text).toMatch(/<walnut-message kind="notification" from="Walnut" outcome="reply-language"/);
    await replay('w1', TURN.slice(3));
    expect(delivered).toHaveLength(1);
  });

  it('a Chinese turn gets nothing', async () => {
    session('w2');
    await replay('w2', [TURN[0], '', '日志和其余 9 个文件都是 0 命中，所以是误报。下面整理失败日志，再对比两个版本。']);
    expect(delivered).toEqual([]);
  });

  it('a turn a notice started, the CLI\'s own turn, an ACP engine, or a turn that is over gets none (the turn end decides)', async () => {
    for (const sid of ['a', 'd']) session(sid);
    session('b', { engine: 'codex' } as never);
    session('c', { process_status: 'idle' } as never);
    await replay('a', TURN.slice(0, 3), true, 'walnut-notify');
    // The CLI's own turn after a person's turn (a background command came back): no send since.
    await replay('d', [TURN[0]]);
    await replay('d', TURN.slice(2, 4), true, null);
    for (const sid of ['b', 'c']) await replay(sid, TURN.slice(0, 3));
    expect(delivered).toEqual([]);
  });

  it('a notice that comes in during his turn does not make it someone else\'s', async () => {
    session('m');
    bus.emit(EventNames.SESSION_SEND as never, { sessionId: 'm', message: 'what the hack?' } as never, ['session-runner'], { source: 'mobile' });
    emit(EventNames.SESSION_TEXT_DELTA, 'm', { delta: TURN[0], msgId: 'a' });
    bus.emit(EventNames.SESSION_SEND as never, { sessionId: 'm', message: 'status note' } as never, ['session-runner'], { source: 'walnut-notify' });
    await replay('m', TURN.slice(2, 4), true, null);
    expect(delivered).toHaveLength(1);
  });

  it('the next turn may be corrected again', async () => {
    session('w3');
    await replay('w3', TURN.slice(0, 3));
    await replay('w3', TURN.slice(2, 4));
    expect(delivered).toHaveLength(2);
  });
});

describe('the turn end after a live correction', () => {
  const judge = async (sid: string, replies: string[]) => {
    await hintDriftHook.handler({ sessionId: sid, task: { parent_task_id: 'p' }, result: replies.at(-1), replies } as never, {} as never);
    return records.get(sid)!.hintState?.drift?.['reply-language'];
  };

  it('a turn that came back to the language is not named again on the next message', async () => {
    session('w4');
    await replay('w4', [...TURN.slice(0, 3), '好，按同样的负载重新测了一遍：旧版每次点击约 0.5 秒，新版约 1.15 秒。接下来拆开新版的时间。']);
    expect(await judge('w4', [...TURN.slice(0, 3), '好，按同样的负载重新测了一遍。'])).toBeUndefined();
  });

  it('a turn that stayed English after it is named on the next message', async () => {
    session('w5');
    await replay('w5', TURN);
    // Even though the correction itself, a Walnut notice, was the last send into the session.
    records.set('w5', { ...records.get('w5')!, hintState: { sends: 5, told: {}, lastSendBy: 'agent' } } as never);
    expect(await judge('w5', TURN.filter(Boolean))).toBeTruthy();
  });

  it('the outcome is read once', async () => {
    session('w6');
    await replay('w6', TURN.slice(0, 3));
    expect(await takeLiveCorrection('w6')).toEqual({ driftAfter: false });
    expect(await takeLiveCorrection('w6')).toBeUndefined();
  });
});
