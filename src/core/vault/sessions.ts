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
 * `here`: the person unlocked it on the computer Walnut runs on (a typed master password, or the
 * keychain at start), so this computer's browser extension and Walnut windows may share it (joinSession).
 * `source`: the hash of the unlock a shared session shares; it is part of that one unlock and
 * holds only while that one does.
 */
export interface Session { hash: string; client: string; createdAt: number; lastUsedAt: number; idleMs: number; maxMs: number; device?: string; choice?: string; keep?: boolean; here?: boolean; source?: string }

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
export function createSession(client: string, length: number | { idleMs: number; maxMs: number; choice?: string; survivesRestart?: boolean }, device?: string, here?: boolean): { token: string; expiresAt: string | null; idleMinutes: number | null } {
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
  sessions.set(hashOf(token), { hash: hashOf(token), client: client.slice(0, 80), createdAt: now, lastUsedAt: now, idleMs, maxMs, keep: true, ...tag, ...(device ? { device } : {}), ...(here ? { here: true } : {}) })
  changed()
  schedule()
  const end = Math.min(now + idleMs, now + maxMs)
  return { token, expiresAt: Number.isFinite(end) ? new Date(end).toISOString() : null, idleMinutes: Number.isFinite(idleMs) ? Math.round(idleMs / 60_000) : null }
}

export function live(s: Session, now: number): boolean {
  return now - s.lastUsedAt <= s.idleMs && now - s.createdAt <= s.maxMs
}

/** Live, and for a shared session, the unlock it shares is live too (one unlock: they end together). */
function alive(s: Session, now: number): boolean {
  if (!live(s, now)) return false
  if (!s.source) return true
  const src = sessions.get(s.source)
  return !!src && live(src, now)
}

/** Removes every session that is no longer alive (a lapsed one, a shared one whose unlock ended). True when any went. */
function sweep(now = Date.now()): boolean {
  const gone = [...sessions.values()].filter((s) => !alive(s, now)).map((s) => s.hash)
  for (const h of gone) sessions.delete(h)
  // A shared session whose unlock was among them goes with it.
  for (const s of [...sessions.values()]) if (s.source && !sessions.has(s.source)) { sessions.delete(s.hash); gone.push(s.hash) }
  return gone.length > 0
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
  if (!alive(s, now)) { sweep(now); dropped(); return null }
  // A session a device opened ends when that device's token no longer comes with it (removed in
  // Settings): the token alone was what made the session that device's.
  if (s.device && s.device !== device) { sessions.delete(s.hash); sweep(now); dropped(); return null }
  if (touch) {
    s.lastUsedAt = now
    // One unlock: a use of a shared session renews the unlock it shares, as a use anywhere does.
    if (s.source) { const src = sessions.get(s.source); if (src) src.lastUsedAt = now }
    changed('use')
  } // the timer, when it fires early, schedules itself again
  return { client: s.client }
}

/**
 * One window's or device's Lock of itself. `joiner`: the extension device, or a Walnut window's
 * joiner id (browser-keys.ts windowJoiner), that locked only itself.
 */
export function endSession(token: string | undefined, joiner?: string): void {
  // The sessions sharing it end with it (one unlock).
  if (token && sessions.delete(hashOf(token))) { sweep(); changed() }
  // A device or window that locked only itself (its own auto-lock) stays locked until the person
  // unlocks again, after a restart too (session-store.ts keeps the record), also when it held no session.
  if (joiner) { selfLocked.set(joiner, Date.now()); changed() }
  schedule()
}

// ── one unlock for this computer's extension and Walnut windows (joinSession) ──

/**
 * When each joiner (an extension device, or a Walnut window's `window:<id>`) last locked only
 * itself: an unlock older than that is not shared with it.
 */
const selfLocked = new Map<string, number>()

/**
 * The record under this name holds against every joiner: a new master password (or a recovery)
 * means no unlock made before it is shared with any window or extension, only one typed with the
 * new password (endJoinsBefore). It rides the self-lock list, so a restart keeps it.
 */
const EVERY_JOINER = '*'

/** No unlock made up to now is shared any more (a master password change, a recovery). */
export function endJoinsBefore(now = Date.now()): void {
  selfLocked.set(EVERY_JOINER, now)
  changed()
}

/**
 * The Playwright fixture's one vault serves specs running side by side, each with an extension
 * and windows of its own, so there (WALNUT_TEST_VAULT_JOIN=named) only the devices and windows a
 * spec names share an unlock (routes/test-vault-join.ts); one spec's unlock never unlocks another's.
 */
