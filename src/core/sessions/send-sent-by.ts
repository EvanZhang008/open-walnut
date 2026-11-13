/**
 * Who a send to a session came from, read from its source: a person's own words
 * or an agent's (another task, Walnut's notices, triggers, routines, hooks).
 * Pure and dependency-free, so callers that mock the queue still get the rule.
 */
import { CALLER_KIND_HEADER, SENDER_LABEL_HEADER, senderLabel } from '../../lib/cli-sender.js';

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

/**
 * Sources of a task's FIRST message that a person typed (the quick-start composer, the phone's
 * launch). A start also counts as a person's whenever its source is a send source above; the
 * first line of anything else is framed (send-frame.ts).
 */
export const PERSON_START_SOURCES: ReadonlySet<string> = new Set([
  'quick-start', 'quick-input', 'mobile-launch', 'mobile-launch-bridge', 'cloud-exec-launch',
]);

/** True when `source` names a person typing: a send source, a letter answer, or a person's start. */
export function isPersonSource(source: string | undefined): boolean {
  return queueSentBy(source) === 'person' || PERSON_START_SOURCES.has(source ?? '');
}

type HeaderBag = Record<string, string | string[] | undefined>;
const headerOf = (headers: HeaderBag, name: string): string => {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
};

/**
 * The source a route reports for a request: its person source, unless the request is not a person's.
 * An agent's request names its session (`x-walnut-caller-sid`, put on every request made through the
 * `walnut` CLI, the `api` op or MCP) and a script's names itself an automation
 * (`x-walnut-caller-kind`, cli-sender.ts). Either one reaching a person's route is not a person.
 */
export function routeSource(personSource: string, headers: HeaderBag): string {
  return headerOf(headers, 'x-walnut-caller-sid') || headerOf(headers, CALLER_KIND_HEADER) === 'automation'
    ? 'api-agent' : personSource;
}

/** A first message needs the automation's name as well as its sender class. */
export function startRouteSource(personSource: string, headers: HeaderBag): string {
  if (headerOf(headers, 'x-walnut-caller-sid')) return 'api-agent';
  const kind = headerOf(headers, CALLER_KIND_HEADER).toLowerCase();
  if (kind && !['person', 'human'].includes(kind)) {
    return `automation:${senderLabel(headerOf(headers, SENDER_LABEL_HEADER))}`;
  }
  return personSource;
}
