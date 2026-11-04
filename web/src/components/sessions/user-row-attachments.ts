/**
 * A host's own line under a person's message, drawn from the hints the message went with: the
 * browser side panel shows the text the person attached from the page as a small quote under
 * their bubble (web/src/popout/PopoutExtPanel.tsx). A sent bubble carries the hints it asked for
 * (`requestedHints`), a saved row the hints Walnut put beside it (`hints`). No other surface
 * provides one, so nothing is drawn there.
 */
import { createContext, type ReactNode } from 'react';
import type { CarriedHint } from '@open-walnut/hint-format';

export interface UserRowHints {
  hints?: CarriedHint[];
  requestedHints?: Record<string, { arg?: string }>;
  /** The person's words as the row shows them (a first message's bubble carries no hints of its own). */
  text?: string;
}

export const UserRowAttachmentsContext = createContext<((row: UserRowHints) => ReactNode) | null>(null);