const joinOnlyNamed = process.env.WALNUT_TEST_VAULT_JOIN === 'named'
const joinNamed = new Set<string>()

export function joinTestRouteAllowed(opts: { ephemeral: boolean; cloudMode: boolean }): boolean {
  return joinOnlyNamed && opts.ephemeral && !opts.cloudMode
}

export function nameJoinDeviceForTest(joiner: string, on: boolean): void {
  if (on) joinNamed.add(joiner); else joinNamed.delete(joiner)
}

/**
 * The unlock `joiner` may share (this computer's extension device, or a Walnut window here by its
 * `window:<id>`): a live one the person made on this computer after the joiner last locked only
 * itself, the one that lasts longest.
 */
export function joinSource(joiner: string, now = Date.now()): Session | null {
  if (joinOnlyNamed && !joinNamed.has(joiner)) return null
  const since = Math.max(selfLocked.get(joiner) ?? 0, selfLocked.get(EVERY_JOINER) ?? 0)
  let best: Session | null = null
  for (const s of sessions.values()) {
    if (!s.here || s.source || s.createdAt <= since || !alive(s, now)) continue
    if (!best || expiryOf(s) > expiryOf(best)) best = s
  }
  return best
}

/**
 * A session for `joiner` sharing the person's unlock on this computer: a token of its own and part
 * of that one unlock (`source`): it starts on the same clocks, holds only while that unlock does
 * (its expiry, a Lock of it, Lock all end both), and a use of it renews that unlock, as a use in
 * any window does. So sharing never makes an unlock last longer. `kind` 'device': the extension's,
 * held only with that device's token; 'window': a Walnut window's, held as a window's own unlock
 * is (its token, which only that browser keeps). Null when there is nothing to share.
 */
export function joinSession(joiner: string, client: string, kind: 'device' | 'window' = 'device'): { token: string; expiresAt: string | null } | null {
  const src = joinSource(joiner)
  if (!src) return null
  const token = crypto.randomBytes(32).toString('base64url')
  const hash = hashOf(token)
  sessions.set(hash, {
    hash, client: client.slice(0, 80), createdAt: src.createdAt, lastUsedAt: src.lastUsedAt, idleMs: src.idleMs, maxMs: src.maxMs, ...(kind === 'device' ? { device: joiner } : {}),
    ...(src.choice ? { choice: src.choice } : {}), keep: src.keep !== false, source: src.hash,
  })
  changed()
  schedule()
  const end = expiryOf(sessions.get(hash)!)
  return { token, expiresAt: Number.isFinite(end) ? new Date(end).toISOString() : null }
}

/** Every session but `keep` (a new master password locks the other windows). */
export function endOtherSessions(keep: string | undefined): number {
  const k = keep ? hashOf(keep) : ''
  // A shared session kept keeps the unlock it is part of.
  const ks = sessions.get(k)?.source ?? ''
  let n = 0
  for (const h of [...sessions.keys()]) if (h !== k && h !== ks) { sessions.delete(h); n++ }
  changed() // also with none ended: the kept copy is sealed again under the new vault key
  schedule()
  return n
}

/** Every session the device opened (it was removed). */
export function endDeviceSessions(device: string): number {
  let n = 0
  for (const [h, s] of [...sessions]) if (s.device === device) { sessions.delete(h); n++ }
  if (n) { sweep(); dropped() } else schedule()
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
  if (sweep()) changed()
  return sessions.size
}

/** Copies of the sessions open now (session-store.ts writes the ones a restart keeps). */
export function sessionList(): Session[] {
  return [...sessions.values()].map((s) => ({ ...s }))
}

/** Sessions a restart kept, back in memory (session-store.ts, at start, before any route reads one). */
export function restoreSessions(list: Session[]): void {
  for (const s of list) if (!sessions.has(s.hash)) sessions.set(s.hash, { ...s })
  // A shared session the file kept without the unlock it shares does not come back alone.
  sweep()
  schedule()
}

/** When each device last locked only itself (session-store.ts keeps them for a restart). */
export function selfLockList(): Array<{ device: string; at: number }> {
  return [...selfLocked].map(([device, at]) => ({ device, at }))
}

/** The records a restart kept, back in memory before any route answers (session-store.ts). */
export function restoreSelfLocks(list: Array<{ device: string; at: number }>): void {
  for (const { device, at } of list) if (at > (selfLocked.get(device) ?? 0)) selfLocked.set(device, at)
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
  selfLocked.clear()
  if (timer) { clearTimeout(timer); timer = null }
  failures = 0
  blockedUntil = 0
}
