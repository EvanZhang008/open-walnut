/**
 * The draft session column's pure logic: quick-access chip selection (R6), the
 * AI-backfill ownership rules (R9), and the suggested-vs-chosen ledger the launch
 * records from them.
 *
 * Both are decisions a browser spec can only observe indirectly — the chip row is
 * ranked over a working-dirs store every launch reorders, and "the AI may not
 * overwrite this field" is invisible until it regresses and silently moves a user's
 * project. So they are asserted here, on the module, and the browser suite keeps
 * asserting the DOM shape that surfaces them.
 *
 * `peekWorkingDirs` is the ONLY input to `quickDirsFor` (the draft-open path is
 * contractually network-free), so mocking that one export is the whole fixture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkingDirEntry, WorkingDirsResult } from '@/api/sessions';

const { peek } = vi.hoisted(() => ({ peek: vi.fn<() => WorkingDirsResult | null>() }));

vi.mock('@/api/sessions', () => ({ peekWorkingDirs: peek }));

const {
  applyDraftParse, clearAiFields, quickDirsFor, projectForFolderPick, suggestDiff, restoreMetaAfterWalnut,
  followProjectRegistryChange,
} = await import('@/components/sessions/draft-column');
type DraftColumn = import('@/components/sessions/draft-column').DraftColumn;

/** A working-dirs row. `count` = absolute lifetime uses, `lastUsed` = recency —
 *  the two axes the chip row splits across. */
function dir(cwd: string, count: number, lastUsed: string, host: string | null = null): WorkingDirEntry {
  return { cwd, host, project: '', count, lastUsed };
}

function seedDirs(dirs: WorkingDirEntry[]): void {
  peek.mockReturnValue({ dirs, hosts: [] });
}

function draft(over: Partial<DraftColumn> = {}): DraftColumn {
  return {
    id: 'draft:1',
    cwd: '',
    host: null,
    meta: { unread: false, priority: 'none', pinTier: 'focus', model: undefined, engine: undefined },
    ...over,
  };
}

const names = (dirs: WorkingDirEntry[]) => dirs.map((d) => d.cwd);

beforeEach(() => {
  peek.mockReset();
});

describe('quickDirsFor — chip selection (R6)', () => {
  it('takes the top 4 by ABSOLUTE count, then the 4 most recent of the rest', () => {
    // /fresh* are the newest but barely used; /heavy* are the workhorses. The
    // server's own frecency order would surface /fresh1 first, which is exactly
    // the churn this split removes.
    seedDirs([
      dir('/fresh1', 1, '2026-08-11T10:00:00Z'),
      dir('/heavy1', 90, '2026-01-01T00:00:00Z'),
      dir('/fresh2', 2, '2026-08-10T10:00:00Z'),
      dir('/heavy2', 50, '2026-02-01T00:00:00Z'),
      dir('/heavy3', 30, '2026-03-01T00:00:00Z'),
      dir('/heavy4', 25, '2026-03-05T00:00:00Z'),
      dir('/heavy5', 20, '2026-03-06T00:00:00Z'),
      dir('/fresh3', 3, '2026-08-09T10:00:00Z'),
      dir('/fresh4', 4, '2026-08-08T10:00:00Z'),
      dir('/old', 3, '2020-01-01T00:00:00Z'),
    ]);
    expect(names(quickDirsFor())).toEqual([
      '/heavy1', '/heavy2', '/heavy3', '/heavy4',   // by count
      '/fresh1', '/fresh2', '/fresh3', '/fresh4',   // by recency, excluding the four above
    ]);
  });

  it('never exceeds 8 chips', () => {
    seedDirs(Array.from({ length: 20 }, (_, i) => dir(`/d${i}`, 20 - i, `2026-08-${(i % 28) + 1}T00:00:00Z`)));
    expect(quickDirsFor()).toHaveLength(8);
  });

  it('returns fewer than 8 when the cache holds fewer dirs', () => {
    seedDirs([dir('/a', 5, '2026-08-01T00:00:00Z'), dir('/b', 2, '2026-08-02T00:00:00Z')]);
    expect(names(quickDirsFor())).toEqual(['/a', '/b']);
  });

  it("keeps the draft's CURRENT cwd in the row — membership is cache-only", () => {
    // Excluding it made the row RESHUFFLE right after a pick (the folder just
    // left re-entered at slot 0), so a double-click re-picked the folder the
    // user had escaped. The bar renders the current chip active instead.
    seedDirs([
      dir('/here', 100, '2026-08-11T00:00:00Z'),
      dir('/a', 9, '2026-08-01T00:00:00Z'),
      dir('/b', 8, '2026-07-01T00:00:00Z'),
    ]);
    expect(names(quickDirsFor())).toEqual(['/here', '/a', '/b']);
  });

  it('treats the same path on a different HOST as a different folder', () => {
    seedDirs([dir('/repo', 10, '2026-08-01T00:00:00Z'), dir('/repo', 9, '2026-08-02T00:00:00Z', 'devbox')]);
    const out = quickDirsFor();
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.host)).toEqual([null, 'devbox']);
  });

  it('dedupes duplicate rows for one cwd+host pair', () => {
    seedDirs([dir('/a', 10, '2026-08-01T00:00:00Z'), dir('/a', 4, '2026-08-05T00:00:00Z')]);
    expect(names(quickDirsFor())).toEqual(['/a']);
  });

  it('is EMPTY on a cold cache — never a fetch', () => {
    peek.mockReturnValue(null);
    expect(quickDirsFor()).toEqual([]);
    expect(peek).toHaveBeenCalledTimes(1);
  });

  it('breaks count ties on recency, so the order is deterministic', () => {
    seedDirs([
      dir('/older', 5, '2026-01-01T00:00:00Z'),
      dir('/newer', 5, '2026-08-01T00:00:00Z'),
    ]);
    expect(names(quickDirsFor())).toEqual(['/newer', '/older']);
  });

  it('sorts a missing/garbage lastUsed LAST instead of poisoning the compare', () => {
    seedDirs([
      { cwd: '/broken', host: null, project: '', count: 1, lastUsed: 'not-a-date' },
      dir('/fine', 1, '2026-08-01T00:00:00Z'),
    ]);
    expect(names(quickDirsFor())).toEqual(['/fine', '/broken']);
  });
});

