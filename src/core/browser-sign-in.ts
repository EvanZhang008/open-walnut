/**
 * A browser's sign-in renews itself (2026-11-04, the user asked for the way a
 * well-known dashboard keeps a phone signed in: a short-lived access token, and
 * a long-lived refresh token that only the renewal path ever sees).
 *
 * A browser signed in with a code (routes/browser-pair.ts) holds two tokens:
 *  - the ACCESS token, in the page (localStorage, its headers, the WebSocket and
 *    the media cookie). Its hash is the record's `tokenHash`, as any device
 *    token's, so every server role that checks device tokens checks it the same
 *    way. Refused here after `accessUntil`: 20 hours.
 *  - the REFRESH token, in an HttpOnly cookie sent only to /api/auth/browser
 *    (routes/browser-sign-in.ts). No script can read it, and Safari's 7-day
 *    rules (script storage, script-written cookies) never reach a cookie the
 *    server set, so it outlives a page whose storage Safari cleared.
 *
 * Renewing trades the refresh token for a new pair, once: the old one is
 * recorded as spent. A spent token presented again is a replay (someone else
 * holds a copy) and signs the browser out, except
 *  - within a minute of its use (two tabs renewing at once, a retry): the same
 *    answer again while this process still holds it, else 409 and the page asks
 *    again with the cookie its browser has by then;
 *  - when nothing issued since it was traded was ever used (every later pair
 *    went unused, and was itself issued for a lost answer): that answer never
 *    reached the browser (a phone that lost its network), so it is answered
 *    again with a fresh pair. A thief who tried it first is found the moment
 *    the browser presents the token it does hold.
 * A sign-in not renewed for a year ends, and so does one whose page comes to
 * renew with its access token but without its refresh cookie (it can never
 * renew again). Nothing is bound to an address: a phone moves between Wi-Fi
 * and cellular.
 *
 * A browser signed in before renewing existed holds one token that never
 * expires: its first renewal (the page sends it) starts the pair in its place,
 * with no new code.
 */

import crypto from 'node:crypto'
import { log } from '../logging/index.js'
import { listDeviceRecords, notifyPaired, resetLastUsedThrottle, revokePairing } from './device-auth.js'
import { BROWSER_SIGN_IN_NAME, hashesEqual, recordForToken, sha256Hex, tombstone, updateAuth, type BrowserSignInState, type DeviceRecord } from './device-store.js'
import { dropRevokeIntent, finishRevoke, pairingsOf, trackRevokeWork, writeRevokeIntent, type RevokePlan } from './devices/revoke-parts.js'

export { BROWSER_SIGN_IN_NAME }

export const ACCESS_TTL_MS = 20 * 60 * 60 * 1000
/** Not renewed for this long: the sign-in ends. */
export const IDLE_LIMIT_MS = 365 * 24 * 60 * 60 * 1000
/** A spent refresh token presented again this soon is a race, never a replay. */
export const RACE_MS = 60_000
/** Spent refresh tokens kept per browser for replay detection. */
const SPENT_KEPT = 8
/** Renewals one sign-in may make in RENEW_WINDOW_MS. */
const RENEW_MAX = 30
const RENEW_WINDOW_MS = 10 * 60_000

/**
 * The access token's lifetime: 20 hours, or shorter when the operator asks
 * (`WALNUT_BROWSER_ACCESS_TTL_S`, 30 s at least; a demo or a test of renewal).
 */
export function accessTtlMs(): number {
  const s = Number(process.env.WALNUT_BROWSER_ACCESS_TTL_S)
  return Number.isFinite(s) && s >= 30 && s * 1000 < ACCESS_TTL_MS ? Math.round(s * 1000) : ACCESS_TTL_MS
}

export interface IssuedSignIn {
  name: string
  /** The access token (plaintext, once). */
  token: string
  /** The refresh token (plaintext, once): the route puts it in its cookie. */
  refreshToken: string
  /** Epoch ms. */
  accessUntil: number
  accessMs: number
}

export type RenewOutcome =
  | ({ kind: 'renewed'; migrated?: true } & IssuedSignIn)
  /** A spent refresh token, in its first minute, with no answer kept: ask again. */
  | { kind: 'raced' }
  /** A spent refresh token presented again: the browser was signed out. */
  | { kind: 'replayed'; name: string }
  /** Not renewed for a year: the browser was signed out. */
  | { kind: 'idle'; name: string }
  /** A renewing sign-in's access token with no refresh cookie it knows: it can never renew, so it was signed out. */
  | { kind: 'lost'; name: string }
  /** A token nothing here knows (or one revoked). `staleCookie`: a refresh token was presented. */
  /** `removed`: its refresh token is one of a browser removed on the computer (device-auth.ts). */
  | { kind: 'refused'; staleCookie: boolean; removed?: true }
  /** Nothing that renews: none presented, a token that never expires, or an access token alone. */
  | { kind: 'nothing'; staleCookie: boolean }
  | { kind: 'limited' }

