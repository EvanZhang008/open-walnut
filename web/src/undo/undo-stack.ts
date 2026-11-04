/**
 * The app's one undo stack for list-level task actions (complete, reopen, snooze, pin,
 * delete, a column closed by its completion). Each action pushes one entry that lives
 * UNDO_WINDOW_MS; the newest live entry is what mod+z (and its toast's Undo) takes back.
 *
 * An entry may carry a `commit`: the part of the action that is held back until the
 * window ends (a delete is a hard delete on the server, so the row is only hidden while
 * it can still be undone, and the DELETE goes out when the window closes). A commit runs
 * exactly once: at expiry, when the page goes (`commitAll`, the request then leaves with
 * keepalive), or never, when the entry is undone.
 *
 * Pure module (timers injectable) so the ordering rules are unit tested
 * (tests/web/undo-stack.test.ts); TaskUndoContext.tsx wires it to the stores and toasts.
 */

export const UNDO_WINDOW_MS = 5000;
/** How long, all told, an entry's clock may stand still while its toast is out of sight (the
 *  server holds a delete only so long past its window). */
export const MAX_PAUSED_MS = 10_000;

export interface UndoEntryInput {
  /** Stable per action target, e.g. `pin:<taskId>`. A second action on the same target
   *  stacks on the first: each Undo steps back one action, newest first. */
  key: string;
  /** The second half of one gesture (a pin, then its group): the replaced entry's `undo`
   *  is kept, so one Undo goes back to before the first half. */
  merge?: boolean;
  undo: () => void;
  commit?: () => void;
  /** Called when the entry leaves the stack for any reason (undone, expired, committed). */
  onSettled?: (how: Settled) => void;
}

export type Settled = 'undone' | 'expired' | 'committed' | 'replaced' | 'dropped';

interface Entry extends UndoEntryInput {
  seq: number;
  expiresAt: number;
  timer: unknown;
  /** While its toast is out of sight: the time it had left, and since when. */
  paused?: { left: number; at: number };
  pausedTotal: number;
}

export interface UndoClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realClock: UndoClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface UndoStack {
  /** Push an entry; returns its handle for `undo(handle)` (the toast's own button). */
  push: (input: UndoEntryInput, windowMs?: number) => number;
  /** Undo the newest live entry. False when there is none (the key stays the page's). */
  undoLatest: () => boolean;
  /** Undo one entry by handle (its toast's button). False when it already settled. */
  undo: (handle: number) => boolean;
  /** Forget a key's entry with neither its undo nor its commit (the action was refused). */
  drop: (key: string) => boolean;
  /** Take one entry away without undoing it, if it is still there (its write was refused). */
  discard: (handle: number) => boolean;
  /** Run every pending commit now (the page is leaving) and empty the stack. */
  commitAll: () => void;
  hasLive: () => boolean;
  /** Settle every entry past its time (a page back from the background, its timers late). */
  sweep: () => void;
  /** Its toast went out of sight (behind newer ones): its clock stands still, up to
   *  MAX_PAUSED_MS all told, so it never comes back with a moment left. */
  pause: (handle: number) => void;
  /** Its toast is in sight again: the clock goes on from where it stood. */
  resume: (handle: number) => void;
  /** The time an entry has left (0 once settled). */
  timeLeft: (handle: number) => number;
  size: () => number;
}

export function createUndoStack(clock: UndoClock = realClock): UndoStack {
  let seq = 0;
  const entries: Entry[] = [];

  const remove = (entry: Entry) => {
    const at = entries.indexOf(entry);
    if (at >= 0) entries.splice(at, 1);
    clock.clearTimeout(entry.timer);
  };

  const settle = (entry: Entry, how: Settled) => {
    remove(entry);
    if (how === 'undone') {
      try { entry.undo(); } catch (err) { console.error('[undo] undo failed', err); }
    } else {
      try { entry.commit?.(); } catch (err) { console.error('[undo] commit failed', err); }
    }
    entry.onSettled?.(how);
  };

  // An entry lives exactly as long as its timer, the same clock its toast runs on, so an Undo
  // on screen always works. A hidden page's timers are throttled: `sweep` settles what passed
  // its time while it was away, when it comes back.
  const live = () => entries;
  const arm = (entry: Entry, ms: number) => {
    clock.clearTimeout(entry.timer);
    entry.timer = clock.setTimeout(() => { if (entries.includes(entry)) settle(entry, 'expired'); }, ms);
  };

  return {
    push(input, windowMs = UNDO_WINDOW_MS) {
      let undo = input.undo;
      // Only the second half of one gesture takes the first half's place.
      if (input.merge) {
        for (const prior of live().filter((e) => e.key === input.key)) {
          undo = prior.undo;
          settle(prior, 'replaced');
        }
      }
      const entry: Entry = { ...input, undo, seq: ++seq, expiresAt: clock.now() + windowMs, timer: undefined, pausedTotal: 0 };
      arm(entry, windowMs);
      entries.push(entry);
      return entry.seq;
    },
    undoLatest() {
      const list = live();
      const newest = list[list.length - 1];
      if (!newest) return false;
      settle(newest, 'undone');
      return true;
    },
    undo(handle) {
      const entry = live().find((e) => e.seq === handle);
      if (!entry) return false;
      // Back to before this one: what came after it on the same target is gone with it, so a
      // later Undo cannot put back a state in between.
      for (const newer of entries.filter((e) => e.key === entry.key && e.seq > entry.seq)) { remove(newer); newer.onSettled?.('dropped'); }
      settle(entry, 'undone');
      return true;
    },
    drop(key) {
      const found = entries.filter((e) => e.key === key);
      for (const e of found) { remove(e); e.onSettled?.('dropped'); }
      return found.length > 0;
    },
    discard(handle) {
      const entry = entries.find((e) => e.seq === handle);
      if (!entry) return false;
      remove(entry);
      entry.onSettled?.('dropped');
      return true;
    },
    commitAll() {
      for (const e of [...entries]) settle(e, 'committed');
    },
    pause(handle) {
      const entry = entries.find((e) => e.seq === handle);
      if (!entry || entry.paused) return;
      const now = clock.now();
      const spare = MAX_PAUSED_MS - entry.pausedTotal;
      if (spare <= 0) return;
      const left = Math.max(0, entry.expiresAt - now);
      entry.paused = { left, at: now };
      // Out of sight past what it may stand still: it ends then, as it would have.
      entry.expiresAt = now + left + spare;
      arm(entry, left + spare);
    },
    resume(handle) {
      const entry = entries.find((e) => e.seq === handle);
      if (!entry?.paused) return;
      const now = clock.now();
      entry.pausedTotal += now - entry.paused.at;
      const left = entry.paused.left;
      entry.paused = undefined;
      entry.expiresAt = now + left;
      arm(entry, left);
    },
    timeLeft(handle) {
      const entry = entries.find((e) => e.seq === handle);
      if (!entry) return 0;
      return entry.paused ? entry.paused.left : Math.max(0, entry.expiresAt - clock.now());
    },
    hasLive: () => live().length > 0,
    sweep() {
      const now = clock.now();
      for (const e of [...entries]) if (e.expiresAt <= now) settle(e, 'expired');
    },
    size: () => entries.length,
  };
}
