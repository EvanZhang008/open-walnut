/**
 * The daemon twins' journal boot migration (createJournalMigration in
 * src/providers/offline-journal-core.ts, which both twins run: daemon-source.ts inlines it
 * by toString), the state.json read rule, and the ONE journal root each twin computes
 * (evaluated from both twins' own text, so the two rules cannot drift). Temp dirs pose as
 * the home, the prod dir and the daemon dirs; faults are injected through deps.fs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { JHOME, SID_A, TASK_A, journalTmpDir, cleanupJournalDirs, journalStore, journalHost, jslice, keyOf, type Clock } from '../helpers/offline-journal-harness.js'
import { JOURNAL_V2_DRAINS, createJournalMigration, type OfflineJournal } from '../../src/providers/offline-journal-core.js'
import { createLeaderBook } from '../../src/providers/leader-core.js'

const T0 = Date.parse('2026-10-14T12:00:00Z')
const ROOT = path.resolve(__dirname, '../..')
const settings = (effort: string) => ({ kind: 'settings', sid: SID_A, effort })

afterEach(() => cleanupJournalDirs())

/** An fs whose calls on paths `fail` names throw `code` (deps.fs: chmod passes as root). */
function faultyFs(fail: (call: string, file: string) => string | null): typeof fs {
  const wrap = (name: 'readFileSync' | 'renameSync' | 'statSync' | 'openSync') =>
    (file: fs.PathLike, ...rest: unknown[]) => {
      const code = fail(name, String(file))
      if (code) throw Object.assign(new Error(`${code}: injected on ${name} ${String(file)}`), { code })
      return (fs[name] as (...a: unknown[]) => unknown)(file, ...rest)
    }
  return { ...fs, readFileSync: wrap('readFileSync'), renameSync: wrap('renameSync'), statSync: wrap('statSync'), openSync: wrap('openSync') } as typeof fs
}

/** A v1 journal as the 1fe1fd194 offline host wrote it (`{nextSeq, records, rows, settledCopies}`). */
function v1Journal(records: Array<Record<string, unknown>>, rows: Record<string, unknown> = {}): string {
  return JSON.stringify({ nextSeq: records.length + 1, records: records.map((r, i) => ({ seq: i + 1, at: T0 + i, ...r })), rows, settledCopies: [] })
}

/** A legacy dir with a slice (it names the Walnut) and a v1 journal beside it. */
function legacyDir(records: Array<Record<string, unknown>>, rows?: Record<string, unknown>): { dir: string; file: string } {
  const dir = path.join(journalTmpDir('journal-legacy-'), 'offline-host')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `slice-${keyOf(JHOME)}.json`), JSON.stringify(jslice({ asOf: T0 })))
  const file = path.join(dir, `journal-${keyOf(JHOME)}.json`)
  fs.writeFileSync(file, v1Journal(records, rows))
  return { dir, file }
}

/** One daemon boot over `dir`: a new store and a new migration (as each twin builds them). */
function boot(dir: string, legacyDirs: string[], clock: Clock, over: Parameters<typeof journalStore>[2] = {}) {
  const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = []
  const journal = journalStore(dir, clock, { log: (level, msg, data) => { logs.push({ level, msg, data }) }, ...over })
  const calls = { leaders: 0, slices: 0, rearmed: 0 }
  const migration = createJournalMigration({
    path, journal, dir, legacyDirs,
    importLegacyLeaders: () => { calls.leaders++ },
    slicesMoved: () => { calls.slices++ },
    recordsMigrated: () => { calls.rearmed++ },
    log: (level, msg, data) => { logs.push({ level, msg, data }) },
  })
  migration.boot()
  return { journal, logs, calls }
}

const drainAll = (j: OfflineJournal) => {
  const d = j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS })
  expect(j.ack(JHOME, { seqs: d.records.map((r) => r.seq) }).error).toBeUndefined()
  return d.records
}
const stateFile = (dir: string) => path.join(dir, `journal-${keyOf(JHOME)}.state.json`)

describe('journal boot migration: legacy slices, leader records, the orphan sweep', () => {
  it('copies legacy slices (then the host reads them again), imports leader records, sweeps hour-old orphans', () => {
    const clock = { now: T0 }
    const legacy = journalTmpDir('journal-legacy-')
    fs.writeFileSync(path.join(legacy, `slice-${keyOf(JHOME)}.json`), JSON.stringify(jslice({ asOf: T0 })))
    const dir = path.join(journalTmpDir('journal-mine-'), 'offline-host')
    const orphan = path.join(dir, 'blobs', 'a'.repeat(64))
    fs.mkdirSync(path.dirname(orphan), { recursive: true })
    fs.writeFileSync(orphan, 'left by a crash')
    const old = new Date(Date.now() - 2 * 3600_000)
    fs.utimesSync(orphan, old, old)
    const h = boot(dir, [legacy], clock)
    expect(JSON.parse(fs.readFileSync(path.join(dir, `slice-${keyOf(JHOME)}.json`), 'utf8'))).toMatchObject({ home: JHOME, asOf: T0 })
    expect(h.calls).toEqual({ leaders: 1, slices: 1, rearmed: 0 })
    expect(fs.existsSync(orphan)).toBe(false)
  })

  it('a trigger pause a v1 journal holds is a hold once the migration took it, and the daemon is told to arm again', () => {
    const clock = { now: T0 }
    const pause = { kind: 'op', op: 'trigger_pause', args: { id: 'trg-acme' }, callerSid: SID_A, trigger: { id: 'trg-acme', name: 'Acme watch' } }
    const { dir: legacy } = legacyDir([pause])
    const dir = path.join(journalTmpDir('journal-mine-'), 'offline-host')
    // The daemon arms triggers.json before the migration runs (loadTriggersAtBoot): no hold yet.
    const { host, journal } = journalHost(dir, clock, { drains: null })
    expect([...host.triggerHolds().keys()]).toEqual([])
    let holdsWhenTold: Array<[string, boolean]> = []
    createJournalMigration({
      path, journal, dir, legacyDirs: [legacy], log: () => {},
      recordsMigrated: () => { holdsWhenTold = [...host.triggerHolds()].map(([id, h]) => [id, h.on]) },
    }).boot()
    expect(holdsWhenTold).toEqual([['trg-acme', false]])
    // A boot with nothing to move never re-arms.
    expect(boot(dir, [legacy], clock).calls.rearmed).toBe(0)
  })

  it('the test knob on the production dir is logged as ignored', () => {
    const dir = path.join(journalTmpDir('journal-mine-'), 'offline-host')
    const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = []
    createJournalMigration({
      path, journal: journalStore(dir, { now: T0 }), dir, legacyDirs: [],
      ignoredTestDir: '/tmp/acme-journal', log: (level, msg, data) => { logs.push({ level, msg, data }) },
    }).boot()
    expect(logs).toContainEqual({ level: 'error', msg: expect.stringMatching(/ignored on the production daemon dir/), data: { dir: '/tmp/acme-journal' } })
  })
})

