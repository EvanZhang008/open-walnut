/**
 * The one fold rule of the task panel's status folds (web/src/components/tasks/section-fold-rule.ts):
 * Watching and Needs you start folded, then follow the user's choice; Working, Waiting / snoozed,
 * Completed and every per-project fold folded by default and folded again 15 minutes after
 * they were opened; since 2026-11-06 that time is 60 s after the last action in their panel.
 */
import { describe, expect, it } from 'vitest';
import {
  FOLD_AUTO_CLOSE_MS,
  STATUS_SECTION_FOLD,
  foldBusy,
  foldIsDue,
  foldIsOpen,
  mergeFoldChanges,
  initialFoldStore,
  nextAutoClose,
  parseFoldStore,
  projectFoldKind,
  pruneFolds,
  serializeFoldStore,
  setFold,
  statusSectionFoldKind as kind,
  statusSectionsOpen,
} from '../../web/src/components/tasks/section-fold-rule';

const T0 = Date.parse('2026-11-04T05:00:00Z');

describe('the fold rule', () => {
  it('first visit: every section starts folded', () => {
    expect(statusSectionsOpen({})).toEqual({ watching: false, needs: false, working: false, waiting: false, notstarted: false, background: false, done: false });
    expect(STATUS_SECTION_FOLD).toEqual({ watching: 'sticky', needs: 'sticky', working: 'auto', waiting: 'auto', notstarted: 'auto', background: 'auto', done: 'auto' });
  });

  it('preserves old implicit open choices and records fresh folded defaults explicitly', () => {
    expect(statusSectionsOpen(initialFoldStore('{}', kind))).toEqual({ watching: true, needs: true, working: false, waiting: false, notstarted: false, background: false, done: false });
    expect(initialFoldStore('{"needs":false,"waiting":123}', kind)).toEqual({ needs: false, watching: true, waiting: 123 });
    expect(initialFoldStore(null, kind)).toEqual({ watching: false, needs: false });
    expect(initialFoldStore(null, kind, true)).toEqual({ watching: true, needs: true });
    expect(initialFoldStore('{"needs":false}', kind, true)).toEqual({ watching: true, needs: false });
    expect(initialFoldStore('{bad', kind)).toEqual({ watching: false, needs: false });
    const fresh = initialFoldStore(null, kind);
    expect(initialFoldStore(serializeFoldStore(fresh), kind)).toEqual(fresh);
    expect(initialFoldStore('{}', projectFoldKind)).toEqual({});
  });

  it('a sticky fold keeps the user choice with no clock', () => {
    let s = setFold({}, 'needs', true, kind, T0);
    expect(s).toEqual({ needs: true });
    expect(nextAutoClose(s, kind)).toBeNull();
    expect(pruneFolds(s, kind, T0 + 30 * 24 * 3600_000)).toEqual({ needs: true });
    s = setFold(s, 'needs', false, kind, T0);
    expect(s).toEqual({ needs: false });
    expect(foldIsOpen(s, 'needs', kind)).toBe(false);
  });

  it('an auto fold opened holds its opening time and is due 60 s later', () => {
    const s = setFold({}, 'waiting', true, kind, T0);
    expect(s).toEqual({ waiting: T0 });
    expect(foldIsOpen(s, 'waiting', kind)).toBe(true);
    expect(nextAutoClose(s, kind)).toBe(T0 + FOLD_AUTO_CLOSE_MS);
    expect(FOLD_AUTO_CLOSE_MS).toBe(60_000);
    expect(foldIsDue(s, 'waiting', kind, T0 + FOLD_AUTO_CLOSE_MS - 1)).toBe(false);
    expect(foldIsDue(s, 'waiting', kind, T0 + FOLD_AUTO_CLOSE_MS)).toBe(true);
    // Due is not folded: only the page's timer (or a load) folds it, so a render never does.
    expect(foldIsOpen(s, 'waiting', kind)).toBe(true);
    expect(setFold(s, 'waiting', false, kind, T0)).toEqual({});
  });

  it('a load folds what ran out while the page was away, and keeps the rest', () => {
    const s = { working: T0, done: T0 - FOLD_AUTO_CLOSE_MS - 1, needs: false } as const;
    expect(pruneFolds(s, kind, T0 + 1)).toEqual({ working: T0, needs: false });
    expect(pruneFolds({ working: T0 }, kind, T0 + 1)).toEqual({ working: T0 });
  });

  it('an older build value reads safely: a boolean on an auto fold is folded, a number on a sticky one is the default', () => {
    const s = parseFoldStore('{"waiting":true,"working":false,"needs":12,"watching":false}');
    expect(statusSectionsOpen(s)).toEqual({ watching: false, needs: false, working: false, waiting: false, notstarted: false, background: false, done: false });
    expect(pruneFolds(s, kind, T0)).toEqual({ watching: false });
  });

  it('a corrupt or foreign value reads as the defaults', () => {
    for (const raw of [null, '', '{not json', '[1,2]', '"x"', '{"done":"yes"}']) {
      expect(statusSectionsOpen(parseFoldStore(raw))).toEqual(statusSectionsOpen({}));
    }
    expect(serializeFoldStore({})).toBeNull();
    expect(parseFoldStore(serializeFoldStore({ done: T0, needs: false }))).toEqual({ done: T0, needs: false });
  });

  it('per-project folds are all auto', () => {
    const key = 'list\u0000Garden\u0000done';
    const s = setFold({}, key, true, projectFoldKind, T0);
    expect(nextAutoClose(s, projectFoldKind)).toBe(T0 + FOLD_AUTO_CLOSE_MS);
    expect(pruneFolds(s, projectFoldKind, T0 + FOLD_AUTO_CLOSE_MS)).toEqual({});
  });

  it('an opening time ahead of this clock counts from now', () => {
    expect(pruneFolds({ waiting: T0 + 3600_000 }, kind, T0)).toEqual({ waiting: T0 });
  });

  it('a write lays only its own changed folds over what storage holds now', () => {
    const storage = { done: T0, needs: false, waiting: T0 - 1000 };
    // This tab folded Waiting by its clock and knew nothing of the other tab's Completed and Needs you.
    expect(mergeFoldChanges(storage, { waiting: undefined })).toEqual({ done: T0, needs: false });
    expect(mergeFoldChanges({}, { working: T0 })).toEqual({ working: T0 });
  });

  it('the soonest due fold wakes the page first', () => {
    const s = { working: T0 + 5000, done: T0, needs: false };
    expect(nextAutoClose(s, kind)).toBe(T0 + FOLD_AUTO_CLOSE_MS);
  });
});