describe('applyDraftParse — AI may only fill what nobody claimed (R9)', () => {
  const noDefaults = () => undefined;

  it('fills an EMPTY project and marks it ✦ + projectSource ai', () => {
    const out = applyDraftParse(draft(), { project: 'Marina' }, noDefaults);
    expect(out.project).toBe('Marina');
    expect(out.projectSource).toBe('ai');
    expect(out.aiFields?.has('project')).toBe(true);
  });

  it('NEVER overwrites a user-picked project', () => {
    const d = draft({ project: 'Mine', projectSource: 'user' });
    const out = applyDraftParse(d, { project: 'Marina' }, noDefaults);
    expect(out.project).toBe('Mine');
    expect(out.projectSource).toBe('user');
    expect(out.aiFields?.has('project')).toBeFalsy();
    // The REFUSED proposal is still recorded: "the AI said Marina, the user
    // launched under Mine" is the single most useful line in the accuracy ledger,
    // so this is the one thing that legitimately changes the row here.
    expect(out.aiSuggested).toEqual({ project: 'Marina' });
  });

  it('NEVER overwrites a SEEDED project (project/tier "+")', () => {
    const d = draft({ project: 'Seeded', projectSource: 'seed' });
    expect(applyDraftParse(d, { project: 'Marina' }, noDefaults).project).toBe('Seeded');
  });

  it('replaces its OWN earlier guess as the sentence changes', () => {
    const first = applyDraftParse(draft(), { project: 'Marina' }, noDefaults);
    const second = applyDraftParse(first, { project: 'Acme' }, noDefaults);
    expect(second.project).toBe('Acme');
    expect(second.projectSource).toBe('ai');
  });

  it("follows an AI project to the project's default_cwd, ✦-marking the folder", () => {
    const out = applyDraftParse(
      draft(),
      { project: 'Marina' },
      (name) => (name === 'Marina' ? { cwd: '/work/marina', host: 'devbox' } : undefined),
    );
    expect(out.cwd).toBe('/work/marina');
    expect(out.host).toBe('devbox');
    expect(out.aiFields?.has('cwd')).toBe(true);
    // A folder the AI chose is NOT a pin — a project default or a later pick may
    // still move it.
    expect(out.cwdPinned).toBeUndefined();
  });

  it('leaves a PINNED cwd alone while still applying the project', () => {
    const out = applyDraftParse(
      draft({ cwd: '/chosen', cwdPinned: true }),
      { project: 'Marina' },
      () => ({ cwd: '/work/marina', host: null }),
    );
    expect(out.cwd).toBe('/chosen');
    expect(out.project).toBe('Marina');
    expect(out.aiFields?.has('cwd')).toBe(false);
  });

  it('writes priority with a ✦ and records it, WITHOUT latching metaTouched', () => {
    const out = applyDraftParse(draft(), { priority: 'important' }, noDefaults);
    expect(out.meta.priority).toBe('important');
    // THE regression guard: metaTouched is the per-directory launch-memory switch
    // for model/engine, so an AI write must never latch it.
    expect(out.metaTouched).toBeUndefined();
    expect(out.userTouched).toBeUndefined();
    expect(out.fieldOwner).toBeUndefined();
    expect(out.aiFields?.has('priority')).toBe(true);
    expect(out.aiSuggested).toEqual({ priority: 'important' });
  });

  it('APPLIES the pin tier now that a chip shows it, ✦-marked and recorded', () => {
    const out = applyDraftParse(draft(), { pinTier: 'backlog' }, noDefaults);
    expect(out.meta.pinTier).toBe('backlog');
    expect(out.aiFields?.has('pinTier')).toBe(true);
    expect(out.aiSuggested).toEqual({ pinTier: 'backlog' });
  });

  it('metaTouched (model/engine memory) no longer freezes the task fields', () => {
    const d = draft({ metaTouched: true });
    const out = applyDraftParse(d, { priority: 'important', due_date: '2026-08-14T17:00:00' }, noDefaults);
    expect(out.meta.priority).toBe('important');
    expect(out.meta.dueDate).toBe('2026-08-14T17:00:00');
    expect(out.metaTouched).toBe(true);
  });

  it('fills the date trio ("by Friday 3-5pm"): start and due ✦-marked, the end rides the start', () => {
    const out = applyDraftParse(draft(), {
      due_date: '2026-08-14T17:00:00Z',
      start_date: '2026-08-14T15:00:00Z',
      end_date: '2026-08-14T17:00:00Z',
    }, noDefaults);
    expect(out.meta.dueDate).toBe('2026-08-14T17:00:00Z');
    expect(out.meta.startDate).toBe('2026-08-14T15:00:00Z');
    expect(out.meta.endDate).toBe('2026-08-14T17:00:00Z');
    expect([...(out.aiFields ?? [])].sort()).toEqual(['dueDate', 'startDate']);
    // The end is never a ledger field: it cannot be changed on its own.
    expect(out.aiSuggested).toEqual({ dueDate: '2026-08-14T17:00:00Z', startDate: '2026-08-14T15:00:00Z' });
    expect(out.metaTouched).toBeUndefined();
  });

  it('a user-owned due is not written, but the proposal is still recorded', () => {
    const d = draft({ fieldOwner: { dueDate: 'user' }, meta: { ...draft().meta, dueDate: '2026-08-20' } });
    const out = applyDraftParse(d, { due_date: '2026-08-14' }, noDefaults);
    expect(out.meta.dueDate).toBe('2026-08-20');
    expect(out.aiFields?.has('dueDate')).toBe(false);
    expect(out.aiSuggested).toEqual({ dueDate: '2026-08-14' });
  });

  it('returns the SAME row when the same parse lands again (C15)', () => {
    // Every eager mid-typing parse repeats the previous answer: the second landing
    // must not hand React a new row. The title is ignored (a retitle is a no-op).
    const parse = { title: 'a', project: 'Marina', priority: 'important' as const, pinTier: 'satellite' };
    const first = applyDraftParse(draft(), parse, noDefaults);
    expect(first).not.toBe(draft());
    expect(applyDraftParse(first, parse, noDefaults)).toBe(first);
    expect(applyDraftParse(first, { ...parse, title: 'a b' }, noDefaults)).toBe(first);
  });

  it('Focus proposed on a Focus row: new object once (✦ added), then the same object (C15)', () => {
    const d = draft();
    const first = applyDraftParse(d, { pinTier: 'focus' }, noDefaults);
    expect(first).not.toBe(d);
    expect(first.meta.pinTier).toBe('focus');
    expect(first.aiFields?.has('pinTier')).toBe(true);
    expect(applyDraftParse(first, { pinTier: 'focus' }, noDefaults)).toBe(first);
  });

  it('returns the SAME row for an empty parse', () => {
    const d = draft();
    expect(applyDraftParse(d, {}, noDefaults)).toBe(d);
  });
});

