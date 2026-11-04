/**
 * A message lined up for AFTER the running turn (src/core/sessions/queue-after-turn.ts):
 * held in the durable queue while the turn runs, shown as an ordinary pending row,
 * editable and withdrawable until then, and sent as the next turn (one row at a time)
 * when the turn ends. A Stop that comes after the hold sets the row aside instead.
 *
 * Real queue file and real bus; only the runner's "is a turn running" answer is scripted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-queue-after-turn'));

import { WALNUT_HOME } from '../../../src/constants.js';
import { sessionRunner } from '../../../src/providers/claude-code-session.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import {
  resetCache, sendMessageToSession, getQueue, editMessage, deleteMessage, enqueueMessage,
} from '../../../src/core/session-message-queue.js';
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js';
import { getSessionQueuePayload } from '../../../src/core/sessions/session-extras.js';
import { STOP_PARKED_REASON } from '../../../src/core/relay-fates.js';
import {
  AFTER_TURN_REASON, isAfterTurnHold, presentAfterTurn, releaseAfterTurn, setAsideAfterTurnHolds,
  startQueueAfterTurn, stopQueueAfterTurn,
} from '../../../src/core/sessions/queue-after-turn.js';

const running = new Set<string>();
let sends: Array<{ sessionId: string; interrupt?: boolean; source: string }> = [];

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  running.clear();
  sends = [];
  vi.spyOn(sessionRunner, 'isTurnRunning').mockImplementation((sid: string) => running.has(sid));
  bus.subscribe('test-after-turn-sends', (e) => {
    if (e.name !== EventNames.SESSION_SEND) return;
    const d = e.data as { sessionId: string; interrupt?: boolean };
    sends.push({ sessionId: d.sessionId, interrupt: d.interrupt, source: e.source });
  }, { global: true, interest: [EventNames.SESSION_SEND] });
});

afterEach(async () => {
  stopQueueAfterTurn();
  bus.unsubscribe('test-after-turn-sends');
  vi.restoreAllMocks();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

async function waitFor(what: string, ok: () => Promise<boolean> | boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const hold = (sid: string, text: string, extra?: Record<string, unknown>) =>
  sendMessageToSession(sid, text, { source: 'mobile', afterTurn: true, ...extra });

describe('a send lined up for after the turn', () => {
  it('is held, parked under its reason, while a turn runs: nothing is written to the CLI', async () => {
    running.add('s1');
    const row = await hold('s1', 'then do this');
    expect(row.status).toBe('parked');
    expect(row.parkedReason).toBe(AFTER_TURN_REASON);
    expect(isAfterTurnHold(row)).toBe(true);
    expect(sends).toEqual([]);
  });

  it('goes straight out when no turn runs (nothing to wait for)', async () => {
    const row = await hold('s2', 'idle send');
    expect(row.status).toBe('pending');
    expect(sends.map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('is not held while the turn waits on a permission prompt: the words are the answer', async () => {
    running.add('s3b');
    vi.spyOn(sessionRunner, 'hasPendingPermission').mockImplementation((sid: string) => sid === 's3b');
    const row = await hold('s3b', 'no, do this instead');
    expect(row.status).toBe('pending');
    expect(sends.map((s) => s.sessionId)).toEqual(['s3b']);
  });

  it('an interrupting send is never held, whatever else it asks', async () => {
    running.add('s3');
    const row = await hold('s3', 'steer', { interrupt: true });
    expect(row.status).toBe('pending');
    expect(sends).toEqual([{ sessionId: 's3', interrupt: true, source: 'mobile' }]);
  });

  it('without the flag a mid-turn send is untouched (it joins the live turn as before)', async () => {
    running.add('s4');
    const row = await sendMessageToSession('s4', 'plain', { source: 'mobile' });
    expect(row.status).toBe('pending');
    expect(sends.length).toBe(1);
  });

  it('the queue a person reads shows it as a pending row, flagged', async () => {
    await createSessionRecord('s5', 'task-5', 'proj', '/tmp', { initialProcessStatus: 'running' });
    running.add('s5');
    const row = await hold('s5', 'for later');
    const { messages } = await getSessionQueuePayload('s5');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: row.id, status: 'pending', afterTurn: true });
    expect(messages[0]).not.toHaveProperty('parkedReason');
    // The stored row is untouched: only the reading is presented.
    expect((await getQueue('s5'))[0].status).toBe('parked');
  });

  it('presents every other row as it is', () => {
    const plain = { id: 'a', status: 'pending' as const, message: 'x' };
    expect(presentAfterTurn(plain)).toBe(plain);
    const stopped = { id: 'b', status: 'parked' as const, parkedReason: STOP_PARKED_REASON, message: 'x' };
    expect(presentAfterTurn(stopped)).toBe(stopped);
  });

  it('can be edited and withdrawn while it waits', async () => {
    running.add('s6');
    const row = await hold('s6', 'old words');
    expect(await editMessage('s6', row.id, 'new words')).toBe(true);
    expect((await getQueue('s6'))[0].message).toContain('new words');
    expect(await deleteMessage('s6', row.id)).toBe(true);
    expect(await getQueue('s6')).toEqual([]);
  });

  it('a retry of the same id after it went out does not hold it again', async () => {
    running.add('s7');
    const first = await hold('s7', 'again', { messageId: 'qm-mobile-same00001' });
    running.delete('s7');
    expect(await releaseAfterTurn('s7', { viaEvent: true })).toBe('released');
    sends = [];
    running.add('s7');
    const repeat = await hold('s7', 'again', { messageId: 'qm-mobile-same00001' });
    expect(repeat.id).toBe(first.id);
    expect(repeat.status).toBe('pending');
    expect(sends.length).toBe(1);
  });
});

describe('release when the turn ends', () => {
  it('does nothing while the turn still runs', async () => {
    running.add('r1');
    await hold('r1', 'wait');
    expect(await releaseAfterTurn('r1', { viaEvent: true })).toBe('running');
    expect((await getQueue('r1'))[0].status).toBe('parked');
  });

  it('sends the oldest held row only: the next one waits for the next turn end', async () => {
    running.add('r2');
    const a = await hold('r2', 'first');
    const b = await hold('r2', 'second');
    running.delete('r2');
    expect(await releaseAfterTurn('r2', { viaEvent: true })).toBe('released');
    const rows = await getQueue('r2');
    expect(rows.find((r) => r.id === a.id)?.status).toBe('pending');
    expect(rows.find((r) => r.id === b.id)?.status).toBe('parked');
    expect(sends.map((s) => s.sessionId)).toEqual(['r2']);
    expect(sends[0].source).toBe('mobile');
    // The first row is on its way: the second does not follow it into the same turn.
    expect(await releaseAfterTurn('r2', { viaEvent: true })).toBe('busy');
    // It was delivered and its turn ended: now the second goes.
    await deleteMessage('r2', a.id);
    expect(await releaseAfterTurn('r2', { viaEvent: true })).toBe('released');
    expect((await getQueue('r2'))[0].status).toBe('pending');
  });

  it('keeps waiting behind an Interrupt & send that is already on its way in', async () => {
    running.add('r3');
    await hold('r3', 'for later');
    await enqueueMessage('r3', 'steer now');
    running.delete('r3');
    expect(await releaseAfterTurn('r3', { viaEvent: true })).toBe('busy');
  });

  it('a sweep never sends a second row right after the first', async () => {
    running.add('r4');
    const a = await hold('r4', 'one');
    await hold('r4', 'two');
    running.delete('r4');
    expect(await releaseAfterTurn('r4', { viaEvent: false })).toBe('released');
    await deleteMessage('r4', a.id);
    expect(await releaseAfterTurn('r4', { viaEvent: false })).toBe('busy');
    expect(await releaseAfterTurn('r4', { viaEvent: true })).toBe('released');
  });

  it('a Stop set the row aside: it stays unsent, shown as set aside', async () => {
    await createSessionRecord('r5', 'task-r5', 'proj', '/tmp', { initialProcessStatus: 'running' });
    running.add('r5');
    await hold('r5', 'after the job');
    expect(await setAsideAfterTurnHolds('r5')).toBe(1);
    const [row] = await getQueue('r5');
    expect(row.status).toBe('parked');
    expect(row.parkedReason).toBe(STOP_PARKED_REASON);
    running.delete('r5');
    expect(await releaseAfterTurn('r5', { viaEvent: true })).toBe('none');
    expect(sends).toEqual([]);
  });

  it('a stop that came after the hold wins even if nobody set the row aside', async () => {
    await createSessionRecord('r6', 'task-r6', 'proj', '/tmp', { initialProcessStatus: 'running' });
    running.add('r6');
    await hold('r6', 'before the stop');
    await updateSessionRecord('r6', { stopRequest: { id: 'stop-1', requestedAt: new Date().toISOString(), state: 'confirmed' } });
    running.delete('r6');
    expect(await releaseAfterTurn('r6', { viaEvent: true })).toBe('stopped');
    const [row] = await getQueue('r6');
    expect(row.parkedReason).toBe(STOP_PARKED_REASON);
    expect(sends).toEqual([]);
  });

  it('waits while a stop is still awaiting the host', async () => {
    await createSessionRecord('r7', 'task-r7', 'proj', '/tmp', { initialProcessStatus: 'running' });
    running.add('r7');
    await hold('r7', 'during a stop');
    await updateSessionRecord('r7', { stopRequest: { id: 'stop-2', requestedAt: new Date().toISOString(), state: 'pending' } });
    running.delete('r7');
    expect(await releaseAfterTurn('r7', { viaEvent: true })).toBe('stopping');
    expect(sends).toEqual([]);
  });

  it('a session with no holds answers none', async () => {
    expect(await releaseAfterTurn('nobody', { viaEvent: true })).toBe('none');
  });
});

describe('the turn-end events and the boot sweep', () => {
  it('a session:result releases the row once the runner lets go of the turn', async () => {
    await startQueueAfterTurn();
    running.add('e1');
    const row = await hold('e1', 'after the result');
    running.delete('e1');
    bus.emit(EventNames.SESSION_RESULT, { sessionId: 'e1', result: 'done' }, ['*'], { source: 'test' });
    await waitFor('the row to be released', async () => (await getQueue('e1'))[0]?.status === 'pending');
    expect((await getQueue('e1'))[0].id).toBe(row.id);
  });

  it('an event that comes a tick before the runner lets go is retried', async () => {
    await startQueueAfterTurn();
    running.add('e2');
    await hold('e2', 'late runner');
    bus.emit(EventNames.SESSION_RESULT, { sessionId: 'e2', result: 'done' }, ['*'], { source: 'test' });
    setTimeout(() => running.delete('e2'), 700);
    await waitFor('the row to be released', async () => (await getQueue('e2'))[0]?.status === 'pending', 8000);
  });

  it('a hold a restart left behind goes out at boot (its turn is gone)', async () => {
    running.add('b1');
    const row = await hold('b1', 'left behind');
    running.clear();
    resetCache();
    await startQueueAfterTurn();
    await waitFor('the leftover to be released', async () => (await getQueue('b1')).find((r) => r.id === row.id)?.status === 'pending', 8000);
  });
});
