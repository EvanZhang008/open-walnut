/**
 * The answer to a `walnut` call a host's daemon relays (`gateway-request`), one path for every
 * server that answers one: the leader (providers/daemon-connection.ts, over its link to the
 * host) and a host replica while its leader is away (replica/local-calls.ts, over its follower
 * link). Both run the same steps:
 *
 *   dedupe   a relay sent again (its socket closed, its answer was late) gets the first
 *            answer, by (daemon instance, relay id); its op runs once
 *   run      the capability router (capability-router.ts), inside the relay's deadline
 *   reply    the `gateway-result` fields, a refusal with its typed code
 *
 *   pack     a big answer's result gzipped for a daemon that reads it (packRelayResult)
 *
 * How the answer travels (the leader's upstream check, a link's frame cap) stays with each link.
 */
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { log } from '../../logging/index.js';
import { DAEMON_FRAME_MAX_BYTES } from '../../providers/daemon-frame-cap.js';
import { gatewayErrorReplyFields, vouchedGatewayPayload } from '../../providers/gateway-core.js';
import { createRefusalLog, isOpAnswerStatus } from '../../providers/gateway-refusal-log.js';
import type { GatewayRelayMeta } from './capability-router.js';

const gzipAsync = promisify(gzip);
/** A relay answer's result this big or bigger goes gzipped. */
export const RELAY_RESULT_GZ_BYTES = 16 * 1024;

/**
 * A big answer's result gzipped where the daemon reads it (gateway-result-gz-v1): answers to a
 * host's sessions were the top upload on its link (2026-11-12: 9 MB in 14 minutes). Compressed
 * off the event loop; a small answer goes as it is, and so does one over the frame cap plain
 * (its send fails and the caller gets the small "too large" answer, never MBs of gzip).
 */
export async function packRelayResult(reply: Record<string, unknown>, gz: boolean, minBytes = RELAY_RESULT_GZ_BYTES): Promise<Record<string, unknown>> {
  const result = reply.result;
  if (!gz || !result || typeof result !== 'object') return reply;
  const json = JSON.stringify(result);
  if (json.length < minBytes || json.length > DAEMON_FRAME_MAX_BYTES) return reply;
  const { result: _plain, ...rest } = reply;
  return { ...rest, resultGz: (await gzipAsync(Buffer.from(json))).toString('base64') };
}

/** One relayed call as the daemon sends it. */
export interface RelayedCall {
  relayId: number;
  /** The daemon process (relay ids count from 1 in each); absent from an older daemon. */
  instanceId?: string;
  capability: string;
  callerSid: string;
  payload: unknown;
  busyAgain?: number;
  /**
   * The plugin job that made the call, as the host's daemon names it (the frame's `caller`). Its own
   * replica takes it; the leader only from a host it gives that job now (daemon-connection.ts,
   * plugin-jobs relayedJobOf).
   * `vouched`: the daemon saw the call's process inside that job's run, only ever the literal `true`;
   * only then is the call the job's for the start-mode ceiling (plugin-jobs/job-caller.ts).
   */
  pluginJob?: { plugin: string; job: string; vouched?: true };
  /** How long the daemon waits for this answer from now (a host's daemon to its own replica; after a wait, maybe little). */
  answerInMs?: number;
}

/** The relayed call an event names, or null when it is not one. */
export function relayedCallOf(event: Record<string, unknown>): RelayedCall | null {
  const { relayId, capability, callerSid, instanceId, busyAgain, caller, answerInMs } = event as Record<string, unknown>;
  if (typeof relayId !== 'number' || typeof capability !== 'string' || typeof callerSid !== 'string') return null;
  const c = caller as { kind?: unknown; plugin?: unknown; job?: unknown; vouched?: unknown } | undefined;
  const pluginJob = c && c.kind === 'plugin-job' && typeof c.plugin === 'string' && c.plugin && typeof c.job === 'string' && c.job
    ? { plugin: c.plugin.slice(0, 120), job: c.job.slice(0, 120), ...(c.vouched === true ? { vouched: true as const } : {}) } : undefined;
  return {
    relayId, capability, callerSid, payload: event.payload,
    ...(typeof instanceId === 'string' && instanceId ? { instanceId } : {}),
    ...(typeof busyAgain === 'number' && Number.isFinite(busyAgain) && busyAgain > 0 ? { busyAgain } : {}),
    ...(pluginJob ? { pluginJob } : {}),
    ...(typeof answerInMs === 'number' && Number.isFinite(answerInMs) && answerInMs >= 0 ? { answerInMs: Math.min(answerInMs, 600_000) } : {}),
  };
}