describe('suggestDiff — what the AI proposed vs. what the launch carried', () => {
  const noDefaults = () => undefined;

  it('pairs each proposal with the value the launch actually carries', () => {
    // The user overrode the project by hand but kept the folder it brought along;
    // the ledger has to show BOTH sides, or "the suggestions feel wrong" stays
    // unfalsifiable.
    let d = applyDraftParse(
      draft(),
      { project: 'Marina' },
      (name) => (name === 'Marina' ? { cwd: '/work/marina', host: null } : undefined),
    );
    d = { ...d, project: 'Acme', projectSource: 'user' };

    expect(suggestDiff(d)).toEqual([
      { field: 'project', suggested: 'Marina', chosen: 'Acme' },
      { field: 'cwd', suggested: '/work/marina', chosen: '/work/marina' },
    ]);
  });

  it('reports a kept suggestion as suggested === chosen', () => {
    const d = applyDraftParse(draft(), { project: 'Marina' }, noDefaults);
    expect(suggestDiff(d)).toEqual([{ field: 'project', suggested: 'Marina', chosen: 'Marina' }]);
  });

  it('omits `chosen` when the user cleared the field', () => {
    let d = applyDraftParse(draft(), { project: 'Marina' }, noDefaults);
    d = { ...d, project: '', projectSource: 'user' };   // picked Inbox on the pill
    expect(suggestDiff(d)).toEqual([{ field: 'project', suggested: 'Marina' }]);
  });

  it('records the tier as kept, changed or dropped', () => {
    const d = applyDraftParse(draft(), { pinTier: 'backlog' }, noDefaults);
    expect(suggestDiff(d)).toEqual([{ field: 'pinTier', suggested: 'backlog', chosen: 'backlog' }]);
    const changed = { ...d, meta: { ...d.meta, pinTier: 'wait' } };
    expect(suggestDiff(changed)).toEqual([{ field: 'pinTier', suggested: 'backlog', chosen: 'wait' }]);
    const unpinned = { ...d, meta: { ...d.meta, pinTier: undefined } };
    expect(suggestDiff(unpinned)).toEqual([{ field: 'pinTier', suggested: 'backlog' }]);
  });

  it('a tier the app cannot resolve counts as the Focus the launch sends', () => {
    let d = applyDraftParse(draft(), { pinTier: 'ct_gone0001' }, noDefaults, { tierKnown: () => true });
    d = { ...d, meta: { ...d.meta, pinTier: 'ct_gone0001' } };
    expect(suggestDiff(d, { tierKnown: () => false })).toEqual([
      { field: 'pinTier', suggested: 'ct_gone0001', chosen: 'focus' },
    ]);
  });

  it('records priority and dates; priority none and a cleared date count as dropped, the end never', () => {
    let d = applyDraftParse(draft(), {
      project: 'Marina', priority: 'important',
      due_date: '2026-08-14T17:00:00', start_date: '2026-08-14T15:00:00', end_date: '2026-08-14T16:00:00',
    }, noDefaults);
    d = { ...d, meta: { ...d.meta, priority: 'none', dueDate: undefined, startDate: '2026-08-15T09:00:00' } };
    expect(suggestDiff(d)).toEqual([
      { field: 'project', suggested: 'Marina', chosen: 'Marina' },
      { field: 'priority', suggested: 'important' },
      { field: 'startDate', suggested: '2026-08-14T15:00:00', chosen: '2026-08-15T09:00:00' },
      { field: 'dueDate', suggested: '2026-08-14T17:00:00' },
    ]);
  });

  it('records the folder the AI derived from its project', () => {
    const d = applyDraftParse(
      draft(),
      { project: 'Marina' },
      (name) => (name === 'Marina' ? { cwd: '/work/marina', host: null } : undefined),
    );
    expect(suggestDiff(d)).toEqual([
      { field: 'project', suggested: 'Marina', chosen: 'Marina' },
      { field: 'cwd', suggested: '/work/marina', chosen: '/work/marina' },
    ]);
  });

  it('records NOTHING for fields the AI never proposed', () => {
    // A draft always carries a folder, so counting silence as "the AI missed it"
    // would bury every real signal under defaults.
    const d = draft({ cwd: '/picked', project: 'Chosen', projectSource: 'user' });
    expect(suggestDiff(d)).toEqual([]);
  });

  it('survives a draft that never saw a parse', () => {
    expect(suggestDiff(draft())).toEqual([]);
  });
});

