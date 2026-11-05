/**
 * The reply language corrected inside the turn (src/core/hints/hint-drift-live.ts), replayed on
 * the shape of a real turn (2026-11-01, a worker's chat, the turn after the user typed "what the
 * hack?"): a Chinese first line, then English progress lines between Bash calls to the end. The
 * turn-end check named it only on his next message. Now the first English line gets a
 * correction, sent mid-turn right at the tool call that follows it, quoting the line with its
 * rewrite in his language; again after every two more lines off, at most three times a turn, in
 * any turn of a native Claude Code session whoever started it (2026-11-02: a worker's turn a
 * notice started was English throughout and never corrected). The correction's own words are
 * Walnut's English, followed by the user's rule (2026-11-05, the user: no language of Walnut's
 * own in the product), whatever language the rule names.
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
import { LIVE_LATE_LINE, _setRewriteForTest, acceptRewrite, _settledForTest, liveCorrectionText, quoteLine, startLiveDrift, stopLiveDrift, takeLiveCorrection } from '../../../src/core/hints/hint-drift-live.js';
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

let msgSeq = 0;
/** One turn: the send that starts it (none = the CLI's own turn), its lines, each followed by a Bash call. */
async function replay(sid: string, lines: readonly string[], end = true, source: string | null = 'ui') {
  if (source) bus.emit(EventNames.SESSION_SEND as never, { sessionId: sid, message: 'what the hack?' } as never, ['session-runner'], { source });
  for (const line of lines) {
    const n = ++msgSeq;
    const msgId = `msg_${n}`;
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

const REWRITE = '负载刚从约 90 降到 26，所以我在同样条件下把旧版和新版轮流重测一遍：';
let rewrites = 0;
beforeEach(() => {
  records.clear(); delivered.length = 0; rewrites = 0; startLiveDrift();
  _setRewriteForTest(async () => { rewrites++; return REWRITE; });
});
afterEach(() => stopLiveDrift());

describe('a person\'s turn with an English progress line', () => {
  it('gets a correction at the tool call right after the first English line, quoting it with a rewrite; the next after two more off; never a fourth', async () => {
    session('w1');
    await replay('w1', TURN.slice(0, 3), false);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ sid: 'w1', source: 'walnut-notify' });
    // Walnut's English correction quoting the line and its rewrite, then his rule, then the late-turn line.
    expect(delivered[0].text).toContain(`${liveCorrectionText(quoteLine(TURN[2]), REWRITE)} ${RULE}\n${LIVE_LATE_LINE}`);
    expect(delivered[0].text).toContain(`"${quoteLine(TURN[2])}"`);
    expect(delivered[0].text).toContain(`"${REWRITE}"`);
    // Walnut adds no words of its own in his language: the only non-ASCII is the model's rewrite.
    expect(delivered[0].text.replace(REWRITE, '')).toMatch(/^[\x00-\x7f]*$/);
    expect(delivered[0].text).toMatch(/<walnut-message kind="notification" from="Walnut" outcome="reply-language"/);
    // One more English line: still one correction.
    await replay('w1', TURN.slice(3, 5), false, null);
    expect(delivered).toHaveLength(1);
    // A second line still off after it (2026-11-02: one correction did not hold): the second, quoting that line.
    await replay('w1', [TURN[5]], false, null);
    expect(delivered).toHaveLength(2);
    expect(delivered[1].text).toContain(`"${quoteLine(TURN[5])}"`);
    await replay('w1', [TURN[6]], false, null);
    expect(delivered).toHaveLength(2);
    await replay('w1', [TURN[5]], false, null);
    expect(delivered).toHaveLength(3);
    await replay('w1', [TURN[6], TURN[5], TURN[6], TURN[5]], true, null);
    expect(delivered).toHaveLength(3);
  });

  it('a turn that ends while the rewrite is made gets no correction (it would start a turn of its own)', async () => {
    let release!: () => void;
    _setRewriteForTest(() => new Promise((r) => { release = () => r(REWRITE); }));
    session('w12');
    const run = replay('w12', TURN.slice(0, 3), false);
    await new Promise((r) => setTimeout(r, 20));
    emit(EventNames.SESSION_RESULT, 'w12', { result: '', isError: false });
    release();
    await run;
    await settle();
    expect(delivered).toEqual([]);
  });

    it('without a rewrite in time it quotes the line alone', async () => {
    _setRewriteForTest(async () => null);
    session('w11');
    await replay('w11', TURN.slice(0, 3), false);
    expect(delivered[0].text).toContain(`${liveCorrectionText(quoteLine(TURN[2]))} ${RULE}`);
    expect(delivered[0].text).not.toContain('In it: "');
  });

  it('any rule gets the English correction, quoting too', () => {
    expect(liveCorrectionText('Ich teste jetzt.', 'Je teste maintenant.')).toContain('"Ich teste jetzt."');
  });

  it('a line back in his language after the correction needs no second one', async () => {
    session('w7');
    await replay('w7', TURN.slice(0, 3), false);
    await replay('w7', ['好，同样的负载下旧版每次约 0.5 秒，新版约 1.15 秒。', '下面把新版的时间拆开看。', TURN[4]], true, null);
    expect(delivered).toHaveLength(1);
  });

  it('a short progress line counts ("Chromium 34/34. Now WebKit.")', async () => {
    session('w8');
    await replay('w8', [TURN[0], 'Chromium 34/34. Now WebKit.'], false);
    expect(delivered).toHaveLength(1);
  });

  it('a correction that cannot be delivered is tried at most three times in a turn', async () => {
    session('w10');
    let tries = 0;
    const real = records.get('w10')!;
    records.set('w10', new Proxy(real, { get: (o, k) => { if (k === 'process_status') { tries++; throw new Error('read failed'); } return (o as never)[k]; } }) as never);
    await replay('w10', [TURN[0], ...TURN.slice(2), ...TURN.slice(2), ...TURN.slice(2)]);
    expect(delivered).toEqual([]);
    expect(tries).toBe(3);
  });

  it('a Chinese turn gets nothing', async () => {
    session('w2');
    await replay('w2', [TURN[0], '', '日志和其余 9 个文件都是 0 命中，所以是误报。下面整理失败日志，再对比两个版本。']);
    expect(delivered).toEqual([]);
  });

  it('a turn a notice, another task or a trigger started, and the CLI\'s own turn, are corrected too', async () => {
    // 2026-11-02: a worker's turn a Walnut notice started was English throughout, uncorrected.
    for (const [sid, source] of [['a', 'walnut-notify'], ['e', 'peer'], ['f', 'routine-trigger']] as const) {
      session(sid);
      await replay(sid, TURN.slice(0, 3), true, source);
    }
    // The CLI's own turn (a background command came back): no send since.
    session('d');
    await replay('d', [TURN[0]]);
    await replay('d', TURN.slice(2, 4), true, null);
    expect(delivered.map((d) => d.sid)).toEqual(['a', 'e', 'f', 'd']);
  });

  it('an ACP engine, or a session not running, gets none (the turn end decides)', async () => {
    session('b', { engine: 'codex' } as never);
    session('c', { process_status: 'idle' } as never);
    for (const sid of ['b', 'c']) await replay(sid, TURN.slice(0, 3));
    expect(delivered).toEqual([]);
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

  it('short English lines after the correction still name the turn on the next message', async () => {
    session('w9');
    // One line under the turn end's 40 letters (two would bring the second correction, judged after it).
    await replay('w9', [...TURN.slice(0, 3), 'Chromium 34/34. Now WebKit.']);
    expect(await judge('w9', [...TURN.slice(0, 3), 'Chromium 34/34. Now WebKit.'])).toBeTruthy();
  });

  it('the outcome is read once', async () => {
    session('w6');
    await replay('w6', TURN.slice(0, 3));
    expect(await takeLiveCorrection('w6')).toEqual({ driftAfter: false });
    expect(await takeLiveCorrection('w6')).toBeUndefined();
  });
});

describe('the rewrite shown as the example is the line itself, in the rule language', () => {
  const RULE = 'Talk to the user in Chinese.'
  const LINE = 'The three new scans all fail on the old code and pass on the new code. Next I\'m running the related tests: mail items and threads.'
  it('refuses the fast model\'s own reasoning (2026-11-03: it passed the old check)', () => {
    // Simplified Chinese test data: "I am rewriting a progress line, turning the user's words into Chinese."
    const reasoning = '我正在改写一行进度说明，把用户的话转成中文。 Wait, I should be careful: the instruction is to rewrite "the progress line the user gives" as one short line in Chinese.'
    expect(acceptRewrite(RULE, LINE, reasoning)).toBeNull()
    expect(acceptRewrite(RULE, LINE, `${reasoning.split(' Wait')[0]}\nsecond line`)).toBeNull()
  })
  it('takes a plain translation that keeps the line\'s own names', () => {
    // "The three new scans all fail on the old code and pass on the new code; next I run the related tests: mail items and threads."
    const good = '三条新扫描在旧代码上都失败、在新代码上通过；接下来跑相关测试：邮件条目和 threads。'
    expect(acceptRewrite(RULE, LINE, `「${good}」`)).toBe(good)
  })
  it('refuses one still in the wrong language, or far longer than the line', () => {
    expect(acceptRewrite(RULE, LINE, LINE)).toBeNull()
    expect(acceptRewrite(RULE, 'Done.', '好的'.repeat(40))).toBeNull()
  })
})