describe('journal boot migration: v1 journals (where 1fe1fd194 wrote them)', () => {
  const mine = () => path.join(journalTmpDir('journal-mine-'), 'offline-host')
  const migratedNames = (d: string) => fs.readdirSync(d).filter((n) => n.includes('.migrated'))

  it('EACCES on a v1 file at boot leaves it as it is (never read as empty); the next clean boot migrates it once', () => {
    const clock = { now: T0 }
    const { dir: legacy, file } = legacyDir([settings('low'), settings('high')])
    const copy = fs.readFileSync(file, 'utf8')
    const dir = mine()
    const denied = faultyFs((call, f) => (call === 'readFileSync' && f === file ? 'EACCES' : null))
    const first = boot(dir, [legacy], clock, { fs: denied })
    expect(first.journal.records(JHOME)).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe(copy)
    expect(migratedNames(legacy)).toEqual([])
    expect(first.logs.some((l) => l.level === 'error' && /unreadable; kept as is/.test(l.msg))).toBe(true)
    const second = boot(dir, [legacy], clock)
    expect(second.journal.records(JHOME).map((r) => r.effort)).toEqual(['low', 'high'])
    expect(fs.existsSync(file)).toBe(false)
    expect(migratedNames(legacy)).toHaveLength(1)
    // A third boot over the same copy restored adds nothing.
    fs.writeFileSync(file, copy)
    expect(boot(dir, [legacy], clock).journal.records(JHOME).map((r) => r.effort)).toEqual(['low', 'high'])
  })

  it('a v1 file met while state.json cannot be read is kept for the next boot', () => {
    const clock = { now: T0 }
    const dir = mine()
    expect(journalStore(dir, clock).append(JHOME, settings('mine')).ok).toBe(true)
    const { dir: legacy, file } = legacyDir([settings('legacy')])
    const blind = faultyFs((call, f) => (call === 'readFileSync' && f === stateFile(dir) ? 'EMFILE' : null))
    const first = boot(dir, [legacy], clock, { fs: blind })
    expect(first.journal.records(JHOME).map((r) => r.effort)).toEqual(['mine'])
    expect(fs.existsSync(file)).toBe(true)
    expect(boot(dir, [legacy], clock).journal.records(JHOME).map((r) => r.effort)).toEqual(['mine', 'legacy'])
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a v2 journal found in a legacy dir is never read and never renamed', () => {
    const clock = { now: T0 }
    const legacy = path.join(journalTmpDir('journal-legacy-'), 'offline-host')
    // A v2 journal there (an isolated daemon of that dir keeps one), and a v1 file of the
    // same Walnut that nothing but that v2 journal names.
    expect(journalStore(legacy, clock).append(JHOME, settings('elsewhere')).ok).toBe(true)
    fs.writeFileSync(path.join(legacy, `journal-${keyOf(JHOME)}.json`), v1Journal([settings('v1')]))
    const names = fs.readdirSync(legacy).sort()
    const touched: string[] = []
    const spy = faultyFs((call, f) => {
      if (f.startsWith(legacy) && /journal-[^/]*\.(ndjson|state\.json)/.test(f)) touched.push(`${call} ${path.basename(f)}`)
      return null
    })
    const h = boot(mine(), [legacy], clock, { fs: spy })
    expect(touched).toEqual([])
    expect(h.journal.records(JHOME)).toEqual([])
    expect(fs.readdirSync(legacy).sort()).toEqual(names)
    expect(h.logs.some((l) => /the Walnut of a v1 journal is unknown/.test(l.msg))).toBe(true)
  })

  const PAUSE = { kind: 'op', op: 'trigger_pause', args: { id: 'trg-acme' }, callerSid: SID_A, trigger: { id: 'trg-acme', name: 'Acme watch' } }
  const holdsOf = (host: ReturnType<typeof journalHost>['host']) => [...host.triggerHolds()].map(([id, h]) => [id, h.on])
  /** A v1 file with nothing beside it that names its Walnut (no slice, no leader record). */
  function nameless(records: Array<Record<string, unknown>>) {
    const legacy = path.join(journalTmpDir('journal-legacy-'), 'offline-host')
    fs.mkdirSync(legacy, { recursive: true })
    const file = path.join(legacy, `journal-${keyOf(JHOME)}.json`)
    fs.writeFileSync(file, v1Journal(records))
    return { legacy, file }
  }

  it('a v1 file of a Walnut nothing names waits; the configure that names it moves it at once and the daemon re-arms', () => {
    const clock = { now: T0 }
    const { legacy, file } = nameless([PAUSE, settings('v1')])
    const dir = mine()
    const told: Array<[string, number]> = []
    const { host, journal } = journalHost(dir, clock, { drains: null, journal: { migrated: (home, n) => { told.push([home, n]) } } })
    createJournalMigration({ path, journal, dir, legacyDirs: [legacy], log: () => {} }).boot()
    expect(journal.records(JHOME)).toEqual([])
    expect(fs.existsSync(file)).toBe(true)
    host.configure(jslice({ asOf: T0 }))
    expect(told).toEqual([[JHOME, 2]])
    expect(journal.records(JHOME).map((r) => r.effort ?? r.op)).toEqual(['trigger_pause', 'v1'])
    expect(fs.existsSync(file)).toBe(false)
    expect(holdsOf(host)).toEqual([['trg-acme', false]])
  })

  it('a write that names that Walnut first moves the waiting v1 file ahead of itself', () => {
    const clock = { now: T0 }
    const { legacy } = nameless([settings('v1-a'), settings('v1-b')])
    const dir = mine()
    const told: Array<[string, number]> = []
    const h = boot(dir, [legacy], clock, { migrated: (home, n) => { told.push([home, n]) } })
    expect(h.journal.append(JHOME, settings('new')).ok).toBe(true)
    expect(drainAll(h.journal).map((r) => r.effort)).toEqual(['v1-a', 'v1-b', 'new'])
    expect(told).toEqual([[JHOME, 2]])
  })

  it('a v1 file left part way at boot and finished by a later write re-arms the trigger holds', () => {
    const clock = { now: T0 }
    const dir = mine()
    expect(journalStore(dir, clock).append(JHOME, settings('mine')).ok).toBe(true)
    const { dir: legacy, file } = legacyDir([PAUSE])
    let blind = true
    const told: Array<[string, number]> = []
    const { host, journal } = journalHost(dir, clock, {
      drains: null,
      journal: {
        fs: faultyFs((call, f) => (blind && call === 'readFileSync' && f === stateFile(dir) ? 'EMFILE' : null)),
        migrated: (home, n) => { told.push([home, n]) },
      },
    })
    createJournalMigration({ path, journal, dir, legacyDirs: [legacy], log: () => {} }).boot()
    expect(fs.existsSync(file)).toBe(true)
    expect(holdsOf(host)).toEqual([])
    blind = false
    clock.now += 2_000
    expect(journal.append(JHOME, settings('later')).ok).toBe(true)
    expect(told).toEqual([[JHOME, 1]])
    expect(fs.existsSync(file)).toBe(false)
    expect(holdsOf(host)).toEqual([['trg-acme', false]])
  })

  it('a fold into a migrated v1 record, drained and acked, never comes back from that v1 file, restored or rewritten', () => {
    const clock = { now: T0 }
    // A v1 record of a kind that folds: the rule holds for any kind a v1 file carries.
    const fields = (value: string) => ({ kind: 'task-fields', op: 'task_update', taskId: TASK_A, fields: { title: { base: 'Leader work', value } } })
    const { dir: legacy, file } = legacyDir([fields('One'), settings('low')])
    const copy = fs.readFileSync(file, 'utf8')
    const dir = mine()
    const h = boot(dir, [legacy], clock)
    const migrated = h.journal.records(JHOME)
    expect(migrated.map((r) => r.opId)).toEqual([expect.stringMatching(/^v1-[0-9a-f]{16}$/), expect.stringMatching(/^v1-[0-9a-f]{16}$/)])
    const fold = h.journal.append(JHOME, fields('Two'))
    expect(fold).toMatchObject({ ok: true, coalesced: true, opId: migrated[0].opId, rev: 2 })
    expect(h.journal.records(JHOME).find((r) => r.kind === 'task-fields')).toMatchObject({ v1Seq: 1, rev: 2 })
    expect(drainAll(h.journal).map((r) => r.kind)).toEqual(['settings', 'task-fields'])
    expect(JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')).importedAcked).toEqual(expect.arrayContaining(migrated.map((r) => r.opId)))
    // The same file restored from a copy: nothing.
    fs.writeFileSync(file, copy)
    expect(boot(dir, [legacy], clock).journal.records(JHOME)).toEqual([])
    // An older instance rewrote it with one record more: only that record.
    fs.writeFileSync(file, v1Journal([fields('One'), settings('low'), settings('later')]))
    expect(boot(dir, [legacy], clock).journal.records(JHOME).map((r) => r.effort ?? r.kind)).toEqual(['later'])
  })
})

describe('a legacy dir or file that is not this user\'s own is never read, imported or renamed', () => {
  const PLANTED_TASK = { kind: 'op', op: 'task_update', args: { id: TASK_A, title: 'planted' }, callerSid: SID_A }
  /** What another user can plant in /tmp/open-walnut: a slice of a far asOf, a v1 task_update, a leader record. */
  function plant(root: string) {
    const off = path.join(root, 'offline-host')
    const lead = path.join(root, 'leader')
    fs.mkdirSync(off, { recursive: true })
    fs.mkdirSync(lead, { recursive: true })
    fs.writeFileSync(path.join(off, `slice-${keyOf(JHOME)}.json`), JSON.stringify(jslice({ asOf: 9e15, host: 'planted' })))
    fs.writeFileSync(path.join(off, `journal-${keyOf(JHOME)}.json`), v1Journal([PLANTED_TASK]))
    fs.writeFileSync(path.join(lead, `leader-${keyOf(JHOME)}.json`), JSON.stringify({ v: 1, home: JHOME, walnutId: 'acme-planted', backup: true, epoch: 9, holder: 'backup', since: 9e15 }))
    return { off, lead }
  }
  /** lstat answers another owner for every path `foreign` names (planted by another user). */
  function foreignFs(foreign: (p: string) => boolean): typeof fs {
    const lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      const st = (fs.lstatSync as (...a: unknown[]) => fs.Stats)(p, ...rest)
      if (!foreign(String(p))) return st
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid + 1 })
    }) as typeof fs.lstatSync
    return { ...fs, lstatSync } as typeof fs
  }
  /** One boot of the home fallback's daemon whose legacy root is `root`, over its own slice and leader record. */
  function bootOver(root: string, over: { fs?: typeof fs } = {}) {
    const clock = { now: T0 }
    const mineRoot = journalTmpDir('journal-mine-')
    const dir = path.join(mineRoot, 'offline-host')
    const leaderDir = path.join(mineRoot, 'leader')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `slice-${keyOf(JHOME)}.json`), JSON.stringify(jslice({ asOf: T0 })))
    const bookOf = () => createLeaderBook({ fs: over.fs ?? fs, path, dir: leaderDir, now: () => clock.now, keyOf, log: () => {}, takeoverMs: 60_000, bootAt: T0, legacyDirs: [path.join(root, 'leader')] })
    bookOf().configure({ home: JHOME, walnutId: 'walnut-marina', backup: true })
    const book = bookOf()
    const logs: string[] = []
    const journal = journalStore(dir, clock, { fs: over.fs ?? fs, log: (_l, msg) => { logs.push(msg) } })
    createJournalMigration({
      path, journal, dir, legacyDirs: [path.join(root, 'offline-host')],
      importLegacyLeaders: () => book.importLegacy(), log: (_l, msg) => { logs.push(msg) },
    }).boot()
    return { journal, book, dir, logs }
  }
  const untouched = (d: string) => expect(fs.readdirSync(d).filter((n) => /\.(migrated|unconverted)/.test(n))).toEqual([])
  const notImported = (h: ReturnType<typeof bootOver>) => {
    expect(h.journal.records(JHOME)).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, `slice-${keyOf(JHOME)}.json`), 'utf8')).asOf).toBe(T0)
    expect(h.book.recordOf(JHOME)).toMatchObject({ walnutId: 'walnut-marina', holder: 'primary', epoch: 1 })
  }

  it('control: the same files in a dir of this user are taken (so the cases below prove a refusal)', () => {
    const root = journalTmpDir('journal-own-')
    const { off } = plant(root)
    const h = bootOver(root)
    expect(h.journal.records(JHOME).map((r) => r.op)).toEqual(['task_update'])
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, `slice-${keyOf(JHOME)}.json`), 'utf8')).asOf).toBe(9e15)
    expect(h.book.recordOf(JHOME)).toMatchObject({ walnutId: 'acme-planted', holder: 'backup' })
    expect(fs.readdirSync(off).filter((n) => n.endsWith('.migrated'))).toHaveLength(1)
  })

  it('a daemon dir that is a symlink to another dir (a planted /tmp/open-walnut)', () => {
    const target = journalTmpDir('journal-foreign-')
    const { off } = plant(target)
    const link = path.join(journalTmpDir('journal-tmp-'), 'open-walnut')
    fs.symlinkSync(target, link)
    const h = bootOver(link)
    notImported(h)
    untouched(off)
    expect(fs.existsSync(path.join(off, `journal-${keyOf(JHOME)}.json`))).toBe(true)
    expect(h.logs.some((m) => /legacy dir is not this user's own/.test(m))).toBe(true)
  })

  it('a daemon dir another user owns', () => {
    const root = journalTmpDir('journal-foreign-')
    const { off } = plant(root)
    const h = bootOver(root, { fs: foreignFs((p) => p === root || p.startsWith(root + '/')) })
    notImported(h)
    untouched(off)
  })

  it('a world writable daemon dir', () => {
    const root = journalTmpDir('journal-shared-')
    const { off } = plant(root)
    fs.chmodSync(root, 0o777)
    const h = bootOver(root)
    notImported(h)
    untouched(off)
  })

  it('files another user planted in a dir of this user (a group member), and a v1 file that is a symlink', () => {
    const root = journalTmpDir('journal-group-')
    const { off } = plant(root)
    const h = bootOver(root, { fs: foreignFs((p) => p.startsWith(root + '/') && /(journal|slice|leader)-[^/]*\.json$/.test(p)) })
    notImported(h)
    untouched(off)
    // A symlinked v1 file: never followed, neither it nor its target renamed.
    const elsewhere = path.join(journalTmpDir('journal-foreign-'), 'planted.json')
    fs.writeFileSync(elsewhere, v1Journal([PLANTED_TASK]))
    const own = journalTmpDir('journal-own-')
    fs.mkdirSync(path.join(own, 'offline-host'))
    fs.symlinkSync(elsewhere, path.join(own, 'offline-host', `journal-${keyOf(JHOME)}.json`))
    const again = bootOver(own)
    expect(again.journal.records(JHOME)).toEqual([])
    untouched(path.join(own, 'offline-host'))
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe(v1Journal([PLANTED_TASK]))
  })
})

