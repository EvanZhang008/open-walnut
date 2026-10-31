/**
 * The Org page's side strip (web/src/components/org/org-side-columns.ts): one free panel
 * (what `?open=` names) beside the panels the user locked.
 */
import { describe, it, expect } from 'vitest';
import {
  orgStripDedupe, orgStripOnOpen, orgStripToggleLock, orgStripView,
} from '../../web/src/components/org/org-side-columns';

const s = (id: string, locked = false) => ({ id, locked });

describe('org side strip', () => {
  it('opening another task replaces the free panel', () => {
    let cols = orgStripOnOpen([], null, 'task:a');
    expect(cols).toEqual([s('task:a')]);
    cols = orgStripOnOpen(cols, 'task:a', 'task:b');
    expect(cols).toEqual([s('task:b')]);
  });

  it('a locked panel stays and the next one opens next to it', () => {
    let cols = orgStripOnOpen([], null, 'task:a');
    cols = orgStripToggleLock(cols, 'task:a');
    cols = orgStripOnOpen(cols, 'task:a', 'task:b');
    expect(cols).toEqual([s('task:b'), s('task:a', true)]);
    cols = orgStripOnOpen(cols, 'task:b', 'session:c');
    expect(cols).toEqual([s('session:c'), s('task:a', true)]);
  });

  it('two pins: the newer pin sits left of the first, the free panel leftmost', () => {
    let cols = orgStripOnOpen([], null, 'task:a');
    cols = orgStripToggleLock(cols, 'task:a');
    cols = orgStripOnOpen(cols, 'task:a', 'task:b');
    cols = orgStripToggleLock(cols, 'task:b');
    cols = orgStripOnOpen(cols, 'task:b', 'task:c');
    expect(cols).toEqual([s('task:c'), s('task:b', true), s('task:a', true)]);
  });

  it('closing the free panel (open gone) keeps the pins; a pin named by open is not closed', () => {
    const cols = [s('task:b'), s('task:a', true)];
    expect(orgStripOnOpen(cols, 'task:b', null)).toEqual([s('task:a', true)]);
    expect(orgStripOnOpen(cols, 'task:a', null)).toEqual(cols);
  });

  it('opening a pinned task does not duplicate it', () => {
    const cols = [s('task:b'), s('task:a', true)];
    expect(orgStripOnOpen(cols, 'task:b', 'task:a')).toEqual([s('task:a', true)]);
  });

  const same = (a: string, b: string) => a !== b && [a, b].sort().join() === ['session:sa', 'task:a'].sort().join();
  it('a task and its session are one panel; a pin keeps the id it was pinned under', () => {
    expect(orgStripOnOpen([s('task:a', true)], null, 'session:sa', same)).toEqual([s('task:a', true)]);
    expect(orgStripOnOpen([s('task:a')], 'task:a', 'session:sa', same)).toEqual([s('session:sa')]);
    // Closing what the URL named never closes the pin that shows it.
    expect(orgStripOnOpen([s('task:a', true)], 'session:sa', null, same)).toEqual([s('task:a', true)]);
  });

  it('once the tasks are known, a task panel and its session panel merge into one', () => {
    const cols = [s('task:a'), s('session:sa', true)];
    expect(orgStripDedupe(cols, same, 'task:a')).toEqual([s('task:a', true)]);
    expect(orgStripDedupe(cols, same, null)).toEqual([s('task:a', true)]);
    const apart = [s('task:b'), s('session:sa', true)];
    expect(orgStripDedupe(apart, same, null)).toBe(apart);
  });

  it('the shown strip is the URL\'s panel beside the pins, whatever the URL did before', () => {
    const pins = [s('task:a', true)];
    expect(orgStripView(pins, 'task:b')).toEqual([s('task:b'), s('task:a', true)]);
    // The URL naming the pin shows the pins alone: no stale free panel beside it.
    expect(orgStripView(pins, 'task:a')).toEqual([s('task:a', true)]);
    // Picking another node clears the URL: the pins stay.
    expect(orgStripView(pins, null)).toEqual([s('task:a', true)]);
    // Only pins count as state; an unlocked saved slot (an older build's free panel) is not shown.
    expect(orgStripView([s('task:z'), s('task:a', true)], null)).toEqual([s('task:a', true)]);
  });

  it('the shown strip has one panel per session', () => {
    const same = (x: string, y: string) => [x, y].every((v) => v === 'task:a' || v === 'session:sa');
    expect(orgStripView([s('task:a', true), s('session:sa', true)], null, same)).toEqual([s('task:a', true)]);
    expect(orgStripView([s('task:a', true)], 'session:sa', same)).toEqual([s('task:a', true)]);
  });
});
