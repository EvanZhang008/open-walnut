/**
 * Unsaved-editor drafts: the policy layer, against an in-memory adapter.
 *
 * The bug this pins: the Files-panel editor kept its dirty buffer only in React
 * state, so leaving the panel threw typed text away. The store below is the
 * temporary copy — so what matters is that a write survives, that the paths a
 * host has drafts for are listable, that abandoned records expire, and above all
 * that a broken storage layer degrades to "no draft" instead of rejecting into a
 * render.
 *
 * There is no fake-indexeddb in devDependencies (and adding a dependency for one
 * test is the wrong trade), which is exactly why file-drafts.ts takes its store
 * through an injectable adapter.
 *
 * Three more losses are pinned below, all of them "a path changed and the draft
 * didn't follow":
 *   - a RENAME must carry the record (descendants included, segment-wise) and
 *     redirect the outgoing editor's late unmount flush, or the typed text is
 *     orphaned at a path that no longer exists;
 *   - a DELETE must drop the records and REFUSE that late flush, or recreating the
 *     filename offers to restore the deleted file's body;
 *   - restoring a draft written against OLDER bytes must keep the optimistic lock
 *     at the draft's own baseHash, so the next Save 409s instead of silently
 *     replacing the newer file on disk.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveFileDraft, loadFileDraft, deleteFileDraft, listFileDraftPaths,
  subscribeFileDrafts, setFileDraftAdapter, fileDraftKey,
  moveFileDraftsUnder, deleteFileDraftsUnder, planDraftReplay, planStaleDraftRestore,
  type FileDraft, type FileDraftAdapter,
} from '../../web/src/utils/file-drafts';

const DAY = 24 * 60 * 60 * 1000;

/** The whole store as a Map — same contract, no IndexedDB. */
class MemoryAdapter implements FileDraftAdapter {
  rows = new Map<string, FileDraft>();

  async get(key: string) { return this.rows.get(key) ?? null; }
  async put(key: string, record: FileDraft) { this.rows.set(key, record); }
  async delete(key: string) { this.rows.delete(key); }
  async keysWithPrefix(prefix: string) {
    return [...this.rows.keys()].filter((k) => k.startsWith(prefix));
  }
  async agesOldestFirst() {
    return [...this.rows.entries()]
      .map(([key, rec]) => ({ key, updatedAt: rec.updatedAt }))
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }
}

/** Every method rejects — private browsing, quota, a corrupt DB. */
class ThrowingAdapter implements FileDraftAdapter {
  async get(): Promise<FileDraft | null> { throw new Error('idb is gone'); }
  async put(): Promise<void> { throw new Error('idb is gone'); }
  async delete(): Promise<void> { throw new Error('idb is gone'); }
  async keysWithPrefix(): Promise<string[]> { throw new Error('idb is gone'); }
  async agesOldestFirst(): Promise<Array<{ key: string; updatedAt: number }>> { throw new Error('idb is gone'); }
}

let store: MemoryAdapter;

beforeEach(() => {
  store = new MemoryAdapter();
  setFileDraftAdapter(store);
});

describe('file drafts: roundtrip', () => {
  it('saves and loads the text plus the hash it was typed against', async () => {
    await saveFileDraft(null, '/repo/src/a.ts', { text: 'half a thought', baseHash: 'h1' });
    const draft = await loadFileDraft(null, '/repo/src/a.ts');
    expect(draft?.text).toBe('half a thought');
    expect(draft?.baseHash).toBe('h1');
    expect(draft?.host).toBeNull();
    expect(draft?.path).toBe('/repo/src/a.ts');
    expect(draft?.updatedAt).toBeGreaterThan(0);
  });

  it('an undefined host is the same record as a null host (the local machine)', async () => {
    await saveFileDraft(undefined, '/repo/a.ts', { text: 'x', baseHash: 'h1' });
    expect((await loadFileDraft(null, '/repo/a.ts'))?.text).toBe('x');
    expect(fileDraftKey(undefined, '/repo/a.ts')).toBe(fileDraftKey(null, '/repo/a.ts'));
  });

  it('the same path on two hosts is two drafts', async () => {
    await saveFileDraft(null, '/repo/a.ts', { text: 'mine', baseHash: 'h1' });
    await saveFileDraft('devbox', '/repo/a.ts', { text: 'theirs', baseHash: 'h2' });
    expect((await loadFileDraft(null, '/repo/a.ts'))?.text).toBe('mine');
    expect((await loadFileDraft('devbox', '/repo/a.ts'))?.text).toBe('theirs');
  });

  it('a missing draft is null, not a throw', async () => {
    expect(await loadFileDraft(null, '/nothing/here.ts')).toBeNull();
  });

  it('delete removes it', async () => {
    await saveFileDraft(null, '/repo/a.ts', { text: 'x', baseHash: 'h1' });
    await deleteFileDraft(null, '/repo/a.ts');
    expect(await loadFileDraft(null, '/repo/a.ts')).toBeNull();
  });
});