describe('state.json: null only when there is none; any other read error refuses the write', () => {
  /** A journal whose state.json holds a request row and an acked migrated record. */
  function seeded() {
    const clock = { now: T0 }
    const dir = path.join(journalTmpDir('journal-mine-'), 'offline-host')
    const { dir: legacy } = legacyDir([settings('low')], { 'req-acme-1': { id: 'req-acme-1', state: 'pending' } })
    drainAll(boot(dir, [legacy], clock).journal)
    const saved = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'))
    expect(saved.importedAcked).toHaveLength(1)
    expect(Object.keys(saved.rows)).toEqual(['req-acme-1'])
    return { clock, dir, saved }
  }

  it('EMFILE on state.json at load, then persist(): the rows and importedAcked on disk are kept (with a row added meanwhile)', () => {
    const { clock, dir, saved } = seeded()
    // The next process meets EMFILE on its first two reads of state.json (the load, and the
    // offline host's read of the rows), then the file reads again.
    let fails = 2
    const flaky = faultyFs((call, f) => (call === 'readFileSync' && f === stateFile(dir) && fails-- > 0 ? 'EMFILE' : null))
    const j = journalStore(dir, clock, { fs: flaky })
    const st = j.state(JHOME)
    expect(st.rows).toEqual({})
    st.rows['req-acme-2'] = { id: 'req-acme-2', state: 'pending' }
    j.persist(JHOME)
    const after = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'))
    expect(Object.keys(after.rows).sort()).toEqual(['req-acme-1', 'req-acme-2'])
    expect(after.importedAcked).toEqual(saved.importedAcked)
    expect(after.migratedV1).toEqual(saved.migratedV1)
    expect(after.journalId).toBe(saved.journalId)
  })

  it('a state.json that cannot be read refuses every write with journal_unwritable and is never replaced; readable again, the writes go on', () => {
    const { clock, dir, saved } = seeded()
    let broken = true
    const denied = faultyFs((call, f) => (broken && call === 'readFileSync' && f === stateFile(dir) ? 'EACCES' : null))
    const j = journalStore(dir, clock, { fs: denied })
    const bytes = fs.readFileSync(stateFile(dir))
    expect(j.append(JHOME, settings('high'))).toMatchObject({ ok: false, code: 'journal_unwritable', why: 'state_unreadable' })
    j.persist(JHOME)
    expect(j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS })).toMatchObject({ records: [], why: 'state_unreadable' })
    expect(fs.readFileSync(stateFile(dir))).toEqual(bytes)
    broken = false
    expect(j.append(JHOME, settings('high')).ok).toBe(true)
    j.persist(JHOME)
    const after = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'))
    expect(after.rows).toEqual(saved.rows)
    expect(after.importedAcked).toEqual(saved.importedAcked)
  })

  it('a state.json that is not a v2 state (torn by hand, a newer format) is a refusal, never overwritten', () => {
    const { clock, dir } = seeded()
    fs.writeFileSync(stateFile(dir), '{"v":3,"rows"')
    const j = journalStore(dir, clock)
    expect(j.append(JHOME, settings('high'))).toMatchObject({ ok: false, code: 'journal_unwritable' })
    expect(fs.readFileSync(stateFile(dir), 'utf8')).toBe('{"v":3,"rows"')
  })

  it('no state.json at all (ENOENT) is a fresh journal', () => {
    const dir = path.join(journalTmpDir('journal-mine-'), 'offline-host')
    const j = journalStore(dir, { now: T0 })
    expect(j.append(JHOME, settings('low'))).toMatchObject({ ok: true, seq: 1 })
    j.persist(JHOME)
    expect(JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'))).toMatchObject({ v: 2, home: JHOME, nextSeq: 2 })
  })
})

