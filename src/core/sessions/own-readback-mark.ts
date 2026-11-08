/**
 * The first words of the org role line that tells Main or a VP about its own readback
 * (session-context.ts OWN_READBACK_LINE; own-readback.ts). A prompt holding them was built by a
 * Walnut that gives the session the own-readback hook, so the spawn adds the hook only then and the
 * compaction's open_items leaves MEMORY.md to it: an older prompt a resume replays keeps both as before.
 * Its own module so the spawn reads it without the readback's imports.
 */
export const OWN_READBACK_MARK = 'At the start of every new conversation and after every compaction, Walnut reads back to you';

/**
 * The readback is on unless WALNUT_OWN_READBACK=0. Read at spawn for the prompt line and the hook
 * together, and again at a compaction and in the route: a session spawned with it while it was
 * on, then turned off, reads MEMORY.md in open_items again and the hook gets nothing.
 */
export function ownReadbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WALNUT_OWN_READBACK !== '0';
}
