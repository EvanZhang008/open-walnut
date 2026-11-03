/**
 * Changed default instructions reach a running session in few, small notices (2026-11-03, the org
 * reflection: 64 notices, about 287K characters, in 12 hours across 100 sessions).
 *
 * - Changes close together go out as one notice (NOTICE_GAP_MS), riding a message from a person,
 *   a task or a trigger, never a line of Walnut's own notes alone.
 * - A side question's compaction (a fork) runs the compaction hook too; its statement no longer
 *   wipes what the conversation was told, so the next message does not restate everything
 *   (the CIS review task: 10.8 KB at 01:45 and again at 02:06).
 * - A hook statement lands on the boundary the record holds when it is written, also when the
 *   server read that boundary before the hook's own request finished.
 * - The compaction hook never adds more than Claude Code shows the model (10,000 characters;
 *   Main's 39 KB statement reached it as a 2 KB preview and was recorded as told).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-instruction-notice-few'));
import { WALNUT_HOME } from '../../src/constants.js';
import { addTask, getTask, updateTask } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js';
import { NOTICE_GAP_MS, instructionNoticeForHost, isWalnutNotesOnly, noteInstructionNoticeStatedByHook } from '../../src/core/sessions/instruction-notice.js';
import { TEAM_CHARTER } from '../../src/core/team-charter.js';
import { WALNUT_PROMPT_MARK, buildSessionContext, defaultInstructions } from '../../src/core/sessions/session-context.js';
import { enqueueMessage, markProcessing, removeProcessed, resetCache } from '../../src/core/session-message-queue.js';
import { HOOK_CONTEXT_MAX, collectOpenItems, fitHookContext } from '../../src/core/sessions/open-items.js';
import { notePlaceCompaction, pendingPlaceNotice } from '../../src/core/sessions/place-notice.js';
import { editOrgNode } from '../../src/core/org/org-node-edit.js';
import { buildWalnutMessage } from '../../src/core/peers/walnut-message-tag.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});

const RELAY = TEAM_CHARTER.split('\n').find((l) => l.startsWith("- When you pass on the user's request"))!;
const NOTICE = 'Walnut changed your default instructions';

/** A lead's session spawned before `drop` was added to its instructions. */
async function seed(drop: string[] = [RELAY]) {
  const { task } = await addTask({ title: 'Lead', project: 'marina', org_role: 'lead' });
  const sid = randomUUID();
  await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
  const gone = new Set(drop.flatMap((d) => d.split('\n')).map((l) => l.trim()).filter(Boolean));
  const current = (await buildSessionContext(task.id)).systemPrompt;
  await updateSessionRecord(sid, { appliedAppendSystemPrompt: current.split('\n').filter((l) => !gone.has(l.trim())).join('\n') });
  return { sid, task };
}
/** One stdin line of `texts` (one row each), as the queue freezes and the CLI takes it. */
async function line(sid: string, ...texts: string[]): Promise<string> {
  for (const t of texts) await enqueueMessage(sid, t);
  const batch = await markProcessing(sid);
  await removeProcessed(sid, batch.map((r) => r.id));
  return batch.map((r) => r.message).join('\n\n');
}
/** A charter line other than RELAY. */
const CHARTER_LINE = TEAM_CHARTER.split('\n').find((l) => l.startsWith('- ') && l !== RELAY && l.length > 40)!;
/** The record forgets it was told `text`: as a deploy that rewords that rule looks to the session. */
async function forget(sid: string, text: string) {
  const noted = (await getSessionByClaudeId(sid))!.taskRoutingNoted!;
  const h = createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
  expect(noted.lines).toContain(h);
  await updateSessionRecord(sid, { taskRoutingNoted: { ...noted, lines: noted.lines!.filter((l) => l !== h) } });
}
async function shiftTold(sid: string, ms: number) {
  const noted = (await getSessionByClaudeId(sid))!.taskRoutingNoted!;
  await updateSessionRecord(sid, { taskRoutingNoted: { ...noted, toldAt: new Date(Date.parse(noted.toldAt!) - ms).toISOString() } });
}
const status = buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'status' }, body: 'A task you follow changed its status.' });
const stopped = buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'stopped' }, body: 'Your subtask stopped.' });

