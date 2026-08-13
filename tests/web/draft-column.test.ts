/**
 * The draft session column's pure logic: quick-access chip selection (R6) and the
 * AI-backfill ownership rules (R9).
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

const { applyDraftParse, clearAiFields, quickDirsFor } = await import(
  '@/components/sessions/draft-column'
);
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
    meta: { starred: true, unread: false, priority: 'none', pinTier: 'satellite', model: undefined, engine: undefined },
    ...over,
  };
}

const names = (dirs: WorkingDirEntry[]) => dirs.map((d) => d.cwd);

beforeEach(() => {
  peek.mockReset();
});

describe('quickDirsFor — chip selection (R6)', () => {
  it('takes the top 2 by ABSOLUTE count, then the 2 most recent of the rest', () => {
    // /fresh* are the newest but barely used; /heavy* are the workhorses. The
    // server's own frecency order would surface /fresh1 first, which is exactly
    // the churn this split removes.
    seedDirs([
      dir('/fresh1', 1, '2026-08-11T10:00:00Z'),
      dir('/heavy1', 90, '2026-01-01T00:00:00Z'),
      dir('/fresh2', 2, '2026-08-10T10:00:00Z'),
      dir('/heavy2', 50, '2026-02-01T00:00:00Z'),
      dir('/heavy3', 30, '2026-03-01T00:00:00Z'),
      dir('/old', 3, '2020-01-01T00:00:00Z'),
    ]);
    expect(names(quickDirsFor())).toEqual([
      '/heavy1', '/heavy2',              // by count
      '/fresh1', '/fresh2',              // by recency, excluding the two above
    ]);
  });

  it('never exceeds 4 chips', () => {
    seedDirs(Array.from({ length: 20 }, (_, i) => dir(`/d${i}`, 20 - i, `2026-08-${(i % 28) + 1}T00:00:00Z`)));
    expect(quickDirsFor()).toHaveLength(4);
  });

  it('returns fewer than 4 when the cache holds fewer dirs', () => {
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
    expect(out).toBe(d);   // same object = no re-render either
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

  it('fills tier/priority/star while metaTouched is false — WITHOUT setting it', () => {
    const out = applyDraftParse(draft(), { pinTier: 'focus', priority: 'important', starred: false }, noDefaults);
    expect(out.meta.pinTier).toBe('focus');
    expect(out.meta.priority).toBe('important');
    expect(out.meta.starred).toBe(false);
    // THE regression guard: metaTouched is also the per-directory launch-memory
    // switch, so an AI write must never latch it.
    expect(out.metaTouched).toBeUndefined();
    expect(out.aiFields?.has('pinTier')).toBe(true);
  });

  it('writes NO meta once the user has edited it', () => {
    const d = draft({ metaTouched: true });
    const out = applyDraftParse(d, { pinTier: 'focus', priority: 'important' }, noDefaults);
    expect(out).toBe(d);
    expect(out.meta.pinTier).toBe('satellite');
  });

  it('fills the date trio ("by Friday 3-5pm") while metaTouched is false', () => {
    const out = applyDraftParse(draft(), {
      due_date: '2026-08-14T17:00:00Z',
      start_date: '2026-08-14T15:00:00Z',
      end_date: '2026-08-14T17:00:00Z',
    }, noDefaults);
    expect(out.meta.dueDate).toBe('2026-08-14T17:00:00Z');
    expect(out.meta.startDate).toBe('2026-08-14T15:00:00Z');
    expect(out.meta.endDate).toBe('2026-08-14T17:00:00Z');
    expect(out.aiFields?.has('dueDate')).toBe(true);
    expect(out.aiFields?.has('startDate')).toBe(true);
    expect(out.aiFields?.has('endDate')).toBe(true);
    expect(out.metaTouched).toBeUndefined();
  });

  it('writes NO dates once the user has edited the meta', () => {
    const d = draft({ metaTouched: true });
    expect(applyDraftParse(d, { due_date: '2026-08-14T17:00:00Z' }, noDefaults)).toBe(d);
  });

  it('returns the SAME row when the parse says nothing new', () => {
    const d = draft({ project: 'Marina', projectSource: 'ai' });
    expect(applyDraftParse(d, { project: 'Marina', pinTier: 'satellite' }, noDefaults)).toBe(d);
  });

  it('returns the SAME row for an empty parse', () => {
    const d = draft();
    expect(applyDraftParse(d, {}, noDefaults)).toBe(d);
  });
});

describe('clearAiFields — a user edit drops the badge, not the authority', () => {
  it('removes only the named fields', () => {
    const d = draft({ aiFields: new Set(['project', 'cwd', 'pinTier'] as const) });
    const out = clearAiFields(d, ['project']);
    expect(out.aiFields?.has('project')).toBe(false);
    expect(out.aiFields?.has('cwd')).toBe(true);
    expect(out.aiFields?.has('pinTier')).toBe(true);
  });

  it('is a no-op (same object) when there is nothing to clear', () => {
    const d = draft({ aiFields: new Set(['cwd'] as const) });
    expect(clearAiFields(d, ['project'])).toBe(d);
    const bare = draft();
    expect(clearAiFields(bare, ['project'])).toBe(bare);
  });
});