describe('the offline host adopts a journal another process wrote after it was built', () => {
  it('configure() reads the journal from disk, and a drain hands its records out', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const { host, journal } = journalHost(dir, clock)
    expect(journal.homes()).toEqual([])
    // Another process (an older daemon, a migration) writes the journal now.
    const writer = journalStore(dir, clock)
    for (const e of ['low', 'high']) writer.append(JHOME, settings(e))
    host.configure(jslice())
    expect(journal.homes()).toEqual([JHOME])
    expect(host.drain(JHOME, JOURNAL_V2_DRAINS).records.map((r) => (r as unknown as { effort: string }).effort)).toEqual(['low', 'high'])
    expect(host.journalStats(JHOME)).toMatchObject({ records: 2 })
  })

  it('reloadSlices takes a slice copied to disk unless the host already holds a newer one', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const { host } = journalHost(dir, clock)
    expect(host.hasHome(JHOME)).toBe(false)
    fs.writeFileSync(path.join(dir, `slice-${keyOf(JHOME)}.json`), JSON.stringify(jslice({ asOf: T0, hash: 'copied' })))
    host.reloadSlices()
    expect(host.hasHome(JHOME)).toBe(true)
    host.configure(jslice({ asOf: T0 + 10, hash: 'from-the-mac' }))
    fs.writeFileSync(path.join(dir, `slice-${keyOf(JHOME)}.json`), JSON.stringify(jslice({ asOf: T0, hash: 'older' })))
    host.reloadSlices()
    expect(host.configure(jslice({ asOf: T0 + 10, hash: 'from-the-mac' }))).toEqual({ changed: false })
  })
})

