import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-routing-notice'));
import { WALNUT_HOME } from '../../src/constants.js';
import { addTask, deleteTask, updateTask } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js';
import { stripTaskRoutingNotice, taskRoutingPolicyForSession } from '../../src/core/sessions/task-routing-notice.js';
import { parkMessages } from '../../src/core/session-queue-park.js';
import { TASK_ROUTING_CONTRACT } from '../../src/core/task-routing-contract.js';
import { buildSessionContext } from '../../src/core/sessions/session-context.js';
import { renderSelfKnowledgeContract } from '../../src/core/self-knowledge-contract.js';
import { sendMessageToSession, getQueue, enqueueMessage, resetCache, editMessage, deleteMessage,
  markProcessing, markNextProcessing, revertToPending, removeProcessed } from '../../src/core/session-message-queue.js';
import { collectOpenItems } from '../../src/core/sessions/open-items.js';
import { notePlaceCompaction } from '../../src/core/sessions/place-notice.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});
async function seed(role?: 'main' | 'lead', prompt: string | null = 'Old area-owner routing') {
  const { task } = await addTask({ title: role ?? 'Work', project: role === 'main' ? 'Ask Walnut' : 'marina',
    ...(role ? { org_role: role } : {}), ...(role === 'main' ? { walnut_agent: true } : {}) });
  const sid = randomUUID();
  await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
  if (prompt !== null) await updateSessionRecord(sid, { appliedAppendSystemPrompt: prompt });
  return { sid, task };
}
const copies = (text: string) => text.split(TASK_ROUTING_CONTRACT).length - 1;
async function deliver(sid: string, text: string, pick = markProcessing) {
  await enqueueMessage(sid, text);
  const batch = await pick(sid);
  await removeProcessed(sid, batch.map((row) => row.id));
  return batch;
}

