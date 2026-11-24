/**
 * One Walnut, one home (walnut-scope-core.ts): a host keys each Walnut by its first home here,
 * and a Walnut whose server DECLARED that its data dir moved (leader.configure's movedFrom)
 * keeps its state. Nothing is inferred. Unit tier: the rules of `declareMove`, the home it left
 * refused for good (`movedTo`), the alias file, and that every file keeps a name an older daemon
 * (sha1 of the path it embeds) still finds.
 *
 * Plus the ratchet that keeps ONE key: every core a daemon twin builds takes walnutScope.keyOf,
 * and the sha1-of-a-home closure lives only in walnutScope's own deps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createWalnutScope, type DeclaredMove } from '../../src/providers/walnut-scope-core.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { cleanupJournalDirs, journalHost, journalTmpDir, jslice } from '../helpers/offline-journal-harness.js'
import { createOfflineHost as createOfflineHostOver } from '../../src/providers/offline-host-core.js'

const ROOT = path.resolve(__dirname, '../..')
const sha = (v: string) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 16)
const W = 'a'.repeat(32)

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-scope-alias-'))
  file = path.join(dir, 'leader', 'homes.json')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const scopeAt = (aliasFile: () => string = () => file) => createWalnutScope({ path, fs, keyOf: sha, aliasFile, now: () => 1_000 })

/** `home` declares it moved from `from`, on a host whose leader records are `records` (home -> walnutId). */
function move(home: string, from: unknown, records: Record<string, string>, extra: Partial<DeclaredMove> = {}): DeclaredMove {
  return { home, movedFrom: from, walnutId: W, recordIdOf: (h) => records[h] ?? null, ...extra }
}

describe('declareMove: a home becomes an alias only on a declared move of the same Walnut', () => {
  it('a declared move from a home whose record names the same id: the new home is its alias', () => {
    const scope = scopeAt()
    expect(scope.declareMove(move('/new/walnut', '/old/walnut', { '/old/walnut': W }))).toEqual({ moved: true, to: '/old/walnut', aliased: true })
    expect(scope.canonical('/new/walnut')).toBe('/old/walnut')
    // Every key is the first home's: the files it already has are the ones used.
    expect(scope.keyOf('/new/walnut')).toBe(sha('/old/walnut'))
    expect(scope.dirFor('/base', '/new/walnut')).toBe(path.join('/base', 'walnuts', sha('/old/walnut')))
    // The path's own key is still there for what a server computes about itself.
    expect(scope.pathKeyOf('/new/walnut')).toBe(sha('/new/walnut'))
    expect(scope.whereNow('/old/walnut')).toBe('/new/walnut')
    // The same declaration again (every connect sends it) changes nothing.
    expect(scope.declareMove(move('/new/walnut', '/old/walnut', { '/old/walnut': W }))).toEqual({ moved: true, to: '/old/walnut', aliased: false })
  })

  it('nothing declared, a home it does not know, another Walnut\'s id: no alias, ever', () => {
    const scope = scopeAt()
    expect(scope.declareMove(move('/copy', undefined, { '/real': W }))).toEqual({ moved: false, why: 'none' })
    expect(scope.declareMove(move('/new', '/unknown', { '/real': W }))).toEqual({ moved: false, why: 'not_this_walnut' })
    expect(scope.declareMove(move('/new', '/real', { '/real': 'b'.repeat(32) }))).toEqual({ moved: false, why: 'not_this_walnut' })
    expect(scope.canonical('/copy')).toBe('/copy')
    expect(scope.canonical('/new')).toBe('/new')
    expect(fs.existsSync(file), 'nothing was moved: no alias file').toBe(false)
  })

  it('never on a volatile id, an id that is not one, a home with a record of its own, or itself', () => {
    const scope = scopeAt()
    expect(scope.declareMove(move('/new', '/old', { '/old': W }, { volatile: true }))).toEqual({ moved: false, why: 'volatile_id' })
    expect(scope.declareMove(move('/new', '/old', { '/old': W }, { walnutId: undefined }))).toEqual({ moved: false, why: 'no_walnut_id' })
    expect(scope.declareMove(move('/new', '/old', { '/old': W }, { walnutId: 'not an id!' }))).toEqual({ moved: false, why: 'no_walnut_id' })
    expect(scope.declareMove(move('/b', '/a', { '/a': W, '/b': 'c'.repeat(32) }))).toEqual({ moved: false, why: 'own_record' })
    // N2: the record under the new home is this Walnut's own (a move made before it declared moves): quiet.
    expect(scope.declareMove(move('/b', '/a', { '/a': W, '/b': W }))).toEqual({ moved: false, why: 'own_record_same' })
    expect(scope.declareMove(move('/a', '/a', { '/a': W }))).toEqual({ moved: false, why: 'bad_home' })
    expect(scope.keyOf('/new')).toBe(sha('/new'))
  })

  it('a scope with no alias file is today\'s: every home its own', () => {
    const scope = createWalnutScope({ path, keyOf: sha })
    expect(scope.declareMove(move('/new', '/old', { '/old': W }))).toEqual({ moved: false, why: 'no_alias_file' })
    expect(scope.keyOf('/new')).toBe(sha('/new'))
  })
})

