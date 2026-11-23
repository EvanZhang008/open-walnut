/**
 * The tell that a held note was dropped is never lost either (2026-11-23, the user: no message is
 * ever lost, and an error keeps retrying). src/core/sessions/held-notices-sweep.ts flushDropTells:
 *  - the tell is held for the sender's next message as a `whole` part under DROP_TELL_KEY, so no
 *    age limit or fold cap drops it once it is counted told;
 *  - a tell whose sender cannot be looked up (an error) waits and is tried again, kept in the
 *    held-notices file across a restart, for TELL_KEEP_MS; then its note's fate says it was not told;
 *  - a tell no live session can take is never handed to a dead one: the note's fate says so.
 * The session store is stubbed so a lookup can fail, find a live sender, or find none.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>();
  return { ...actual, ...createMockConstants('walnut-held-tells') };
});

/** Live sender sessions; a lookup throws while `failLookups` > 0. */
const live = new Set<string>();
let failLookups = 0;
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (sid: string) => {
    if (failLookups > 0) { failLookups--; throw new Error('session store busy'); }
    return live.has(sid) ? { claudeSessionId: sid, archived: false } : null;
  },
  getAcpIdentityReplacementTarget: () => null,
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  DROP_WHY, FOLD_PARTS_MAX, HOLD_MAX_MS, _clearHeldNotices, dropParts, heldNoteState, heldNoticeKeys, pendingHeldNotices,
} from '../../../src/core/sessions/held-notices.js';
import { TELL_KEEP_MS, _resetHeldStoreForTesting, persist, recordFate } from '../../../src/core/sessions/held-notices-store.js';
import { DROP_TELL_KEY, flushDropTells, startHeldNotices, stopHeldNotices, sweepHeldNotices } from '../../../src/core/sessions/held-notices-sweep.js';

const FILE = () => path.join(WALNUT_HOME, 'cache', 'held-notices.json');
const fileTells = async () => (JSON.parse(await fsp.readFile(FILE(), 'utf8')).tells ?? []) as Array<{ callerSid: string; tries: number }>;

/** Drop one note of `sender`'s (as the sweep does), its own flush a second later kept off the clock. */
function drop(mid: string, sender: string, title: string, at = Date.now()): void {
  recordFate(mid, { state: 'dropped', at, sid: 'sid-target', why: DROP_WHY.gone });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  dropParts('sid-target', [{ at, mid, from: sender, task: 't-1', title, whole: true }], DROP_WHY.gone, at);
  vi.useRealTimers();
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  _clearHeldNotices();
  live.clear();
  failLookups = 0;
  await startHeldNotices();
});

afterEach(async () => {
  await stopHeldNotices();
  await _resetHeldStoreForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('the sender of a dropped note is told, whatever fails on the way', () => {
  it('a tell that failed is tried again, and waits in the file across a restart until it is held for the sender', async () => {
    live.add('sid-sender');
    drop('qm-t-1', 'sid-sender', 'Shard red');
    await persist();
    expect((await fileTells()).map((t) => t.callerSid)).toEqual(['sid-sender']);

    failLookups = 1;
    expect(await flushDropTells()).toBe(0);
    expect(await fileTells()).toMatchObject([{ callerSid: 'sid-sender', tries: 1 }]);
    expect(heldNoticeKeys('sid-sender')).toEqual([]);

    // A restart: memory gone, the file read again; the tell is still there to give.
    await stopHeldNotices();
    await _resetHeldStoreForTesting({ keepFile: true });
    await startHeldNotices();
    expect(await flushDropTells()).toBe(1);
    expect(await fileTells()).toEqual([]);
    expect(heldNoticeKeys('sid-sender')).toEqual([DROP_TELL_KEY]);
    const held = (await pendingHeldNotices('sid-sender'))!;
    expect(held.text).toContain('outcome="note-dropped"');
    expect(held.text).toContain('"Shard red"');
    held.markTold();
    // Told once: nothing more to tell.
    expect(await flushDropTells()).toBe(0);
  });

  it('a tell, once held, is never aged out or pushed out by more tells', async () => {
    live.add('sid-sender');
    const n = FOLD_PARTS_MAX + 3;
    for (let i = 0; i < n; i++) {
      drop(`qm-cap-${i}`, 'sid-sender', `note ${i}`);
      await flushDropTells();
    }
    // Swept well past the age limit (the sender's session is there, so it stays).
    await sweepHeldNotices(Date.now() + 2 * HOLD_MAX_MS);
    const text = (await pendingHeldNotices('sid-sender', Date.now() + 2 * HOLD_MAX_MS))!.text;
    for (let i = 0; i < n; i++) expect(text).toContain(`"note ${i}"`);
  });

  it('no live session of the sender or its task: never handed to a dead one, the note\'s fate says it was not told', async () => {
    drop('qm-t-2', 'sid-gone', 'Lost sender');
    expect(await flushDropTells()).toBe(0);
    expect(heldNoticeKeys('sid-gone')).toEqual([]);
    expect(await fileTells()).toEqual([]);
    const state = await heldNoteState('qm-t-2');
    expect(state).toMatchObject({ state: 'dropped' });
    expect(state.why).toContain(DROP_WHY.gone);
    expect(state.why).toContain('its sender was not told either: no live session of it or of its task can take the notice');
  });

  it('a tell that keeps failing for TELL_KEEP_MS is written on the note\'s fate and leaves the queue', async () => {
    live.add('sid-sender');
    drop('qm-t-3', 'sid-sender', 'Old tell', Date.now() - TELL_KEEP_MS - 60_000);
    failLookups = 1;
    expect(await flushDropTells()).toBe(0);
    expect(await fileTells()).toEqual([]);
    expect((await heldNoteState('qm-t-3')).why).toContain('its sender was not told either: telling it failed for 7 days');
  });
});
