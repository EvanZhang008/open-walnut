/**
 * Rows on their way between queues are never only in memory (src/core/session-queue-transit.ts;
 * 2026-11-23, the user: a message is never lost, a restart or crash included, and an error keeps
 * being retried). An engine switch or a move took the old session's rows in one write and put them
 * on the new session in another, minutes later; a host hand took a session's lines until the host
 * answered. A crash, or a failed write, between the two left a row in no queue.
 *
 * A "restart" here is what a new server has: the file on disk, an empty cache, no transit held.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

const writes = { fail: 0, failAfter: 0 };
vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/utils/fs.js')>();
  return {
    ...orig,
    writeJsonFile: async (...args: Parameters<typeof orig.writeJsonFile>) => {
      if (String(args[0]).endsWith('session-message-queue.json') && writes.fail > 0) {
        writes.fail--;
        throw new Error('EIO: simulated disk failure');
      }
      await orig.writeJsonFile(...args);
      if (String(args[0]).endsWith('session-message-queue.json') && writes.failAfter > 0) {
        writes.failAfter--;
        throw new Error('EIO: simulated failure after the rename');
      }
    },
  };
});

import { WALNUT_HOME, SESSION_QUEUE_FILE } from '../../src/constants.js';
import { enqueueMessage, findQueuedMessage, getQueue, loadQueue, QueueNotStoredError, resetCache, takeLinesForHost } from '../../src/core/session-message-queue.js';
import type { QueueStore } from '../../src/core/session-queue-store.js';
import { putQueuedRows, takeQueuedRows, landHeldRows } from '../../src/core/sessions/engine-switch-io.js';
import { noteTransitTarget, resetTransitState, rowsOnTheWay, settleStrandedTransits } from '../../src/core/session-queue-transit.js';
import { drainQueueSpool, resetSpoolState, spoolRow } from '../../src/core/session-queue-spool.js';

const disk = (): QueueStore => JSON.parse(fs.readFileSync(SESSION_QUEUE_FILE, 'utf-8')) as QueueStore;
const ids = (sid: string) => (disk().queues[sid] ?? []).map((m) => m.message);
const inTransit = () => Object.values(disk().transit ?? {}).flatMap((t) => t.rows.map((r) => r.message));
/** What a new server has after a crash: the file, nothing in memory. */
const restart = () => { resetCache(); resetTransitState(); resetSpoolState(); };

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  restart();
  writes.fail = 0;
  writes.failAfter = 0;
});