describe('the home a Walnut left is refused for good (movedTo)', () => {
  it('after a move the old home is refused whether or not the new one is connected, and a move back flips it', () => {
    const scope = scopeAt()
    // No move yet: two homes are two Walnuts, each speaks freely.
    expect(scope.movedTo('/a')).toBeNull()
    expect(scope.declareMove(move('/b', '/a', { '/a': W })).moved).toBe(true)
    // For good: no socket state counts, so two diverged copies can never take turns.
    expect(scope.movedTo('/a')).toBe('/b')
    expect(scope.movedTo('/b')).toBeNull()
    expect(scopeAt().movedTo('/a'), 'a restarted daemon keeps the rule').toBe('/b')
    // A declared move back: the first home speaks again, the one it left is refused.
    expect(scope.declareMove(move('/a', '/b', { '/a': W }))).toEqual({ moved: true, to: '/a', aliased: false })
    expect(scope.movedTo('/a')).toBeNull()
    expect(scope.movedTo('/b')).toBe('/a')
    expect(scope.whereNow('/b')).toBe('/a')
    // Still one Walnut, keyed by its first home.
    expect(scope.keyOf('/b')).toBe(sha('/a'))
    // Other Walnuts are never touched.
    expect(scope.movedTo('/other')).toBeNull()
  })

  it('a chain of moves keeps one Walnut; only the newest home speaks', () => {
    const scope = scopeAt()
    expect(scope.declareMove(move('/b', '/a', { '/a': W })).moved).toBe(true)
    expect(scope.declareMove(move('/c', '/b', { '/a': W }))).toEqual({ moved: true, to: '/a', aliased: true })
    expect(scope.canonical('/c')).toBe('/a')
    expect(scope.movedTo('/a')).toBe('/c')
    expect(scope.movedTo('/b')).toBe('/c')
    expect(scope.movedTo('/c')).toBeNull()
  })
})

