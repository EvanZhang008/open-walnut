/**
 * The daemon's leader book (src/providers/leader-core.ts): who leads a host's
 * work, the primary or, while it is away, the cloud companion.
 *
 * Real files in a temp dir (a daemon restart while the companion leads must
 * keep the lead and its epoch); the clock is a number the test moves. The last
 * block rebuilds the factory from its text the way the source twin runs it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createLeaderBook, type LeaderBookDeps } from '../../src/providers/leader-core.js'

const HOME = '/fixture/walnut-home'
const TEST_HOME = '/fixture/test-server-home'
const WALNUT = 'w0123456789abcdef'
const T = 60_000

let dirs: string[] = []
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs = [] })

function book(opts: { dir?: string; bootAt?: number; create?: typeof createLeaderBook } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'leader-book-'))
  if (!opts.dir) dirs.push(dir)
  const clock = { now: 1_000_000 }
  const logs: string[] = []
  const deps: LeaderBookDeps = {
    fs, path, dir,
    now: () => clock.now,
    keyOf: (home) => createHash('sha1').update(home).digest('hex').slice(0, 12),
    log: (_l, msg) => { logs.push(msg) },
    takeoverMs: T,
    bootAt: opts.bootAt ?? clock.now,
  }
  return { b: (opts.create ?? createLeaderBook)(deps), clock, dir, logs }
}

describe('leader book: configure and the primary', () => {
  it('a first configure starts at epoch 1 with the primary leading', () => {
    const { b } = book()
    const rec = b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    expect(rec).toMatchObject({ epoch: 1, holder: 'primary', backup: true, walnutId: WALNUT })
  })

  it('refuses a configure without a home or with a malformed id', () => {
    const { b } = book()
    expect(() => b.configure({ home: '', walnutId: WALNUT, backup: true })).toThrow(/home/)
    expect(() => b.configure({ home: HOME, walnutId: 'has spaces', backup: true })).toThrow(/walnutId/)
  })

  it('a primary claim while the primary leads keeps the epoch', () => {
    const { b } = book()
    b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    expect(b.primaryClaim(HOME)).toMatchObject({ epoch: 1, holder: 'primary' })
    expect(b.primaryClaim('/unknown')).toBeNull()
  })
})

describe('leader book: the companion asks for the lead', () => {
  it('is refused while this host heard the primary within the takeover window', () => {
    const { b, clock } = book()
    b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    clock.now += T - 1
    const r = b.backupClaim(WALNUT, 2)
    expect(r).toMatchObject({ ok: false, code: 'primary_alive', epoch: 1 })
  })

  it('is granted once this host has not heard the primary for the window, at a higher epoch', () => {
    const { b, clock } = book()
    b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    clock.now += T
    const r = b.backupClaim(WALNUT, 2)
    expect(r.ok).toBe(true)
    expect(b.backupLead(HOME)).toEqual({ walnutId: WALNUT, epoch: 2 })
  })

  it('a heard frame from the primary restarts the window (a sleeping Mac stops sending, a live one does not)', () => {
    const { b, clock } = book()
    b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    clock.now += T - 1000
    b.noteHeard(HOME)
    clock.now += T - 1000
    expect(b.backupClaim(WALNUT, 2)).toMatchObject({ ok: false, code: 'primary_alive' })
    clock.now += 1000
    expect(b.backupClaim(WALNUT, 2).ok).toBe(true)
  })

  it('a frame from another Walnut on the same host does not count for this one', () => {
    const { b, clock } = book()
    b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    b.configure({ home: TEST_HOME, walnutId: 'wtestserver', backup: false })
    clock.now += T
    b.noteHeard(TEST_HOME)
    expect(b.backupClaim(WALNUT, 2).ok).toBe(true)
  })

  it('needs the user to have allowed it', () => {
    const { b, clock } = book()
    b.configure({ home: HOME, walnutId: WALNUT, backup: false })
    clock.now += 10 * T
    expect(b.backupClaim(WALNUT, 2)).toMatchObject({ ok: false, code: 'not_enabled' })
  })

  it('refuses an unknown Walnut, a stale epoch, and an epoch that is not an integer', () => {
    const { b, clock } = book()
    b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    clock.now += T
    expect(b.backupClaim('wsomeoneelse', 9)).toMatchObject({ ok: false, code: 'unknown_walnut' })
    expect(b.backupClaim(WALNUT, 1)).toMatchObject({ ok: false, code: 'stale_epoch', epoch: 1 })
    expect(b.backupClaim(WALNUT, 2.5)).toMatchObject({ ok: false, code: 'stale_epoch' })
    expect(b.backupClaim(WALNUT, '3')).toMatchObject({ ok: false, code: 'stale_epoch' })
  })

  it('a primary never heard since this daemon started was last heard at the start, at best', () => {
    // The primary configured an earlier daemon life: the record is on disk, but
    // the restarted process never heard it. The window counts from its boot.
    const first = book()
    first.b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    const bootAt = first.clock.now + 10 * T
    const restarted = book({ dir: first.dir, bootAt })
    restarted.clock.now = bootAt + T - 1
    expect(restarted.b.backupClaim(WALNUT, 2)).toMatchObject({ ok: false, code: 'primary_alive' })
    restarted.clock.now = bootAt + T
    expect(restarted.b.backupClaim(WALNUT, 2).ok).toBe(true)
  })
})

describe('leader book: fencing and handback', () => {
  function led() {
    const h = book()
    h.b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    h.clock.now += T
    expect(h.b.backupClaim(WALNUT, 2).ok).toBe(true)
    return h
  }

  it('honours a companion command only at the current epoch while it leads', () => {
    const { b } = led()
    expect(b.fence(WALNUT, 2)).toMatchObject({ ok: true, home: HOME, epoch: 2 })
    expect(b.fence(WALNUT, 1)).toMatchObject({ ok: false, code: 'stale_epoch' })
    expect(b.fence('wother', 2)).toMatchObject({ ok: false, code: 'unknown_walnut' })
  })

  it('the primary takes the lead back with a higher epoch, and the old lead is fenced off', () => {
    const { b, logs } = led()
    const back = b.primaryClaim(HOME)!
    expect(back).toMatchObject({ holder: 'primary', epoch: 3 })
    expect(b.backupLead(HOME)).toBeNull()
    expect(b.fence(WALNUT, 2)).toMatchObject({ ok: false, code: 'not_leader' })
    expect(logs).toContain('leader: the primary took the lead back')
    // The companion cannot win it straight back: the primary was just heard.
    expect(b.backupClaim(WALNUT, 4)).toMatchObject({ ok: false, code: 'primary_alive' })
  })

  it('a configure while the companion leads reports it, so the primary takes the record back before it claims', () => {
    const { b } = led()
    expect(b.configure({ home: HOME, walnutId: WALNUT, backup: true })).toMatchObject({ holder: 'backup', epoch: 2 })
  })

  it('the lead and its epoch survive a daemon restart', () => {
    const h = led()
    const again = book({ dir: h.dir })
    expect(again.b.recordOf(HOME)).toMatchObject({ holder: 'backup', epoch: 2 })
    expect(again.b.fence(WALNUT, 2).ok).toBe(true)
  })

  it('witness lists only the Walnuts that let the companion lead, with how long ago the primary was heard', () => {
    const { b, clock } = led()
    b.configure({ home: TEST_HOME, walnutId: 'wtest', backup: false })
    clock.now += 5_000
    const w = b.witness((home) => home === HOME)
    expect(w).toEqual([{ walnutId: WALNUT, epoch: 2, holder: 'backup', primaryConnected: false, primaryHeardAgoMs: T + 5_000 }])
  })

  it('a socket that is open but silent is not a connected primary (a sleeping Mac keeps its sockets)', () => {
    const { b, clock } = book()
    b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    expect(b.witness(() => true)[0].primaryConnected).toBe(true)
    clock.now += T
    expect(b.witness(() => true)[0].primaryConnected).toBe(false)
  })
})

describe('leader book: rebuilt from its text (the source twin)', () => {
  it('behaves the same when reconstructed with new Function', () => {
    const rebuilt = new Function('"use strict"; return ' + createLeaderBook.toString())() as typeof createLeaderBook
    const { b, clock } = book({ create: rebuilt })
    b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    clock.now += T
    expect(b.backupClaim(WALNUT, 2).ok).toBe(true)
    expect(b.primaryClaim(HOME)).toMatchObject({ epoch: 3, holder: 'primary' })
  })
})
