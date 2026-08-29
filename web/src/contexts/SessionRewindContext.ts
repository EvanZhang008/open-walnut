import { createContext, useContext } from 'react';

/**
 * Rewind entry point for message rows. The row only ASKS; the panel owns the
 * confirm dialog (it needs the dry-run round-trip, the file-restore choice, and
 * somewhere to navigate afterwards), so the button stays a one-liner and no
 * dialog state lives inside a memoized transcript row.
 */
export interface SessionRewindApi {
  /** False when this session can't rewind at all (Codex/ACP engine, or no
   *  session id yet) — the button hides rather than failing on click. */
  available: boolean;
  /** Open the confirm dialog for a rewind back to this message. */
  request: (msgId: string, label?: string) => void;
}

const UNAVAILABLE: SessionRewindApi = { available: false, request: () => {} };

export const SessionRewindContext = createContext<SessionRewindApi>(UNAVAILABLE);

export function useSessionRewindApi(): SessionRewindApi {
  return useContext(SessionRewindContext);
}
