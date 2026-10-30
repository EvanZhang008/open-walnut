import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-instruction-notice'));
import { WALNUT_HOME } from '../../src/constants.js';
import { addTask, deleteTask, updateTask } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js';
import { stripInstructionNotice, instructionNoticeForSession } from '../../src/core/sessions/instruction-notice.js';
import { parkMessages } from '../../src/core/session-queue-park.js';
import { TASK_ROUTING_CONTRACT } from '../../src/core/task-routing-contract.js';
import { TEAM_CHARTER } from '../../src/core/team-charter.js';
import { buildSessionContext } from '../../src/core/sessions/session-context.js';
import { renderSelfKnowledgeContract } from '../../src/core/self-knowledge-contract.js';
import { sendMessageToSession, getQueue, enqueueMessage, resetCache, editMessage, deleteMessage,
  markProcessing, markNextProcessing, revertToPending, removeProcessed, removeTaken } from '../../src/core/session-message-queue.js';
import { collectOpenItems } from '../../src/core/sessions/open-items.js';
import { notePlaceCompaction } from '../../src/core/sessions/place-notice.js';
import { editOrgNode } from '../../src/core/org/org-node-edit.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});
/** The charter's relay rule (2026-10-27): the first change this notice carried. */
const RELAY = TEAM_CHARTER.split('\n').find((l) => l.startsWith("- When you pass on the user's request"))!;
/** Today's prompt for the task without `drop`'s lines: a session spawned before they were added. */
async function oldPrompt(taskId: string, drop: string[] = [RELAY]) {
  const current = (await buildSessionContext(taskId)).systemPrompt;
  const gone = new Set(drop.flatMap((d) => d.split('\n')).map((l) => l.trim()).filter(Boolean));
  return current.split('\n').filter((l) => !gone.has(l.trim())).join('\n');
}
type Role = 'main' | 'lead' | 'ask' | undefined;
async function seed(role?: Role, prompt: string | null | 'old' | 'current' = 'old', drop?: string[]) {
  const main = role === 'main';
  const { task } = await addTask({ title: role ?? 'Work', project: main || role === 'ask' ? 'Ask Walnut' : 'marina',
    ...(main || role === 'lead' ? { org_role: role } : {}), ...(main || role === 'ask' ? { walnut_agent: true } : {}) });
  const sid = randomUUID();
  await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
  const text = prompt === 'old' ? await oldPrompt(task.id, drop)
    : prompt === 'current' ? (await buildSessionContext(task.id)).systemPrompt : prompt;
  if (text !== null) await updateSessionRecord(sid, { appliedAppendSystemPrompt: text });
  return { sid, task };
}
const copies = (text: string) => text.split(RELAY).length - 1;
async function deliver(sid: string, text: string, pick = markProcessing) {
  await enqueueMessage(sid, text);
  const batch = await pick(sid);
  await removeProcessed(sid, batch.map((row) => row.id));
  return batch;
}

