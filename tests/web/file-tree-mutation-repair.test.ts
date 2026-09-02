/**
 * Files-panel state repair after a rename / delete, and the rule that decides
 * whether a restored selection is dead.
 *
 * Three shipped losses live here:
 *   - a rename repaired `selectedFile` / `expanded` / `childrenMap` but NOT the
 *     back/forward history, so pressing Back after renaming folder `a` to `b`
 *     mounted a dead `a/one.ts` and showed an error pane where a file used to be;
 *   - a delete pruned only the CURRENT selection, so every other stop under the
 *     removed folder stayed in the stack;
 *   - the explorer's stale-selection pruner ran on CACHED listings, and a listing
 *     that predates a file says "not there" — so it cleared the remembered file
 *     and dropped its history stop (both persisted to localStorage) for a file
 *     that exists. Its verdict must wait for FRESH rows.
 *
 * Every path rule here is SEGMENT-wise: `/a/b` must never match `/a/bc`.
 */
import { describe, it, expect } from 'vitest';
import {
  remapFileHistory, pruneFileHistoryUnder, judgeRestoredSelection,
  planPendingPolls, pendingOpLanded, PENDING_POLL_DELAYS_MS,
  type PendingPollPlan,
} from '@/components/sessions/useFileTreeMutations';
import type { FileHistory } from '@/utils/file-view-state';
import type { DirEntry } from '@/api/files';

function history(paths: Array<string | [string, number]>, index?: number): FileHistory {
  const entries = paths.map((p) => (typeof p === 'string' ? { path: p } : { path: p[0], line: p[1] }));
  return { entries, index: index ?? entries.length - 1 };
}

const file = (name: string): DirEntry => ({ name, type: 'file' });
const dir = (name: string): DirEntry => ({ name, type: 'dir' });

describe('history follows a rename', () => {
  it('remaps the renamed file itself', () => {
    const next = remapFileHistory(history(['/marina/a.ts', '/marina/b.ts']), '/marina/b.ts', '/marina/c.ts');
    expect(next.entries.map((e) => e.path)).toEqual(['/marina/a.ts', '/marina/c.ts']);
    expect(next.index).toBe(1);
  });

  it('remaps every stop under a renamed DIRECTORY', () => {
    const next = remapFileHistory(
      history(['/marina/a/one.ts', '/marina/a/deep/two.ts', '/marina/other.ts'], 1),
      '/marina/a',
      '/marina/b',
    );
    expect(next.entries.map((e) => e.path)).toEqual([
      '/marina/b/one.ts', '/marina/b/deep/two.ts', '/marina/other.ts',
    ]);
    expect(next.index).toBe(1); // still on the same file, under its new name
  });

  it('leaves /a/bc alone when /a/b is renamed', () => {
    const next = remapFileHistory(history(['/a/b/one.ts', '/a/bc/two.ts']), '/a/b', '/a/moved');
    expect(next.entries.map((e) => e.path)).toEqual(['/a/moved/one.ts', '/a/bc/two.ts']);
  });

  it('keeps a positioned stop\'s line', () => {
    const next = remapFileHistory(history([['/marina/a/one.ts', 42]]), '/marina/a', '/marina/b');
    expect(next.entries[0]).toEqual({ path: '/marina/b/one.ts', line: 42 });
  });

  it('returns the SAME object when nothing under the rename was visited', () => {
    const before = history(['/marina/x.ts']);
    expect(remapFileHistory(before, '/marina/a', '/marina/b')).toBe(before);
  });

  it('collapses stops the remap made adjacent duplicates of, keeping the cursor', () => {
    // The stack already held a file at the destination name, so Back would
    // otherwise land on the same file it started from.
    const next = remapFileHistory(history(['/m/a.ts', '/m/b.ts', '/m/c.ts'], 2), '/m/a.ts', '/m/b.ts');
    expect(next.entries.map((e) => e.path)).toEqual(['/m/b.ts', '/m/c.ts']);
    expect(next.entries[next.index]!.path).toBe('/m/c.ts');
  });

  it('an empty history is untouched', () => {
    const before: FileHistory = { entries: [], index: -1 };
    expect(remapFileHistory(before, '/a', '/b')).toBe(before);
  });
});

