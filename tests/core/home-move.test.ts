/**
 * A Walnut's data dir moved: declared by its server, never guessed (src/core/home-move.ts).
 * The rule (judgeHome) and the record it keeps (noteHome), on real files. With no leader switch
 * the rule is pinned to the one before switches existed (a verbatim copy below); a committed
 * switch declares the previous holder's data dir (src/core/leader/switch/moved-home.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FORMER_HOMES_MAX, homeRecordFile, judgeHome, noteHome, type HomeRecord, type SwitchedFrom } from '../../src/core/home-move.js'

const M = 'f'.repeat(32)
const W = 'a'.repeat(32)

describe('judgeHome: what a start says', () => {
  const none = () => null
  it('no record: here is where the Walnut is, nothing moved', () => {
    expect(judgeHome(null, { machineId: M, home: '/h', walnutId: W }, none)).toEqual({ record: { machineId: M, home: '/h' }, formerHomes: [] })
  })
  it('another machine wrote the record (a copy or a restore there): nothing is declared', () => {
    expect(judgeHome({ machineId: 'e'.repeat(32), home: '/old' }, { machineId: M, home: '/h', walnutId: W }, none))
      .toEqual({ record: { machineId: M, home: '/h' }, formerHomes: [] })
  })
  it('same machine, same path: what it declared before still holds (a record with movedFrom alone too)', () => {
    expect(judgeHome({ machineId: M, home: '/h', movedFrom: '/old' }, { machineId: M, home: '/h', walnutId: W }, none))
      .toEqual({ record: { machineId: M, home: '/h', movedFrom: '/old' }, formerHomes: ['/old'] })
  })
  it('same machine, another path, the old one gone or holding another Walnut: a move from it', () => {
    expect(judgeHome({ machineId: M, home: '/old' }, { machineId: M, home: '/h', walnutId: W }, none))
      .toEqual({ record: { machineId: M, home: '/h', movedFrom: '/old', formerHomes: ['/old'] }, formerHomes: ['/old'] })
    expect(judgeHome({ machineId: M, home: '/old', movedFrom: '/older' }, { machineId: M, home: '/h', walnutId: W }, () => 'b'.repeat(32)).formerHomes[0]).toBe('/old')
  })
  it('a second move keeps every former home, newest first, capped (M2: a host that missed the first follows)', () => {
    const second = judgeHome({ machineId: M, home: '/a1', movedFrom: '/a', formerHomes: ['/a'] }, { machineId: M, home: '/a2', walnutId: W }, none)
    expect(second).toEqual({ record: { machineId: M, home: '/a2', movedFrom: '/a1', formerHomes: ['/a1', '/a'] }, formerHomes: ['/a1', '/a'] })
    // A move back drops the home it returns to from the list.
    expect(judgeHome(second.record, { machineId: M, home: '/a', walnutId: W }, none).formerHomes).toEqual(['/a2', '/a1'])
    const many = Array.from({ length: 20 }, (_, i) => `/h${i}`)
    expect(judgeHome({ machineId: M, home: '/x', formerHomes: many }, { machineId: M, home: '/y', walnutId: W }, none).formerHomes).toHaveLength(FORMER_HOMES_MAX)
  })
  it('same machine, another path, the old one still holds this Walnut: a copy, never a move', () => {
    expect(judgeHome({ machineId: M, home: '/real', movedFrom: '/x' }, { machineId: M, home: '/copy', walnutId: W }, () => W))
      .toEqual({ record: { machineId: M, home: '/copy' }, formerHomes: [] })
  })
  it('the same folder under another spelling is never a copy: a move from the other spelling (L1)', () => {
    expect(judgeHome({ machineId: M, home: '/local/home/u/w', movedFrom: '/old' }, { machineId: M, home: '/home/u/w', walnutId: W }, () => W, () => true))
      .toEqual({ record: { machineId: M, home: '/home/u/w', movedFrom: '/local/home/u/w', formerHomes: ['/local/home/u/w', '/old'] }, formerHomes: ['/local/home/u/w', '/old'] })
  })
  it('without an id of its own a start declares nothing (and keeps the record of its own folder)', () => {
    expect(judgeHome({ machineId: M, home: '/old' }, { machineId: M, home: '/h', walnutId: null }, none).formerHomes).toEqual([])
    expect(judgeHome({ machineId: M, home: '/s', movedFrom: '/o' }, { machineId: M, home: '/h', walnutId: null }, none, () => true).record).toEqual({ machineId: M, home: '/s', movedFrom: '/o' })
  })
})

/** judgeHome as it was before leader switches (verbatim): the rule with no switch must stay this, byte for byte. */
function judgeHomeBeforeSwitches(
  prev: HomeRecord | null,
  now: { machineId: string; home: string; walnutId: string | null },
  heldBy: (home: string) => string | null,
  sameFolder: (home: string) => boolean = () => false,
): { record: HomeRecord; formerHomes: string[] } {
  const formerHomesOf = (r: HomeRecord): string[] => r.formerHomes && r.formerHomes.length > 0 ? r.formerHomes : r.movedFrom ? [r.movedFrom] : []
  const fresh: HomeRecord = { machineId: now.machineId, home: now.home }
  if (!prev || prev.machineId !== now.machineId) return { record: fresh, formerHomes: [] }
  if (prev.home === now.home) return { record: prev, formerHomes: formerHomesOf(prev) }
  const same = sameFolder(prev.home)
  if (!now.walnutId) return { record: same ? prev : fresh, formerHomes: [] }
  if (!same && heldBy(prev.home) === now.walnutId) return { record: fresh, formerHomes: [] }
  const formers = [prev.home, ...formerHomesOf(prev)]
    .filter((h, i, all) => h !== now.home && all.indexOf(h) === i)
    .slice(0, FORMER_HOMES_MAX)
  return { record: { ...fresh, movedFrom: formers[0], formerHomes: formers }, formerHomes: formers }
}

