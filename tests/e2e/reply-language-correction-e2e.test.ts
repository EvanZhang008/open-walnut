/**
 * The reply-language correction against a real server (2026-10-31: the Walnut lead answered the
 * user in English though every message carried the reminder). A lead's turn streams a Chinese
 * line, an English progress line between tool calls and a Chinese final reply, the way the CLI's
 * events reach the bus; the server's own hook pipeline marks the drift, and the next message to the
 * lead (a worker's notice, nobody typing) carries the reply-language hint led by the correction.
 * 2026-11-05, the user: the hint never rides every message (only at start, after a compaction, on a
 * change and after a drift), and every correction is Walnut's English followed by his own rule.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('reply-language-correction-e2e', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js';
import { getQueue, markProcessing, removeProcessed, sendMessageToSession } from '../../src/core/session-message-queue.js';
import { updateConfig } from '../../src/core/config-manager.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { prepareHintedSend } from '../../src/core/hints/hint-send.js';
import { REPLY_LANGUAGE_SCOPE, replyLanguageCorrection } from '../../src/core/hints/hint-origin.js';
import { liveCorrectionText, quoteLine } from '../../src/core/hints/hint-drift-live.js';

const SID = 'correction-lead-session';
let leadId = '';
const RULE = 'Talk to the user in Chinese; code, commits, UI strings and repo docs stay English.';

const emit = (name: string, data: Record<string, unknown>) =>
  bus.emit(name as never, { sessionId: SID, taskId: leadId, ...data } as never, ['main-ai'], { source: 'session-runner' });

async function until<T>(read: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  await startServer({ port: 0, dev: true }) as Server;
  await updateConfig({ session: { reply_language: RULE } });
  const lead = (await addTask({ title: 'Walnut lead', project: 'Walnut', source: 'local', org_role: 'lead' } as never)).task;
  leadId = lead.id;
  await createSessionRecord(SID, lead.id, 'Walnut');
});
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('a lead\'s English progress line', () => {
  it('is caught at the turn end, and the next notice opens with the correction, once', async () => {
    // First message: the rule alone, nothing of Walnut's in front of it.
    const first = await prepareHintedSend(SID, await getSessionByClaudeId(SID), 'Team update: a worker finished.', { sentBy: 'agent' });
    expect(first.enqueueText).toContain(`Walnut (reply-language): ${RULE} ${REPLY_LANGUAGE_SCOPE}`);
    await first.commit();
    // A later plain notice carries nothing (2026-11-05: never on every message).
    const plain = await prepareHintedSend(SID, await getSessionByClaudeId(SID), 'Team update: a review started.', { sentBy: 'agent' });
    expect(plain.enqueueText).not.toContain('Walnut (reply-language)');
    await plain.commit();

    emit(EventNames.SESSION_SEND, { message: 'Team update: a worker finished.' });
    emit(EventNames.SESSION_TEXT_DELTA, { delta: '日志和其余 9 个文件都是 0 命中，所以审计报的是一个误报。下面整理失败日志。', msgId: 'msg_a' });
    emit(EventNames.SESSION_TOOL_USE, { toolName: 'Bash', toolUseId: 'tu1', input: {} });
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'Two artifacts downloaded in full. ', msgId: 'msg_b' });
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'Deleting the public copies now, then scanning them locally.', msgId: 'msg_b' });
    emit(EventNames.SESSION_TEXT_DELTA, { delta: '四个红分别属于四个任务，都已转给各自负责的任务。', msgId: 'msg_c' });
    emit(EventNames.SESSION_RESULT, { result: '四个红分别属于四个任务，都已转给各自负责的任务。', isError: false });

    const driftAt = await until(async () => (await getSessionByClaudeId(SID))?.hintState?.drift?.['reply-language']);
    expect(Date.parse(driftAt)).toBeGreaterThan(0);

    const next = await prepareHintedSend(SID, await getSessionByClaudeId(SID), 'Team update: another worker is waiting on CI.', { sentBy: 'agent' });
    expect(next.enqueueText).toContain(`Walnut (reply-language): ${replyLanguageCorrection(driftAt)} ${RULE} ${REPLY_LANGUAGE_SCOPE}`);
    await next.commit();
    expect((await getSessionByClaudeId(SID))?.hintState?.drift).toBeUndefined();

    const after = await prepareHintedSend(SID, await getSessionByClaudeId(SID), 'Team update: nothing new.', { sentBy: 'agent' });
    expect(after.enqueueText).not.toContain('Walnut (reply-language)');
  });
});

describe('a person\'s turn in a worker\'s session (2026-11-01, the user\'s "what the hack?")', () => {
  const WSID = 'correction-worker-session';
  it('only his first message carries the rule; the first English progress line is corrected mid-turn, once', async () => {
    const worker = (await addTask({ title: 'A worker', project: 'Walnut', source: 'local', parent_task_id: leadId } as never)).task;
    await createSessionRecord(WSID, worker.id, 'Walnut');
    // His messages, typed in the web app the way session:send sends them (web/routes/session-chat.ts):
    // hinted as a person's, queued with source ui. The first (session start) carries the rule, the
    // second does not (2026-11-05: a person's message is no reason of its own).
    for (const [text, carries] of [['Look into it.', true], ['what the hack?', false]] as const) {
      const hinted = await prepareHintedSend(WSID, await getSessionByClaudeId(WSID), text, { sentBy: 'person' });
      await sendMessageToSession(WSID, text, { source: 'ui', enqueueMessage: hinted.enqueueText, hinted: true });
      await hinted.commit();
      const batch = await markProcessing(WSID);
      expect(batch.map((q) => q.message).join('\n').includes(RULE), text).toBe(carries);
      await removeProcessed(WSID, batch.map((q) => q.id));
    }
    await updateSessionRecord(WSID, { process_status: 'running' } as never);
    const w = (name: string, data: Record<string, unknown>) =>
      bus.emit(name as never, { sessionId: WSID, taskId: worker.id, ...data } as never, ['main-ai'], { source: 'session-runner' });
    w(EventNames.SESSION_TEXT_DELTA, { delta: '是慢得离谱。我直接拆开看那 1 秒花在哪：', msgId: 'w1' });
    w(EventNames.SESSION_TOOL_USE, { toolName: 'Bash', toolUseId: 'b1', input: {} });
    w(EventNames.SESSION_TEXT_DELTA, { delta: "The machine load just dropped from about 90 to 26, so I'm re-measuring old vs new back to back:", msgId: 'w2' });
    w(EventNames.SESSION_TOOL_USE, { toolName: 'Bash', toolUseId: 'b2', input: {} });
    const row = await until(async () => (await getQueue(WSID)).find((q) => q.message.includes('outcome="reply-language"')));
    // Walnut's English correction quoting the line (no fast model in tests: no rewrite), then his rule.
    expect(row.message).toContain(`${liveCorrectionText(quoteLine("The machine load just dropped from about 90 to 26, so I'm re-measuring old vs new back to back:"))} ${RULE}`);
    w(EventNames.SESSION_TEXT_DELTA, { delta: 'Under the same load the old version takes about half a second per click, the new one more than one.', msgId: 'w3' });
    w(EventNames.SESSION_TOOL_USE, { toolName: 'Bash', toolUseId: 'b3', input: {} });
    await new Promise((r) => setTimeout(r, 500));
    expect((await getQueue(WSID)).filter((q) => q.message.includes('outcome="reply-language"'))).toHaveLength(1);
  });
});
