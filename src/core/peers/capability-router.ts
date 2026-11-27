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
import { createHash } from 'node:crypto';
import type { GatewayError } from '../../providers/gateway-core.js';
import { EXTERNAL_CALLER_SID, isBusyAgainOp, isExternalCallerSid } from '../../providers/gateway-core.js';
import { GATEWAY_WRITE_MAX_PER_WINDOW, PeerThrottle } from './peer-throttle.js';

export type CapabilityOutcome =
  | { ok: true; result: Record<string, unknown> }
  /**
   * `opStatus`: the op ran and Walnut's API answered it with this HTTP status (a 404 for an id
   * that does not exist). Never sent on the wire: the relay's log reads it, so an op's own
   * answer is not counted as the relay refusing the call.
   */
  | { ok: false; error: GatewayError; opStatus?: number };

/** What the host's daemon says about a relay beside the caller's own payload. */
export interface GatewayRelayMeta {
  /** The daemon asks a busy call again (gateway-core.ts busyRelayAgainMs): the how-manyth time. */
  busyAgain?: number;
  /**
   * The plugin job that made the call, as the host's daemon names it: its own replica (a follower
   * that answers local calls) takes it and its write port records the job as the maker; the leader
   * keeps it only from a host it gives that job now (plugin-jobs relayedJobOf).
   * `vouched` (only ever `true`): the daemon saw the call's process inside that job's run; only
   * then is the call the job's for the start-mode ceiling (plugin-jobs/job-caller.ts).
   */
  pluginJob?: { plugin: string; job: string; vouched?: true };
}

export interface CapabilityRouterDeps {
  throttle: PeerThrottle;
  /** WALNUT_CLOUD_MODE replica — gateway capabilities are refused there (P1). */
  cloudMode: boolean;
  /**
   * The listing (role and plugins) of a caller whose MCP server asks for one (tool-listing-role.ts), or
   * undefined to list everything. Tests inject it; the default reads the experiment and the
   * caller's task.
   */
  listingRole?: (callerSid: string) => Promise<import('../../ops/op-groups.js').ToolListing | undefined>;
  /** True when the plugins' ops may still be missing from a list read now (pluginsStillLoading); tests inject it. */
  pluginsLoading?: () => Promise<boolean>;
  /** The task of a caller session, for the real-use monitor's count of a short list (tests inject it). */
  taskOfCaller?: (callerSid: string) => Promise<string | undefined>;
}

/** How long a schemas tools.list waits for a plugin walk under way before it answers without the rest. */
// Short: the host's MCP server waits 15 s for its whole request (a cold daemon's own wait and a slow
// link come out of it too), and it asks again for a partial list about 10 s later.
export const TOOLS_LIST_PLUGIN_WAIT_MS = 2_000;

/**
 * Whether the plugin set is still changing after a short wait: the server answers gateway calls
 * while its boot walks the plugins (about 20 s on a busy Mac), and a plugin's ops are listed only
 * once it is loaded. 2026-11-22 09:49: sessions resumed by a restart read their catalog before
 * Slack, interview practice and notes import were loaded, and lived without those 37 tools.
 */
