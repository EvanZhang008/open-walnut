/**
 * Why a dropped host has not come back yet, and what the reconnect loop does
 * about it. daemon-connection.ts's scheduleReconnect used to log the failure
 * kind and nothing else: the phase stayed 'reconnecting' forever, with no
 * cause on any surface and no action. This module keeps the cause per host
 * (read by getDaemonConnectState, so buildHostStatus can say it) and decides
 * the next step, as a pure function the loop and the tests share.
 *
 * Rules (spec G4):
 *  - auth / host_key / dns: standing. The screen says 'failed' (the host will
 *    not come back by itself soon), but recovery never stops: exactly ONE slow
 *    probe (RECONNECT_STANDING_FAILURE_DELAY_MS) is scheduled, and its time is
 *    the real `retryAt`.
 *  - cert_expired / agent_missing / proxy_login: standing, re-dialled on the
 *    credential schedule (1, 2, 5 minutes, then every 5) and at once when a
 *    login is seen (host-credential-signal.ts); `retryAt` = the scheduled one.
 *  - dns / unreachable / timeout within WAKE_GRACE_MS of a wake or network
 *    change: NOT standing (Wi-Fi or VPN is still coming up after the lid opens).
 *  - anything else: plain exponential backoff, no promise of a time.
 */

import type { HostConnectErrorKind } from '../core/sessions/host-connect-hint.js'

/** A dns / unreachable / timeout this soon after a wake or network change is the network waking up. */
export const WAKE_GRACE_MS = 90_000

const SLOW_PROBE_KINDS: ReadonlySet<string> = new Set(['auth', 'host_key', 'dns'])
const CREDENTIAL_KINDS: ReadonlySet<string> = new Set(['cert_expired', 'agent_missing', 'proxy_login'])
const WAKE_TRANSIENT_KINDS: ReadonlySet<string> = new Set(['dns', 'unreachable', 'timeout'])

/** A failure a login fixes (cert_expired, agent_missing, proxy_login): the credential schedule's kinds. */
export function isCredentialWaitKind(kind: string): boolean {
  return CREDENTIAL_KINDS.has(kind)
}

export interface ReconnectStepInput {
  kind: HostConnectErrorKind | string
  now: number
  /** The backoff delay that led to this failed attempt. */
  delayMs: number
  /** Consecutive credential-wait failures so far (index into the credential schedule). */
  credentialAttempt: number
  /** Epoch ms of the last wake / network-change signal (0 = none). */
  lastSignalAt: number
  standingDelayMs: number
  maxDelayMs: number
  credentialDelayMs: (attempt: number) => number
}

export interface ReconnectStep {
  /** Show 'failed' on screen (recovery continues on the slow schedule). */
  standing: boolean
  credentialWait: boolean
  nextDelayMs: number
  /** Epoch ms of the next attempt Walnut really has scheduled; only when standing. */
  retryAt?: number
}

export function decideReconnectStep(i: ReconnectStepInput): ReconnectStep {
  const afterWake = i.lastSignalAt > 0 && i.now - i.lastSignalAt < WAKE_GRACE_MS && WAKE_TRANSIENT_KINDS.has(i.kind)
  if (CREDENTIAL_KINDS.has(i.kind)) {
    const nextDelayMs = i.credentialDelayMs(i.credentialAttempt)
    return { standing: true, credentialWait: true, nextDelayMs, retryAt: i.now + nextDelayMs }
  }
  if (SLOW_PROBE_KINDS.has(i.kind) && !afterWake) {
    return { standing: true, credentialWait: false, nextDelayMs: i.standingDelayMs, retryAt: i.now + i.standingDelayMs }
  }
  return { standing: false, credentialWait: false, nextDelayMs: Math.min(Math.max(1, i.delayMs) * 2, i.maxDelayMs) }
}

/** The last failure of the reconnect loop for one host. */
export interface ReconnectCause {
  summary: string
  kind: HostConnectErrorKind | string
  /** When the host dropped (the reconnect began). */
  since: number
  /** When this failure was seen. */
  at: number
  standing: boolean
  retryAt?: number
}

const causes = new Map<string, ReconnectCause>()

export function recordReconnectCause(host: string, cause: ReconnectCause): void {
  causes.set(host, cause)
}

export function getReconnectCause(host: string): ReconnectCause | undefined {
  return causes.get(host)
}

/** The host came back, was removed, or a human dialled it fresh. */
export function clearReconnectCause(host?: string): void {
  if (host === undefined) causes.clear()
  else causes.delete(host)
}

// ── Wake / network-change signals (host-wake-signal.ts stamps these) ──

let lastSignalAt = 0

export function noteHostSignal(at: number): void {
  lastSignalAt = Math.max(lastSignalAt, at)
}

export function lastHostSignalAt(): number {
  return lastSignalAt
}

/** Test seam. */
export function resetHostSignalForTest(): void {
  lastSignalAt = 0
}