type Reply = Record<string, unknown>;
/** A relay's answer kept for a resend. */
export interface KeptRelay { reply: Promise<Reply>; at: number }

const RELAY_KEEP_MS = 5 * 60_000;
const RELAYS_KEPT = 2_000;
/**
 * Relays answered lately, by (daemon instance, relayId). One map for every link of this
 * process: a resend that comes in on another connection to the same daemon (a second host
 * key for one machine) still runs once.
 */
const relays = new Map<string, KeptRelay>();

/** Tests: forget the relays answered so far. */
export function resetRelayedCallsForTest(): void {
  relays.clear();
}

/** Tests: the relays kept now, by `instance:relayId`. */
export function relaysKeptForTest(): ReadonlyMap<string, KeptRelay> {
  return relays;
}

function remember(key: string, reply: Promise<Reply>): void {
  const now = Date.now();
  for (const [k, v] of relays) {
    if (now - v.at < RELAY_KEEP_MS && relays.size < RELAYS_KEPT) break;
    relays.delete(k);
  }
  relays.set(key, { reply, at: now });
}

/** Folds a looping caller's refusals to one line every few minutes; shared by every link. */
const refusalLog = createRefusalLog();
let refusalSweep: ReturnType<typeof setInterval> | null = null;

/** Write how many refusals a window left out once it ends, so a caller that stopped still has its count. */
function sweepRefusalsLater(label: string): void {
  if (refusalSweep) return;
  refusalSweep = setInterval(() => {
    for (const s of refusalLog.sweep()) {
      log.session.info(`${label}: gateway relay refusals left out of the log`, {
        host: s.host, callerSid: s.callerSid, errorCode: s.code, suppressed: s.suppressed,
      });
    }
    if (refusalLog.size() === 0 && refusalSweep) { clearInterval(refusalSweep); refusalSweep = null; }
  }, 60_000);
  refusalSweep.unref?.();
}

export interface RelayedCallDeps {
  /** The host the call came from (the link's host key; a host replica's own: its host key). */
  hostKey: string;
  /** Whether the relaying daemon advertises a capability (what only a daemon writes is kept only then). */
  hasCapability(cap: string): boolean;
  /** Log lines start with this (`DaemonConnection`, `replica`). */
  label: string;
  /** A refusal before anything runs (null: the call runs). Never memoized. */
  refuse?(call: RelayedCall): Reply | null;
  /** Before the call runs (the leader takes the host's journal first). */
  before?(): Promise<void>;
  /** When the call is answered, the router's clock started (the host gives up at its hub timeout from about then). */
  receivedAt: number;
  /** The relay's deadline from `receivedAt`. */
  deadlineMs: number;
  /**
   * A refusal Walnut's API gave with this code (its `api.code`) goes back with it as the
   * relay's own code: a host replica's `needs_leader` tells the daemon to answer the call
   * itself. Absent: none (the leader's answers keep the codes older CLIs read).
   */
  liftCodes?: readonly string[];
  /** Send the answer on the link; true once the daemon took it. `kept`: the memo entry, which a link may shrink. */
  send(reply: Reply, kept: KeptRelay | undefined): Promise<boolean>;
}

/** Answer one relayed call: deduped, run once, its answer sent. Never throws. */
export async function serveRelayedCall(call: RelayedCall, deps: RelayedCallDeps): Promise<void> {
  const { relayId, capability, callerSid } = call;
  const refused = deps.refuse?.(call);
  if (refused) {
    // One line per caller and reason every few minutes, as every refusal (a host refusing many calls never floods the log).
    const code = typeof refused.errorCode === 'string' ? refused.errorCode : 'internal';
    const seen = refusalLog.admit(deps.hostKey, callerSid, `before:${code}`);
    sweepRefusalsLater(deps.label);
    if (seen.write) {
      log.session.warn(`${deps.label}: gateway relay refused`, {
        host: deps.hostKey, relayId, capability, callerSid, errorCode: code, before: true,
        ...(typeof refused.error === 'string' ? { reason: refused.error.slice(0, 200) } : {}),
        ...(seen.suppressed > 0 ? { suppressed: seen.suppressed } : {}),
      });
    }
    try { await deps.send(refused, undefined); } catch { /* the daemon times the relay out */ }
    return;
  }
  // Relay ids count from 1 in each daemon process, so the key is the instance the relay itself
  // names (read off the request, never the link's last hello, which can be a restarted daemon's).
  const key = call.instanceId ? `${call.instanceId.slice(0, 80)}:${relayId}` : null;
  const seen = key ? relays.get(key) : undefined;
  if (seen) {
    log.session.info(`${deps.label}: gateway relay asked again, answered once`, { host: deps.hostKey, relayId, capability, callerSid });
    await deps.send(await seen.reply, seen);
    return;
  }
  const reply = answerRelayedCall(call, deps)
    .catch((err: unknown): Reply => ({ relayId, error: err instanceof Error ? err.message : String(err), errorCode: 'internal' }));
  if (key) remember(key, reply);
  const acked = await deps.send(await reply, key ? relays.get(key) : undefined);
  // Taken: the daemon holds the relay no more, so a resend still on its way only needs a
  // word it drops (stale), not the whole answer kept five minutes.
  const kept = key ? relays.get(key) : undefined;
  if (acked && kept) kept.reply = Promise.resolve({ relayId, error: 'this relay was answered already', errorCode: 'internal' });
}

