/**
 * The sidebar's remembered shape: one `localStorage` key holding the expanded groups, the recently
 * opened labels and the selected row.
 *
 * What each case defends:
 *
 * - PRUNING (C66). Three of the four fields are keyed by account id, so deleting an account otherwise
 *   leaves its expanded state and a list of its folder ids behind for the life of the origin. The
 *   pruning happens on READ so the next write persists the pruned shape, and the neighbouring
 *   preference file states the same value in its own comment ("no key is ever left behind").
 * - An EMPTY account list prunes nothing. It means the accounts request has not landed yet, and reading
 *   it as "there are no accounts" erases a real preference on the next write.
 * - A THROWING store is not an error. `localStorage` throws outright in some private windows and when
 *   the quota is full, and a reading preference is never worth taking the console down for: everything
 *   reads as collapsed with no recent folders, which is exactly the default view.
 * - Recent labels: newest first, deduped, capped at three (C16).
 * - The reserved SMART selection survives pruning: its account id belongs to no provider, and whether
 *   the row is visible is a question about mailbox rows this file has never seen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  noteRecentFolder,
  readRecentFolders,
  readSelectedPref,
  readSidebarPrefs,
  readSmartExpanded,
  readTailExpanded,
  writeSelectedPref,
  writeSmartExpanded,
  writeTailExpanded,
} from '../../web/src/apps/mail/mail-sidebar-prefs';
import { SMART_ACCOUNT, SMART_INBOX } from '../../web/src/apps/mail/mail-store';

const KEY = 'walnut.mail.sidebar.v1';
const A = 'dense:harbour';
const B = 'dense:marina';

let kept: Map<string, string>;

/** A store that behaves, unless a test makes one of its methods throw. */
function install(opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}): void {
  kept = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => {
        if (opts.throwOnGet) throw new Error('this window refuses storage');
        return kept.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (opts.throwOnSet) throw new Error('the quota is full');
        kept.set(key, value);
      },
      removeItem: (key: string) => { kept.delete(key); },
    },
  });
}

function stored(): Record<string, unknown> {
  return JSON.parse(kept.get(KEY) ?? '{}') as Record<string, unknown>;
}

