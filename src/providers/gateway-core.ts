/**
 * Agent gateway — shared pure protocol logic for the daemon twins.
 *
 * daemon-standalone.ts imports this directly (bundled into the bun binary);
 * daemon-source.ts mirrors the logic by hand (it cannot import). Keep the
 * two in sync when changing anything here.
 *
 * Zero I/O and dependency-free by design so the bun daemon build can bundle
 * it and L1 unit tests can exercise every branch.
 */

// ── Constants ──

export const GATEWAY_SOCKET_FILENAME = 'agent-gateway.sock';

/**
 * Well-known daemon dir. Duplicated from local-daemon.ts on purpose: the daemon
 * twins are standalone deploy artifacts and cannot import server code.
 */
export const PROD_DAEMON_DIR = '/tmp/open-walnut';

/**
 * Well-known gateway socket path — what `walnut` falls back to when no
 * WALNUT_AGENT_SOCKET was injected (a hand-started agent, or the user's own
 * terminal, on a host that runs a daemon). WALNUT_DAEMON_DIR override honoured
 * so tests and ephemeral daemons stay isolated.
 */
export function wellKnownGatewaySocketPath(env?: Record<string, string | undefined>): string {
  return wellKnownGatewaySocketPaths(env)[0];
}

/**
 * Every well-known socket, in the order to try: the WALNUT_DAEMON_DIR one alone
 * when it is set; otherwise /tmp/open-walnut, then $HOME/.cache/open-walnut
 * (where a connect moves the daemon when /tmp is read-only, noexec or full).
 */
export function wellKnownGatewaySocketPaths(env?: Record<string, string | undefined>): string[] {
  const e: Record<string, string | undefined> = env ?? (typeof process !== 'undefined' ? process.env : {});
  if (e.WALNUT_DAEMON_DIR) return [`${e.WALNUT_DAEMON_DIR.replace(/\/+$/, '')}/${GATEWAY_SOCKET_FILENAME}`];
  const home = (e.HOME || '').replace(/\/+$/, '');
  return [
    `${PROD_DAEMON_DIR}/${GATEWAY_SOCKET_FILENAME}`,
    ...(home ? [`${home}/.cache/open-walnut/${GATEWAY_SOCKET_FILENAME}`] : []),
  ];
}

/**
 * Caller sid a `walnut` invocation sends when it has no WALNUT_SESSION_ID.
 *
 * PROVENANCE LABEL, NEVER AUTHORIZATION. The gateway socket is owner-only 0600
 * and that mode is the entire credential, so whoever sends this sid is already
 * the user who owns the daemon; the label only tells the hub "this did not come
 * from a tracked session" so a letter's sender is stamped honestly. The hub
 * must never grant 'external' anything a tracked session cannot do.
 */
export const EXTERNAL_CALLER_SID = 'external';

/** True for the env-less caller label. Session ids are UUIDs, so no collision. */
export function isExternalCallerSid(sid: string): boolean {
  return sid === EXTERNAL_CALLER_SID;
}

/**
 * caller-proof-v1: a daemon that reads the process on its gateway socket (socket-peer-pid.ts)
 * tells the server whether that process runs inside the session it names, as `callerProof` on the
 * relayed payload. Only the daemon writes it: whatever a caller put there is dropped first, in
 * both twins, and the server reads it only from a daemon that advertises this capability.
 */
export const CALLER_PROOF_CAPABILITY = 'caller-proof-v1';
/** The ops whose server side reads the proof: the rest relay as before, with no process lookup. */
export const CALLER_PROOF_OPS: readonly string[] = ['approval_request', 'approval_consume'];

export interface CallerProof {
  v: 1
  /** The asking process descends from the session's own process (its CLI or ACP worker). */
  verified: boolean
  pid?: number
  /** The name of the process that started the asker, and its command line. */
  process?: string
  ranBy?: string
}

/** The payload with no `callerProof` of the caller's own. Pure. */
export function withoutCallerProof<T extends Record<string, unknown>>(payload: T): T {
  if (!payload || typeof payload !== 'object' || !('callerProof' in payload)) return payload;
  const { callerProof: _dropped, ...rest } = payload;
  return rest as T;
}

/** Whether this relayed payload is one the daemon checks the asking process for. Pure. */
export function wantsCallerProof(capability: string, payload: Record<string, unknown> | undefined): boolean {
  return capability === 'tools.call' && typeof payload?.name === 'string' && CALLER_PROOF_OPS.includes(payload.name);
}

