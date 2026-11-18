import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-instruction-slice'));
import { USER_FILE, WALNUT_HOME } from '../../src/constants.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js';
import { buildHostSlice } from '../../src/core/host-slice.js';
import { markNextProcessing, markProcessing, removeProcessed, sendMessageToSession } from '../../src/core/session-message-queue.js';
import { refreshUserProfile } from '../../src/core/sessions/user-profile-context.js';
import { instructionNoticeForHost, noteInstructionNoticeToldByHost } from '../../src/core/sessions/instruction-notice.js';
import { notePlaceCompaction } from '../../src/core/sessions/place-notice.js';
import { TEAM_CHARTER } from '../../src/core/team-charter.js';
import { buildSessionContext } from '../../src/core/sessions/session-context.js';

const RELAY = TEAM_CHARTER.split('\n').find((l) => l.startsWith("- When you pass on the user's request"))!;
const current = async (taskId: string) => (await buildSessionContext(taskId)).systemPrompt;
const withoutRelay = async (taskId: string) => (await current(taskId)).split('\n').filter((l) => l !== RELAY).join('\n');

beforeEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
describe('server supplies changed instructions to old host-local sessions', () => {
  it('the slice carries the rule only while due, and a host delivery under that key makes it told', async () => {
    const { task } = await addTask({ title: 'Main', project: 'Ask Walnut', walnut_agent: true, org_role: 'main' });
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: await withoutRelay(task.id) });
    const row = async () => (await buildHostSlice('__local__')).sessions.find((r) => r.sid === sid);
    const due = await row();
    expect(due?.taskRoutingPolicy).toContain(RELAY);
    expect(due?.taskRoutingDue).toBeTruthy();
    // A stale key (the prompt or compaction moved on) records nothing.
    await noteInstructionNoticeToldByHost(sid, 'not-the-current-key');
    expect((await row())?.taskRoutingDue).toBe(due?.taskRoutingDue);
    await noteInstructionNoticeToldByHost(sid, due!.taskRoutingDue!);
    expect(await row()).not.toHaveProperty('taskRoutingPolicy');
    // The server's own queue now leaves it out too.
    await sendMessageToSession(sid, 'Next notice');
    const [line] = await markProcessing(sid);
    expect(line.message).not.toContain(RELAY);
    await removeProcessed(sid, [line.id]);
    // A compaction makes it due again, under a new key.
    await notePlaceCompaction(sid, 'boundary-1');
    const again = await row();
    expect(again?.taskRoutingDue).toBeTruthy();
    expect(again?.taskRoutingDue).not.toBe(due?.taskRoutingDue);
    // A line the server delivers itself also makes it told.
    await sendMessageToSession(sid, 'After compaction');
    const [led] = await markProcessing(sid);
    expect(led.message).toContain(RELAY);
    await removeProcessed(sid, [led.id]);
    expect(await row()).not.toHaveProperty('taskRoutingPolicy');
  });
  it('an idle session carries no notice bytes; it is told when a line reaches it later', async () => {
    const { task } = await addTask({ title: 'Idle worker', project: 'Mobile' });
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: await withoutRelay(task.id), process_status: 'stopped' });
    const record = (await getSessionByClaudeId(sid))!;
    const later = Date.parse(record.lastActiveAt) + 2 * 24 * 60 * 60_000;
    expect(instructionNoticeForHost(record, task, later)).toBeNull();
    expect(instructionNoticeForHost({ ...record, process_status: 'running' }, task, later)?.policy).toContain(RELAY);
    await sendMessageToSession(sid, 'Wake up');
    const [line] = await markProcessing(sid);
    expect(line.message).toContain(RELAY);
    await removeProcessed(sid, [line.id]);
  });
  it('a notice the server has on its way keeps the host from adding a second', async () => {
    const { task } = await addTask({ title: 'Busy worker', project: 'Mobile' });
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: await withoutRelay(task.id) });
    const row = async () => (await buildHostSlice('__local__')).sessions.find((r) => r.sid === sid);
    expect((await row())?.taskRoutingPolicy).toContain(RELAY);
    await sendMessageToSession(sid, 'Server line');
    const [line] = await markProcessing(sid);
    expect(line.message).toContain(RELAY);
    expect(await row()).not.toHaveProperty('taskRoutingPolicy');
    await removeProcessed(sid, [line.id]);
    expect(await row()).not.toHaveProperty('taskRoutingPolicy');
  });
  it('current prompts add no notice bytes', async () => {
    for (const role of [undefined, 'main', 'lead'] as const) {
      const { task } = await addTask({ title: role ?? 'Worker', project: role === 'main' ? 'Ask Walnut' : 'Mobile',
        ...(role ? { org_role: role } : {}), ...(role === 'main' ? { walnut_agent: true } : {}) });
      const sid = randomUUID();
      await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
      await updateSessionRecord(sid, { appliedAppendSystemPrompt: await current(task.id) });
    }
    for (const row of (await buildHostSlice('__local__')).sessions) expect(row).not.toHaveProperty('taskRoutingPolicy');
  });
});

