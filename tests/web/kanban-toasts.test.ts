/**
 * C65 (G7): the kanban toast queue. Newest on top, three in sight, older ones
 * folded into `+N more moves`, each toast its own buttons and 8s clock, every
 * clock paused while hovered.
 */
import { describe, expect, it } from 'vitest';
import {
  TOASTS_MAX, TOAST_TTL_MS, dismissToastItem, expiredToasts, foldToasts, nextDeadline, pauseClocks, pushToastItem,
  resumeClocks, syncClocks, type KanbanToastItem,
} from '../../web/src/components/board/kanban/kanban-toasts';

const toast = (id: string, ttlMs?: number): KanbanToastItem => ({
  id, text: `Moved to Resolved. The task is still open. (${id})`,
  actions: [{ label: 'Complete task', run: () => undefined }], ...(ttlMs ? { ttlMs } : {}),
});

describe('kanban toast queue', () => {
  it('puts the newest on top and replaces a toast pushed again under its id', () => {
    let list: KanbanToastItem[] = [];
    list = pushToastItem(list, toast('a'));
    list = pushToastItem(list, toast('b'));
    expect(list.map((t) => t.id)).toEqual(['b', 'a']);
    list = pushToastItem(list, { ...toast('a'), text: 'again' });
    expect(list.map((t) => t.id)).toEqual(['a', 'b']);
    expect(list[0].text).toBe('again');
  });

  it('keeps each toast its own buttons', () => {
    let done = '';
    let list = pushToastItem([], { id: 'a', text: 'A', actions: [{ label: 'Complete task', run: () => { done = 'a'; } }] });
    list = pushToastItem(list, { id: 'b', text: 'B', actions: [{ label: 'Complete task', run: () => { done = 'b'; } }] });
    list.find((t) => t.id === 'a')!.actions![0].run();
    expect(done).toBe('a');
    list.find((t) => t.id === 'b')!.actions![0].run();
    expect(done).toBe('b');
  });

  it('dismisses one and leaves the rest in order', () => {
    const list = ['a', 'b', 'c'].reduce<KanbanToastItem[]>((l, id) => pushToastItem(l, toast(id)), []);
    expect(dismissToastItem(list, 'b').map((t) => t.id)).toEqual(['c', 'a']);
    expect(dismissToastItem(list, 'zz')).toBe(list);
  });

  it('caps the queue, dropping the oldest', () => {
    let list: KanbanToastItem[] = [];
    for (let i = 0; i < TOASTS_MAX + 5; i++) list = pushToastItem(list, toast(`t${i}`));
    expect(list).toHaveLength(TOASTS_MAX);
    expect(list[0].id).toBe(`t${TOASTS_MAX + 4}`);
    expect(list.some((t) => t.id === 't0')).toBe(false);
  });

  it('shows three and folds the older ones into "+N more moves"', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].reduce<KanbanToastItem[]>((l, id) => pushToastItem(l, toast(id)), []);
    const folded = foldToasts(list, false);
    expect(folded.shown.map((t) => t.id)).toEqual(['e', 'd', 'c']);
    expect(folded.folded).toBe(2);
    expect(folded.foldText).toBe('+2 more moves');
    expect(foldToasts(list.slice(0, 4), false).foldText).toBe('+1 more move');
    const open = foldToasts(list, true);
    expect(open.shown).toHaveLength(5);
    expect(open.foldText).toBe('');
    expect(foldToasts(list.slice(0, 3), false).folded).toBe(0);
  });
});

describe('kanban toast clocks', () => {
  it('gives every toast its own 8s and expires each on its own time', () => {
    let clocks = syncClocks({}, [toast('a')], 1_000, false);
    clocks = syncClocks(clocks, [toast('b'), toast('a')], 5_000, false);
    expect(clocks.a.deadline).toBe(1_000 + TOAST_TTL_MS);
    expect(clocks.b.deadline).toBe(5_000 + TOAST_TTL_MS);
    expect(nextDeadline(clocks)).toBe(9_000);
    expect(expiredToasts(clocks, 9_000)).toEqual(['a']);
    expect(expiredToasts(clocks, 12_999)).toEqual(['a']);
    expect(expiredToasts(clocks, 13_000).sort()).toEqual(['a', 'b']);
  });

  it('honours a toast ttl and drops the clock of a gone toast', () => {
    let clocks = syncClocks({}, [toast('a', 2_000), toast('b')], 0, false);
    expect(clocks.a.deadline).toBe(2_000);
    clocks = syncClocks(clocks, [toast('b')], 1_000, false);
    expect(Object.keys(clocks)).toEqual(['b']);
  });

  it('pauses every clock while hovered and resumes with the time that was left', () => {
    let clocks = syncClocks({}, [toast('a'), toast('b')], 0, false);
    clocks = pauseClocks(clocks, 6_000);
    expect(nextDeadline(clocks)).toBeNull();
    expect(expiredToasts(clocks, 60_000)).toEqual([]);
    expect(clocks.a.remaining).toBe(2_000);
    // Pushed while hovered: starts paused with its full time.
    clocks = syncClocks(clocks, [toast('c'), toast('a'), toast('b')], 7_000, true);
    expect(clocks.c).toEqual({ remaining: TOAST_TTL_MS, deadline: null });
    clocks = resumeClocks(clocks, 30_000);
    expect(clocks.a.deadline).toBe(32_000);
    expect(clocks.c.deadline).toBe(30_000 + TOAST_TTL_MS);
    expect(expiredToasts(clocks, 31_999)).toEqual([]);
    expect(expiredToasts(clocks, 32_000).sort()).toEqual(['a', 'b']);
  });

  it('a double pause or resume changes nothing', () => {
    const c0 = syncClocks({}, [toast('a')], 0, false);
    const p = pauseClocks(pauseClocks(c0, 3_000), 5_000);
    expect(p.a.remaining).toBe(5_000);
    const r = resumeClocks(resumeClocks(p, 10_000), 12_000);
    expect(r.a.deadline).toBe(15_000);
  });
});
