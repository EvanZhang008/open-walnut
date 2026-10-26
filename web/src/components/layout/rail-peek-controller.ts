/**
 * The collapsed rail's peek, as a plain state machine (no React, no DOM): useRailPeek.ts
 * feeds it the rail's pointer, focus and click events, and renders the phase it reports.
 *
 * The timings follow the products that do this well (an icon rail that expands on
 * hover): a short hover-intent delay so a pointer crossing the rail on its way to the
 * window edge does not flash it open, a slightly longer close delay so a wobble out
 * and back does not flap it, and a short animation that reads as instant.
 *
 * A click inside closes it AT ONCE and synchronously (`snap`), because what the click
 * opens is placed against the narrow rail. It then stays closed until the pointer leaves
 * the rail or moves to another item. The hamburger is the exception: it pins the rail
 * open, so the peek simply becomes the docked sidebar.
 */

/** Hover intent: long enough to ignore a pointer passing through, short enough to feel instant. */
export const RAIL_PEEK_OPEN_MS = 80;
/** Grace after the pointer leaves before the rail starts to close. */
export const RAIL_PEEK_CLOSE_MS = 180;
/** The close animation; the CSS transition of `.rail-peek-out` has the same length. */
export const RAIL_PEEK_OUT_MS = 140;

export type RailPeekPhase = 'closed' | 'open' | 'closing';

export interface RailPeekOptions {
  /** The collapsed desktop rail: the only layout that peeks. */
  enabled: boolean;
  /** Something the rail opened sits beside it (a panel, a popover): the peek would cover it. */
  blocked: boolean;
  /** A menu the rail opened is up: keep the peek while the pointer is in that menu. */
  hold: boolean;
}

/**
 * `snap`: closed with no animation (the CSS drops the transition). `sync`: from a click or
 * Escape, so the narrow rail must be on screen before that event's own handlers run.
 */
export type RailPeekListener = (phase: RailPeekPhase, snap: boolean, sync: boolean) => void;

export interface RailPeekTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: RailPeekTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RailPeekController {
  private current: RailPeekPhase = 'closed';
  private timer: unknown = null;
  private hovering = false;
  // Keyboard focus is inside: the peek stays while it is.
  private keyboard = false;
  // A click closed the peek: the item it was on, or true for "anywhere" (Escape).
  private dismissed: object | true | null = null;
  private opts: RailPeekOptions = { enabled: false, blocked: false, hold: false };

  constructor(private readonly listener: RailPeekListener, private readonly timers: RailPeekTimers = realTimers) {}

  get phase(): RailPeekPhase { return this.current; }

  setOptions(next: RailPeekOptions): void {
    const prev = this.opts;
    this.opts = next;
    // Docked, phone, or a panel beside the rail: no peek, and no animation out of one.
    if (!next.enabled || next.blocked) {
      this.clearTimer();
      if (!next.enabled) { this.keyboard = false; this.dismissed = null; }
      if (this.current !== 'closed') this.emit('closed', true, false);
      return;
    }
    // The menu closed: the peek goes unless the pointer or keyboard focus is still in the rail.
    if (prev.hold && !next.hold && !this.wanted()) this.hide(false);
  }

  /** The DOM's own answer (`:hover`) after something the rail's events cannot see, like a menu vanishing under the pointer. */
  syncHover(hovering: boolean): void { this.hovering = hovering; }

  /**
   * Entering alone opens nothing: a page that loads or reflows under a resting pointer
   * makes the browser report the pointer "over" the rail without anyone moving it, and a
   * rail that opened then covered what the person was about to click. `pointerMove` opens.
   */
  pointerEnter(): void {
    this.hovering = true;
    this.dismissed = null;
    // Back inside before it finished closing: stay open.
    if (this.current !== 'closed') this.show(false);
  }

  pointerLeave(): void {
    this.hovering = false;
    this.dismissed = null;
    if (this.keyboard || this.opts.hold) { this.clearTimer(); return; }
    this.hide(false);
  }

  /**
   * The pointer really moved over the rail (`item`: the row under it). Also how a new look
   * starts after a click (on another item) or once a blocking panel has closed.
   */
  pointerMove(item: object | null, buttons: number): void {
    this.hovering = true;
    // A drag or a text selection sweeping across the rail is not a look at it.
    if (buttons !== 0) return;
    if (this.dismissed !== null) {
      if (this.dismissed === true || item === null || item === this.dismissed) return;
      this.dismissed = null;
    }
    // Open: moving inside cancels a pending close. Closed: starts the intent delay once.
    if (this.current !== 'closed' || this.timer === null) this.show(false);
  }

  /** Focus arrived by Tab: open at once, and stay while focus is inside. */
  keyboardFocus(): void {
    this.keyboard = true;
    this.dismissed = null;
    this.show(true);
  }

  focusLeft(): void {
    this.keyboard = false;
    if (!this.wanted() && !this.opts.hold) this.hide(false);
  }

  /** Escape: closes at once and stays closed until the pointer comes back or focus moves on. */
  escape(): boolean {
    if (this.current === 'closed') return false;
    this.keyboard = false;
    this.dismissed = true;
    this.hide(true);
    return true;
  }

  /** A click anywhere in the rail (also before the peek has opened: it cancels the intent delay). */
  click(item: object | null, pin: boolean): void {
    this.dismissed = item ?? true;
    this.keyboard = false;
    // The hamburger docks the peek as it stands (no snap to narrow first); un-docking
    // from it leaves the narrow rail closed under the resting pointer.
    if (pin) { this.clearTimer(); return; }
    this.hide(true);
  }

  dispose(): void { this.clearTimer(); }

  private wanted(): boolean {
    return this.keyboard || (this.hovering && this.dismissed === null);
  }

  private show(now: boolean): void {
    if (!this.opts.enabled || this.opts.blocked) return;
    this.clearTimer();
    // Already open: nothing to tell (no re-render per pointer move).
    if (this.current === 'open') return;
    // On its way out: back to open with no delay.
    if (now || this.current === 'closing') { this.emit('open'); return; }
    this.timer = this.timers.set(() => { this.timer = null; this.emit('open'); }, RAIL_PEEK_OPEN_MS);
  }

  private hide(snap: boolean): void {
    if (this.current === 'closed') { this.clearTimer(); return; }
    if (snap) { this.clearTimer(); this.emit('closed', true, true); return; }
    // Already on its way out: keep the timer that finishes it.
    if (this.current === 'closing') return;
    this.clearTimer();
    this.timer = this.timers.set(() => {
      this.emit('closing');
      this.timer = this.timers.set(() => { this.timer = null; this.emit('closed'); }, RAIL_PEEK_OUT_MS);
    }, RAIL_PEEK_CLOSE_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
  }

  private emit(phase: RailPeekPhase, snap = false, sync = false): void {
    this.current = phase;
    this.listener(phase, snap, sync);
  }
}
