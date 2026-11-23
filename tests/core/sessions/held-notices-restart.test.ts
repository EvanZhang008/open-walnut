/**
 * A note that asks nothing (task_send wake=false), and every other notice that waits to ride a
 * session's next message, survives a restart (src/core/sessions/held-notices-store.ts).
 * 2026-11-21: three such notes from a lead to one task were held in server memory only, deploys
 * restarted the server within minutes, the notes were gone, nobody was told, and op_result kept
 * reading "applied, delivery held".
 *
 * Pinned here, through the real send entry point, the real queue file and the real session store:
 *  - a held note is on disk before its send is answered, and after a restart it rides the target's
 *    next message, once (a later restart, or a replay of the same send, holds nothing again);
 *  - a riding notice and a request's deadline notice survive a restart the same way;
 *  - a note dropped anyway (its target session gone, its age limit) is recorded dropped and its
 *    sending session is told, riding that session's next message; a session that took over
 *    (an engine switch's) gets what waited instead;
 *  - a file of another shape, or none, reads as empty.
 * A restart here is what one does to this process: the module memory forgotten, the file read again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>();
  return { ...actual, ...createMockConstants('walnut-held-restart') };
});

import { WALNUT_HOME } from '../../../src/constants.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { buildWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js';
import { resetCache, sendMessageToSession } from '../../../src/core/session-message-queue.js';
import {
  createSessionRecord, deleteSessionRecords, updateSessionRecord, _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js';
import { performSessionSend } from '../../../src/core/sessions/session-send-core.js';
import { holdQuietNote } from '../../../src/core/sessions/quiet-notes.js';
import {
  DROP_WHY, _clearHeldNotices, heldNoteState, heldNoticeKeys, holdNotice, pendingHeldNotices,
} from '../../../src/core/sessions/held-notices.js';
import { HOLD_MAX_MS, _resetHeldStoreForTesting } from '../../../src/core/sessions/held-notices-store.js';
import { startHeldNotices, stopHeldNotices, sweepHeldNotices } from '../../../src/core/sessions/held-notices-sweep.js';

const TARGET = 'aaaaaaaa-1111-4222-8333-000000000001';
const SENDER = 'aaaaaaaa-1111-4222-8333-000000000002';
const TAKER = 'aaaaaaaa-1111-4222-8333-000000000003';
const FILE = () => path.join(WALNUT_HOME, 'cache', 'held-notices.json');

let kicks: string[] = [];

/** What a restart does to this process: memory gone, the file kept, then read again at boot. */
async function restart(): Promise<void> {
  await stopHeldNotices();
  await _resetHeldStoreForTesting({ keepFile: true });
  resetCache();
  await startHeldNotices();
}

const fromSender = { key: SENDER, label: 'Lead [aaaaaaaa]' };

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  _clearHeldNotices();
  _resetSessionTrackerForTesting();
  await createSessionRecord(TARGET, 't-target', 'Acme', '/tmp', { initialProcessStatus: 'idle', title: 'Target' });
  await createSessionRecord(SENDER, 't-sender', 'Acme', '/tmp', { initialProcessStatus: 'idle', title: 'Lead' });
  await startHeldNotices();
  kicks = [];
  bus.subscribe('held-restart-test', (e) => {
    if (e.name === EventNames.SESSION_SEND) kicks.push(String((e.data as { sessionId?: string }).sessionId));
  }, { global: true, interest: [EventNames.SESSION_SEND] });
});

