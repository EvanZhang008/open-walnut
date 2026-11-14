import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCertExpiryAlert, certLetterHandedOff, WARN_AHEAD_MS } from '../../src/core/hosts/ssh-cert-expiry-alert.js'
import { readCertificateWarning, SIGN_IN_OK_FRESH_MS } from '../../src/core/sign-in-ask.js'
import { certificateWarningDue, certificateWarningCheckMs, watchCertificatePresence } from '../../src/core/hosts/cert-warning-time.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const HOUR = 3_600_000
const EXPIRES = Date.parse('2026-11-14T07:20:29Z')
let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-warning-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function kit(owner: Record<string, unknown> = {}) {
  let clock = EXPIRES - 2 * HOUR
  const letters = new Map<string, string>()
  const turns: string[] = []
  let sends = 0
  let fail = false
  const writeOwner = () => fs.writeFileSync(path.join(dir, 'sign-in-state.json'), JSON.stringify({
    ok: true, owns: true, checkedAt: new Date(clock).toISOString(), ...owner,
  }))
  writeOwner()
  const deps = {
    hosts: async () => [{ host: 'dev', label: 'Dev box' }, { host: 'build', label: 'Build box' }],
    certExpiry: async () => EXPIRES,
    freshSignIn: async () => ({ ok: false, error: 'Permission denied (publickey).' }),
    send: async (letter: { opKey: string }) => {
      if (fail) throw new Error('store busy')
      if (!letters.has(letter.opKey)) { sends++; letters.set(letter.opKey, `letter-${sends}`) }
      return letters.get(letter.opKey)!
    },
    addTurn: async (_id: string, text: string) => { turns.push(text) },
    archive: async () => {}, loginHint: async () => undefined,
    statePath: path.join(dir, 'cert.json'), now: () => clock,
    timeZone: () => 'America/Los_Angeles', online: () => true,
    handedOff: (phase: 'ahead' | 'expired') => certLetterHandedOff(undefined, clock, dir, phase, async id => id === 'owner-letter'),
    warningLetter: (expiry: number) => readCertificateWarning(expiry, clock, dir, async id => id === 'owner-letter'),
    setTimer: () => ({ unref: () => {} }), clearTimer: () => {},
  }
  return { deps, sends: () => sends, turns, fail: (v: boolean) => { fail = v }, clock: (v: number) => { clock = v }, writeOwner }
}

describe('a delivered letter, not an owner claim, covers the certificate warning', () => {
  const shapes = [
    {}, { ok: false }, { notificationId: 'push-only' },
    { certificateWarning: { expiresAt: EXPIRES - 12 * HOUR, letterId: 'owner-letter' } },
    { certificateWarning: { expiresAt: EXPIRES, letterId: 'archived-letter' } },
    { certificateWarning: { expiresAt: EXPIRES, letterId: '' } },
  ]
  it.each(shapes)('unproven owner %j: delivers one warning within the three-hour window', async owner => {
    const k = kit(owner)
    const alert = createCertExpiryAlert(k.deps)
    await Promise.all([alert.check(), alert.check(), alert.check()])
    expect(k.sends()).toBe(1)
    expect((await alert.episode())?.openedAt).toBe(EXPIRES - 2 * HOUR)
    await createCertExpiryAlert(k.deps).check()
    expect(k.sends()).toBe(1)
  })

  it.each([
    { checkedAt: new Date(EXPIRES - 2 * HOUR - SIGN_IN_OK_FRESH_MS - 1).toISOString() },
    { owns: false },
  ])('adopts an already delivered warning even if the checker stopped before first read: %j', async state => {
    const k = kit({ ...state, certificateWarning: { expiresAt: EXPIRES, letterId: 'owner-letter' } })
    await createCertExpiryAlert(k.deps).check()
    expect(k.sends()).toBe(0)
    expect(JSON.parse(fs.readFileSync(k.deps.statePath, 'utf8')).episode.letterId).toBe('owner-letter')
  })

  it('adopts the owner letter for this expiry and keeps it after the owner stops and the server restarts', async () => {
    const k = kit({ certificateWarning: { expiresAt: EXPIRES, letterId: 'owner-letter' } })
    await createCertExpiryAlert(k.deps).check()
    expect(k.sends()).toBe(0)
    expect(JSON.parse(fs.readFileSync(k.deps.statePath, 'utf8')).episode.letterId).toBe('owner-letter')
    fs.rmSync(path.join(dir, 'sign-in-state.json'))
    const again = createCertExpiryAlert(k.deps)
    await again.check()
    expect(await again.joinLetter(['build'])).toBe('owner-letter')
    k.clock(EXPIRES + 60_000)
    await again.check()
    await createCertExpiryAlert(k.deps).check()
    expect(k.sends()).toBe(0)
    expect(k.turns).toHaveLength(1)
  })

  it('an owner letter read failure retries before sending any fallback letter', async () => {
    const k = kit({ certificateWarning: { expiresAt: EXPIRES, letterId: 'owner-letter' } })
    let failRead = true
    const alert = createCertExpiryAlert({ ...k.deps, warningLetter: expiry => readCertificateWarning(
      expiry, EXPIRES - 2 * HOUR, dir, async () => {
        if (failRead) throw new Error('inbox temporarily unavailable')
        return true
      },
    ) })
    await alert.check()
    expect(k.sends()).toBe(0)
    expect((await alert.episode())?.letterId).toBeUndefined()
    failRead = false
    await alert.check()
    expect(k.sends()).toBe(0)
    expect((await alert.episode())?.letterId).toBe('owner-letter')
  })

  it('a send failure retries the same expiry after restart, then never repeats when ownership changes', async () => {
    const k = kit()
    k.fail(true)
    await createCertExpiryAlert(k.deps).check()
    k.fail(false)
    const alert = createCertExpiryAlert(k.deps)
    await alert.check()
    fs.rmSync(path.join(dir, 'sign-in-state.json'))
    await alert.check()
    k.clock(EXPIRES + 60_000)
    await alert.check()
    expect(k.sends()).toBe(1)
    expect(k.turns).toHaveLength(1)
  })
})

