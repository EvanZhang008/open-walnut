import { createContext, useContext } from 'react';
import type { SessionPinnedMessage, SessionPinnedQuote } from '@/types/session';

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
  /** Does a WHOLE-message pin exist for this row? The meta-row icon's semantics:
   *  quote pins inside the message deliberately do NOT light it up, since the
   *  button would then unpin something the user never pressed it for. */
  isPinned: (msgId: string | undefined) => boolean;
  /** Pin/unpin the WHOLE message. No-op without a msgId (a row with no stable id
   *  has nothing a TOC entry could point at after a reload). Leaves the message's
   *  quote pins alone. */
  toggle: (message: { msgId?: string; role: 'user' | 'assistant' | 'system'; text?: string; timestamp?: string }) => void;
  /** Pin a passage inside a message. Idempotent for an identical selection. */
  pinQuote: (input: {
    msgId: string;
    role: 'user' | 'assistant' | 'system';
    timestamp?: string;
    quote: SessionPinnedQuote;
  }) => void;
  /** Remove one pin by its key (`pin.id ?? pin.msgId` — see pinKeyOf). */
  unpin: (pinKey: string) => void;
  /**
   * Is a real pin store behind this api? FALSE for the stub providers, and the
   * gate for mounting the selection pill.
   *
   * The pill is an invitation, so it must never appear where pinning cannot work.
   * A timeline mounted with a stub (the side-question drawer passes one, since a
   * side thread has no session record to PATCH) offered "Pin", cleared the
   * selection on click, and created nothing — the worst possible outcome for a
   * one-shot gesture the user cannot tell failed.
   */
  canPinQuote: boolean;
}

const EMPTY: SessionPinsApi = {
  pins: [],
  isPinned: () => false,
  toggle: () => {},
  pinQuote: () => {},
  unpin: () => {},
  canPinQuote: false,
};

export const SessionPinsContext = createContext<SessionPinsApi>(EMPTY);

export function useSessionPinsApi(): SessionPinsApi {
  return useContext(SessionPinsContext);
}
