/**
 * Agent-gateway capability router (Mac hub side).
 *
 * DaemonConnection.handleGatewayRequest forwards every `gateway-request`
 * event here. The surface is the ops registry:
 *   - tools.list — the op catalog
 *   - tools.call — execute one op against this hub's local API
 *
 * The old peers.list / peers.send capabilities were folded into the registry
 * (session_list / session_send with server-side fencing) — an old daemon that
 * still sends them gets a pointer, not a hang.
 *
 * Everything is dependency-injected so L1 tests can mock the session store,
 * the message queue, and the clock. Real deps are dynamically imported on
 * first use.
 */
import type { GatewayError } from '../../providers/gateway-core.js';
import { EXTERNAL_CALLER_SID, isExternalCallerSid } from '../../providers/gateway-core.js';
import { PeerThrottle } from './peer-throttle.js';

export type CapabilityOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: GatewayError };

export interface CapabilityRouterDeps {
  throttle: PeerThrottle;
  /** WALNUT_CLOUD_MODE replica — gateway capabilities are refused there (P1). */
  cloudMode: boolean;
}

// Shared across all daemon connections — the throttle is per-sender state
// and must survive individual requests.
const sharedThrottle = new PeerThrottle();

async function defaultDeps(): Promise<CapabilityRouterDeps> {
  const { CLOUD_MODE } = await import('../../constants.js');
  return {
    throttle: sharedThrottle,
    cloudMode: CLOUD_MODE,
  };
}

function err(
  code: GatewayError['code'],
  message: string,
  extra?: { retryAfterMs?: number; detail?: unknown },
): CapabilityOutcome {
  return { ok: false, error: { code, message, ...extra } };
}

/**
 * Rate-limit bucket for one caller. A tracked session IS its sid; an anonymous
 * ('external') caller has NO identity, so the finest honest bucket is the host
 * it called from. Keying anonymous callers on the bare label collapsed every
 * env-less `walnut` on every machine into ONE budget, so a runaway agent on a dev
 * box could throttle the user's own terminal on the Mac.
 */
function throttleKey(callerSid: string, host: string): string {
  const displayHost = !host || host === '__local__' ? 'local' : host;
  return isExternalCallerSid(callerSid)
    ? `${EXTERNAL_CALLER_SID}@${displayHost}`
    : callerSid;
}

/**
 * Entry point called from DaemonConnection.handleGatewayRequest.
 * `host` is the daemon connection's hostKey — authoritative for where the
 * calling CLI runs. Never throws; every failure maps to a GatewayError.
 *
 * `callerSid` may be 'external' (an env-less `walnut`: a hand-started agent or the
 * user's own terminal on a daemon host). That is a PROVENANCE label, not an
 * authorization, and it is ANONYMOUS rather than trusted: any program the user's
 * account can run on a daemon host can send it, including a managed session that
 * cleared its own WALNUT_* env (the well-known socket is the same socket it was
 * handed). So it unlocks no capability — same op catalog, same local-only
 * refusals, and a per-HOST throttle bucket rather than a shared one.
 */
export async function handleGatewayCapability(
  capability: string,
  callerSid: string,
  payload: Record<string, unknown> | undefined,
  host: string,
  deps?: CapabilityRouterDeps,
): Promise<CapabilityOutcome> {
  const d = deps ?? (await defaultDeps());
  if (d.cloudMode) {
    return err('unsupported_replica', 'agent gateway capabilities are not available on a cloud replica');
  }
  switch (capability) {
    case 'tools.list':
      return handleToolsList(payload ?? {});
    case 'tools.call':
      return handleToolsCall(callerSid, payload ?? {}, host, d);
    // Old daemons / old shims still speak these — answer with the replacement
    // instead of a bare unknown-capability error.
    case 'peers.list':
      return err('bad_request',
        'peers.list was replaced — run `walnut tools call session_list \'{}\'`');
    case 'peers.send':
      return err('bad_request',
        'peers.send was replaced — run `walnut tools call session_send \'{"to":"...","text":"..."}\'`');
    default:
      return err('bad_request', `unsupported capability: ${JSON.stringify(capability)}`);
  }
}