async function pluginsStillLoading(): Promise<boolean> {
  const { registry } = await import('../integration-registry.js');
  await registry.waitForPlugins(TOOLS_LIST_PLUGIN_WAIT_MS);
  return registry.isChanging();
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
  extra?: { retryAfterMs?: number; detail?: unknown; api?: GatewayError['api'] },
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
  meta: GatewayRelayMeta = {},
): Promise<CapabilityOutcome> {
  const d = deps ?? (await defaultDeps());
  if (d.cloudMode) {
    return err('unsupported_replica', 'agent gateway capabilities are not available on a cloud replica');
  }
  // A revoked host's sessions run nothing here: a ban, not only a closed door (revoked-hosts.ts).
  // Under any name of its machine (revoked-hosts.ts revokedAs).
  const { revokedAs, HostRevokedError } = await import('../session-channel/revoked-hosts.js');
  const revoked = host && host !== '__local__' ? revokedAs(host) : null;
  if (revoked) {
    return err('host_revoked', new HostRevokedError(host, `${capability} refused, nothing ran`, revoked).message);
  }
  // An ACP session's worker runtime id names its session record from here on.
  callerSid = (await import('../sessions/acp-caller-sid.js')).canonicalCallerSid(callerSid);
  switch (capability) {
    case 'tools.list':
      return handleToolsList(payload ?? {}, host, callerSid, d);
    case 'tools.call':
      return handleToolsCall(callerSid, payload ?? {}, host, d, meta);
    case 'history.fetch':
      return handleHistoryFetch(payload ?? {}, host);
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

// ── history.fetch — a daemon's restore of a session kept in remote storage ──
//
// Only this server holds the bucket's credentials, and only its OWN machine's history goes
// there (history-remote/service.ts), so only the local daemon may ask. It names the session's
// project dir and id; the server reads that session's manifest itself, downloads what is
// missing next to it and checks each file's hash. Anything else is refused. At worst a caller
// on this machine brings one of the user's own sessions back to disk, which opening it does.
async function handleHistoryFetch(payload: Record<string, unknown>, host: string): Promise<CapabilityOutcome> {
  if (host !== '__local__') return err('bad_request', 'history.fetch: only this machine\'s history is in remote storage');
  try {
    const { fetchLocalArchive } = await import('../history-remote/service.js');
    const files = await fetchLocalArchive(payload.dir, payload.sessionId);
    return { ok: true, result: { files } };
  } catch (e) {
    return err('internal', `history.fetch: ${(e as Error).message}`);
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
 * parameter descriptions over the socket. Each row names its group (src/ops/op-groups.ts)
 * and the answer lists the groups, so the CLI prints the catalog by group.
 */
async function handleToolsList(payload: Record<string, unknown>, host: string, callerSid: string, deps: CapabilityRouterDeps): Promise<CapabilityOutcome> {
  // A host's MCP server says its session was given fewer tools than its whole list for a while
  // (walnut-mcp-stdio.ts tellShort), or a session's client tells its calls no Walnut answered
  // (lib/no-answer-report.ts): counted for the real-use monitor, nothing listed back.
  if (payload.report !== undefined) {
    // Only a session's own client says it: a caller with no session (a bare `walnut`) counts nothing.
    if (!callerSid || isExternalCallerSid(callerSid)) return { ok: true, result: { recorded: false } };
    const { recordNoAnswers, recordShortToolList } = await import('../usage-watch/gateway-record.js');
    const taskOf = deps.taskOfCaller ?? (async (sid: string) => (await (await import('../session-tracker.js')).getSessionByClaudeId(sid))?.taskId ?? undefined);
    const short = await recordShortToolList(callerSid, host, payload.report, taskOf);
    const noAnswer = await recordNoAnswers(callerSid, host, payload.report, taskOf);
    return { ok: true, result: { recorded: short || noAnswer > 0, ...(noAnswer ? { no_answer: noAnswer } : {}) } };
  }
  const { areaOpsForCaller } = await import('../router/gateway-policy.js');
  const areaOps = await areaOpsForCaller(callerSid);
  const { listOps, getOpOwner } = await import('../../ops/index.js');
  const { opParams, formatParamSignature } = await import('../../ops/op-help.js');
  const { groupOfOp, listedForRole, summarizeGroups } = await import('../../ops/op-groups.js');
  const wanted = typeof payload.name === 'string' ? payload.name.trim() : '';
  // `schemas: true` is the Walnut MCP server on a host (`walnut mcp-server`,
  // src/providers/walnut-mcp-stdio.ts): every op with its JSON schema, and only
  // the ops this host's gateway would run, so the model never sees a tool it is
  // refused. An older hub ignores the flag; that server then lists permissive schemas.
  if (payload.schemas === true) {
    // Read first: a walk that ends within the wait lists its plugins' ops below.
    const partial = await (deps.pluginsLoading ?? pluginsStillLoading)().catch(() => false);
    const { opInputJsonSchema } = await import('../../ops/registry.js');
    // `listing: 'role'`: a server that tells its session how to reach what it does not list asks
    // for its role's tools only (experiment mcp_tools_by_role, tool-listing-role.ts). An older
    // one never asks, so it keeps listing everything. Listing only: tools.call runs every op.
    // A router is held to its own ops above and gets no role.
    const listing = !areaOps && payload.listing === 'role'
      ? await (deps.listingRole ?? (async (sid: string) => (await import('../sessions/tool-listing-role.js')).listingRoleForCaller(sid)))(callerSid).catch(() => undefined)
      : undefined;
    const ops = listOps()
      .filter((o) => (!areaOps || areaOps.has(o.name)) && !gatewayRefusal(o, host, getOpOwner(o.name)))
      .filter((o) => !listing || listedForRole(listing, o.name, getOpOwner(o.name)))
      .map((o) => ({
        name: o.name,
        title: o.title,
        description: o.description,
        readonly: o.tags.readonly,
        ...(o.tags.destructive !== undefined ? { destructive: o.tags.destructive } : {}),
        inputSchema: cachedInputSchema(o, opInputJsonSchema),
      }));
    // A list read while plugins load says so (`partial`): the MCP server answers it and asks again
    // until a whole one comes, then tells its client the list changed (walnut-mcp-stdio.ts). It
    // carries no hash, so no daemon holds it as a caller's catalog; an older server ignores the flag.
    if (partial) return { ok: true, result: { ops, partial: true } };
    // tools-list-held-v1 (held-catalogs-core.ts): the host's daemon names the catalogs it
    // holds (`have`); when it holds this caller's, only the hash goes back, not ~130 KB.
    // An older daemon sends no `have` and reads past `catalogHash`.
    const catalogHash = catalogHashOf(ops);
    if (Array.isArray(payload.have) && payload.have.includes(catalogHash)) {
      return { ok: true, result: { sameAs: catalogHash } };
    }
    return { ok: true, result: { ops, catalogHash } };
  }
  const ops = (wanted ? listOps({ includeDeprecated: true }).filter((o) => o.name === wanted) : listOps())
    .filter((o) => !areaOps || areaOps.has(o.name));
  const away = await awayCatalog();
  const rows = ops.map((o) => {
    const params = opParams(o.input);
    return {
      name: o.name,
      title: o.title,
      description: o.description,
      readonly: o.tags.readonly,
      remote: o.tags.remote,
      signature: formatParamSignature(params),
      group: groupOfOp(o.name, getOpOwner(o.name)),
      ...(wanted ? { params } : {}),
      ...(away ? { away: away.of(o.name) } : {}),
    };
  });
  return {
    ok: true,
    result: {
      ops: rows,
      groups: summarizeGroups(rows),
      ...(away ? { hint: away.hint } : {}),
    },
  };
}

/**
 * A host's follower answering its host's own calls while the leader is away: each op says what
 * it gets here (src/replica/away-op-decisions.ts), as the daemon's own away catalog listed only
 * what it answered. The whole catalog stays listed (a session keeps the tools it read once the
 * leader is back). Null on the leader, on a companion, and while the leader answers.
 */
async function awayCatalog(): Promise<{ of(name: string): 'host' | 'held' | 'leader'; hint: string } | null> {
  const [{ hasCapability }, { leaderAnswers }] = await Promise.all([import('../capabilities.js'), import('../server-role.js')]);
  if (!hasCapability('host-local-calls') || leaderAnswers()) return null;
  const { AWAY_OP_DECISIONS } = await import('../../replica/away-op-decisions.js');
  return {
    of: (name) => AWAY_OP_DECISIONS[name]?.answer ?? 'leader',
    hint: 'Your Mac is away: this host\'s Walnut answers the ops marked away:"host" (writes are kept and reach the Mac when it is back); an op marked away:"leader" answers needs_leader until the Mac is back.',
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

/**
 * A caller's schema catalog, named by its content: sha256 of its JSON, 16 hex characters.
 * The same ops give the same hash on every call and in every server run; a caller with
 * another catalog (another area, another host's refusals) gets another hash.
 */
export function catalogHashOf(ops: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(ops)).digest('hex').slice(0, 16);
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
  meta: GatewayRelayMeta,
): Promise<CapabilityOutcome> {
  const name = payload.name;
  if (typeof name !== 'string' || !name) {
    return err('bad_request', 'tools.call requires a non-empty string "name"');
  }
  const { areaOpsForCaller } = await import('../router/gateway-policy.js');
  const areaOps = await areaOpsForCaller(callerSid);
  if (areaOps && !areaOps.has(name)) return err('bad_request', 'A router session may use only its routing tools. Nothing ran.');
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
  if (refusal) {
    // The op's own refusal (403 local_only), counted by real use as one; the code older CLIs read stays.
    const { LOCAL_ONLY_CODE, ownRefusal } = await import('../../ops/own-refusal.js');
    const refused = ownRefusal(LOCAL_ONLY_CODE, refusal, { status: 403 });
    // A test run's calls stay out of real use, as below.
    const { parseTestRunLabel, testRunMarkingEnabled } = await import('../test-run.js');
    const label = parseTestRunLabel(payload.testRun);
    if (!(label && await testRunMarkingEnabled())) {
      const { recordGatewayCall } = await import('../usage-watch/gateway-record.js');
      recordGatewayCall(name, payload.client, refused, 0);
    }
    return err('bad_request', refused.message, { api: { status: 403, code: LOCAL_ONLY_CODE } });
  }
  // Writes ride a per-sender rate budget; reads are free. A call the host's gateway asks again
  // after a busy refusal (gateway-core.ts busyRelayAgainMs) paid at its first ask: one call, one write.
  const askedAgain = typeof meta.busyAgain === 'number' && meta.busyAgain > 0 && isBusyAgainOp(name);
  if (!op.tags.readonly && !askedAgain) {
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
  // What the daemon vouches a trigger check's call came from (trigger-caller.ts), with the host that relayed it.
  // Only for an op that runs only for a task (lib/task-host-ops.ts): no other op reads it.
  const { isTaskHostOpPath } = await import('../../lib/task-host-ops.js');
  const { holdRelayTrigger } = await import('../hosts/trigger-caller.js');
  const triggerToken = isTaskHostOpPath(op.bind?.path) ? holdRelayTrigger(payload.triggerCaller, host) : undefined;
  // The plugin job the host's daemon vouched made the call (plugin-jobs/job-caller.ts), only for the
  // anonymous gateway caller daemon-connection.ts kept it for: the start and send routes read who it is.
  // Only for a job the daemon vouched for (`vouched === true`, its process tree checked) and an op that
  // reads it (opReadsVouchedJob: a start, the start check, a message): an unvouched job's call keeps its
  // labels below, stays capped and is sent as an unidentified process.
  const { holdRelayJob, opReadsVouchedJob, releaseRelayJob } = await import('../plugin-jobs/job-caller.js');
  const jobToken = meta.pluginJob?.vouched === true && isExternalCallerSid(callerSid) && opReadsVouchedJob(op) ? holdRelayJob(meta.pluginJob, host) : undefined;
  // The call's id, chosen by the caller's client (src/lib/op-call-id.ts): a resend of the
  // same call runs it at most once, and op_result reads what it did.
  const { isCallId } = await import('../../lib/op-call-id.js');
  const callId = isCallId(payload.callId) ? payload.callId : undefined;
  // The answer's surface (ops/answer.ts): the client names itself; one that names none (an older CLI or
  // daemon) gets the CLI's smaller cap, since its answer may be printed into a shell; a program
  // (wn-cli's own loops) none, it reads the whole answer.
  const { agentSurfaceOf } = await import('../../ops/answer.js');
  const surface = agentSurfaceOf(payload.client);
  // Held to that surface only for a session's call: a check script or a plugin job reads the result as
  // it is, and so does a call no session made (a person's terminal on that host, an outside script).
  const forAgent = surface && !payload.triggerCaller && !meta.pluginJob && !!callerSid && !isExternalCallerSid(callerSid) ? surface : undefined;
  // A program parses the answer, so outside data in it reads plain (ops/outside-answer.ts agentReadsFramed):
  // a check script (its output reaches a session only inside the fire's frame) and a plugin's job. Both
  // are the daemon's own stamps, which a caller cannot write (trigger-check-core.ts, gateway-answer.ts).
  // Every other call through here (a session, a person's terminal or a script on that host) reads it framed.
  const answerReader = payload.triggerCaller || meta.pluginJob ? 'program' as const : undefined;
  // Asked for whole (`_full`, taken out of the arguments by executeOp): read before the call.
  const { FULL_ARG } = await import('../../ops/answer.js');
  const askedWhole = typeof args === 'object' && args !== null && (args as Record<string, unknown>)[FULL_ARG] === true;
  // The op itself answers this call whole (answer.whole_for: a hook's output, a single-use read): it
  // has no cap to be over, and its size still counts as what the session read.
  const { answersWhole } = await import('../../ops/answer.js');
  const uncapped = answersWhole(op, args);
  const startedAt = Date.now();
  // The daemon could not prove the session sid (lib/caller-unproven.ts): the sid stays the call's
  // provenance, and the start-mode ceiling of every self-call reads the caller as anonymous.
  const { relayedCallerUnproven } = await import('../../lib/caller-unproven.js');
  const unproven = relayedCallerUnproven(payload);
  // The job's token ends with the call: its place in the hold goes back (job-caller.ts releaseRelayJob).
  const r = await withTestRun(testRun, () => executeOp(name, (args ?? {}) as Record<string, unknown>, {
callerSid, callerHost: host, origin: hostOrigin(host), ...(proofToken ? { callerProof: proofToken } : {}), ...(triggerToken ? { callerTrigger: triggerToken } : {}), ...(callId ? { callId } : {}),
...(meta.pluginJob ? { callerPluginId: meta.pluginJob.plugin, callerPluginJob: meta.pluginJob.job } : {}),
...(jobToken ? { callerJob: jobToken } : {}),
...(unproven ? { callerUnproven: true } : {}),
  ...(forAgent ? { forAgent } : {}),
  ...(answerReader ? { answerReader } : {}),
})).finally(() => releaseRelayJob(jobToken));
  // Real use (core/usage-watch): the call's outcome and its answer's size as its client prints it.
  // A test run's calls stay out of it.
  if (!testRun) {
    const { recordGatewayCall } = await import('../usage-watch/gateway-record.js');
    recordGatewayCall(name, payload.client, r, Date.now() - startedAt, !forAgent || askedWhole, uncapped);
  }
  // The server's own call to its API went out and got no answer: the caller hears the answer
  // was lost (hub_timeout), so its client names the call id and the read, never a bare error.
  // Nothing answering at all (a refused connection) ran nothing and stays `internal`.
  if (!r.ok && r.lost) {
    return err('hub_timeout', `the Walnut server's own call to its API got no answer, so ${name} may have run: ${r.message}`, r.result === undefined ? undefined : { detail: r.result });
  }
  // A trigger check's call the op refused for its arguments can never run as written, and a script
  // that drops the error reads it as "nothing yet": its trigger's task, or the test's answer, hears it
  // (routines/check-call-refused.ts).
  if (!r.ok && r.invalidArgs && payload.triggerCaller) {
    const { noteCheckCallRefused } = await import('../routines/check-call-refused.js');
    void noteCheckCallRefused(payload.triggerCaller, host, name, r.message);
  }
  // Arguments the op does not take are the caller's to fix (bad_request), never an internal fault.
  // The code stays what older CLIs already read; `opStatus` tells the relay's log the API answered.
  // `api` is how the API answered (its status and code), for a trigger check's machine faults
  // (trigger-check-core.ts machineFaultOf); the code stays what older CLIs already read.
  if (!r.ok) {
    const api = typeof r.status === 'number' ? { status: r.status, ...(r.code ? { code: r.code } : {}) } : undefined;
    const out = err(r.invalidArgs ? 'bad_request' : 'internal', r.message, {
      ...(r.result === undefined ? {} : { detail: r.result }), ...(api ? { api } : {}),
      ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}),
    });
    // Arguments the op's own check refused (no request went out) are the answer a 400 is: the op's.
    const opStatus = typeof r.status === 'number' ? r.status : r.invalidArgs ? 400 : undefined;
    return opStatus !== undefined && !out.ok ? { ...out, opStatus } : out;
  }
  // GatewayResponse.result must be an object — wrap non-object op results.
  const result = (typeof r.result === 'object' && r.result !== null && !Array.isArray(r.result))
    ? r.result as Record<string, unknown>
    : { value: r.result };
  return { ok: true, result };
}