describe('review A3b: copies, several hops, another Walnut, and moves a host cannot follow', () => {
  it('M1: a backup started after the move declares the same former home: refused for good, no turns', () => {
    const scope = scopeAt()
    const records = { '/a': W }
    expect(scope.declareMove(move('/a1', '/a', records))).toEqual({ moved: true, to: '/a', aliased: true })
    // The backup B of /a, started later, also says it came from /a: it is not where the Walnut is now.
    expect(scope.declareMove(move('/b', '/a', records))).toEqual({ moved: false, why: 'contested' })
    expect(scope.whereNow('/a')).toBe('/a1')
    expect(scope.refusalOf('/b', W)).toEqual({ errorKind: 'walnut_home_busy', movedTo: '/a1' })
    // They reconnect in turn: nothing flips, ever, and a restarted daemon keeps it.
    for (let i = 0; i < 3; i++) {
      expect(scope.declareMove(move('/a1', '/a', records))).toEqual({ moved: true, to: '/a', aliased: false })
      expect(scope.declareMove(move('/b', '/a', records))).toEqual({ moved: false, why: 'contested' })
      expect(scope.whereNow('/a')).toBe('/a1')
    }
    expect(scopeAt().movedTo('/b')).toBe('/a1')
    expect(scopeAt().movedTo('/a1')).toBeNull()
    // The real one may still move on to /b later (a move from where it is now).
    expect(scope.declareMove(move('/b', '/a1', records, { formerHomes: ['/a1', '/a'] }))).toEqual({ moved: true, to: '/a', aliased: false })
    expect(scope.movedTo('/a1')).toBe('/b')
  })

  it('N1: a backup B that reached the host first gives the place to the real A1 once A1\'s server says B is gone', () => {
    const scope = scopeAt()
    const records = { '/a': W }
    expect(scope.declareMove(move('/b', '/a', records))).toEqual({ moved: true, to: '/a', aliased: true })
    // The real A1 comes later: contested while B may still be alive (a person picks).
    expect(scope.declareMove(move('/a1', '/a', records))).toEqual({ moved: false, why: 'contested' })
    expect(scope.refusalOf('/a1', W)).toEqual({ errorKind: 'walnut_home_busy', movedTo: '/b' })
    // Naming a copy that is not where the Walnut is now proves nothing.
    expect(scope.declareMove(move('/a1', '/a', records, { copyGone: '/elsewhere' }))).toEqual({ moved: false, why: 'contested' })
    // A1's server found /b no longer holds this Walnut: A1 takes the place, and /b is the one refused.
    expect(scope.declareMove(move('/a1', '/a', records, { copyGone: '/b' }))).toEqual({ moved: true, to: '/a', aliased: false })
    expect(scope.whereNow('/a')).toBe('/a1')
    expect(scope.refusalOf('/a1', W)).toBeNull()
    expect(scope.refusalOf('/b', W)).toEqual({ errorKind: 'walnut_home_busy', movedTo: '/a1' })
    // It holds after a restart, and later connects (which send no copyGone) keep it.
    const again = scopeAt()
    expect(again.movedTo('/a1')).toBeNull()
    expect(again.movedTo('/b')).toBe('/a1')
    expect(again.declareMove(move('/a1', '/a', records))).toEqual({ moved: true, to: '/a', aliased: false })
    // A copy that comes back after it was replaced is contested in turn: no flip by connect order.
    expect(again.declareMove(move('/b', '/a', records))).toEqual({ moved: false, why: 'contested' })
    expect(again.whereNow('/a')).toBe('/a1')
  })

  it('N1 first contact: a copy that never spoke here takes the place of a gone one directly (an alias at once)', () => {
    const scope = scopeAt()
    const records = { '/a': W }
    expect(scope.declareMove(move('/b', '/a', records)).moved).toBe(true)
    // Without the contested round first (another host told it already).
    expect(scope.declareMove(move('/a1', '/a', records, { copyGone: '/b' }))).toEqual({ moved: true, to: '/a', aliased: true })
    expect(scope.keyOf('/a1')).toBe(sha('/a'))
    expect(scope.movedTo('/b')).toBe('/a1')
  })

  it('N3: a contested declaration from the Walnut\'s first home keeps no self alias', () => {
    const scope = scopeAt()
    const records = { '/a': W }
    expect(scope.declareMove(move('/b', '/a', records)).moved).toBe(true)
    expect(scope.declareMove(move('/a1', '/a', records))).toEqual({ moved: false, why: 'contested' })
    // A1 moves back to /a while the host follows B: contested, and /a is never its own alias.
    expect(scope.declareMove(move('/a', '/a1', records, { formerHomes: ['/a1', '/a'] }))).toEqual({ moved: false, why: 'contested' })
    const file2 = JSON.parse(fs.readFileSync(file, 'utf8')) as { aliases: Record<string, { to: string }> }
    for (const [from, a] of Object.entries(file2.aliases)) expect(a.to, from).not.toBe(from)
    expect(scope.canonical('/a')).toBe('/a')
  })

  it('M2: a host that missed the first of two moves follows from the home it knows', () => {
    const scope = scopeAt()
    expect(scope.declareMove(move('/a2', '/a1', { '/a': W }, { formerHomes: ['/a1', '/a'] }))).toEqual({ moved: true, to: '/a', aliased: true })
    expect(scope.keyOf('/a2')).toBe(sha('/a'))
    expect(scope.movedTo('/a')).toBe('/a2')
    // A host that heard both moves takes the second from the first.
    const both = scopeAt(() => path.join(dir, 'other', 'homes.json'))
    expect(both.declareMove(move('/a1', '/a', { '/a': W })).moved).toBe(true)
    expect(both.declareMove(move('/a2', '/a1', { '/a': W }, { formerHomes: ['/a1', '/a'] }))).toEqual({ moved: true, to: '/a', aliased: true })
    expect(both.movedTo('/a1')).toBe('/a2')
  })

  it('M2: a move this host cannot follow is one its server hears of; a host that never knew the Walnut is not', () => {
    const scope = scopeAt()
    const lost = scope.declareMove(move('/a9', '/a8', { '/a': W }, { homes: () => ['/a'] }))
    expect(lost).toEqual({ moved: false, why: 'lost_trail' })
    expect(scope.moveNotTakenTold('lost_trail')).toBe(true)
    expect(scope.moveNotTakenTold('own_record')).toBe(true)
    expect(scope.declareMove(move('/n', '/m', {}, { homes: () => [] }))).toEqual({ moved: false, why: 'not_this_walnut' })
    for (const quiet of ['not_this_walnut', 'none', 'contested', 'volatile_id', 'own_record_same']) expect(scope.moveNotTakenTold(quiet)).toBe(false)
  })

  it('M3: another Walnut at the path a Walnut left reads walnut_home_taken; the same Walnut reads busy', () => {
    const scope = scopeAt()
    const records = { '/a': W }
    expect(scope.declareMove(move('/a1', '/a', records)).moved).toBe(true)
    const recordIdOf = (h: string) => (records as Record<string, string>)[h] ?? null
    expect(scope.refusalOf('/a', 'c'.repeat(32), recordIdOf)).toEqual({ errorKind: 'walnut_home_taken', movedTo: '/a1' })
    expect(scope.refusalOf('/a', W, recordIdOf)).toEqual({ errorKind: 'walnut_home_busy', movedTo: '/a1' })
    // A command that names no id (a push) reads busy; a home nobody left is never refused.
    expect(scope.refusalOf('/a', undefined, recordIdOf)?.errorKind).toBe('walnut_home_busy')
    expect(scope.refusalOf('/a1', 'c'.repeat(32), recordIdOf)).toBeNull()
  })
})

