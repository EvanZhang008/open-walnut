/**
 * A held quiet note never waits past the cold hold's max (2026-11-23, the Reflection audit: five
 * wake=false notes from the Walnut VP waited 1 to 6.5 h for their targets' next message, one to a
 * task that completed without ever reading it). src/core/sessions/held-notices-sweep.ts
 * deliverDueQuietNotes, on the cold hold's lap (cold-hold.ts sweepColdHolds). Pinned here:
 *  - an idle target gets every quiet note held for it in ONE message once the oldest waited
 *    COLD_HOLD_MAX_MS, not a minute before, through the real send path, under a source that is no
 *    person's, as a quiet turn (its phase, unread mark and board do not move) whose line carries no
 *    riders; their fates read delivered with that row; the line is never dropped: a send that takes
 *    the session first, its quiet turn ending, a failed write or a restart leaves it a normal row;
 *    a failed send keeps the notes;
 *  - when a quiet turn cannot carry them: a normal message, but a task waiting on the user holds them;
 *  - Walnut's own wake=false notices never go out on their own; the org off holds them for CEO or a VP;
 *  - an idle record whose process is gone is stopped; at most QUIET_DELIVERIES_PER_LAP sends a lap;
 *  - a target running a turn is not woken (its notes go once the turn ended);
 *  - a target whose task is complete is not woken: its notes read not delivered and the sender is told;
 *  - a stopped target is not started: its notes wait, say why, and ride its next message;
 *  - a restart keeps the clock: the hold's `at` is read back from the file.
 *
 * Real queue file, session store, held-notices file and bus; only the runner's "is a turn running"
 * answer and the target task's phase are scripted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>();
  return { ...actual, ...createMockConstants('walnut-quiet-due') };
});

/** Tasks the test sets (phase, org role); any other task id reads as the real store has it (none: not found). */
const phases = new Map<string, string>();
const roles = new Map<string, string>();
vi.mock('../../../src/core/task-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/task-manager.js')>();
  return {
    ...actual,
    getTask: async (id: string) => (phases.has(id) || roles.has(id)
      ? { id, phase: phases.get(id) ?? 'IN_PROGRESS', ...(roles.has(id) ? { org_role: roles.get(id) } : {}) } : actual.getTask(id)),
  };
});

/** The next sends under the held-notes source fail (a queue write that did not take). */
let failHeldSends = 0;
vi.mock('../../../src/core/session-message-queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/session-message-queue.js')>();
  return {
    ...actual,
    sendMessageToSession: async (...args: Parameters<typeof actual.sendMessageToSession>) => {
      if (args[2]?.source === 'held-notes' && failHeldSends > 0) { failHeldSends--; throw new Error('queue not stored'); }
      return actual.sendMessageToSession(...args);
    },
  };
});

