/**
 * Undoable task actions: complete / reopen, snooze, pin / unpin / tier, delete. Each one
 * writes through the shared stores as before (optimistic, the same frame on every
 * surface) and pushes an entry on the app's undo stack (undo-stack.ts) with a 5 second
 * toast. mod+z takes back the newest one from anywhere in the app, except while the caret
 * is in a field with text of its own to undo (see `undoKeyApplies`).
 *
 * A delete is a hard delete on the server, so it is held: the row is hidden at once and
 * the DELETE goes out when the window closes (or at once when the page goes, as one batch
 * POST with keepalive). An Undo inside the window shows the row again with nothing sent.
 *
 * The other Undos outlive a reload inside their window (undo-persist.ts): each names a kind
 * and the data to rebuild it from, and the page that comes back revives it for the time left.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { useTasksContext } from '@/contexts/TasksContext';
import { startDateMs } from '@open-walnut/user-status';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useNotifications } from '@/contexts/notifications';
import type { FocusTier } from '@/api/focus';
import { tierLabelOf } from '@/components/sessions/task-meta-constants';
import { createUndoStack, UNDO_WINDOW_MS, type UndoStack } from './undo-stack';
import { undoKeyApplies, undoKeyLabel } from './undo-key';
import { formatSnoozeDate } from './undo-labels';
import { hasActiveModalOverlay } from '@/hooks/useModalOverlay';
import { hasOpenOverlayLayer } from '@/hooks/useOverlayLayer';
import { batchDeleteTasks, cancelScheduledDeletes } from '@/api/tasks';
import { MIN_REVIVE_LEFT_MS, RETURN_WITHIN_MS, saveUndos, takeUndos, type PersistedUndo } from './undo-persist';

export interface UndoablePush {
  key: string;
  title: string;
  body?: string;
  undo: () => void;
  commit?: () => void;
  /** The second half of one gesture: keep the replaced entry's undo (undo-stack.ts). */
  merge?: boolean;
  /** Called when the entry leaves the stack without being undone. */
  onExpired?: () => void;
  /** How a reload inside the window rebuilds it: a reviver's kind (`registerReviver`) and
   *  plain data for it. Without one the Undo ends with the page. */
  revive?: { kind: string; data: unknown };
  /** The window, when not the full one (a revived Undo has only what was left). */
  windowMs?: number;
}

/** What a task's phase was, for putting it back. */
export type PhaseSnapshot = Pick<Task, 'phase' | 'wait_until' | 'phase_changed_at' | 'unread'>;
export const phaseSnapshot = (t: Task): PhaseSnapshot => ({ phase: t.phase, wait_until: t.wait_until, phase_changed_at: t.phase_changed_at, unread: t.unread });

/** Rebuilds a saved Undo after a reload: its undo (and commit), or null when it no longer applies. */
export type UndoReviver = (data: unknown) => Pick<UndoablePush, 'undo' | 'commit' | 'onExpired'> | null;

export interface TaskUndo {
  /** Push any undoable action with its toast (the column completion uses this). Returns what
   *  takes this one entry away again (its write was refused), and no newer one with its key. */
  push: (entry: UndoablePush) => () => void;
  /** Take a key's entry and toast away without undoing it (the server refused the action). */
  drop: (key: string) => void;
  /** `ring`: the completion ring clicked again, a reopen that takes a fresh completion back. */
  setPhase: (id: string, phase: string, opts?: { ring?: boolean }) => void;
  /** Put a task's phase back as it was (every Undo of a phase goes through here): a
   *  NEED_ACTION that came from its session is not written back as the person's own ask. */
  restorePhase: (id: string, before: PhaseSnapshot) => Promise<boolean>;
  /** How Undos of `kind` come back after a reload. Returns the unregister. */
  registerReviver: (kind: string, reviver: UndoReviver) => () => void;
  /** A task is being completed by a path that writes the phase itself (a column's ring): a
   *  reopen right after takes it back to this, as an Undo does, not to TODO. */
  noteCompleted: (t: Task) => void;
  toggleComplete: (id: string) => void;
  setStartDate: (id: string, date: string | null) => void;
  pin: (id: string) => Promise<void>;
  unpin: (id: string) => Promise<void>;
  setTier: (id: string, tier: FocusTier, newPinnedOrder?: string[]) => Promise<void>;
  deleteTask: (id: string, opts?: { force?: boolean }) => void;
  /** The task's delete is held for its undo window (its row is hidden): leave it alone. */
  isDeleteHeld: (id: string) => boolean;
  /** `hook` runs as a task is deleted; what it returns puts back what went with it, told why:
   *  the person's Undo, or the server refusing the delete. */
  onDelete: (hook: (id: string) => ((why: 'undo' | 'refused') => void) | void) => () => void;
}