afterEach(async () => {
  bus.unsubscribe('held-restart-test');
  await stopHeldNotices();
  await _resetHeldStoreForTesting();
  resetCache();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('a held note survives a restart', () => {
  it('a wake=false send is on disk when it is answered, and after a restart rides the target\'s next message once', async () => {
    const sent = await performSessionSend({
      to: TARGET, text: 'FYI: the build is green.', title: 'Build green', callerSid: 'external',
      callerLabel: 'ci-watch', callerHost: 'devbox', wake: false, messageId: 'qm-quiet-0001',
    });
    expect(sent).toMatchObject({ delivery: 'held', messageId: 'qm-quiet-0001', targetSessionId: TARGET });
    // Written before the answer came back: a restart right now keeps it.
    expect(await fsp.readFile(FILE(), 'utf8')).toContain('qm-quiet-0001');
    expect(kicks).toEqual([]);

    await restart();
    expect(heldNoticeKeys(TARGET)).toEqual(['quiet-note:automation: ci-watch@devbox']);
    expect(await heldNoteState('qm-quiet-0001')).toMatchObject({ state: 'waiting', session_id: TARGET });
    // The same note again (a replay of its call, by its message id) holds nothing more.
    expect((await holdQuietNote(TARGET, fromSender, { at: Date.now(), text: 'FYI: the build is green.', mid: 'qm-quiet-0001' })).duplicate).toBe(true);
    expect(heldNoticeKeys(TARGET)).toEqual(['quiet-note:automation: ci-watch@devbox']);

    const row = await sendMessageToSession(TARGET, 'hello from the user', { source: 'ui' });
    expect(kicks).toEqual([TARGET]);
    expect(row.message.split('FYI: the build is green.')).toHaveLength(2);
    expect(row.message.indexOf('FYI: the build is green.')).toBeLessThan(row.message.indexOf('hello from the user'));
    expect(await heldNoteState('qm-quiet-0001')).toMatchObject({ state: 'delivered', session_id: TARGET, row: row.id });

    // Told once: another restart and another message carry nothing, and a late replay holds nothing.
    await restart();
    expect(heldNoticeKeys(TARGET)).toEqual([]);
    expect(await heldNoteState('qm-quiet-0001')).toMatchObject({ state: 'delivered', row: row.id });
    expect((await holdQuietNote(TARGET, fromSender, { at: Date.now(), text: 'late copy', mid: 'qm-quiet-0001' })).duplicate).toBe(true);
    const next = await sendMessageToSession(TARGET, 'and again', { source: 'ui' });
    expect(next.message).not.toContain('FYI: the build is green.');
    expect(next.message).not.toContain('late copy');
  });

  it('a session\'s notes fold as one notice after a restart, the restored ones with the new one', async () => {
    for (const n of [1, 2]) {
      await holdQuietNote(TARGET, fromSender, { at: Date.now() + n, title: `note ${n}`, text: `Restored note number ${n}.`, mid: `qm-fold-${n}`, from: SENDER, task: 't-target' });
    }
    await restart();
    await holdQuietNote(TARGET, fromSender, { at: Date.now() + 3, title: 'note 3', text: 'A note held after the restart.', mid: 'qm-fold-3', from: SENDER });
    const held = (await pendingHeldNotices(TARGET))!;
    expect(held.text).toContain('3 notes from Lead [aaaaaaaa]');
    for (const words of ['Restored note number 1.', 'Restored note number 2.', 'A note held after the restart.']) expect(held.text).toContain(words);
    held.release();
  });

  it('a riding notice and a request\'s deadline notice wait across a restart too', async () => {
    const status = buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'status' }, body: 'Task X is done.' });
    await sendMessageToSession(TARGET, status, { source: 'walnut-notify' });
    await holdNotice(TARGET, 'topic-not-taken:tp-1', 'TOPIC NOT TAKEN');
    expect(kicks).toEqual([]);
    await restart();
    expect(heldNoticeKeys(TARGET).sort()).toEqual(['riding-notices', 'topic-not-taken:tp-1']);
    const row = await sendMessageToSession(TARGET, 'next', { source: 'ui' });
    expect(row.message).toContain('Task X is done.');
    expect(row.message).toContain('TOPIC NOT TAKEN');
  });

  it('notices a message took but never stored are in the file until it is, and wait again after a restart', async () => {
    await holdQuietNote(TARGET, fromSender, { at: Date.now(), text: 'Taken but not yet stored.', mid: 'qm-taken-1' });
    const taken = (await pendingHeldNotices(TARGET))!;
    expect(taken.text).toContain('Taken but not yet stored.');
    // The server dies before the row that carries it is stored.
    await restart();
    expect(heldNoticeKeys(TARGET)).toEqual([`quiet-note:${SENDER}`]);
    const row = await sendMessageToSession(TARGET, 'next', { source: 'ui' });
    expect(row.message).toContain('Taken but not yet stored.');
  });

  it('a file of another shape, or none, reads as empty; a file a newer release wrote is set aside, never written over', async () => {
    for (const body of ['not json', JSON.stringify({ version: 99, sessions: { [TARGET]: { k: { text: 'NEWER', at: Date.now() } } } }), JSON.stringify([1, 2])]) {
      await stopHeldNotices();
      await _resetHeldStoreForTesting();
      await fsp.rm(path.dirname(FILE()), { recursive: true, force: true });
      await fsp.mkdir(path.dirname(FILE()), { recursive: true });
      await fsp.writeFile(FILE(), body);
      await startHeldNotices();
      expect(heldNoticeKeys(TARGET)).toEqual([]);
      await holdNotice(TARGET, 'k', 'NEW');
      const aside = (await fsp.readdir(path.dirname(FILE()))).filter((f) => f.startsWith('held-notices.json.backup-'));
      expect(aside).toHaveLength(1);
      expect(await fsp.readFile(path.join(path.dirname(FILE()), aside[0]), 'utf8')).toBe(body);
    }
    await stopHeldNotices();
    await _resetHeldStoreForTesting();
    await startHeldNotices();
    expect(heldNoticeKeys(TARGET)).toEqual([]);
  });
});