describe('file drafts: listing per host', () => {
  it('returns only the requested host, as bare paths', async () => {
    await saveFileDraft(null, '/repo/a.ts', { text: 'a', baseHash: 'h' });
    await saveFileDraft(null, '/repo/b.ts', { text: 'b', baseHash: 'h' });
    await saveFileDraft('devbox', '/srv/c.ts', { text: 'c', baseHash: 'h' });

    expect(await listFileDraftPaths(null)).toEqual(new Set(['/repo/a.ts', '/repo/b.ts']));
    expect(await listFileDraftPaths('devbox')).toEqual(new Set(['/srv/c.ts']));
    expect(await listFileDraftPaths('other')).toEqual(new Set());
  });
});

describe('file drafts: housekeeping', () => {
  it('drops drafts nobody came back for in 30 days, keeps the rest', async () => {
    const now = Date.now();
    store.rows.set(fileDraftKey(null, '/old.ts'), {
      host: null, path: '/old.ts', text: 'stale', baseHash: 'h', updatedAt: now - 31 * DAY,
    });
    store.rows.set(fileDraftKey(null, '/fresh.ts'), {
      host: null, path: '/fresh.ts', text: 'live', baseHash: 'h', updatedAt: now - 2 * DAY,
    });
    // Housekeeping runs once, on the first access after the adapter is installed.
    setFileDraftAdapter(store);

    expect(await loadFileDraft(null, '/old.ts')).toBeNull();
    expect((await loadFileDraft(null, '/fresh.ts'))?.text).toBe('live');
  });

  it('caps the store at 300 records, evicting the oldest first', async () => {
    const now = Date.now();
    for (let i = 0; i < 305; i++) {
      store.rows.set(fileDraftKey(null, `/f${i}.ts`), {
        host: null, path: `/f${i}.ts`, text: `t${i}`, baseHash: 'h', updatedAt: now - (305 - i) * 1000,
      });
    }
    setFileDraftAdapter(store);

    const paths = await listFileDraftPaths(null);
    expect(paths.size).toBe(300);
    // f0..f4 are the five oldest by updatedAt.
    for (let i = 0; i < 5; i++) expect(paths.has(`/f${i}.ts`)).toBe(false);
    expect(paths.has('/f5.ts')).toBe(true);
    expect(paths.has('/f304.ts')).toBe(true);
  });
});

/**
 * Housekeeping is also the ORDERING barrier (cache/keyed-idb-store.ts): every
 * write awaits the same one-shot sweep, so two writes to one key land in the order
 * they were issued. When only the save awaited it, a save parked behind a slow
 * sweep landed AFTER a delete issued later and brought the record back — i.e.
 * pressing Save left the file still marked unsaved, with a draft of text that was
 * already on disk.
 */
