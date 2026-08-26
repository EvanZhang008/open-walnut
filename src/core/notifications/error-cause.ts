/**
 * Root-cause identity for error notifications: the `causeKey`.
 *
 * `recoveryKey` identifies the CONDITION a card is about (`task:<id>`,
 * `route:GET /api/x`, `session:<sid>`) — but one underlying outage fans out into
 * MANY conditions. A host whose SSH/daemon link is down produces a session-start
 * failure keyed `task:<id>`, route 5xx cards keyed `route:…`, and delivery
 * failures keyed `session:<sid>`, and each of those waits for its OWN success
 * signal that may never re-fire (nobody re-opens that plan view; that task never
 * retries). The result was a wall of red that outlived the outage.
 *
 * `causeKey` is the second identity that cuts across conditions: every card the
 * same root cause produced carries the same key, so ONE recovery signal (the
 * daemon reconnecting to that host) retires all of them at once, and the UI can
 * fold them into a single group while they're firing.
 *
 * Shapes in use: `host:<alias>` — the host's SSH/daemon link is down. The key is
 * only ever derived when BOTH a connectivity signature AND a concrete host are
 * identifiable; a confident wrong grouping is worse than no grouping, so
 * everything ambiguous stays keyless and keeps today's behavior.
 *
 * Pure and import-free ON PURPOSE: the log-error bridge is installed by the
 * logging layer's sink and must stay leaf-ish (see the import-closure note in
 * log-error-bridge.ts), and a classifier is worth unit-testing without booting
 * anything.
 */

/** The causeKey for a host whose SSH/daemon link is the root cause. */
export function hostCauseKey(host: string): string {
  return `host:${host}`;
}

/** The host alias inside a `host:<alias>` causeKey, or null for other shapes. */
export function hostOfCauseKey(causeKey: string): string | null {
  if (!causeKey.startsWith('host:')) return null;
  return causeKey.slice('host:'.length) || null;
}

/**
 * Connectivity signatures — the error shapes the daemon/SSH layer actually
 * produces when a host link is down (each literal is pinned to a producer):
 *   - deploy/start failures: daemon-connection.ts deploySource/deployBinary/
 *     startDaemon ("Failed to deploy daemon source to <host>: …")
 *   - the failure-cache retry shape: "Connection to <host> failed Ns ago: …"
 *   - send() on a dead pool entry: "DaemonConnection not connected to <host>"
 *   - "daemon command timeout" (send() deadline)
 *   - ssh/socket-level failures: connection lost/closed/refused/reset/timed out,
 *     no route to host, host unreachable, ssh tunnel errors, and the errno
 *     tokens a wrapped ssh spawn surfaces.
 * Mirrors the spirit of INFRA_TEXT_SIGNATURES (session-error-kind.ts) but stays
 * its own list: that one classifies session records for auto-recovery, this one
 * gates a cross-condition grouping — different blast radius, different bar.
 */
const CONNECTIVITY_RE = new RegExp(
  [
    'failed to deploy daemon',
    'failed to start daemon',
    'daemon spawn failed',
    'daemon command timeout',
    'not connected to',
    // The failure-cache shape only — bare "connection to X failed" is generic
    // English any plugin's HTTP error could produce about a database.
    'connection to \\S+ failed \\d+s ago',
    'connection (?:lost|closed|refused|reset|timed out)',
    'no route to host',
    'host unreachable',
    'ssh tunnel',
    'command failed: ssh',
    '\\bE(?:CONNREFUSED|CONNRESET|TIMEDOUT|HOSTUNREACH|NETUNREACH|PIPE)\\b',
  ].join('|'),
  'i',
);

/**
 * Host-naming patterns, tried in order. Each one anchors on a producer's fixed
 * wording so the captured token really is a host alias — a bare "word after a
 * preposition" heuristic would happily capture a path segment or a session id.
 */
const TEXT_HOST_RES: RegExp[] = [
  /failed to deploy daemon (?:source|binary) to ([\w.-]+?):/i,
  /failed to start daemon on ([\w.-]+?):/i,
  // The `\d+s ago` suffix pins this to the failure-cache producer — a plugin's
  // "connection to database failed" must not mint a `host:database` group.
  /connection to ([\w.-]+) failed \d+s ago/i,
  // The full producer wording, not the bare phrase: "not connected to (\S+)"
  // alone would capture "the" out of prose like "not connected to the daemon"
  // and mint a junk `host:the` group whose recovery signal never arrives.
  /DaemonConnection not connected to ([\w.-]+)/i,
];

/**
 * A host value that can carry a `host:` cause. The local transport has no SSH
 * link — a local failure is never a connectivity condition, and `host:__local__`
 * would recover on every boot's daemon warm-up, stamping 'recovered' on cards
 * whose real cause was something else entirely.
 */
function usableHost(host: string | undefined): string | null {
  const h = (host ?? '').trim();
  if (!h || h === 'local' || h === '__local__' || h === 'localhost') return null;
  return h;
}

/** First host the TEXT names, if any pattern matches. */
function hostFromText(text: string): string | null {
  for (const re of TEXT_HOST_RES) {
    const m = re.exec(text);
    const h = usableHost(m?.[1]);
    if (h) return h;
  }
  return null;
}

/**
 * Derive the causeKey for one error, or undefined when no confident cause exists.
 *
 * `text` is everything the caller knows about the failure (title + body + the
 * error strings out of log meta, newline-joined — exact composition is the
 * caller's). `host` is a structured hint (log meta / session record) that wins
 * over text parsing when present.
 *
 * BOTH gates must pass: a connectivity signature in the text AND a resolvable
 * non-local host. A plugin's `write EPIPE` against some external API matches the
 * errno signature but names no host → keyless, correctly. A missing-cwd spawn
 * failure carries a host but no connectivity signature → keyless, correctly.
 */
export function causeKeyForError(input: { text: string; host?: string }): string | undefined {
  const text = input.text ?? '';
  if (!CONNECTIVITY_RE.test(text)) return undefined;
  const host = usableHost(input.host) ?? hostFromText(text);
  return host ? hostCauseKey(host) : undefined;
}