const iso = (ms: number) => new Date(ms).toISOString()

/** Answers already given, by the hash of what was presented, kept RACE_MS (two tabs at once get the same pair). */
const answered = new Map<string, { issued: IssuedSignIn; at: number }>()
/** Renewal times per browser (its name), for the per-sign-in limit. */
const renewals = new Map<string, number[]>()

function pruneAnswered(now: number): void {
  for (const [k, v] of answered) if (now - v.at >= RACE_MS) answered.delete(k)
}

function overLimit(name: string, now: number): boolean {
  const recent = (renewals.get(name) ?? []).filter((t) => now - t < RENEW_WINDOW_MS)
  renewals.set(name, recent)
  return recent.length >= RENEW_MAX
}

/** The record holding `hash` as its current refresh token, compared against every record. */
function currentHolder(devices: readonly DeviceRecord[], hash: string): DeviceRecord | undefined {
  let found: DeviceRecord | undefined
  for (const d of devices) if (d.browserSignIn && hashesEqual(hash, d.browserSignIn.refreshHash)) found = d
  return found
}

/**
 * The record that spent `hash`, when, and whether every pair issued since was
 * one answered again for a lost answer (`lostSince`): then this browser may
 * still hold only `hash`.
 */
function spender(devices: readonly DeviceRecord[], hash: string): { d: DeviceRecord; at: number; lostSince: boolean } | undefined {
  let found: { d: DeviceRecord; at: number; lostSince: boolean } | undefined
  for (const d of devices) {
    const spent = d.browserSignIn?.spent ?? []
    spent.forEach((s, i) => {
      if (hashesEqual(hash, s.hash)) found = { d, at: Date.parse(s.at), lostSince: spent.slice(i + 1).every((later) => later.lost) }
    })
  }
  return found
}

/** A new pair on `d`, in the locked write: the old access token stops, `spentHash` joins the spent list. */
function issue(d: DeviceRecord, spentHash: string | null, now: number, lost = false, migratedFrom?: string): IssuedSignIn {
  const ttl = accessTtlMs()
  const token = crypto.randomBytes(16).toString('hex')
  const refreshToken = crypto.randomBytes(32).toString('base64url')
  const replacedHash = d.tokenHash
  d.tokenHash = sha256Hex(token)
  // Set again at the new token's first use (written at once: the throttle forgets this name first):
  // a pair whose token was never used is one whose answer was lost.
  delete d.lastUsedAt
  resetLastUsedThrottle(d.name)
  const spent = [...(d.browserSignIn?.spent ?? []), ...(spentHash ? [{ hash: spentHash, at: iso(now), ...(lost ? { lost: true as const } : {}) }] : [])].slice(-SPENT_KEPT)
  const state: BrowserSignInState = { refreshHash: sha256Hex(refreshToken), renewedAt: iso(now), accessUntil: iso(now + ttl), ...(spent.length > 0 ? { spent } : {}), replacedHash, ...(migratedFrom ? { migratedFrom } : {}) }
  d.browserSignIn = state
  return { name: d.name, token, refreshToken, accessUntil: now + ttl, accessMs: ttl }
}

/**
 * Start the renewing sign-in of a browser just paired with `token`
 * (routes/browser-pair.ts): the token becomes its access token, with a refresh
 * token beside it. Null when the record is gone or is not that browser's.
 */
export async function beginBrowserSignIn(name: string, token: string, now: number = Date.now()): Promise<IssuedSignIn | null> {
  if (!BROWSER_SIGN_IN_NAME.test(name)) return null
  const ttl = accessTtlMs()
  return updateAuth((auth) => {
    const d = recordForToken(auth.devices, token)
    if (!d || d.name !== name || d.kind === 'machine' || d.browserSignIn) return { persist: false, result: null }
    const refreshToken = crypto.randomBytes(32).toString('base64url')
    d.browserSignIn = { refreshHash: sha256Hex(refreshToken), renewedAt: iso(now), accessUntil: iso(now + ttl) }
    return { persist: true, result: { name, token, refreshToken, accessUntil: now + ttl, accessMs: ttl } }
  })
}

type Locked =
  | { kind: 'issued'; issued: IssuedSignIn; key: string; migrated?: true; lost?: true }
  | { kind: 'cached'; issued: IssuedSignIn }
  | { kind: 'revoke'; why: 'replayed' | 'idle' | 'lost'; name: string; tokenHash?: string }
  | Exclude<RenewOutcome, { kind: 'renewed' } | { kind: 'replayed' } | { kind: 'idle' } | { kind: 'lost' }>

