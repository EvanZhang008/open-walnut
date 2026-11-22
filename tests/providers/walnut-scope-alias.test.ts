/**
 * One Walnut, one home (walnut-scope-core.ts aliases): a host keys each Walnut by its first
 * home here, so a Walnut that comes back from another data dir with the same instance id
 * keeps its state. Unit tier: the rules of `adopt`, the alias file, and that every file
 * keeps a name an older daemon (sha1 of the path it embeds) still finds.
 *
 * Plus the ratchet that keeps ONE key: every core a daemon twin builds takes walnutScope.keyOf,
 * and the sha1-of-a-home closure lives only in walnutScope's own deps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createWalnutScope, type HomeAdoptionFacts } from '../../src/providers/walnut-scope-core.js'
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

/** A host that keeps `records` (home -> walnutId), with `busy` homes still in use. */
function facts(home: string, walnutId: unknown, records: Record<string, string>, busy: Record<string, string> = {}, extra: Partial<HomeAdoptionFacts> = {}): HomeAdoptionFacts {
  return {
    home, walnutId,
    hasRecord: (h) => h in records,
    homesWith: (w) => Object.keys(records).filter((h) => records[h] === w),
    inUse: (h) => busy[h] ?? null,
    offered: true,
    ...extra,
  }
}

describe('adopt: a home becomes an alias only when it is surely the same Walnut', () => {
  it('a new home with the id of a Walnut kept under another home that is away is its alias', () => {
    const scope = scopeAt()
    expect(scope.adopt(facts('/new/walnut', W, { '/old/walnut': W }))).toEqual({ aliased: true, from: '/new/walnut', to: '/old/walnut' })
    expect(scope.canonical('/new/walnut')).toBe('/old/walnut')
    // Every key is the first home's: the files it already has are the ones used.
    expect(scope.keyOf('/new/walnut')).toBe(sha('/old/walnut'))
    expect(scope.dirFor('/base', '/new/walnut')).toBe(path.join('/base', 'walnuts', sha('/old/walnut')))
    // The path's own key is still there for what a server computes about itself.
    expect(scope.pathKeyOf('/new/walnut')).toBe(sha('/new/walnut'))
    expect(scope.whereNow('/old/walnut')).toBe('/new/walnut')
    expect(scope.aliasesOf('/old/walnut')).toEqual(['/new/walnut'])
  })

  it('never while the first home is in use: a copy of its data dir shares the id', () => {
    const scope = scopeAt()
    const r = scope.adopt(facts('/copy', W, { '/real': W }, { '/real': 'socket_open' }))
    expect(r).toEqual({ aliased: false, why: 'first_home_in_use:socket_open' })
    expect(scope.canonical('/copy')).toBe('/copy')
    // The file keeps only that a leader offered its moves: no alias.
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ v: 1, aliases: {}, movesOffered: true })
  })

  it('never on an id the leader keeps in memory only', () => {
    const scope = scopeAt()
    expect(scope.adopt(facts('/new', W, { '/old': W }, {}, { volatile: true }))).toEqual({ aliased: false, why: 'volatile_id' })
    // A leader that does not offer its home moves (the one-service experiment off) never gets one.
    expect(scope.adopt(facts('/new', W, { '/old': W }, {}, { offered: false }))).toEqual({ aliased: false, why: 'not_offered' })
    expect(scope.adopt(facts('/new', W, { '/old': W }, {}, { offered: undefined }))).toEqual({ aliased: false, why: 'not_offered' })
  })

  it('a leader with no id (older than leader.configure) keeps the path: two homes are two Walnuts', () => {
    const scope = scopeAt()
    expect(scope.adopt(facts('/new', undefined, { '/old': W }))).toEqual({ aliased: false, why: 'no_walnut_id' })
    expect(scope.adopt(facts('/new', 'not an id!', { '/old': W }))).toEqual({ aliased: false, why: 'no_walnut_id' })
    expect(scope.keyOf('/new')).toBe(sha('/new'))
  })

  it('never over a home with a record of its own, nor when two homes hold the id, nor for a new Walnut', () => {
    const scope = scopeAt()
    expect(scope.adopt(facts('/b', W, { '/a': W, '/b': W }))).toEqual({ aliased: false, why: 'own_record' })
    expect(scope.adopt(facts('/c', W, { '/a': W, '/b': W }))).toEqual({ aliased: false, why: 'several_homes' })
    expect(scope.adopt(facts('/d', 'b'.repeat(32), { '/a': W }))).toEqual({ aliased: false, why: 'first_home' })
  })

  it('a scope with no alias file is today\'s: every home its own', () => {
    const scope = createWalnutScope({ path, keyOf: sha })
    expect(scope.adopt(facts('/new', W, { '/old': W }))).toEqual({ aliased: false, why: 'no_alias_file' })
    expect(scope.keyOf('/new')).toBe(sha('/new'))
  })
})

