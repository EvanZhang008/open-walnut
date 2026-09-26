/**
 * The per-host readiness store: the last preflight answer per host, the fix
 * state merged into it on read, and the change listeners. Split out of
 * host-readiness.ts (which probes and fixes) so both it and the floor module
 * (host-readiness-floor.ts) share one store; import through host-readiness.ts.
 */

import type { HostPreflightResult } from '../../providers/host-runtime-core.js'
import { withFixState, type HostFixAction, type HostFixing, type HostFixRecord } from './host-autofix.js'
import type { ReadinessProblem } from './host-readiness-problems.js'

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
}

/** What the store keeps: the preflight answer; fix state is merged on read. */
export type StoredReadiness = Omit<HostReadiness, 'fixing' | 'fixes'>

// ── Per-host store ──

export const store = new Map<string, StoredReadiness>()
export const inFlight = new Map<string, Promise<HostReadiness | null>>()
export const listeners = new Set<(host: string) => void>()
/** Per host: the fix running now and the finished ones (kept across reconnects). */
export const fixState = new Map<string, { fixing?: HostFixing; fixes: HostFixRecord[] }>()
/** Per host: fixes already tried this server lifetime (the once-per-problem rule). */
export const attempted = new Map<string, Set<HostFixAction>>()
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
  return {
    ...base, problems,
    fixes: fixes.map((f) => ({ ...f, ageMs: Math.max(0, now - f.finishedAt) })),
    ...(fixing ? { fixing } : {}),
  }
}

/**
 * A human asked again ("Check again" / Connect): every fix may run once more.
 * A round already running keeps its own record and is not restarted.
 */
export function resetHostAutofixAttempts(host: string): void {
  attempted.delete(host)
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

/** Test seam + disconnect-free reset. */
export function clearHostReadiness(host?: string): void {
  if (host === undefined) {
    store.clear(); inFlight.clear(); fixState.clear(); attempted.clear(); rounds.clear()
    prebuiltFor.clear(); prebuiltUnusable.clear(); problemCtx.clear()
    return
  }
  store.delete(host)
  inFlight.delete(host)
  fixState.delete(host)
  attempted.delete(host)
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
