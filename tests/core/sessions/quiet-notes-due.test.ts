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
 *  - a note that waits past the max hold for a reason that does not clear by itself tells its
 *    sender once (across laps and a restart) that it is not delivered yet; it stays held;
 *  - a sender's tell goes on its own to an idle sender once it waited the max hold; a stopped
 *    sender's tell waits and op_result says why; a complete sender's is written on the note's fate;
 *  - a sender no live session of which takes the tell is marked not told (op_result says so) and
 *    told again a max hold later; a tell that goes alone with no quiet turn keeps riding; tells
 *    never take a lap's sends from a quiet note; a delivery that keeps failing tells the sender
 *    once it failed for a max hold, and keeps trying; a delivered note's stale tell is withdrawn;
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
/** Tasks snoozed until a date (their start_date, src/core/snooze.ts). */
const snoozed = new Map<string, string>();
vi.mock('../../../src/core/task-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/task-manager.js')>();
  return {
    ...actual,
    getTask: async (id: string) => (phases.has(id) || roles.has(id) || snoozed.has(id)
      ? {
        id, phase: phases.get(id) ?? 'IN_PROGRESS',
        // The derived status a NEED_ACTION task carries (user-status.ts).
        ...(phases.get(id) === 'NEED_ACTION' ? { user_status: { state: 'needs' } } : {}),
        ...(snoozed.has(id) ? { start_date: snoozed.get(id) } : {}),
        ...(roles.has(id) ? { org_role: roles.get(id) } : {}),
      } : actual.getTask(id)),
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
import { QUIET_ROW_PREFIX, endQuietTurn, isQuietRowId, isQuietTurn, isRidingQuietRowId, resetQuietTurnsForTest } from '../../../src/core/sessions/quiet-turn.js';
import { _resetOrgEnabledForTesting } from '../../../src/core/org/org-enabled.js';
import { COLD_HOLD_MAX_MS, stopColdHold, sweepColdHolds } from '../../../src/core/sessions/cold-hold.js';
import { holdQuietNote } from '../../../src/core/sessions/quiet-notes.js';
import { readDeliveryLines } from '../../../src/core/sessions/delivery-ledger.js';
import path from 'node:path';
import { DROP_WHY, _clearHeldNotices, heldNoteState, heldNoticeKeys, holdFoldedNotice } from '../../../src/core/sessions/held-notices.js';
import { _resetHeldStoreForTesting, held, persist } from '../../../src/core/sessions/held-notices-store.js';
import {
  DROP_TELL_KEY, HELD_NOTES_SOURCE, NEED_ACTION_WAIT_WHY, QUIET_DELIVERIES_PER_LAP, QUIET_WAITS, SNOOZED_WAIT_WHY, STOPPED_WAIT_WHY, _resetQuietDelivery,
  flushDropTells, startHeldNotices, stopHeldNotices, waitWhy,
} from '../../../src/core/sessions/held-notices-sweep.js';

const TARGET = 'dddddddd-1111-4222-8333-555555555555';

/** The tells still to be held for a sender, as the file has them now (in flight included). */
async function queuedTells(): Promise<Array<{ callerSid: string; kind?: string; mid?: string }>> {
  await persist();
  return JSON.parse(await fsp.readFile(path.join(WALNUT_HOME, 'cache', 'held-notices.json'), 'utf8')).tells ?? [];
}
/** The tells held for `sid` (under DROP_TELL_KEY), once every queued one was held. */
async function heldTells(sid: string): Promise<Array<{ text: string; told: Array<{ mid?: string; kind?: string }> }>> {
  await flushDropTells();
  await vi.waitFor(async () => expect(await queuedTells()).toEqual([]));
  return (held.get(sid)?.get(DROP_TELL_KEY)?.parts ?? []) as Array<{ text: string; told: Array<{ mid?: string; kind?: string }> }>;
}
const SENDER = 'eeeeeeee-1111-4222-8333-555555555555';
const MIN = 60_000;
/**
 * The ledger's `told` steps of a note, once written (2026-11-27, the Reflection VP's audit: a held
 * note's sender was told it still waited, the ledger had no `told`, and the audit read it as never told).
 */
async function toldInLedger(mid: string, n = 1): Promise<Array<{ via?: string; told?: string; sessionId?: string }>> {
  let out: Array<{ via?: string; told?: string; sessionId?: string }> = [];
  await vi.waitFor(async () => {
    out = (await readDeliveryLines(1)).filter((l) => l.id === mid && l.step === 'told');
    expect(out).toHaveLength(n);
  });
  return out;
}

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
  snoozed.clear();
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
    await sweepColdHolds(t0 + 2 * COLD_HOLD_MAX_MS);
    expect(sends).toEqual([]);
    expect(await heldNoteState('qm-r')).toMatchObject({ state: 'waiting', why: expect.stringContaining('running a turn') });
    // A turn ends by itself: its sender is not told it waits, unless it runs for three max holds.
    expect(await queuedTells()).toEqual([]);
    await sweepColdHolds(t0 + 3 * COLD_HOLD_MAX_MS + MIN);
    expect((await heldTells(SENDER))[0].text).toContain(`not delivered yet: ${QUIET_WAITS.running.cause}.`);

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

  it('a stopped target: the sender is told ONCE (across laps and a restart) that the note is not delivered yet; it stays held and is delivered when the target runs', async () => {
    await target('stopped');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-st', t0, 'FYI: the cache was rebuilt.');
    // Not before the max hold.
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS - MIN);
    expect(await queuedTells()).toEqual([]);

    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([]);
    const tells = await heldTells(SENDER);
    expect(tells).toHaveLength(1);
    expect(tells[0].told).toMatchObject([{ mid: 'qm-st', kind: 'waiting' }]);
    expect(await toldInLedger('qm-st')).toEqual([expect.objectContaining({ via: 'note-wait', told: SENDER, sessionId: TARGET })]);
    expect(tells[0].text).toContain('outcome="note-held"');
    expect(tells[0].text).toContain(`"note qm-st", sent ${new Date(t0).toISOString().slice(0, 16).replace('T', ' ')} UTC: not delivered yet: ${QUIET_WAITS.stopped.cause}. `
      + 'It stays held and rides task t-target\'s next message; send it again without wake=false (or task_start that task) to have it read now.');
    // The note itself still waits for its target, and op_result says its sender's notice is on its way.
    expect(await heldNoteState('qm-st')).toMatchObject({ state: 'waiting', why: STOPPED_WAIT_WHY, sender_told: expect.stringContaining('is not delivered yet') });

    // Another lap, and a restart: never told twice.
    _resetQuietDelivery();
    await sweepColdHolds(t0 + 3 * COLD_HOLD_MAX_MS);
    expect(await queuedTells()).toEqual([]);
    await stopHeldNotices();
    await _resetHeldStoreForTesting({ keepFile: true });
    _resetQuietDelivery();
    await startHeldNotices();
    await sweepColdHolds(t0 + 4 * COLD_HOLD_MAX_MS);
    expect(await queuedTells()).toEqual([]);
    expect(await heldTells(SENDER)).toHaveLength(1);
    expect(await toldInLedger('qm-st')).toHaveLength(1);

    // The target's next run carries it, and the sender's tell that it waits is withdrawn (stale).
    const row = await sendMessageToSession(TARGET, 'pick the task up again', { source: 'ui' });
    expect(row.message).toContain('FYI: the cache was rebuilt.');
    expect(await heldNoteState('qm-st')).toMatchObject({ state: 'delivered', row: row.id });
    expect(heldNoticeKeys(SENDER)).toEqual([]);
  });

  it('a waiting tell no live session takes: the note reads not told, is told again a max hold later, and again if the sender\'s task completes first', async () => {
    await target('stopped');
    await updateSessionRecord(SENDER, { archived: true });
    // Sent a max hold ago, so the lap's clock is the flush's (the tell is tried at the real time).
    const now = Date.now();
    await taskNote('qm-un', now - COLD_HOLD_MAX_MS - MIN, 'FYI: untold.');
    await sweepColdHolds(now);
    expect(await heldTells(SENDER)).toEqual([]);
    expect(await heldNoteState('qm-un')).toMatchObject({ state: 'waiting', sender_told: expect.stringContaining('not told yet') });

    // The sender's session is back: not retried within a max hold, then told.
    await updateSessionRecord(SENDER, { archived: false });
    await sweepColdHolds(now + 20 * MIN);
    expect(await queuedTells()).toEqual([]);
    await sweepColdHolds(now + COLD_HOLD_MAX_MS + 5 * MIN);
    expect(await heldTells(SENDER)).toHaveLength(1);

    // Its tell is dropped (the sender's task completed): not told again, said so.
    phases.set('t-vp', 'COMPLETE');
    alive.add(SENDER);
    const tellAt = Date.now();
    await sweepColdHolds(tellAt + COLD_HOLD_MAX_MS + MIN);
    expect(heldNoticeKeys(SENDER)).toEqual([]);
    expect(await heldNoteState('qm-un')).toMatchObject({ state: 'waiting', sender_told: expect.stringContaining('not told yet') });
  });

  it('a sender holding only Walnut\'s tells with no quiet turn: they keep riding (no normal turn), and go as a quiet turn once one can', async () => {
    await target('idle');
    alive.add(SENDER);
    await updateSessionRecord(SENDER, { pendingPermission: { requestId: 'perm-t', toolName: 'Bash' } });
    phases.set('t-target', 'COMPLETE');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-tq', t0, 'FYI: done.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(await heldTells(SENDER)).toHaveLength(1);
    const tellAt = Date.now();
    await sweepColdHolds(tellAt + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([]);
    expect(await heldNoteState('qm-tq')).toMatchObject({ state: 'dropped', sender_told: expect.stringContaining(waitWhy('tellNoQuietTurn')) });

    await updateSessionRecord(SENDER, { pendingPermission: undefined });
    _resetQuietDelivery();
    await sweepColdHolds(tellAt + COLD_HOLD_MAX_MS + 2 * MIN);
    expect(sends).toEqual([{ sessionId: SENDER, source: HELD_NOTES_SOURCE }]);
    const [row] = await getQueue(SENDER);
    expect(isQuietRowId(row.id)).toBe(true);
    expect(row.message).toContain('outcome="note-dropped"');
  });

  it('a tells-only quiet line whose quiet turn ends unsent never goes as a normal turn: it stays queued and rides the next message', async () => {
    await target('idle');
    alive.add(SENDER);
    phases.set('t-target', 'COMPLETE');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-rq', t0, 'FYI: done.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(await heldTells(SENDER)).toHaveLength(1);
    await sweepColdHolds(Date.now() + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([{ sessionId: SENDER, source: HELD_NOTES_SOURCE }]);
    const [quietRow] = await getQueue(SENDER);
    expect(isRidingQuietRowId(quietRow.id)).toBe(true);

    endQuietTurn(SENDER, 'turn-before-delivery');
    // Not asked to go, and no drain takes it alone (a restart's included).
    await new Promise((r) => setImmediate(r));
    expect(sends).toHaveLength(1);
    expect(await drain(SENDER)).toEqual([]);
    resetQuietTurnsForTest();
    expect(await drain(SENDER)).toEqual([]);
    expect((await getQueue(SENDER)).map((m) => m.id)).toEqual([quietRow.id]);

    const row = await sendMessageToSession(SENDER, 'next task step', { source: 'ui' });
    expect(await drain(SENDER)).toEqual([quietRow.id, row.id]);
  });

  it('an old tell never makes a new quiet note due at once', async () => {
    await target('idle');
    alive.add(SENDER);
    await updateSessionRecord(SENDER, { pendingPermission: { requestId: 'perm-o', toolName: 'Bash' } });
    const now = Date.now();
    await holdFoldedNotice(SENDER, DROP_TELL_KEY, { at: now - 3 * COLD_HOLD_MAX_MS, text: 'old tell', whole: true, told: [] }, (parts) => parts.map((p) => p.text).join('\n\n'));
    await holdQuietNote(SENDER, { key: TARGET, label: 'Target [dddddddd]' },
      { at: now, mid: 'qm-new', title: 'new', text: 'FYI: brand new.', from: TARGET, whole: true, task: 't-vp', by: 'session' });
    await sweepColdHolds(now + MIN);
    expect(sends).toEqual([]);
    await sweepColdHolds(now + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([{ sessionId: SENDER, source: HELD_NOTES_SOURCE }]);
    expect((await heldNoteState('qm-new')).state).toBe('delivered');
  });

  it('a sender whose task is complete is not told a note still waits, recorded once and never retried', async () => {
    await target('stopped');
    alive.add(SENDER);
    phases.set('t-vp', 'COMPLETE');
    const now = Date.now();
    await taskNote('qm-cs', now - COLD_HOLD_MAX_MS - MIN, 'FYI.');
    await sweepColdHolds(now);
    expect(await heldTells(SENDER)).toEqual([]);
    expect(await heldNoteState('qm-cs')).toMatchObject({ state: 'waiting', sender_told: expect.stringMatching(/^not told \(.*its task is complete/) });
    _resetQuietDelivery();
    await sweepColdHolds(now + 2 * COLD_HOLD_MAX_MS);
    expect(await queuedTells()).toEqual([]);
  });

  it('tells that fall due at once never take a lap\'s sends from a quiet note', async () => {
    const t0 = Date.now() - 2 * MIN;
    const senders = [0, 1, 2].map((i) => `aaaaaaaa-1111-4222-8333-55555555555${i}`);
    for (const [i, sid] of senders.entries()) {
      await target('idle', sid, `t-s${i}`);
      await holdFoldedNotice(sid, DROP_TELL_KEY, { at: t0, text: `old tell ${i}`, whole: true, told: [] }, (parts) => parts.map((p) => p.text).join('\n\n'));
    }
    await target('idle');
    await taskNote('qm-first', t0 + MIN, 'FYI: younger than the tells.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + 2 * MIN);
    expect(sends).toHaveLength(QUIET_DELIVERIES_PER_LAP);
    expect(sends.map((x) => x.sessionId)).toContain(TARGET);
  });

  it('a delivery that keeps failing is retried, and once it failed for a max hold the sender is told; it is still delivered after', async () => {
    await target('idle');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-fl', t0, 'FYI: retried forever.');
    failHeldSends = 1_000;
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(await heldNoteState('qm-fl')).toMatchObject({ state: 'waiting', why: waitWhy('failing') });
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + 11 * MIN);
    expect(await queuedTells()).toEqual([]);
    await sweepColdHolds(t0 + 2 * COLD_HOLD_MAX_MS + MIN);
    const tells = await heldTells(SENDER);
    expect(tells).toHaveLength(1);
    expect(tells[0].text).toContain(`not delivered yet: ${QUIET_WAITS.failing.cause}.`);
    expect(sends).toEqual([]);

    failHeldSends = 0;
    await sweepColdHolds(t0 + 2 * COLD_HOLD_MAX_MS + 12 * MIN);
    expect(sends).toEqual([{ sessionId: TARGET, source: HELD_NOTES_SOURCE }]);
    expect((await heldNoteState('qm-fl')).state).toBe('delivered');
    expect(heldNoticeKeys(SENDER)).toEqual([]);
  });

  it('a delivery that keeps failing across restarts (the failure clock forgotten) still tells the sender, by the note\'s own age', async () => {
    await target('idle');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-fr', t0, 'FYI: failing across deploys.');
    failHeldSends = 1_000;
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    // A restart forgets when it first failed: each lap after one reads as a first failure.
    _resetQuietDelivery();
    await sweepColdHolds(t0 + 2 * COLD_HOLD_MAX_MS - MIN);
    expect(await queuedTells()).toEqual([]);
    _resetQuietDelivery();
    await sweepColdHolds(t0 + 2 * COLD_HOLD_MAX_MS + MIN);
    expect((await heldTells(SENDER))[0].text).toContain(`not delivered yet: ${QUIET_WAITS.failing.cause}.`);
  });

  it('a script\'s note has no session to tell; a note younger than the max hold is told on a later lap', async () => {
    await target('stopped');
    const t0 = Date.now() - 2 * MIN;
    await scriptNote('qm-sc', t0);
    await taskNote('qm-late', t0 + 30 * MIN, 'FYI: later.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + MIN);
    expect(await queuedTells()).toEqual([]);
    _resetQuietDelivery();
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + 31 * MIN);
    expect((await heldTells(SENDER)).flatMap((p) => p.told.map((t) => t.mid))).toEqual(['qm-late']);
  });

  it('a completed target: the note is dropped, and its tell goes to an idle sender that gets no other message once the tell waited the max hold', async () => {
    await target('idle');
    alive.add(SENDER);
    phases.set('t-target', 'COMPLETE');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-cd', t0, 'The rollout finished.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(await heldNoteState('qm-cd')).toMatchObject({ state: 'dropped', why: DROP_WHY.complete });
    expect(await heldTells(SENDER)).toHaveLength(1);
    expect(await toldInLedger('qm-cd')).toEqual([expect.objectContaining({ via: 'note-void', told: SENDER, sessionId: TARGET })]);
    expect(sends).toEqual([]);

    const heldAt = Date.now();
    await sweepColdHolds(heldAt + COLD_HOLD_MAX_MS - 5 * MIN);
    expect(sends).toEqual([]);
    await sweepColdHolds(heldAt + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([{ sessionId: SENDER, source: HELD_NOTES_SOURCE }]);
    const [row] = await getQueue(SENDER);
    expect(row.message).toContain('outcome="note-dropped"');
    expect(row.message).toContain('NOT delivered');
    expect(heldNoticeKeys(SENDER)).toEqual([]);
    // Delivered once.
    await sweepColdHolds(heldAt + 2 * COLD_HOLD_MAX_MS);
    expect(sends).toHaveLength(1);
  });

  it('a stopped sender\'s tell waits and op_result says why; once the sender\'s task is complete it is written on the note\'s fate', async () => {
    await target('idle');
    phases.set('t-target', 'COMPLETE');
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-sd', t0, 'The rollout finished.');
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(await heldTells(SENDER)).toHaveLength(1);

    // SENDER's record reads idle but its process is gone: stopped.
    const heldAt = Date.now();
    await sweepColdHolds(heldAt + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([]);
    expect(await heldNoteState('qm-sd')).toMatchObject({ state: 'dropped', sender_told: expect.stringContaining(STOPPED_WAIT_WHY) });
    // A tell is never told about in turn.
    expect(await queuedTells()).toEqual([]);

    phases.set('t-vp', 'COMPLETE');
    _resetQuietDelivery();
    await sweepColdHolds(heldAt + COLD_HOLD_MAX_MS + 20 * MIN);
    expect(heldNoticeKeys(SENDER)).toEqual([]);
    const state = await heldNoteState('qm-sd');
    expect(state).toMatchObject({ state: 'dropped' });
    expect(state.why).toContain(DROP_WHY.complete);
    expect(state.why).toContain(`its sender was not told either: the notice that would tell it was dropped too, as ${DROP_WHY.tellComplete}`);
    expect(state.sender_told).toBeUndefined();
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

  it('no quiet turn can carry them and the task is snoozed: they wait for the snooze, then go as a normal message', async () => {
    await target('idle');
    await updateSessionRecord(TARGET, { pendingPermission: { requestId: 'perm-2', toolName: 'Bash' } });
    const t0 = Date.now() - 2 * MIN;
    await taskNote('qm-s', t0, 'FYI: shipped.');
    snoozed.set('t-target', new Date(Date.now() + 24 * 60 * MIN).toISOString().slice(0, 10));
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS);
    expect(sends).toEqual([]);
    expect(await heldNoteState('qm-s')).toMatchObject({ state: 'waiting', why: SNOOZED_WAIT_WHY });

    snoozed.delete('t-target');
    _resetQuietDelivery();
    await sweepColdHolds(t0 + COLD_HOLD_MAX_MS + MIN);
    expect(sends).toEqual([{ sessionId: TARGET, source: HELD_NOTES_SOURCE }]);
    expect((await heldNoteState('qm-s')).state).toBe('delivered');
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
