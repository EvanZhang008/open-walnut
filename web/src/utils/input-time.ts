/**
 * When a person pressed a key or clicked, on the page's monotonic clock (performance.now()).
 *
 * An arm that ignores input for a moment after something appears (a prompt's keys, a card's
 * buttons) must judge the input by when it was pressed, not by when the page got to it: a page
 * busy drawing the new card handles a key or a click late, and that input is exactly the one
 * the arm is for. The event's own `timeStamp` is that time where the engine gives one on this
 * clock; a stamp that is missing or on another clock reads as now, never as a time that would
 * let an input through early. Ratchet: tests/web/input-arm-event-time-guard.test.ts.
 */
export function inputPressedAt(e: Pick<Event, 'timeStamp'>, now = performance.now()): number {
  const at = e.timeStamp;
  return Number.isFinite(at) && at > 0 && at <= now ? at : now;
}
