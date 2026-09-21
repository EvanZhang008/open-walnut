/**
 * The composer controls row's fit rule (web/src/components/chat/composer-controls-fit.ts).
 *
 * The row stopped wrapping on 2026-09-19: five pills in a narrow session column
 * stacked four rows high above the composer. What stays on the row and what moves
 * into the "..." menu is decided here, and the two properties that matter are
 * stability (the same width must always produce the same answer, or the row
 * flickers as the column resizes) and priority (the controls the user reaches for
 * are the last to leave).
 */
import { describe, it, expect } from 'vitest';
import { pickVisibleControls, ASSUMED_CONTROL_WIDTH, type ControlFitInput } from '../../web/src/components/chat/composer-controls-fit';

const OPTS = { gap: 4, overflowButtonWidth: 22 };

/** The real five, with the widths measured in Chromium at 11px. */
const FIVE: ControlFitInput[] = [
  { id: 'mode', priority: 1, width: 81 },
  { id: 'model', priority: 2, width: 120 },
  { id: 'output', priority: 3, width: 42 },
  { id: 'btw', priority: 4, width: 36 },
  { id: 'note', priority: 5, width: 42 },
];

describe('pickVisibleControls', () => {
  it('shows every control and no button when the whole row fits', () => {
    // 81+120+42+36+42 = 321 plus four gaps = 337.
    const r = pickVisibleControls(FIVE, 337, OPTS);
    expect(r.visible).toEqual(['mode', 'model', 'output', 'btw', 'note']);
    expect(r.overflow).toEqual([]);
  });

  it('does not let the button push a control out of a row that fits without it', () => {
    // 337 fits exactly; the button would need 26 more. The "everything fits"
    // branch is decided first, so it stays a five-pill row.
    expect(pickVisibleControls(FIVE, 337, OPTS).overflow).toEqual([]);
  });

  it('drops the lowest priority first, keeping the original order on the row', () => {
    // 320 = the four higher pills (279) + four slots of gap (16) + the button (22),
    // with nothing left for the note pill.
    const r = pickVisibleControls(FIVE, 320, OPTS);
    expect(r.overflow).toEqual(['note']);
    expect(r.visible).toEqual(['mode', 'model', 'output', 'btw']);
  });

  it('collapses to the mode pill and the button in the reported narrow column', () => {
    // A 1100px window with two session columns leaves the row about 130px.
    const r = pickVisibleControls(FIVE, 130, OPTS);
    expect(r.visible).toEqual(['mode']);
    expect(r.overflow).toEqual(['model', 'output', 'btw', 'note']);
  });

  it('keeps a narrow low-priority control that fits where a wide higher one does not', () => {
    // mode (81) + reply style (42) + two gaps (8) + button (22) = 153; adding the
    // model pill (120) instead would need 231. Filling must not stop at the first
    // control that misses.
    const r = pickVisibleControls(FIVE, 155, OPTS);
    expect(r.visible).toEqual(['mode', 'output']);
    expect(r.overflow).toEqual(['model', 'btw', 'note']);
  });

  it('keeps the top-priority control even when it cannot fit at all', () => {
    const r = pickVisibleControls(FIVE, 40, OPTS);
    expect(r.visible).toEqual(['mode']);
    expect(r.overflow).toEqual(['model', 'output', 'btw', 'note']);
  });

  it('prices an unmeasured control at the assumed width instead of zero', () => {
    const controls: ControlFitInput[] = [
      { id: 'mode', priority: 1, width: 81 },
      { id: 'fresh', priority: 2 },
    ];
    // 81 + assumed + one gap; a zero-width assumption would have claimed it fits.
    expect(pickVisibleControls(controls, 81 + ASSUMED_CONTROL_WIDTH + 4, OPTS).overflow).toEqual([]);
    expect(pickVisibleControls(controls, 100, OPTS).overflow).toEqual(['fresh']);
  });

  it('shows everything while the row has not been laid out yet', () => {
    // Zero available width is "unknown", not "no room": collapsing every control
    // for the frame between mount and the first measure is a visible flash.
    expect(pickVisibleControls(FIVE, 0, OPTS).overflow).toEqual([]);
  });

  it('is stable: re-deciding from its own answer changes nothing', () => {
    // The flicker this guards against: hiding a pill frees width, which makes it
    // fit again, which takes the width away. The rule reads natural widths only,
    // so feeding the result back must be a fixed point.
    for (const available of [90, 130, 180, 220, 260, 300, 337, 400]) {
      const first = pickVisibleControls(FIVE, available, OPTS);
      const again = pickVisibleControls(FIVE, available, OPTS);
      expect(again).toEqual(first);
    }
  });

  it('ignores controls the session does not render', () => {
    const three = FIVE.filter((c) => c.id !== 'btw' && c.id !== 'note');
    const r = pickVisibleControls(three, 130, OPTS);
    expect(r.visible).toEqual(['mode']);
    expect(r.overflow).toEqual(['model', 'output']);
  });

  it('honours a pinned control by priority, not by order', () => {
    // ComposerControlsBar pins a menu-clicked control by handing it priority 0,
    // because an anchored popover needs a visible anchor. It therefore outranks
    // the mode pill for as long as the pin lasts (released once all controls fit
    // again), and the row still fills its leftover with whatever else fits.
    const pinned = FIVE.map((c) => (c.id === 'btw' ? { ...c, priority: 0 } : c));
    const r = pickVisibleControls(pinned, 130, OPTS);
    expect(r.visible).toEqual(['output', 'btw']);
    expect(r.overflow).toEqual(['mode', 'model', 'note']);
  });
});