describe('the alias file', () => {
  it('a new daemon reads it back; a chain names the last home and a cycle names none', () => {
    expect(scopeAt().declareMove(move('/b', '/a', { '/a': W })).moved).toBe(true)
    expect(scopeAt().canonical('/b')).toBe('/a')
    fs.writeFileSync(file, JSON.stringify({ v: 2, aliases: {
      '/c': { to: '/b', walnutId: W, at: 2 }, '/b': { to: '/a', walnutId: W, at: 1 },
      '/x': { to: '/y', walnutId: W, at: 1 }, '/y': { to: '/x', walnutId: W, at: 1 },
      '/bad': { to: '/a', walnutId: 'no!', at: 1 },
    }, places: { '/a': '/c', '/q': '/nope' } }))
    const scope = scopeAt()
    expect(scope.canonical('/c')).toBe('/a')
    expect(scope.canonical('/x')).toBe('/x')
    expect(scope.canonical('/bad')).toBe('/bad')
    expect(scope.whereNow('/a')).toBe('/c')
    expect(scope.movedTo('/q'), 'a place that is no alias of its Walnut is dropped').toBeNull()
  })

  it('land 1\'s inferred aliases (v1) are dropped at first read', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ v: 1, aliases: { '/b': { to: '/a', walnutId: W, at: 1 } }, movesOffered: true }))
    const scope = scopeAt()
    expect(scope.canonical('/b')).toBe('/b')
    expect(scope.movedTo('/a')).toBeNull()
  })

  it('asked before its dir is known (a twin\'s boot order), it is read on a later use', () => {
    expect(scopeAt().declareMove(move('/b', '/a', { '/a': W })).moved).toBe(true)
    let ready = false
    const scope = scopeAt(() => { if (!ready) throw new ReferenceError('not yet'); return file })
    expect(scope.canonical('/b')).toBe('/b')
    ready = true
    expect(scope.canonical('/b')).toBe('/a')
  })

  it('an alias that could not be written is not made', () => {
    fs.writeFileSync(path.join(dir, 'leader'), 'a file where the dir should be')
    const scope = scopeAt()
    expect(scope.declareMove(move('/b', '/a', { '/a': W }))).toEqual({ moved: false, why: 'not_persisted' })
    expect(scope.canonical('/b')).toBe('/b')
    expect(scope.movedTo('/a')).toBeNull()
  })
})

