/**
 * A person's unlock of the vault in one client (docs/reference/passwords.md,
 * "Unlocking"). The master password (as its password key) buys a vault session
 * token; every item read or write through the API carries it in
 * `x-walnut-vault-session`. Sessions live in memory; session-store.ts keeps a copy (token
 * hashes only) so a Walnut restart keeps them, except those of "until restart". A session ends
 * after its idle time without use and after its length whatever happens (unlock-length.ts: the
 * person's "Keep Passwords unlocked" choice; a plain number of idle minutes keeps the old rule,
 * MAX_SESSION_HOURS at most), or on Lock. "Until restart" and "forever" sessions have neither
 * clock.
 *
 * Wrong passwords are slowed down per server: after FREE_FAILURES in a row, each
 * further try waits twice as long as the last (30 s up to an hour). Every check of the
 * master password (unlock, export, a new password, the Secret Key, the agents switch)
 * counts, and only one runs at a time (beginAttempt).
 */
import crypto from 'node:crypto'

export const SESSION_HEADER = 'x-walnut-vault-session'
export const DEFAULT_IDLE_MINUTES = 15
export const MAX_SESSION_HOURS = 12
const FREE_FAILURES = 5

/**
 * `device`: the paired device whose token opened it (the browser extension, a paired browser); it holds only for that device.
 * `choice`: the unlock length it was made under; `keep`: a Walnut restart keeps it (session-store.ts).
 */
export interface Session { hash: string; client: string; createdAt: number; lastUsedAt: number; idleMs: number; maxMs: number; device?: string; choice?: string; keep?: boolean }

const sessions = new Map<string, Session>()

/** session-store.ts: told of every change (`use` is only a touch), and of a test reset. */
interface StoreHook { changed: (kind: 'change' | 'use') => void; reset: () => void }
let hook: StoreHook | null = null

export function setSessionStoreHook(h: StoreHook | null): void {
  hook = h
}

const changed = (kind: 'change' | 'use' = 'change') => hook?.changed(kind)

// When the last session runs out by itself (nobody pressed Lock), the vault closes too: the
// route layer registers what closing means (closeIfNobody), and one timer waits for the
// earliest expiry.
let onExpire: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

export function onSessionsExpired(cb: (() => void) | null): void {
  onExpire = cb
  schedule()
}

function expiryOf(s: Session): number {
  return Math.min(s.lastUsedAt + s.idleMs, s.createdAt + s.maxMs)
}

function schedule(): void {
  if (timer) { clearTimeout(timer); timer = null }
  if (!onExpire || sessions.size === 0) return
  let next = Infinity
  for (const s of sessions.values()) next = Math.min(next, expiryOf(s))
  if (next === Infinity) return // only sessions with no clock: nothing runs out by itself
  timer = setTimeout(() => {
    timer = null
    const left = liveSessionCount()
    if (left === 0) onExpire?.()
    else schedule()
  }, Math.max(1000, Math.min(next - Date.now() + 1000, 2 ** 31 - 1)))
  timer.unref?.()
}

/**
 * A session removed by itself (it lapsed when read, its device was removed or did not come with
 * it): when it was the last, the vault closes as when the timer finds them all gone. No timer
 * is armed once none are left, so this is the only way that close happens.
 */
function dropped(): void {
  changed()
  schedule()
  if (sessions.size === 0 && onExpire) { const cb = onExpire; queueMicrotask(() => cb()) }
}

function hashOf(token: string): string {
  return crypto.createHash('sha256').update(`walnut-vault-session\0${token}`).digest('hex')
}

/**
 * A new window unlock. `length`: idle minutes (the old rule: that long unused, MAX_SESSION_HOURS
 * at most), or the person's choice as limits (unlock-length.ts; Infinity = no such clock).
 * `expiresAt` is null for a session with no clock.
 */
export function createSession(client: string, length: number | { idleMs: number; maxMs: number; choice?: string; survivesRestart?: boolean }, device?: string): { token: string; expiresAt: string | null; idleMinutes: number | null } {
  const token = crypto.randomBytes(32).toString('base64url')
  const now = Date.now()
  let idleMs: number
  let maxMs: number
  const tag = typeof length === 'number' ? {} : { ...(length.choice ? { choice: length.choice } : {}), keep: length.survivesRestart !== false }
  if (typeof length === 'number') {
    idleMs = Math.max(1, Math.min(MAX_SESSION_HOURS * 60, Math.round(length || DEFAULT_IDLE_MINUTES))) * 60_000
    maxMs = MAX_SESSION_HOURS * 3_600_000
  } else {
    idleMs = length.idleMs > 0 ? length.idleMs : DEFAULT_IDLE_MINUTES * 60_000
    maxMs = length.maxMs > 0 ? length.maxMs : MAX_SESSION_HOURS * 3_600_000
  }
  sessions.set(hashOf(token), { hash: hashOf(token), client: client.slice(0, 80), createdAt: now, lastUsedAt: now, idleMs, maxMs, keep: true, ...tag, ...(device ? { device } : {}) })
  changed()
  schedule()
  const end = Math.min(now + idleMs, now + maxMs)
  return { token, expiresAt: Number.isFinite(end) ? new Date(end).toISOString() : null, idleMinutes: Number.isFinite(idleMs) ? Math.round(idleMs / 60_000) : null }
}

export function live(s: Session, now: number): boolean {
  return now - s.lastUsedAt <= s.idleMs && now - s.createdAt <= s.maxMs
}

