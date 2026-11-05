/**
 * The per-host readiness store: the last preflight answer per host, the fix
 * state merged into it on read, and the change listeners. Split out of
 * host-readiness.ts (which probes and fixes) so both it and the floor module
 * (host-readiness-floor.ts) share one store; import through host-readiness.ts.
 */

import type { HostPreflightResult } from '../../providers/host-runtime-core.js'
import { withFixState, type HostFixAction, type HostFixing, type HostFixRecord } from './host-autofix.js'
import type { ReadinessProblem } from './host-readiness-problems.js'
import { forgetAllHostFixes, forgetHostFixes } from './host-fix-memory.js'
import { hostUsedForSessions } from './host-session-use.js'
import { BLOCKING_READINESS_KINDS } from './host-problem.js'

export interface HostReadiness extends HostPreflightResult {
  /** When the host was last ASKED (success or failure): the UI's "is this answer new" key. */
  checkedAt: number
  /** Empty when nothing needs doing: the UI then shows nothing at all. */
  problems: ReadinessProblem[]
  /**
   * The last re-check failed (RPC error or timeout). The other fields are the
   * previous good answer, kept so the problem lines do not vanish on a blip.
   */
  checkError?: string
  /** The automatic fix running on the host right now (host-autofix.ts). */
  fixing?: HostFixing
  /**
   * Every automatic fix this server ran on the host, oldest first. `ageMs` is
   * how long ago each finished when this snapshot was taken, so a client times
   * a fix line against its own clock (server and browser clocks may differ).
   */
  fixes: Array<HostFixRecord & { ageMs: number }>
  /**
   * false: nothing points this host's sessions anywhere (no project starts there, no open
   * task last started there, no session open there), so a Claude Code problem here is a
   * Settings line, not an attention card (host-session-use.ts). Absent until first read.
   */
  usedForSessions?: boolean
}

/** What the store keeps: the preflight answer; fix state is merged on read. */
export type StoredReadiness = Omit<HostReadiness, 'fixing' | 'fixes'>

// ── Per-host store ──

export const store = new Map<string, StoredReadiness>()
export const inFlight = new Map<string, Promise<HostReadiness | null>>()
export const listeners = new Set<(host: string) => void>()
/** Per host: the fix running now and the finished ones (kept across reconnects). */
export const fixState = new Map<string, { fixing?: HostFixing; fixes: HostFixRecord[] }>()
/** Per host: fixes already tried (the once-per-problem rule; failures of earlier servers: host-fix-memory.ts). */
export const attempted = new Map<string, Set<HostFixAction>>()
/**
 * Hosts where a person asked for the coding agent's install or update (Install / Update on
 * the host's line), with when: the next autofix round within AGENTS_ASK_MS may run those
 * fixes, and only that round.
 */
export const agentsAsked = new Map<string, number>()
export const AGENTS_ASK_MS = 10 * 60_000

/** Did a person ask for the coding agent's fixes on `host` recently? */
export function agentsAskedNow(host: string, now: number = Date.now()): boolean {
  const at = agentsAsked.get(host)
  return at !== undefined && now - at >= 0 && now - at < AGENTS_ASK_MS
}
/** Per host: the autofix round in progress, if any. */
export const rounds = new Map<string, Promise<void>>()
export const MAX_FIX_RECORDS = 20
/** Per host: a shipped prebuilt dtach matches its platform/arch (last preflight). */
export const prebuiltFor = new Map<string, boolean>()
/** Hosts where the prebuilt was offered and did not run (an older glibc, say). */
export const prebuiltUnusable = new Set<string>()
/** Per host: how its lines were worded (label, target, prebuilt), so a floor change rewords with no RPC. */
export const problemCtx = new Map<string, { prebuiltDtach: boolean; hostLabel?: string; sshTarget?: string }>()

/** The stored answer with the fix state merged in, as every surface reads it. */
export function getHostReadiness(host: string, now: number = Date.now()): HostReadiness | undefined {
  const base = store.get(host)
  if (!base) return undefined
  const fx = fixState.get(host)
  const fixes = fx?.fixes ?? []
  const fixing = fx?.fixing
  const problems = withFixState(base.problems, base, fixing, fixes)
  const usedForSessions = hostUsedForSessions(host)
  return {
    ...base, problems,
    fixes: fixes.map((f) => ({ ...f, ageMs: Math.max(0, now - f.finishedAt) })),
    ...(fixing ? { fixing } : {}),
    ...(usedForSessions !== undefined ? { usedForSessions } : {}),
  }
}

/** The readiness kinds that mean Claude Code cannot start at all on the host (not just an override away). */
const CLAUDE_UNUSABLE_KINDS: readonly string[] = ['claude_missing', 'claude_needs_node', 'claude_error']