/**
 * Hard cap on a single NDJSON request line (bytes). Oversized → reject + close.
 *
 * 28MB, not the original 256KB: one `walnut tools call human_inbox_send` is ONE
 * line, so this bound WAS the letter body cap (200KB), and a daily digest that
 * embeds its podcast as base64 audio or video is megabytes.
 *
 * It bounds the INLINE lane ONLY, and is no longer the ceiling on what an agent
 * can send. A payload over GATEWAY_INLINE_ARGS_MAX_BYTES (1MB) travels as a PATH
 * (`argsFile`): the hub range-reads the file off the calling host's daemon in 2MB
 * chunks, so a 100MB letter body never touches this line at all. See
 * core/peers/gateway-args-file.ts.
 *
 * It must still sit BELOW the 32MB WS frame maxPayload that an inline request
 * crosses on a remote host — raising it past the frame would trade a clean 413
 * for a socket the peer closes with 1009. Ratchets:
 * tests/unit/peers/gateway-core.test.ts and tests/core/human-inbox-caps.test.ts.
 *
 * Safe to be this big: the socket is 0600 owner-only, that mode IS the
 * credential, and the daemon reads one request per connection. The twins count
 * bytes and scan for the newline INCREMENTALLY (never re-measuring the whole
 * buffer per chunk), so a 28MB line is one linear pass, not a quadratic one.
 */
export const GATEWAY_MAX_LINE_BYTES = 28 * 1024 * 1024;

/** Default wait for the Mac hub to answer a relayed gateway request. */
export const GATEWAY_HUB_TIMEOUT_MS = 20_000;

/** The longest `waitMs` a CLI may ask for. */
export const GATEWAY_WAIT_MAX_MS = 180_000;
/** Waiting for a server to come back stops this long before the call's end: a relay gets at least this. */
export const GATEWAY_MIN_RELAY_MS = 8_000;

/**
 * When a call ends, and whether it may wait for a server to come back. A CLI
 * that names its `waitMs` (a newer `walnut`) gets that time (clamped), waits
 * while no server is there, and is sent again within it. A caller that names
 * none (an older `walnut`, the Mac's own CLI, which falls back to HTTP) is
 * answered as before: no server is hub_unreachable at once, and one relay has
 * the hub timeout (a socket that closes inside it still sends it again).
 */
export function gatewayCallPlan(waitMs: number | undefined, hubTimeoutMs: number, now: number): { deadline: number; waits: boolean } {
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs <= 0) return { deadline: now + hubTimeoutMs, waits: false };
  return { deadline: now + Math.min(GATEWAY_WAIT_MAX_MS, Math.max(GATEWAY_MIN_RELAY_MS, Math.floor(waitMs))), waits: true };
}

/**
 * May a relay that went to a server of run `sentRun` be sent again to a socket of
 * run `targetRun`? A server dedupes a relay it sees twice (by daemon instance and
 * relay id) within its own run only, so a call that may change something goes
 * again only to the run it first went to; one this host could answer from its
 * copy (a read) may go anywhere, and so may one the target server itself names
 * read-only in its hello (`targetReadsIt`, helloReadOps): running a read again
 * changes nothing. An older server names no run and no reads: nothing is sent
 * to it twice.
 */
export function relayMayResendTo(relay: { run?: string; readable: boolean }, targetRun: string | undefined, targetReadsIt = false): boolean {
  if (relay.readable || targetReadsIt) return true;
  return typeof relay.run === 'string' && relay.run.length > 0 && relay.run === targetRun;
}

/** Most op names one hello may list as read-only (the registry has about 60). */
export const HELLO_READ_OPS_MAX = 500;
const READ_OP_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * The ops a server's hello names read-only (`readOps`, its op registry's
 * `readonly` tag). 2026-11-03: a `host_list` relayed 0.3 s before a deploy
 * stopped the server was never sent to the next run, which said hello 11 s
 * later, and the call ended hub_timeout after 90 s. A relay of an op the target
 * names here may go to it whatever run it first went to (relayMayResendTo).
 * Bounded; a list that is not an array of names is no list.
 */
export function helloReadOps(raw: unknown): Set<string> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = new Set<string>();
  for (const name of raw.slice(0, HELLO_READ_OPS_MAX)) if (typeof name === 'string' && READ_OP_NAME.test(name)) out.add(name);
  return out.size > 0 ? out : undefined;
}

