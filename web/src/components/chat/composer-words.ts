/**
 * The names of the composer's two direct buttons, one copy for every place that shows them
 * (the button, its "+" menu row, the controls row's overflow row, the side chat's own pill).
 * A plain module with no imports, so a light entry that draws a composer loads nothing more.
 *
 * Side chat: its button and every place that names it read "btw", the user's own name for it
 * (2026-11-22 and 11-23, after dc9949e416 had renamed it "Side chat"); never "side thread"
 * (a thread is the user's Threads; standard.md, "Words").
 * Notes: the person's own note on a session; it is never sent to the agent
 * (src/ops/launch-parity.ts: human_note). The user named it "Notes" (2026-11-23), not "Session note":
 * every place that shows it reads this constant (tests/web/session-note-label-guard.test.ts).
 */
export const SIDE_CHAT_LABEL = 'btw';
export const SIDE_CHAT_TITLE = 'Ask a side question in a separate chat; the main session never sees it';
export const SESSION_NOTE_LABEL = 'Notes';
export const SESSION_NOTE_TITLE = 'Add a note to this session; the agent does not see it';