beforeEach(() => { install(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('one key holds the whole arrangement', () => {
  it('keeps the expanded groups, the tail and the selection in a single blob', () => {
    writeSmartExpanded([A, B], 'inbox', true);
    writeTailExpanded([A, B], A, true);
    writeSelectedPref([A, B], { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX });
    expect([...kept.keys()]).toEqual([KEY]);
    expect(stored()).toEqual({
      smart: { inbox: 1 },
      tail: { [A]: 1 },
      recent: {},
      selected: { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX },
    });
    expect(readSmartExpanded([A, B])).toEqual({ inbox: 1 });
    expect(readTailExpanded([A, B], A)).toBe(true);
    expect(readTailExpanded([A, B], B)).toBe(false);
    expect(readSelectedPref([A, B])).toEqual({ accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX });
  });

  it('collapses again and drops the selection rather than storing a false value', () => {
    writeSmartExpanded([A], 'sent', true);
    writeSmartExpanded([A], 'sent', false);
    writeSelectedPref([A], { accountId: A, mailboxId: 'INBOX' });
    writeSelectedPref([A], null);
    expect(stored()).toEqual({ smart: {}, tail: {}, recent: {} });
    expect(readSelectedPref([A])).toBeNull();
  });

  it('reads anything unparseable as collapsed with nothing remembered', () => {
    for (const raw of ['', 'not json', '[]', 'null', '{"smart":"yes","tail":3,"recent":[1,2]}']) {
      kept.set(KEY, raw);
      expect(readSidebarPrefs([A, B]), raw).toEqual({ smart: {}, tail: {}, recent: {} });
    }
    // A blob whose fields are the right shape but hold junk keeps only what it can read.
    kept.set(KEY, JSON.stringify({ smart: { inbox: 1, nope: 1 }, recent: { [A]: ['x', 7, null] } }));
    expect(readSidebarPrefs([A])).toEqual({ smart: { inbox: 1 }, tail: {}, recent: { [A]: ['x'] } });
  });
});

describe('recent labels: newest first, deduped, three at most (C16)', () => {
  it('moves a folder back to the front and drops the oldest when a fourth arrives', () => {
    noteRecentFolder([A], A, 'label/one');
    noteRecentFolder([A], A, 'label/two');
    noteRecentFolder([A], A, 'label/three');
    expect(readRecentFolders([A], A)).toEqual(['label/three', 'label/two', 'label/one']);
    // Opening one again moves it to the front and does not add a second entry.
    noteRecentFolder([A], A, 'label/one');
    expect(readRecentFolders([A], A)).toEqual(['label/one', 'label/three', 'label/two']);
    // The fourth pushes the oldest out, so the promotion block can never grow past three.
    noteRecentFolder([A], A, 'label/four');
    expect(readRecentFolders([A], A)).toEqual(['label/four', 'label/one', 'label/three']);
    expect(readRecentFolders([A], A)).toHaveLength(3);
    // Per ACCOUNT: B's list is its own.
    noteRecentFolder([A, B], B, 'marina/label/berths');
    expect(readRecentFolders([A, B], B)).toEqual(['marina/label/berths']);
    expect(readRecentFolders([A, B], A)).toEqual(['label/four', 'label/one', 'label/three']);
  });
});

describe('an account that is gone leaves nothing behind (C66)', () => {
  it('drops its tail and recent keys on the next write, and discards a selection pointing at it', () => {
    writeTailExpanded([A, B], A, true);
    writeTailExpanded([A, B], B, true);
    noteRecentFolder([A, B], A, 'harbour/label/receipts');
    noteRecentFolder([A, B], B, 'marina/label/berths');
    writeSelectedPref([A, B], { accountId: B, mailboxId: 'inbox' });
    expect(Object.keys(stored().tail as object)).toEqual([A, B]);

    // B is deleted. The very next read already answers with the pruned shape.
    const pruned = readSidebarPrefs([A]);
    expect(pruned.tail).toEqual({ [A]: 1 });
    expect(pruned.recent).toEqual({ [A]: ['harbour/label/receipts'] });
    expect(pruned.selected).toBeUndefined();
    expect(readSelectedPref([A])).toBeNull();

    // And the next write persists it, so nothing is left on disk either.
    writeSmartExpanded([A], 'inbox', true);
    expect(stored()).toEqual({ smart: { inbox: 1 }, tail: { [A]: 1 }, recent: { [A]: ['harbour/label/receipts'] } });
  });

  it('keeps a reserved smart selection, which belongs to no account', () => {
    writeSelectedPref([A, B], { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX });
    // Down to one account: the row may well be invisible now, but that verdict is the caller's, made
    // against the mailbox rows. Pruning it here would throw the answer away before anybody asked.
    expect(readSelectedPref([A])).toEqual({ accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX });
  });

  it('prunes nothing while the account list is still empty', () => {
    writeTailExpanded([A], A, true);
    noteRecentFolder([A], A, 'harbour/label/receipts');
    // The first frame of the pane, before /accounts has answered. An empty list is not an answer.
    const early = readSidebarPrefs([]);
    expect(early.tail).toEqual({ [A]: 1 });
    expect(early.recent).toEqual({ [A]: ['harbour/label/receipts'] });
  });
});

describe('a storage the browser refuses', () => {
  it('reads as collapsed and still lets every write be attempted without throwing', () => {
    install({ throwOnGet: true });
    expect(readSidebarPrefs([A, B])).toEqual({ smart: {}, tail: {}, recent: {} });
    expect(readSelectedPref([A])).toBeNull();
    expect(readTailExpanded([A], A)).toBe(false);
    expect(readRecentFolders([A], A)).toEqual([]);
    expect(() => writeSmartExpanded([A], 'inbox', true)).not.toThrow();

    // A quota that refuses the write: the pane still expands, it just will not be remembered.
    install({ throwOnSet: true });
    expect(() => writeTailExpanded([A], A, true)).not.toThrow();
    expect(() => noteRecentFolder([A], A, 'harbour/label/receipts')).not.toThrow();
    expect(readTailExpanded([A], A)).toBe(false);
  });

  it('does not throw when there is no window at all, which is the server-rendered case', () => {
    vi.stubGlobal('window', undefined);
    expect(readSidebarPrefs([A])).toEqual({ smart: {}, tail: {}, recent: {} });
    expect(() => writeSmartExpanded([A], 'drafts', true)).not.toThrow();
  });
});
