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
 * Redo is the same history run forward: an entry undone that carries a `redo` goes on the redo
 * list for its own window, and mod+shift+z (or the "Undone" toast's Redo) runs the newest one. A
 * redo does the action again through the same call that did it first, so that call pushes a fresh
 * entry (and toast) with the same key; any other new action clears the redo list, as in every
 * editor. An undo that finds its target changed elsewhere says so (`undo` returns false): nothing
 * was taken back, so nothing can be redone over that change.
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
  /** Takes the action back. Returns false when it no longer applies (the target changed
   *  elsewhere since): nothing was undone, and it is not redoable. */
  undo: () => void | boolean;
  /** Does the action again, through the call that did it first (it pushes its own entry with the
   *  same key; a promise while that push may still come). Present only on redoable actions. */
  redo?: () => void | Promise<unknown>;
  commit?: () => void;
  /** Called when the entry leaves the stack for any reason (undone, expired, committed). */
  onSettled?: (how: Settled) => void;
}

/** `stale`: undone, but its undo found the target changed elsewhere and left it. */
export type Settled = 'undone' | 'stale' | 'expired' | 'committed' | 'replaced' | 'dropped';

interface RedoEntry {
  key: string;
  redo: () => void | Promise<unknown>;
  seq: number;
  expiresAt: number;
  timer: unknown;
}

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
  /** Redo the newest action undone in its window. False when there is none. */
  redoLatest: () => boolean;
  hasRedo: () => boolean;
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
  const redos: RedoEntry[] = [];
  /** Keys a redo is doing again right now: their push is that redo, not a new action. A key
   *  leaves when its push comes, or when the redo ends without one (canceled, nothing to do). */
  const redoing = new Map<string, number>();
  const liveRedos = () => {
    const now = clock.now();
    for (const r of [...redos]) if (r.expiresAt <= now) removeRedo(r);
    return redos;
  };

  const removeRedo = (r: RedoEntry) => {
    const at = redos.indexOf(r);
    if (at >= 0) redos.splice(at, 1);
    clock.clearTimeout(r.timer);
  };
  const clearRedos = () => { for (const r of [...redos]) removeRedo(r); };

  const remove = (entry: Entry) => {
    const at = entries.indexOf(entry);
    if (at >= 0) entries.splice(at, 1);
    clock.clearTimeout(entry.timer);
  };

  const settle = (entry: Entry, how: Settled) => {
    remove(entry);
    if (how === 'undone') {
      let applied = true;
      try { applied = entry.undo() !== false; } catch (err) { console.error('[undo] undo failed', err); applied = false; }
      if (!applied) how = 'stale';
      else if (entry.redo) {
        const r: RedoEntry = { key: entry.key, redo: entry.redo, seq: ++seq, expiresAt: clock.now() + UNDO_WINDOW_MS, timer: undefined };
        r.timer = clock.setTimeout(() => removeRedo(r), UNDO_WINDOW_MS);
        redos.push(r);
      }
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
      // A redo's own push keeps the rest of the redo list; any other action ends it.
      if (redoing.has(input.key)) redoing.delete(input.key);
      else clearRedos();
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
    redoLatest() {
      const list = liveRedos();
      const newest = list[list.length - 1];
      if (!newest) return false;
      removeRedo(newest);
      const mark = newest.seq;
      redoing.set(newest.key, mark);
      // The key stops counting as a redo once the redo is over, pushed or not.
      const done = () => { if (redoing.get(newest.key) === mark) redoing.delete(newest.key); };
      try {
        const result = newest.redo();
        if (result && typeof (result as Promise<unknown>).then === 'function') void (result as Promise<unknown>).then(done, done);
        else done();
      } catch (err) { console.error('[undo] redo failed', err); done(); }
      return true;
    },
    hasRedo: () => liveRedos().length > 0,
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
      clearRedos();
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
      liveRedos();
    },
    size: () => entries.length,
  };
}
