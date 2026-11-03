/**
 * A turn that ended because its machine could not reach the model endpoint at all (2026-11-03: the
 * Mac's local model proxy went down with its login session, and eight sessions ended on "API Error:
 * Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)" and read Needs you).
 * The request never reached the model, so it cost nothing, and the same turn goes through once the
 * endpoint answers again: the task waits on its machine (sessions/endpoint-wait.ts), not on the user.
 *
 * Only the connection layer: the address does not resolve, nothing listens, the network or host is
 * unreachable, the connection closed before any answer. Never an answer the endpoint gave (401, 403,
 * 429, 5xx, a refusal, a prompt too long) and never a timeout or reset mid-response, which may have
 * reached the model: those stay with the daemon's turn retry and session-auto-continue. Each pattern
 * is also one of the daemon's retryable turn errors (providers/daemon-core.ts classifyTurnError),
 * and the server checks that first, so a text that is also terminal is never one of these.
 *
 * tests/core/sessions/endpoint-unreachable-corpus.test.ts holds every error text known to Walnut
 * with its class and fails on a pattern no text exercises.
 *
 * Pure and browser-safe.
 */
import type { SessionEndpointWait } from '../types.js';

export const ENDPOINT_UNREACHABLE_PATTERNS: readonly RegExp[] = [
  // The Claude Code CLI's own words for ECONNREFUSED, and the code itself.
  /connection refused/i,
  /\bECONNREFUSED\b/,
  // The name does not resolve (DNS down, offline, a host name that is gone).
  /\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo/i,
  // No route: the network or the host is down or unreachable.
  /\bEHOSTUNREACH\b|\bENETUNREACH\b|\bEHOSTDOWN\b|\bENETDOWN\b/,
  /unable to connect/i,
  // fetch's own wrapper for a connection it could not make.
  /fetch failed/i,
  // The connection closed before any answer came back.
  /socket hang up/i,
  // The Anthropic SDK's APIConnectionError: no response at all.
  /\bconnection error\b/i,
];

/** The text names a connection the endpoint never answered. Pair it with classifyTurnError. */
export function matchesEndpointUnreachable(text: string | null | undefined): boolean {
  if (!text) return false;
  return ENDPOINT_UNREACHABLE_PATTERNS.some((re) => re.test(text));
}

/** The endpoint wait is on (WALNUT_ENDPOINT_WAIT=0 turns it off; then session-auto-continue retries these). */
export function endpointWaitEnabled(): boolean {
  return typeof process === 'undefined' || process.env?.WALNUT_ENDPOINT_WAIT !== '0';
}

/** The endpoint as a person reads it: its URL on its machine, or the machine alone. */
export function endpointWords(w: Pick<SessionEndpointWait, 'url' | 'where'>): string {
  return w.url ? `the model endpoint ${w.url} on ${w.where}` : `the model endpoint on ${w.where}`;
}

/** What the user is asked once the wait gave up. Pure (user-status.ts and the error card say the same). */
export function endpointGaveUpWords(w: Pick<SessionEndpointWait, 'url' | 'where' | 'since' | 'resumes' | 'gaveUpWhy'> & { probeError?: string }): string {
  const what = endpointWords(w)
  const head = what.charAt(0).toUpperCase() + what.slice(1)
  const since = w.since.slice(0, 16).replace('T', ' ')
  // Its host was away at the last look ('host offline', endpoint-wait.ts HOST_OFFLINE): the machine is the news.
  if (w.gaveUpWhy !== 'resumes' && w.probeError === 'host offline') {
    return `${w.where.charAt(0).toUpperCase() + w.where.slice(1)} has not been connected since ${since} UTC, so Walnut stopped waiting for its model endpoint. Bring it back, then Retry the session.`
  }
  return w.gaveUpWhy === 'resumes'
    ? `${head} answers, but its turns still could not reach it (${w.resumes} tries). Check it there, then Retry the session.`
    : `${head} has not answered since ${since} UTC, so Walnut stopped waiting. Start it there, then Retry the session.`
}
