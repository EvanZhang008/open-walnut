/**
 * The names of the composer's two direct buttons, one copy for every place that shows them
 * (the button, its "+" menu row, the controls row's overflow row, the side chat's own pill).
 * A plain module with no imports, so a light entry that draws a composer loads nothing more.
 *
 * Side chat: never "side thread" or "btw" (a thread is the user's Threads; standard.md, "Words").
 * Session note: the person's own note on a session; it is never sent to the agent
 * (src/ops/launch-parity.ts: human_note).
 */
export const SIDE_CHAT_LABEL = 'Side chat';
export const SIDE_CHAT_TITLE = 'Ask a side question in a separate chat; the main session never sees it';
export const SESSION_NOTE_LABEL = 'Session note';
export const SESSION_NOTE_TITLE = 'Add a note to this session; the agent does not see it';
