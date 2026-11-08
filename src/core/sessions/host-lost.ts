/**
 * A session whose host cannot be reached: stopped here, the work carried on elsewhere,
 * the process ended when the host comes back.
 *
 * 2026-11-07: a task whose session ran on a laptop that went offline was stuck for good.
 * task_move answered 502 (packing the work needs the old host), task_start on another host
 * was refused ("already has its active session"), and task_stop stayed "its host has not
 * confirmed it yet". The rule since: when the host does not answer a fresh connect, a
 * stop is recorded on the session as `hostLost` (the stop request stays pending, so no
 * message reaches the session from here), the task is free to move or start elsewhere,
 * and the host's reconnect sends that stop before anything else (session-stop.ts flush),
 * so the old CLI ends and one session id never runs twice. Paths that meet an
 * unreachable host and how each gets out: tests/core/sessions/host-lost-paths.test.ts.
 *
 * Two verdicts. A stop takes `probeHost` alone: the person asked for the session to end,
 * and a host that was only slow ends it on its reconnect anyway. Carrying the work on
 * elsewhere (a move, a start on another host) takes `hostGone`, which is stricter,
 * because a wrong answer there leaves two agents on one task: the link down a while
 * (HOST_GONE_AFTER_MS), for a reason that is not a sign-in (an expired login leaves the
 * host and its CLI running), and some other host answering (else this machine may be the
 * one offline).
 */
import os from 'node:os';
import { AWAKE_TICK_MS, AwakeDownClock } from '../../providers/awake-down-clock.js';
import type { SessionRecord } from '../types.js';

/** How long a fresh connect may take before the host counts as unreachable. */
export const HOST_LOST_PROBE_MS = 8_000;
/** An unreachable answer is reused this long (a move probes, then its stop probes again). */
export const HOST_LOST_MEMO_MS = 30_000;
/**
 * A lost session's stop waits this long for its host to come back, then fails like any
 * stop (the session takes messages again). The task was free from the start; this only
 * bounds the record's pending stop (lifecycle-waits.ts).
 */
export const HOST_LOST_STOP_MAX_MS = 7 * 24 * 60 * 60_000;
/** The pending stop's error while its host is away: session-stop.ts reads it by this prefix. */
export const HOST_LOST_STOP_PREFIX = 'Host unreachable; stopped here';

/** How long a host's link must have been down before its work may go on elsewhere. */
export const HOST_GONE_AFTER_MS = 2 * 60_000;

export type HostReach = { reachable: true } | { reachable: false; error: string; downSince?: string };
/** `unreachable`: the host does not answer (or may not), but its work may not go on elsewhere yet: `why` says what to do. */
export type HostGone = { gone: true; error: string } | { gone: false; why: string; unreachable?: true };

const LOCAL = new Set(['', 'local', '__local__']);
export const isLocalHost = (host: string | null | undefined): boolean => LOCAL.has(host ?? '');
export const hostWords = (host: string | null | undefined): string => (isLocalHost(host) ? 'this Mac' : String(host));

/**
 * Awake time since this server started looking (session-stop.ts loads this module at boot): a
 * host never reached since counts as down that long. No clock skips a Mac's sleep, so it is
 * summed from looks (awake-down-clock.ts).
 */
const sinceBoot = new AwakeDownClock();
sinceBoot.start(Date.now());
setInterval(() => { sinceBoot.sample(Date.now()); }, AWAKE_TICK_MS).unref?.();
const memo = new Map<string, { at: number; error: string; downSince?: string }>();
let override: ((host: string) => Promise<HostReach>) | null = null;
interface GoneFacts {
  lostSince(host: string): number | null;
  /** Awake time the link has been down (0: unknown): a Mac's sleep never counts as the host being away. */
  awakeDownMs(host: string): number;
  uptimeMs(): number;
  otherHosts(host: string): Promise<{ configured: number; connected: number }>;
  /** Whether this machine has a network address at all (a Wi-Fi drop takes it away). */
  online(): boolean;
}
let factsOverride: GoneFacts | null = null;

/** Tests: answer every probe (null: the real one), and forget the memo. */
export function __setHostProbeForTesting(fn: ((host: string) => Promise<HostReach>) | null, facts?: Partial<GoneFacts> | null): void {
  override = fn;
  // Defaults for a test: down since long ago, no other host configured.
  factsOverride = fn ? { lostSince: () => null, awakeDownMs: () => 0, uptimeMs: () => Number.MAX_SAFE_INTEGER, otherHosts: async () => ({ configured: 0, connected: 0 }), online: () => true, ...(facts ?? {}) } : null;
  memo.clear();
}

/** A connect that failed on a sign-in, a host key or a missing leader: the host may well be up. */
const SIGN_IN = /permission denied|publickey|authenticat|host key|credential|sign.?in|certificate|expired|needs.?leader|other_hosts_need_mac|too many authentication/i;
/**
 * A connect that failed before it left this machine: no route at all, or no DNS server
 * answering. A name that does not resolve is not one: a laptop's `.local` name goes with it.
 */
const OWN_NETWORK = /network is unreachable|ENETUNREACH|temporary failure in name resolution|EAI_AGAIN/i;

async function realFacts(): Promise<GoneFacts> {
  const [{ getConfig }, dc] = await Promise.all([import('../config-manager.js'), import('../../providers/daemon-connection.js')]);
  return {
    lostSince: (host) => dc.daemonLinkLostSince(host),
    awakeDownMs: (host) => dc.getDaemonDisconnectedAwakeMs(host),
    uptimeMs: () => sinceBoot.sample(Date.now()),
    otherHosts: async (host) => {
      const hosts = Object.entries((await getConfig()).hosts ?? {})
        .filter(([name, def]) => name !== host && (def as { enabled?: boolean } | undefined)?.enabled !== false);
      return { configured: hosts.length, connected: hosts.filter(([name]) => !!dc.getConnectedDaemonConnection(name)).length };
    },
    online: () => Object.values(os.networkInterfaces()).some((addrs) => (addrs ?? []).some((a) => !a.internal && !(a.family === 'IPv6' && a.address.startsWith('fe80')) && !a.address.startsWith('169.254.'))),
  };
}