describe('file drafts: a later delete cannot be overtaken by an earlier save', () => {
  /** Housekeeping that takes a while, so the parked put is observable. */
  class SlowSweepAdapter extends MemoryAdapter {
    async agesOldestFirst() {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return super.agesOldestFirst();
    }
  }

  it('the delete wins, even though the save was issued first', async () => {
    setFileDraftAdapter(new SlowSweepAdapter());

    // Both in flight at once: the editor's autosave, then the Save that clears it.
    const saving = saveFileDraft(null, '/marina/a.ts', { text: 'typed', baseHash: 'h1' });
    const deleting = deleteFileDraft(null, '/marina/a.ts');
    await Promise.all([saving, deleting]);

    expect(await loadFileDraft(null, '/marina/a.ts')).toBeNull();
    expect(await listFileDraftPaths(null)).toEqual(new Set());
  });
});

describe('file drafts: notification', () => {
  it('fires on save and on delete, and stops after unsubscribe', async () => {
    let hits = 0;
    const off = subscribeFileDrafts(() => { hits++; });

    await saveFileDraft(null, '/repo/a.ts', { text: 'x', baseHash: 'h' });
    expect(hits).toBe(1);
    await deleteFileDraft(null, '/repo/a.ts');
    expect(hits).toBe(2);

    off();
    await saveFileDraft(null, '/repo/a.ts', { text: 'y', baseHash: 'h' });
    expect(hits).toBe(2);
  });
});

describe('file drafts: a rename carries the draft', () => {
  it('moves the record to the new path, text and baseHash intact', async () => {
    await saveFileDraft(null, '/marina/src/a.ts', { text: 'half a thought', baseHash: 'h1' });
    await moveFileDraftsUnder(null, '/marina/src/a.ts', '/marina/src/b.ts');

    expect(await loadFileDraft(null, '/marina/src/a.ts')).toBeNull();
    const moved = await loadFileDraft(null, '/marina/src/b.ts');
    expect(moved?.text).toBe('half a thought');
    expect(moved?.baseHash).toBe('h1'); // the bytes didn't change, so the replay is still valid
    expect(moved?.path).toBe('/marina/src/b.ts');
  });

  it('a DIRECTORY rename moves every descendant draft', async () => {
    await saveFileDraft(null, '/marina/a/one.ts', { text: '1', baseHash: 'h1' });
    await saveFileDraft(null, '/marina/a/deep/two.ts', { text: '2', baseHash: 'h2' });
    await moveFileDraftsUnder(null, '/marina/a', '/marina/b');

    expect(await listFileDraftPaths(null)).toEqual(new Set([
      '/marina/b/one.ts', '/marina/b/deep/two.ts',
    ]));
    expect((await loadFileDraft(null, '/marina/b/deep/two.ts'))?.baseHash).toBe('h2');
  });

  it('matches path SEGMENTS — moving /a/b leaves /a/bc alone', async () => {
    await saveFileDraft(null, '/a/b/one.ts', { text: 'in b', baseHash: 'h1' });
    await saveFileDraft(null, '/a/bc/two.ts', { text: 'in bc', baseHash: 'h2' });
    await moveFileDraftsUnder(null, '/a/b', '/a/moved');

    expect(await listFileDraftPaths(null)).toEqual(new Set(['/a/moved/one.ts', '/a/bc/two.ts']));
  });

  it('only touches the requested host', async () => {
    await saveFileDraft(null, '/repo/a.ts', { text: 'mine', baseHash: 'h1' });
    await saveFileDraft('devbox', '/repo/a.ts', { text: 'theirs', baseHash: 'h2' });
    await moveFileDraftsUnder(null, '/repo/a.ts', '/repo/b.ts');

    expect(await listFileDraftPaths(null)).toEqual(new Set(['/repo/b.ts']));
    expect(await listFileDraftPaths('devbox')).toEqual(new Set(['/repo/a.ts']));
  });

  it('the outgoing editor\'s late flush lands under the NEW path', async () => {
    // The reported loss: the rename remaps the selection, so the old view
    // unmounts and flushes its buffer under the OLD path AFTER the move.
    await saveFileDraft(null, '/marina/a.ts', { text: 'typed', baseHash: 'h1' });
    await moveFileDraftsUnder(null, '/marina/a.ts', '/marina/b.ts');
    await saveFileDraft(null, '/marina/a.ts', { text: 'typed more', baseHash: 'h1' });

    expect(await loadFileDraft(null, '/marina/a.ts')).toBeNull();
    expect((await loadFileDraft(null, '/marina/b.ts'))?.text).toBe('typed more');
  });

  it('redirects a late flush from anywhere under a renamed DIRECTORY', async () => {
    await moveFileDraftsUnder(null, '/marina/a', '/marina/b');
    await saveFileDraft(null, '/marina/a/deep/one.ts', { text: 'late', baseHash: 'h1' });

    expect(await listFileDraftPaths(null)).toEqual(new Set(['/marina/b/deep/one.ts']));
  });

  it('a rename back settles on the original path', async () => {
    await moveFileDraftsUnder(null, '/marina/a.ts', '/marina/b.ts');
    await moveFileDraftsUnder(null, '/marina/b.ts', '/marina/a.ts');
    await saveFileDraft(null, '/marina/a.ts', { text: 'late', baseHash: 'h1' });

    expect(await listFileDraftPaths(null)).toEqual(new Set(['/marina/a.ts']));
  });
});