describe('current task routing for an older Main or lead', () => {
  it('a replacement session drops a notice frozen into an old row', async () => {
    const { sid } = await seed('main');
    await sendMessageToSession(sid, 'Keep this request');
    const [row] = await markProcessing(sid);
    expect(stripTaskRoutingNotice(row.message)).toBe('Keep this request');
    expect(stripTaskRoutingNotice('Plain text')).toBe('Plain text');
  });
  it('uses one canonical rule in persona, Main and lead without conflicting worker rules', async () => {
    expect(renderSelfKnowledgeContract()).toContain(TASK_ROUTING_CONTRACT);
    for (const role of ['main', 'lead'] as const) {
      const { task } = await seed(role);
      const context = (await buildSessionContext(task.id)).systemPrompt;
      expect(context).toContain(TASK_ROUTING_CONTRACT);
      expect(context).not.toContain('create a task only when none does');
      expect(context).not.toContain('for detail, or to hand work over');
      if (role === 'lead') {
        expect(context).toContain('that request is the signal to create or continue a task');
        expect(context).not.toContain('New work lands beside yours');
      }
    }
  });
  it('is told once on its first frozen line, again after a compaction or on another prompt', async () => {
    const { sid } = await seed('main');
    const queued = await sendMessageToSession(sid, 'Independent sorting goal', { source: 'web-ui' });
    expect(queued.message).not.toContain(TASK_ROUTING_CONTRACT);
    const [first] = await markProcessing(sid);
    expect(first.message.startsWith('<walnut-message kind="notification"')).toBe(true);
    expect(first.message.endsWith('Independent sorting goal')).toBe(true);
    await removeProcessed(sid, [first.id]);
    expect((await getSessionByClaudeId(sid))?.taskRoutingNoted?.promptHash).toBeTruthy();
    expect(copies((await deliver(sid, 'Additional screenshot'))[0].message)).toBe(0);
    await notePlaceCompaction(sid, 'boundary-1');
    expect(copies((await deliver(sid, 'After compaction'))[0].message)).toBe(1);
    expect(copies((await deliver(sid, 'Later'))[0].message)).toBe(0);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: 'Another old prompt' });
    expect(copies((await deliver(sid, 'On another prompt', markNextProcessing))[0].message)).toBe(1);
    expect(copies((await deliver(sid, 'Then quiet', markNextProcessing))[0].message)).toBe(0);
  });
  it('a frozen line that never reaches the CLI is not told; the claim lapses to a later line', async () => {
    const { sid } = await seed('main');
    await sendMessageToSession(sid, 'Stopped before it was read');
    const frozen = await markProcessing(sid);
    expect(copies(frozen[0].message)).toBe(1);
    // A second freeze while that line is in flight does not carry it again.
    const racing = (await taskRoutingPolicyForSession(sid))!;
    expect(racing.apply('Mid-turn input')).toBe('Mid-turn input');
    // The user stops the session: the line is parked, never delivered.
    expect(await parkMessages(frozen, 'user-stop')).toBe(1);
    expect((await getSessionByClaudeId(sid))?.taskRoutingNoted).toBeUndefined();
    const later = Date.now() + 61_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(copies((await deliver(sid, 'Next input'))[0].message)).toBe(1);
      expect((await getSessionByClaudeId(sid))?.taskRoutingNoted?.version).toBeTruthy();
    } finally { clock.mockRestore(); }
  });
  it('a batch of queued rows carries the rules once, at the head', async () => {
    const { sid } = await seed('main');
    for (const text of ['One', 'Two', 'Three']) await sendMessageToSession(sid, text);
    const batch = await markProcessing(sid);
    expect(batch).toHaveLength(3);
    const line = batch.map((row) => row.message).join('\n\n');
    expect(copies(line)).toBe(1);
    expect(line.startsWith('<walnut-message kind="notification"')).toBe(true);
  });
  it('a slash command reaches the CLI as typed and does not count as told', async () => {
    const { sid } = await seed('lead');
    for (const pick of [markProcessing, markNextProcessing]) {
      const [row] = await deliver(sid, '  /compact', pick);
      expect(row.message).toBe('  /compact');
    }
    expect((await getSessionByClaudeId(sid))?.taskRoutingNoted).toBeUndefined();
    expect(copies((await deliver(sid, 'Plain input'))[0].message)).toBe(1);
  });
  it.each([markProcessing, markNextProcessing])('edit A then deliver it immediately retains current rules (%#)', async (pick) => {
    const { sid } = await seed('main');
    const row = await sendMessageToSession(sid, 'Original input');
    expect(await editMessage(sid, row.id, 'Edited input')).toBe(true);
    const batch = await pick(sid);
    expect(batch).toHaveLength(1);
    expect(batch[0].message).toContain(TASK_ROUTING_CONTRACT);
    expect(batch[0].message).toContain('Edited input');
    expect(batch[0].message).not.toContain('Original input');
  });
  it('delete A then deliver already-queued B with no new send', async () => {
    const { sid } = await seed('lead');
    const a = await sendMessageToSession(sid, 'Input A');
    const b = await enqueueMessage(sid, 'Input B');
    expect(await deleteMessage(sid, a.id)).toBe(true);
    const batch = await markProcessing(sid);
    expect(batch.map((row) => row.id)).toEqual([b.id]);
    expect(batch[0].message).toContain(TASK_ROUTING_CONTRACT);
    expect(batch[0].message).toContain('Input B');
  });
  it('editing and freezing race under the same queue lock without losing policy', async () => {
    const { sid } = await seed('main');
    const row = await enqueueMessage(sid, 'Original');
    const [edited, batch] = await Promise.all([editMessage(sid, row.id, 'Changed'), markProcessing(sid)]);
    expect(batch[0].message).toContain(TASK_ROUTING_CONTRACT);
    expect(batch[0].message).toContain(edited ? 'Changed' : 'Original');
    expect(await deleteMessage(sid, row.id)).toBe(false);
  });
  it('a row quoting the notice in its body still gets a formal leading notice', async () => {
    const { sid } = await seed('main');
    const policy = (await taskRoutingPolicyForSession(sid))!.text;
    await enqueueMessage(sid, `User quote:\n${policy}`);
    const batch = await markProcessing(sid);
    expect(batch[0].message.startsWith(policy)).toBe(true);
    expect(batch[0].message.split(policy)).toHaveLength(3);
  });
  it('queue reload and same-id crash retry preserve frozen bytes and line identity', async () => {
    const { sid } = await seed('main');
    await enqueueMessage(sid, 'Request', { id: 'qm-routing-replay' });
    const first = await markProcessing(sid);
    const bytes = first[0].message;
    const line = first[0].lineUuid;
    expect(copies(bytes)).toBe(1);
    await revertToPending(first);
    resetCache();
    // Whatever the record says now, a written line keeps its bytes.
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: 'Yet another old prompt', taskRoutingNoted: undefined });
    await sendMessageToSession(sid, 'Request', { messageId: 'qm-routing-replay' });
    const second = await markProcessing(sid);
    expect(second).toHaveLength(1);
    expect(second[0].message).toBe(bytes);
    expect(second[0].lineUuid).toBe(line);
    await removeProcessed(sid, second.map((row) => row.id));
    expect(await getQueue(sid)).toHaveLength(0);
  });
  it('batch order and explicit user UUID splitting stay intact', async () => {
    const { sid } = await seed('main');
    const a = await enqueueMessage(sid, 'First', { userUuid: randomUUID() });
    const b = await enqueueMessage(sid, 'Second', { userUuid: randomUUID() });
    const first = await markProcessing(sid);
    expect(first.map((row) => row.id)).toEqual([a.id]);
    await removeProcessed(sid, [a.id]);
    expect((await markProcessing(sid)).map((row) => row.id)).toEqual([b.id]);
  });
  it('a stale trigger is annotated before the routing policy freezes its body', async () => {
    const { sid } = await seed('main');
    const row = await sendMessageToSession(sid, '<walnut-message kind="trigger">\nOld state\n</walnut-message>');
    expect(row.message.startsWith('<walnut-message kind="trigger"')).toBe(true);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(row.enqueuedAt) + 2 * 60 * 60_000);
    try {
      const batch = await markProcessing(sid);
      expect(batch[0].message).toContain('so what it reports may be out of date');
      expect(batch[0].message).toContain(TASK_ROUTING_CONTRACT);
      await revertToPending(batch);
      resetCache();
      clock.mockReturnValue(Date.parse(row.enqueuedAt) + 3 * 60 * 60_000);
      const retry = await markProcessing(sid);
      expect(retry[0].message).toBe(batch[0].message);
      expect(retry[0].lineUuid).toBe(batch[0].lineUuid);
    } finally { clock.mockRestore(); }
  });
  it('place and routing notes coexist without breaking place acknowledgment', async () => {
    const { sid, task } = await seed('lead');
    await updateTask(task.id, { project: 'other' });
    await sendMessageToSession(sid, 'Input');
    const [row] = await markProcessing(sid);
    expect(row.message).toContain('outcome="moved"');
    expect(row.message).toContain('outcome="task-routing-policy"');
    expect((await getSessionByClaudeId(sid))?.placeNoted?.project).toBe('other');
    await removeProcessed(sid, [row.id]);
    const next = await sendMessageToSession(sid, 'Next input');
    expect(next.message).not.toContain('outcome="moved"');
  });
  it('stays silent for workers, current prompts, ACP engines, an unknown prompt and a deleted task', async () => {
    for (const role of [undefined, 'main', 'lead'] as const) {
      const { sid } = await seed(role, role ? TASK_ROUTING_CONTRACT : 'Old worker');
      expect(await taskRoutingPolicyForSession(sid)).toBeNull();
      expect(copies((await deliver(sid, 'Plain input'))[0].message)).toBe(0);
    }
    const acp = await seed('lead');
    await updateSessionRecord(acp.sid, { engine: 'codex' });
    expect(await taskRoutingPolicyForSession(acp.sid)).toBeNull();
    expect(await taskRoutingPolicyForSession((await seed('main', null)).sid)).toBeNull();
    const gone = await seed('lead');
    await deleteTask(gone.task.id);
    expect(await taskRoutingPolicyForSession(gone.sid)).toBeNull();
    // A repaired persona on the record is not what the live CLI runs on.
    const old = await seed('main');
    await updateSessionRecord(old.sid, { profile: { systemPrompt: TASK_ROUTING_CONTRACT } });
    expect(await taskRoutingPolicyForSession(old.sid)).not.toBeNull();
  });
  it('the compaction hook restates the rules even when told, and that counts as told in either order', async () => {
    const { sid } = await seed('main');
    expect(copies((await deliver(sid, 'First'))[0].message)).toBe(1);
    // Hook first, then the server reads the boundary.
    expect((await collectOpenItems(sid, Date.now(), { afterCompaction: true })).text).toContain(TASK_ROUTING_CONTRACT);
    await notePlaceCompaction(sid, 'one');
    expect(copies((await deliver(sid, 'After hook then boundary'))[0].message)).toBe(0);
    // Boundary first, then the hook.
    await notePlaceCompaction(sid, 'two');
    expect((await collectOpenItems(sid, Date.now(), { afterCompaction: true })).text).toContain(TASK_ROUTING_CONTRACT);
    expect(copies((await deliver(sid, 'After boundary then hook'))[0].message)).toBe(0);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: TASK_ROUTING_CONTRACT });
    expect((await collectOpenItems(sid, Date.now(), { afterCompaction: true })).text).not.toContain(TASK_ROUTING_CONTRACT);
  });
});