/**
 * Renew a browser's sign-in from what its page presented: the refresh cookie,
 * and the token the page holds (a browser from before renewing starts its pair
 * with it; an access token alone never renews).
 */
export async function renewBrowserSignIn(presented: { refreshToken?: string; oldToken?: string }, now: number = Date.now()): Promise<RenewOutcome> {
  const refreshToken = presented.refreshToken || undefined
  const oldToken = presented.oldToken || undefined
  if (!refreshToken && !oldToken) return { kind: 'nothing', staleCookie: false }
  pruneAnswered(now)
  // Kept in the lock, once the pair is on disk: a renewal that waited for the lock finds it.
  let made: { key: string; issued: IssuedSignIn } | null = null
  // A migration's old token: refused for good here, and its copy on the cloud companion removed.
  const intent: { plan: RevokePlan | null } = { plan: null }
  const keep = async () => {
    if (!made) return
    answered.set(made.key, { issued: made.issued, at: now })
    renewals.set(made.issued.name, [...(renewals.get(made.issued.name) ?? []), now])
  }
  const locked = await updateAuth<Locked>(async (auth) => {
    if (refreshToken) {
      const hash = sha256Hex(refreshToken)
      const holder = currentHolder(auth.devices, hash)
      if (holder?.browserSignIn) {
        if (now - Date.parse(holder.browserSignIn.renewedAt) > IDLE_LIMIT_MS) {
          return { persist: false, result: { kind: 'revoke', why: 'idle', name: holder.name } }
        }
        if (overLimit(holder.name, now)) return { persist: false, result: { kind: 'limited' } }
        const issued = issue(holder, hash, now)
        made = { key: hash, issued }
        return { persist: true, result: { kind: 'issued', issued, key: hash } }
      }
      const spent = spender(auth.devices, hash)
      if (spent) {
        const kept = answered.get(hash)
        if (kept && kept.issued.name === spent.d.name) return { persist: false, result: { kind: 'cached', issued: kept.issued } }
        if (now - spent.at < RACE_MS) return { persist: false, result: { kind: 'raced' } }
        if (spent.lostSince && !spent.d.lastUsedAt && spent.d.browserSignIn) {
          // Nothing issued for it was ever used: its answer never reached the browser.
          if (overLimit(spent.d.name, now)) return { persist: false, result: { kind: 'limited' } }
          const issued = issue(spent.d, spent.d.browserSignIn.refreshHash, now, true)
          made = { key: hash, issued }
          return { persist: true, result: { kind: 'issued', issued, key: hash, lost: true } }
        }
        return { persist: false, result: { kind: 'revoke', why: 'replayed', name: spent.d.name } }
      }
      // A browser removed on the computer (its row's Remove, Sign out browsers): its page is told so.
      if ((auth.revokedHashes ?? []).includes(hash)) return { persist: false, result: { kind: 'refused', staleCookie: true, removed: true } }
    }
    if (oldToken) {
      const hash = sha256Hex(oldToken)
      const kept = answered.get(hash)
      if (kept) return { persist: false, result: { kind: 'cached', issued: kept.issued } }
      // Carried over already, and nothing issued for it was used since: the answer never
      // reached the browser, which still holds only this token. Answered again.
      const carried = auth.devices.find((x) => x.browserSignIn?.migratedFrom && hashesEqual(hash, x.browserSignIn.migratedFrom))
      if (carried?.browserSignIn && !carried.lastUsedAt) {
        if (overLimit(carried.name, now)) return { persist: false, result: { kind: 'limited' } }
        const issued = issue(carried, null, now, false, hash)
        made = { key: hash, issued }
        return { persist: true, result: { kind: 'issued', issued, key: hash, migrated: true, lost: true } }
      }
      const d = recordForToken(auth.devices, oldToken)
      const revoked = new Set(auth.revokedHashes ?? [])
      if (!d || revoked.has(hash) || d.kind === 'machine') return { persist: false, result: { kind: 'refused', staleCookie: !!refreshToken } }
      // An access token alone never renews: only the refresh cookie does. A renewing sign-in
      // whose cookie is gone (cleared, or one nothing here knows) never can again: it is
      // signed out now, so its page says so instead of retrying until its token runs out,
      // and the device list keeps no entry that cannot come back. Pinned to this token.
      if (d.browserSignIn) return { persist: false, result: { kind: 'revoke', why: 'lost', name: d.name, tokenHash: d.tokenHash } }
      if (!BROWSER_SIGN_IN_NAME.test(d.name)) return { persist: false, result: { kind: 'nothing', staleCookie: !!refreshToken } }
      if (overLimit(d.name, now)) return { persist: false, result: { kind: 'limited' } }
      // As a device's own rotation does (device-auth.ts rotateDevice): the token it held may
      // have been copied to the companion before renewing existed (device-twins.ts).
      intent.plan = await writeRevokeIntent([], pairingsOf(auth.devices, [d]).map((x) => x.tokenHash))
      tombstone(auth, [d.tokenHash])
      const issued = issue(d, null, now, false, hash)
      made = { key: hash, issued }
      return { persist: true, result: { kind: 'issued', issued, key: hash, migrated: true } }
    }
    return { persist: false, result: { kind: 'refused', staleCookie: true } }
  }, keep, () => dropRevokeIntent(intent))

  if (locked.kind === 'cached') return { kind: 'renewed', ...locked.issued }
  if (locked.kind === 'issued') {
    const { issued } = locked
    // Every host server's copy takes the new access token at once (replication/device-replica.ts).
    notifyPaired(issued.name)
    const plan = intent.plan
    if (plan && plan.twins.length > 0) trackRevokeWork(finishRevoke(plan, `browser ${issued.name} now renews`))
    if (locked.migrated && locked.lost) log.web.info('browser sign-in: a carry-over answer never reached its browser; answered again', { name: issued.name })
    else if (locked.migrated) log.web.info('browser sign-in: a browser signed in before renewing existed now renews', { name: issued.name })
    else if (locked.lost) log.web.info('browser sign-in: a renewal answer never reached its browser; answered again', { name: issued.name })
    return { kind: 'renewed', ...issued, ...(locked.migrated ? { migrated: true as const } : {}) }
  }
  if (locked.kind === 'revoke') {
    const forget = () => { for (const [k, v] of answered) if (v.issued.name === locked.name) answered.delete(k) }
    if (locked.why === 'lost') {
      // Only the token read in the lock: a renewal with its cookie that landed meanwhile keeps
      // it, and this page asks again (it then holds that renewal's cookie).
      const out = await revokePairing(locked.name, { tokenHash: locked.tokenHash, endedBySignIn: true })
      if (!out.revoked) return { kind: 'raced' }
      forget()
      log.web.info('browser sign-in: a renewing browser came without its refresh cookie; that browser is signed out', { name: locked.name })
      return { kind: 'lost', name: locked.name }
    }
    forget()
    if (locked.why === 'replayed') log.web.warn('browser sign-in: a spent refresh token was presented again; that browser is signed out', { name: locked.name })
    else log.web.info('browser sign-in: not renewed for a year; that browser is signed out', { name: locked.name })
    // By name, whatever its token is now: a renewal that landed meanwhile is the same browser.
    await revokePairing(locked.name, { endedBySignIn: true })
    return { kind: locked.why, name: locked.name }
  }
  return locked
}

