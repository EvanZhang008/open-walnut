/**
 * A browser's sign-in renews itself (src/core/browser-sign-in.ts): a short-lived
 * access token and a refresh token traded once for a new pair. 2026-11-04, the
 * user asked for the way a well-known dashboard keeps a phone signed in, kept to
 * a year of idle time and bound to no address.
 *
 * auth.json lives in the mocked WALNUT_HOME (a temp dir per run).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-browser-sign-in'))

import { WALNUT_HOME } from '../../src/constants.js'
import { LOCAL_ACTOR } from '../../src/core/device-actor.js'
import {
  createDevice, createDeviceAs, isExpiredAccessToken, listDeviceRecords, onCredentialsRevoked, onDevicePaired, revokeDevice, verifyDeviceToken, _resetDeviceAuthForTesting,
} from '../../src/core/device-auth.js'
import {
  ACCESS_TTL_MS, IDLE_LIMIT_MS, RACE_MS, accessTtlMs, beginBrowserSignIn, renewBrowserSignIn, renewsItself, sweepIdleBrowserSignIns, _resetBrowserSignInForTesting,
} from '../../src/core/browser-sign-in.js'

const authFile = () => path.join(WALNUT_HOME, 'auth.json')
let seq = 0

async function signedIn(now = Date.now()) {
  const name = `browser-${(0xa00000 + seq++).toString(16)}`
  const { token } = await createDevice(name)
  const issued = await beginBrowserSignIn(name, token, now)
  if (!issued) throw new Error('no sign-in')
  return issued
}

async function record(name: string) {
  return (await listDeviceRecords()).find((d) => d.name === name)
}

/** Edit a record in auth.json directly, as time passing would leave it. */
async function edit(name: string, change: (d: Record<string, unknown>) => void) {
  const file = JSON.parse(await fs.readFile(authFile(), 'utf-8')) as { devices: Array<Record<string, unknown>> }
  const d = file.devices.find((x) => x.name === name)!
  change(d)
  await fs.writeFile(authFile(), JSON.stringify(file))
}

beforeEach(async () => {
  _resetDeviceAuthForTesting()
  _resetBrowserSignInForTesting()
  await fs.rm(authFile(), { force: true })
  await fs.rm(`${authFile()}.bak`, { force: true })
})

afterEach(() => {
  delete process.env.WALNUT_BROWSER_ACCESS_TTL_S
  vi.useRealTimers()
})