describe('changed default instructions for a session spawned before them', () => {
  it('a replacement session drops a notice frozen into an old row', async () => {
    const { sid } = await seed('main');
    await sendMessageToSession(sid, 'Keep this request');
    const [row] = await markProcessing(sid);
    expect(stripInstructionNotice(row.message)).toBe('Keep this request');
    expect(stripInstructionNotice('Plain text')).toBe('Plain text');
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
    expect(queued.message).not.toContain(RELAY);
    const [first] = await markProcessing(sid);
    expect(first.message.startsWith('<walnut-message kind="notification"')).toBe(true);
    expect(first.message.endsWith('Independent sorting goal')).toBe(true);
    await removeProcessed(sid, [first.id]);
    expect((await getSessionByClaudeId(sid))?.taskRoutingNoted?.promptHash).toBeTruthy();
    expect(copies((await deliver(sid, 'Additional screenshot'))[0].message)).toBe(0);
    await notePlaceCompaction(sid, 'boundary-1');
    expect(copies((await deliver(sid, 'After compaction'))[0].message)).toBe(1);
    expect(copies((await deliver(sid, 'Later'))[0].message)).toBe(0);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: (await oldPrompt((await getSessionByClaudeId(sid))!.taskId!)) + '\nRespawned' });
    expect(copies((await deliver(sid, 'On another prompt', markNextProcessing))[0].message)).toBe(1);
    expect(copies((await deliver(sid, 'Then quiet', markNextProcessing))[0].message)).toBe(0);
  });
  it('a frozen line that never reaches the CLI is not told; the next live line carries the notice', async () => {
    const { sid } = await seed('main');
    await sendMessageToSession(sid, 'Stopped before it was read');
    const frozen = await markProcessing(sid);
    expect(copies(frozen[0].message)).toBe(1);
    // A second freeze while that line is in flight does not carry it again.
    const racing = (await instructionNoticeForSession(sid))!;
    expect(racing.apply('Mid-turn input', await getQueue(sid))).toBe('Mid-turn input');
    // The user stops the session: the line is parked, never delivered.
    expect(await parkMessages(frozen, 'user-stop')).toBe(1);
    expect((await getSessionByClaudeId(sid))?.taskRoutingNoted).toBeUndefined();
    expect(copies((await deliver(sid, 'Next input'))[0].message)).toBe(1);
    expect((await getSessionByClaudeId(sid))?.taskRoutingNoted?.version).toBeTruthy();
  });
  it('a line waiting minutes for a dead CLI keeps the next batch from a second copy (2026-10-30)', async () => {
    // Main's 07:36Z double: its first line carried the notice, waited nine minutes for a resume, and the
    // batch frozen meanwhile got the notice again because "already attached" was a 60 s claim.
    const { sid } = await seed('main');
    await sendMessageToSession(sid, 'First, waits for a resume');
    const [first] = await markProcessing(sid);
    expect(copies(first.message)).toBe(1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 60_000);
    try {
      for (const t of ['Two', 'Three', 'Four', 'Five']) await sendMessageToSession(sid, t);
      const batch = await markProcessing(sid);
      expect(batch).toHaveLength(4);
      expect(batch.map((r) => r.message).join('\n')).not.toContain(RELAY);
      // The resume delivers the first line, then the batch goes to the new CLI.
      await removeProcessed(sid, [first.id]);
      await removeProcessed(sid, batch.map((r) => r.id));
      expect(copies((await deliver(sid, 'Later'))[0].message)).toBe(0);
    } finally { clock.mockRestore(); }
  });
  it('a line frozen while a delivered notice is still being recorded gets none', async () => {
    const { sid } = await seed('lead');
    await sendMessageToSession(sid, 'Carries it');
    const [row] = await markProcessing(sid);
    expect(copies(row.message)).toBe(1);
    await sendMessageToSession(sid, 'Frozen in between');
    // Delivery and the next freeze race: the told record is written after the next freeze looks.
    const [, next] = await Promise.all([removeProcessed(sid, [row.id]), markProcessing(sid)]);
    expect(copies(next[0].message)).toBe(0);
  });
  it('a line still waiting through a compaction is not told again after the hook restated it', async () => {
    const { sid } = await seed('main');
    await sendMessageToSession(sid, 'Waits through a compaction');
    const [row] = await markProcessing(sid);
    expect(copies(row.message)).toBe(1);
    // The session compacts before the line is taken: the hook restates, the server reads the boundary.
    expect(copies((await collectOpenItems(sid, Date.now(), { afterCompaction: true })).text)).toBe(1);
    await notePlaceCompaction(sid, 'c2');
    // The line written back as told must land on the new boundary, not the one it was attached on.
    await removeProcessed(sid, [row.id]);
    expect((await getSessionByClaudeId(sid))?.taskRoutingNoted?.compactUuid).toBe('c2');
    expect(copies((await deliver(sid, 'After'))[0].message)).toBe(0);
  });
  it('a delivery on another prompt records nothing', async () => {
    const { sid, task } = await seed('main');
    await sendMessageToSession(sid, 'Attached on the old prompt');
    const [row] = await markProcessing(sid);
    expect(copies(row.message)).toBe(1);
    // A fresh spawn on the current prompt before the old line was recorded.
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: (await buildSessionContext(task.id)).systemPrompt });
    await removeProcessed(sid, [row.id]);
    expect((await getSessionByClaudeId(sid))?.taskRoutingNoted).toBeUndefined();
  });
  it('sessions given the same notice are each recorded as it was attached, after the instructions changed again', async () => {
    // One USER.md save gives every session the same text; a notice kept by its text alone was
    // kept for the last session only, and the rest were checked against the instructions again.
    const a = await seed('lead');
    const b = await seed('lead');
    await sendMessageToSession(a.sid, 'A');
    await sendMessageToSession(b.sid, 'B');
    const [ra] = await markProcessing(a.sid);
    const [rb] = await markProcessing(b.sid);
    expect(stripInstructionNotice(ra.message)).toBe('A');
    expect(ra.message.slice(0, ra.message.indexOf('</walnut-message>'))).toBe(rb.message.slice(0, rb.message.indexOf('</walnut-message>')));
    // Both leads' instructions change while the lines wait (a dead CLI, a resume).
    for (const t of [a.task, b.task]) await editOrgNode(t.id, { instructions: 'Ship on Fridays only.' });
    await removeProcessed(a.sid, [ra.id]);
    await removeProcessed(b.sid, [rb.id]);
    for (const { sid } of [a, b]) {
      const next = (await deliver(sid, 'Next'))[0].message;
      expect(copies(next)).toBe(0);
      expect(next).toContain('Ship on Fridays only.');
    }
  });
  it('a line the CLI reports taking counts as told; a cancelled one does not', async () => {
    // The live path: rows leave through removeTaken when Claude Code names the line.
    const { sid } = await seed('main');
    await sendMessageToSession(sid, 'Cancelled by a Stop');
    const [cancelled] = await markProcessing(sid);
    expect(copies(cancelled.message)).toBe(1);
    await removeTaken(sid, [cancelled.id], { ran: false });
    expect((await getSessionByClaudeId(sid))?.taskRoutingNoted).toBeUndefined();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      await sendMessageToSession(sid, 'Taken by the CLI');
      const [taken] = await markProcessing(sid);
      expect(copies(taken.message)).toBe(1);
      await removeTaken(sid, [taken.id]);
      expect((await getSessionByClaudeId(sid))?.taskRoutingNoted?.version).toBeTruthy();
      await sendMessageToSession(sid, 'Next notice');
      const [next] = await markProcessing(sid);
      expect(copies(next.message)).toBe(0);
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
    expect(copies(batch[0].message)).toBe(1);
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
    expect(copies(batch[0].message)).toBe(1);
    expect(batch[0].message).toContain('Input B');
  });
  it('editing and freezing race under the same queue lock without losing policy', async () => {
    const { sid } = await seed('main');
    const row = await enqueueMessage(sid, 'Original');
    const [edited, batch] = await Promise.all([editMessage(sid, row.id, 'Changed'), markProcessing(sid)]);
    expect(copies(batch[0].message)).toBe(1);
    expect(batch[0].message).toContain(edited ? 'Changed' : 'Original');
    expect(await deleteMessage(sid, row.id)).toBe(false);
  });
  it('a row quoting the notice in its body still gets a formal leading notice', async () => {
    const { sid } = await seed('main');
    const policy = (await instructionNoticeForSession(sid))!.text;
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
      expect(copies(batch[0].message)).toBe(1);
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
  it('stays silent for current prompts, ACP engines, an unknown or non-Walnut prompt and a deleted task', async () => {
    for (const role of [undefined, 'ask', 'main', 'lead'] as const) {
      const { sid } = await seed(role, 'current');
      expect(await instructionNoticeForSession(sid)).toBeNull();
      expect((await deliver(sid, 'Plain input'))[0].message).toBe('Plain input');
    }
    const acp = await seed('lead');
    await updateSessionRecord(acp.sid, { engine: 'codex' });
    expect(await instructionNoticeForSession(acp.sid)).toBeNull();
    expect(await instructionNoticeForSession((await seed('main', null)).sid)).toBeNull();
    // A slim profile runs on its caller's prompt alone, even one that quotes the charter.
    expect(await instructionNoticeForSession((await seed(undefined, `App lane prompt\n\n${TEAM_CHARTER}`)).sid)).toBeNull();
    const gone = await seed('lead');
    await deleteTask(gone.task.id);
    expect(await instructionNoticeForSession(gone.sid)).toBeNull();
    // A repaired persona on the record is not what the live CLI runs on.
    const old = await seed('main');
    await updateSessionRecord(old.sid, { profile: { systemPrompt: RELAY } });
    expect(await instructionNoticeForSession(old.sid)).not.toBeNull();
  });
  it.each([undefined, 'ask', 'main', 'lead'] as const)('tells a %s session only the lines that changed, under their heading', async (role) => {
    const { sid } = await seed(role);
    const notice = (await instructionNoticeForSession(sid))!.text;
    expect(copies(notice)).toBe(1);
    expect(notice).toContain('## How we work');
    expect(notice).toContain('outcome="task-routing-policy"');
    // Nothing the session already has: not the charter's other points, not its identity line.
    expect(notice).not.toContain('We are a startup');
    expect(notice).not.toContain('You are a coding session opened by Walnut');
    expect(notice.length).toBeLessThan(1200);
  });
  it('an older Main lacking the routing rules and the relay rule gets both; Main gets no worker rule', async () => {
    const { sid } = await seed('main', 'old', [RELAY, TASK_ROUTING_CONTRACT]);
    const notice = (await instructionNoticeForSession(sid))!.text;
    expect(notice).toContain('## Task routing');
    for (const line of TASK_ROUTING_CONTRACT.split('\n').filter((l) => l.startsWith('- '))) expect(notice).toContain(line);
    expect(copies(notice)).toBe(1);
    expect(notice).not.toContain('arm a trigger yourself');
  });
  it('a later change sends only its own lines; a compaction sends them all again', async () => {
    const LATER = TASK_ROUTING_CONTRACT.split('\n').find((l) => l.startsWith('- A COMPLETE task'))!;
    const { sid } = await seed('lead', 'old', [RELAY, LATER]);
    // Told RELAY earlier, against this prompt: as if LATER had been added after.
    const hash = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16);
    const prompt = (await getSessionByClaudeId(sid))!.appliedAppendSystemPrompt!;
    await updateSessionRecord(sid, { taskRoutingNoted: { version: 'v', promptHash: hash(prompt), lines: [hash(RELAY)] } });
    const [first] = await deliver(sid, 'Next');
    expect(first.message).toContain(LATER);
    expect(copies(first.message)).toBe(0);
    expect((await getSessionByClaudeId(sid))?.taskRoutingNoted?.lines).toEqual(expect.arrayContaining([hash(RELAY), hash(LATER)]));
    expect((await deliver(sid, 'Quiet'))[0].message).toBe('Quiet');
    await notePlaceCompaction(sid, 'boundary-x');
    const [again] = await deliver(sid, 'After compaction');
    expect(again.message).toContain(LATER);
    expect(copies(again.message)).toBe(1);
  });
  it('a record told the routing rules before lines were kept is told the changed lines once', async () => {
    const { sid } = await seed('main');
    const hash = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16);
    const prompt = (await getSessionByClaudeId(sid))!.appliedAppendSystemPrompt!;
    await updateSessionRecord(sid, { taskRoutingNoted: { version: 'routing-v1', promptHash: hash(prompt) } });
    expect(copies((await deliver(sid, 'One'))[0].message)).toBe(1);
    expect(copies((await deliver(sid, 'Two'))[0].message)).toBe(0);
  });
  it('the compaction hook restates the changed lines even when told, and that counts as told in either order', async () => {
    const { sid } = await seed('main');
    expect(copies((await deliver(sid, 'First'))[0].message)).toBe(1);
    // Hook first, then the server reads the boundary.
    expect(copies((await collectOpenItems(sid, Date.now(), { afterCompaction: true })).text)).toBe(1);
    await notePlaceCompaction(sid, 'one');
    expect(copies((await deliver(sid, 'After hook then boundary'))[0].message)).toBe(0);
    // Boundary first, then the hook.
    await notePlaceCompaction(sid, 'two');
    expect(copies((await collectOpenItems(sid, Date.now(), { afterCompaction: true })).text)).toBe(1);
    expect(copies((await deliver(sid, 'After boundary then hook'))[0].message)).toBe(0);
    // A session on the current prompt hears nothing from the hook.
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: (await buildSessionContext((await getSessionByClaudeId(sid))!.taskId!)).systemPrompt });
    expect(copies((await collectOpenItems(sid, Date.now(), { afterCompaction: true })).text)).toBe(0);
  });
});