describe('clearAiFields — a user edit drops the badge, not the authority', () => {
  it('removes only the named fields', () => {
    const d = draft({ aiFields: new Set(['project', 'cwd', 'priority'] as const) });
    const out = clearAiFields(d, ['project']);
    expect(out.aiFields?.has('project')).toBe(false);
    expect(out.aiFields?.has('cwd')).toBe(true);
    expect(out.aiFields?.has('priority')).toBe(true);
  });

  it('is a no-op (same object) when there is nothing to clear', () => {
    const d = draft({ aiFields: new Set(['cwd'] as const) });
    expect(clearAiFields(d, ['project'])).toBe(d);
    const bare = draft();
    expect(clearAiFields(bare, ['project'])).toBe(bare);
  });
});

describe('projectForFolderPick — a folder is a project unless somebody said otherwise', () => {
  /** Registry lookup: only /home/walnut is declared (by "Walnut"). Exact-match on
   *  a slash-stripped path, mirroring MainPage's projectForDir. */
  const registry = (cwd: string) => (cwd === '/home/walnut' ? 'Walnut' : '');

  it('a declared folder resolves to its registry owner, over any earlier value', () => {
    expect(projectForFolderPick(draft(), '/home/walnut', registry)).toBe('Walnut');
    // Trailing slashes are normalized before the registry lookup.
    expect(projectForFolderPick(draft(), '/home/walnut//', registry)).toBe('Walnut');
    // The mapping is user-configured fact — it outranks even an explicit pick.
    const userPicked = draft({ project: 'Other', projectSource: 'user' });
    expect(projectForFolderPick(userPicked, '/home/walnut', registry)).toBe('Walnut');
  });

  it('a folder INSIDE a declared checkout resolves to that project, not a junk basename', () => {
    // Picking repo/web inside the checkout must not mint a "web" project.
    expect(projectForFolderPick(draft(), '/home/walnut/web/src', registry)).toBe('Walnut');
  });

  it('re-picking the folder of the CURRENT project still returns it — the caller must latch ownership', () => {
    // Same value, but the source may be 'ai': returning null would leave the AI
    // free to move the project off a folder the user just explicitly picked.
    const aiSame = draft({ project: 'Walnut', projectSource: 'ai' });
    expect(projectForFolderPick(aiSame, '/home/walnut', registry)).toBe('Walnut');
  });

  it('an undeclared folder defaults to its basename (the project the launch creates)', () => {
    expect(projectForFolderPick(draft(), '/repos/tidepool', registry)).toBe('tidepool');
    // Trailing slashes don't leak into the name.
    expect(projectForFolderPick(draft(), '/repos/tidepool///', registry)).toBe('tidepool');
  });

  it('the basename DEFAULT never overwrites an explicit user/seed project — including Inbox', () => {
    expect(projectForFolderPick(draft({ project: 'Chosen', projectSource: 'user' }), '/repos/x', registry)).toBeNull();
    expect(projectForFolderPick(draft({ project: 'Seeded', projectSource: 'seed' }), '/repos/x', registry)).toBeNull();
    // Explicit "Inbox" pick ('' with source 'user') is a choice too.
    expect(projectForFolderPick(draft({ project: '', projectSource: 'user' }), '/repos/x', registry)).toBeNull();
  });

  it('the basename default DOES replace an AI guess and an earlier folder derivation', () => {
    expect(projectForFolderPick(draft({ project: 'AiGuess', projectSource: 'ai' }), '/repos/x', registry)).toBe('x');
    // Second folder pick re-derives: the previous 'folder' value follows the new folder.
    expect(projectForFolderPick(draft({ project: 'x', projectSource: 'folder' }), '/repos/y', registry)).toBe('y');
  });

  it('bound and fork drafts are never reseeded — their task already has a project', () => {
    expect(projectForFolderPick(draft({ taskId: 't1' }), '/repos/x', registry)).toBeNull();
    expect(projectForFolderPick(draft({ forkOf: { sessionId: 's1' } }), '/repos/x', registry)).toBeNull();
  });

  it("never derives a name the server's registry gate would reject", () => {
    // Leading '.' (hidden dirs), '..' runs, backslashes: each would 400 the
    // launch AFTER the draft is gone — better to leave the project alone.
    expect(projectForFolderPick(draft(), '/home/.claude', registry)).toBeNull();
    expect(projectForFolderPick(draft(), '/tags/v1..v2', registry)).toBeNull();
    expect(projectForFolderPick(draft(), '/weird/back\\slash', registry)).toBeNull();
  });

  it('no-ops on an empty cwd and the filesystem root', () => {
    expect(projectForFolderPick(draft(), '', registry)).toBeNull();
    expect(projectForFolderPick(draft(), '/', registry)).toBeNull();
  });
});

