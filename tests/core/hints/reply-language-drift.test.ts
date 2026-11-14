/**
 * The reply language, corrected only on a drift (src/core/hints/reply-language-drift.ts),
 * replayed on the shape of real turns (2026-11-14, the org reflection): the user typed English
 * ("wait a min beeta preivosu we ahve a issue for one clsuter how is it now") and the agent's
 * progress lines and reply went English to the end. Pins:
 *   - an English line in a turn a person started gets ONE correction mid-turn, at the tool call
 *     after it, quoting the line, in Walnut's English plus the user's rule;
 *   - a Chinese turn gets nothing, and code blocks, paths and identifiers do not count;
 *   - a turn another task or Walnut started is not judged;
 *   - a turn still off at its end marks the drift for the next message; one that came back after
 *     the correction does not; a clean turn clears an older mark;
 *   - a letter off the language gets a note, one in it gets none.
 *
 * Would fail if reverted: without the module no correction goes out and no drift is marked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/core/types.js';

const RULE = 'Talk to the user in Chinese.';
let config: Record<string, unknown> = { session: { reply_language: RULE } };
const records = new Map<string, SessionRecord>();
const delivered: Array<{ sid: string; text: string; source: string }> = [];
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => config }));
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
import {
  LIVE_LATE_LINE, _settledForTest, letterLanguageNote, liveCorrectionText, quoteLine,
  startReplyLanguageDrift, stopReplyLanguageDrift,
} from '../../../src/core/hints/reply-language-drift.js';

const ENGLISH = [
  "Yes, CPU went down too. Let me pull the per-process numbers to confirm it's the indexer:",
  'The cluster in beta recovered at 06:40 and has been healthy since. Checking the alarms now:',
  'Both alarms cleared, nothing is paging, and the retry queue drained back to zero.',
];
const CHINESE = [
  '是的，CPU 也降下来了。我看一下每个进程的数字，确认是不是索引器：',
  'beta 那个集群 06:40 恢复了，之后一直正常。现在看一下告警：',
  '两个告警都清了，没有在报警，重试队列也回到 0 了。',
];

const emit = (name: string, sid: string, data: Record<string, unknown>) =>
  bus.emit(name as never, { sessionId: sid, ...data } as never, ['main-ai'], { source: 'session-runner' });

let msgSeq = 0;
/** One turn: each line streamed in two deltas, then a Bash call; then the result. */
async function replay(sid: string, lines: readonly string[], end = true) {
  for (const line of lines) {
    const n = ++msgSeq;
    if (line) for (const delta of [line.slice(0, 15), line.slice(15)]) emit(EventNames.SESSION_TEXT_DELTA, sid, { delta, msgId: `msg_${n}` });
    emit(EventNames.SESSION_TOOL_USE, sid, { toolName: 'Bash', toolUseId: `tu_${n}` });
    await _settledForTest();
  }
  if (end) { emit(EventNames.SESSION_RESULT, sid, { result: lines[lines.length - 1] ?? '', isError: false }); await _settledForTest(); }
}

const session = (sid: string, lastSendBy: 'person' | 'agent' = 'person', o: Partial<SessionRecord> = {}) => records.set(sid, {
  claudeSessionId: sid, taskId: `t-${sid}`, process_status: 'running', engine: 'claude',
  hintState: { sends: 4, told: {}, lastSendBy }, ...o,
} as unknown as SessionRecord);
const driftOf = (sid: string) => records.get(sid)?.hintState?.drift?.['reply-language'];

beforeEach(() => {
  records.clear(); delivered.length = 0;
  config = { session: { reply_language: RULE } };
  startReplyLanguageDrift();
});
afterEach(() => stopReplyLanguageDrift());