import { WALNUT_HOME } from '../../../src/constants.js';
import { sessionRunner } from '../../../src/providers/claude-code-session.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { getQueue, loadQueue, markProcessing, resetCache, revertToPending, sendMessageToSession } from '../../../src/core/session-message-queue.js';
import { holdRidingNotice } from '../../../src/core/sessions/wake-policy.js';
import { withoutWalnutRows } from '../../../src/core/sessions/session-extras.js';
import { parkMessages } from '../../../src/core/session-queue-park.js';
import { STOP_PARKED_REASON } from '../../../src/core/relay-fates.js';
import { buildWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js';
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { QUIET_ROW_PREFIX, endQuietTurn, isQuietRowId, isQuietTurn, resetQuietTurnsForTest } from '../../../src/core/sessions/quiet-turn.js';
import { _resetOrgEnabledForTesting } from '../../../src/core/org/org-enabled.js';
import { COLD_HOLD_MAX_MS, stopColdHold, sweepColdHolds } from '../../../src/core/sessions/cold-hold.js';
import { holdQuietNote } from '../../../src/core/sessions/quiet-notes.js';
import { DROP_WHY, _clearHeldNotices, heldNoteState, heldNoticeKeys } from '../../../src/core/sessions/held-notices.js';
import { _resetHeldStoreForTesting, persist } from '../../../src/core/sessions/held-notices-store.js';
import {
  DROP_TELL_KEY, HELD_NOTES_SOURCE, NEED_ACTION_WAIT_WHY, QUIET_DELIVERIES_PER_LAP, STOPPED_WAIT_WHY, _resetQuietDelivery,
  flushDropTells, startHeldNotices, stopHeldNotices,
} from '../../../src/core/sessions/held-notices-sweep.js';

const TARGET = 'dddddddd-1111-4222-8333-555555555555';
const SENDER = 'eeeeeeee-1111-4222-8333-555555555555';
const MIN = 60_000;

let sends: Array<{ sessionId: string; source: string }> = [];
const running = new Set<string>();

/** A task's wake=false note to TARGET (kept whole), as session-send-core.ts holds it. */
const taskNote = (mid: string, at: number, text: string, to = TARGET) => holdQuietNote(to, { key: SENDER, label: 'Walnut VP [eeeeeeee]' },
  { at, mid, title: `note ${mid}`, text, from: SENDER, whole: true, fromTask: 't-vp', task: 't-target', by: 'session' });
/** A script's "No reply needed" note to TARGET. */
const scriptNote = (mid: string, at: number) => holdQuietNote(TARGET, { key: 'automation: watchdog@local', label: 'automation: watchdog (on local, not your user)' },
  { at, mid, text: 'Paused your job. No reply needed.', task: 't-target', by: 'script' });

/** Sessions whose process the runner holds alive. */
const alive = new Set<string>();
async function target(status: 'idle' | 'stopped', sid = TARGET, taskId = 't-target'): Promise<void> {
  await createSessionRecord(sid, taskId, 'Acme', '/tmp', { initialProcessStatus: status });
  if (status === 'idle') alive.add(sid);
}
/** The runner drains the queue: what goes out in one line. */
async function drain(sid = TARGET): Promise<string[]> {
  return (await markProcessing(sid)).map((m) => m.id);
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  _clearHeldNotices();
  _resetQuietDelivery();
  _resetSessionTrackerForTesting();
  phases.clear();
  roles.clear();
  failHeldSends = 0;
  alive.clear();
  resetQuietTurnsForTest();
  _resetOrgEnabledForTesting(true);
  running.clear();
  sends = [];
  vi.spyOn(sessionRunner, 'isTurnRunning').mockImplementation((sid: string) => running.has(sid));
  vi.spyOn(sessionRunner, 'holdsLiveSession').mockImplementation((sid: string) => alive.has(sid));
  await createSessionRecord(SENDER, 't-vp', 'Acme', '/tmp', { initialProcessStatus: 'idle' });
  await startHeldNotices();
  bus.subscribe('quiet-due-test', (e) => {
    if (e.name !== EventNames.SESSION_SEND) return;
    sends.push({ sessionId: (e.data as { sessionId: string }).sessionId, source: e.source });
  }, { global: true, interest: [EventNames.SESSION_SEND] });
});