describe('changes close together are one notice', () => {
  it('a change of Walnut\'s wording within the gap waits; after it, one notice holds every change since', async () => {
    const { sid } = await seed([RELAY, CHARTER_LINE]);
    expect(await line(sid, 'First')).toContain(RELAY);
    // Two deploys reword two rules soon after (here: the session's record forgets it was told them).
    await forget(sid, RELAY);
    expect(await line(sid, 'Soon after')).toBe('Soon after');
    await forget(sid, CHARTER_LINE);
    await shiftTold(sid, NOTICE_GAP_MS - 60_000);
    expect(await line(sid, 'Still inside')).toBe('Still inside');
    await shiftTold(sid, 2 * 60_000);
    const merged = await line(sid, 'After the gap');
    expect(merged.split(NOTICE).length - 1).toBe(1);
    expect(merged).toContain(RELAY);
    expect(merged).toContain(CHARTER_LINE);
    expect(await line(sid, 'Next')).toBe('Next');
  });

  it('the user\'s own words never wait, and take what was waiting with them', async () => {
    const { sid, task } = await seed();
    expect(await line(sid, 'First')).toContain(RELAY);
    await forget(sid, RELAY);
    expect(await line(sid, 'Soon after')).toBe('Soon after');
    await editOrgNode(task.id, { instructions: 'Ship weekly.' });
    const out = await line(sid, 'Right after the edit');
    expect(out).toContain('Ship weekly.');
    expect(out).toContain(RELAY);
  });

  it('a compaction starts over: what it dropped is told at once, gap or not', async () => {
    const { sid } = await seed();
    expect(await line(sid, 'First')).toContain(RELAY);
    await notePlaceCompaction(sid, 'c-new');
    expect(await line(sid, 'After the compaction')).toContain(RELAY);
  });
});

describe('a notice rides a real message', () => {
  it('a line of Walnut\'s own notes goes without it; the next message from a person carries it', async () => {
    const { sid } = await seed();
    expect(await line(sid, status)).toBe(status);
    expect(await line(sid, `${status}\n\n${stopped}`)).toBe(`${status}\n\n${stopped}`);
    expect(await line(sid, 'Hello')).toContain(RELAY);
  });

  it('notes and a message in one line: the line carries it', async () => {
    const { sid } = await seed();
    const out = await line(sid, status, 'What changed?');
    expect(out.startsWith('<walnut-message kind="notification" from="Walnut" outcome="task-routing-policy"')).toBe(true);
    expect(out).toContain('What changed?');
  });

  it('a subtask\'s completion is work and carries it; so does a person\'s image with no text', () => {
    const done = buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'completed' }, body: 'Your subtask completed.' });
    expect(isWalnutNotesOnly(done)).toBe(false);
    expect(isWalnutNotesOnly(buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'error' }, body: 'Your subtask errored.' }))).toBe(false);
    expect(isWalnutNotesOnly('')).toBe(false);
  });

  it('what counts as Walnut\'s own notes', () => {
    expect(isWalnutNotesOnly(status)).toBe(true);
    expect(isWalnutNotesOnly(`${status}\n\n${stopped}\n\n<system-reminder>\nWalnut (reply-language): Talk in Chinese.\n</system-reminder>`)).toBe(true);
    expect(isWalnutNotesOnly(`${status}\n\nship it`)).toBe(false);
    expect(isWalnutNotesOnly(buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'Lead [abcd1234]' }, body: 'Please review.' }))).toBe(false);
    expect(isWalnutNotesOnly(buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Trigger: CI' }, body: 'The build finished.' }))).toBe(false);
    expect(isWalnutNotesOnly(buildWalnutMessage({ kind: 'reply', attrs: { from: 'Worker [abcd1234]' }, body: 'Done.' }))).toBe(false);
  });
});

describe('a fork\'s compaction leaves what the conversation was told', () => {
  it('the next message tells nothing it already holds', async () => {
    const { sid } = await seed();
    expect(await line(sid, 'First')).toContain(RELAY);
    await shiftTold(sid, NOTICE_GAP_MS + 60_000);
    // A side question compacts: its hook restates everything, and no boundary of this conversation comes.
    const hook = await collectOpenItems(sid, Date.now(), { afterCompaction: true });
    expect(hook.text).toContain(RELAY);
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted!.prior).toBeTruthy();
    expect(await line(sid, 'After the fork')).toBe('After the fork');
  });

  it('what changed after it is still told', async () => {
    const { sid, task } = await seed();
    await line(sid, 'First');
    await shiftTold(sid, NOTICE_GAP_MS + 60_000);
    await collectOpenItems(sid, Date.now(), { afterCompaction: true });
    await editOrgNode(task.id, { instructions: 'Ship weekly.' });
    const out = await line(sid, 'Later');
    expect(out).toContain('Ship weekly.');
    expect(out).not.toContain(RELAY);
  });
});