describe('one home of a Walnut speaks at a time (speakingElsewhere)', () => {
  it('a home is refused while another home of its Walnut has a live server socket, in either order', () => {
    const scope = scopeAt()
    // No alias yet: two homes are two Walnuts, each speaks freely.
    expect(scope.speakingElsewhere('/b', ['/a'])).toBeNull()
    expect(scope.adopt(facts('/b', W, { '/a': W })).aliased).toBe(true)
    // The alias came while the first home was away, then the first home came back: it waits.
    expect(scope.speakingElsewhere('/a', ['/b'])).toBe('/b')
    // The reverse: the first home speaks, the alias waits.
    expect(scope.speakingElsewhere('/b', ['/a'])).toBe('/a')
    // Sockets of the same home (a server's bulk channel) and of other Walnuts never count.
    expect(scope.speakingElsewhere('/b', ['/b', '/other'])).toBeNull()
    expect(scope.speakingElsewhere('/other', ['/a', '/b'])).toBeNull()
  })

  it('the other home works again once the first is gone', () => {
    const scope = scopeAt()
    scope.adopt(facts('/b', W, { '/a': W }))
    const live = new Set(['/b'])
    expect(scope.speakingElsewhere('/a', live)).toBe('/b')
    live.delete('/b')
    expect(scope.speakingElsewhere('/a', live)).toBeNull()
    // A daemon restarted after the alias keeps the rule (read from the file).
    expect(scopeAt().speakingElsewhere('/a', ['/b'])).toBe('/b')
  })
})

describe('a leader ever offered its home moves (movesOffered)', () => {
  it('false until a leader offers them: with the experiment off no home waits for an alias', () => {
    const scope = scopeAt()
    expect(scope.movesOffered()).toBe(false)
    scope.adopt(facts('/new', W, { '/old': W }, {}, { offered: false }))
    expect(scope.movesOffered()).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('kept in the alias file once offered, even when no alias came, and read back after a restart', () => {
    const scope = scopeAt()
    // A Walnut new to this host offers its moves: nothing to alias, the flag is kept.
    expect(scope.adopt(facts('/a', W, {}))).toEqual({ aliased: false, why: 'first_home' })
    expect(scope.movesOffered()).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ v: 1, movesOffered: true })
    expect(scopeAt().movesOffered()).toBe(true)
    // An alias written later keeps the flag beside it.
    expect(scope.adopt(facts('/b', W, { '/a': W })).aliased).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ v: 1, movesOffered: true, aliases: { '/b': { to: '/a' } } })
  })
})