describe('history is pruned by a delete', () => {
  it('drops every stop under a removed folder, not just the open file', () => {
    const next = pruneFileHistoryUnder(
      history(['/m/keep.ts', '/m/a/one.ts', '/m/a/deep/two.ts', '/m/later.ts'], 3),
      '/m/a',
    );
    expect(next.entries.map((e) => e.path)).toEqual(['/m/keep.ts', '/m/later.ts']);
    expect(next.entries[next.index]!.path).toBe('/m/later.ts'); // cursor stayed on its file
  });

  it('leaves /a/bc alone when /a/b is deleted', () => {
    const next = pruneFileHistoryUnder(history(['/a/b/one.ts', '/a/bc/two.ts'], 1), '/a/b');
    expect(next.entries.map((e) => e.path)).toEqual(['/a/bc/two.ts']);
    expect(next.index).toBe(0);
  });

  it('losing the CURRENT stop lands on its predecessor', () => {
    const next = pruneFileHistoryUnder(history(['/m/first.ts', '/m/a/gone.ts'], 1), '/m/a');
    expect(next.entries.map((e) => e.path)).toEqual(['/m/first.ts']);
    expect(next.index).toBe(0);
  });

  it('removing everything empties the stack (both buttons go dead, not to a hole)', () => {
    const next = pruneFileHistoryUnder(history(['/m/a/one.ts', '/m/a/two.ts'], 1), '/m/a');
    expect(next).toEqual({ entries: [], index: -1 });
  });

  it('deleting the exact file path works, not just a folder', () => {
    const next = pruneFileHistoryUnder(history(['/m/a.ts', '/m/b.ts'], 1), '/m/b.ts');
    expect(next.entries.map((e) => e.path)).toEqual(['/m/a.ts']);
  });

  it('returns the SAME object when nothing under the path was visited', () => {
    const before = history(['/m/x.ts']);
    expect(pruneFileHistoryUnder(before, '/m/a')).toBe(before);
  });
});

/**
 * A mutation the server answered 202 for: it is still running on the host, so the
 * shipped bug was reporting "Delete failed" and repairing nothing while the daemon
 * went on and deleted the folder anyway. The watch below is the replacement — and
 * the part worth pinning is that the FILESYSTEM decides, never a timer.
 */
describe('a pending (202) mutation is watched, not guessed', () => {
  const rows = (...names: string[]): DirEntry[] => names.map(file);

  /** The probe loop, driven purely: one listing per scheduled probe. */
  function runProbes(plan: PendingPollPlan, listings: Array<DirEntry[] | undefined>) {
    const probedAt: number[] = [];
    for (const [i, delay] of plan.delays.entries()) {
      probedAt.push(delay);
      if (pendingOpLanded(plan, listings[i])) return { probedAt, landed: true };
    }
    return { probedAt, landed: false };
  }

  it('probes at 3s, 10s and 30s after the 202', () => {
    const plan = planPendingPolls({ op: 'delete', path: '/m/big', message: 'Still working on it…' });
    expect(plan.delays).toEqual([3_000, 10_000, 30_000]);
    expect(plan.delays).toEqual(PENDING_POLL_DELAYS_MS);
    // Offsets from the 202, so they must be strictly increasing — a sorted copy
    // that differs would mean the last one is not the give-up point.
    expect([...plan.delays].sort((a, b) => a - b)).toEqual(plan.delays);
  });

  it('a delete watches its PARENT for the row to disappear', () => {
    const plan = planPendingPolls({ op: 'delete', path: '/m/src/gone.ts', message: 'still deleting' });
    expect(plan.dirs).toEqual(['/m/src']);
    expect(plan.watchDir).toBe('/m/src');
    expect(plan.watchName).toBe('gone.ts');
    expect(plan.expect).toBe('absent');
    expect(plan.target).toBe('/m/src/gone.ts');
    expect(plan.message).toBe('still deleting'); // the server's own prose, verbatim
  });

  it('a duplicate watches its DESTINATION for the copy to appear', () => {
    const plan = planPendingPolls({
      op: 'duplicate', path: '/m/src/a.ts', destination: '/m/src/a copy.ts', message: 'still copying',
    });
    expect(plan.dirs).toEqual(['/m/src']); // one dir, listed once, not twice
    expect(plan.watchDir).toBe('/m/src');
    expect(plan.watchName).toBe('a copy.ts');
    expect(plan.expect).toBe('present');
  });

  it('a duplicate into ANOTHER folder re-lists both ends', () => {
    const plan = planPendingPolls({
      op: 'duplicate', path: '/m/src/a.ts', destination: '/m/backup/a.ts', message: 'still copying',
    });
    expect(plan.dirs).toEqual(['/m/src', '/m/backup']);
    expect(plan.watchDir).toBe('/m/backup'); // the copy is judged where it lands
  });

  it('a rename watches the NEW name (any remote op can answer 202, not just the slow ones)', () => {
    // A remote rename over a stalled tunnel used to sit on the RPC's full timeout
    // and then come back as a failure the file tree "repaired" by putting the old
    // row back — over a rename that had in fact landed.
    const plan = planPendingPolls({
      op: 'rename', path: '/m/src/old.ts', destination: '/m/src/new.ts', message: 'still renaming',
    });
    expect(plan.dirs).toEqual(['/m/src']);
    expect(plan.watchDir).toBe('/m/src');
    expect(plan.watchName).toBe('new.ts');
    expect(plan.expect).toBe('present');
    // The watch is keyed by the SOURCE: a second op on the same row replaces it.
    expect(plan.target).toBe('/m/src/old.ts');
  });

  it('a create watches the folder for the new row to appear', () => {
    const plan = planPendingPolls({
      op: 'create', path: '/m/src/fresh.ts', destination: '/m/src/fresh.ts', message: 'still creating',
    });
    expect(plan.dirs).toEqual(['/m/src']);
    expect(plan.watchName).toBe('fresh.ts');
    expect(plan.expect).toBe('present');
  });

  it('stops early: rows that show the end state end the watch', () => {
    const del = planPendingPolls({ op: 'delete', path: '/m/src/gone.ts', message: 'x' });
    // Gone by the second probe — the 30s one is never armed.
    const run = runProbes(del, [rows('gone.ts', 'keep.ts'), rows('keep.ts'), rows('keep.ts')]);
    expect(run.landed).toBe(true);
    expect(run.probedAt).toEqual([3_000, 10_000]);
  });

  it('stops at the FIRST probe when the host was quick', () => {
    const dup = planPendingPolls({
      op: 'duplicate', path: '/m/a.ts', destination: '/m/a copy.ts', message: 'x',
    });
    const run = runProbes(dup, [rows('a.ts', 'a copy.ts')]);
    expect(run.landed).toBe(true);
    expect(run.probedAt).toEqual([3_000]);
  });

  it('never lands when the rows keep saying otherwise — the notice stays instead', () => {
    const del = planPendingPolls({ op: 'delete', path: '/m/src/gone.ts', message: 'x' });
    const run = runProbes(del, [rows('gone.ts'), rows('gone.ts'), rows('gone.ts')]);
    expect(run.landed).toBe(false);
    expect(run.probedAt).toEqual([3_000, 10_000, 30_000]);
  });

  it('a MISSING listing is "don\'t know", never "it landed"', () => {
    // The re-list failed (offline, daemon gone) or React hasn't committed it yet.
    // Treating that as success would forget the tree state of a file that still
    // exists — the confident wrong answer this watch exists to avoid.
    const del = planPendingPolls({ op: 'delete', path: '/m/src/gone.ts', message: 'x' });
    expect(pendingOpLanded(del, undefined)).toBe(false);
    const dup = planPendingPolls({
      op: 'duplicate', path: '/m/a.ts', destination: '/m/a copy.ts', message: 'x',
    });
    expect(pendingOpLanded(dup, undefined)).toBe(false);
  });

  it('an emptied directory settles a delete, and an empty one never settles a duplicate', () => {
    const del = planPendingPolls({ op: 'delete', path: '/m/src/gone.ts', message: 'x' });
    expect(pendingOpLanded(del, [])).toBe(true);
    const dup = planPendingPolls({
      op: 'duplicate', path: '/m/a.ts', destination: '/m/a copy.ts', message: 'x',
    });
    expect(pendingOpLanded(dup, [])).toBe(false);
  });

  it('judges by NAME within the watched dir — a same-named file elsewhere is not it', () => {
    const del = planPendingPolls({ op: 'delete', path: '/m/src/gone.ts', message: 'x' });
    expect(pendingOpLanded(del, rows('gone.ts'))).toBe(false);
    expect(pendingOpLanded(del, rows('gone.ts.bak', 'notgone.ts'))).toBe(true);
  });
});