/**
 * The session for a token, or null. `touch` (default) restarts its idle clock; a read the page
 * makes by itself (the one-time code refreshing every 30 s) passes false, so an open item
 * never keeps a window unlocked.
 */
export function useSession(token: string | undefined, touch: boolean, device: string | undefined): { client: string } | null {
  if (!token) return null
  const s = sessions.get(hashOf(token))
  const now = Date.now()
  if (!s) return null
  if (!live(s, now)) { sessions.delete(s.hash); dropped(); return null }
  // A session a device opened ends when that device's token no longer comes with it (removed in
  // Settings): the token alone was what made the session that device's.
  if (s.device && s.device !== device) { sessions.delete(s.hash); dropped(); return null }
  if (touch) { s.lastUsedAt = now; changed('use') } // the timer, when it fires early, schedules itself again
  return { client: s.client }
}

export function endSession(token: string | undefined): void {
  if (token && sessions.delete(hashOf(token))) changed()
  schedule()
}

/** Every session but `keep` (a new master password locks the other windows). */
export function endOtherSessions(keep: string | undefined): number {
  const k = keep ? hashOf(keep) : ''
  let n = 0
  for (const h of [...sessions.keys()]) if (h !== k) { sessions.delete(h); n++ }
  changed() // also with none ended: the kept copy is sealed again under the new vault key
  schedule()
  return n
}

/** Every session the device opened (it was removed). */
export function endDeviceSessions(device: string): number {
  let n = 0
  for (const [h, s] of [...sessions]) if (s.device === device) { sessions.delete(h); n++ }
  if (n) dropped(); else schedule()
  return n
}

export function endAllSessions(): number {
  const n = sessions.size
  sessions.clear()
  changed()
  schedule()
  return n
}

export function liveSessionCount(): number {
  const now = Date.now()
  let gone = false
  for (const s of sessions.values()) if (!live(s, now)) { sessions.delete(s.hash); gone = true }
  if (gone) changed()
  return sessions.size
}

/** Copies of the sessions open now (session-store.ts writes the ones a restart keeps). */
export function sessionList(): Session[] {
  return [...sessions.values()].map((s) => ({ ...s }))
}

/** Sessions a restart kept, back in memory (session-store.ts, at start, before any route reads one). */
export function restoreSessions(list: Session[]): void {
  for (const s of list) if (!sessions.has(s.hash)) sessions.set(s.hash, { ...s })
  schedule()
}

/**
 * The windows open now follow the limits in effect (a changed choice or idle minutes, a turned-off
 * machine key), but only ever shorter: each keeps the smaller idle and length of the two, and a
 * window stops surviving a restart when either says so. A longer choice applies to new unlocks.
 */
export function retimeSessions(limits: { idleMs: number; maxMs: number; survivesRestart?: boolean }): number {
  let n = 0
  for (const s of sessions.values()) {
    const idleMs = limits.idleMs > 0 ? Math.min(limits.idleMs, s.idleMs) : s.idleMs
    const maxMs = limits.maxMs > 0 ? Math.min(limits.maxMs, s.maxMs) : s.maxMs
    const keep = s.keep !== false && limits.survivesRestart !== false
    if (idleMs === s.idleMs && maxMs === s.maxMs && keep === (s.keep !== false)) continue
    s.idleMs = idleMs
    s.maxMs = maxMs
    s.keep = keep
    n++
  }
  // A shorter one may end some now; the last one ending closes the vault as an idle-out does.
  if (n) { liveSessionCount(); dropped() }
  return n
}

// ── wrong-password brake ──

let failures = 0
let blockedUntil = 0

/** Milliseconds until another try is allowed (0 = now). */
export function unlockWaitMs(now = Date.now()): number {
  return Math.max(0, blockedUntil - now)
}

export function noteUnlockFailure(now = Date.now()): void {
  failures += 1
  if (failures >= FREE_FAILURES) {
    const wait = Math.min(3_600_000, 30_000 * 2 ** (failures - FREE_FAILURES))
    blockedUntil = now + wait
  }
}

export function noteUnlockSuccess(): void {
  failures = 0
  blockedUntil = 0
}

let attemptRunning = false

/** A master-password check runs now (a close waits for it: it may be about to open a session). */
export function isAttemptRunning(): boolean {
  return attemptRunning
}

/**
 * One master-password check at a time, server-wide: a try while the brake holds, or while
 * another try runs, is refused before any work, so a burst of parallel guesses cannot all
 * pass the check before the first failure is counted. Returns why not, or null to go on;
 * the caller ends its try with endAttempt.
 */
export function beginAttempt(now = Date.now()): { code: 'unlock_slowed'; waitMs: number } | { code: 'unlock_busy'; waitMs: number } | null {
  const wait = unlockWaitMs(now)
  if (wait > 0) return { code: 'unlock_slowed', waitMs: wait }
  if (attemptRunning) return { code: 'unlock_busy', waitMs: 1000 }
  attemptRunning = true
  return null
}

export function endAttempt(outcome: 'ok' | 'wrong' | 'other'): void {
  attemptRunning = false
  if (outcome === 'ok') noteUnlockSuccess()
  else if (outcome === 'wrong') noteUnlockFailure()
}

export function resetSessionsForTest(): void {
  hook?.reset()
  attemptRunning = false
  sessions.clear()
  if (timer) { clearTimeout(timer); timer = null }
  failures = 0
  blockedUntil = 0
}
