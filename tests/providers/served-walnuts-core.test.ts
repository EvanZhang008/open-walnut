/**
 * served-walnuts-core.ts on its own: the record a daemon keeps of the Walnuts it serves.
 * Writes when a Walnut is new or seen again after 10 minutes (not on every push), drops
 * a Walnut not seen for a week, and ignores a hand-edited or torn file. A server this daemon
 * runs for a leader (its data dir) is that leader's Walnut, never another one sharing it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServedWalnuts } from '../../src/providers/served-walnuts-core.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-served-core-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
const keyOf = (h: string) => crypto.createHash('sha1').update(h).digest('hex').slice(0, 16)

function make(file: string, clock: { now: number }, writes: { n: number }) {
  const counting = { ...fs, renameSync: (a: fs.PathLike, b: fs.PathLike) => { writes.n++; fs.renameSync(a, b) } } as typeof fs
  return createServedWalnuts({ fs: counting, file, keyOf, version: 'v1', twin: 'binary', capabilities: () => ['a', 'b'], now: () => clock.now })
}

describe('served walnuts record', () => {
  it('writes for a new Walnut and every 10 minutes, not on every push', () => {
    const file = path.join(root, 'throttle.json')
    const clock = { now: 1_000_000 }
    const writes = { n: 0 }
    const s = make(file, clock, writes)
    s.note('/w/a')
    s.note('/w/a')
    clock.now += 9 * 60_000
    s.note('/w/a')
    expect(writes.n).toBe(1)
    s.note('')
    expect(writes.n).toBe(2)
    // That write carried A's time too: the next is due 10 minutes after it.
    clock.now += 9 * 60_000
    s.note('/w/a')
    expect(writes.n).toBe(2)
    clock.now += 60_000
    s.note('/w/a')
    expect(writes.n).toBe(3)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      v: 1, version: 'v1', twin: 'binary', capabilities: ['a', 'b'],
      walnuts: { [keyOf('/w/a')]: clock.now, '-': clock.now - 10 * 60_000 }, at: clock.now,
    })
  })

  it('reads the record back, drops a Walnut not seen for a week and keys it does not know', () => {
    const file = path.join(root, 'prune.json')
    const now = 10 * 24 * 3600_000
    fs.writeFileSync(file, JSON.stringify({ walnuts: { [keyOf('/w/a')]: now - 3600_000, [keyOf('/w/old')]: now - 8 * 24 * 3600_000, '../x': now, '-': 'soon' } }))
    const s = make(file, { now }, { n: 0 })
    expect(s.recent()).toEqual({ [keyOf('/w/a')]: now - 3600_000 })
    expect(s.recent(60_000)).toEqual({})
  })

  it('a torn file reads as none', () => {
    const file = path.join(root, 'torn.json')
    fs.writeFileSync(file, '{"walnuts":{')
    expect(make(file, { now: 1 }, { n: 0 }).recent()).toEqual({})
  })
})

describe('a server this daemon runs for a leader', () => {
  // 2026-11-23: a host's replica pushed turns.configure naming its own data dir, so the record
  // held a second key and the leader kept an old daemon for "another Walnut" for four hours.
  const LEADER = '/fixture/marina-home'
  const DATA = '/home/u/.open-walnut-host/data'
  const OTHER = '/fixture/acme-home'
  function withFollower(file: string, clock: { now: number }, homes: () => string[] = () => [DATA]) {
    return createServedWalnuts({
      fs, file, keyOf, version: 'v1', twin: 'binary', capabilities: () => [], now: () => clock.now,
      walnutOf: (h) => (h === DATA ? LEADER : undefined), followerHomes: homes,
    })
  }

  it('files its data dir under its leader\'s key, whatever slashes it is written with', () => {
    const file = path.join(root, 'follower-note.json')
    const clock = { now: 5_000_000 }
    const s = withFollower(file, clock)
    s.note(LEADER)
    s.note(DATA)
    s.note(DATA + '/')
    s.note('/home/u//.open-walnut-host/data')
    expect(Object.keys(s.recent())).toEqual([keyOf(LEADER)])
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).walnuts)).toEqual([keyOf(LEADER)])
    expect(s.knows(DATA)).toBe(true)
    // Another Walnut is still another one.
    s.note(OTHER)
    expect(Object.keys(s.recent()).sort()).toEqual([keyOf(LEADER), keyOf(OTHER)].sort())
  })

  it('drops the key an older build filed its data dir under, in the record and in the file', () => {
    const file = path.join(root, 'follower-stale.json')
    const now = 9_000_000
    fs.writeFileSync(file, JSON.stringify({ walnuts: { [keyOf(LEADER)]: now - 1000, [keyOf(DATA)]: now - 500, [keyOf(OTHER)]: now - 200 } }))
    // Before the daemon read its specs, the key stays (it cannot tell yet).
    let homes: string[] = []
    const s = withFollower(file, { now }, () => homes)
    expect(Object.keys(s.recent()).sort()).toEqual([keyOf(LEADER), keyOf(DATA), keyOf(OTHER)].sort())
    homes = [DATA]
    expect(Object.keys(s.recent()).sort()).toEqual([keyOf(LEADER), keyOf(OTHER)].sort())
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).walnuts).sort()).toEqual([keyOf(LEADER), keyOf(OTHER)].sort())
  })

  it('a data dir walnutOf does not map (no spec for it, a refused dir) keeps its own key', () => {
    const file = path.join(root, 'follower-unmapped.json')
    const s = createServedWalnuts({
      fs, file, keyOf, version: 'v1', twin: 'binary', capabilities: () => [], now: () => 1_000,
      walnutOf: () => undefined, followerHomes: () => [OTHER],
    })
    s.note(OTHER)
    expect(Object.keys(s.recent())).toEqual([keyOf(OTHER)])
  })

  it('a lookup that throws (the supervisor not made yet) files the home as it is', () => {
    const file = path.join(root, 'follower-throws.json')
    const s = createServedWalnuts({
      fs, file, keyOf, version: 'v1', twin: 'binary', capabilities: () => [], now: () => 1_000,
      walnutOf: () => { throw new ReferenceError('hostServers is not defined') }, followerHomes: () => { throw new ReferenceError('x') },
    })
    s.note(DATA)
    expect(Object.keys(s.recent())).toEqual([keyOf(DATA)])
  })
})