// ── tools.list / tools.call — the op registry over the gateway ──────────────
//
// A `walnut tools ...` call inside ANY Walnut-managed session (local or remote)
// lands here and dispatches into the SAME registry executor the MCP server and
// the `walnut tools` CLI use, against this hub's own local API. Remote policy
// is per-op (`tags.remote`): destructive ops refuse the gateway transport.

/**
 * The catalog. Every row carries a one-line parameter SIGNATURE so the remote
 * `walnut tools list` shows arguments instead of bare names (agents guessed
 * `query` vs `q` from the old output). `payload.name` narrows the answer to one
 * op and adds its full parameter rows — that is how `walnut tools help <op>`
 * and `walnut tools call <op> --help` get a schema without shipping every op's
 * parameter descriptions over the socket.
 */
async function handleToolsList(payload: Record<string, unknown>): Promise<CapabilityOutcome> {
  const { listOps } = await import('../../ops/index.js');
  const { opParams, formatParamSignature } = await import('../../ops/op-help.js');
  const wanted = typeof payload.name === 'string' ? payload.name.trim() : '';
  const ops = wanted ? listOps().filter((o) => o.name === wanted) : listOps();
  return {
    ok: true,
    result: {
      ops: ops.map((o) => {
        const params = opParams(o.input);
        return {
          name: o.name,
          title: o.title,
          description: o.description,
          readonly: o.tags.readonly,
          remote: o.tags.remote,
          signature: formatParamSignature(params),
          ...(wanted ? { params } : {}),
        };
      }),
    },
  };
}

/** Writes ride a per-sender rate budget so a runaway agent can't hammer the hub. */
async function handleToolsCall(
  callerSid: string,
  payload: Record<string, unknown>,
  host: string,
  deps: CapabilityRouterDeps,
): Promise<CapabilityOutcome> {
  const name = payload.name;
  if (typeof name !== 'string' || !name) {
    return err('bad_request', 'tools.call requires a non-empty string "name"');
  }
  let args = payload.args;
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return err('bad_request', 'tools.call "args" must be a JSON object');
  }
  // A payload too big to inline arrives as a PATH on the caller's host, and the
  // hub pulls it back in bounded chunks (gateway-args-file.ts). This is what lets
  // an agent send a 100MB letter body: the gateway line stays tiny, so no single
  // frame ever has to carry the document. Deliberately generic — any op with a
  // big argument benefits, not just the human inbox.
  if (typeof payload.argsFile === 'string' && payload.argsFile.length > 0) {
    try {
      const { pullArgsFile } = await import('./gateway-args-file.js');
      // The file IS the args; anything inline alongside it is a stale duplicate
      // from an older CLI, so the pulled object wins outright.
      args = await pullArgsFile(host, payload.argsFile);
    } catch (pullErr) {
      return err('bad_request', pullErr instanceof Error ? pullErr.message : String(pullErr));
    }
  }
  const { getOp, executeOp } = await import('../../ops/index.js');
  const op = getOp(name);
  if (!op) {
    return err('bad_request', `unknown op: ${name} — run \`walnut tools list\``);
  }
  if (op.tags.remote === 'deny') {
    return err('bad_request', `${name} is local-only (destructive) — run it on the Walnut host via \`walnut tools call\``);
  }
  // Writes ride the same per-sender rate budget; reads are free.
  if (!op.tags.readonly) {
    const decision = deps.throttle.admitWrite(throttleKey(callerSid, host));
    if (!decision.allowed) {
      return err('throttled', 'too many gateway writes — slow down', { retryAfterMs: decision.retryAfterMs });
    }
  }
  // callerSid rides along as provenance (never authorization): ops whose
  // server side stamps "who did this" — the human inbox stamps a letter's
  // sender, session_send fences another session's words — get the
  // daemon-resolved sid instead of guessing.
  const r = await executeOp(name, (args ?? {}) as Record<string, unknown>, { callerSid, callerHost: host });
  if (!r.ok) return err('internal', r.message);
  // GatewayResponse.result must be an object — wrap non-object op results.
  const result = (typeof r.result === 'object' && r.result !== null && !Array.isArray(r.result))
    ? r.result as Record<string, unknown>
    : { value: r.result };
  return { ok: true, result };
}
