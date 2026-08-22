/**
 * Route-error identity: what makes "this endpoint is failing" ONE condition.
 *
 * The live feed's worst offender was nine separate red cards for one broken
 * endpoint. The request logger's error line embedded the request latency
 * (`GET /api/ui-prefs → 500 (23ms)`), and the log-error bridge hashes the log
 * MESSAGE — so every occurrence with a different duration minted a fresh card,
 * and none of them could ever be retired because the identity kept moving.
 *
 * Two things fix that, and both need the same normalization, so it lives here:
 *   - the error log MESSAGE becomes `<METHOD> <normalizedPath> → <status>`
 *     (latency and query string move to the meta, which is outside the bridge's
 *     dedup allowlist), so repeats fold into ONE record with a count;
 *   - the record's recoveryKey becomes `route:<METHOD> <normalizedPath>`, so the
 *     next non-5xx response on the same endpoint retires the whole family.
 *
 * A leaf module with no imports: the request logger is on every request's hot
 * path and must not gain an import edge into the notification store, and the
 * normalizer itself is worth unit-testing without booting a server.
 */

/**
 * A path segment that identifies an ENTITY rather than naming the route.
 *
 * Deliberately stricter than the metrics logger's heuristic in the same
 * middleware: this one feeds a user-visible card title, so a wrongly collapsed
 * segment would show the user a route they never called. Recognized shapes:
 *   - UUID (8-4-4-4-12 hex, any case)
 *   - a long hex run (>= 16 chars, hex only) — session/claude ids, sha-ish ids
 *   - pure digits — numeric ids
 * A route WORD keeps its shape: `ui-prefs`, `notes-v2`, `search-memory-v1`,
 * `mark-read` all fail every branch (letters outside hex, or too short).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;
const NUMERIC_RE = /^\d+$/;

/** Whether a single path segment is an id (and should collapse to `:id`). */
export function isIdSegment(segment: string): boolean {
  return UUID_RE.test(segment) || LONG_HEX_RE.test(segment) || NUMERIC_RE.test(segment);
}

/**
 * The stable route identity of a request URL: query string dropped, id segments
 * replaced by `:id`.
 *
 * Unlike the metrics `routeGroup` in the same middleware, the path is NOT
 * truncated to N segments — this string is shown to a human in a card title, and
 * `PUT /api/tasks/:id/phase` failing is a different thing to fix than
 * `PUT /api/tasks/:id/note`. Cardinality is bounded by the route table, and only
 * FAILING routes ever become records.
 */
export function normalizeRoutePath(url: string): string {
  // Fragment first, then query: a URL can carry both, and only the path matters.
  const path = url.split('#')[0].split('?')[0];
  if (!path) return url;
  // Trailing slash is not a distinct route (Express treats them the same by
  // default) — normalize it away so /api/x and /api/x/ share one condition.
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed
    .split('/')
    .map((seg) => (isIdSegment(seg) ? ':id' : seg))
    .join('/');
}

/** The condition id for a route: `route:<METHOD> <normalizedPath>`. */
export function routeRecoveryKey(method: string, url: string): string {
  return `route:${method} ${normalizeRoutePath(url)}`;
}

/**
 * The log MESSAGE for a request outcome, with NO latency and NO query string.
 *
 * The bridge fingerprints the message, so anything varying per occurrence in
 * here becomes a new card. Latency/query/reqId all still ride the meta, which
 * the bridge's DEDUP_META_KEYS allowlist excludes.
 */
export function routeLogMessage(method: string, url: string, status: number): string {
  return `${method} ${normalizeRoutePath(url)} → ${status}`;
}