const twinText = (file: string) => fs.readFileSync(path.join(ROOT, 'src/providers', file), 'utf8')
const ruleBlock = (file: string, from: RegExp, to: RegExp) => {
  const text = twinText(file)
  const start = text.search(from)
  const end = text.slice(start).search(to)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(0)
  return text.slice(start, start + end)
}
const RULE = {
  standalone: ruleBlock('daemon-standalone.ts', /const JOURNAL_PROD_STATE_DIR =/, /\/\*\* Whether daemon\.pid names this process/),
  source: ruleBlock('daemon-source.ts', /var JOURNAL_PROD_STATE_DIR =/, /\/\/ Whether daemon\.pid names this process/),
}
interface Rule { JOURNAL_ROOT: string; OFFLINE_HOST_DIR: string; LEADER_BOOK_DIR: string; LEGACY_JOURNAL_DIRS: string[]; LEGACY_LEADER_DIRS: string[] }
interface RuleEnv { daemonDir: string; service: boolean; prod: boolean; stateDir?: string; knob?: string; home?: string; prodDir?: string }
const PROD = '/tmp/open-walnut'
/** A twin's rule block run with this mode (no fs access: the block only joins paths). */
const runRule = (text: string, env: RuleEnv): Rule => new Function(
  'path', 'HOME_DIR', 'DAEMON_DIR', 'DAEMON_STATE_DIR', 'SERVICE_MODE', 'IS_PROD_DAEMON_DIR', 'PROD_DAEMON_DIR', 'FALLBACK_DAEMON_DIR', 'process',
  `${text}\nreturn { JOURNAL_ROOT, OFFLINE_HOST_DIR, LEADER_BOOK_DIR, LEGACY_JOURNAL_DIRS, LEGACY_LEADER_DIRS }`,
)(path, env.home ?? '/home/marina', env.daemonDir, env.stateDir, env.service, env.prod, env.prodDir ?? PROD,
  path.join(env.home ?? '/home/marina', '.cache', 'open-walnut'),
  { platform: 'linux', env: env.knob ? { WALNUT_JOURNAL_DIR: env.knob } : {} }) as Rule