describe('night warning timing in the primary machine time zone', () => {
  const due = (expires: string, now: string, online = true) => certificateWarningDue({
    expiresAt: Date.parse(expires), now: Date.parse(now), warnAheadMs: WARN_AHEAD_MS,
    timeZone: 'America/Los_Angeles', online,
  })
  it('the reported expiry warns in the online evening, never waits for its 23:20 expiry', () => {
    expect(due('2026-11-14T07:20:29Z', '2026-11-14T02:05:00Z')).toBe(true)
    expect(due('2026-11-14T07:20:29Z', '2026-11-14T01:59:00Z')).toBe(false)
  })
  it('a morning expiry warns the previous evening online, or at 21:00 even offline', () => {
    expect(due('2026-11-14T15:59:00Z', '2026-11-14T02:00:00Z')).toBe(true)
    expect(due('2026-11-14T15:59:00Z', '2026-11-14T02:00:00Z', false)).toBe(false)
    expect(due('2026-11-14T15:59:00Z', '2026-11-14T05:00:00Z', false)).toBe(true)
  })
  it('22:00 is night; 08:00 and 21:59 use the normal three-hour window', () => {
    expect(due('2026-11-14T06:00:00Z', '2026-11-14T02:00:00Z')).toBe(true)
    expect(due('2026-11-14T05:59:00Z', '2026-11-14T02:00:00Z')).toBe(false)
    expect(due('2026-11-14T16:00:00Z', '2026-11-14T02:00:00Z')).toBe(false)
    expect(due('2026-11-14T16:00:00Z', '2026-11-14T13:00:00Z', false)).toBe(true)
  })
  it.each([
    ['2026-03-08T14:30:00Z', '2026-03-08T02:00:00Z'],
    ['2026-11-01T15:30:00Z', '2026-11-01T01:00:00Z'],
  ])('DST night %s uses the actual previous evening %s', (expiry, evening) => {
    expect(due(expiry, evening)).toBe(true)
    expect(due(expiry, new Date(Date.parse(evening) - 60_000).toISOString())).toBe(false)
  })
  it('aligns polling exactly to the evening, bedtime and normal warning boundary', () => {
    const expiry = Date.parse('2026-11-14T15:59:00Z')
    for (const [now, seconds] of [['2026-11-14T01:59:30Z', 30], ['2026-11-14T04:59:45Z', 15]] as const) {
      expect(certificateWarningCheckMs({ expiresAt: expiry, now: Date.parse(now), warnAheadMs: WARN_AHEAD_MS,
        timeZone: 'America/Los_Angeles', online: false }, 10 * 60_000)).toBe(seconds * 1000)
    }
    expect(certificateWarningCheckMs({ expiresAt: Date.parse('2026-11-14T16:00:00Z'), now: Date.parse('2026-11-14T12:59:40Z'),
      warnAheadMs: WARN_AHEAD_MS, timeZone: 'America/Los_Angeles', online: false }, 10 * 60_000)).toBe(20_000)
  })

  it('uses existing attention signals, expires them and unsubscribes cleanly', () => {
    let now = EXPIRES - 5 * HOUR
    let wakes = 0
    const presence = watchCertificatePresence(() => now, () => { wakes++ })
    try {
      expect(presence.online()).toBe(false)
      bus.emit(EventNames.TIME_OUTSIDE, { ts: new Date(now).toISOString(), durationMs: 1000, idleSecs: 90 }, [])
      expect(presence.online()).toBe(false)
      bus.emit(EventNames.TIME_BANKED, { records: [{ ts: new Date(now).toISOString(), durationMs: 1000, kind: 'active' }] }, [])
      expect(presence.online()).toBe(true)
      expect(wakes).toBe(1)
      bus.emit(EventNames.TIME_BANKED, { records: [{ ts: new Date(now).toISOString(), durationMs: 1000, kind: 'active' }] }, [])
      expect(wakes).toBe(1)
      now += 5 * 60_000
      expect(presence.online()).toBe(false)
      presence.stop()
      bus.emit(EventNames.TIME_OUTSIDE, { ts: new Date(now).toISOString(), durationMs: 1000 }, [])
      expect(presence.online()).toBe(false)
    } finally { presence.stop() }
  })
})
