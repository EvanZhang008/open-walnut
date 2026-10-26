/**
 * Who a send to a session came from, read from its source: a person's own words
 * or an agent's (another task, Walnut's notices, triggers, routines, hooks).
 * Pure and dependency-free, so callers that mock the queue still get the rule.
 */

/**
 * Send sources a person typed into the session (phase.ts REOPENING_SEND_SOURCES
 * minus the peer and letter paths). Their rows answer a pending permission
 * prompt (QueuedMessage.closesPrompt); every other row waits behind it.
 */
export const PERSON_SEND_SOURCES: ReadonlySet<string> = new Set(['ui', 'mobile', 'cli', 'web-api', 'api-v1', 'chat']);

/** Sources beyond PERSON_SEND_SOURCES that carry a person's own words. */
const PERSON_ONLY_SOURCES: ReadonlySet<string> = new Set([
  'human-inbox',    // a letter the person answered (human-inbox/letter-ops.ts)
  'side-thread',    // a side-thread question the person asked (sessions/side-thread-manager.ts)
  'cloud-fallback', // the person's chat on the companion (web/routes/cloud-chat-fallback.ts)
]);

/**
 * Who a send came from, by its source (QueuedMessage.sentBy): a person's words
 * (PERSON_SEND_SOURCES, a letter they answered, a side-thread question they
 * asked) or an agent's (another task, Walnut's notices, triggers, routines,
 * hooks). No source says nothing, so nothing is folded for it.
 */
export function queueSentBy(source: string | undefined): 'person' | 'agent' | undefined {
  if (!source) return undefined;
  return PERSON_SEND_SOURCES.has(source) || PERSON_ONLY_SOURCES.has(source) ? 'person' : 'agent';
}