describe('file drafts: a delete takes the draft with it', () => {
  it('removes the record for the deleted file', async () => {
    await saveFileDraft(null, '/marina/a.ts', { text: 'gone with it', baseHash: 'h1' });
    await deleteFileDraftsUnder(null, '/marina/a.ts');

    expect(await loadFileDraft(null, '/marina/a.ts')).toBeNull();
  });

  it('a DIRECTORY delete removes descendants, segment-wise', async () => {
    await saveFileDraft(null, '/a/b/one.ts', { text: '1', baseHash: 'h1' });
    await saveFileDraft(null, '/a/b/deep/two.ts', { text: '2', baseHash: 'h2' });
    await saveFileDraft(null, '/a/bc/three.ts', { text: '3', baseHash: 'h3' });
    await deleteFileDraftsUnder(null, '/a/b');

    expect(await listFileDraftPaths(null)).toEqual(new Set(['/a/bc/three.ts']));
  });

  it('the unmount flush cannot re-create what the delete removed', async () => {
    // Without this the record came back for a dead path, and creating that
    // filename again offered to restore the deleted file's body.
    await saveFileDraft(null, '/marina/a.ts', { text: 'typed', baseHash: 'h1' });
    await deleteFileDraftsUnder(null, '/marina/a.ts');
    await saveFileDraft(null, '/marina/a.ts', { text: 'flushed on unmount', baseHash: 'h1' });

    expect(await loadFileDraft(null, '/marina/a.ts')).toBeNull();
    expect(await listFileDraftPaths(null)).toEqual(new Set());
  });

  it('a flush from anywhere under a deleted DIRECTORY is dropped too', async () => {
    await deleteFileDraftsUnder(null, '/marina/a');
    await saveFileDraft(null, '/marina/a/deep/one.ts', { text: 'late', baseHash: 'h1' });

    expect(await listFileDraftPaths(null)).toEqual(new Set());
  });

  it('a path RECREATED and read again accepts drafts once more', async () => {
    await deleteFileDraftsUnder(null, '/marina/a.ts');
    // The new file's editor reads before it can be typed in — that read is the
    // proof the path is live again.
    expect(await loadFileDraft(null, '/marina/a.ts')).toBeNull();
    await saveFileDraft(null, '/marina/a.ts', { text: 'brand new work', baseHash: 'h9' });

    expect((await loadFileDraft(null, '/marina/a.ts'))?.text).toBe('brand new work');
  });

  it('the write rules expire, so a stale one can never misdirect forever', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-01T10:00:00Z'));
      await deleteFileDraftsUnder(null, '/marina/a.ts');
      vi.setSystemTime(new Date('2026-09-01T10:02:00Z')); // past the 60s window
      await saveFileDraft(null, '/marina/a.ts', { text: 'much later', baseHash: 'h1' });

      expect((await loadFileDraft(null, '/marina/a.ts'))?.text).toBe('much later');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('file drafts: replay policy at read time', () => {
  const draft = (text: string, baseHash: string): FileDraft => ({
    host: null, path: '/marina/a.ts', text, baseHash, updatedAt: Date.now(),
  });

  it('no draft = seed from disk, lock at the disk hash', async () => {
    const plan = planDraftReplay(null, { content: 'on disk', contentHash: 'h-disk' });
    expect(plan).toEqual({ seed: null, stale: null, drop: false, lockHash: 'h-disk' });
  });

  it('a draft against the SAME bytes is replayed into the editor', () => {
    const plan = planDraftReplay(draft('typed', 'h-disk'), { content: 'on disk', contentHash: 'h-disk' });
    expect(plan.seed).toBe('typed');
    expect(plan.stale).toBeNull();
    expect(plan.lockHash).toBe('h-disk');
  });

  it('a draft typed back to the on-disk bytes is obsolete', () => {
    const plan = planDraftReplay(draft('on disk', 'h-old'), { content: 'on disk', contentHash: 'h-disk' });
    expect(plan.drop).toBe(true);
    expect(plan.seed).toBeNull();
    expect(plan.stale).toBeNull();
  });

  it('a draft against OLDER bytes is held back, not replayed', () => {
    const plan = planDraftReplay(draft('mine', 'h-old'), { content: 'newer on disk', contentHash: 'h-disk' });
    expect(plan.seed).toBeNull(); // editor still shows what is on disk
    expect(plan.stale).toEqual({ text: 'mine', baseHash: 'h-old' });
    expect(plan.lockHash).toBe('h-disk');
  });
});

describe('file drafts: restoring a stale draft cannot overwrite silently', () => {
  it('re-arms the lock at the DRAFT\'s baseHash, not the current disk hash', () => {
    // The reported loss: type, the session\'s agent rewrites the file, Refresh,
    // "Restore my changes", ⌘S — the newer file was replaced with no 409.
    const read = planDraftReplay(
      { host: null, path: '/marina/a.ts', text: 'mine', baseHash: 'h-old', updatedAt: Date.now() },
      { content: 'the agent\'s newer version', contentHash: 'h-disk' },
    );
    const restore = planStaleDraftRestore(read.stale!);

    expect(restore.seed).toBe('mine');
    expect(restore.lockHash).toBe('h-old');
    // The save's expectedHash no longer matches the file ⇒ the server 409s and the
    // user gets the existing conflict warning instead of a silent overwrite.
    expect(restore.lockHash).not.toBe(read.lockHash);
    expect(restore.lockHash).not.toBe('h-disk');
  });

  it('a draft with no recorded baseHash still sends a non-empty token', () => {
    // An EMPTY expectedHash reads as "no lock" on both sides, which would be the
    // silent overwrite again.
    const restore = planStaleDraftRestore({ text: 'mine', baseHash: '' });
    expect(restore.lockHash).not.toBe('');
    expect(restore.lockHash.length).toBeGreaterThan(0);
  });
});

describe('file drafts: a broken store never reaches a render', () => {
  beforeEach(() => { setFileDraftAdapter(new ThrowingAdapter()); });

  it('load resolves null', async () => {
    await expect(loadFileDraft(null, '/repo/a.ts')).resolves.toBeNull();
  });

  it('save resolves instead of rejecting', async () => {
    await expect(saveFileDraft(null, '/repo/a.ts', { text: 'x', baseHash: 'h' })).resolves.toBeUndefined();
  });

  it('delete resolves instead of rejecting', async () => {
    await expect(deleteFileDraft(null, '/repo/a.ts')).resolves.toBeUndefined();
  });

  it('list resolves to an empty set', async () => {
    await expect(listFileDraftPaths(null)).resolves.toEqual(new Set());
  });

  it('a rename\'s draft move resolves instead of rejecting', async () => {
    await expect(moveFileDraftsUnder(null, '/a.ts', '/b.ts')).resolves.toBeUndefined();
  });

  it('a delete\'s draft cleanup resolves instead of rejecting', async () => {
    await expect(deleteFileDraftsUnder(null, '/a.ts')).resolves.toBeUndefined();
  });
});