describe('signing in and renewing', () => {
  it('a sign-in keeps its paired token as the access token, with a refresh token beside it, for 20 hours', async () => {
    const now = Date.now()
    const s = await signedIn(now)
    expect(s.accessMs).toBe(ACCESS_TTL_MS)
    expect(s.accessUntil).toBe(now + 20 * 3_600_000)
    expect(await verifyDeviceToken(s.token)).toEqual({ name: s.name })
    // The refresh token is never an access token.
    expect(await verifyDeviceToken(s.refreshToken)).toBeNull()
    const r = await record(s.name)
    expect(r?.browserSignIn?.accessUntil).toBe(new Date(now + ACCESS_TTL_MS).toISOString())
    // Only a hash is stored.
    expect(await fs.readFile(authFile(), 'utf-8')).not.toContain(s.refreshToken)
  })

  it('a renewal trades the refresh token for a new pair: the old access and refresh tokens stop, the new ones work', async () => {
    const s = await signedIn()
    const out = await renewBrowserSignIn({ refreshToken: s.refreshToken })
    expect(out.kind).toBe('renewed')
    if (out.kind !== 'renewed') return
    expect(out.name).toBe(s.name)
    expect(out.token).not.toBe(s.token)
    expect(out.refreshToken).not.toBe(s.refreshToken)
    expect(await verifyDeviceToken(out.token)).toEqual({ name: s.name })
    expect(await verifyDeviceToken(s.token)).toBeNull()
    // Same device: id kept, no revoke heard.
    expect((await record(s.name))?.browserSignIn?.spent).toHaveLength(1)
  })

  it('the access token a renewal replaced reads as one that ran out (a request sent before the page stored the new one), until the next renewal', async () => {
    const s = await signedIn()
    const r1 = await renewBrowserSignIn({ refreshToken: s.refreshToken })
    if (r1.kind !== 'renewed') throw new Error(r1.kind)
    expect(await verifyDeviceToken(s.token)).toBeNull()
    expect(await isExpiredAccessToken(s.token)).toBe(true)
    expect(await fs.readFile(authFile(), 'utf-8')).not.toContain(s.token)
    await verifyDeviceToken(r1.token)
    const r2 = await renewBrowserSignIn({ refreshToken: r1.refreshToken })
    if (r2.kind !== 'renewed') throw new Error(r2.kind)
    expect(await isExpiredAccessToken(s.token)).toBe(false)
    expect(await isExpiredAccessToken(r1.token)).toBe(true)
  })

  it('a token\'s first use is written at once, even inside the throttle another token of the name set', async () => {
    const s = await signedIn()
    expect(await verifyDeviceToken(s.token)).toEqual({ name: s.name })
    expect((await record(s.name))?.lastUsedAt).toBeDefined()
    // As a renewal leaves it: no lastUsedAt, and this name's throttle fresh (a request still out with the old token set it).
    await edit(s.name, (d) => { delete d.lastUsedAt })
    expect(await verifyDeviceToken(s.token)).toEqual({ name: s.name })
    expect((await record(s.name))?.lastUsedAt).toBeDefined()
  })

  it('a renewal is heard as a pairing (every host copy takes the new token at once), never as a revoke', async () => {
    const s = await signedIn()
    const paired: string[] = []
    const revoked: string[][] = []
    const offP = onDevicePaired((n) => paired.push(n))
    const offR = onCredentialsRevoked((n) => revoked.push(n))
    try {
      await renewBrowserSignIn({ refreshToken: s.refreshToken })
      expect(paired).toEqual([s.name])
      expect(revoked).toEqual([])
    } finally { offP(); offR() }
  })

  it('an access token is refused after 20 hours, and told apart from a wrong one', async () => {
    const s = await signedIn()
    await edit(s.name, (d) => { (d.browserSignIn as { accessUntil: string }).accessUntil = new Date(Date.now() - 1_000).toISOString() })
    expect(await verifyDeviceToken(s.token)).toBeNull()
    expect(await isExpiredAccessToken(s.token)).toBe(true)
    expect(await isExpiredAccessToken('not-a-token')).toBe(false)
    // An unreadable time fails closed.
    await edit(s.name, (d) => { (d.browserSignIn as { accessUntil: string }).accessUntil = 'soon' })
    expect(await verifyDeviceToken(s.token)).toBeNull()
    // The refresh token still renews it.
    expect((await renewBrowserSignIn({ refreshToken: s.refreshToken })).kind).toBe('renewed')
  })

  it('WALNUT_BROWSER_ACCESS_TTL_S only shortens the lifetime (30 s at least)', () => {
    process.env.WALNUT_BROWSER_ACCESS_TTL_S = '60'
    expect(accessTtlMs()).toBe(60_000)
    for (const v of ['5', '999999', 'x', '']) {
      process.env.WALNUT_BROWSER_ACCESS_TTL_S = v
      expect(accessTtlMs(), v).toBe(ACCESS_TTL_MS)
    }
  })

  it('a token that never expires (the app, the extension, a CLI device) has no sign-in and stays as it was', async () => {
    const { token } = await createDevice('evans-iphone')
    expect(await beginBrowserSignIn('evans-iphone', token)).toBeNull()
    const ext = await createDeviceAs('extension-abcdef', { by: LOCAL_ACTOR, extension: true })
    expect(await beginBrowserSignIn('extension-abcdef', ext.token)).toBeNull()
    expect(await renewBrowserSignIn({ oldToken: token })).toEqual({ kind: 'nothing', staleCookie: false })
    expect(await verifyDeviceToken(token)).toEqual({ name: 'evans-iphone' })
  })
})

