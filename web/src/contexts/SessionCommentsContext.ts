import { createContext, useContext } from 'react';
import type { SessionPassageComment, SessionPinnedQuote } from '@/types/session';

/**
 * Quotes and comments on passages of the open session (utils/passage-comments.ts).
 * The panel owns the store (its composer sends the pending ones); the timeline
 * paints them and adds new ones from the selection pill.
 */
export interface SessionCommentsApi {
  comments: SessionPassageComment[];
  /** Add one (comment '' = a plain Quote). */
  add: (input: {
    msgId: string;
    role: 'user' | 'assistant' | 'system';
    quote: SessionPinnedQuote;
    text: string;
    comment: string;
  }) => void;
  remove: (id: string) => void;
  /** Ask the timeline to show this one's passage (a tray row's click). */
  requestJump: (id: string) => void;
  /** The newest jump request; the timeline lands each `seq` once. */
  jump: { id: string; seq: number } | null;
  /** FALSE for the stub: no record to write, so the pill keeps the old text path. */
  canComment: boolean;
}

const EMPTY: SessionCommentsApi = {
  comments: [],
  add: () => {},
  remove: () => {},
  requestJump: () => {},
  jump: null,
  canComment: false,
};

export const SessionCommentsContext = createContext<SessionCommentsApi>(EMPTY);

export function useSessionCommentsApi(): SessionCommentsApi {
  return useContext(SessionCommentsContext);
}