const TaskUndoContext = createContext<TaskUndo | null>(null);

const isDone = (t: Pick<Task, 'status' | 'phase'>) => t.status === 'done' || t.phase === 'COMPLETE';

export function TaskUndoProvider({ children }: { children: ReactNode }) {
  const store = useTasksContext();
  const focusBar = useFocusBarContext();
  const { notify, dismissToast } = useNotifications();
  const latest = useRef({ store, focusBar, notify, dismissToast });
  latest.current = { store, focusBar, notify, dismissToast };
  const stackRef = useRef<UndoStack | null>(null);
  if (!stackRef.current) stackRef.current = createUndoStack();
  const stack = stackRef.current;

  const row = (id: string) => latest.current.store.tasks.find((t) => t.id === id);

  const toastSeq = useRef(0);
  /** The live entries, by handle: what a reload saves, and when each was pushed. */
  const live = useRef(new Map<number, { entry: UndoablePush; pushedAt: number }>());
  const push = useCallback((entry: UndoablePush) => {
    // Its own toast id each time: a replaced entry's toast is still going when this one comes.
    const toastId = `undo:${entry.key}:${++toastSeq.current}`;
    const windowMs = Math.min(entry.windowMs ?? UNDO_WINDOW_MS, UNDO_WINDOW_MS);
    let handle = 0;
    handle = stack.push({
      key: entry.key,
      undo: entry.undo,
      commit: entry.commit,
      merge: entry.merge,
      onSettled: (how) => {
        live.current.delete(handle);
        latest.current.dismissToast(toastId);
        if (how === 'expired' || how === 'committed') entry.onExpired?.();
      },
    }, windowMs);
    live.current.set(handle, { entry, pushedAt: performance.now() });
    latest.current.notify({
      kind: 'hint',
      severity: 'success',
      id: toastId,
      dedupKey: toastId,
      title: entry.title,
      ...(entry.body ? { body: entry.body } : {}),
      persistent: false,
      durationMs: windowMs,
      action: { label: 'Undo', kind: 'callback' },
      actionKeyHint: undoKeyLabel(),
      onAction: () => { stack.undo(handle); },
      // The stack's clock is the toast's: it stands still while the toast is out of sight.
      ownClock: true,
      timeLeftMs: () => stack.timeLeft(handle),
      onShownChange: (shown) => { if (shown) stack.resume(handle); else stack.pause(handle); },
    });
    return () => { stack.discard(handle); };
  }, [stack]);

  const drop = useCallback((key: string) => { stack.drop(key); }, [stack]);
  /** A write the server refused takes its Undo and toast down (the store says why). */
  const withdrawIfRefused = (write: Promise<boolean | void>, withdraw: () => void) => {
    void write.then((ok) => { if (ok === false) withdraw(); }, withdraw);
  };

  // ── Phase ──
  const restorePhase = useCallback((id: string, before: PhaseSnapshot): Promise<boolean> => {
    const { store: s } = latest.current;
    if (before.phase === 'WAITING') return s.update(id, { phase: 'WAITING', ...(before.wait_until ? { wait_until: before.wait_until } : {}) });
    // Put back as it was: a NEED_ACTION is the person's own ask only if it was one before (the
    // server reads its mark against this time; the list's rows do not carry the mark).
    // Its read marker comes back as it was too: NEED_ACTION alone would light the unread dot.
    if (before.phase === 'NEED_ACTION') return s.setPhase(id, before.phase, { undoOf: before.phase_changed_at ?? '', unread: !!before.unread });
    return s.setPhase(id, before.phase, { unread: !!before.unread });
  }, []);

  /** The Undo of a phase move to done or back, from its data (also after a reload). */
  const phaseUndo = useCallback((id: string, nowDone: boolean, before: PhaseSnapshot) => () => {
    const cur = row(id);
    // A refusal already put it back, or something newer moved it: nothing to undo.
    if (cur && isDone(cur) !== nowDone) return;
    void restorePhase(id, before);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restorePhase]);

  const pushPhaseUndo = useCallback((t: Task, nowDone: boolean, write: Promise<boolean>) => {
    const before = phaseSnapshot(t);
    withdrawIfRefused(write, push({
      key: `phase:${t.id}`,
      title: nowDone ? 'Task completed' : 'Task reopened',
      body: t.title,
      undo: phaseUndo(t.id, nowDone, before),
      revive: { kind: 'phase', data: { id: t.id, nowDone, before } },
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push, phaseUndo]);

  /** Completions made in the undo window: their phase before (a double click's second click
   *  lands on a ring that just completed). */
  const recentDone = useRef(new Map<string, { before: PhaseSnapshot; at: number }>());
  const noteCompleted = useCallback((t: Task) => {
    if (!isDone(t)) recentDone.current.set(t.id, { before: phaseSnapshot(t), at: Date.now() });
  }, []);
  /** A reopen of a task completed moments ago is that completion taken back: its own Undo when
   *  it is on screen (the column comes back too), else its phase as it was. Never TODO, which
   *  drops a task that needed the person out of Needs you. True when it was one. */
  const takeBackFreshCompletion = (id: string): boolean => {
    // The newest completion of it still on screen (a reopen's own Undo is not one).
    let found: number | undefined;
    for (const [handle, v] of live.current) {
      const done = v.entry.key === `column-done:${id}`
        || (v.entry.key === `phase:${id}` && (v.entry.revive?.data as { nowDone?: boolean } | undefined)?.nowDone === true);
      if (done) found = handle;
    }
    if (found !== undefined) { stack.undo(found); return true; }
    const recent = recentDone.current.get(id);
    recentDone.current.delete(id);
    if (recent && Date.now() - recent.at < UNDO_WINDOW_MS) { void restorePhase(id, recent.before); return true; }
    return false;
  };

  const setPhase = useCallback((id: string, phase: string, opts?: { ring?: boolean }) => {
    const t = row(id);
    // Only the ring's reopen takes a completion back: a phase picked by name (a menu's To do)
    // is the person's choice and is written.
    if (t && isDone(t) && opts?.ring && takeBackFreshCompletion(id)) return;
    if (t && phase === 'COMPLETE') noteCompleted(t);
    const write = latest.current.store.setPhase(id, phase);
    if (!t || t.phase === phase) return;
    const wasDone = isDone(t);
    const nowDone = phase === 'COMPLETE';
    if (wasDone !== nowDone) pushPhaseUndo(t, nowDone, write);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushPhaseUndo]);

  const toggleComplete = useCallback((id: string) => {
    const t = row(id);
    if (t && isDone(t) && takeBackFreshCompletion(id)) return;
    if (t && !isDone(t)) noteCompleted(t);
    const write = latest.current.store.toggleComplete(id);
    if (t) pushPhaseUndo(t, !isDone(t), write);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushPhaseUndo]);

  // ── Snooze (the task's start date) ──
  const setStartDate = useCallback((id: string, date: string | null) => {
    const t = row(id);
    const before = t?.start_date ?? '';
    const next = date ?? '';
    const write = latest.current.store.update(id, { start_date: next });
    if (!t || before === next) return;
    withdrawIfRefused(write, push({
      key: `snooze:${id}`,
      title: next ? `Snoozed until ${formatSnoozeDate(next)}` : 'Snooze cleared',
      body: t.title,
      undo: () => {
        const written = latest.current.store.update(id, { start_date: before });
        // Its place before the snooze, at once: the server's status says Snoozed until its next
        // pass (about 1.5 s), and the row would sit under Waiting that long. Held while the
        // write is out, so a list read answered before it lands does not draw Snoozed back.
        const was = t.user_status;
        if (was && !was.snoozed && !(startDateMs(before) > Date.now())) {
          const settle = latest.current.store.patchTasksLocal({ [id]: { user_status: was } }, { pending: true });
          void Promise.resolve(written).then(settle, settle);
        }
      },
      revive: { kind: 'snooze', data: { id, before } },
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push]);

  // ── Pin ──
  /** Where the pin was: unpinned, or its tier and the whole pinned order. */
  const pinSnapshot = (id: string) => {
    const fb = latest.current.focusBar;
    return fb.isPinned(id) ? { pinned: true as const, tier: fb.tierOf(id), order: [...fb.pinnedIds] } : { pinned: false as const };
  };
  const restorePin = (id: string, snap: ReturnType<typeof pinSnapshot>) => {
    const fb = latest.current.focusBar;
    if (!snap.pinned) { void fb.unpin(id).catch(() => {}); return; }
    void (async () => {
      if (!fb.isPinned(id)) await fb.pin(id);
      // Back in its old place among the pins as they are now (others may have moved since).
      const now = latest.current.focusBar.pinnedIds.filter((x) => x !== id);
      now.splice(Math.min(Math.max(snap.order.indexOf(id), 0), now.length), 0, id);
      await latest.current.focusBar.setTier(id, snap.tier, now);
    })().catch(() => {});
  };
  const tierName = (tier: string) => tierLabelOf(tier, latest.current.focusBar.customTiers);
  /** Tasks pinned a moment ago: the tier picked right after ("Pin to Focus" is a pin, then a
   *  tier, TaskKebabMenu) still reads as that pin. Once only: a later tier pick is a move. */
  const PIN_THEN_TIER_MS = 1500;
  const freshPins = useRef(new Map<string, { until: number; snap: ReturnType<typeof pinSnapshot> }>());

  const pin = useCallback(async (id: string) => {
    const snap = pinSnapshot(id);
    const t = row(id);
    const done = latest.current.focusBar.pin(id);
    if (!snap.pinned && t && !isDone(t)) {
      freshPins.current.set(id, { until: Date.now() + PIN_THEN_TIER_MS, snap });
      withdrawIfRefused(done, push({ key: `pin:${id}`, title: 'Pinned', body: t.title, undo: () => restorePin(id, snap), revive: { kind: 'pin', data: { id, snap } } }));
    }
    await done;
    // The tier pick follows the pin's answer: its moment starts now, however slow that was.
    const fresh = freshPins.current.get(id);
    if (fresh) fresh.until = Date.now() + PIN_THEN_TIER_MS;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push]);

  const unpin = useCallback(async (id: string) => {
    const snap = pinSnapshot(id);
    const t = row(id);
    const done = latest.current.focusBar.unpin(id);
    freshPins.current.delete(id);
    if (snap.pinned) {
      withdrawIfRefused(done, push({ key: `pin:${id}`, title: 'Unpinned', ...(t ? { body: t.title } : {}), undo: () => restorePin(id, snap), revive: { kind: 'pin', data: { id, snap } } }));
    }
    await done;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push]);

  const setTier = useCallback(async (id: string, tier: FocusTier, newPinnedOrder?: string[]) => {
    const snap = pinSnapshot(id);
    const t = row(id);
    const done = latest.current.focusBar.setTier(id, tier, newPinnedOrder);
    // A reorder inside the same tier is a drag, not an action to announce.
    if (!snap.pinned || snap.tier !== tier) {
      const pinned = freshPins.current.get(id);
      const fresh = !!pinned && pinned.until > Date.now();
      freshPins.current.delete(id);
      withdrawIfRefused(done, push({
        key: `pin:${id}`,
        // Picking the group of a task just pinned is one gesture with the pin (TaskKebabMenu).
        merge: fresh,
        title: `${!snap.pinned || fresh ? 'Pinned to' : 'Moved to'} ${tierName(tier)}`,
        ...(t ? { body: t.title } : {}),
        undo: () => restorePin(id, snap),
        // A merged entry undoes to before the pin (the stack keeps the pin's undo).
        revive: { kind: 'pin', data: { id, snap: fresh ? pinned!.snap : snap } },
      }));
    }
    await done;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push]);

  // ── Delete (held for the undo window) ──
  /** The server's scheduled delete taken back, a few tries over a few seconds (the server
   *  deletes it about 30 s on): the person is told when it could not be. */
  const takeBackScheduledDelete = async (id: string, heldAt: number) => {
    // Until one gets through, a page that goes sends it again as it goes (onLeave).
    takingBack.current.set(id, heldAt);
    for (const wait of [0, 1000, 3000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (takingBack.current.get(id) !== heldAt) return;
      try { await cancelScheduledDeletes([id], heldAt); if (takingBack.current.get(id) === heldAt) takingBack.current.delete(id); return; } catch { /* try again */ }
    }
    if (takingBack.current.get(id) === heldAt) takingBack.current.delete(id);
    latest.current.notify({ kind: 'operation-error', severity: 'error', persistent: false, dedupKey: `undo-delete-failed:${id}`,
      title: 'Could not undo the delete', body: 'The server could not be reached, so it will still delete this task.' });
  };

  /** Undone deletes whose cancel has not reached the server yet (id -> its held_at). */
  const takingBack = useRef(new Map<string, number>());
  /** Held deletes and their options, until each is undone or sent. */
  const heldDeletes = useRef(new Map<string, { force?: boolean; heldAt: number }>());
  const isDeleteHeld = useCallback((id: string) => heldDeletes.current.has(id), []);
  const deleteHooks = useRef(new Set<(id: string) => ((why: 'undo' | 'refused') => void) | void>());
  const onDelete = useCallback((hook: (id: string) => ((why: 'undo' | 'refused') => void) | void) => {
    deleteHooks.current.add(hook);
    return () => { deleteHooks.current.delete(hook); };
  }, []);
  const deleteTask = useCallback((id: string, opts?: { force?: boolean }) => {
    const s = latest.current.store;
    // Already on its way out (a second menu on the hidden task): one DELETE, at the end.
    if (heldDeletes.current.has(id)) return;
    const t = row(id);
    if (!t) { void s.deleteTask(id, opts); return; }
    const heldAt = Date.now();
    heldDeletes.current.set(id, { ...opts, heldAt });
    takingBack.current.delete(id);
    s.hideTasks([id]);
    // The server holds it too, from now: a browser that quits or crashes inside the window (no
    // pagehide) still has it deleted, once the window and the time a reload takes are over.
    void batchDeleteTasks([id], { ...(opts?.force ? { force: true } : {}), delayMs: UNDO_WINDOW_MS + RETURN_WITHIN_MS, heldAt }).catch(() => {});
    const putBack = [...deleteHooks.current].map((hook) => hook(id)).filter((f): f is (why: 'undo' | 'refused') => void => typeof f === 'function');
    push({
      key: `delete:${id}`,
      title: 'Task deleted',
      body: t.title,
      // A reload keeps it held: the page hands it to the server as it goes (onLeave).
      revive: { kind: 'delete', data: { id, heldAt, ...(opts?.force ? { force: true } : {}) } },
      undo: () => {
        heldDeletes.current.delete(id);
        latest.current.store.unhideTasks([id]);
        for (const f of putBack) f('undo');
        void takeBackScheduledDelete(id, heldAt);
      },
      // The row leaves the full list in the same frame as it stops being hidden; a
      // refusal (a live session's 409) refetches and the row comes back.
      commit: () => {
        heldDeletes.current.delete(id);
        // Refused (a live session's 409): the row comes back with the refetch, and what went
        // with it (its column) comes back too.
        // The server's own hold is taken back too: what is shown is what stays.
        void latest.current.store.deleteTask(id, opts).then((ok) => {
          if (ok) return;
          for (const f of putBack) f('refused');
          void takeBackScheduledDelete(id, heldAt);
        });
        latest.current.store.unhideTasks([id]);
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push]);

  // ── Reload: the Undos with a reviver come back for the time they had left ──
  const revivers = useRef(new Map<string, UndoReviver>());
  const waiting = useRef<PersistedUndo[]>([]);
  const reviveWaiting = useCallback(() => {
    const now = Date.now();
    waiting.current = waiting.current.filter((saved) => {
      const reviver = revivers.current.get(saved.kind);
      // A kind whose page part has not mounted yet waits for it, a while.
      if (!reviver) return now - saved.savedAt < RETURN_WITHIN_MS;
      const rebuilt = reviver(saved.data);
      if (rebuilt) {
        push({ key: saved.key, title: saved.title, ...(saved.body ? { body: saved.body } : {}), ...rebuilt, revive: { kind: saved.kind, data: saved.data }, windowMs: saved.leftMs });
      }
      return false;
    });
  }, [push]);
  const registerReviver = useCallback((kind: string, reviver: UndoReviver) => {
    revivers.current.set(kind, reviver);
    reviveWaiting();
    return () => { if (revivers.current.get(kind) === reviver) revivers.current.delete(kind); };
  }, [reviveWaiting]);
  useEffect(() => {
    const builtIn: Array<[string, UndoReviver]> = [
      ['phase', (data) => {
        const d = data as { id?: string; nowDone?: boolean; before?: PhaseSnapshot };
        return d.id && d.before && typeof d.nowDone === 'boolean' ? { undo: phaseUndo(d.id, d.nowDone, d.before) } : null;
      }],
      ['snooze', (data) => {
        const d = data as { id?: string; before?: string };
        return d.id && typeof d.before === 'string' ? { undo: () => { void latest.current.store.update(d.id!, { start_date: d.before! }); } } : null;
      }],
      ['pin', (data) => {
        const d = data as { id?: string; snap?: ReturnType<typeof pinSnapshot> };
        return d.id && d.snap ? { undo: () => restorePin(d.id!, d.snap!) } : null;
      }],
      // A delete the page before handed to the server as it went: hidden again, the Undo takes
      // the server's delete back, and the end of the window sends it now.
      ['delete', (data) => {
        const d = data as { id?: string; force?: boolean; heldAt?: number };
        if (!d.id) return null;
        const id = d.id;
        const heldAt = typeof d.heldAt === 'number' ? d.heldAt : Date.now();
        const opts = d.force ? { force: true } : undefined;
        heldDeletes.current.set(id, { ...opts, heldAt });
        latest.current.store.hideTasks([id]);
        return {
          undo: () => {
            heldDeletes.current.delete(id);
            latest.current.store.unhideTasks([id]);
            void takeBackScheduledDelete(id, heldAt);
          },
          commit: () => {
            heldDeletes.current.delete(id);
            void latest.current.store.deleteTask(id, opts).then((ok) => { if (!ok) void takeBackScheduledDelete(id, heldAt); });
            latest.current.store.unhideTasks([id]);
          },
        };
      }],
    ];
    const off = builtIn.map(([kind, reviver]) => registerReviver(kind, reviver));
    return () => { for (const f of off) f(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerReviver, phaseUndo]);

  // mod+z from anywhere, and the held deletes go out when the page does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (e.repeat || !undoKeyApplies(e, active)) return;
      // A dialog or a menu over the page owns its keys: nothing is undone behind it.
      if (hasActiveModalOverlay() || hasOpenOverlayLayer() || document.querySelector('.wn-context-menu, .task-kebab-menu, [role="menu"]')) return;
      if (!stack.hasLive()) {
        // Outside any text box the key would do nothing at all: say so.
        const inText = !!active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
        if (!inText) {
          latest.current.notify({ kind: 'hint', severity: 'info', title: 'Nothing to undo', dedupKey: 'undo:nothing', persistent: false, durationMs: 1800 });
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // The key has no button to watch go: a line says what it took back.
      const newest = Math.max(...[...live.current.keys()]);
      const undone = live.current.get(newest)?.entry;
      if (stack.undoLatest() && undone) {
        latest.current.notify({ kind: 'hint', severity: 'info', title: 'Undone',
          body: undone.body ? `${undone.title}  \u00b7  ${undone.body}` : undone.title,
          dedupKey: 'undo:done', persistent: false, durationMs: 2000 });
      }
    };
    const save = (): boolean => {
      const now = Date.now();
      return saveUndos(sessionStorageOrUndefined(), [...live.current.entries()]
        .map(([handle, v]) => ({ v, left: stack.timeLeft(handle) }))
        .filter(({ v, left }) => v.entry.revive && left > 0)
        .map(({ v, left }): PersistedUndo => ({
          kind: v.entry.revive!.kind, data: v.entry.revive!.data, key: v.entry.key, title: v.entry.title,
          ...(v.entry.body ? { body: v.entry.body } : {}), leftMs: left, savedAt: now,
        })));
    };
    const revive = () => {
      waiting.current.push(...takeUndos(sessionStorageOrUndefined(), Date.now()));
      reviveWaiting();
    };
    revive();
    // Back from the page cache: the stack was emptied as the page went.
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) revive(); };
    const onLeave = () => {
      const kept = save();
      // The held deletes go to the server, which deletes them once their window (and the time
      // a reload takes) is over: a page that comes back revives their Undo and takes them back
      // or sends them at its end; a tab that never comes back loses nothing it was promised.
      // As batch POSTs: WebKit cancels a DELETE sent as the page goes, keepalive or not, while
      // a POST lives on (page-exit-writes.spec.ts).
      const left = (id: string) => {
        for (const [handle, v] of live.current) if (v.entry.key === `delete:${id}`) return stack.timeLeft(handle);
        return 0;
      };
      // One that will not come back (too little left to show, or nothing could be saved) goes now.
      const groups = new Map<string, { ids: string[]; force: boolean; heldAt: number; delayMs: number }>();
      for (const [id, o] of heldDeletes.current) {
        const l = left(id);
        const delayMs = kept && l >= MIN_REVIVE_LEFT_MS ? l + RETURN_WITHIN_MS : 0;
        const key = `${!!o.force}|${o.heldAt}|${delayMs}`;
        const g = groups.get(key) ?? { ids: [], force: !!o.force, heldAt: o.heldAt, delayMs };
        g.ids.push(id);
        groups.set(key, g);
      }
      for (const id of heldDeletes.current.keys()) stack.drop(`delete:${id}`);
      heldDeletes.current.clear();
      for (const g of groups.values()) {
        void batchDeleteTasks(g.ids, { ...(g.force ? { force: true } : {}), ...(g.delayMs ? { delayMs: g.delayMs } : {}), heldAt: g.heldAt }).catch(() => {});
      }
      // An Undo whose cancel has not got through: sent again now, as the page goes.
      for (const [id, heldAt] of takingBack.current) void cancelScheduledDeletes([id], heldAt).catch(() => {});
      takingBack.current.clear();
      stack.commitAll();
    };
    const onShown = () => { if (document.visibilityState === 'visible') stack.sweep(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onShown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onShown);
      // As when the page goes: the effect running again (StrictMode, a remount) revives them
      // rather than losing them to the commit, held deletes included.
      onLeave();
    };
  }, [stack, reviveWaiting]);

  const value = useMemo<TaskUndo>(
    () => ({ push, drop, setPhase, restorePhase, registerReviver, noteCompleted, toggleComplete, setStartDate, pin, unpin, setTier, deleteTask, isDeleteHeld, onDelete }),
    [push, drop, setPhase, restorePhase, registerReviver, noteCompleted, toggleComplete, setStartDate, pin, unpin, setTier, deleteTask, isDeleteHeld, onDelete],
  );
  return <TaskUndoContext.Provider value={value}>{children}</TaskUndoContext.Provider>;
}

function sessionStorageOrUndefined(): Storage | undefined {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; } catch { return undefined; }
}

/** The undoable actions, or null outside the app shell (pop-out windows have none). */
export function useTaskUndo(): TaskUndo | null {
  return useContext(TaskUndoContext);
}

/** Complete, phase and delete for any surface that shows tasks: through the Undo stack in the
 *  app (each gets its toast and mod+z), straight to the store where there is none (a pop-out).
 *  A surface never takes these from the task store itself (tests/web/undo-surfaces-ratchet.test.ts). */
export function useUndoableTaskActions(): {
  toggleComplete: (id: string) => void;
  setPhase: (id: string, phase: string) => void;
  deleteTask: (id: string) => void;
} {
  const undo = useContext(TaskUndoContext);
  const store = useTasksContext();
  const toggleComplete = useCallback((id: string) => {
    if (undo) undo.toggleComplete(id); else void store.toggleComplete(id);
  }, [undo, store]);
  const setPhase = useCallback((id: string, phase: string) => {
    if (undo) undo.setPhase(id, phase); else void store.setPhase(id, phase);
  }, [undo, store]);
  const deleteTask = useCallback((id: string) => {
    if (undo) undo.deleteTask(id); else void store.deleteTask(id);
  }, [undo, store]);
  return useMemo(() => ({ toggleComplete, setPhase, deleteTask }), [toggleComplete, setPhase, deleteTask]);
}