describe('a spent refresh token presented again', () => {
  it('after its first minute, with the new pair in use, is a replay: the browser is signed out, both tokens dead', async () => {
    const t0 = Date.now()
    const s = await signedIn(t0)
    const first = await renewBrowserSignIn({ refreshToken: s.refreshToken }, t0)
    if (first.kind !== 'renewed') throw new Error(first.kind)
    // The browser used its new access token.
    expect(await verifyDeviceToken(first.token)).toEqual({ name: s.name })
    _resetBrowserSignInForTesting()
    const again = await renewBrowserSignIn({ refreshToken: s.refreshToken }, t0 + RACE_MS + 1)
    expect(again).toEqual({ kind: 'replayed', name: s.name })
    expect(await record(s.name)).toBeUndefined()
    expect(await verifyDeviceToken(first.token)).toBeNull()
    expect((await renewBrowserSignIn({ refreshToken: first.refreshToken })).kind).toBe('refused')
  })

  it('within its first minute (two tabs at once) gets the same answer again, or 409 when the answer is gone', async () => {
    const t0 = Date.now()
    const s = await signedIn(t0)
    const first = await renewBrowserSignIn({ refreshToken: s.refreshToken }, t0)
    const second = await renewBrowserSignIn({ refreshToken: s.refreshToken }, t0 + 1_000)
    expect(second).toEqual(first)
    _resetBrowserSignInForTesting()
    expect(await renewBrowserSignIn({ refreshToken: s.refreshToken }, t0 + 2_000)).toEqual({ kind: 'raced' })
    // The browser still signed in.
    if (first.kind !== 'renewed') throw new Error(first.kind)
    expect(await verifyDeviceToken(first.token)).toEqual({ name: s.name })
  })

  it('two renewals at the same moment make one rotation, and both get the same pair', async () => {
    const s = await signedIn()
    const [a, b] = await Promise.all([
      renewBrowserSignIn({ refreshToken: s.refreshToken }),
      renewBrowserSignIn({ refreshToken: s.refreshToken }),
    ])
    expect(a).toEqual(b)
    expect((await record(s.name))?.browserSignIn?.spent).toHaveLength(1)
  })

  it('whose answer never reached the browser (nothing issued since was used) is answered again, as often as it is lost', async () => {
    const t0 = Date.now()
    const s = await signedIn(t0)
    const lost1 = await renewBrowserSignIn({ refreshToken: s.refreshToken }, t0)
    _resetBrowserSignInForTesting()
    const again1 = await renewBrowserSignIn({ refreshToken: s.refreshToken }, t0 + RACE_MS + 1)
    expect(again1.kind).toBe('renewed')
    _resetBrowserSignInForTesting()
    const again2 = await renewBrowserSignIn({ refreshToken: s.refreshToken }, t0 + 2 * RACE_MS + 2)
    expect(again2.kind).toBe('renewed')
    if (again2.kind !== 'renewed' || lost1.kind !== 'renewed') return
    expect(await verifyDeviceToken(again2.token)).toEqual({ name: s.name })
    // The pairs that never arrived are spent: presented, they show someone else held them.
    _resetBrowserSignInForTesting()
    expect(await renewBrowserSignIn({ refreshToken: lost1.refreshToken }, t0 + 3 * RACE_MS)).toEqual({ kind: 'replayed', name: s.name })
  })

  it('a lost answer after a renewal that was used is a replay (the thief case)', async () => {
    const t0 = Date.now()
    const s = await signedIn(t0)
    const r1 = await renewBrowserSignIn({ refreshToken: s.refreshToken }, t0)
    if (r1.kind !== 'renewed') throw new Error(r1.kind)
    await verifyDeviceToken(r1.token)
    // A second renewal, whose pair is not used yet.
    await renewBrowserSignIn({ refreshToken: r1.refreshToken }, t0 + 1_000)
    _resetBrowserSignInForTesting()
    expect(await renewBrowserSignIn({ refreshToken: s.refreshToken }, t0 + RACE_MS + 2_000)).toEqual({ kind: 'replayed', name: s.name })
  })
})