/**
 * Whether a session's work may go on on another host: its link has been down at least
 * HOST_GONE_AFTER_MS of this machine's awake time (or this server has run that long without
 * reaching it), this machine is online (the work's new host answers, or some other host does,
 * or with no other host, it has a network address and the failure is not its own), and the
 * host does not answer for a reason other than a sign-in. `target`: where the work would go.
 * Never throws.
 */
export async function hostGone(host: string | null | undefined, opts: { target?: string | null; now?: number } = {}): Promise<HostGone> {
  if (isLocalHost(host)) return { gone: false, why: 'it is this machine' };
  const now = opts.now ?? Date.now();
  const words = hostWords(host);
  // The facts this server already holds first: a dial costs up to HOST_LOST_PROBE_MS.
  const facts = factsOverride ?? await realFacts();
  const since = facts.lostSince(String(host));
  const awake = since != null ? facts.awakeDownMs(String(host)) : 0;
  const downMs = since != null ? (awake > 0 ? Math.min(awake, now - since) : now - since) : facts.uptimeMs();
  const later = `if it stays away, try again after ${Math.round(HOST_GONE_AFTER_MS / 60_000)} minutes`;
  if (downMs < HOST_GONE_AFTER_MS) {
    return { gone: false, unreachable: true, why: `${words} has been unreachable for only ${Math.round(downMs / 1000)} s; ${later}` };
  }
  const offline = { gone: false as const, unreachable: true as const, why: `this machine may be the one offline: ${words} does not answer, and neither does any other host` };
  if (!facts.online()) return { gone: false, unreachable: true, why: 'this machine has no network connection' };
  if (opts.target && !isLocalHost(opts.target)) {
    // The work's new host answering proves this machine is online.
    if (!(await probeHost(opts.target)).reachable) return offline;
  } else {
    const others = await facts.otherHosts(String(host)).catch(() => ({ configured: 0, connected: 0 }));
    if (others.configured > 0 && others.connected === 0) return offline;
  }
  const reach = await probeHost(host);
  if (reach.reachable) return { gone: false, why: 'it answers' };
  if (SIGN_IN.test(reach.error)) {
    return { gone: false, unreachable: true, why: `the sign-in to ${words} failed (${reach.error}): it may still be running the session; fix the sign-in instead` };
  }
  if (OWN_NETWORK.test(reach.error)) return { gone: false, unreachable: true, why: `the connect to ${words} failed on this machine's own network (${reach.error}); ${later}` };
  return { gone: true, error: reach.error };
}

/**
 * Whether the host's daemon answers now: a live connection, else a fresh connect within
 * `ms`. This machine's own host always counts as reachable (its daemon is this server's
 * to restart, never a host that went away). Never throws.
 */
export async function probeHost(host: string | null | undefined, ms = HOST_LOST_PROBE_MS): Promise<HostReach> {
  if (isLocalHost(host)) return { reachable: true };
  const key = String(host);
  if (override) return override(key);
  const dc = await import('../../providers/daemon-connection.js');
  if (dc.getConnectedDaemonConnection(key)) {
    memo.delete(key);
    return { reachable: true };
  }
  const held = memo.get(key);
  if (held && Date.now() - held.at < HOST_LOST_MEMO_MS) return { reachable: false, error: held.error, ...(held.downSince ? { downSince: held.downSince } : {}) };
  let error: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { link } = await import('../hosts/link.js');
    const conn = await Promise.race([
      link(key),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms); }),
    ]);
    if (conn.connected) {
      memo.delete(key);
      return { reachable: true };
    }
    error = 'its daemon did not answer';
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const lost = dc.daemonLinkLostSince(key);
  const downSince = lost != null ? new Date(lost).toISOString() : undefined;
  memo.set(key, { at: Date.now(), error, ...(downSince ? { downSince } : {}) });
  return { reachable: false, error, ...(downSince ? { downSince } : {}) };
}

export function hostLostStopError(host: string, error: string): string {
  return `${HOST_LOST_STOP_PREFIX}: ${hostWords(host)} could not be reached (${error}); its host ends the process when it reconnects`;
}

export function isHostLostStopError(error: string | undefined): boolean {
  return typeof error === 'string' && error.startsWith(HOST_LOST_STOP_PREFIX);
}

/** Why a message cannot reach a lost session, and the way on. */
export function hostLostFenceText(record: Pick<SessionRecord, 'hostLost' | 'taskId' | 'host'>): string {
  const lost = record.hostLost;
  const host = hostWords(lost?.host ?? record.host);
  return `This session's host ${host} could not be reached, so Walnut stopped it here${lost?.at ? ` at ${lost.at}` : ''}; `
    + `${host} ends its process when it reconnects. `
    + (record.taskId
      ? `To carry the task on now, move it to another host: task_move {"id":"${record.taskId}","host":"<another host>"} (its conversation goes with it).`
      : 'Start the work again on another host.');
}

/** Who a stop is from, for the record: 'human', or 'task:<id>' for a session caller. */
export async function stopperOf(callerSid: string | undefined): Promise<string> {
  if (!callerSid) return 'human';
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(callerSid);
    return rec?.taskId ? `task:${rec.taskId}` : `session:${callerSid}`;
  } catch {
    return `session:${callerSid}`;
  }
}