/** One attempt's wait: the hub timeout, or what is left of the call when that is less. */
export function relayAttemptMs(deadline: number, now: number, hubTimeoutMs: number): number {
  return Math.max(0, Math.min(hubTimeoutMs, deadline - now));
}

/** Effective hub timeout — WALNUT_GATEWAY_TIMEOUT_MS overrides (tests only). */
export function gatewayHubTimeoutMs(): number {
  const raw = typeof process !== 'undefined' ? process.env?.WALNUT_GATEWAY_TIMEOUT_MS : undefined;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return GATEWAY_HUB_TIMEOUT_MS;
}

// ── Protocol types ──

// peers.* are tombstones: still ACCEPTED on the wire so the capability router
// can answer with a pointer to the replacement op instead of a bare
// unknown-op error (old daemons / stale session guidance still say "peers").
export const GATEWAY_OPS = ['peers.list', 'peers.send', 'tools.list', 'tools.call'] as const;
export type GatewayOp = (typeof GATEWAY_OPS)[number];

/** Full error-code table (plan §2d) — shared by the walnut CLI and the socket protocol. */
export type GatewayErrorCode =
  | 'unknown_peer'
  | 'ambiguous_peer'
  | 'self_send'
  | 'throttled'
  | 'queue_full'
  | 'target_awaiting_permission'
  | 'target_archived'
  | 'unknown_caller'
  | 'hub_unreachable'
  | 'hub_timeout'
  | 'bad_request'
  | 'unsupported_version'
  | 'unsupported_replica'
  | 'internal';

export interface GatewayError {
  code: GatewayErrorCode;
  message: string;
  /** Present on `throttled` — when the sender's window frees up. */
  retryAfterMs?: number;
  /** Extra structured context (e.g. `ambiguous_peer` candidates, `queue_full` depth). */
  detail?: unknown;
}

/** One request line on the unix socket (walnut CLI → daemon). */
export interface GatewayRequest {
  v: 1;
  op: GatewayOp;
  /** The caller's $WALNUT_SESSION_ID — a lookup key only; daemon resolves the real sid. */
  sid: string;
  args: Record<string, unknown>;
  /** How long the CLI waits for this answer in all (a newer `walnut`); the daemon queues and resends within it. */
  waitMs?: number;
}

/** One response line on the unix socket (daemon → walnut CLI). */
export type GatewayResponse =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: GatewayError };

export type ParseGatewayResult =
  | { ok: true; request: GatewayRequest }
  | { ok: false; error: GatewayError };

// ── Pure functions ──

function err(code: GatewayErrorCode, message: string): ParseGatewayResult {
  return { ok: false, error: { code, message } };
}

/**
 * Parse + validate a single NDJSON request line from the agent socket.
 * Never throws; every failure maps to a typed GatewayError.
 */