/**
 * Why Walnut must not pick this remote host for a Claude Code session ON ITS OWN, or null
 * (2026-11-05: placement read every remote host as able to run Claude Code, so a fleet Mac
 * with none installed scored like any other). Only a host whose last check said yes to all
 * of it is picked: Claude Code found, signed in, its version read and new enough, and the
 * check itself answered. A refusal (BLOCKING_READINESS_KINDS) gives its own sentence; an
 * answer that could not tell (a timed-out sign-in or version probe, an older daemon that
 * does not report one, a re-check that failed) keeps the host out too. A person may still
 * pick any host; the picker and Start say what is wrong there.
 */
export function claudeSessionBlocker(host: string): string | null {
  if (!host || host === '__local__') return null
  const r = store.get(host)
  if (!r) return `Walnut has not checked Claude Code on ${host} yet`
  const p = r.problems.find((x) => BLOCKING_READINESS_KINDS.includes(x.kind))
  if (p) return p.message.replace(/\.\s*$/, '')
  const c = r.claude
  if (r.checkError) return `Walnut's last check of Claude Code on ${host} did not answer`
  if (c.unknown || !c.found) return `Walnut could not tell whether Claude Code runs on ${host}`
  if (c.auth !== 'ok') return `Walnut could not tell whether Claude Code on ${host} is signed in`
  if (!c.version || (c.minVersion && c.versionOk !== true)) return `Walnut could not read which Claude Code ${host} runs`
  return null
}

/** The stored problem that means Claude Code cannot start on the host at all, or undefined. */
export function claudeUnusableProblem(host: string): ReadinessProblem | undefined {
  return store.get(host)?.problems.find((x) => CLAUDE_UNUSABLE_KINDS.includes(x.kind))
}

/**
 * A human asked again ("Check again" / Connect): every fix may run once more.
 * A round already running keeps its own record and is not restarted.
 */
export function resetHostAutofixAttempts(host: string): void {
  attempted.delete(host)
  void forgetHostFixes(host)
}

/** Fires when a host's readiness changed (set or cleared). Returns an unsubscribe. */
export function onHostReadinessChange(cb: (host: string) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function notifyReadiness(host: string): void {
  for (const cb of listeners) {
    try { cb(host) } catch { /* an observer must never break the probe */ }
  }
}

/**
 * Test seam + disconnect-free reset. The failed fixes kept across restarts go
 * too, unless `keepFixMemory` (a test standing in for a server restart).
 */
export function clearHostReadiness(host?: string, opts: { keepFixMemory?: boolean } = {}): void {
  if (host === undefined) {
    store.clear(); inFlight.clear(); fixState.clear(); attempted.clear(); rounds.clear(); agentsAsked.clear()
    prebuiltFor.clear(); prebuiltUnusable.clear(); problemCtx.clear()
    if (!opts.keepFixMemory) void forgetAllHostFixes()
    return
  }
  if (!opts.keepFixMemory) void forgetHostFixes(host)
  store.delete(host)
  inFlight.delete(host)
  fixState.delete(host)
  attempted.delete(host)
  agentsAsked.delete(host)
  rounds.delete(host)
  prebuiltFor.delete(host)
  prebuiltUnusable.delete(host)
  problemCtx.delete(host)
}

/**
 * A re-check that failed still answers the human who asked: keep the previous
 * good answer, stamp the attempt and its error, and push. With no previous
 * answer there is nothing on screen to update, so nothing is stored.
 */
export function markCheckFailed(host: string, message: string, at: number): void {
  const prev = store.get(host)
  if (!prev) return
  store.set(host, { ...prev, checkedAt: at, checkError: message.slice(0, 300) })
  notifyReadiness(host)
}

export function setFixState(host: string, update: (s: { fixing?: HostFixing; fixes: HostFixRecord[] }) => void): void {
  const s = fixState.get(host) ?? { fixes: [] }
  update(s)
  if (s.fixes.length > MAX_FIX_RECORDS) s.fixes.splice(0, s.fixes.length - MAX_FIX_RECORDS)
  fixState.set(host, s)
  notifyReadiness(host)
}

// ── Hosts that must never be probed (the Playwright host fixture) ──

let probeSkip: ((host: string) => boolean) | null = null

/**
 * A fixture host's "daemon" is the MockDaemon, which has no host.preflight: a
 * real probe would store `unknown command: host.preflight` as its checkError.
 * The fixture seeds its own answers and registers here (host-fixture.ts).
 */
export function setReadinessProbeSkip(fn: ((host: string) => boolean) | null): void { probeSkip = fn }

export function readinessProbeSkipped(host: string): boolean {
  try { return !!probeSkip?.(host) } catch { return false }
}
