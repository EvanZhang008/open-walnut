/**
 * A notice never reaches a CLI whose prompt already holds it, and a rebuilt prompt keeps the gap
 * (2026-11-21, the org reflection: 78 notices in 12 hours; 43 of them reached a CLI resumed seconds
 * before on a prompt rebuilt on the current instructions, 11 to 14 KB each when the Mac woke at
 * 08:00, and two of those sessions got their next notice 49 minutes and 2 hours later).
 *
 * The class: every place that writes a line to a CLI checks the line's notice against the prompt that
 * CLI runs on (stale-notice.ts). The ratchet at the end finds every such write in the runner, so a new
 * one is covered the day it is added.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-instruction-stale'));
import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask } from '../../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../../src/core/session-tracker.js';
import { getQueue, markProcessing, removeProcessed, resetCache, sendMessageToSession } from '../../../src/core/session-message-queue.js';
import { NOTICE_GAP_MS, instructionNoticeFor } from '../../../src/core/sessions/instruction-notice.js';
import { dropStaleNotices } from '../../../src/core/sessions/stale-notice.js';
import { buildSessionContext } from '../../../src/core/sessions/session-context.js';
import { editOrgNode } from '../../../src/core/org/org-node-edit.js';
import { TEAM_CHARTER } from '../../../src/core/team-charter.js';

const NOTICE = 'Walnut changed your default instructions';
const RELAY = TEAM_CHARTER.split('\n').find((l) => l.startsWith("- When you pass on the user's request"))!;

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});

/** A lead's session spawned before RELAY was in its instructions; `current` is what a rebuild gives it. */
async function seed() {
  const { task } = await addTask({ title: 'Lead', project: 'marina', org_role: 'lead' });
  const sid = randomUUID();
  await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
  const current = (await buildSessionContext(task.id)).systemPrompt;
  const old = current.split('\n').filter((l) => l.trim() !== RELAY.trim()).join('\n');
  await updateSessionRecord(sid, { appliedAppendSystemPrompt: old });
  return { sid, task, old, current };
}
/** Freeze one line, as processNext does before it knows which CLI takes it. */
async function freeze(sid: string, text: string) {
  await sendMessageToSession(sid, text);
  return markProcessing(sid);
}
/** The line reaches the CLI that runs on `prompt`, as the runner writes it. */
async function write(sid: string, batch: Awaited<ReturnType<typeof markProcessing>>, prompt: string) {
  await dropStaleNotices(sid, batch, prompt);
  await removeProcessed(sid, batch.map((r) => r.id));
  return batch.map((r) => r.message).join('\n\n');
}
/** A cold resume rebuilt the session's prompt on the current instructions (prompt-refresh.ts). */
const rebuilt = (sid: string, prompt: string) => updateSessionRecord(sid, { appliedAppendSystemPrompt: prompt });
async function shiftTold(sid: string, ms: number) {
  const noted = (await getSessionByClaudeId(sid))!.taskRoutingNoted!;
  await updateSessionRecord(sid, { taskRoutingNoted: { ...noted, toldAt: new Date(Date.parse(noted.toldAt!) - ms).toISOString() } });
}

describe('a notice looked up against a prompt the CLI no longer runs on', () => {
  it('a line frozen before its resume rebuilt the prompt reaches the new CLI without it, and nothing is recorded told', async () => {
    const { sid, current } = await seed();
    const batch = await freeze(sid, 'Please look at the build.');
    expect(batch[0].message).toContain(NOTICE);
    await rebuilt(sid, current);
    const out = await write(sid, batch, current);
    expect(out).not.toContain(NOTICE);
    expect(out).toContain('Please look at the build.');
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted).toBeUndefined();
    // The rebuilt prompt holds it all: the next line carries nothing either.
    expect(await write(sid, await freeze(sid, 'Next'), current)).not.toContain(NOTICE);
  });

  it('a notice the host attached from its copy (not known here) goes only when it is what the CLI\'s prompt still lacks', async () => {
    const { sid, task, old, current } = await seed();
    const record = (await getSessionByClaudeId(sid))!;
    const hostNotice = instructionNoticeFor(record, task)!;
    expect(hostNotice).toContain(RELAY);
    const queued = () => [{ message: `${hostNotice}\n\nA note from a teammate.` }];
    // The CLI still runs on the old prompt: the host's notice is what it needs.
    const live = queued();
    expect(await dropStaleNotices(sid, live, old)).toBe(false);
    expect(live[0].message).toContain(RELAY);
    // Resumed on the rebuilt prompt: it holds every word of it.
    const resumed = queued();
    expect(await dropStaleNotices(sid, resumed, current)).toBe(true);
    expect(resumed[0].message).toBe('A note from a teammate.');
  });

  it('a prompt the runner could not read keeps the notice: the CLI still runs on its stored one (review F1)', async () => {
    const { sid } = await seed();
    const batch = await freeze(sid, 'Hello');
    expect(await dropStaleNotices(sid, batch, undefined)).toBe(false);
    await removeProcessed(sid, batch.map((r) => r.id));
    expect(batch[0].message).toContain(RELAY);
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted?.toldAt).toBeTruthy();
  });

  it('the queue holds what went out: a dropped notice is gone from its row, so nothing of it is recorded and no other row waits on it (review F2)', async () => {
    const { sid, current } = await seed();
    const batch = await freeze(sid, 'Please look at the build.');
    await rebuilt(sid, current);
    expect(await dropStaleNotices(sid, batch, current)).toBe(true);
    // As stored, not the frozen rows in hand.
    resetCache();
    const row = (await getQueue(sid)).find((r) => r.id === batch[0].id)!;
    expect(row.message).toBe(batch[0].message);
    expect(row.message).not.toContain(NOTICE);
    await removeProcessed(sid, batch.map((r) => r.id));
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted).toBeUndefined();
  });

  it('a notice looked up against the prompt the CLI runs on reaches it, and is recorded', async () => {
    const { sid, old } = await seed();
    const out = await write(sid, await freeze(sid, 'Hello'), old);
    expect(out).toContain(RELAY);
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted?.toldAt).toBeTruthy();
  });
});

