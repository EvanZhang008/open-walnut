/**
 * Whether a failed `gh` call is GitHub's passing trouble (a 5xx, a 429, the network),
 * worth asking again, rather than an answer (a 404, a 401, signed out). The one matcher
 * every script that retries gh reads (scripts/ci-gate.mjs, scripts/ci-runner-retry.mjs).
 * 2026-11-13 (Release run 43523718216): gh's own words for a failed connection,
 * "error connecting to api.github.com", were not on the list, so the nightly's
 * green-commit pick failed on its first try.
 */
export function isTransientGhFailure(text) {
  return /HTTP (5\d\d|429)|Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|error connecting to|connection (refused|reset)|unexpected EOF|TLS handshake timeout|i\/o timeout|timed out|no such host|network is unreachable|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(String(text))
}