afterEach(async () => {
  restart();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('an enqueue reaches the disk before its sender hears "queued"', () => {
  it('a write that keeps failing puts the row in the spool, and the next start queues it once', async () => {
    writes.fail = 10;
    const row = await enqueueMessage('s1', 'the user\'s words', { id: 'qm-spooled' });
    expect(await getQueue('s1')).toEqual([]);
    expect(fs.existsSync(`${SESSION_QUEUE_FILE}.spool`)).toBe(true);
    // A resend of the same id while it waits there is that row, not a second one.
    expect((await enqueueMessage('s1', 'the user\'s words', { id: 'qm-spooled' })).id).toBe(row.id);
    writes.fail = 0;
    restart();
    await loadQueue();
    expect(ids('s1')).toEqual(['the user\'s words']);
    expect(fs.readdirSync(`${SESSION_QUEUE_FILE}.spool`)).toEqual([]);
  });

  it('a row whose fate goes with it is never spooled: its sender is told', async () => {
    writes.fail = 10;
    await expect(enqueueMessage('s1', 'from the phone', { id: 'qm-mobile-x', relayTaken: true })).rejects.toBeInstanceOf(QueueNotStoredError);
    writes.fail = 0;
    expect(fs.existsSync(`${SESSION_QUEUE_FILE}.spool`)).toBe(false);
  });
});

describe('who may place a transit', () => {
  const plant = (boot: string, pid: number, at: number) => fs.writeFileSync(SESSION_QUEUE_FILE, JSON.stringify({
    version: 1, queues: {},
    transit: { 'host-x': { from: 'hs', kind: 'host', pid, boot, at, rows: [{ id: 'qm-x', sessionId: 'hs', message: 'waiting', status: 'pending', enqueuedAt: new Date().toISOString() }] } },
  }));

  it('another boot whose owner is alive keeps it a while; after that, or with its owner gone, it is placed', async () => {
    // A live pid (this one) under another boot: its owner may still place it.
    plant('another-boot', process.pid, Date.now());
    expect(await settleStrandedTransits()).toBe(0);
    // The same, older than the owner's allowance (a reused pid): placed.
    plant('another-boot', process.pid, Date.now() - 11 * 60_000);
    resetCache();
    expect(await settleStrandedTransits()).toBe(1);
    expect(ids('hs')).toEqual(['waiting']);
  });

  it('a placed transit is not put again by its late owner', async () => {
    await enqueueMessage('old', 'once');
    const held = await takeQueuedRows('old', 'es-late');
    restart();
    await settleStrandedTransits({ switches: true });
    // The owner comes back to it (its put retried): the transit is gone, so nothing goes twice.
    await putQueuedRows('new', held, 'es-late');
    expect(ids('old')).toEqual(['once']);
    expect(ids('new')).toEqual([]);
  });
});

describe('an engine switch moves its held rows through the queue file', () => {
  it('a crash between the take and the put leaves the rows in the transit, and the restart places them', async () => {
    await enqueueMessage('old', 'first');
    await enqueueMessage('old', 'second');
    const taken = await takeQueuedRows('old', 'es-1');
    expect(taken.map((r) => r.message)).toEqual(['first', 'second']);
    // Out of the old queue, and on disk all the same.
    expect(ids('old')).toEqual([]);
    expect(inTransit()).toEqual(['first', 'second']);
    restart();
    // The switch resume has run (no switch left to settle): the sweep puts them where they belong.
    expect(await settleStrandedTransits({ switches: true })).toBe(2);
    expect(ids('old')).toEqual(['first', 'second']);
    expect(disk().transit).toBeUndefined();
  });

  it('a put whose write fails throws and keeps the rows in the transit; the next put lands them once', async () => {
    await enqueueMessage('old', 'only message');
    const held = await takeQueuedRows('old', 'es-2');
    writes.fail = 1;
    await expect(putQueuedRows('new', held, 'es-2')).rejects.toThrow(/EIO/);
    expect(ids('new')).toEqual([]);
    expect(inTransit()).toEqual(['only message']);
    await putQueuedRows('new', held, 'es-2');
    await putQueuedRows('new', held, 'es-2');
    expect(ids('new')).toEqual(['only message']);
    expect(ids('old')).toEqual([]);
    expect(disk().transit).toBeUndefined();
  });

  it('a put that fails after the take is placed by the sweep, never dropped', async () => {
    await enqueueMessage('old', 'carried');
    const held = await takeQueuedRows('old', 'es-3');
    writes.fail = 1;
    expect(await landHeldRows('new', held, 'es-3')).toBe(false);
    expect(inTransit()).toEqual(['carried']);
    // The sweep tries again (this process's own transit, abandoned by its put).
    await settleStrandedTransits();
    expect(ids('old')).toEqual(['carried']);
    expect(disk().transit).toBeUndefined();
  });

  it('a take whose write fails throws and leaves the rows in the old queue', async () => {
    await enqueueMessage('old', 'stays');
    writes.fail = 1;
    await expect(takeQueuedRows('old', 'es-4')).rejects.toThrow(/EIO/);
    expect(ids('old')).toEqual(['stays']);
    expect(disk().transit).toBeUndefined();
  });

  it('a transit a live switch holds is left to it', async () => {
    await enqueueMessage('old', 'mine');
    await takeQueuedRows('old', 'es-5');
    expect(await settleStrandedTransits({ switches: true })).toBe(0);
    expect(inTransit()).toEqual(['mine']);
  });
});

describe('a host hand keeps its lines in the queue file until the host took them', () => {
  it('a crash before the host answered puts them back at the next start', async () => {
    await enqueueMessage('hs', 'to the host');
    const taken = await takeLinesForHost('hs');
    expect(taken.lines.map((m) => m.message)).toEqual(['to the host']);
    expect(ids('hs')).toEqual([]);
    expect(inTransit()).toEqual(['to the host']);
    restart();
    await loadQueue();
    expect(ids('hs')).toEqual(['to the host']);
    expect(disk().transit).toBeUndefined();
  });

  it('taken by the host: the transit ends and a restart puts nothing back', async () => {
    await enqueueMessage('hs', 'delivered');
    const taken = await takeLinesForHost('hs');
    await taken.done();
    expect(disk().transit).toBeUndefined();
    restart();
    await loadQueue();
    expect(ids('hs')).toEqual([]);
  });

  it('a put back whose write fails leaves them in the transit, and the sweep puts them back', async () => {
    await enqueueMessage('hs', 'refused');
    await enqueueMessage('hs', 'refused too');
    const taken = await takeLinesForHost('hs');
    writes.fail = 1;
    await taken.putBack();
    expect(inTransit()).toEqual(['refused', 'refused too']);
    await settleStrandedTransits();
    expect(ids('hs')).toEqual(['refused', 'refused too']);
  });
});

describe('review round 2: rows not in a queue yet are never lost, doubled or reported delivered', () => {
  const row = (id: string, sessionId: string, at: string) => ({ id, sessionId, message: id, status: 'pending' as const, enqueuedAt: at });

  it('a write that landed and then threw, read back through a failing read, is still one row', async () => {
    writes.failAfter = 1;
    const real = fsp.readFile.bind(fsp);
    let reads = 0;
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation(async (file, ...rest) => {
      // The read back after the failed write: EMFILE, which says nothing either way.
      if (String(file) === SESSION_QUEUE_FILE && writes.failAfter === 0 && reads++ === 0) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      return real(file as never, ...(rest as []));
    });
    await enqueueMessage('s1', 'once only');
    spy.mockRestore();
    expect(ids('s1')).toEqual(['once only']);
  });

  it('a row in a transit or in the spool is found as queued (never answered as delivered) and shown as waiting', async () => {
    await enqueueMessage('old', 'moving', { id: 'qm-moving' });
    await takeQueuedRows('old', 'es-view');
    await noteTransitTarget('es-view', 'new');
    await spoolRow(row('qm-spooled-view', 'old', new Date().toISOString()));
    resetCache();
    expect((await findQueuedMessage('qm-moving'))?.id).toBe('qm-moving');
    expect((await findQueuedMessage('qm-spooled-view'))?.id).toBe('qm-spooled-view');
    expect((await rowsOnTheWay('old')).map((r) => r.id).sort()).toEqual(['qm-moving', 'qm-spooled-view']);
    expect((await rowsOnTheWay('new')).map((r) => r.id)).toEqual(['qm-moving']);
  });

  it('the spool merge never doubles a row another queue or a transit holds, and keeps the line in time order', async () => {
    const t = (s: number) => new Date(Date.parse('2026-11-23T10:00:00Z') + s * 1000).toISOString();
    fs.writeFileSync(SESSION_QUEUE_FILE, JSON.stringify({ version: 1, queues: {
      s1: [row('qm-a', 's1', t(1)), row('qm-c', 's1', t(3))],
      other: [row('qm-elsewhere', 'other', t(0))],
    } }));
    resetCache();
    await spoolRow(row('qm-b', 's1', t(2)));
    await spoolRow(row('qm-elsewhere', 's1', t(0)));
    await drainQueueSpool();
    expect(ids('s1')).toEqual(['qm-a', 'qm-b', 'qm-c']);
    expect(ids('other')).toEqual(['qm-elsewhere']);
  });

  it('a second take into a transit its switch holds, failing, leaves the whole transit to the switch', async () => {
    await enqueueMessage('old', 'retired');
    await takeQueuedRows('old', 'es-two');
    await enqueueMessage('old', 'late');
    writes.fail = 1;
    await expect(takeQueuedRows('old', 'es-two')).rejects.toThrow(/EIO/);
    // Still the switch's: the sweep places nothing, and the switch's own put lands what it took.
    expect(await settleStrandedTransits({ switches: true })).toBe(0);
    await putQueuedRows('new', [], 'es-two');
    expect(ids('new')).toEqual(['retired']);
    expect(ids('old')).toEqual(['late']);
  });
});