describe('inside a turn a person started', () => {
  it('the first English line gets one correction at the next tool call, quoting it', async () => {
    session('s1');
    await replay('s1', ENGLISH.slice(0, 1), false);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].source).toBe('walnut-notify');
    expect(delivered[0].text).toContain(liveCorrectionText(quoteLine(ENGLISH[0])));
    expect(delivered[0].text).toContain(RULE);
    expect(delivered[0].text).toContain(LIVE_LATE_LINE);
    expect(delivered[0].text).toContain('outcome="reply-language"');
  });

  it('a whole English turn: at most two corrections, and the drift is marked for the next message', async () => {
    session('s2');
    await replay('s2', [...ENGLISH, ...ENGLISH]);
    expect(delivered).toHaveLength(2);
    expect(driftOf('s2')).toBeTruthy();
  });

  it('a Chinese turn gets nothing and marks nothing', async () => {
    session('s3');
    await replay('s3', CHINESE);
    expect(delivered).toHaveLength(0);
    expect(driftOf('s3')).toBeUndefined();
  });

  it('code blocks, inline code, paths and links do not count against a Chinese line', async () => {
    session('s4');
    const line = '改好了，测试都过了：\n```ts\nexport function detectLanguageDrift(rule: string, reply: string): boolean { return languageDrift(rule, reply) === true }\n```\n见 `src/core/hints/reply-language-drift.ts` 和 https://example.invalid/some/long/english/path';
    await replay('s4', [line]);
    expect(delivered).toHaveLength(0);
    expect(driftOf('s4')).toBeUndefined();
  });

  it('back to Chinese after the correction: no mark at the end', async () => {
    session('s5');
    await replay('s5', [ENGLISH[0], ...CHINESE]);
    expect(delivered).toHaveLength(1);
    expect(driftOf('s5')).toBeUndefined();
  });

  it('a one-message English reply (no tool call) marks the drift', async () => {
    session('s6');
    emit(EventNames.SESSION_TEXT_DELTA, 's6', { delta: ENGLISH[2], msgId: 'only' });
    emit(EventNames.SESSION_RESULT, 's6', { result: ENGLISH[2], isError: false });
    await _settledForTest();
    expect(delivered).toHaveLength(0);
    expect(driftOf('s6')).toBeTruthy();
  });

  it('a clean turn clears an older mark', async () => {
    session('s7', 'person', { hintState: { sends: 4, told: {}, lastSendBy: 'person', drift: { 'reply-language': '2026-11-14T00:00:00.000Z' } } } as never);
    await replay('s7', CHINESE);
    expect(driftOf('s7')).toBeUndefined();
  });

  it('an ACP engine gets no mid-turn line; its turn end still marks the drift', async () => {
    session('s8', 'person', { engine: 'codex' } as never);
    await replay('s8', ENGLISH);
    expect(delivered).toHaveLength(0);
    expect(driftOf('s8')).toBeTruthy();
  });
});