afterEach(async () => {
  stopColdHold();
  resetQuietTurnsForTest();
  _resetOrgEnabledForTesting();
  bus.unsubscribe('quiet-due-test');
  vi.restoreAllMocks();
  await stopHeldNotices();
  await _resetHeldStoreForTesting();
  resetCache();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('quiet notes past the max hold', () => {
  it('an idle target gets every held quiet note in ONE message once the oldest waited the max hold, not before', async () => {
    await target('idle');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-a', t0, 'The deploy is done.');
    await taskNote('qm-b', t0 + MIN, 'CI is green too.');
    await scriptNote('qm-c', t0 + 30_000);

    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS - 1);
    expect(sends).toEqual([]);
    expect(await getQueue(TARGET)).toEqual([]);
    expect((await heldNoteState('qm-a')).state).toBe('waiting');
    expect((await heldNoteState('qm-a')).why).toContain('goes on its own at');

    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(sends).toEqual([{ sessionId: TARGET, source: HELD_NOTES_SOURCE }]);
    const rows = await getQueue(TARGET);
    expect(rows).toHaveLength(1);
    for (const words of ['The deploy is done.', 'CI is green too.', 'Paused your job.', 'waited 60 minutes']) expect(rows[0].message).toContain(words);
    // No person's input: an agent's row, a quiet turn's (no phase, unread mark or board moves).
    expect(rows[0].sentBy).toBe('agent');
    expect(isQuietRowId(rows[0].id)).toBe(true);
    expect(isQuietTurn(TARGET)).toBe(true);
    expect(heldNoticeKeys(TARGET)).toEqual([]);
    // The row carries them from the moment it is stored: it is never dropped.
    for (const mid of ['qm-a', 'qm-b', 'qm-c']) expect(await heldNoteState(mid)).toMatchObject({ state: 'delivered', row: rows[0].id });
    expect(await drain()).toEqual([rows[0].id]);

    // Delivered once.
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + 5 * MIN);
    expect(sends).toHaveLength(1);
  });

  it('a target running a turn is not woken; the notes go on the first lap after the turn ended', async () => {
    await target('idle');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-r', t0, 'FYI.');
    running.add(TARGET);
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([]);
    expect(await heldNoteState('qm-r')).toMatchObject({ state: 'waiting', why: expect.stringContaining('running a turn') });

    running.delete(TARGET);
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + 2 * MIN);
    expect(sends).toEqual([{ sessionId: TARGET, source: HELD_NOTES_SOURCE }]);
    expect((await heldNoteState('qm-r')).state).toBe('delivered');
  });

  it('a target whose task is complete is not woken: the notes read not delivered and the sending task is told', async () => {
    await target('idle');
    phases.set('t-target', 'COMPLETE');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-d', t0, 'The review is in.');
    await scriptNote('qm-s', t0);
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(sends).toEqual([]);
    expect(await getQueue(TARGET)).toEqual([]);
    expect(heldNoticeKeys(TARGET)).toEqual([]);
    for (const mid of ['qm-d', 'qm-s']) {
      expect(await heldNoteState(mid)).toMatchObject({ state: 'dropped', why: DROP_WHY.complete });
      expect(DROP_WHY.complete).toMatch(/^not delivered: its task was complete/);
    }
    // The sender hears it (the drop-tell path): held for its next message, never a turn of its own.
    expect(await flushDropTells()).toBe(1);
    expect(heldNoticeKeys(SENDER)).toEqual([DROP_TELL_KEY]);
  });

  it('a stopped target is not started: its notes wait, say why, and ride its next message', async () => {
    await target('stopped');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-x', t0, 'FYI: the base image moved.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + 30 * MIN);
    expect(sends).toEqual([]);
    expect(await heldNoteState('qm-x')).toMatchObject({ state: 'waiting', why: STOPPED_WAIT_WHY });

    const row = await sendMessageToSession(TARGET, 'please pick the task up again', { source: 'ui' });
    expect(row.message).toContain('FYI: the base image moved.');
    expect(await heldNoteState('qm-x')).toMatchObject({ state: 'delivered', row: row.id });
  });

  it('a restart keeps the clock: what waited before it goes by its own time, not the restart\'s', async () => {
    await target('idle');
    const now = Date.now();
    await taskNote('qm-k', now - COLD_HOLD_MAX_MS + 10 * MIN, 'Held across a deploy.');
    await persist();
    await stopHeldNotices();
    await _resetHeldStoreForTesting({ keepFile: true });
    await startHeldNotices();
    expect(heldNoticeKeys(TARGET)).toHaveLength(1);

    await sweepColdHolds(now);
    expect(sends).toEqual([]);
    await sweepColdHolds(now + 10 * MIN);
    expect(sends).toEqual([{ sessionId: TARGET, source: HELD_NOTES_SOURCE }]);
    expect((await heldNoteState('qm-k')).state).toBe('delivered');
  });

  it('a send that takes the session before the quiet line went out: the line is not dropped, it goes in line as a normal row', async () => {
    await target('idle');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-o', t0, 'FYI: rebased.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    const [quietRow] = await getQueue(TARGET);
    const row = await sendMessageToSession(TARGET, 'how is it going?', { source: 'ui' });
    expect(isQuietTurn(TARGET)).toBe(false);
    expect(await drain()).toEqual([quietRow.id, row.id]);
    expect(await heldNoteState('qm-o')).toMatchObject({ state: 'delivered', row: quietRow.id });
  });

  it('a quiet line whose quiet turn ended unsent is asked to go as a normal message', async () => {
    await target('idle');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-e', t0, 'FYI.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    endQuietTurn(TARGET, 'turn-before-delivery');
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toEqual({ sessionId: TARGET, source: HELD_NOTES_SOURCE });
    expect((await getQueue(TARGET))).toHaveLength(1);
  });

  it('a write that failed (back to pending) or a restart mid-delivery: the quiet line goes again, never dropped', async () => {
    await target('idle');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-f', t0, 'FYI: shipped.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    const [quietRow] = await getQueue(TARGET);
    const line = await markProcessing(TARGET);
    await revertToPending(line);
    expect(await drain()).toEqual([quietRow.id]);
    // A restart: the quiet turn is forgotten and the processing row reads pending, in doubt.
    resetQuietTurnsForTest();
    await loadQueue();
    expect(await drain()).toEqual([quietRow.id]);
    expect(await heldNoteState('qm-f')).toMatchObject({ state: 'delivered', row: quietRow.id });
  });

  it('a quiet line a Stop sets aside is shown in the queue (its Retry reaches it); a Walnut command\'s quiet row is not', async () => {
    await target('idle');
    const queued: string[] = [];
    bus.subscribe('quiet-due-queued', (e) => { if (e.name === EventNames.SESSION_MESSAGE_QUEUED) queued.push((e.data as { messageId: string }).messageId); },
      { global: true, interest: [EventNames.SESSION_MESSAGE_QUEUED] });
    try {
      const t0 = Date.now() - 2 * MIN;
      await taskNote('qm-p', t0, 'FYI: parked by a Stop.');
      await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
      const [row] = await getQueue(TARGET);
      expect(queued).toEqual([row.id]);
      expect(await parkMessages([row], STOP_PARKED_REASON)).toBe(1);
      const shown = await withoutWalnutRows(await getQueue(TARGET));
      expect(shown.map((m) => m.id)).toEqual([row.id]);
      expect(await withoutWalnutRows([{ id: `${QUIET_ROW_PREFIX}idle-compact-x`, message: '/compact' }])).toEqual([]);
    } finally {
      bus.unsubscribe('quiet-due-queued');
    }
  });

  it('a quiet line that goes into a turn the CLI began by itself ends the quiet turn: that turn is a real one, not sent again', async () => {
    await target('idle');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-m', t0, 'FYI: written mid-turn.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    const [row] = await getQueue(TARGET);
    expect(isQuietTurn(TARGET)).toBe(true);
    expect((await markProcessing(TARGET, undefined, { midTurn: true })).map((m) => m.id)).toEqual([row.id]);
    expect(isQuietTurn(TARGET)).toBe(false);
    // The end listener sends nothing more: the row is on its way.
    await new Promise((r) => setTimeout(r, 50));
    expect(sends).toHaveLength(1);
  });

  it('a failed send keeps the notes; the next try delivers them', async () => {
    await target('idle');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-z', t0, 'FYI: retried.');
    failHeldSends = 1;
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(sends).toEqual([]);
    expect((await heldNoteState('qm-z')).state).toBe('waiting');
    expect(isQuietTurn(TARGET)).toBe(false);
    _resetQuietDelivery();
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([{ sessionId: TARGET, source: HELD_NOTES_SOURCE }]);
    expect((await heldNoteState('qm-z')).state).toBe('delivered');
  });

  it('the quiet line carries no riders: what arrives meanwhile waits for the next message', async () => {
    await target('idle');
    const notice = buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'status' }, body: 'a status notice' });
    void holdRidingNotice(TARGET, notice);
    const row = await sendMessageToSession(TARGET, 'the line', { source: HELD_NOTES_SOURCE, wakeReason: 'test', bare: true, hinted: true });
    expect(row.message).not.toContain('a status notice');
    expect(heldNoticeKeys(TARGET)).toEqual(['riding-notices']);
  });

  it('a task waiting on the user with a quiet turn available gets them quietly', async () => {
    await target('idle');
    phases.set('t-target', 'NEED_ACTION');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-q', t0, 'FYI: approved upstream.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    const [row] = await getQueue(TARGET);
    expect(isQuietRowId(row.id)).toBe(true);
    expect(isQuietTurn(TARGET)).toBe(true);
    expect((await heldNoteState('qm-q')).state).toBe('delivered');
  });

  it('no quiet turn can carry them: a normal message, but a task that waits on the user keeps them for its next message', async () => {
    await target('idle');
    await updateSessionRecord(TARGET, { pendingPermission: { requestId: 'perm-1', toolName: 'Bash' } });
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-n', t0, 'FYI: merged.');
    phases.set('t-target', 'NEED_ACTION');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(sends).toEqual([]);
    expect(await heldNoteState('qm-n')).toMatchObject({ state: 'waiting', why: NEED_ACTION_WAIT_WHY });

    phases.set('t-target', 'IN_PROGRESS');
    _resetQuietDelivery();
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([{ sessionId: TARGET, source: HELD_NOTES_SOURCE }]);
    const [row] = await getQueue(TARGET);
    expect(isQuietRowId(row.id)).toBe(false);
    expect(await heldNoteState('qm-n')).toMatchObject({ state: 'delivered', row: row.id });
  });

  it('Walnut\'s own wake=false notice never goes on its own; it keeps no lap running', async () => {
    await target('idle');
    const t0 = Date.now() - 2 * MIN;
    await holdQuietNote(TARGET, { key: 'Walnut (title-topic)@local', label: 'Walnut (title-topic)' }, { at: t0, mid: 'qm-w', text: 'Your title moved.', by: 'walnut' });
    // One held before `by` was kept reads Walnut's by its key.
    await holdQuietNote(TARGET, { key: 'Walnut (other)@local', label: 'Walnut (other)' }, { at: t0, mid: 'qm-w2', text: 'Older notice.' });
    const { deliverDueQuietNotes } = await import('../../../src/core/sessions/held-notices-sweep.js');
    expect(await deliverDueQuietNotes(t0 + 3 * COLD_HOLD_MAX_MS)).toBe(0);
    expect(sends).toEqual([]);
    expect((await heldNoteState('qm-w')).why).toContain('Walnut\'s own notice');
  });

  it('the org off: CEO or a VP is not woken; an idle record whose process is gone is stopped', async () => {
    await target('idle');
    roles.set('t-target', 'lead');
    _resetOrgEnabledForTesting(false);
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-g', t0, 'FYI.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(sends).toEqual([]);
    expect((await heldNoteState('qm-g')).why).toContain('the org is off');

    _resetOrgEnabledForTesting(true);
    alive.delete(TARGET);
    _resetQuietDelivery();
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([]);
    expect(await heldNoteState('qm-g')).toMatchObject({ state: 'waiting', why: STOPPED_WAIT_WHY });
  });

  it(`at most ${QUIET_DELIVERIES_PER_LAP} targets are sent to in one lap; the rest go the next`, async () => {
    const t0 = Date.now() - 2 * MIN;
    const sids = [0, 1, 2, 3].map((i) => `ffffffff-1111-4222-8333-55555555555${i}`);
    for (const [i, sid] of sids.entries()) {
      await target('idle', sid, `t-${i}`);
      await taskNote(`qm-cap-${i}`, t0, `FYI ${i}.`, sid);
    }
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(sends).toHaveLength(QUIET_DELIVERIES_PER_LAP);
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + MIN);
    expect(new Set(sends.map((x) => x.sessionId))).toEqual(new Set(sids));
  });
});