export function parseGatewayLine(line: string): ParseGatewayResult {
  if (new TextEncoder().encode(line).length > GATEWAY_MAX_LINE_BYTES) {
    return err('bad_request', `request line exceeds ${GATEWAY_MAX_LINE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return err('bad_request', 'request is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err('bad_request', 'request must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) {
    return err('unsupported_version', `unsupported protocol version: ${JSON.stringify(obj.v)}`);
  }
  if (typeof obj.op !== 'string' || !(GATEWAY_OPS as readonly string[]).includes(obj.op)) {
    return err('bad_request', `unsupported op: ${JSON.stringify(obj.op)}`);
  }
  if (typeof obj.sid !== 'string' || obj.sid.length === 0) {
    return err('bad_request', 'missing sid');
  }
  let args: Record<string, unknown> = {};
  if (obj.args !== undefined) {
    if (typeof obj.args !== 'object' || obj.args === null || Array.isArray(obj.args)) {
      return err('bad_request', 'args must be an object');
    }
    args = obj.args as Record<string, unknown>;
  }
  const waitMs = typeof obj.waitMs === 'number' && Number.isFinite(obj.waitMs) && obj.waitMs > 0 ? obj.waitMs : undefined;
  return { ok: true, request: { v: 1, op: obj.op as GatewayOp, sid: obj.sid, args, ...(waitMs !== undefined ? { waitMs } : {}) } };
}

const MAX_ALIAS_HOPS = 5;

/**
 * Resolve the env-reported sid to the CURRENT sid the daemon tracks.
 * Fresh sessions spawn with a tmp id that cmdRename later replaces, so the
 * alias map may chain (tmp → renamed → renamed again). Capped at 5 hops to
 * make a cyclic/corrupt alias table terminate. Returns null when the sid is
 * unknown (→ unknown_caller, request never leaves the host).
 */
export function resolveCallerSid(
  sid: string,
  sessions: { has(sid: string): boolean },
  aliases: Map<string, string>,
): string | null {
  let cur = sid;
  for (let hop = 0; hop <= MAX_ALIAS_HOPS; hop++) {
    if (sessions.has(cur)) return cur;
    const next = aliases.get(cur);
    if (next === undefined || next === cur) return null;
    cur = next;
  }
  return null;
}

/**
 * Caller identity for one gateway request (what handleGatewayLine uses in both
 * twins). 'external' passes through untouched — it is not a tracked session and
 * never will be, and the owner-only socket already vouched for the caller.
 * Every OTHER sid must still resolve to a session this daemon tracks; null →
 * unknown_caller and the request never leaves the host.
 */
export function resolveGatewayCallerSid(
  sid: string,
  sessions: { has(sid: string): boolean },
  aliases: Map<string, string>,
): string | null {
  if (isExternalCallerSid(sid)) return EXTERNAL_CALLER_SID;
  return resolveCallerSid(sid, sessions, aliases);
}

// ── On-PATH `walnut` shim (pure helpers; both twins use these rules) ──

/**
 * Canonical argv keyword that makes the daemon artifact run as the on-host
 * walnut CLI instead of starting a daemon: `<artifact> walnut tools list`.
 */
export const DAEMON_CLI_KEYWORD = 'walnut';

/**
 * Deprecated keyword the dispatch must KEEP accepting. Every shim written by a
 * daemon deployed before 2026-08-30 says `wn`, and those files live on hosts we
 * do not redeploy synchronously (a shim is rewritten only when its daemon next
 * boots). Dropping the alias would break `walnut` inside every already-running
 * session on such a host until then.
 */
export const DAEMON_CLI_KEYWORD_LEGACY = 'wn';

/** True for either dispatch keyword — canonical `walnut` or legacy `wn`. */
export function isDaemonCliKeyword(action: string | undefined | null): boolean {
  return action === DAEMON_CLI_KEYWORD || action === DAEMON_CLI_KEYWORD_LEGACY;
}

/** POSIX single-quoting for a path embedded in the /bin/sh shim. */
export function shimQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * The whole `/bin/sh` shim body. `argv` is the command that runs the daemon
 * artifact (a compiled binary alone, or an interpreter + script), and the
 * canonical keyword is appended so new shims never write the legacy `wn`.
 */
export function gatewayShimScript(argv: string[]): string {
  return '#!/bin/sh\nexec ' + argv.map(shimQuote).join(' ') + ' ' + DAEMON_CLI_KEYWORD + ' "$@"\n';
}

/** Filename of the stable in-daemon-dir copy of the artifact the shim execs. */
export const SHIM_CORE_BASENAME = 'walnut-core';

/**
 * Does the stable copy at `<daemon dir>/bin/walnut-core` need to be (re)written?
 *
 * Why a copy exists at all: on the hub the daemon binary is booted from a STAGE
 * TEMP dir (dev-prod clones dist/ into /var/folders/... before launching), and
 * the next deploy deletes that clone. A shim that exec'd `process.execPath`
 * directly then pointed at a path that no longer exists, so every `walnut` call
 * inside a live session died with exit 126 — the shim outlived its target.
 *
 * Why the check is this cheap: the artifact is ~60MB, the daemon boots often,
 * and /tmp is not fast. Size + a version stamp written next to the copy is
 * enough — the daemon version is a content hash of the daemon sources, so a
 * changed artifact always changes either the stamp or the size.
 */
export function shimCoreNeedsCopy(input: {
  /** Size of the running artifact, or null when it can't be stat'd. */
  srcSize: number | null;
  /** Size of the existing stable copy, or null when absent. */
  dstSize: number | null;
  /** Contents of the `<copy>.version` stamp, or null when absent. */
  stampedVersion: string | null;
  /** This daemon's version. */
  version: string;
}): boolean {
  const { srcSize, dstSize, stampedVersion, version } = input;
  if (srcSize === null || srcSize <= 0) return false; // nothing trustworthy to copy
  if (dstSize === null) return true;                  // no copy yet
  if (dstSize !== srcSize) return true;               // different artifact
  if (!stampedVersion || stampedVersion !== version) return true;
  return false;
}