describe('the end of a sign-in', () => {
  it('a sign-in not renewed for a year ends: the browser is signed out', async () => {
    const s = await signedIn()
    await edit(s.name, (d) => { (d.browserSignIn as { renewedAt: string }).renewedAt = new Date(Date.now() - IDLE_LIMIT_MS - 60_000).toISOString() })
    expect(await renewBrowserSignIn({ refreshToken: s.refreshToken })).toEqual({ kind: 'idle', name: s.name })
    expect(await record(s.name)).toBeUndefined()
  })

  it('a year less a day still renews, and starts the year again', async () => {
    const s = await signedIn()
    await edit(s.name, (d) => { (d.browserSignIn as { renewedAt: string }).renewedAt = new Date(Date.now() - IDLE_LIMIT_MS + 86_400_000).toISOString() })
    const out = await renewBrowserSignIn({ refreshToken: s.refreshToken })
    expect(out.kind).toBe('renewed')
    expect(Date.parse((await record(s.name))!.browserSignIn!.renewedAt)).toBeGreaterThan(Date.now() - 60_000)
  })

  it('a removed browser renews nothing (and is known as removed), and an unknown refresh token is refused', async () => {
    const s = await signedIn()
    await revokeDevice(s.name)
    expect(await renewBrowserSignIn({ refreshToken: s.refreshToken })).toEqual({ kind: 'refused', staleCookie: true, removed: true })
    // One that ended for its own reason (its page is told that reason) is not "removed".
    const t = await signedIn()
    await revokeDevice(t.name, { endedBySignIn: true })
    expect(await renewBrowserSignIn({ refreshToken: t.refreshToken })).toEqual({ kind: 'refused', staleCookie: true })
    expect(await renewBrowserSignIn({ refreshToken: 'made-up' })).toEqual({ kind: 'refused', staleCookie: true })
    expect(await renewBrowserSignIn({})).toEqual({ kind: 'nothing', staleCookie: false })
  })

  it('a sweep signs out every browser not renewed for a year, and no other', async () => {
    const old = await signedIn()
    const recent = await signedIn()
    const { token: legacy } = await createDevice('browser-01d0ff')
    await edit(old.name, (d) => { (d.browserSignIn as { renewedAt: string }).renewedAt = new Date(Date.now() - IDLE_LIMIT_MS - 60_000).toISOString() })
    expect(await sweepIdleBrowserSignIns()).toEqual([old.name])
    expect(await record(old.name)).toBeUndefined()
    expect(await verifyDeviceToken(recent.token)).toEqual({ name: recent.name })
    // A browser from before renewing has no renewal time: it carries over when its page opens.
    expect(await verifyDeviceToken(legacy)).toEqual({ name: 'browser-01d0ff' })
    expect(await sweepIdleBrowserSignIns()).toEqual([])
  })

  it('renewals are limited per sign-in (30 in 10 minutes), never by address', async () => {
    let s = await signedIn()
    let refresh = s.refreshToken
    for (let i = 0; i < 30; i++) {
      const out = await renewBrowserSignIn({ refreshToken: refresh })
      if (out.kind !== 'renewed') throw new Error(`${i}: ${out.kind}`)
      refresh = out.refreshToken
    }
    expect(await renewBrowserSignIn({ refreshToken: refresh })).toEqual({ kind: 'limited' })
    // Another browser is not held back.
    s = await signedIn()
    expect((await renewBrowserSignIn({ refreshToken: s.refreshToken })).kind).toBe('renewed')
  })
})