describe('foldBusy', () => {
  interface FakeFold { key: string; hover?: boolean; contains?: boolean; menu?: boolean; openTask?: boolean; top?: number }
  const fakeDoc = (els: FakeFold[], active: { editing: boolean; keyboard?: boolean } | null = null): Document => ({
    body: {},
    activeElement: active && { matches: (sel: string) => (sel === ':focus-visible' ? !!active.keyboard : active.editing) },
    querySelectorAll: () => els.map((e) => ({
      getAttribute: () => e.key,
      matches: () => !!e.hover,
      contains: () => !!e.contains,
      querySelector: (sel: string) => ((sel.includes('menu') ? e.menu : e.openTask) ? {} : null),
    })),
  }) as unknown as Document;

  it('typing inside it, or a menu open from one of its rows, holds it', () => {
    expect(foldBusy(fakeDoc([{ key: 'waiting', contains: true }], { editing: true }), 'waiting')).toBe(true);
    expect(foldBusy(fakeDoc([{ key: 'waiting', menu: true }]), 'waiting')).toBe(true);
    expect(foldBusy(fakeDoc([{ key: 'done', menu: true }]), 'waiting')).toBe(false);
    expect(foldBusy(fakeDoc([]), 'waiting')).toBe(false);
  });

  it('no action holds it: the pointer resting on it, a focus a click left, its row the task open (2026-11-06)', () => {
    expect(foldBusy(fakeDoc([{ key: 'done', hover: true }]), 'done')).toBe(false);
    expect(foldBusy(fakeDoc([{ key: 'done', contains: true }], { editing: false, keyboard: true }), 'done')).toBe(false);
    expect(foldBusy(fakeDoc([{ key: 'done', openTask: true }]), 'done')).toBe(false);
    expect(foldBusy(fakeDoc([{ key: 'done', hover: true, contains: true, openTask: true }], { editing: false }), 'done')).toBe(false);
  });
});