describe('a fork after a real compaction', () => {
  it('keeps the real compaction\'s statement, which still counts', async () => {
    const { sid } = await seed();
    // The conversation compacts: the hook restates, the boundary is read 2 s later.
    expect((await collectOpenItems(sid, Date.now(), { afterCompaction: true })).text).toContain(RELAY);
    await notePlaceCompaction(sid, 'c1');
    expect(await line(sid, 'After')).toBe('After');
    // 15 minutes later its side question compacts; no boundary of this conversation comes.
    const rec = (await getSessionByClaudeId(sid))!;
    const back = (iso: string) => new Date(Date.parse(iso) - 15 * 60_000).toISOString();
    await updateSessionRecord(sid, { lastCompactAt: back(rec.lastCompactAt!),
      taskRoutingNoted: { ...rec.taskRoutingNoted!, byHookAt: back(rec.taskRoutingNoted!.byHookAt!), toldAt: back(rec.taskRoutingNoted!.toldAt!) } });
    await shiftTold(sid, NOTICE_GAP_MS);
    await collectOpenItems(sid, Date.now(), { afterCompaction: true });
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted!.prior?.byHookAt).toBeTruthy();
    expect(await line(sid, 'After the fork')).toBe('After the fork');
  });

  it('the place note too: a fork\'s statement leaves the place the conversation was told', async () => {
    const { sid, task } = await seed();
    await updateTask(task.id, { project: 'harbour-two' } as never);
    const note = await pendingPlaceNotice(sid);
    expect(note?.text).toContain('harbour-two');
    await note!.markTold();
    expect(await pendingPlaceNotice(sid)).toBeNull();
    await collectOpenItems(sid, Date.now(), { afterCompaction: true });
    expect((await getSessionByClaudeId(sid))!.placeNoted!.prior?.project).toBe('harbour-two');
    expect(await pendingPlaceNotice(sid)).toBeNull();
  });
});

describe('the host\'s copy follows the gap', () => {
  it('a session told within the gap gets no notice from its host for Walnut\'s wording', async () => {
    const { sid, task } = await seed();
    await line(sid, 'First');
    await forget(sid, RELAY);
    const rec = (await getSessionByClaudeId(sid))!;
    const t = (await getTask(task.id))!;
    expect(instructionNoticeForHost({ ...rec, process_status: 'running' }, t)).toBeNull();
    expect(instructionNoticeForHost({ ...rec, process_status: 'running' }, t, Date.now() + NOTICE_GAP_MS + 60_000)?.policy).toContain(RELAY);
  });
});

describe('a hook statement lands on the boundary it answers', () => {
  it('also when the server read the boundary before the hook\'s request finished', async () => {
    const { sid, task } = await seed();
    await line(sid, 'First');
    await shiftTold(sid, NOTICE_GAP_MS + 60_000);
    const before = (await getSessionByClaudeId(sid))!;
    // The boundary is read first; the hook, which read the record before it, records after.
    await notePlaceCompaction(sid, 'c2');
    await noteInstructionNoticeStatedByHook(before, (await getTask(task.id))!);
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted!.compactUuid).toBe('c2');
    expect(await line(sid, 'After')).toBe('After');
  });
});

describe('the compaction hook stays within what Claude Code shows the model', () => {
  it('changes too long for it come with the next message, whole, and are not counted told by the hook', async () => {
    const { task } = await addTask({ title: 'Lead', project: 'marina', org_role: 'lead' });
    // A session from long ago: its prompt holds only Walnut's identity line.
    const keep = defaultInstructions(task).split('\n').find((l) => l.includes(WALNUT_PROMPT_MARK)) ?? WALNUT_PROMPT_MARK;
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: keep });
    const hook = await collectOpenItems(sid, Date.now(), { afterCompaction: true });
    expect(hook.text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX);
    expect(hook.text).not.toContain(NOTICE);
    expect(hook.text).toContain('come in full in front of your next message');
    expect(hook.text.startsWith('Walnut changed some of your default instructions')).toBe(true);
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted).toBeUndefined();
    await notePlaceCompaction(sid, 'c1');
    const next = await line(sid, 'After the compaction');
    expect(next.length).toBeGreaterThan(HOOK_CONTEXT_MAX);
    expect(next).toContain(RELAY);
  });

  it('changes that fit are stated by the hook and told', async () => {
    const { sid } = await seed();
    const hook = await collectOpenItems(sid, Date.now(), { afterCompaction: true });
    expect(hook.text).toContain(RELAY);
    await notePlaceCompaction(sid, 'c1');
    expect(await line(sid, 'After')).toBe('After');
  });

  it('a hook text past the limit is cut at a line end and says where the rest is', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a long team snapshot.`).join('\n');
    const fit = fitHookContext(long);
    expect(fit.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX);
    expect(fit).toMatch(/snapshot\.\n\n\(Cut here: /);
    expect(fitHookContext('short')).toBe('short');
  });
});
