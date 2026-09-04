/**
 * One browser, one letter store.
 *
 * The rail's Inbox and a session panel's Inbox tab used to be two independent
 * client copies of the same letters, reconciled only by a debounced full re-GET
 * that some UNRELATED letter event happened to trigger. `pinned` has no WS echo at
 * all, so pinning in the rail left the session tab showing "Pin", no glyph, and
 * the old date order until a reload.
 *
 * What is pinned here is the shared store that replaced both copies:
 *   - one in-flight GET however many surfaces ask;
 *   - a patch reaches every reader immediately, on whichever shelf holds the row;
 *   - a failed write re-reads instead of leaving a lie on screen;
 *   - the archive shelf is a SEPARATE list, so archived rows never leak into a
 *     session tab's list.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LetterEnvelope } from '../../web/src/api/human-inbox';

const listLetters = vi.hoisted(() => vi.fn());
const setLetterPinned = vi.hoisted(() => vi.fn());

vi.mock('@/api/human-inbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web/src/api/human-inbox')>();
  return { ...actual, listLetters, setLetterPinned };
});

import {
  applyLetterChange, ensureLetters, getLetterSnapshot, loadArchivedLetters, loadLetters,
  patchLetter, resetLetterStore, subscribeLetters,
} from '../../web/src/components/inbox/letter-store';
import { lettersForSession } from '../../web/src/components/inbox/session-letters';

function letter(over: Partial<LetterEnvelope> & { id: string }): LetterEnvelope {
  return {
    subject: `Subject ${over.id}`,
    type: 'info',
    bodyFormat: 'markdown',
    textPreview: 'preview',
    sender: { sessionId: 'sess-a', host: 'local' },
    createdAt: 1_000,
    read: true,
    pinned: false,
    archived: false,
    ...over,
  };
}

const LIVE = [
  letter({ id: 'lt-1', createdAt: 3_000 }),
  letter({ id: 'lt-2', createdAt: 2_000 }),
];
const SHELF = [letter({ id: 'lt-old', archived: true, createdAt: 1_000 })];

/** Answer the live list and the archive list from the same mock. */
function serve(live = LIVE, shelf = SHELF): void {
  listLetters.mockImplementation(async (opts?: { archived?: boolean }) => (
    opts?.archived ? shelf : live
  ));
}

beforeEach(() => {
  resetLetterStore();
  listLetters.mockReset();
  setLetterPinned.mockReset();
  serve();
});

describe('one fetch, many surfaces', () => {
  it('shares a single in-flight GET', async () => {
    await Promise.all([loadLetters(), loadLetters(), loadLetters()]);
    expect(listLetters).toHaveBeenCalledTimes(1);
    expect(getLetterSnapshot().letters.map(l => l.id)).toEqual(['lt-1', 'lt-2']);
  });

  it('a second surface mounting reuses a fresh list instead of re-fetching', async () => {
    await loadLetters();
    ensureLetters();
    ensureLetters();
    expect(listLetters).toHaveBeenCalledTimes(1);
  });

  it('a load failure is reported without wiping what is on screen', async () => {
    await loadLetters();
    listLetters.mockRejectedValueOnce(new Error('offline'));
    await loadLetters();

    const snap = getLetterSnapshot();
    expect(snap.error).toBe('Could not load letters');
    expect(snap.letters.map(l => l.id)).toEqual(['lt-1', 'lt-2']);
  });
});

describe('the archive shelf is its own list', () => {
  it('never leaks archived rows into a session tab list', async () => {
    await loadLetters();
    await loadArchivedLetters();

    const snap = getLetterSnapshot();
    expect(snap.archived.map(l => l.id)).toEqual(['lt-old']);
    // The per-session lens reads the LIVE list, so the shelf cannot reach it.
    expect(lettersForSession(snap.letters, 'sess-a').map(l => l.id)).toEqual(['lt-1', 'lt-2']);
  });

  it('is not fetched until a surface asks for it', async () => {
    ensureLetters();
    await loadLetters();
    expect(listLetters).toHaveBeenCalledWith();
    expect(getLetterSnapshot().archivedLoaded).toBe(false);
  });
});

describe('a patch reaches every reader at once', () => {
  it('notifies subscribers and flips the field, on whichever shelf holds the row', async () => {
    await loadLetters();
    await loadArchivedLetters();
    let notified = 0;
    const off = subscribeLetters(() => { notified += 1; });

    patchLetter('lt-2', { pinned: true });
    patchLetter('lt-old', { pinned: true });

    expect(notified).toBe(2);
    const snap = getLetterSnapshot();
    expect(snap.letters.find(l => l.id === 'lt-2')?.pinned).toBe(true);
    expect(snap.archived.find(l => l.id === 'lt-old')?.pinned).toBe(true);
    // Pinned sorts first — the order the other surface must adopt immediately.
    expect(lettersForSession(snap.letters, 'sess-a').map(l => l.id)).toEqual(['lt-2', 'lt-1']);
    off();
  });

  it('an unknown id changes nothing and wakes nobody', async () => {
    await loadLetters();
    let notified = 0;
    const off = subscribeLetters(() => { notified += 1; });
    const before = getLetterSnapshot();

    patchLetter('lt-nope', { pinned: true });

    expect(notified).toBe(0);
    expect(getLetterSnapshot()).toBe(before);
    off();
  });

  it('the optimistic patch lands BEFORE the route answers', async () => {
    await loadLetters();
    let release = (): void => {};
    const call = vi.fn(() => new Promise<void>((r) => { release = () => r(); }));

    const done = applyLetterChange('lt-1', { pinned: true }, call, 'pin');
    // This is the whole point: the other surface already reads `pinned`.
    expect(getLetterSnapshot().letters.find(l => l.id === 'lt-1')?.pinned).toBe(true);
    expect(listLetters).toHaveBeenCalledTimes(1);

    release();
    await done;
    // A successful write does NOT trigger a re-read: the echo confirms, nothing more.
    expect(listLetters).toHaveBeenCalledTimes(1);
  });

  it('a failed write re-reads instead of leaving a lie on screen', async () => {
    await loadLetters();
    await applyLetterChange('lt-1', { pinned: true }, async () => { throw new Error('nope'); }, 'pin');

    expect(listLetters).toHaveBeenCalledTimes(2);
    // The re-read is the server's answer, so the optimistic pin is gone.
    expect(getLetterSnapshot().letters.find(l => l.id === 'lt-1')?.pinned).toBe(false);
  });
});