/** Run one relayed call (after `before`) and build its gateway-result. Never throws. */
export async function answerRelayedCall(call: RelayedCall, deps: RelayedCallDeps): Promise<Reply> {
  const { relayId, capability, callerSid } = call;
  if (deps.before) await deps.before();
  try {
    const { handleGatewayCapability } = await import('./capability-router.js');
    const { withAnswerBy } = await import('../../lib/answer-by.js');
    // What only a daemon writes (callerProof, triggerCaller), kept only from one that says it drops a forged one.
    const body = vouchedGatewayPayload(call.payload, (c) => deps.hasCapability(c));
    const meta: GatewayRelayMeta = { ...(call.busyAgain ? { busyAgain: call.busyAgain } : {}), ...(call.pluginJob ? { pluginJob: call.pluginJob } : {}) };
    const outcome = await withAnswerBy(deps.receivedAt + deps.deadlineMs, () => handleGatewayCapability(
      capability, callerSid, body, deps.hostKey, undefined, meta,
    // Fresh: this relay's own deadline, never one of a call still running in whose context the link was made.
    ), { fresh: true });
    // Which op, so a burst of refusals names what keeps asking (2026-11-14: only "tools.call").
    const op = capability === 'tools.call' && typeof body?.name === 'string' ? { op: body.name.slice(0, 80) } : {};
    if (outcome.ok) {
      log.session.info(`${deps.label}: gateway relay handled`, { host: deps.hostKey, relayId, capability, callerSid });
      return { relayId, result: outcome.result };
    }
    // One line per caller and reason every few minutes, with the count left out (gateway-refusal-log.ts).
    const answered = isOpAnswerStatus(outcome.opStatus);
    const seen = refusalLog.admit(deps.hostKey, callerSid, answered ? `status:${outcome.opStatus}` : outcome.error.code);
    sweepRefusalsLater(deps.label);
    // The relay worked and the API answered (a 404 for a missing id): the op's answer, not a refusal (2026-11-15).
    if (seen.write && answered) {
      log.session.info(`${deps.label}: gateway relay handled, the op answered an error`, {
        host: deps.hostKey, relayId, capability, callerSid, status: outcome.opStatus, ...op,
        ...(seen.suppressed > 0 ? { suppressed: seen.suppressed } : {}),
      });
    } else if (seen.write) {
      log.session.warn(`${deps.label}: gateway relay refused`, {
        host: deps.hostKey, relayId, capability, callerSid, errorCode: outcome.error.code, ...op,
        // How the API answered (`needs_leader` and its why, say): what the caller is told next.
        ...(outcome.error.api?.code ? { apiCode: outcome.error.api.code } : {}),
        ...(typeof (outcome.error.detail as { why?: unknown } | undefined)?.why === 'string' ? { why: (outcome.error.detail as { why: string }).why } : {}),
        ...(seen.suppressed > 0 ? { suppressed: seen.suppressed } : {}),
      });
    }
    const lifted = outcome.error.api?.code && deps.liftCodes?.includes(outcome.error.api.code)
      ? { ...outcome.error, code: outcome.error.api.code as typeof outcome.error.code } : outcome.error;
    const reply: Reply = { relayId, ...gatewayErrorReplyFields(lifted) };
    const detail: Record<string, unknown> = {
      ...(typeof lifted.detail === 'object' && lifted.detail !== null ? lifted.detail as Record<string, unknown> : {}),
      ...(lifted.retryAfterMs !== undefined ? { retryAfterMs: lifted.retryAfterMs } : {}),
    };
    if (Object.keys(detail).length > 0) reply.detail = detail;
    return reply;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.session.warn(`${deps.label}: gateway relay failed`, { host: deps.hostKey, relayId, message });
    return { relayId, error: message, errorCode: 'internal' };
  }
}