/** Whether `token` is the access token of a renewing sign-in here (it then never needs the old cookie). */
export async function renewsItself(token: string): Promise<boolean> {
  if (!token) return false
  const d = recordForToken(await listDeviceRecords(), token)
  return !!d?.browserSignIn
}

/**
 * Sign out every browser whose sign-in was not renewed for a year: one that
 * never comes back would otherwise keep its record (and every host's copy of its
 * last access token) for good. Returns the names signed out.
 */
export async function sweepIdleBrowserSignIns(now: number = Date.now()): Promise<string[]> {
  const idle = (await listDeviceRecords())
    .filter((d) => d.browserSignIn && now - Date.parse(d.browserSignIn.renewedAt) > IDLE_LIMIT_MS)
  const out: string[] = []
  for (const d of idle) {
    // Pinned to the token read here: one that renewed since is in use again.
    if (!(await revokePairing(d.name, { tokenHash: d.tokenHash, endedBySignIn: true })).revoked) continue
    log.web.info('browser sign-in: not renewed for a year; that browser is signed out', { name: d.name })
    out.push(d.name)
  }
  return out
}

const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000
let sweepTimer: ReturnType<typeof setInterval> | null = null

/** The year-idle sweep, every 6 hours on the server that renews (the primary). Once per process. */
export function startBrowserSignInSweep(): void {
  if (sweepTimer) return
  const run = () => { void sweepIdleBrowserSignIns().catch((err) => log.web.warn('browser sign-in: idle sweep failed', { error: err instanceof Error ? err.message : String(err) })) }
  const first = setTimeout(run, 60_000)
  first.unref?.()
  sweepTimer = setInterval(run, SWEEP_EVERY_MS)
  sweepTimer.unref?.()
}

export function _resetBrowserSignInForTesting(): void {
  answered.clear()
  renewals.clear()
}