describe('the journal and the host copy go on under the first home', () => {
  afterEach(() => cleanupJournalDirs())
  const HOME_A = '/fixture/marina-home'
  const HOME_B = '/fixture/new-box/marina-home'

  it('a record the host wrote for the first home is drained by the leader from the new one, after a restart', () => {
    const jdir = journalTmpDir()
    const clock = { now: Date.parse('2026-11-21T10:00:00Z') }
    const scope = scopeAt()
    const first = journalHost(jdir, clock, { journal: { keyOf: scope.keyOf } })
    first.host.configure(jslice({ home: HOME_A }))
    expect(first.journal.append(HOME_A, { kind: 'settings', sid: 'aaaaaaaa-1111-4111-8111-111111111111', effort: 'high' })).toMatchObject({ ok: true })
    first.journal.close()
    expect(scope.declareMove(move(HOME_B, HOME_A, { [HOME_A]: W })).moved).toBe(true)
    // A restarted daemon: the leader names the new home, the daemon reads it as the first one.
    const again = journalHost(jdir, clock, { journal: { keyOf: scope.keyOf } })
    const drained = again.host.drain(scope.canonical(HOME_B), JOURNAL_V2_DRAINS)
    expect(drained.records.map((r) => r.kind)).toEqual(['settings'])
    // One journal on disk, named by the home its header embeds (what an older daemon checks).
    const journals = fs.readdirSync(jdir).filter((n) => n.endsWith('.ndjson'))
    expect(journals).toEqual([`journal-${sha(HOME_A)}.ndjson`])
    expect(JSON.parse(fs.readFileSync(path.join(jdir, journals[0]!), 'utf8').split('\n')[0]!)).toMatchObject({ home: HOME_A })
  })

  it('a copy the new home sent before the alias is the Walnut\'s; its own file is left out at boot', () => {
    const jdir = journalTmpDir()
    const clock = { now: Date.parse('2026-11-21T10:00:00Z') }
    const scope = scopeAt()
    const deps = { keyOf: scope.keyOf, canonical: scope.canonical }
    const live = journalHostWith(jdir, clock, deps)
    live.configure(jslice({ home: HOME_A, hash: 'old', asOf: 1 }))
    live.configure(jslice({ home: HOME_B, hash: 'new', asOf: 2 }))
    expect(scope.declareMove(move(HOME_B, HOME_A, { [HOME_A]: W })).moved).toBe(true)
    live.foldHome(HOME_B, HOME_A)
    expect(live.holdsSlice(HOME_A, 'new')).toBe(true)
    expect(live.hasHome(HOME_B)).toBe(false)
    // The new home's own file stays (an older daemon reads it as that home's), a new daemon leaves it out.
    expect(fs.existsSync(path.join(jdir, `slice-${sha(HOME_B)}.json`))).toBe(true)
    const rebooted = journalHostWith(jdir, clock, deps)
    expect(rebooted.homes()).toEqual([HOME_A])
    expect(rebooted.holdsSlice(HOME_A, 'new')).toBe(true)
  })
})