describe('one version of the user\'s profile reaches a remote session once (2026-11-18)', () => {
  // The org review read two notices of USER.md vf2088c0b in one clouddev session, 3 minutes apart
  // and the second mid-turn, as a lost "told" record. The transcript showed a compaction between
  // them: told once per compaction boundary is the rule. Pinned here on every path a line takes:
  // the server's queue (first line and a mid-turn one), the host's own delivery, and a compaction.
  const RULE = 'A rule the user gave while the session ran, worded the way real ones are.'
  const user = async (rules: string[]) => {
    await fs.mkdir(path.dirname(USER_FILE), { recursive: true })
    await fs.writeFile(USER_FILE, `---\nname: User Profile\n---\n\n## Standing rules\n${rules.map((r) => `- ${r}`).join('\n')}\n`)
    await new Promise((r) => setTimeout(r, 15))
    await refreshUserProfile()
  }
  const BASE = Array.from({ length: 8 }, (_, i) => `Standing rule ${i + 1}, kept as it is across every save of the profile.`)

  it('told on its first line, never on a mid-turn line or by the host after it; once more only after a compaction', async () => {
    await user(BASE)
    const { task } = await addTask({ title: 'Remote worker', project: 'marina' })
    const sid = randomUUID()
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME)
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: await current(task.id), host: 'clouddev', process_status: 'running' })
    const hostNotice = async () => instructionNoticeForHost((await getSessionByClaudeId(sid))!, task)
    const line = async (text: string, pick = markProcessing) => {
      await sendMessageToSession(sid, text)
      const [row] = await pick(sid)
      await removeProcessed(sid, [row.id])
      return row.message
    }
    const copies = (text: string) => text.split(RULE).length - 1
    expect(await hostNotice()).toBeNull()

    await user([...BASE, RULE])
    expect(copies(await line('First line after the save'))).toBe(1)
    expect(copies(await line('Injected mid-turn', markNextProcessing))).toBe(0)
    expect(await hostNotice()).toBeNull()

    // The next save reaches the session through its host's own delivery: told there once, then by nobody.
    const NEXT = 'Another rule the user gave a little later, also worded like a real one.'
    await user([...BASE, RULE, NEXT])
    const due = (await hostNotice())!
    expect(due.policy).toContain(NEXT)
    expect(due.policy).not.toContain(RULE)
    await noteInstructionNoticeToldByHost(sid, due.due)
    expect(await hostNotice()).toBeNull()
    expect((await line('After the host told it', markNextProcessing)).includes(NEXT)).toBe(false)

    // A compaction drops what was told: the next line restates it once, and only once.
    await notePlaceCompaction(sid, 'boundary-1')
    const restated = await line('First line after the compaction', markNextProcessing)
    expect(copies(restated)).toBe(1)
    expect(restated).toContain(NEXT)
    expect(copies(await line('Mid-turn after it', markNextProcessing))).toBe(0)
    expect(await hostNotice()).toBeNull()
  })
})
