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

/** Hard cap on a single NDJSON request line (bytes). Oversized → reject + close. */
export const GATEWAY_MAX_LINE_BYTES = 256 * 1024;

/** Default wait for the Mac hub to answer a relayed gateway request. */
export const GATEWAY_HUB_TIMEOUT_MS = 20_000;

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

export const GATEWAY_OPS = ['peers.list', 'peers.send'] as const;
export type GatewayOp = (typeof GATEWAY_OPS)[number];

/** Full error-code table (plan §2d) — shared by the wn CLI and the socket protocol. */
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

/** One request line on the unix socket (wn CLI → daemon). */
export interface GatewayRequest {
  v: 1;
  op: GatewayOp;
  /** The caller's $WALNUT_SESSION_ID — a lookup key only; daemon resolves the real sid. */
  sid: string;
  args: Record<string, unknown>;
}

/** One response line on the unix socket (daemon → wn CLI). */
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
  return { ok: true, request: { v: 1, op: obj.op as GatewayOp, sid: obj.sid, args } };
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