describe('ONE journal root per host in every mode, the same in both twins (evaluated from their own text)', () => {
  const MINE = '/home/marina/.open-walnut/tmp'
  const STATE = '/home/marina/.local/share/open-walnut/daemon'
  const FALLBACK = '/home/marina/.cache/open-walnut'
  const cases = [
    { name: 'a plain test daemon', env: { daemonDir: '/tmp/acme-run', service: false, prod: false }, root: '/tmp/acme-run', legacy: [] },
    { name: 'an isolated daemon that inherited the service state dir', env: { daemonDir: '/tmp/acme-run', stateDir: STATE, service: false, prod: false }, root: '/tmp/acme-run', legacy: [] },
    { name: 'the test knob', env: { daemonDir: '/tmp/acme-run', service: false, prod: false, knob: '/tmp/acme-j' }, root: '/tmp/acme-j', legacy: ['/tmp/acme-run'] },
    { name: 'the test knob on a service daemon of a test dir (never the prod dir)', env: { daemonDir: '/tmp/acme-run', stateDir: STATE, service: true, prod: false, knob: '/tmp/acme-j' }, root: '/tmp/acme-j', legacy: ['/tmp/acme-run'] },
    // The prod dir's daemon also reads the home fallback a v1 daemon used while the server picked it.
    { name: 'the service daemon (its runtime dir is the prod dir)', env: { daemonDir: PROD, stateDir: STATE, service: true, prod: true }, root: MINE, legacy: [PROD, FALLBACK] },
    // Only tests run --service on a dir other than the prod dir (the real service always
    // runs on /tmp/open-walnut): such a daemon is isolated and never reads the prod journal.
    { name: 'a service daemon on another runtime dir', env: { daemonDir: '/home/marina/acme-run', stateDir: STATE, service: true, prod: false }, root: '/home/marina/acme-run', legacy: [] },
    { name: 'the plain daemon on the prod dir', env: { daemonDir: PROD, service: false, prod: true }, root: MINE, legacy: [PROD, FALLBACK] },
    { name: 'the prod dir ignores the test knob', env: { daemonDir: PROD, stateDir: STATE, service: false, prod: true, knob: '/tmp/acme-j' }, root: MINE, legacy: [PROD, FALLBACK] },
    // The server picks the fallback when /tmp/open-walnut is another user's or a symlink: never read.
    { name: 'the home fallback daemon dir', env: { daemonDir: FALLBACK, service: false, prod: true }, root: MINE, legacy: [FALLBACK] },
    { name: 'the home fallback daemon dir in service mode', env: { daemonDir: FALLBACK, stateDir: STATE, service: true, prod: true }, root: MINE, legacy: [FALLBACK] },
  ]
  it.each(cases)('$name', ({ env, root, legacy }) => {
    const a = runRule(RULE.standalone, env)
    expect(runRule(RULE.source, env)).toEqual(a)
    expect(a.JOURNAL_ROOT).toBe(root)
    expect(a.OFFLINE_HOST_DIR).toBe(path.join(root, 'offline-host'))
    expect(a.LEADER_BOOK_DIR).toBe(path.join(root, 'leader'))
    expect(a.LEGACY_JOURNAL_DIRS).toEqual(legacy.map((d) => path.join(d, 'offline-host')))
    expect(a.LEGACY_LEADER_DIRS).toEqual(legacy.map((d) => path.join(d, 'leader')))
  })

  it('no daemon off the prod dir (service mode or not, with or without the knob or a state dir) ever lists /tmp/open-walnut or ~/.open-walnut', () => {
    const dirs = ['/tmp/acme-run', '/home/marina/acme-run', '/tmp/open-walnut-acme', '/tmp/open-walnut/acme', '/var/folders/x/T/marina-runtime']
    let checked = 0
    for (const daemonDir of dirs) for (const service of [false, true]) for (const stateDir of [undefined, STATE])
      for (const knob of [undefined, '/tmp/acme-j']) for (const text of [RULE.standalone, RULE.source]) {
        const r = runRule(text, { daemonDir, service, prod: false, stateDir, knob })
        const all = [r.JOURNAL_ROOT, r.OFFLINE_HOST_DIR, r.LEADER_BOOK_DIR, ...r.LEGACY_JOURNAL_DIRS, ...r.LEGACY_LEADER_DIRS]
        for (const d of all) {
          // Every dir is the daemon's own dir or the knob's, never the prod dir's own files.
          expect([daemonDir, knob].some((own) => own && (d === own || d.startsWith(own + '/')))).toBe(true)
          expect([path.join(PROD, 'offline-host'), path.join(PROD, 'leader')]).not.toContain(d)
          expect(d.startsWith(MINE)).toBe(false)
        }
        expect(r.JOURNAL_ROOT).toBe(knob ?? daemonDir)
        checked++
      }
    expect(checked).toBe(80)
  })

  it('the home fallback daemon never lists /tmp/open-walnut (another user\'s or a symlink when the server picks the fallback)', () => {
    let checked = 0
    for (const home of ['/home/marina', '/Users/acme', '/var/lib/acme-home']) for (const service of [false, true])
      for (const stateDir of [undefined, STATE]) for (const knob of [undefined, '/tmp/acme-j']) for (const text of [RULE.standalone, RULE.source]) {
        const fallback = path.join(home, '.cache', 'open-walnut')
        const r = runRule(text, { daemonDir: fallback, service, prod: true, stateDir, knob, home })
        for (const d of [...r.LEGACY_JOURNAL_DIRS, ...r.LEGACY_LEADER_DIRS]) {
          expect(d === PROD || d.startsWith(PROD + '/')).toBe(false)
          expect(d.startsWith(fallback + '/')).toBe(true)
        }
        expect(r.LEGACY_JOURNAL_DIRS).toEqual([path.join(fallback, 'offline-host')])
        // The prod dir's daemon of that HOME reads that HOME's fallback, never another HOME's.
        const onProd = runRule(text, { daemonDir: PROD, service, prod: true, stateDir, knob, home })
        expect(onProd.LEGACY_JOURNAL_DIRS).toEqual([path.join(PROD, 'offline-host'), path.join(fallback, 'offline-host')])
        expect(onProd.LEGACY_LEADER_DIRS).toEqual([path.join(PROD, 'leader'), path.join(fallback, 'leader')])
        checked++
      }
    expect(checked).toBe(48)
  })

  it('neither rule reads the service state dir: the mode never moves the journal', () => {
    for (const text of [RULE.standalone, RULE.source]) expect(text).not.toMatch(/DAEMON_STATE_DIR|STATE_CANDIDATES|SERVICE_STATE_DIR/)
  })

  /** A temp host: HOME, the prod dir (both modes' runtime dir), and a service state dir of its own. */
  function host(text: string) {
    const home = journalTmpDir('journal-home-')
    const prodDir = journalTmpDir('journal-prod-')
    const stateDir = path.join(home, 'acme-state')
    return {
      home, prodDir,
      service: runRule(text, { daemonDir: prodDir, stateDir, service: true, prod: true, home, prodDir }),
      plain: runRule(text, { daemonDir: prodDir, service: false, prod: true, home, prodDir }),
    }
  }

  for (const twin of ['standalone', 'source'] as const) {
    it(`${twin} twin: service-mode and plain-mode daemons on the same HOME write and drain the same journal file`, () => {
      const h = host(RULE[twin])
      const clock = { now: T0 }
      expect(h.service.OFFLINE_HOST_DIR).toBe(path.join(h.home, '.open-walnut', 'tmp', 'offline-host'))
      expect(h.plain.OFFLINE_HOST_DIR).toBe(h.service.OFFLINE_HOST_DIR)
      expect(h.plain.LEADER_BOOK_DIR).toBe(h.service.LEADER_BOOK_DIR)
      const svc = journalStore(h.service.OFFLINE_HOST_DIR, clock)
      const plain = journalStore(h.plain.OFFLINE_HOST_DIR, clock)
      expect(svc.append(JHOME, settings('from-the-service'))).toMatchObject({ ok: true, seq: 1 })
      expect(plain.append(JHOME, settings('from-the-plain-daemon'))).toMatchObject({ ok: true, seq: 2 })
      expect(svc.append(JHOME, settings('service-again'))).toMatchObject({ ok: true, seq: 3 })
      expect(fs.readdirSync(h.service.OFFLINE_HOST_DIR).filter((n) => n.endsWith('.ndjson'))).toEqual([`journal-${keyOf(JHOME)}.ndjson`])
      expect(drainAll(plain).map((r) => r.effort)).toEqual(['from-the-service', 'from-the-plain-daemon', 'service-again'])
      svc.refresh(JHOME)
      expect(svc.records(JHOME)).toEqual([])
    })

    it(`${twin} twin: the prod dir's daemon moves the v1 records a home fallback daemon left, with the prod dir's, oldest first`, () => {
      const h = host(RULE[twin])
      const clock = { now: T0 }
      // /tmp was full: a 1fe1fd194 daemon ran from ~/.cache/open-walnut and journaled there.
      const fallbackV1 = path.join(h.home, '.cache', 'open-walnut', 'offline-host')
      fs.mkdirSync(fallbackV1, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(fallbackV1, `slice-${keyOf(JHOME)}.json`), JSON.stringify(jslice({ asOf: T0 })))
      fs.writeFileSync(path.join(fallbackV1, `journal-${keyOf(JHOME)}.json`), v1Journal([settings('while-tmp-was-full')]))
      // After a reboot the server picked /tmp/open-walnut again, and a v1 daemon journaled there later.
      const prodV1 = path.join(h.prodDir, 'offline-host')
      fs.mkdirSync(prodV1, { recursive: true })
      fs.writeFileSync(path.join(prodV1, `journal-${keyOf(JHOME)}.json`), JSON.stringify({ nextSeq: 2, records: [{ seq: 1, at: T0 + 60_000, ...settings('after-reboot') }], rows: {}, settledCopies: [] }))
      expect(h.plain.LEGACY_JOURNAL_DIRS).toEqual([prodV1, fallbackV1])
      const journal = journalStore(h.plain.OFFLINE_HOST_DIR, clock)
      createJournalMigration({ path, journal, dir: h.plain.OFFLINE_HOST_DIR, legacyDirs: h.plain.LEGACY_JOURNAL_DIRS, log: () => {} }).boot()
      expect(drainAll(journal).map((r) => r.effort)).toEqual(['while-tmp-was-full', 'after-reboot'])
      for (const d of [fallbackV1, prodV1]) expect(fs.readdirSync(d).filter((n) => n.endsWith('.migrated'))).toHaveLength(1)
    })

    for (const order of [['service', 'plain'], ['plain', 'service']] as const) {
      it(`${twin} twin: a ${order[0]} daemon followed by a ${order[1]} daemon loses and reorders nothing (v1 records first)`, () => {
        const h = host(RULE[twin])
        const clock = { now: T0 }
        // What a 1fe1fd194 daemon left in the prod dir, the runtime dir of both modes.
        const v1 = path.join(h.prodDir, 'offline-host')
        fs.mkdirSync(v1, { recursive: true })
        fs.writeFileSync(path.join(v1, `slice-${keyOf(JHOME)}.json`), JSON.stringify(jslice({ asOf: T0 })))
        fs.writeFileSync(path.join(v1, `journal-${keyOf(JHOME)}.json`), v1Journal([settings('v1-a'), settings('v1-b')]))
        const bootAs = (mode: 'service' | 'plain') => {
          const r = h[mode]
          const journal = journalStore(r.OFFLINE_HOST_DIR, clock)
          createJournalMigration({ path, journal, dir: r.OFFLINE_HOST_DIR, legacyDirs: r.LEGACY_JOURNAL_DIRS, log: () => {} }).boot()
          return journal
        }
        const first = bootAs(order[0])
        for (const e of ['first-1', 'first-2']) expect(first.append(JHOME, settings(e)).ok).toBe(true)
        first.close()
        const second = bootAs(order[1])
        expect(second.append(JHOME, settings('second-1')).ok).toBe(true)
        expect(drainAll(second).map((r) => r.effort)).toEqual(['v1-a', 'v1-b', 'first-1', 'first-2', 'second-1'])
        // The first mode boots again: nothing comes back.
        expect(bootAs(order[0]).records(JHOME)).toEqual([])
      })
    }
  }
})

