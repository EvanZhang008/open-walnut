/**
 * The collapsed rail's item peek, as a plain state machine (no React, no DOM): hovering
 * one icon grows THAT item out over the page with its name (a pill), and only that one;
 * moving to the next icon moves the pill there at once. useRailPeek.ts feeds it the
 * rail's pointer, focus and click events and renders the item it reports.
 *
 * Items are opaque objects (the rail's row elements in the app). Timing:
 * - the first pill waits a short hover intent, so a pointer crossing the rail on its way
 *   to the window edge does not flash one; once a pill is up, the next item takes it at
 *   once (no delay, no grow animation);
 * - the gap between two rows and the way out get a short grace, so moving down the list
 *   never flickers the pill off and on.
 * A click closes it at once and synchronously (what the click opens is placed against
 * the narrow rail), and that item stays quiet until the pointer moves to another one.
 */

/** Hover intent before the first pill: long enough to ignore a pointer passing through. */
export const RAIL_PEEK_OPEN_MS = 60;
/** Grace over the gap between two rows, or after the pointer leaves the rail. */
export const RAIL_PEEK_CLOSE_MS = 120;

export interface RailPeekOptions {
  /** The collapsed desktop rail: the only layout that peeks. */
  enabled: boolean;
  /** Something the rail opened sits beside it (a panel, a popover): a pill would cover it. */
  blocked: boolean;
  /** A menu the rail opened is up: keep the pill while the pointer is in that menu. */
  hold: boolean;
}

/**
 * `item`: the row to show, or null to hide. `grow`: the first pill animates out from its
 * icon; a move to the next row does not. `sync`: from a click or Escape, so the pill is
 * gone before that event's own handlers run.
 */
export type RailPeekListener = (item: object | null, grow: boolean, sync: boolean) => void;

export interface RailPeekTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: RailPeekTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RailPeekController {
  private shown: object | null = null;
  private timer: unknown = null;
  // The row a pending open is for.
  private pending: object | null = null;
  private hovering = false;
  // The row keyboard focus is on: its pill stays while focus does.
  private focused: object | null = null;
  // A click closed the pill: the row it was on, or true for "anywhere" (Escape).
  private dismissed: object | true | null = null;
  private opts: RailPeekOptions = { enabled: false, blocked: false, hold: false };

  constructor(private readonly listener: RailPeekListener, private readonly timers: RailPeekTimers = realTimers) {}

  get item(): object | null { return this.shown; }

  setOptions(next: RailPeekOptions): void {
    const prev = this.opts;
    this.opts = next;
    // Docked, phone, or a panel beside the rail: no pill.
    if (!next.enabled || next.blocked) {
      this.clearTimer();
      if (!next.enabled) { this.focused = null; this.dismissed = null; }
      this.hide(false);
      return;
    }
    // The menu closed: the pill goes unless the pointer or keyboard focus is still on the rail.
    if (prev.hold && !next.hold && !this.hovering && this.focused === null) this.hideSoon();
  }

  /** The DOM's own answer (`:hover`) after something the rail's events cannot see, like a menu vanishing under the pointer. */
  syncHover(hovering: boolean): void { this.hovering = hovering; }

  /**
   * The pointer really moved over the rail; `item` is the row under it, null for a gap.
   * (Entering alone shows nothing: a page that reflows under a resting pointer makes the
   * browser report it "over" a row without anyone moving it.)
   */
  pointerMove(item: object | null, buttons: number): void {
    this.hovering = true;
    // A drag or a text selection sweeping across the rail is not a look at it.
    if (buttons !== 0) return;
    if (this.dismissed !== null) {
      if (this.dismissed === true || item === null || item === this.dismissed) return;
      this.dismissed = null;
    }
    if (item === null) { if (this.shown !== null) this.hideSoon(); return; }
    if (this.shown !== null) {
      // Up already: the next row takes it at once.
      this.clearTimer();
      if (item !== this.shown) this.show(item, false);
      return;
    }
    if (this.pending === item && this.timer !== null) return;
    this.clearTimer();
    this.pending = item;
    this.timer = this.timers.set(() => { this.timer = null; this.pending = null; this.show(item, true); }, RAIL_PEEK_OPEN_MS);
  }

  /** The pointer is on the pill itself (it covers its row): keep it. */
  pillHover(): void {
    this.hovering = true;
    this.clearTimer();
  }

  pointerLeave(): void {
    this.hovering = false;
    this.dismissed = null;
    if (this.opts.hold) { this.clearTimer(); return; }
    if (this.focused !== null) {
      // Back to the row keyboard focus is on.
      this.clearTimer();
      if (this.shown !== this.focused) this.show(this.focused, false);
      return;
    }
    if (this.shown !== null) this.hideSoon();
    else this.clearTimer();
  }

  /** Focus arrived on a row from the keyboard: its pill, at once. */
  keyboardFocus(item: object): void {
    this.focused = item;
    this.dismissed = null;
    this.clearTimer();
    if (this.shown !== item) this.show(item, this.shown === null);
  }

  /** Keyboard focus left the rail. */
  focusLeft(): void {
    this.focused = null;
    if (!this.hovering && !this.opts.hold) this.hide(false);
  }

  /** Escape: closes at once and stays closed until the pointer comes back or focus moves on. */
  escape(): boolean {
    if (this.shown === null) return false;
    this.focused = null;
    this.dismissed = true;
    this.hide(true);
    return true;
  }

  /** A click on a row or its pill (also before the pill opened: it cancels the intent delay). */
  click(item: object | null): void {
    this.dismissed = item ?? true;
    this.focused = null;
    this.hide(true);
  }

  /**
   * The rows moved under the pointer (a scroll, a resize): a pointer's pill goes, the next
   * move brings it back. A keyboard pill stays: it follows its row.
   */
  reset(): void {
    if (this.focused !== null && this.shown === this.focused) return;
    this.hide(false);
  }

  /** The row went away (it unmounted): its pill goes, whoever opened it. */
  drop(): void {
    if (this.focused === this.shown) this.focused = null;
    this.hide(false);
  }

  dispose(): void { this.clearTimer(); }

  private show(item: object, grow: boolean): void {
    if (!this.opts.enabled || this.opts.blocked) return;
    this.shown = item;
    this.listener(item, grow, false);
  }

  private hideSoon(): void {
    if (this.timer !== null && this.pending === null) return;
    this.clearTimer();
    this.timer = this.timers.set(() => { this.timer = null; this.hide(false); }, RAIL_PEEK_CLOSE_MS);
  }

  private hide(sync: boolean): void {
    this.clearTimer();
    if (this.shown === null) return;
    this.shown = null;
    this.listener(null, false, sync);
  }

  private clearTimer(): void {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    this.pending = null;
  }
}
