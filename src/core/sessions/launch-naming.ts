/**
 * Which text a launch is NAMED after.
 *
 * A launch message is not always the human's words. Walnut prepends two things
 * to it: the attached-image context block, and (on an ACP engine, which has no
 * system-prompt channel) the Ask agent's whole persona. Both are configuration
 * the model must read and the reader must not: a session titled
 * "[Walnut agent profile] You are the agent described below…" tells the person
 * nothing about what they asked, and the task description under it is 500
 * characters of persona.
 *
 * So the launcher carries the human's own words alongside the wire message
 * (`SessionStartEvent.namingMessage`) and every name derives from THIS. One
 * function rather than three copies of the same ternary, because the fallback is
 * the load-bearing half: a caller that prepends nothing sends no
 * `namingMessage`, and its titles must stay byte-identical to before.
 */

/**
 * The human's words when the launcher supplied them, else the message itself.
 *
 * Blank counts as absent. An empty `namingMessage` is what a caller that
 * prepended a prefix to an EMPTY message would produce (an init-only spawn with
 * an image block), and there the wire message is no better a name — the title
 * falls through to the task's own, which is what both provider paths do when the
 * text they get is empty.
 */
export function launchNamingText(message: string, namingMessage?: string): string {
  return namingMessage?.trim() ? namingMessage : message;
}
