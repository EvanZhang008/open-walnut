/**
 * What a host's session was told, when the leader tells it too (sessions/told-copies.ts).
 *
 * 2026-11-24: the leader's records of what it told a host's session were left out of the row (host
 * fields), so it told the same thing again at every line: one session got the same folder move five
 * times in 33 minutes, and the same rule change at 04:01, 07:18 and 13:00. The leader keeps its own
 * copies now, and a reader takes what either copy says.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-told-copies'));
import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask } from '../../../src/core/task-manager.js';
import { SESSION_FIELD_OWNER, sessionFieldOwner } from '../../../src/core/sessions/session-row-owner.js';
import { LEADER_TOLD_COPY, leaderToldAtBoundary, toldIntoLeaderCopies } from '../../../src/core/sessions/told-copies.js';
import { hash } from '../../../src/core/sessions/instruction-diff.js';
import { instructionNoticeFor } from '../../../src/core/sessions/instruction-notice.js';
import { promptHash as createPromptHash, toldPlaceOf } from '../../../src/core/sessions/place-notice.js';
import { buildSessionContext } from '../../../src/core/sessions/session-context.js';
import { TEAM_CHARTER } from '../../../src/core/team-charter.js';
import type { SessionInstructionsNoted, SessionRecord } from '../../../src/core/types.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

describe('every told record a host owns has a leader copy', () => {
  it('each host field that records what a session was told (…Noted, …Told, …HookAt) is in LEADER_TOLD_COPY', () => {
    // A new told record on a host's row: give the leader its copy in told-copies.ts, or its
    // writes of it are left out and it tells the same thing at every line.
    const told = Object.keys(SESSION_FIELD_OWNER).filter((k) => sessionFieldOwner(k) === 'host' && /(Noted|Told|HookAt)$/.test(k));
    expect(told.sort()).toEqual(Object.keys(LEADER_TOLD_COPY).sort());
  });

  it('each copy is the leader\'s, and a write moves only told fields into them', () => {
    for (const copy of Object.values(LEADER_TOLD_COPY)) expect(sessionFieldOwner(copy)).toBe('leader');
    expect(toldIntoLeaderCopies({ taskRoutingNoted: 1, title: 't', placeNoted: undefined }))
      .toEqual({ taskRoutingNotedByLeader: 1, title: 't', placeNotedByLeader: undefined });
    const plain = { title: 't' };
    expect(toldIntoLeaderCopies(plain)).toBe(plain);
  });
});

type Rec = Pick<SessionRecord, 'appliedAppendSystemPrompt' | 'engine' | 'lastCompactUuid' | 'lastCompactAt' | 'taskRoutingNoted' | 'taskRoutingNotedByLeader' | 'judge'>;
const RULE = TEAM_CHARTER.split('\n').find((l) => l.startsWith('- ') && l.length > 60)!;

/** A host's session spawned before RULE was in its instructions. */
async function before(): Promise<{ task: Awaited<ReturnType<typeof addTask>>['task']; record: Rec }> {
  const { task } = await addTask({ title: 'Told copies' });
  const prompt = (await buildSessionContext(task.id)).systemPrompt.split('\n').filter((l) => l.trim() !== RULE.trim()).join('\n');
  return { task, record: { appliedAppendSystemPrompt: prompt, judge: 'host' } };
}
const toldRule = (prompt: string, toldAt: string, extra: Partial<SessionInstructionsNoted> = {}): SessionInstructionsNoted =>
  ({ version: 'v', promptHash: hash(prompt), lines: [hash(RULE)], blocks: {}, toldAt, ...extra });