describe('both twins wire the migration the same way', () => {
  it('build it from that rule, run it after daemon.pid names them, and serve the gateway only after it', () => {
    for (const file of ['daemon-standalone.ts', 'daemon-source.ts']) {
      const text = twinText(file)
      expect(text, file).toMatch(/legacyDirs: LEGACY_JOURNAL_DIRS,/)
      expect(text, file).toMatch(/legacyDirs: LEGACY_LEADER_DIRS,/)
      expect(text, file).toMatch(/importLegacyLeaders: (\(\) => |function \(\) \{ )leaderBook\.importLegacy\(\)/)
      expect(text, file).toMatch(/slicesMoved: (\(\) => |function \(\) \{ )offlineHost\.reloadSlices\(\)/)
      // The trigger holds are armed again after the boot migration, and after a late one
      // (a v1 file left part way, or of a Walnut unknown at boot), outside the write that finished it.
      expect(text, file).toMatch(/recordsMigrated: (\(\) => |function \(\) \{ )triggerHoldsChanged\(\)/)
      expect(text, file).toMatch(/migrated: (\(\) => \{ setTimeout\(\(\) => |function \(\) \{ setTimeout\(function \(\) \{ )triggerHoldsChanged\(\)/)
      // Nothing moves v2 records between dirs: no state dir candidates, no conflict view.
      expect(text, file).not.toMatch(/stateDirs:|JOURNAL_STATE_CANDIDATES|conflictOf\(|journalMigration\.afterAck/)
      // The offline host's minute sweep starts inside migrateJournals() only: a long CLI run
      // (walnut wait, up to a day) never reads or writes the daemon's journals.
      const fnAt = text.indexOf('function migrateJournals(')
      const fnEnd = text.indexOf('\n}\n', fnAt)
      const sweeps = [...text.matchAll(/offlineHost\.sweep\(\)/g)].map((m) => m.index ?? 0)
      expect(sweeps.length, file).toBe(1)
      expect(sweeps[0] > fnAt && sweeps[0] < fnEnd, `${file}: the sweep starts in migrateJournals()`).toBe(true)
      // Nothing at module load copies, imports or sweeps (the binary also runs as the walnut CLI).
      expect(text, file).not.toMatch(/^(const|var) [^\n]*\.(migrateSlices|sweepBlobs|importLegacy)\(/m)
      expect(text, file).not.toMatch(/^offlineJournal\.(migrateSlices|sweepBlobs)\(/m)
      const pid = text.indexOf('fs.writeFileSync(PID_FILE, String(process.pid))')
      const migrate = text.indexOf('migrateJournals()', pid)
      expect(pid, file).toBeGreaterThan(0)
      expect(migrate, file).toBeGreaterThan(pid)
      // The gateway listener of the --start path starts after the migration (no write ahead of the v1 records).
      const gatewayStarts = [...text.matchAll(/^\s*startGatewayListener\(\)/gm)].map((m) => m.index ?? 0)
      expect(gatewayStarts.length, file).toBeGreaterThan(0)
      for (const at of gatewayStarts) expect(at, `${file}: the gateway starts after the migration`).toBeGreaterThan(migrate)
    }
  })

  it('the source twin inlines createJournalMigration once, and the generated text passes its build-time smoke', async () => {
    const { getDaemonSource } = await import('../../src/providers/daemon-source.js')
    const src = getDaemonSource()
    expect(src).not.toContain('__CREATE_JOURNAL_MIGRATION__')
    expect(src.split('function createJournalMigration(').length - 1).toBe(1)
  })

  it('the leader book imports a v1 record from the legacy dirs; one it cannot read is left for the next boot', () => {
    const clock = { now: T0 }
    const legacy = path.join(journalTmpDir('journal-prod-'), 'leader')
    const dir = path.join(journalTmpDir('journal-mine-'), 'leader')
    fs.mkdirSync(legacy, { recursive: true })
    const file = path.join(legacy, `leader-${keyOf(JHOME)}.json`)
    const rec = JSON.stringify({ v: 1, home: JHOME, walnutId: 'walnut-marina', backup: true, epoch: 4, holder: 'primary', since: T0 })
    fs.writeFileSync(file, rec)
    let broken = true
    const book = () => createLeaderBook({
      fs: faultyFs((call, f) => (broken && call === 'readFileSync' && f === file ? 'EACCES' : null)),
      path, dir, now: () => clock.now, keyOf, log: () => {}, takeoverMs: 60_000, bootAt: clock.now, legacyDirs: [legacy],
    })
    const first = book()
    first.importLegacy()
    expect(first.recordOf(JHOME)).toBeNull()
    expect(fs.readFileSync(file, 'utf8')).toBe(rec)
    broken = false
    const second = book()
    second.importLegacy()
    expect(second.recordOf(JHOME)).toMatchObject({ walnutId: 'walnut-marina', epoch: 4 })
    expect(fs.readFileSync(file, 'utf8')).toBe(rec)
  })
})
