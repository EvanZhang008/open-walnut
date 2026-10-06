/**
 * "Changed since you last looked" (spec 8.4, G5, G6): the user's baseline lives
 * on the server beside the board (`kanban_seen`, human only), so every window
 * and device counts the same changes. This hook keeps it moving:
 *
 * - First open of a board with no baseline: PUT the cards as shown, so nothing
 *   counts as changed (waits until every card of the team is known).
 * - A visit = the Board view shown + the document visible + the window
 *   focused. It ends when the view goes away (Page, pane closed) or the window
 *   stays blurred / hidden for 5 minutes; then the cards as shown become the
 *   new baseline (`visit_end`, the server moves `at` to `previous_at`).
 * - markCardSeen (the user opened, messaged or answered a card) and
 *   markAllSeen write at once.
 *
 * Writes are optimistic: the entries count from the click until the next
 * payload after the write answered (the server's own baseline by then).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiPut } from '@/api/client';
import { log } from '@/utils/log';
import type { BoardKanbanSeen, BoardKanbanSeenCard } from '../board-model';
import type { KanbanSeenApi, UseKanbanSeen } from './kanban-contract';

/** Blurred or hidden this long = the visit ended. */
export const SEEN_AWAY_MS = 5 * 60_000;
/** A first baseline waits at most this long for the team to load. */
const FIRST_SEEN_WAIT_MS = 15_000;
/** ... and for the cards to hold still this long (late summaries, statuses). */
const FIRST_SEEN_SETTLE_MS = 2_000;
/** An unmount followed by a mount of the same owner's board this soon is not a visit end. */
const REMOUNT_GRACE_MS = 1_000;
/** Mounted boards per owner, across instances (a remount is a new instance). */
const mountedOwners = new Map<string, number>();

type SeenBody = { cards?: string[] | 'all'; snapshot?: Record<string, BoardKanbanSeenCard>; visit_end?: boolean };

/** One optimistic write: its entries count until a payload newer than its answer arrives. */
export interface SeenOverlay {
  id: number;
  cards: Record<string, BoardKanbanSeenCard>;
  /** A new baseline time (Mark all seen, first open, visit end). */
  restartAt?: string;
  answered: boolean;
  /** The payload on screen when the write answered. */
  payloadAtAnswer?: unknown;
}

/** The baseline with the optimistic writes on top (pure). */
export function overlaySeen(base: BoardKanbanSeen | null, overlays: readonly SeenOverlay[]): BoardKanbanSeen | null {
  let out = base;
  for (const o of overlays) {
    if (o.restartAt) {
      out = { at: o.restartAt, ...(out?.at ? { previous_at: out.at } : {}), cards: { ...o.cards } };
    } else if (out) {
      out = { ...out, cards: { ...out.cards, ...o.cards } };
    }
  }
  return out;
}

/** summaryHash('') (FNV-1a offset basis): a card the browser shows without a summary. */
export const EMPTY_SUMMARY_HASH = '811c9dc5';

/**
 * The entries the server takes as shown, and the cards it should read itself.
 * The home list payload carries no task summary, so a card can show none for a
 * moment while the task has one; an empty summary is therefore not trusted, and
 * the server computes that card from the task (the same rule the web uses).
 */
export function splitSnapshot(shown: Record<string, BoardKanbanSeenCard>): { snapshot: Record<string, BoardKanbanSeenCard>; unsure: string[] } {
  const snapshot: Record<string, BoardKanbanSeenCard> = {};
  const unsure: string[] = [];
  for (const [id, e] of Object.entries(shown)) {
    if (e.summaryHash === EMPTY_SUMMARY_HASH) unsure.push(id);
    else snapshot[id] = e;
  }
  return { snapshot, unsure };
}

function seenPath(ownerId: string): string {
  return `/api/v1/tasks/${encodeURIComponent(ownerId)}/board/kanban-seen`;
}

