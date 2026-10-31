/**
 * The reply-language correction against a real server (2026-10-31: the Walnut lead answered the
 * user in English though every message carried the reminder). A lead's turn streams a Chinese
 * line, an English progress line between tool calls and a Chinese final reply, the way the CLI's
 * events reach the bus; the server's own hook pipeline marks the drift, and the next message to the
 * lead (a worker's notice, nobody typing) leads its reply-language hint with the correction.
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
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js';
import { updateConfig } from '../../src/core/config-manager.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { prepareHintedSend } from '../../src/core/hints/hint-send.js';

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
    // First message: the rule alone.
    const first = await prepareHintedSend(SID, await getSessionByClaudeId(SID), 'Team update: a worker finished.', { sentBy: 'agent' });
    expect(first.enqueueText).toContain(`Walnut (reply-language): ${RULE}`);
    await first.commit();

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
    expect(next.enqueueText).toMatch(/Walnut \(reply-language\): Correction: your last reply the user read \(the turn that ended \d{2}:\d{2} UTC\) was not in his language\./);
    expect(next.enqueueText).toContain(RULE);
    await next.commit();
    expect((await getSessionByClaudeId(SID))?.hintState?.drift).toBeUndefined();

    const after = await prepareHintedSend(SID, await getSessionByClaudeId(SID), 'Team update: nothing new.', { sentBy: 'agent' });
    expect(after.enqueueText).toContain(`Walnut (reply-language): ${RULE}`);
    expect(after.enqueueText).not.toContain('Correction:');
  });
});
