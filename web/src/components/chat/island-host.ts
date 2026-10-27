/**
 * What an html-app island knows about the conversation it sits in.
 *
 * The session names the island's saved state (island-store.ts), and `sendResult` is
 * how the user's press of "Send to AI" reaches that session: the same send the
 * composer makes, so the result shows as the user's own message. Outside a session
 * (or a surface with no send) an island still keeps its state for the window and its
 * result card offers Copy instead of Send.
 */
import { createContext } from 'react';

export interface IslandHost {
  sessionId: string | null;
  /** Resolves true once the session accepted the message. */
  sendResult?: (text: string) => Promise<boolean>;
}

export const IslandHostContext = createContext<IslandHost>({ sessionId: null });
