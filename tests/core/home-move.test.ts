/**
 * A Walnut's data dir moved: declared by its server, never guessed (src/core/home-move.ts).
 * The rule (judgeHome) and the record it keeps (noteHome), on real files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FORMER_HOMES_MAX, homeRecordFile, judgeHome, noteHome } from '../../src/core/home-move.js'

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

  it('an unreadable record is no move, and is written again', async () => {
    const now = dataDir('now', W)
    fs.mkdirSync(path.dirname(homeRecordFile(now)), { recursive: true })
    fs.writeFileSync(homeRecordFile(now), '{ not json')
    expect(await noteHome(now, M, W)).toEqual([])
    expect(JSON.parse(fs.readFileSync(homeRecordFile(now), 'utf8'))).toEqual({ machineId: M, home: now })
  })
})
