import { createContext, useContext } from 'react';
import type { SessionPassageComment, SessionPassageCommentDoc, SessionPinnedQuote } from '@/types/session';

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
    /** About a passage of a document (its comment lives in the doc's sidecar). */
    doc?: SessionPassageCommentDoc;
    /** The Tree Mode page it was made on (a thread key, '' = the main conversation). */
    pageKey?: string;
  }) => void;
  /**
   * Change a pending one's words (a plain Quote given words becomes a comment).
   * FALSE when it cannot be: sent, being sent, taken out, a doc's, or no words.
   */
  update: (id: string, comment: string) => boolean;
  remove: (id: string) => void;
  /**
   * Ask the timeline (or, for a doc's entry, its doc) to show this one's passage (a
   * tray row's click); `edit` also opens its card with the words in the editor,
   * at `origin` (the row, a viewport point) when its passage cannot be shown.
   */
  requestJump: (id: string, opts?: { edit?: boolean; origin?: { x: number; y: number } }) => void;
  /** The newest jump request; each `seq` lands once, `at` = when it was asked. */
  jump: { id: string; seq: number; at: number; edit?: boolean; origin?: { x: number; y: number } } | null;
  /** FALSE for the stub: no record to write, so the pill keeps the old text path. */
  canComment: boolean;
}

const EMPTY: SessionCommentsApi = {
  comments: [],
  add: () => {},
  update: () => false,
  remove: () => {},
  requestJump: () => {},
  jump: null,
  canComment: false,
};

export const SessionCommentsContext = createContext<SessionCommentsApi>(EMPTY);

export function useSessionCommentsApi(): SessionCommentsApi {
  return useContext(SessionCommentsContext);
}