function documentPresent(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

export const useKanbanSeen: UseKanbanSeen = (ownerId, payload, opts) => {
  const [overlays, setOverlays] = useState<SeenOverlay[]>([]);
  const seq = useRef(0);
  const payloadRef = useRef<unknown>(payload);
  payloadRef.current = payload;
  const snapRef = useRef(opts.getSnapshot);
  snapRef.current = opts.getSnapshot;
  const ownerRef = useRef(ownerId);
  ownerRef.current = ownerId;

  // A payload newer than a write's answer replaces that write's entries.
  useEffect(() => {
    setOverlays((prev) => {
      const next = prev.filter((o) => !o.answered || o.payloadAtAnswer === payload);
      return next.length === prev.length ? prev : next;
    });
  }, [payload]);
  // Another owner's writes are not this one's.
  useEffect(() => { setOverlays([]); }, [ownerId]);

  const write = useCallback((body: SeenBody, overlay: Omit<SeenOverlay, 'id' | 'answered'>, reason: string) => {
    const owner = ownerRef.current;
    if (!owner) return;
    const id = ++seq.current;
    setOverlays((prev) => [...prev, { ...overlay, id, answered: false }]);
    const started = Date.now();
    apiPut<{ kanban_seen: BoardKanbanSeen }>(seenPath(owner), body).then(() => {
      log.info('board', 'kanban seen written', { taskId: owner, reason, cards: Array.isArray(body.cards) ? body.cards.join(',') : body.cards ?? '', ms: Date.now() - started });
      setOverlays((prev) => prev.map((o) => (o.id === id ? { ...o, answered: true, payloadAtAnswer: payloadRef.current } : o)));
    }).catch((err: unknown) => {
      log.warn('board', 'kanban seen write failed', { taskId: owner, reason, error: String(err) });
      setOverlays((prev) => prev.filter((o) => o.id !== id));
    });
  }, []);

  const writeAll = useCallback((reason: 'first-open' | 'visit-end' | 'mark-all') => {
    const shown = snapRef.current();
    const { snapshot, unsure } = splitSnapshot(shown);
    const body: SeenBody = reason === 'visit-end'
      ? { snapshot, visit_end: true, ...(unsure.length ? { cards: unsure } : {}) }
      : { cards: 'all', snapshot };
    write(body, { cards: shown, restartAt: new Date().toISOString() }, reason);
  }, [write]);

  // First open: no baseline yet, so take the board as shown (once per owner),
  // after every card is known and the cards stopped changing: the task store
  // fills summaries a moment after the list, and a baseline taken before that
  // would count every summary as changed.
  const firstDone = useRef<string | null>(null);
  const first = useRef<{ owner: string; loadedAt: number; sig: string; since: number }>({ owner: '', loadedAt: 0, sig: '', since: 0 });
  const serverSeen = payload ? payload.kanban_seen : undefined;
  const teamSize = (payload as { team?: unknown[] } | null)?.team?.length ?? 0;
  useEffect(() => {
    if (!ownerId || serverSeen !== null || firstDone.current === ownerId || overlays.length > 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      timer = undefined;
      if (firstDone.current === ownerId) return;
      const now = Date.now();
      const snap = snapRef.current();
      const sig = JSON.stringify(snap);
      const f = first.current;
      if (f.owner !== ownerId) first.current = { owner: ownerId, loadedAt: now, sig, since: now };
      else if (f.sig !== sig) first.current = { ...f, sig, since: now };
      const st = first.current;
      const known = Object.keys(snap).length;
      const waitLeft = FIRST_SEEN_WAIT_MS - (now - st.loadedAt);
      const settleLeft = FIRST_SEEN_SETTLE_MS - (now - st.since);
      if (waitLeft > 0 && (known < teamSize || settleLeft > 0)) {
        timer = setTimeout(attempt, Math.max(50, Math.min(waitLeft, settleLeft > 0 ? settleLeft : waitLeft)));
        return;
      }
      firstDone.current = ownerId;
      writeAll('first-open');
    };
    attempt();
    return () => { if (timer) clearTimeout(timer); };
  });

  // Visits: start while shown + present; end when hidden, or away for 5 minutes.
  const visitOpen = useRef(false);
  const visible = opts.visible;
  // A visit that ends before the first baseline exists writes nothing: the
  // next open takes the first baseline, from the board once it has loaded.
  const hasBaseline = useRef(false);
  hasBaseline.current = (serverSeen !== null && serverSeen !== undefined) || firstDone.current === ownerId;
  const endVisit = useCallback((why: string) => {
    if (!visitOpen.current) return;
    visitOpen.current = false;
    if (!hasBaseline.current) {
      log.info('board', 'kanban visit ended before a baseline', { taskId: ownerRef.current, why });
      return;
    }
    log.info('board', 'kanban visit ended', { taskId: ownerRef.current, why });
    writeAll('visit-end');
  }, [writeAll]);
  useEffect(() => {
    if (!visible) { endVisit('view-hidden'); return; }
    let awayTimer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (documentPresent()) {
        if (awayTimer) { clearTimeout(awayTimer); awayTimer = undefined; }
        visitOpen.current = true;
      } else if (visitOpen.current && !awayTimer) {
        awayTimer = setTimeout(() => { awayTimer = undefined; if (!documentPresent()) endVisit('away'); }, SEEN_AWAY_MS);
      }
    };
    check();
    window.addEventListener('focus', check);
    window.addEventListener('blur', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      if (awayTimer) clearTimeout(awayTimer);
      window.removeEventListener('focus', check);
      window.removeEventListener('blur', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [visible, endVisit]);
  // The pane closing (unmount) ends the visit too, unless the same owner's
  // board mounts again within a moment (StrictMode's simulated unmount, a
  // parent re-rendering the pane): the user is still looking at it.
  useEffect(() => {
    const owner = ownerId;
    if (!owner) return;
    mountedOwners.set(owner, (mountedOwners.get(owner) ?? 0) + 1);
    return () => {
      mountedOwners.set(owner, (mountedOwners.get(owner) ?? 1) - 1);
      setTimeout(() => {
        // Mounted again (StrictMode keeps this very instance and its refs): the visit goes on.
        if ((mountedOwners.get(owner) ?? 0) > 0) return;
        mountedOwners.delete(owner);
        endVisit('unmount');
      }, REMOUNT_GRACE_MS);
    };
  }, [ownerId, endVisit]);

  const markCardSeen = useCallback((taskId: string) => {
    const entry = snapRef.current()[taskId];
    if (!entry) return;
    // Before the first baseline: one card alone would start it, and every other
    // card would then count as new. Take the whole board as shown instead.
    if (!hasBaseline.current) {
      firstDone.current = ownerRef.current;
      writeAll('first-open');
      return;
    }
    const { snapshot } = splitSnapshot({ [taskId]: entry });
    write({ cards: [taskId], snapshot }, { cards: { [taskId]: entry } }, 'card');
  }, [write, writeAll]);
  const markAllSeen = useCallback(() => writeAll('mark-all'), [writeAll]);

  const baseline = useMemo(() => overlaySeen(serverSeen ?? null, overlays), [serverSeen, overlays]);
  return useMemo<KanbanSeenApi>(() => ({
    baseline,
    baselineAt: baseline?.at ?? null,
    previousAt: baseline?.previous_at ?? null,
    markCardSeen,
    markAllSeen,
  }), [baseline, markCardSeen, markAllSeen]);
};
