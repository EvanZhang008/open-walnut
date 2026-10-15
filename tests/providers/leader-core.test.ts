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

/** Where a v1 daemon kept its book: `<its daemon dir>/leader`, both this user's own (the import checks both). */
function legacyLeaderDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-legacy-'))
  dirs.push(root)
  const dir = path.join(root, 'leader')
  fs.mkdirSync(dir, { mode: 0o700 })
  return dir
}

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

describe('leader book: journal v2 (drains, heardSinceBoot, the state dir move)', () => {
  it('keeps the drains a configure names, persists them, and an older configure without drains clears them', () => {
    const { b, dir } = book()
    b.configure({ home: HOME, walnutId: WALNUT, backup: false, drains: ['task-fields', 'board', 'task-fields', 'Bad Kind'] })
    expect(b.drainsFor(HOME)).toEqual(['board', 'task-fields'])
    const again = book({ dir })
    expect(again.b.drainsFor(HOME)).toEqual(['board', 'task-fields'])
    // A rolled-back Mac (no drains): v1 only from now on, persisted too.
    again.b.configure({ home: HOME, walnutId: WALNUT, backup: false })
    expect(again.b.drainsFor(HOME)).toBeNull()
    expect(book({ dir }).b.drainsFor(HOME)).toBeNull()
    expect(again.b.drainsFor('/unknown')).toBeNull()
  })

  it('a claim and a takeover keep the drains', () => {
    const { b, clock } = book()
    b.configure({ home: HOME, walnutId: WALNUT, backup: true, drains: ['task-fields'] })
    clock.now += T
    expect(b.backupClaim(WALNUT, 2).ok).toBe(true)
    expect(b.primaryClaim(HOME)).toMatchObject({ drains: ['task-fields'] })
  })

  it('after a boot, the companion is still refused within takeoverMs while follower writes are allowed until the primary is heard (D14)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-book-'))
    dirs.push(dir)
    book({ dir }).b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    // The daemon restarts: the record is on disk, nothing heard yet.
    const { b, clock } = book({ dir })
    expect(b.heardSinceBoot(HOME)).toBe(false)
    expect(b.backupClaim(WALNUT, 2)).toMatchObject({ ok: false, code: 'primary_alive' })
    // The follower view's rule (the twins' primaryAnswersFollower): unheard = not answering.
    const answersFollower = () => b.heardSinceBoot(HOME) && b.primaryAgeMs(HOME) < 30_000
    expect(answersFollower()).toBe(false)
    b.noteHeard(HOME)
    expect(b.heardSinceBoot(HOME)).toBe(true)
    expect(answersFollower()).toBe(true)
    clock.now += 30_000
    expect(answersFollower()).toBe(false)
  })

  it('takes a record from a legacy dir when this book has none, and copies it into its own dir', () => {
    const legacy = legacyLeaderDir()
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-book-'))
    dirs.push(legacy, mine)
    const old = book({ dir: legacy })
    old.b.configure({ home: HOME, walnutId: WALNUT, backup: true })
    old.clock.now += T
    old.b.backupClaim(WALNUT, 5)
    const build = () => createLeaderBook({
      fs, path, dir: mine, now: () => 2_000_000, keyOf: (home) => createHash('sha1').update(home).digest('hex').slice(0, 12),
      log: () => {}, takeoverMs: T, bootAt: 2_000_000, legacyDirs: [legacy],
    })
    // Building a book (every run of the daemon binary, the walnut CLI included) writes nothing.
    expect(build().recordOf(HOME)).toBeNull()
    expect(fs.readdirSync(mine)).toEqual([])
    // The boot migration takes the legacy record.
    const make = () => { const b = build(); b.importLegacy(); return b }
    expect(make().recordOf(HOME)).toMatchObject({ epoch: 5, holder: 'backup' })
    expect(fs.readdirSync(mine).filter((n) => n.startsWith('leader-'))).toHaveLength(1)
    // This dir moved on (epoch 6): the older legacy record never takes it back.
    const now = make()
    now.primaryClaim(HOME)
    expect(make().recordOf(HOME)).toMatchObject({ epoch: 6, holder: 'primary' })
  })

  it('a takeover a downgraded daemon recorded at a lower epoch wins by its later lead change, at an epoch past both books', () => {
    const legacy = legacyLeaderDir()
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-book-'))
    dirs.push(legacy, mine)
    const at = (dir: string, now: { at: number }, legacyDirs: string[] = []) => {
      const b = createLeaderBook({
        fs, path, dir, now: () => now.at, keyOf: (home) => createHash('sha1').update(home).digest('hex').slice(0, 12),
        log: () => {}, takeoverMs: T, bootAt: now.at, legacyDirs,
      })
      b.importLegacy()
      return b
    }
    // An older daemon's book: the companion led at epoch 5.
    const t = { at: 1_000_000 }
    const old = at(legacy, t)
    old.configure({ home: HOME, walnutId: WALNUT, backup: true })
    t.at += T
    expect(old.backupClaim(WALNUT, 5).ok).toBe(true)
    // Upgrade: this book takes epoch 5, the primary takes the lead back (6), later the
    // companion leads (7) and the primary returns (8).
    t.at += 1000
    const up = at(mine, t, [legacy])
    up.primaryClaim(HOME)
    t.at += T
    expect(up.backupClaim(WALNUT, 7).ok).toBe(true)
    t.at += 1000
    expect(up.primaryClaim(HOME)).toMatchObject({ epoch: 8, holder: 'primary' })
    // Downgrade: the old daemon reads epoch 5 from its own dir; the Mac takes the lead
    // there (6), then the companion takes over there (7), both after this book's last change.
    t.at += 1000
    const down = at(legacy, t)
    expect(down.recordOf(HOME)).toMatchObject({ epoch: 5 })
    down.primaryClaim(HOME)
    t.at += T
    expect(down.backupClaim(WALNUT, 7).ok).toBe(true)
    // Upgrade again: the companion leads, as the downgraded book last said, at an epoch
    // above both (a command at 7 or 8 is fenced; the companion claims again above 9).
    t.at += 1000
    const again = at(mine, t, [legacy])
    expect(again.recordOf(HOME)).toMatchObject({ holder: 'backup', epoch: 9 })
    expect(again.backupClaim(WALNUT, 9)).toMatchObject({ ok: false, code: 'stale_epoch' })
    // And the next boot keeps that answer (the legacy record is no later now).
    expect(at(mine, t, [legacy]).recordOf(HOME)).toMatchObject({ holder: 'backup', epoch: 9 })
  })

  it('a legacy record at a higher epoch but an older lead change never flips the holder: this book only raises its epoch past it', () => {
    const legacy = legacyLeaderDir()
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-book-'))
    dirs.push(legacy, mine)
    const keyOf = (home: string) => createHash('sha1').update(home).digest('hex').slice(0, 12)
    // An unreadable legacy file is injected through deps.fs (chmod passes as root).
    const denied = (file: string): typeof fs => ({
      ...fs,
      readFileSync: ((f: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (String(f) === file) throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' })
        return (fs.readFileSync as (...a: unknown[]) => unknown)(f, ...rest)
      }) as typeof fs.readFileSync,
    })
    const at = (now: number, bookFs: typeof fs = fs) => {
      const b = createLeaderBook({ fs: bookFs, path, dir: mine, now: () => now, keyOf, log: () => {}, takeoverMs: T, bootAt: now, legacyDirs: [legacy] })
      b.importLegacy()
      return b
    }
    // A v1 daemon's book: the companion took the lead at 1000 (epoch 3).
    const legacyFile = path.join(legacy, `leader-${keyOf(HOME)}.json`)
    fs.writeFileSync(legacyFile, JSON.stringify({ v: 1, home: HOME, walnutId: WALNUT, backup: true, epoch: 3, holder: 'backup', since: 1000 }))
    // Boot 1 cannot read it (tried again at the next boot); the Mac configures at 5000.
    const first = at(5000, denied(legacyFile))
    expect(first.recordOf(HOME)).toBeNull()
    first.configure({ home: HOME, walnutId: WALNUT, backup: true })
    expect(first.recordOf(HOME)).toMatchObject({ epoch: 1, holder: 'primary', since: 5000 })
    // Boot 2 reads it: the Mac still leads (its lead change is the later one), past epoch 3.
    const second = at(6000)
    expect(second.recordOf(HOME)).toMatchObject({ epoch: 4, holder: 'primary', since: 5000 })
    // A command at either old epoch is fenced; the legacy file is never changed.
    expect(second.backupClaim(WALNUT, 3)).toMatchObject({ ok: false, code: 'stale_epoch' })
    expect(JSON.parse(fs.readFileSync(legacyFile, 'utf8'))).toMatchObject({ epoch: 3, holder: 'backup' })
    // Boot 3 keeps that answer (the copy in this dir is no older now).
    expect(at(7000).recordOf(HOME)).toMatchObject({ epoch: 4, holder: 'primary', since: 5000 })
  })
})
