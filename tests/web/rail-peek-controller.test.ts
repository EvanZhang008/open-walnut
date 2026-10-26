import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RailPeekController, RAIL_PEEK_CLOSE_MS, RAIL_PEEK_OPEN_MS, RAIL_PEEK_OUT_MS,
  type RailPeekPhase,
} from '../../web/src/components/layout/rail-peek-controller';

// The collapsed rail's hover peek: intent delay, close grace, click snap, keyboard, holds.
const ON = { enabled: true, blocked: false, hold: false };

function make() {
  const events: Array<[RailPeekPhase, boolean, boolean]> = [];
  const ctl = new RailPeekController((phase, snap, sync) => { events.push([phase, snap, sync]); });
  ctl.setOptions(ON);
  return { ctl, events };
}

describe('RailPeekController', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens after the intent delay, and a pointer gone before it never opens', () => {
    const { ctl, events } = make();
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS - 1);
    expect(ctl.phase).toBe('closed');
    ctl.pointerLeave();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    expect(ctl.phase).toBe('open');
  });

  it('closes after the grace and the animation, and coming back inside the grace keeps it open', () => {
    const { ctl, events } = make();
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.pointerLeave();
    vi.advanceTimersByTime(RAIL_PEEK_CLOSE_MS - 1);
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(1000);
    expect(ctl.phase).toBe('open');
    ctl.pointerLeave();
    vi.advanceTimersByTime(RAIL_PEEK_CLOSE_MS);
    expect(ctl.phase).toBe('closing');
    vi.advanceTimersByTime(RAIL_PEEK_OUT_MS);
    expect(ctl.phase).toBe('closed');
    expect(events.map((e) => e[0])).toEqual(['open', 'closing', 'closed']);
  });

  it('back on the rail while it animates out: open again at once, no intent delay', () => {
    const { ctl } = make();
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.pointerLeave();
    vi.advanceTimersByTime(RAIL_PEEK_CLOSE_MS);
    expect(ctl.phase).toBe('closing');
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    expect(ctl.phase).toBe('open');
  });

  it('a second hide while closing keeps the timer that finishes it (no stuck closing)', () => {
    const { ctl } = make();
    ctl.keyboardFocus();
    ctl.focusLeft();
    vi.advanceTimersByTime(RAIL_PEEK_CLOSE_MS);
    expect(ctl.phase).toBe('closing');
    ctl.focusLeft();
    ctl.pointerLeave();
    vi.advanceTimersByTime(RAIL_PEEK_OUT_MS);
    expect(ctl.phase).toBe('closed');
  });

  it('a button held while moving in (a drag, a selection) does not open it', () => {
    const { ctl } = make();
    ctl.pointerEnter();
    ctl.pointerMove({}, 1);
    vi.advanceTimersByTime(1000);
    expect(ctl.phase).toBe('closed');
  });

  it('a click snaps it closed synchronously; it stays closed on that item and reopens on another', () => {
    const { ctl, events } = make();
    const notes = {}; const mail = {};
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.click(notes, false);
    expect(ctl.phase).toBe('closed');
    expect(events.at(-1)).toEqual(['closed', true, true]);
    ctl.pointerMove(notes, 0);
    ctl.pointerMove(null, 0);
    vi.advanceTimersByTime(1000);
    expect(ctl.phase).toBe('closed');
    ctl.pointerMove(mail, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    expect(ctl.phase).toBe('open');
  });

  it('a click inside the intent delay cancels the open', () => {
    const { ctl } = make();
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    ctl.click({}, false);
    vi.advanceTimersByTime(1000);
    expect(ctl.phase).toBe('closed');
  });

  it('the hamburger docks the peek as it stands, then undocking leaves it closed under the pointer', () => {
    const { ctl, events } = make();
    const pin = {};
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.click(pin, true);
    expect(ctl.phase).toBe('open');
    ctl.setOptions({ ...ON, enabled: false });
    expect(events.at(-1)).toEqual(['closed', true, false]);
    // Undock: the pointer still rests on the hamburger.
    ctl.click(pin, true);
    ctl.setOptions(ON);
    ctl.pointerMove(pin, 0);
    vi.advanceTimersByTime(1000);
    expect(ctl.phase).toBe('closed');
  });

  it('a panel beside the rail blocks the peek until it closes', () => {
    const { ctl } = make();
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.setOptions({ ...ON, blocked: true });
    expect(ctl.phase).toBe('closed');
    ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(1000);
    expect(ctl.phase).toBe('closed');
    ctl.setOptions(ON);
    ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    expect(ctl.phase).toBe('open');
  });

  it('a menu holds it open while the pointer is in the menu; closing the menu lets it go', () => {
    const { ctl } = make();
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.setOptions({ ...ON, hold: true });
    ctl.pointerLeave();
    vi.advanceTimersByTime(2000);
    expect(ctl.phase).toBe('open');
    ctl.syncHover(false);
    ctl.setOptions(ON);
    vi.advanceTimersByTime(RAIL_PEEK_CLOSE_MS + RAIL_PEEK_OUT_MS);
    expect(ctl.phase).toBe('closed');
  });

  it('a menu closing while the pointer is back on the rail keeps it open', () => {
    const { ctl } = make();
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    vi.advanceTimersByTime(RAIL_PEEK_OPEN_MS);
    ctl.setOptions({ ...ON, hold: true });
    ctl.syncHover(true);
    ctl.setOptions(ON);
    vi.advanceTimersByTime(2000);
    expect(ctl.phase).toBe('open');
  });

  it('keyboard: opens at once, survives the pointer leaving, Escape snaps it shut, focus leaving closes it', () => {
    const { ctl, events } = make();
    ctl.keyboardFocus();
    expect(ctl.phase).toBe('open');
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    ctl.pointerLeave();
    vi.advanceTimersByTime(1000);
    expect(ctl.phase).toBe('open');
    expect(ctl.escape()).toBe(true);
    expect(events.at(-1)).toEqual(['closed', true, true]);
    expect(ctl.escape()).toBe(false);
    ctl.keyboardFocus();
    expect(ctl.phase).toBe('open');
    ctl.focusLeft();
    vi.advanceTimersByTime(RAIL_PEEK_CLOSE_MS + RAIL_PEEK_OUT_MS);
    expect(ctl.phase).toBe('closed');
  });

  it('docked or on a phone it never opens', () => {
    const { ctl } = make();
    ctl.setOptions({ ...ON, enabled: false });
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    ctl.keyboardFocus();
    vi.advanceTimersByTime(1000);
    expect(ctl.phase).toBe('closed');
  });

  it('entering without moving (the page changed under a resting pointer) opens nothing', () => {
    const { ctl, events } = make();
    ctl.pointerEnter();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
  });

  it('dispose cancels a pending open', () => {
    const { ctl, events } = make();
    ctl.pointerEnter(); ctl.pointerMove({}, 0);
    ctl.dispose();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
  });
});
