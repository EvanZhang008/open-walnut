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
import { GATEWAY_WRITE_MAX_PER_WINDOW, PeerThrottle } from './peer-throttle.js';

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
  // An ACP session's worker runtime id names its session record from here on.
  callerSid = (await import('../sessions/acp-caller-sid.js')).canonicalCallerSid(callerSid);
  switch (capability) {
    case 'tools.list':
      return handleToolsList(payload ?? {}, host, callerSid);
    case 'tools.call':
      return handleToolsCall(callerSid, payload ?? {}, host, d);
    // Old daemons / old shims still speak these — answer with the replacement
    // instead of a bare unknown-capability error.
    case 'peers.list':
      return err('bad_request',
        'peers.list was replaced — run `walnut tools call task_list \'{}\'`');
    case 'peers.send':
      return err('bad_request',
        'peers.send was replaced — run `walnut tools call task_send \'{"to":"...","text":"..."}\'`');
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
async function handleToolsList(payload: Record<string, unknown>, host: string, callerSid: string): Promise<CapabilityOutcome> {
  const { areaOpsForCaller } = await import('../router/gateway-policy.js');
  const areaOps = await areaOpsForCaller(callerSid);
  const { listOps, getOpOwner } = await import('../../ops/index.js');
  const { opParams, formatParamSignature } = await import('../../ops/op-help.js');
  const wanted = typeof payload.name === 'string' ? payload.name.trim() : '';
  // `schemas: true` is the Walnut MCP server on a host (`walnut mcp-server`,
  // src/providers/walnut-mcp-stdio.ts): every op with its JSON schema, and only
  // the ops this host's gateway would run, so the model never sees a tool it is
  // refused. An older hub ignores the flag; that server then lists permissive schemas.
  if (payload.schemas === true) {
    const { opInputJsonSchema } = await import('../../ops/registry.js');
    const ops = listOps().filter((o) => (!areaOps || areaOps.has(o.name)) && !gatewayRefusal(o, host, getOpOwner(o.name)));
    return {
      ok: true,
      result: {
        ops: ops.map((o) => ({
          name: o.name,
          title: o.title,
          description: o.description,
          readonly: o.tags.readonly,
          ...(o.tags.destructive !== undefined ? { destructive: o.tags.destructive } : {}),
          inputSchema: cachedInputSchema(o, opInputJsonSchema),
        })),
      },
    };
  }
  const ops = (wanted ? listOps({ includeDeprecated: true }).filter((o) => o.name === wanted) : listOps())
    .filter((o) => !areaOps || areaOps.has(o.name));
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

// Every new session's `walnut mcp-server` asks for every schema once; building them
// all costs 10 to 20 ms of the event loop, so each op's is built once.
const inputSchemaCache = new WeakMap<object, Record<string, unknown>>();
function cachedInputSchema<T extends object>(op: T, build: (op: T) => Record<string, unknown>): Record<string, unknown> {
  let schema = inputSchemaCache.get(op);
  if (!schema) { schema = build(op); inputSchemaCache.set(op, schema); }
  return schema;
}

type GatewayOpTags = { name: string; tags: { remote?: string; localHostGateway?: boolean }; localOnlyMessage?: string };

/**
 * Why the gateway refuses `op` for a caller on `host`, or null when it runs it.
 * A PLUGIN op lives only in this server process, so a session on this Mac has
 * no other way to it: the installed `walnut` it runs knows core ops alone and
 * hands a plugin op to its host daemon, which lands here as `__local__`. A core
 * `deny` op stays refused on every host, because that CLI reaches it directly
 * (2026-10-06: an Inbox Triage run could not call mail_mark_read at all).
 */
function gatewayRefusal(op: GatewayOpTags, host: string, owner: string | undefined): string | null {
  const localPluginOp = host === '__local__' && (owner ?? 'core') !== 'core';
  if (op.tags.remote !== 'deny' || localPluginOp || (op.tags.localHostGateway && host === '__local__')) return null;
  // A host-local read (Apple Health) is refused for what it is, not as "destructive",
  // and without pointing at a way around the rule.
  if (op.tags.localHostGateway) {
    return `${op.name} refused: ${op.localOnlyMessage ?? 'this data is only available to sessions on this Mac'}`;
  }
  return `${op.name} is local-only because it is destructive. Run it from a session on the Walnut host with \`walnut tools call\`.`;
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
  const { areaOpsForCaller } = await import('../router/gateway-policy.js');
  const areaOps = await areaOpsForCaller(callerSid);
  if (areaOps && !areaOps.has(name)) return err('bad_request', 'This scoped session may use only its area routing tools. Nothing ran.');
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
  const { getOp, getOpOwner, executeOp } = await import('../../ops/index.js');
  const op = getOp(name);
  if (!op) {
    return err('bad_request', `unknown op: ${name} — run \`walnut tools list\``);
  }
  const refusal = gatewayRefusal(op, host, getOpOwner(name));
  if (refusal) return err('bad_request', refusal);
  // Writes ride a per-sender rate budget; reads are free.
  if (!op.tags.readonly) {
    const decision = deps.throttle.admitWrite(throttleKey(callerSid, host));
    if (!decision.allowed) {
      // The shim prints `detail` on stdout and the message on stderr, and a
      // caller reading only stdout saw a bare {"retryAfterMs"} (2026-10-02):
      // the detail carries the sentence and the way out too.
      const secs = Math.ceil(decision.retryAfterMs / 1000);
      return err('throttled', 'too many gateway writes — slow down', {
        retryAfterMs: decision.retryAfterMs,
        detail: {
          outcome: `Refused, nothing changed: this session made ${GATEWAY_WRITE_MAX_PER_WINDOW} writes in the last minute (${name} not run).`,
          next: `Wait ${secs}s before the next write; do not retry in a loop. Many edits at once: `
            + 'task_update_bulk or task_complete_bulk take up to 50 tasks in ONE call (one budget slot).',
        },
      });
    }
  }
  // callerSid rides along as provenance (never authorization): ops whose
  // server side stamps "who did this" — the human inbox stamps a letter's
  // sender, session_send fences another session's words — get the
  // daemon-resolved sid instead of guessing.
  // `origin` is the host's trust class: every loopback self-call the op makes
  // carries it, so a remote host never reads as this Mac (src/lib/caller-origin.ts).
  const { hostOrigin } = await import('../../lib/caller-origin.js');
  // A host's `WALNUT_TEST_RUN=<label> walnut ...` rides as `testRun` (wn-cli.ts), so a test or a
  // demo from another host makes test objects here as it would from this Mac (core/test-run.ts).
  const { parseTestRunLabel, testRunMarkingEnabled, withTestRun } = await import('../test-run.js');
  const label = parseTestRunLabel(payload.testRun);
  const testRun = label && await testRunMarkingEnabled() ? label : undefined;
  // The daemon's word on the asking process (caller-proof-v1), for the approvals route to read.
  const { holdRelayProof } = await import('../approvals/relay-proof.js');
  const proofToken = holdRelayProof(payload.callerProof, callerSid, host);
  // The call's id, chosen by the caller's client (src/lib/op-call-id.ts): a resend of the
  // same call runs it at most once, and op_result reads what it did.
  const { isCallId } = await import('../../lib/op-call-id.js');
  const callId = isCallId(payload.callId) ? payload.callId : undefined;
  const r = await withTestRun(testRun, () => executeOp(name, (args ?? {}) as Record<string, unknown>, {
  callerSid, callerHost: host, origin: hostOrigin(host), ...(proofToken ? { callerProof: proofToken } : {}), ...(callId ? { callId } : {}),
}));
  // The server's own call to its API went out and got no answer: the caller hears the answer
  // was lost (hub_timeout), so its client names the call id and the read, never a bare error.
  // Nothing answering at all (a refused connection) ran nothing and stays `internal`.
  if (!r.ok && r.lost) {
    return err('hub_timeout', `the Walnut server's own call to its API got no answer, so ${name} may have run: ${r.message}`, r.result === undefined ? undefined : { detail: r.result });
  }
  // Arguments the op does not take are the caller's to fix (bad_request), never an internal fault.
  if (!r.ok) return err(r.invalidArgs ? 'bad_request' : 'internal', r.message, r.result === undefined ? undefined : { detail: r.result });
  // GatewayResponse.result must be an object — wrap non-object op results.
  const result = (typeof r.result === 'object' && r.result !== null && !Array.isArray(r.result))
    ? r.result as Record<string, unknown>
    : { value: r.result };
  return { ok: true, result };
}