describe('restoreMetaAfterWalnut — leaving Ask Walnut undoes only what the mode wrote', () => {
  const base = { unread: false, pinTier: 'satellite' as const, priority: 'none' as const, model: 'opus' };

  it('reverts the seeded Focus tier to the stash; keeps a tier picked inside walnut mode', () => {
    const prev = { pinTier: 'satellite' as const };
    expect(restoreMetaAfterWalnut({ ...base, pinTier: 'focus' }, prev).pinTier).toBe('satellite');
    expect(restoreMetaAfterWalnut({ ...base, pinTier: 'backlog' }, prev).pinTier).toBe('backlog');
  });

  it('restores the stashed model when walnut left it on Auto (undefined or the explicit-Auto sentinel)', () => {
    const prev = { model: 'opus' };
    expect(restoreMetaAfterWalnut({ ...base, model: undefined }, prev).model).toBe('opus');
    expect(restoreMetaAfterWalnut({ ...base, model: 'default' }, prev).model).toBe('opus');
  });

  it("restores the stashed model when the row still carries the launch memory's SEED — never leaks it into a coding draft", () => {
    const prev = { model: 'opus', seededModel: 'sonnet' };
    expect(restoreMetaAfterWalnut({ ...base, model: 'sonnet' }, prev).model).toBe('opus');
    // The stash may hold Auto: the seed then reverts to Auto, not to itself.
    expect(restoreMetaAfterWalnut({ ...base, model: 'sonnet' }, { seededModel: 'sonnet' }).model).toBeUndefined();
  });

  it('keeps a model picked by hand inside walnut mode', () => {
    const prev = { model: 'opus', seededModel: 'sonnet' };
    expect(restoreMetaAfterWalnut({ ...base, model: 'haiku' }, prev).model).toBe('haiku');
  });

  it('is the identity without a stash (nothing was written)', () => {
    const meta = { ...base, pinTier: 'focus' as const, model: 'default' };
    expect(restoreMetaAfterWalnut(meta, undefined)).toBe(meta);
  });
});