describe('judgeHome with no leader switch: unchanged, byte for byte', () => {
  it('every combination of record, start, old-path holder and folder judges as before (with and without the switch argument)', () => {
    const OTHER = 'e'.repeat(32)
    const prevs: Array<HomeRecord | null> = [null]
    for (const machineId of [M, OTHER]) {
      for (const home of ['/h', '/old', '/h/', '/a1']) {
        prevs.push({ machineId, home })
        prevs.push({ machineId, home, movedFrom: '/older' })
        prevs.push({ machineId, home, movedFrom: '/h', formerHomes: ['/h', '/a', '/older'] })
        prevs.push({ machineId, home, formerHomes: Array.from({ length: 12 }, (_, i) => `/f${i}`) })
      }
    }
    let n = 0
    for (const prev of prevs) {
      for (const home of ['/h', '/old', '/a']) {
        for (const walnutId of [W, null]) {
          for (const held of [null, W, 'b'.repeat(32)]) {
            for (const folder of [false, true]) {
              const now = { machineId: M, home, walnutId }
              const want = JSON.stringify(judgeHomeBeforeSwitches(prev, now, () => held, () => folder))
              expect(JSON.stringify(judgeHome(prev, now, () => held, () => folder))).toBe(want)
              expect(JSON.stringify(judgeHome(prev, now, () => held, () => folder, null))).toBe(want)
              n++
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(1000)
  })
})

describe('judgeHome after a committed leader switch to this data dir', () => {
  const none = () => null
  const B = 'b'.repeat(32)
  // The previous holder's server spelled its path with a trailing slash: declared as it is, never normalised.
  const sw: SwitchedFrom = { switchId: 's1', home: '/Users/u/.open-walnut/', formerHomes: ['/Users/u/old-walnut'] }

  it('the first start on the new machine (no record: home.json never travels) declares the old holder\'s path first, raw', () => {
    expect(judgeHome(null, { machineId: B, home: '/home/u/.open-walnut', walnutId: W }, none, () => false, sw)).toEqual({
      record: { machineId: B, home: '/home/u/.open-walnut', movedFrom: '/Users/u/.open-walnut/', formerHomes: ['/Users/u/.open-walnut/', '/Users/u/old-walnut'], switchId: 's1' },
      formerHomes: ['/Users/u/.open-walnut/', '/Users/u/old-walnut'],
    })
  })
  it('a record another machine wrote (a copy that carried it) does not hide the switch', () => {
    expect(judgeHome({ machineId: M, home: '/Users/u/.open-walnut/' }, { machineId: B, home: '/h', walnutId: W }, () => W, () => false, sw).formerHomes)
      .toEqual(['/Users/u/.open-walnut/', '/Users/u/old-walnut'])
  })
  it('a record a start of this machine wrote at this path before (no switch in it) comes after the switch', () => {
    const r = judgeHome({ machineId: B, home: '/h', movedFrom: '/b-old' }, { machineId: B, home: '/h', walnutId: W }, none, () => false, sw)
    expect(r.formerHomes).toEqual(['/Users/u/.open-walnut/', '/Users/u/old-walnut', '/b-old'])
    expect(r.record.switchId).toBe('s1')
  })
  it('a restart after it took the switch in: the record goes on as it is', () => {
    const first = judgeHome(null, { machineId: B, home: '/h', walnutId: W }, none, () => false, sw)
    expect(judgeHome(first.record, { machineId: B, home: '/h', walnutId: W }, none, () => false, sw)).toEqual(first)
  })
  it('a move on this machine after the switch: the newest home first, the switch kept, a restart there goes on', () => {
    const first = judgeHome(null, { machineId: B, home: '/h', walnutId: W }, none, () => false, sw)
    const moved = judgeHome(first.record, { machineId: B, home: '/h2', walnutId: W }, none, () => false, sw)
    expect(moved.formerHomes).toEqual(['/h', '/Users/u/.open-walnut/', '/Users/u/old-walnut'])
    expect(moved.record.switchId).toBe('s1')
    expect(judgeHome(moved.record, { machineId: B, home: '/h2', walnutId: W }, none, () => false, sw)).toEqual(moved)
  })
  it('the same path on both machines: the hosts know the Walnut by it already, nothing to declare', () => {
    expect(judgeHome(null, { machineId: B, home: '/Users/u/.open-walnut/', walnutId: W }, none, () => false, { switchId: 's1', home: '/Users/u/.open-walnut/' }))
      .toEqual({ record: { machineId: B, home: '/Users/u/.open-walnut/', switchId: 's1' }, formerHomes: [] })
  })
  it('the switch back declares the other machine\'s path and drops its own from the list', () => {
    const back = judgeHome(null, { machineId: M, home: '/Users/u/.open-walnut/', walnutId: W }, none, () => false,
      { switchId: 's2', home: '/home/u/.open-walnut', formerHomes: ['/Users/u/.open-walnut/', '/Users/u/old-walnut'] })
    expect(back.formerHomes).toEqual(['/home/u/.open-walnut', '/Users/u/old-walnut'])
  })
  it('without an id of its own nothing is declared, switch or not', () => {
    expect(judgeHome(null, { machineId: B, home: '/h', walnutId: null }, none, () => false, sw)).toEqual({ record: { machineId: B, home: '/h' }, formerHomes: [] })
  })
  it('a new switch replaces one taken in before (there and back and there again)', () => {
    const first = judgeHome(null, { machineId: B, home: '/h', walnutId: W }, none, () => false, sw)
    const again = judgeHome(first.record, { machineId: B, home: '/h', walnutId: W }, none, () => false, { switchId: 's3', home: '/a' })
    expect(again.formerHomes[0]).toBe('/a')
    expect(again.record.switchId).toBe('s3')
  })
})

describe('noteHome: the record on disk', () => {
  let base: string
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-home-move-')) })
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })
  const dataDir = (name: string, id?: string) => {
    const d = path.join(base, name)
    fs.mkdirSync(d, { recursive: true })
    if (id) fs.writeFileSync(path.join(d, 'auth.json'), JSON.stringify({ instanceId: id, devices: [] }))
    return d
  }

  it('a move, kept at the next start; a copy of the moved dir beside it declares nothing', async () => {
    const before = path.join(base, 'before')
    const now = dataDir('now', W)
    expect(await noteHome(now, M, null)).toEqual([])
    fs.writeFileSync(homeRecordFile(now), JSON.stringify({ machineId: M, home: before }))
    expect(await noteHome(now, M, W)).toEqual([before])
    expect(JSON.parse(fs.readFileSync(homeRecordFile(now), 'utf8'))).toEqual({ machineId: M, home: now, movedFrom: before, formerHomes: [before] })
    // The next start at the same place still declares it (a host that was away hears it too).
    expect(await noteHome(now, M, W)).toEqual([before])
    // A copy of `now` (its record copied too) while `now` still holds the Walnut: no move.
    const copy = dataDir('copy', W)
    fs.mkdirSync(path.dirname(homeRecordFile(copy)), { recursive: true })
    fs.copyFileSync(homeRecordFile(now), homeRecordFile(copy))
    expect(await noteHome(copy, M, W)).toEqual([])
    expect(JSON.parse(fs.readFileSync(homeRecordFile(copy), 'utf8'))).toEqual({ machineId: M, home: copy })
  })

  it('the old dir whose auth.json is mid-rewrite still names its Walnut through the .bak: a copy, not a move (L4)', async () => {
    const real = dataDir('real')
    fs.writeFileSync(path.join(real, 'auth.json'), '{ half a write')
    fs.writeFileSync(path.join(real, 'auth.json.bak'), JSON.stringify({ instanceId: W, devices: [] }))
    const copy = dataDir('copy', W)
    fs.mkdirSync(path.dirname(homeRecordFile(copy)), { recursive: true })
    fs.writeFileSync(homeRecordFile(copy), JSON.stringify({ machineId: M, home: real }))
    expect(await noteHome(copy, M, W)).toEqual([])
  })

  it('a symlink to the same folder is the same Walnut: never judged a copy, the move is declared from the other path (L1)', async () => {
    const real = dataDir('real', W)
    const link = path.join(base, 'link')
    fs.symlinkSync(real, link)
    fs.mkdirSync(path.dirname(homeRecordFile(real)), { recursive: true })
    fs.writeFileSync(homeRecordFile(real), JSON.stringify({ machineId: M, home: link, movedFrom: '/older' }))
    // The old path still holds this id (it IS this folder), but it is no copy.
    expect(await noteHome(real, M, W)).toEqual([link, '/older'])
    expect(JSON.parse(fs.readFileSync(homeRecordFile(real), 'utf8'))).toMatchObject({ home: real, movedFrom: link, formerHomes: [link, '/older'] })
  })

  it('a committed switch: the record names it and the old holder\'s path; the next start declares the same', async () => {
    const now = dataDir('new-machine', W)
    const sw: SwitchedFrom = { switchId: 'sw-1', home: '/srv/a/./walnut', formerHomes: [] }
    expect(await noteHome(now, 'b'.repeat(32), W, { switched: sw })).toEqual(['/srv/a/./walnut'])
    expect(JSON.parse(fs.readFileSync(homeRecordFile(now), 'utf8'))).toEqual({ machineId: 'b'.repeat(32), home: now, movedFrom: '/srv/a/./walnut', formerHomes: ['/srv/a/./walnut'], switchId: 'sw-1' })
    expect(await noteHome(now, 'b'.repeat(32), W, { switched: sw })).toEqual(['/srv/a/./walnut'])
    // The same record with no switch to judge (the experiment off since): what it declared still holds.
    expect(await noteHome(now, 'b'.repeat(32), W)).toEqual(['/srv/a/./walnut'])
  })

  it('an unreadable record is no move, and is written again', async () => {
    const now = dataDir('now', W)
    fs.mkdirSync(path.dirname(homeRecordFile(now)), { recursive: true })
    fs.writeFileSync(homeRecordFile(now), '{ not json')
    expect(await noteHome(now, M, W)).toEqual([])
    expect(JSON.parse(fs.readFileSync(homeRecordFile(now), 'utf8'))).toEqual({ machineId: M, home: now })
  })
})
