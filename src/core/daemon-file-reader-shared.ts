/**
 * The values daemon-file-reader.ts exports besides its class, in a module of their own with no
 * dependencies, so the test double of the reader (tests/helpers/mock-local-daemon-reader.ts)
 * exports the very same ones and a mocked module never lacks an export the real one has.
 */

/** A stream larger than this ran long past any boot: not read, reads as unknown. */
export const STREAM_EVIDENCE_MAX_BYTES = 1024 * 1024

/** Whether stream text holds a line the CLI writes only inside a conversation:
 *  a top-level `assistant` or `result` line (parsed, so a message that quotes
 *  one inside a string never counts). A resume's own refusal ("No conversation
 *  found", a result line too) is the opposite evidence and never counts. */
export function streamTextHeldConversation(text: string): boolean {
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"') && !line.includes('"result"')) continue
    try {
      const ev = JSON.parse(line) as { type?: unknown; is_error?: unknown }
      if (ev.type === 'result' && ev.is_error === true && line.includes('No conversation found')) continue
      if (ev.type === 'assistant' || ev.type === 'result') return true
    } catch { /* a torn or foreign line */ }
  }
  return false
}

/**
 * The daemon on this host predates a capability the caller needs.
 *
 * Thrown (never swallowed) so the HTTP edge can answer with something the user
 * can act on: the daemon auto-upgrades on the next session message to that host,
 * so "try again in a moment" is the whole remedy. Distinct class because the
 * route maps it to 501, not to the generic 502 "remote failed".
 */
export class DaemonNeedsUpgradeError extends Error {
  constructor(public host: string, public capability = 'fs-mutate-v1') {
    super(
      `The Walnut daemon on ${host} needs an upgrade before it can change files ` +
      `(missing '${capability}'). It upgrades itself the next time you send a message ` +
      'to a session on that host — try again after that.',
    )
    this.name = 'DaemonNeedsUpgradeError'
  }
}