describe('followProjectRegistryChange — a remembered project follows its delete/rename', () => {
  // A launcher column outlives the project it remembers (the tab lives for days).
  // Launching with a stale name used to RE-CREATE the project server-side
  // (2026-09-08); the server now refuses that write, and this keeps the pill from
  // promising a destination the task will not reach.
  it('a delete drops the remembered project (case-insensitively)', () => {
    expect(followProjectRegistryChange({ project: 'Fix Walnut', projectSource: 'user' }, { kind: 'deleted', name: 'fix walnut' }))
      .toEqual({ project: undefined, projectSource: undefined });
  });

  it('a delete of some OTHER project leaves the row alone', () => {
    expect(followProjectRegistryChange({ project: 'Walnut', projectSource: 'user' }, { kind: 'deleted', name: 'Fix Walnut' }))
      .toBeNull();
  });

  it('a rename moves the row to the new name and keeps its provenance', () => {
    expect(followProjectRegistryChange({ project: 'Fix Walnut', projectSource: 'ai' }, { kind: 'renamed', from: 'fix walnut', to: 'Walnut' }))
      .toEqual({ project: 'Walnut', projectSource: 'ai' });
  });

  it('a rename to an empty name is ignored (nothing to follow to)', () => {
    expect(followProjectRegistryChange({ project: 'Fix Walnut', projectSource: 'user' }, { kind: 'renamed', from: 'Fix Walnut', to: '   ' }))
      .toBeNull();
  });

  it('an empty draft has nothing to follow', () => {
    expect(followProjectRegistryChange({ project: '', projectSource: undefined }, { kind: 'deleted', name: 'Fix Walnut' }))
      .toBeNull();
  });

  it('a server-owned SEED project is never touched (it has no registry row to lose)', () => {
    expect(followProjectRegistryChange({ project: 'Ask Walnut', projectSource: 'seed' }, { kind: 'deleted', name: 'Ask Walnut' }))
      .toBeNull();
  });
});
