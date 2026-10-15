/**
 * A host replica's suspect marks and its way back to the Mac
 * (src/replica/presence.ts SuspectMarks, leaderReturn; WP2). A Mac whose daemon
 * link is alive (heard, primaryConnected) while its stream door refuses (the
 * Mac booting, this host not linked yet) used to make presence cycle every 5 s,
 * and every cycle closed every browser's own socket with 4002. Now the mark
 * doubles up to the quiet window, and the own sockets move only once a stream
 * to the Mac opened.
 */
import { describe, expect, it } from 'vitest'
import type { FollowerView } from '../../src/host-server/daemon-link.js'
import { leaderReturn, presenceOf, SUSPECT_MS, SuspectMarks } from '../../src/replica/presence.js'

const QUIET = 30_000
const START = 1_700_000_000_000

const heard: FollowerView = {
  walnutId: 'wmarina01', home: '/fixture/marina-home', epoch: 1, holder: 'primary', backup: false,
  primaryConnected: true, primaryHeardAgoMs: 100, takeoverMs: 0,
  bridge: { connected: false, companion: null }, settings: {}, quietMs: QUIET,
}

const flush = () => new Promise((r) => setImmediate(r))

/** Presence looked at every 500 ms for `ms`, with `back` run on each flip back to the Mac. */
async function run(ms: number, door: () => boolean) {
  let now = START
  const marks = new SuspectMarks(() => QUIET)
  const input = () => ({ view: { view: heard, at: now }, now, suspect: marks.until })
  const probes: number[] = []
  let closes = 0
  const back = leaderReturn({
    probe: async () => {
      probes.push(now - START)
      if (!door()) throw new Error('the Mac is not linked to this host')
    },
    answers: () => presenceOf(input()).answers,
    close: () => { closes++ },
    answered: () => marks.answered('leader'),
    failed: () => { marks.fail('leader', now) },
  })
  // The first forward fails.
  marks.fail('leader', now)
  let was = presenceOf(input()).answers
  for (let t = 0; t <= ms; t += 500) {
    now = START + t
    const p = presenceOf(input()).answers
    if (p && !was) { back(); await flush() }
    was = presenceOf(input()).answers
  }
  return { probes, closes, marks }
}

describe('a Mac heard while its stream door refuses', () => {
  it('moves no browser socket, and its door is tried at 5, 15, 35 and 65 s, not every 5 s', async () => {
    const r = await run(75_000, () => false)
    expect(r.closes).toBe(0)
    expect(r.probes).toEqual([5_000, 15_000, 35_000, 65_000])
    expect(r.marks.failures('leader')).toBe(5)
  })

  it('a door that opens moves the sockets once, and the next failure is marked 5 s again', async () => {
    let tries = 0
    const r = await run(40_000, () => ++tries >= 2)
    expect(r.probes).toEqual([5_000, 15_000])
    expect(r.closes).toBe(1)
    expect(r.marks.failures('leader')).toBe(0)
    expect(r.marks.fail('leader', START + 50_000)).toBe(SUSPECT_MS)
  })
})

describe('SuspectMarks', () => {
  it('failures while a mark holds (the forwards already in flight) count once', () => {
    const m = new SuspectMarks(() => QUIET)
    expect(m.fail('leader', START)).toBe(SUSPECT_MS)
    expect(m.fail('leader', START + 1_000)).toBe(SUSPECT_MS - 1_000)
    expect(m.failures('leader')).toBe(1)
    expect(m.fail('leader', START + SUSPECT_MS)).toBe(2 * SUSPECT_MS)
  })

  it('doubles up to the quiet window, never under SUSPECT_MS, and each target on its own', () => {
    const m = new SuspectMarks(() => QUIET)
    let now = START
    const seen: number[] = []
    for (let i = 0; i < 6; i++) { const ms = m.fail('leader', now); seen.push(ms); now += ms }
    expect(seen).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000])
    expect(m.fail('companion', now)).toBe(SUSPECT_MS)
    const short = new SuspectMarks(() => 1_000)
    expect(short.fail('leader', START)).toBe(SUSPECT_MS)
  })

  it('an answer starts the count again', () => {
    const m = new SuspectMarks(() => QUIET)
    m.fail('leader', START)
    m.fail('leader', START + 5_000)
    m.answered('leader')
    expect(m.fail('leader', START + 20_000)).toBe(SUSPECT_MS)
  })
})

describe('leaderReturn', () => {
  it('one probe at a time, and nothing closes when presence went away meanwhile', async () => {
    let release: () => void = () => {}
    let probes = 0
    let closes = 0
    let answers = true
    const back = leaderReturn({
      probe: () => { probes++; return new Promise<void>((r) => { release = r }) },
      answers: () => answers,
      close: () => { closes++ },
      answered: () => {},
      failed: () => {},
    })
    back(); back()
    expect(probes).toBe(1)
    answers = false
    release()
    await flush()
    expect(closes).toBe(0)
    back()
    expect(probes).toBe(2)
  })
})