describe('the gap goes on across a rebuilt prompt', () => {
  it('told, then resumed on the rebuilt prompt: a change within the gap waits, and goes after it', async () => {
    const { sid, task, old, current } = await seed();
    expect(await write(sid, await freeze(sid, 'First'), old)).toContain(RELAY);
    // 40 minutes later the CLI is resumed on the current prompt; 10 minutes after that the role's instructions change.
    await shiftTold(sid, 40 * 60_000);
    await rebuilt(sid, current);
    await editOrgNode(task.id, { instructions: 'Ship weekly.' });
    const inside = await write(sid, await freeze(sid, 'Inside the gap'), current);
    expect(inside).not.toContain(NOTICE);
    await shiftTold(sid, NOTICE_GAP_MS);
    const after = await write(sid, await freeze(sid, 'After the gap'), current);
    expect(after.split(NOTICE).length - 1).toBe(1);
    expect(after).toContain('Ship weekly.');
    // The rebuilt prompt holds RELAY: never told again.
    expect(after).not.toContain(RELAY);
  });

  it('a rule it was told and a deploy reworded since does not break the gap across the rebuild (review R2-1)', async () => {
    const { sid, task, old, current } = await seed();
    await write(sid, await freeze(sid, 'First'), old);
    // It was also told a wording that a deploy overnight replaced: in its record, in no current prompt.
    const noted = (await getSessionByClaudeId(sid))!.taskRoutingNoted!;
    await updateSessionRecord(sid, { taskRoutingNoted: { ...noted, lines: [...noted.lines!, 'feedfacefeedface'] } });
    await shiftTold(sid, 40 * 60_000);
    await rebuilt(sid, current);
    await editOrgNode(task.id, { instructions: 'Ship weekly.' });
    expect(await write(sid, await freeze(sid, 'Inside the gap'), current)).not.toContain(NOTICE);
  });

  it('a record backfilled with an older prompt, lacking what was told, does not hold the gap (review F3)', async () => {
    const { sid, old } = await seed();
    expect(await write(sid, await freeze(sid, 'First'), old)).toContain(RELAY);
    // A live process's argv put back a still older prompt (spawn-prefix.ts): it lacks RELAY and one more rule.
    const OTHER = TEAM_CHARTER.split('\n').find((l) => l.startsWith('- ') && l !== RELAY && l.length > 40)!;
    const older = old.split('\n').filter((l) => l.trim() !== OTHER.trim()).join('\n');
    await rebuilt(sid, older);
    const out = await write(sid, await freeze(sid, 'Next'), older);
    expect(out).toContain(RELAY);
    expect(out).toContain(OTHER);
  });

  it('a compaction on the prompt it was told on still restates what it dropped at once', async () => {
    const { sid, old } = await seed();
    await write(sid, await freeze(sid, 'First'), old);
    const { notePlaceCompaction } = await import('../../../src/core/sessions/place-notice.js');
    await notePlaceCompaction(sid, 'c-new');
    expect(await write(sid, await freeze(sid, 'After the compaction'), old)).toContain(RELAY);
  });
});

describe('every line the runner writes to a CLI is checked against that CLI\'s prompt', () => {
  const file = path.resolve(__dirname, '../../../src/providers/claude-code-session.ts');
  const lines = fsSync.readFileSync(file, 'utf8').split('\n');
  // Every write to a CLI in the runner: of queued rows (`combined`), or one of these, which carry none.
  const NO_QUEUED_ROWS: Record<string, string> = {
    'transport.writeMessage(message': 'the session wrapper\'s own write, below the runner\'s',
    '_transport?.writeMessage(correction': 'a correction Walnut writes into a running turn, no queued row',
    'acpContract(session).send(message.message': 'an ACP engine, which gets no notice (it rebuilds its instructions)',
    'session.send(message, cwd, resumeId': 'a new session\'s first line, on the prompt built for it',
    "target.send(''": 'a respawn that runs no turn',
  };
  const writes = lines.flatMap((l, i) => (/\.(writeMessage|send)\(/.test(l) && !/\b(ws|socket)\.send\(|send\(JSON/.test(l) ? [i] : []));

  it('finds the writes it guards', () => {
    // The mid-turn write, the live write and the two cold resumes, at least.
    expect(writes.filter((i) => /\.(writeMessage|send)\(combined\b/.test(lines[i])).length).toBeGreaterThanOrEqual(4);
  });

  it.each(writes.map((i) => [i + 1, i]))('the write at line %i is known to carry no queued rows, or drops a stale notice first', (_n, i) => {
    const line = lines[i];
    if (!/\.(writeMessage|send)\(combined\b/.test(line)) {
      expect(Object.keys(NO_QUEUED_ROWS).some((k) => line.includes(k)), `a new write to a CLI: ${line.trim()}`).toBe(true);
      return;
    }
    // From where its rows were frozen or its CLI's prompt was picked, to the write: the check runs.
    let j = i - 1;
    while (j >= 0 && !/markProcessing\(|resumeSpawnPrompt\(|resolveResumeArgs\(/.test(lines[j])) j--;
    expect(j, 'no freeze or prompt pick before this write').toBeGreaterThanOrEqual(0);
    expect(lines.slice(j, i).join('\n'), `line ${j + 1}: ${lines[j].trim()}`).toContain('dropStaleNotices(');
  });
});
