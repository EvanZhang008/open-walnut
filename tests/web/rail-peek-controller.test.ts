import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RailPeekController, RAIL_PEEK_CLOSE_MS, RAIL_PEEK_OPEN_MS,
} from '../../web/src/components/layout/rail-peek-controller';

// The collapsed rail's item peek: only the hovered row grows out with its name.
const ON = { enabled: true, blocked: false, hold: false };
const notes = { id: 'notes' };
const mail = { id: 'mail' };
const settings = { id: 'settings' };

function make() {
  const events: Array<[object | null, boolean, boolean]> = [];
  const ctl = new RailPeekController((item, grow, sync) => { events.push([item, grow, sync]); });
  ctl.setOptions(ON);
  return { ctl, events };
}

describe('RailPeekController (one item at a time)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('the first pill waits the intent delay and grows; a pointer gone before it shows nothing', () => {
    const { ctl, events } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS - 1);
    expect(ctl.item).toBe(null);
    ctl.pointerLeave();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    expect(events).toEqual([[notes, true, false]]);
  });

  it('moving on while the first one waits restarts the wait for the new row', () => {
    const { ctl, events } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS - 10);
    ctl.pointerMove(mail, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    expect(events).toEqual([[mail, true, false]]);
  });

  it('once one is up, the next row takes it at once, without growing', () => {
    const { ctl, events } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.pointerMove(mail, 0);
    expect(ctl.item).toBe(mail);
    expect(events.at(-1)).toEqual([mail, false, false]);
    // Moving within the same row tells nothing new.
    ctl.pointerMove(mail, 0);
    expect(events).toHaveLength(2);
  });

  it('the gap between two rows does not flicker it off', () => {
    const { ctl, events } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.pointerMove(null, 0);
    vi.advanceTimersByTime(RAIL_PEEK_CLOSE_MS - 1);
    ctl.pointerMove(mail, 0);
    vi.advanceTimersByTime(1000);
    expect(events.map((e) => e[0])).toEqual([notes, mail]);
  });

  it('resting in a gap, or leaving the rail, hides it after the grace', () => {
    const { ctl } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.pointerMove(null, 0);
    vi.advanceTimersByTime(RAIL_PEEK_CLOSE_MS);
    expect(ctl.item).toBe(null);
    ctl.pointerMove(mail, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.pointerLeave();
    vi.advanceTimersByTime(RAIL_PEEK_CLOSE_MS - 1);
    expect(ctl.item).toBe(mail);
    vi.advanceTimersByTime(1);
    expect(ctl.item).toBe(null);
  });

  it('the pointer on the pill itself keeps it, also coming back inside the grace', () => {
    const { ctl } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.pointerMove(null, 0);
    ctl.pillHover();
    vi.advanceTimersByTime(1000);
    expect(ctl.item).toBe(notes);
  });

  it('a button held (a drag, a selection) shows nothing', () => {
    const { ctl } = make();
    ctl.pointerMove(notes, 1);
    vi.advanceTimersByTime(1000);
    expect(ctl.item).toBe(null);
  });

  it('a click hides it synchronously; that row stays quiet, another row opens one', () => {
    const { ctl, events } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.click(notes);
    expect(events.at(-1)).toEqual([null, false, true]);
    ctl.pointerMove(notes, 0);
    ctl.pointerMove(null, 0);
    vi.advanceTimersByTime(1000);
    expect(ctl.item).toBe(null);
    ctl.pointerMove(mail, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    expect(ctl.item).toBe(mail);
  });

  it('a click inside the intent delay cancels it', () => {
    const { ctl } = make();
    ctl.pointerMove(notes, 0);
    ctl.click(notes);
    vi.advanceTimersByTime(1000);
    expect(ctl.item).toBe(null);
  });

  it('a panel beside the rail blocks it until it closes', () => {
    const { ctl } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.setOptions({ ...ON, blocked: true });
    expect(ctl.item).toBe(null);
    ctl.pointerMove(mail, 0);
    vi.advanceTimersByTime(1000);
    expect(ctl.item).toBe(null);
    ctl.setOptions(ON);
    ctl.pointerMove(mail, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    expect(ctl.item).toBe(mail);
  });

  it('a menu holds it while the pointer is in the menu; closing the menu lets it go', () => {
    const { ctl } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.setOptions({ ...ON, hold: true });
    ctl.pointerLeave();
    vi.advanceTimersByTime(2000);
    expect(ctl.item).toBe(notes);
    ctl.syncHover(false);
    ctl.setOptions(ON);
    vi.advanceTimersByTime(RAIL_PEEK_CLOSE_MS);
    expect(ctl.item).toBe(null);
  });

  it('a menu closing while the pointer is back on the rail keeps it', () => {
    const { ctl } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.setOptions({ ...ON, hold: true });
    ctl.syncHover(true);
    ctl.setOptions(ON);
    vi.advanceTimersByTime(2000);
    expect(ctl.item).toBe(notes);
  });

  it('keyboard: the focused row opens at once and follows focus; Escape shuts it; focus leaving hides it', () => {
    const { ctl, events } = make();
    ctl.keyboardFocus(notes);
    expect(events.at(-1)).toEqual([notes, true, false]);
    ctl.keyboardFocus(mail);
    expect(events.at(-1)).toEqual([mail, false, false]);
    expect(ctl.escape()).toBe(true);
    expect(events.at(-1)).toEqual([null, false, true]);
    expect(ctl.escape()).toBe(false);
    ctl.keyboardFocus(settings);
    expect(ctl.item).toBe(settings);
    ctl.focusLeft();
    expect(ctl.item).toBe(null);
  });

  it('the pointer leaving goes back to the keyboard-focused row', () => {
    const { ctl } = make();
    ctl.keyboardFocus(notes);
    ctl.pointerMove(mail, 0);
    expect(ctl.item).toBe(mail);
    ctl.pointerLeave();
    expect(ctl.item).toBe(notes);
  });

  it('docked or on a phone it never opens; a scroll resets it', () => {
    const { ctl } = make();
    ctl.pointerMove(notes, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.reset();
    expect(ctl.item).toBe(null);
    ctl.setOptions({ ...ON, enabled: false });
    ctl.pointerMove(mail, 0);
    ctl.keyboardFocus(mail);
    vi.advanceTimersByTime(1000);
    expect(ctl.item).toBe(null);
  });

  it('a scroll keeps a keyboard pill on its row; the row going away drops it', () => {
    const { ctl } = make();
    ctl.keyboardFocus(notes);
    ctl.reset();
    expect(ctl.item).toBe(notes);
    ctl.drop();
    expect(ctl.item).toBe(null);
    // Its focus went with the row: the pointer leaving brings nothing back.
    ctl.pointerMove(mail, 0);
    ctl.pointerLeave();
    vi.advanceTimersByTime(1000);
    expect(ctl.item).toBe(null);
  });

  it('dispose cancels a pending open', () => {
    const { ctl, events } = make();
    ctl.pointerMove(notes, 0);
    ctl.dispose();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
  });
});