describe('the alias file', () => {
  it('a new daemon reads it back; a chain names the last home and a cycle names none', () => {
    expect(scopeAt().adopt(facts('/b', W, { '/a': W })).aliased).toBe(true)
    expect(scopeAt().canonical('/b')).toBe('/a')
    fs.writeFileSync(file, JSON.stringify({ v: 1, aliases: {
      '/c': { to: '/b', walnutId: W, at: 2 }, '/b': { to: '/a', walnutId: W, at: 1 },
      '/x': { to: '/y', walnutId: W, at: 1 }, '/y': { to: '/x', walnutId: W, at: 1 },
      '/bad': { to: '/a', walnutId: 'no!', at: 1 },
    } }))
    const scope = scopeAt()
    expect(scope.canonical('/c')).toBe('/a')
    expect(scope.canonical('/x')).toBe('/x')
    expect(scope.canonical('/bad')).toBe('/bad')
    expect(scope.whereNow('/a')).toBe('/c')
  })

  it('asked before its dir is known (a twin\'s boot order), it is read on a later use', () => {
    expect(scopeAt().adopt(facts('/b', W, { '/a': W })).aliased).toBe(true)
    let ready = false
    const scope = scopeAt(() => { if (!ready) throw new ReferenceError('not yet'); return file })
    expect(scope.canonical('/b')).toBe('/b')
    ready = true
    expect(scope.canonical('/b')).toBe('/a')
  })

  it('an alias that could not be written is not made', () => {
    fs.writeFileSync(path.join(dir, 'leader'), 'a file where the dir should be')
    const scope = scopeAt()
    expect(scope.adopt(facts('/b', W, { '/a': W }))).toEqual({ aliased: false, why: 'not_persisted' })
    expect(scope.canonical('/b')).toBe('/b')
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
    expect(scope.adopt(facts(HOME_B, W, { [HOME_A]: W })).aliased).toBe(true)
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
    expect(scope.adopt(facts(HOME_B, W, { [HOME_A]: W })).aliased).toBe(true)
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
  // journalHost builds with the path key: build again with the scope's (the twins' wiring).
  return createOfflineHostOver({ ...made.deps, keyOf: over.keyOf, canonical: over.canonical })
}

describe('rollback: an older daemon (sha1 of the path a file embeds) still finds every file', () => {
  it('a file written for the new home after the alias is named by the home it embeds', () => {
    const scope = scopeAt()
    scope.adopt(facts('/b', W, { '/a': W }))
    // What a core writes for a command of /b: the canonical home inside, its key outside.
    const home = scope.canonical('/b')
    const name = `slice-${scope.keyOf('/b')}.json`
    expect(name).toBe(`slice-${sha(home)}.json`)
    expect(home).toBe('/a')
  })
})

describe('one key for a home in both daemon twins', () => {
  const TWINS = {
    standalone: fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8'),
    // Only the template the remote host runs (the smoke builders above it pass stubs).
    source: fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf8'),
  }
  for (const [name, src] of Object.entries(TWINS)) {
    it(`${name}: no core gets a key of its own: each takes walnutScope.keyOf`, () => {
      const closures = [...src.matchAll(/createHash\('sha1'\)\.update\((?:home|value)\)\.digest\('hex'\)\.slice\(0, 16\)/g)]
      expect(closures.length, 'the one sha1 of a home is walnutScope\'s own dep').toBe(1)
      expect(src.match(/keyOf: walnutScope\.keyOf/g)?.length ?? 0, 'the cores take the scope\'s key').toBeGreaterThanOrEqual(7)
      expect(src).toMatch(/dirOf: (?:\(home\) => |function \(home\) \{ return )path\.join\(REPLICA_DIR, walnutScope\.keyOf\(home\), 'attachments'\)/)
      // The served record names where the Walnut speaks from now (what its server computes).
      expect(src).toMatch(/walnutScope\.pathKeyOf\(walnutScope\.whereNow\(value\)\)/)
    })
    it(`${name}: every command is read by its Walnut's first home, and an alias folds what came before`, () => {
      expect(src).toMatch(/cmd = adoptCommandHome\(ws, sent\)/)
      for (const fn of ['foldTriggerScope', 'foldHooks', 'foldBridgeLink', 'offlineHost.foldHome', 'servedWalnuts.forgetKey']) {
        expect(src, fn).toContain(`${fn}(`)
      }
      // Only leader.configure carries walnutHomeMoves: no other command adopts.
      expect(src).toMatch(/cmd\.cmd === 'leader\.configure' && server/)
      expect(src).not.toMatch(/WALNUT_ID_COMMANDS|walnutIdOfCommand/)
      // One home of a Walnut speaks at a time; a new home's first checks wait for its leader.configure.
      expect(src).toMatch(/walnutScope\.speakingElsewhere\(home, serverPlaces\(ws\)\)/)
      expect(src).toMatch(/if \(!cmd\) return/)
      expect(src).toMatch(/heldForLeader\(entry, now\)\) continue/)
      expect(src).toMatch(/if \(homeAliasMayCome\(home\)\) \w+\.waitsForLeader = true/)
      expect(src).toMatch(/return !!home && walnutScope\.movesOffered\(\) && !leaderBook\.recordOf\(home\)/)
      expect(src).toMatch(/canonical: walnutScope\.canonical/)
    })
  }
})