describe('a host\'s session is told a change once, whichever server told it', () => {
  it('the rule is due while neither copy says it was told', async () => {
    const { task, record } = await before();
    expect(instructionNoticeFor(record, task)).toContain(RULE.slice(2, 40));
  });

  it('told by the leader (its copy), or by the host (the row\'s own): not told again', async () => {
    const { task, record } = await before();
    const at = new Date().toISOString();
    expect(instructionNoticeFor({ ...record, taskRoutingNotedByLeader: toldRule(record.appliedAppendSystemPrompt!, at) }, task)).toBeNull();
    expect(instructionNoticeFor({ ...record, taskRoutingNoted: toldRule(record.appliedAppendSystemPrompt!, at) }, task)).toBeNull();
  });

  it('the newer copy counts: an older one that lacks the rule does not make it due again', async () => {
    const { task, record } = await before();
    const p = record.appliedAppendSystemPrompt!;
    const older = toldRule(p, new Date(Date.now() - 4 * 3_600_000).toISOString(), { lines: [] });
    expect(instructionNoticeFor({ ...record, taskRoutingNoted: older, taskRoutingNotedByLeader: toldRule(p, new Date().toISOString()) }, task)).toBeNull();
  });

  it('either copy\'s lines count, whichever is newer: a host that had not seen the leader\'s copy does not make its rule due again', async () => {
    const { task, record } = await before();
    const p = record.appliedAppendSystemPrompt!;
    const leader = toldRule(p, new Date(Date.now() - 60_000).toISOString());
    const host = toldRule(p, new Date().toISOString(), { lines: [] });
    expect(instructionNoticeFor({ ...record, taskRoutingNoted: host, taskRoutingNotedByLeader: leader }, task)).toBeNull();
  });

  it('once the row is the leader\'s own again, its old copy counts for nothing', async () => {
    const { task, record } = await before();
    const leaderCopy = toldRule(record.appliedAppendSystemPrompt!, new Date().toISOString());
    expect(instructionNoticeFor({ ...record, judge: undefined, taskRoutingNotedByLeader: leaderCopy }, task)).toContain(RULE.slice(2, 40));
  });

  it('a hook statement on the boundary before counts for none after a compaction, until carried onto the one it answered', async () => {
    const { task, record } = await before();
    const p = record.appliedAppendSystemPrompt!;
    const hookAt = new Date(Date.now() - 60_000).toISOString();
    const stated = toldRule(p, hookAt, { byHookAt: hookAt, compactUuid: 'b0' });
    const compacted: Rec = { ...record, lastCompactUuid: 'b1', lastCompactAt: new Date(Date.now() - 30_000).toISOString(), taskRoutingNotedByLeader: stated };
    expect(instructionNoticeFor(compacted, task)).toContain(RULE.slice(2, 40));
    // Where the leader applies the host's boundary, the statement made for it is carried onto it.
    const beforeRow = { ...record, claudeSessionId: 's', lastCompactUuid: 'b0', lastCompactAt: new Date(Date.now() - 3_600_000).toISOString(), taskRoutingNotedByLeader: stated } as SessionRecord;
    const next = { ...beforeRow, lastCompactUuid: 'b1', lastCompactAt: compacted.lastCompactAt } as SessionRecord;
    leaderToldAtBoundary(beforeRow, next);
    expect(next.taskRoutingNotedByLeader?.compactUuid).toBe('b1');
    expect(instructionNoticeFor(next, task)).toBeNull();
    // One made for an earlier boundary (before the boundary before this one) is not carried.
    const old = { ...beforeRow, lastCompactAt: new Date(Date.now() - 20_000).toISOString() } as SessionRecord;
    const next2 = { ...old, lastCompactUuid: 'b1', lastCompactAt: new Date().toISOString() } as SessionRecord;
    leaderToldAtBoundary(old, next2);
    expect(next2.taskRoutingNotedByLeader?.compactUuid).toBe('b0');
  });
});

describe('the place a host\'s session was told', () => {
  it('the leader\'s copy counts', () => {
    const prompt = 'You are a coding session opened by Walnut';
    const told = toldPlaceOf({ appliedAppendSystemPrompt: prompt, project: 'Old', judge: 'host', placeNotedByLeader: { promptHash: createPromptHash(prompt), project: 'New' } }, 't1');
    expect(told.project).toBe('New');
  });
});

describe('the leader\'s told state follows a boundary the host read', () => {
  const row = (over: Partial<SessionRecord> = {}) => ({ claudeSessionId: 's', judge: 'host', lastCompactUuid: 'b0', lastCompactAt: '2026-11-24T10:00:00.000Z', output_mode_injected: 'rich', ...over }) as SessionRecord;
  it('the rich-output instruction is due again, unless the hook restated it for that boundary; a hint the hook stated moves onto it', () => {
    const next = row({ lastCompactUuid: 'b1', lastCompactAt: '2026-11-24T12:00:00.000Z' });
    leaderToldAtBoundary(row(), next, Date.parse('2026-11-24T12:30:00.000Z'));
    expect(next.output_mode_injected).toBeUndefined();
    const hinted = row({ outputModeHookAtByLeader: '2026-11-24T11:59:00.000Z', hintState: { told: { 'rich-output': { byHookAt: '2026-11-24T11:59:00.000Z', compact: 'b0' } } } as never });
    const next2 = row({ lastCompactUuid: 'b1', lastCompactAt: '2026-11-24T12:00:00.000Z' });
    leaderToldAtBoundary(hinted, next2, Date.parse('2026-11-24T12:30:00.000Z'));
    expect(next2.output_mode_injected).toBe('rich');
    expect(next2.hintState?.told['rich-output']).toMatchObject({ compact: 'b1' });
  });

  it('a change on the same boundary, or an older one replayed after it, changes nothing', () => {
    const next = row();
    leaderToldAtBoundary(row(), next);
    expect(next.output_mode_injected).toBe('rich');
    const older = row({ lastCompactUuid: 'b-old', lastCompactAt: '2026-11-24T09:00:00.000Z' });
    leaderToldAtBoundary(row(), older);
    expect(older.output_mode_injected).toBe('rich');
  });
});
