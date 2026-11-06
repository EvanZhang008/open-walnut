/**
 * The words of a start waiting for room on a host, as the server writes them (src/core/user-status.ts
 * queuedWaitingOn; tests/web/start-queue-words.test.ts keeps the two the same). The web reads the
 * server's status first and these only for a status not derived yet.
 */
export function startQueueWords(q: { host?: string; reason?: string }): string {
  const host = !q.host ? 'a host' : q.host === '__local__' ? 'this Mac' : q.host;
  return `Queued by an older Walnut for room on ${host}${q.reason ? ` (${q.reason})` : ''}: Walnut tries it once more, then says why if it does not start`;
}