describe('a restored selection is judged only on FRESH rows', () => {
  const rows = [file('one.ts'), dir('deep')];

  it('waits while the parent listing has not arrived', () => {
    expect(judgeRestoredSelection({ path: '/m/one.ts', entries: undefined, parentIsFresh: true }))
      .toBe('wait');
  });

  it('waits on a CACHED listing, even one the file is missing from', () => {
    // The destructive case: a cached listing written before the file existed used
    // to clear the remembered file and drop its history stop.
    expect(judgeRestoredSelection({ path: '/m/added-later.ts', entries: rows, parentIsFresh: false }))
      .toBe('wait');
  });

  it('waits on a cached listing that DOES show the file, so the fresh one decides', () => {
    expect(judgeRestoredSelection({ path: '/m/one.ts', entries: rows, parentIsFresh: false }))
      .toBe('wait');
  });

  it('keeps a selection the fresh listing shows', () => {
    expect(judgeRestoredSelection({ path: '/m/one.ts', entries: rows, parentIsFresh: true }))
      .toBe('keep');
  });

  it('prunes a selection the fresh listing does not have', () => {
    expect(judgeRestoredSelection({ path: '/m/deleted.ts', entries: rows, parentIsFresh: true }))
      .toBe('prune');
  });

  it('a DIRECTORY of that name is not the file — prune', () => {
    expect(judgeRestoredSelection({ path: '/m/deep', entries: rows, parentIsFresh: true }))
      .toBe('prune');
  });

  it('an empty fresh listing prunes', () => {
    expect(judgeRestoredSelection({ path: '/m/one.ts', entries: [], parentIsFresh: true }))
      .toBe('prune');
  });
});