describe('the VP reply of 2026-11-14 17:08Z (reported as a false positive)', () => {
  // As the transcript holds it: English prose, so a true positive.
  const SENT = "I've handed it to the inbox task: use the side-by-side, left-and-right panel layout and add a switch between compact and roomy. The whole card still grows on hover, and your compact choice is remembered.\n\nIt won't start yet: the task runs on devbox, and new sign-ins to devbox have been refused since the SSH certificate expired at 07:20Z. Once you renew it with ssh-keygen on the Mac, the message goes out by itself and the work starts.\n\n<walnut-about tasks=\"322aae38-819c-58e8-a497-b0fd5e088d16\"/>";
  // The same reply in Chinese with its English names (devbox, SSH, ssh-keygen, 07:20Z, panel): it passes.
  // It reads: handed to the inbox task, left and right two panels plus a compact switch; it starts
  // once ssh-keygen renews the SSH certificate of devbox, which expired at 07:20Z.
  const CHINESE_WITH_NAMES = '已交给收件箱任务：按你说的"左右两个 panel"排，再加一个 compact / 宽松的切换，悬停时整张卡片变大，你选的 compact 会记住。\n\n现在还开不了：这个任务在 devbox 上跑，devbox 的 SSH 证书 07:20Z 过期后新登录都被拒了。你在 Mac 上跑一次 ssh-keygen 续期，消息会自己发出去，活就开始了。\n\n<walnut-about tasks="322aae38-819c-58e8-a497-b0fd5e088d16"/>';

  it('Chinese prose with English host names, tool names and times passes', async () => {
    session('v1');
    emit(EventNames.SESSION_TEXT_DELTA, 'v1', { delta: CHINESE_WITH_NAMES, msgId: 'r' });
    emit(EventNames.SESSION_RESULT, 'v1', { result: CHINESE_WITH_NAMES, isError: false });
    await _settledForTest();
    expect(driftOf('v1')).toBeUndefined();
  });

  it('the English reply as sent is marked, and the next message quotes it', async () => {
    const { offLineOf } = await import('../../../src/core/hints/reply-language-quote.js');
    session('v2');
    emit(EventNames.SESSION_TEXT_DELTA, 'v2', { delta: SENT, msgId: 'r' });
    emit(EventNames.SESSION_RESULT, 'v2', { result: SENT, isError: false });
    await _settledForTest();
    expect(driftOf('v2')).toBeTruthy();
    expect(offLineOf('v2')).toMatch(/^I've handed it to the inbox task/);
    const { effectiveHints } = await import('../../../src/core/hints/hint-registry.js');
    const hint = effectiveHints(config as never).find((h) => h.kind === 'reply-language')!;
    const out = hint.render({ config: config as never, record: { claudeSessionId: 'v2', hintState: records.get('v2')!.hintState } } as never, new Set(['on_drift']))!;
    expect(out.text).toContain('It was: "I\'ve handed it to the inbox task');
  });
});

describe('who started the turn, from the rows delivered for it', () => {
  const queued = (sid: string, messageId: string, sentBy: 'person' | 'agent') => emit(EventNames.SESSION_MESSAGE_QUEUED, sid, { messageId, sentBy });
  const deliveredRows = (sid: string, ids: string[]) => emit(EventNames.SESSION_MESSAGES_DELIVERED, sid, { messageIds: ids, count: ids.length });

  it('a person\'s row delivered into an agent\'s turn makes the rest of it his', async () => {
    session('d1', 'agent');
    await replay('d1', ENGLISH.slice(0, 1), false);
    expect(delivered).toHaveLength(0);
    queued('d1', 'qm-p', 'person');
    deliveredRows('d1', ['qm-p']);
    await replay('d1', ENGLISH.slice(1, 2), false);
    expect(delivered).toHaveLength(1);
  });

  it('an agent\'s row opening the turn wins over an older person mark on the record', async () => {
    session('d2', 'person');
    queued('d2', 'qm-a', 'agent');
    deliveredRows('d2', ['qm-a']);
    await replay('d2', ENGLISH);
    expect(delivered).toHaveLength(0);
    expect(driftOf('d2')).toBeUndefined();
  });

  it('a person\'s row opening the turn counts though the record says agent', async () => {
    session('d3', 'agent');
    queued('d3', 'qm-p3', 'person');
    deliveredRows('d3', ['qm-p3']);
    await replay('d3', ENGLISH.slice(0, 1));
    expect(delivered).toHaveLength(1);
  });
});

describe('what is not judged', () => {
  it('a turn another task or Walnut started', async () => {
    session('a1', 'agent');
    await replay('a1', ENGLISH);
    expect(delivered).toHaveLength(0);
    expect(driftOf('a1')).toBeUndefined();
  });

  it('an override that dropped the on_drift trigger turns the check off', async () => {
    config = { session: { reply_language: RULE, hints: { 'reply-language': { triggers: [] } } } };
    session('a5');
    await replay('a5', ENGLISH);
    expect(delivered).toHaveLength(0);
    expect(driftOf('a5')).toBeUndefined();
  });

  it('an empty Reply language setting, or the hint switched off', async () => {
    config = { session: {} };
    session('a2');
    await replay('a2', ENGLISH);
    stopReplyLanguageDrift(); startReplyLanguageDrift();
    config = { session: { reply_language: RULE, hints: { 'reply-language': { enabled: false } } } };
    session('a3');
    await replay('a3', ENGLISH);
    expect(delivered).toHaveLength(0);
    expect(driftOf('a2')).toBeUndefined();
    expect(driftOf('a3')).toBeUndefined();
  });

  it('a subagent lane and short lines', async () => {
    session('a4');
    emit(EventNames.SESSION_TEXT_DELTA, 'a4', { delta: ENGLISH[0], msgId: 'sub', parentToolUseId: 'tu_x' });
    emit(EventNames.SESSION_TEXT_DELTA, 'a4', { delta: 'OK.', msgId: 'short' });
    emit(EventNames.SESSION_TOOL_USE, 'a4', { toolName: 'Bash', toolUseId: 'tu_y' });
    await _settledForTest();
    expect(delivered).toHaveLength(0);
  });
});

describe('letters', () => {
  it('an English letter gets the note, a Chinese one none', async () => {
    const note = await letterLanguageNote(['For you: Re: Intro call', "Recruiter replied to the person's own question about interview timing; only the person can reply or pick interview times."]);
    expect(note).toContain('this letter is not in the user\'s language');
    expect(note).toContain(RULE);
    expect(await letterLanguageNote(['给你：面试时间', '招聘方回复了你问的面试时间，只有你能回复或选时间。另一个改期请求还在等你。'])).toBeNull();
  });

  it('html markup, styles and inline media do not count', async () => {
    const html = `<html><head><style>body { font-family: system-ui; color: #333; background: white; }</style></head><body><p>两个告警都清了，重试队列回到 0。</p><img src="data:image/png;base64,${'A'.repeat(50_000)}"></body></html>`;
    expect(await letterLanguageNote(['告警已恢复', html])).toBeNull();
  });

  it('a style block cut before its end does not count', async () => {
    const cut = `<style>${'.row { display: flex; align-items: center; justify-content: space-between; }\n'.repeat(400)}`;
    expect(await letterLanguageNote(['告警已恢复，重试队列回到 0，两个集群都正常。', cut])).toBeNull();
  });

  it('nothing to judge, or no setting: no note', async () => {
    expect(await letterLanguageNote([undefined, '', 42])).toBeNull();
    config = { session: {} };
    stopReplyLanguageDrift();
    expect(await letterLanguageNote([ENGLISH[0]])).toBeNull();
  });
});
