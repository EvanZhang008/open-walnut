/**
 * How a session panel draws Fork, Board and Locate on this frame (live, as
 * spacers, or not at all), with the memory taskControlSlot needs: whether
 * this panel already drew them for the session it shows.
 *
 * The memory is per session. A host that hands a mounted panel another
 * session (the plugin session view renders one panel and changes its id)
 * starts it over, so that session's own first frame decides.
 *
 * A panel that adopts its session's canonical id (a deep link or a chat
 * reference names it by a prefix) is replaced by the host with a panel under
 * the full id, which would start with no memory. The old panel hands what it
 * drew over (`handOver`), and the new one reads it on its first frame. Only
 * there: a panel that already showed the full id when the host folded the
 * prefix column into it never reads it (2026-10-11: it grew three spacers at
 * its next render and moved Changed, Files and Terminal under a click). A
 * hand-over that no new panel took dies with the panel that made it, so a
 * later fresh panel for that session decides from its own first frame again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { taskControlSlot, type HeaderTaskPresence, type TaskControlSlot } from './header-record-gate';

/** Canonical ids a replaced panel drew the three for, until a new panel for that id has mounted. */
const handedOver = new Set<string>();

interface Drawn { sessionId: string; drawn: boolean }

export interface TaskControlSlots {
  slot: TaskControlSlot;
  /** The panel is about to be replaced by one under `canonicalId`: that one starts from what this one drew. */
  handOver: (canonicalId: string) => void;
}

export function useTaskControlSlot(sessionId: string, presence: HeaderTaskPresence): TaskControlSlots {
  const [drawn, setDrawn] = useState<Drawn>(() => ({ sessionId, drawn: handedOver.has(sessionId) }));
  let next = drawn;
  if (next.sessionId !== sessionId) next = { sessionId, drawn: handedOver.has(sessionId) };
  if (presence !== 'none' && !next.drawn) next = { sessionId, drawn: true };
  if (next !== drawn) setDrawn(next);
  const slot = taskControlSlot(presence, next.drawn);

  // Read once this panel shows the session: the hand-over is spent.
  useEffect(() => { handedOver.delete(sessionId); }, [sessionId]);
  const slotRef = useRef(slot);
  slotRef.current = slot;
  const handed = useRef<string | null>(null);
  useEffect(() => () => { if (handed.current) handedOver.delete(handed.current); }, []);
  const handOver = useCallback((canonicalId: string) => {
    if (slotRef.current === 'absent') return;
    handedOver.add(canonicalId);
    handed.current = canonicalId;
  }, []);
  return { slot, handOver };
}

/** Test hook: whether a hand-over for `sessionId` is waiting. */
export function _taskSlotHandOverPendingForTests(sessionId: string): boolean {
  return handedOver.has(sessionId);
}