describe('a browser signed in before renewing existed', () => {
  it('its first renewal sends its token, which starts the pair: no new code, and the old token stops', async () => {
    const { token } = await createDevice('browser-01d000')
    const out = await renewBrowserSignIn({ oldToken: token })
    expect(out.kind).toBe('renewed')
    if (out.kind !== 'renewed') return
    expect(out.migrated).toBe(true)
    expect(await verifyDeviceToken(out.token)).toEqual({ name: 'browser-01d000' })
    expect(await verifyDeviceToken(token)).toBeNull()
    expect((await renewBrowserSignIn({ refreshToken: out.refreshToken })).kind).toBe('renewed')
  })

  it('two tabs starting it at once get the same pair', async () => {
    const { token } = await createDevice('browser-01d001')
    const [a, b] = await Promise.all([renewBrowserSignIn({ oldToken: token }), renewBrowserSignIn({ oldToken: token })])
    // The same pair (only the first says it carried the browser over).
    expect({ ...a, migrated: undefined }).toEqual({ ...b, migrated: undefined })
    expect(a.kind).toBe('renewed')
  })

  it('an access token without its refresh cookie never starts a second pair: that browser can never renew, so it is signed out', async () => {
    // Its cookie was cleared: the page would otherwise retry until its token ran out.
    const s = await signedIn()
    expect(await renewBrowserSignIn({ oldToken: s.token })).toEqual({ kind: 'lost', name: s.name })
    expect(await verifyDeviceToken(s.token)).toBeNull()
    expect((await listDeviceRecords()).some((d) => d.name === s.name)).toBe(false)
    // With a refresh cookie this server does not know: the same.
    const t = await signedIn()
    expect(await renewBrowserSignIn({ oldToken: t.token, refreshToken: 'stale' })).toEqual({ kind: 'lost', name: t.name })
    expect(await verifyDeviceToken(t.token)).toBeNull()
    // Its own cookie beside it still renews: nothing is lost.
    const u = await signedIn()
    expect((await renewBrowserSignIn({ oldToken: u.token, refreshToken: u.refreshToken })).kind).toBe('renewed')
  })

  it('a refresh cookie it does not know, beside an old token it does, still starts the pair', async () => {
    const { token } = await createDevice('browser-01d002')
    expect((await renewBrowserSignIn({ oldToken: token, refreshToken: 'from-before' })).kind).toBe('renewed')
  })

  it('a carry-over whose answer never reached the browser is answered again, until a token issued for it is used', async () => {
    const { token } = await createDevice('browser-01d005')
    const first = await renewBrowserSignIn({ oldToken: token })
    if (first.kind !== 'renewed') throw new Error(first.kind)
    // The answer is lost and this process forgot it (a restart): the browser holds only its old token.
    _resetBrowserSignInForTesting()
    expect(await isExpiredAccessToken(token)).toBe(true)
    const again = await renewBrowserSignIn({ oldToken: token })
    if (again.kind !== 'renewed') throw new Error(again.kind)
    expect(again.name).toBe('browser-01d005')
    expect(again.token).not.toBe(first.token)
    expect(await verifyDeviceToken(first.token)).toBeNull()
    // The browser uses what it got: the old token is refused for good from then on.
    expect(await verifyDeviceToken(again.token)).toEqual({ name: 'browser-01d005' })
    _resetBrowserSignInForTesting()
    expect(await renewBrowserSignIn({ oldToken: token })).toEqual({ kind: 'refused', staleCookie: false })
    expect(await isExpiredAccessToken(token)).toBe(false)
  })

  it('a removed one is refused', async () => {
    const { token } = await createDevice('browser-01d003')
    await revokeDevice('browser-01d003')
    expect(await renewBrowserSignIn({ oldToken: token })).toEqual({ kind: 'refused', staleCookie: false })
  })

  it('renewsItself tells a renewing sign-in from one before it', async () => {
    const s = await signedIn()
    const { token } = await createDevice('browser-01d004')
    expect(await renewsItself(s.token)).toBe(true)
    expect(await renewsItself(token)).toBe(false)
    expect(await renewsItself('')).toBe(false)
  })
})

describe('auth.json', () => {
  it('the record a renewal writes reads back the same (an older build keeps the field it does not know)', async () => {
    const s = await signedIn()
    await renewBrowserSignIn({ refreshToken: s.refreshToken })
    const raw = JSON.parse(await fs.readFile(authFile(), 'utf-8')) as { devices: Array<Record<string, unknown>> }
    const d = raw.devices.find((x) => x.name === s.name)!
    expect(Object.keys(d.browserSignIn as object).sort()).toEqual(['accessUntil', 'refreshHash', 'renewedAt', 'replacedHash', 'spent'])
    // An older build reads every record whole (device-store parseAuth) and writes it back as it read it.
    expect(typeof d.tokenHash).toBe('string')
  })

  it('at most 8 spent refresh tokens are kept', async () => {
    const s = await signedIn()
    let refresh = s.refreshToken
    for (let i = 0; i < 12; i++) {
      _resetBrowserSignInForTesting()
      const out = await renewBrowserSignIn({ refreshToken: refresh })
      if (out.kind !== 'renewed') throw new Error(out.kind)
      refresh = out.refreshToken
    }
    expect((await record(s.name))?.browserSignIn?.spent).toHaveLength(8)
  })
})
