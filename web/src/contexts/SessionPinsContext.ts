import { createContext, useContext } from 'react';
import type { SessionPinnedMessage } from '@/types/session';

/**
 * Pinned messages for the open session, shared by the timeline's TOC and the
 * per-message pin button.
 *
 * Context rather than props for the same reason PlanContentContext exists: the
 * pin button lives inside `SessionMessage`, which is memoized and sits several
 * layers below the panel that owns the session record. Threading props would
 * either re-render every row on every pin, or (with the memo) not re-render the
 * one row that changed.
 */
export interface SessionPinsApi {
  pins: SessionPinnedMessage[];
  /** Fast membership test for the per-row button. */
  isPinned: (msgId: string | undefined) => boolean;
  /** Pin when absent, unpin when present. No-op without a msgId (a row with no
   *  stable id has nothing a TOC entry could point at after a reload). */
  toggle: (message: { msgId?: string; role: 'user' | 'assistant' | 'system'; text?: string; timestamp?: string }) => void;
  unpin: (msgId: string) => void;
}

const EMPTY: SessionPinsApi = {
  pins: [],
  isPinned: () => false,
  toggle: () => {},
  unpin: () => {},
};

export const SessionPinsContext = createContext<SessionPinsApi>(EMPTY);

export function useSessionPinsApi(): SessionPinsApi {
  return useContext(SessionPinsContext);
}
