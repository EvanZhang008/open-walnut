/**
 * The one fold rule of the task panel's status folds (web/src/components/tasks/section-fold-rule.ts):
 * Watching and Needs you open first, then the user's choice; Working, Waiting / snoozed,
 * Completed and every per-project fold folded by default and folded again 15 minutes after
 * they were opened.
 */
import { describe, expect, it } from 'vitest';
import {
  FOLD_AUTO_CLOSE_MS,
  STATUS_SECTION_FOLD,
  foldBusy,
  foldIsDue,
  foldIsOpen,
  mergeFoldChanges,
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
  it('first visit: Watching and Needs you open, everything else folded', () => {
    expect(statusSectionsOpen({})).toEqual({ watching: true, needs: true, working: false, waiting: false, done: false });
    expect(STATUS_SECTION_FOLD).toEqual({ watching: 'sticky', needs: 'sticky', working: 'auto', waiting: 'auto', done: 'auto' });
  });

  it('a sticky fold keeps the user choice with no clock', () => {
    let s = setFold({}, 'needs', false, kind, T0);
    expect(s).toEqual({ needs: false });
    expect(nextAutoClose(s, kind)).toBeNull();
    expect(pruneFolds(s, kind, T0 + 30 * 24 * 3600_000)).toEqual({ needs: false });
    s = setFold(s, 'needs', true, kind, T0);
    expect(s).toEqual({});
    expect(foldIsOpen(s, 'needs', kind)).toBe(true);
  });

  it('an auto fold opened holds its opening time and is due 15 minutes later', () => {
    const s = setFold({}, 'waiting', true, kind, T0);
    expect(s).toEqual({ waiting: T0 });
    expect(foldIsOpen(s, 'waiting', kind)).toBe(true);
    expect(nextAutoClose(s, kind)).toBe(T0 + FOLD_AUTO_CLOSE_MS);
    expect(FOLD_AUTO_CLOSE_MS).toBe(15 * 60_000);
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
    expect(statusSectionsOpen(s)).toEqual({ watching: false, needs: true, working: false, waiting: false, done: false });
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
  interface FakeFold { key: string; hover: boolean; contains?: boolean; menu?: boolean; openTask?: boolean; top?: number }
  const fakeDoc = (els: FakeFold[], active: { editing: boolean; keyboard?: boolean; toggle?: boolean } | null = null) => ({
    body: {},
    defaultView: { innerWidth: 1280, innerHeight: 800 },
    activeElement: active && {
      matches: (sel: string) => (sel === ':focus-visible' ? !!active.keyboard : active.editing),
      hasAttribute: (name: string) => name === 'aria-expanded' && !!active.toggle,
    },
    querySelectorAll: () => els.map((e) => ({
      getAttribute: () => e.key,
      matches: () => e.hover,
      contains: () => !!e.contains,
      querySelector: (sel: string) => ((sel.includes('menu') ? e.menu : e.openTask) ? {} : null),
      getBoundingClientRect: () => ({ top: e.top ?? 100, bottom: (e.top ?? 100) + 200, left: 0, right: 400, height: 200 }),
    })),
  }) as unknown as Document;

  it('the pointer over the fold, or typing inside it, keeps it open; a focused toggle does not', () => {
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: true }]), 'waiting')).toBe(true);
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, contains: true }], { editing: true }), 'waiting')).toBe(true);
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, contains: true }], { editing: false }), 'waiting')).toBe(false);
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false }]), 'waiting')).toBe(false);
    expect(foldBusy(fakeDoc([{ key: 'done', hover: true }]), 'waiting')).toBe(false);
    expect(foldBusy(fakeDoc([]), 'waiting')).toBe(false);
  });

  it('a keyboard focus on one of its rows keeps it open (moved there, or while they work); on its own toggle it does not', () => {
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, contains: true, top: 2000 }], { editing: false, keyboard: true }), 'waiting', () => true)).toBe(true);
    // Moved there with the keyboard: it holds with no work in the panel since.
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, contains: true, top: 2000 }], { editing: false, keyboard: true }), 'waiting', () => false, () => true)).toBe(true);
    // Put back by a closing menu, left alone: the focus no longer holds it.
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, contains: true }], { editing: false, keyboard: true }), 'waiting')).toBe(false);
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, contains: true, top: 2000 }], { editing: false, keyboard: true, toggle: true }), 'waiting', () => true)).toBe(false);
  });

  it('the task the user has open, among its rows, keeps it open', () => {
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, openTask: true, top: 2000 }]), 'waiting')).toBe(true);
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, openTask: false, top: 2000 }]), 'waiting')).toBe(false);
  });

  it('a menu open from one of its rows keeps it open', () => {
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, menu: true }]), 'waiting')).toBe(true);
  });

  it('on screen while the user reads around it keeps it open; off screen or away it folds', () => {
    const reading = () => true;
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false }]), 'waiting', reading)).toBe(true);
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, top: 2000 }]), 'waiting', reading)).toBe(false);
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false, top: -500 }]), 'waiting', reading)).toBe(false);
    expect(foldBusy(fakeDoc([{ key: 'waiting', hover: false }]), 'waiting', () => false)).toBe(false);
  });
});