/** An offline host whose keys and homes come from a walnut scope. */
function journalHostWith(jdir: string, clock: { now: number }, over: { keyOf: (h: string) => string; canonical: (h: string) => string }) {
  const made = journalHost(jdir, clock, { journal: { keyOf: over.keyOf } })
  // journalHost builds with the path key: build again with the scope's (the daemon's wiring).
  return createOfflineHostOver({ ...made.deps, keyOf: over.keyOf, canonical: over.canonical })
}

describe('rollback: an older daemon (sha1 of the path a file embeds) still finds every file', () => {
  it('a file written for the new home after the alias is named by the home it embeds', () => {
    const scope = scopeAt()
    scope.declareMove(move('/b', '/a', { '/a': W }))
    // What a core writes for a command of /b: the canonical home inside, its key outside.
    const home = scope.canonical('/b')
    const name = `slice-${scope.keyOf('/b')}.json`
    expect(name).toBe(`slice-${sha(home)}.json`)
    expect(home).toBe('/a')
  })
})

describe('one key for a home in the daemon', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
  it('no core gets a key of its own: each takes walnutScope.keyOf', () => {
    const closures = [...src.matchAll(/createHash\('sha1'\)\.update\((?:home|value)\)\.digest\('hex'\)\.slice\(0, 16\)/g)]
    expect(closures.length, 'the one sha1 of a home is walnutScope\'s own dep').toBe(1)
    expect(src.match(/keyOf: walnutScope\.keyOf/g)?.length ?? 0, 'the cores take the scope\'s key').toBeGreaterThanOrEqual(6)
    // The journal's store and host take it through host-journal-core.ts, which passes it on as given.
    const journalCore = fs.readFileSync(path.join(ROOT, 'src/providers/host-journal-core.ts'), 'utf8')
    expect(journalCore.match(/keyOf: deps\.keyOf/g)?.length ?? 0).toBe(2)
    expect(src).toMatch(/dirOf: (?:\(home\) => |function \(home\) \{ return )path\.join\(REPLICA_DIR, walnutScope\.keyOf\(home\), 'attachments'\)/)
    // The served record names where the Walnut speaks from now (what its server computes).
    expect(src).toMatch(/walnutScope\.pathKeyOf\(walnutScope\.whereNow\(value\)\)/)
  })
  it('every command is read by its Walnut\'s first home, and an alias folds what came before', () => {
    expect(src).toMatch(/cmd = adoptCommandHome\(ws, sent\)/)
    for (const fn of ['foldTriggerScope', 'foldHooks', 'foldBridgeLink', 'offlineHost.foldHome', 'servedWalnuts.forgetKey']) {
      expect(src, fn).toContain(`${fn}(`)
    }
    // Only a server's leader.configure declares a move; nothing infers one.
    expect(src).toMatch(/cmd\.cmd === 'leader\.configure' && cmd\.movedFrom !== undefined && isServerClient\(ws\)/)
    expect(src).toMatch(/walnutScope\.declareMove\(/)
    expect(src).not.toMatch(/walnutScope\.adopt\(|walnutHomeMoves|movesOffered|homeAliasMayCome|heldForLeader|waitsForLeader|HOME_ALIAS_WAIT_MS|serverPlaces|homeInUse/)
    // The home a Walnut left is refused for good, a command and a copy alike.
    expect(src.match(/(?<!function )refuseMovedHome\(ws, cmd, /g)?.length ?? 0).toBe(2)
    // Why, from the scope (busy: this Walnut is elsewhere; taken: another Walnut left this path).
    expect(src).toMatch(/walnutScope\.refusalOf\(home, cmd\.walnutId, /)
    expect(src).toMatch(/errorKind: refusal\.errorKind, movedTo: refusal\.movedTo/)
    // Every former home goes to the scope, and a move not taken is told back on the answer.
    expect(src).toMatch(/formerHomes: cmd\.formerHomes/)
    expect(src).toMatch(/moveNotTaken: notTaken/)
    expect(src).toMatch(/if \(!cmd\) return/)
    expect(src).toMatch(/canonical: walnutScope\.canonical/)
  })
})