describe('a note dropped anyway tells its sender', () => {
  it('its target session is gone: dropped, op_result says why, and the sender hears with its next message', async () => {
    await holdQuietNote(TARGET, fromSender, { at: Date.now(), title: 'Docs moved', text: 'FYI: the docs moved.', mid: 'qm-gone-1', from: SENDER, task: 't-target' });
    await deleteSessionRecords(new Set([TARGET]), 'test');
    // Gone on one lap is not enough (a switch or a retry may be between its two records).
    expect(await sweepHeldNotices()).toEqual({ dropped: 0, moved: 0 });
    expect(await heldNoteState('qm-gone-1')).toMatchObject({ state: 'waiting' });
    const { dropped } = await sweepHeldNotices();
    expect(dropped).toBe(1);
    expect(heldNoticeKeys(TARGET)).toEqual([]);
    expect(await heldNoteState('qm-gone-1')).toMatchObject({ state: 'dropped', why: DROP_WHY.gone });
    // The sender's notice asks nothing either: it rides the sender's next message, no turn of its own.
    expect(kicks).toEqual([]);
    expect(heldNoticeKeys(SENDER)).toEqual(['riding-notices']);
    // And it survives a restart like any held notice.
    await restart();
    const row = await sendMessageToSession(SENDER, 'what next', { source: 'ui' });
    expect(row.message).toContain('outcome="note-dropped"');
    expect(row.message).toContain('NOT delivered');
    expect(row.message).toContain('task_send t-target: "Docs moved"');
    expect(row.message).toContain(DROP_WHY.gone);
    // Told once.
    expect(await heldNoteState('qm-gone-1')).toMatchObject({ state: 'dropped' });
  });

  it('past its age limit: dropped and told; a Walnut notice that old is dropped without a word', async () => {
    const old = Date.now() - HOLD_MAX_MS - 60_000;
    await holdQuietNote(TARGET, fromSender, { at: old, title: 'Old news', text: 'FYI: old news.', mid: 'qm-old-1', from: SENDER, task: 't-target' });
    await holdNotice(TARGET, 'topic-not-taken:tp-2', 'OLD WALNUT NOTICE', { now: old });
    const { dropped } = await sweepHeldNotices();
    expect(dropped).toBe(2);
    expect(await heldNoteState('qm-old-1')).toMatchObject({ state: 'dropped', why: DROP_WHY.age });
    const held = (await pendingHeldNotices(SENDER))!;
    expect(held.text).toContain('"Old news"');
    expect(held.text).toContain(DROP_WHY.age);
    expect(held.text).not.toContain('OLD WALNUT NOTICE');
  });

  it('a session whose id changes takes what waits with its queue; one whose record went follows its task', async () => {
    const { migrateSessionQueue } = await import('../../../src/core/session-queue-park.js');
    await holdQuietNote(TARGET, fromSender, { at: Date.now(), text: 'FYI: renamed or not.', mid: 'qm-rename-1', from: SENDER, task: 't-target' });
    // A status line riding the old id goes along too (status-riding.ts, review 2026-11-23).
    const riding = await import('../../../src/core/sessions/status-riding.js');
    riding.rideLine(TARGET, 't-worker', 'Worker: build green');
    await migrateSessionQueue(TARGET, TAKER);
    expect(heldNoticeKeys(TARGET)).toEqual([]);
    expect(await heldNoteState('qm-rename-1')).toMatchObject({ state: 'waiting', session_id: TAKER });
    expect(riding.pendingRiding(TARGET)).toBeNull();
    expect(riding.pendingRiding(TAKER)?.text).toContain('Worker: build green');
    // Its record is gone but the task it was for has a session that goes on: it moves there.
    const { addTask } = await import('../../../src/core/task-manager.js');
    const task = (await addTask({ title: 'Target task', project: 'Acme' })).task;
    const OTHER = 'aaaaaaaa-1111-4222-8333-000000000004';
    await createSessionRecord(OTHER, task.id, 'Acme', '/tmp', { initialProcessStatus: 'idle', title: 'Target task' });
    const { linkSessionSlot, getTask } = await import('../../../src/core/task-manager.js');
    await linkSessionSlot(task.id, OTHER, 'exec');
    expect((await getTask(task.id)).session_id).toBe(OTHER);
    await holdQuietNote(TAKER, { key: 'k2', label: 'Lead' }, { at: Date.now(), text: 'FYI: follows the task.', mid: 'qm-task-1', from: SENDER, task: task.id });
    // Both notices waiting for the record-less id (the renamed one's and this one) go on with the task's session.
    expect(await sweepHeldNotices()).toEqual({ dropped: 0, moved: 2 });
    expect(await heldNoteState('qm-task-1')).toMatchObject({ state: 'waiting', session_id: OTHER });
    expect(await heldNoteState('qm-rename-1')).toMatchObject({ state: 'waiting', session_id: OTHER });
  });

  it('a session an engine switch replaced hands what waits to the one that took over, not dropped', async () => {
    await holdQuietNote(TARGET, fromSender, { at: Date.now(), text: 'FYI: for whoever runs the target.', mid: 'qm-move-1', from: SENDER });
    await updateSessionRecord(TARGET, { archived: true, archive_reason: 'engine_switched', supersededBy: TAKER } as never);
    // (Its own task id here: the store keeps one active session per task, and the link is the record's.)
    await createSessionRecord(TAKER, 't-taker', 'Acme', '/tmp', { initialProcessStatus: 'idle', title: 'Target' });
    expect(await sweepHeldNotices()).toEqual({ dropped: 0, moved: 1 });
    expect(heldNoticeKeys(TARGET)).toEqual([]);
    expect(await heldNoteState('qm-move-1')).toMatchObject({ state: 'waiting', session_id: TAKER });
    const row = await sendMessageToSession(TAKER, 'hello', { source: 'ui' });
    expect(row.message).toContain('FYI: for whoever runs the target.');
    expect(heldNoticeKeys(SENDER)).toEqual([]);
  });
});
