/**
 * Flap classifier: links from daemon events, the replica join, the M1-M5
 * rules, storms, outages, the 5-minute-cycle detector and the per-day rows.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  analyze, awakeThrough, buildLinks, classifyDrop, cyclePhase, dayRows, dropContext, findOutages, findStorms, isAligned,
  MECHS, replicaJoin, settleOldGaps, topHypothesis,
} from '../../../scripts/bridge-monitor/lib/classify.mjs'
import { parseDaemonLine, parseReplicaLine, parseServerLine } from '../../../scripts/bridge-monitor/lib/parse-bridge.mjs'
import { parseTcpSummaries } from '../../../scripts/bridge-monitor/lib/parse-tcp.mjs'

const FIX = path.join(import.meta.dirname, 'fixtures')
const lines = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf-8').split('\n')
const T0 = Date.parse('2026-03-10T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const dev = (s: number, ev: string, extra: Record<string, unknown> = {}) => ({ t: at(s), kind: 'daemon', ev, ...extra })
type AnyRec = Record<string, any>

/** A context with nothing in it: every classifier input absent. */
const emptyCtx = () => ({ server: [], net: [], gaps: [], pmset: [], tcp: [], daemonOther: [], replica: [], load: [] })

describe('buildLinks (census)', () => {
  it('opens on connected, closes on the next transition, measures uptime and reconnect', () => {
    const links = buildLinks([
      dev(0, 'connected'), dev(300, 'closed'), dev(301.2, 'connected'),
      dev(1200, 'silence', { silentMs: 98000 }), dev(1200.02, 'closed'), dev(1221, 'dial-timeout'),
      dev(1350, 'connected'), dev(2400, 'restart', { reason: 'startup' }), dev(2400.2, 'connected'),
      dev(2500, 'configured'),
    ])
    expect(links).toHaveLength(4)
    expect(links[0]).toMatchObject({ upS: 300, cause: 'closed', reconnectS: 1.2 })
    expect(links[1]).toMatchObject({ cause: 'silence', silentMs: 98000, reconnectS: 150 })
    expect(links[1].upS).toBeCloseTo(898.8, 3)
    expect(links[2]).toMatchObject({ cause: 'restart', restartReason: 'startup' })
    expect(links[2].reconnectS).toBeCloseTo(0.2, 3)
    expect(links[3].downMs).toBeUndefined()
  })

  it('a duplicate connected while up and events out of order do not split a link', () => {
    const links = buildLinks([dev(300, 'closed'), dev(0, 'connected'), dev(10, 'connected')])
    expect(links).toHaveLength(1)
    expect(links[0].upS).toBe(300)
  })

  it('attaches the structured open/close records of newer daemons to their link', () => {
    const events = lines('daemon.log').map(parseDaemonLine).filter(Boolean).map((e: AnyRec) => ({ ...e, kind: 'daemon' }))
    const [first] = buildLinks(events)
    expect(first).toMatchObject({ connId: 'c-1', dialMs: 180, cause: 'closed' })
    expect(first.close).toMatchObject({ code: 1006, wasClean: false, lastError: 'ECONNRESET', maxOutFrameBytes: 1900000, rttMsMax: 180 })
  })

  it('probe records carry their connId on the connected event', () => {
    const links = buildLinks([
      { t: at(0), ev: 'connected', connId: 'p-1', dialMs: 40 },
      { t: at(50), ev: 'conn-close', connId: 'p-1', code: 1001, wasClean: true },
      { t: at(50.01), ev: 'closed' },
    ])
    expect(links[0]).toMatchObject({ connId: 'p-1', dialMs: 40, cause: 'closed', close: { code: 1001, wasClean: true } })
  })
})

describe('replicaJoin (join.py)', () => {
  const T = T0
  const rep = (s: number, kind: string, extra: Record<string, unknown> = {}) => ({ t: new Date(T + s * 1000).toISOString(), kind, ...extra })

  it('classes: both saw it, silence sweep, never saw it, silence only, nothing near', () => {
    expect(replicaJoin(T, [rep(1.5, 'disconnected', { reason: 'socket closed' })]).cls).toBe('both-saw-close-within-2s')
    expect(replicaJoin(T, [rep(-3, 'silent'), rep(0.4, 'disconnected', { reason: 'socket closed' })]).cls).toBe('replica-silence-sweep-closed-it')
    expect(replicaJoin(T, [rep(3, 'replaced')]).cls).toBe('replica-never-saw-close')
    expect(replicaJoin(T, [rep(-40, 'silent')]).cls).toBe('replica-silence-then-?')
    expect(replicaJoin(T, [rep(-500, 'disconnected')]).cls).toBe('no-replica-event-nearby')
    expect(replicaJoin(T, []).cls).toBeNull()
  })

  it('a close outside the 2 s window does not count as seen', () => {
    expect(replicaJoin(T, [rep(2.5, 'disconnected', { reason: 'socket closed' })]).cls).toBe('no-replica-event-nearby')
    expect(replicaJoin(T, [rep(0.5, 'disconnected', { reason: 'replaced' })]).cls).toBe('no-replica-event-nearby')
  })

  it('the structured close counts, and its initiator is surfaced', () => {
    const j = replicaJoin(T, [rep(0.2, 'closed', { initiator: 'server', code: 1001 })])
    expect(j).toMatchObject({ cls: 'both-saw-close-within-2s', initiator: 'server' })
  })
})

describe('classifyDrop (M1-M5)', () => {
  const link = (cause: string, extra: AnyRec = {}) => ({ upMs: T0 - 300_000, upS: 300, downMs: T0, cause, ...extra })
  const classify = (l: AnyRec, ctx: AnyRec) => classifyDrop(l, dropContext(l.downMs, l, { ...emptyCtx(), ...ctx }))
  const iso = (dS: number) => new Date(T0 + dS * 1000).toISOString()

  it('M4 daemon restart', () => {
    expect(classify(link('restart', { restartReason: 'configure' }), {})).toMatchObject({ mech: 'M4', basis: 'restart: configure' })
  })

  it('M3 silence while the Mac slept (collector gap), M5 while provably awake, M? with no record of the Mac', () => {
    const silence = link('silence', { silentMs: 98_000 })
    expect(classify(silence, { gaps: [{ t: iso(5), wallMs: 400_000, sleptMs: 390_000 }] }).mech).toBe('M3')
    const awake = { load: [{ t: iso(-150) }, { t: iso(-60) }, { t: iso(30) }] }
    expect(classify(silence, awake)).toMatchObject({ mech: 'M5', basis: 'silence watchdog while the Mac was awake, no drift data' })
    // No samples, no sleep data: nothing says the Mac was asleep, so it is not "Mac asleep" either.
    expect(classify(silence, {})).toMatchObject({ mech: 'M?', basis: expect.stringContaining('Mac state unknown') })
  })

  const everyMinute = (fromS: number, toS: number, load1 = 2) => {
    const out: AnyRec[] = []
    for (let x = fromS; x <= toS; x += 60) out.push({ t: iso(x), load1, cpuIdlePct: 40 })
    return out
  }

  it('M6: the daemon froze long enough that its own watchdog fired (live: 94 s silent, 71 s stalled, load 300)', () => {
    const drop = link('silence', { silentMs: 94_000, close: { code: 1000, lastError: 'inbound silence (daemon closed)', loopDriftMax60sMs: 71_000 } })
    const r = classify(drop, { load: everyMinute(-400, 120, 301) })
    expect(r.mech).toBe('M6')
    expect(r.basis).toBe('daemon event loop stalled 71 s of 94 s silent, load 301')
    // A silence the stall does not explain stays M5: 137 s silent, no stall.
    const quiet = link('silence', { silentMs: 137_000, close: { code: 1000, lastError: 'inbound silence (daemon closed)', loopDriftMax60sMs: 40 } })
    expect(classify(quiet, { load: everyMinute(-400, 120) })).toMatchObject({ mech: 'M5', basis: expect.stringContaining('drift 0 s') })
    // A stall while the Mac slept is the sleep, not a freeze.
    expect(classify(drop, { load: everyMinute(-400, 120), gaps: [{ t: iso(0), wallMs: 90_000, sleptMs: 80_000 }] }).mech).toBe('M3')
  })

  it('coverage needs samples THROUGH the silence: a 282 s hole across it is not "awake"', () => {
    const drop = link('silence', { silentMs: 98_000 })
    // Samples on both sides, none inside, and a gap of unknown state (the kernel read failed).
    const load = [...everyMinute(-600, -240), ...everyMinute(42, 300)]
    const gap = { t: iso(42), kind: 'gap', wallMs: 282_000, monoMs: 282_000, sleptMs: 0, kernelSleepAt: null, kernelWakeAt: null }
    expect(classify(drop, { load, gaps: [gap] }).mech).toBe('M?')
    expect(classify(drop, { load }).mech).toBe('M?') // no gap record at all: still a hole
    // The same gap with a kernel read that shows no sleep proves the Mac awake (the collector was starved).
    const starved = { ...gap, kernelSleepAt: iso(-90_000), kernelWakeAt: iso(-89_000) }
    expect(classify(drop, { load, gaps: [starved] }).mech).toBe('M5')
  })

  it('awakeThrough: each instant within 2 minutes after a sample, nothing unproven in between', () => {
    const load = everyMinute(0, 600)
    expect(awakeThrough({ load, gaps: [] }, T0 + 30_000, T0 + 590_000)).toBe(true)
    expect(awakeThrough({ load, gaps: [] }, T0 - 10_000, T0 + 100_000)).toBe(false) // starts before the first sample
    const holed = load.filter((x) => { const d = (Date.parse(x.t) - T0) / 1000; return d < 200 || d > 400 })
    expect(awakeThrough({ load: holed, gaps: [] }, T0 + 30_000, T0 + 590_000)).toBe(false)
    expect(awakeThrough({ load, gaps: [{ t: iso(300), wallMs: 40_000, sleptMs: null, resume: true }] }, T0 + 30_000, T0 + 590_000)).toBe(false)
  })

  it('M3 from pmset: a dark wake inside the silent window, even if awake at the drop', () => {
    const silence = link('silence', { silentMs: 98_000 })
    const pmset = [{ t: iso(-80), state: 'darkwake' }, { t: iso(-2), state: 'awake' }]
    expect(classify(silence, { pmset, load: [{ t: iso(-200) }, { t: iso(30) }] }).mech).toBe('M3')
  })

  it('M1 when the replica saw the close; M2 when it never did', () => {
    const closed = link('closed')
    expect(classify(closed, { replica: [{ t: iso(0.4), kind: 'disconnected', reason: 'socket closed' }] }).mech).toBe('M1')
    expect(classify(closed, { replica: [{ t: iso(2), kind: 'replaced' }] }).mech).toBe('M2')
  })

  it('Mac-only evidence: SSH died together (remote hosts only), network change, kernel drop, peer reset', () => {
    const closed = link('closed')
    expect(classify(closed, { server: [{ t: iso(0.5), ev: 'ssh-died', host: 'devbox' }] }).mech).toBe('M2')
    expect(classify(closed, { server: [{ t: iso(0.5), ev: 'ssh-lost', host: '__local__' }] }).mech).toBe('M?')
    expect(classify(closed, { net: [{ t: iso(-20), changed: ['primary'] }] })).toMatchObject({ mech: 'M2', basis: 'network change: primary' })
    const row = (extra: AnyRec) => ({ t: iso(1), durS: 300, ...extra })
    expect(classify(closed, { tcp: [row({ closefn: 'tcp_drop', state: 'CLOSED', soError: 60 })] }).mech).toBe('M2')
    // tcp_drop with no error and a RST out: the Mac side aborted it, not a network drop.
    expect(classify(closed, { tcp: [row({ closefn: 'tcp_drop', state: 'CLOSED', soError: 0, rstOut: 1 })] }))
      .toMatchObject({ mech: 'M?', basis: 'kernel: the Mac side aborted the socket' })
    expect(classify(closed, { tcp: [row({ closefn: 'tcp_close', state: 'ESTABLISHED', rstIn: 1 })] })).toMatchObject({ mech: 'M1', basis: 'kernel: peer-reset' })
    expect(classify(closed, { tcp: [row({ closefn: 'tcp_usrclosed', state: 'LAST_ACK', finIn: 1 })] }).mech).toBe('M1')
  })

  it('matches the kernel row by connect time even when the summary is logged late', () => {
    const closed = link('closed')
    const late = { t: iso(70), durS: 370, closefn: 'tcp_close', state: 'ESTABLISHED', rstIn: 1 }
    const c = dropContext(T0, closed, { ...emptyCtx(), tcp: [late] })
    expect(c.tcp?.ending).toBe('peer-reset')
  })

  it('never borrows the socket of the next link: a row that opened after the drop is not its evidence', () => {
    const closed = link('closed')
    // Logged 97 s after this drop, but it lived only 93 s: it opened 4 s AFTER the drop.
    const nextLinks = { t: iso(97), durS: 93, closefn: 'tcp_close', state: 'ESTABLISHED', rstIn: 1 }
    expect(dropContext(T0, closed, { ...emptyCtx(), tcp: [nextLinks] }).tcp).toBeFalsy()
    expect(classify(closed, { tcp: [nextLinks] }).mech).toBe('M?')
    // A late row that was already open at the drop still matches.
    const own = { t: iso(60), durS: 200, closefn: 'tcp_close', state: 'ESTABLISHED', rstIn: 1, rxmit: 7 }
    expect(dropContext(T0, closed, { ...emptyCtx(), tcp: [own, nextLinks] }).tcp).toMatchObject({ ending: 'peer-reset', rxmit: 7 })
  })

  it('a server close frame code means M1; nothing at all means M?', () => {
    expect(classify(link('closed', { close: { code: 1001 } }), {}).mech).toBe('M1')
    // The daemon's own close frame (it says "daemon closed") is not the far end's.
    expect(classify(link('closed', { close: { code: 1000, wasClean: true, lastError: 'uplink queue overflow (daemon closed)' } }), {}))
      .toMatchObject({ mech: 'M?', basis: 'the daemon closed it: uplink queue overflow' })
    expect(classify(link('closed', { close: { code: 1006 } }), {}).mech).toBe('M?')
    expect(classify(link('closed'), {})).toMatchObject({ mech: 'M?', basis: 'no corroborating evidence' })
  })

  it('a close while the Mac slept is M3, but replica evidence wins over it', () => {
    const closed = link('closed')
    const gaps = [{ t: iso(3), wallMs: 60_000, sleptMs: 55_000 }]
    expect(classify(closed, { gaps }).mech).toBe('M3')
    expect(classify(closed, { gaps, replica: [{ t: iso(4), kind: 'replaced' }] }).mech).toBe('M2')
  })
})

describe('storms, outages, cycle phase', () => {
  const drop = (s: number, mech = 'M1') => ({ downMs: T0 + s * 1000, mech })

  it('a storm needs MORE than maxDrops inside 10 minutes', () => {
    expect(findStorms([drop(0), drop(60), drop(120)], { maxDrops: 3 })).toEqual([])
    const s = findStorms([drop(0), drop(60), drop(120), drop(180, 'M2'), drop(3000)], { maxDrops: 3 })
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ count: 4, mechs: { M1: 3, M2: 1 } })
  })

  it('two separate bursts are two storms', () => {
    const burst = (base: number) => [0, 30, 60, 90].map((x) => drop(base + x))
    expect(findStorms([...burst(0), ...burst(5000)], { maxDrops: 3 })).toHaveLength(2)
  })

  it('outages over the threshold, including one still in progress', () => {
    const links = [
      { upMs: T0, downMs: T0 + 100_000, reconnectS: 30 },
      { upMs: T0 + 130_000, downMs: T0 + 200_000, reconnectS: 95 },
      { upMs: T0 + 295_000, downMs: T0 + 400_000 },
    ]
    const o = findOutages(links, { thresholdS: 60, nowMs: T0 + 520_000 })
    expect(o).toEqual([
      { downMs: T0 + 200_000, durS: 95, ongoing: false, mech: undefined },
      { downMs: T0 + 400_000, durS: 120, ongoing: true, mech: undefined },
    ])
  })

  it('drops pinned to one slot of a 5-minute cycle are detected; spread drops are not', () => {
    const base = Math.floor(T0 / 300_000) * 300_000
    const aligned = Array.from({ length: 8 }, (_, k) => ({ downMs: base + k * 900_000 + 42_000 + (k % 3) * 1000, mech: 'M1' }))
    const p = cyclePhase(aligned)
    expect(p.near).toBe(8)
    expect(p.phaseSec).toBeGreaterThan(42)
    expect(p.phaseSec).toBeLessThan(64)
    expect(isAligned(p)).toBe(true)
    const spread = Array.from({ length: 10 }, (_, k) => ({ downMs: base + k * 330_000 + k * 29_000, mech: 'M1' }))
    expect(isAligned(cyclePhase(spread))).toBe(false)
    expect(cyclePhase([])).toMatchObject({ n: 0, phaseSec: null })
  })

  it('partial alignment (a periodic job killing some links) still counts', () => {
    const base = Math.floor(T0 / 300_000) * 300_000
    const aligned = Array.from({ length: 6 }, (_, k) => ({ downMs: base + k * 600_000 + 90_000, mech: 'M1' }))
    const noise = Array.from({ length: 14 }, (_, k) => ({ downMs: base + k * 431_000 + 7_000, mech: 'M1' }))
    expect(isAligned(cyclePhase([...aligned, ...noise]))).toBe(true)
  })
})

describe('dayRows and topHypothesis', () => {
  const day = { day: '2026-03-10', startMs: Date.parse('2026-03-10T00:00:00Z'), endMs: Date.parse('2026-03-11T00:00:00Z') }

  it('connected share over the observed part of the day, and with sleep taken out', () => {
    const h = 3_600_000
    const links = [
      { upMs: day.startMs, downMs: day.startMs + 10 * h, upS: 36000, reconnectS: 7200 },
      { upMs: day.startMs + 12 * h, downMs: undefined },
    ]
    const drops = [{ ...links[0], mech: 'M3', downMs: day.startMs + 10 * h }]
    const sleeps: Array<[number, number]> = [[day.startMs + 10 * h, day.startMs + 12 * h]]
    const [row] = dayRows(links, drops, [], findOutages(links, { nowMs: day.endMs }), { dayBounds: [day], nowMs: day.endMs, firstObsMs: day.startMs, sleeps })
    expect(row).toMatchObject({ drops: 1, outages60: 1, longestOutageS: 7200, partial: false, sleepH: 2 })
    expect(row.connectedPct).toBeCloseTo(91.7, 1)
    expect(row.awakeConnectedPct).toBe(100)
    expect(row.byMech).toMatchObject({ M1: 0, M3: 1 })
  })

  it('a partial day only counts time observed so far', () => {
    const links = [{ upMs: day.startMs, downMs: undefined }]
    const [row] = dayRows(links, [], [], [], { dayBounds: [day], nowMs: day.startMs + 3_600_000, firstObsMs: day.startMs })
    expect(row).toMatchObject({ partial: true, observedH: 1, connectedPct: 100 })
  })

  const drops = (m: Record<string, number>) => Object.entries(m).flatMap(([mech, n]) => Array.from({ length: n }, () => ({ mech })))

  it('three or more actionable drops lead; fewer yield to the most common kind', () => {
    expect(topHypothesis(drops({ M1: 5, M3: 20 }), null).mech).toBe('M1')
    expect(topHypothesis(drops({ M1: 1, M3: 20 }), null).mech).toBe('M3')
    expect(topHypothesis(drops({ M2: 4, M5: 6 }), null).mech).toBe('M5')
    expect(topHypothesis(drops({ M6: 4, M3: 3, M5: 1 }), null).mech).toBe('M6')
    expect(topHypothesis([], null)).toMatchObject({ mech: null })
    expect(topHypothesis(drops({ M1: 5, M3: 20 }), null).text).toContain('Next most common: M3')
    expect(MECHS).toContain('M6')
  })

  it('the words claim no more than the evidence', () => {
    // M1 without a replica log: "far side", not "the cloud closed it".
    const kernel = Array.from({ length: 3 }, () => ({ mech: 'M1', basis: 'kernel: peer-reset' }))
    const m1 = topHypothesis(kernel, null).text
    expect(m1).toMatch(/^3 of 3 drops were reset or closed from the far side \(the cloud, or a middlebox on the way\)/)
    expect(m1).not.toContain('closed from the cloud side')
    const byReplica = Array.from({ length: 3 }, () => ({ mech: 'M1', basis: 'replica: both-saw-close-within-2s' }))
    expect(topHypothesis(byReplica, null).text).toMatch(/^3 of 3 drops were closed by the cloud side: the replica log saw each close/)
    // M2 says what it counted.
    const m2 = topHypothesis([
      { mech: 'M2', basis: 'network change: primary' }, { mech: 'M2', basis: 'kernel gave up on the socket' }, { mech: 'M2', basis: 'kernel gave up on the socket' },
    ], null).text
    expect(m2).toBe('3 of 3 drops point at the network path: 1 came with a Mac network change, 2 were sockets the Mac kernel gave up on (a timeout or a lost local address).')
    // M3 does not say the watchdog ended every one (live: 12 of 25 were plain closes).
    const m3 = topHypothesis([
      ...Array.from({ length: 13 }, () => ({ mech: 'M3', cause: 'silence', basis: 'silence watchdog, Mac asleep' })),
      ...Array.from({ length: 12 }, () => ({ mech: 'M3', cause: 'closed', basis: 'Mac asleep' })),
    ], null).text
    expect(m3).toContain('25 of 25 drops happened while the Mac slept or was in DarkWake (13 ended by the daemon\'s silence watchdog, 12 by a plain close)')
    // M5 no longer claims a half-open path.
    const m5 = topHypothesis(drops({ M5: 3 }), null).text
    expect(m5).not.toMatch(/half-open/i)
    expect(m5).toContain('cannot say where the traffic stopped')
    // "Not stalled" is said only for drops whose stall was measured.
    expect(m5).not.toContain('not stalled')
    expect(m5).toContain('3 of 3 drops were the daemon\'s silence watchdog firing while the Mac was awake (the daemon recorded no stall measurement for them)')
    const measured = (drift: number | null) => ({ mech: 'M5', close: drift == null ? {} : { loopDriftMax60sMs: drift } })
    expect(topHypothesis([measured(900), measured(0), measured(1200)], null).text).toContain('while the Mac was awake and the daemon was not stalled:')
    expect(topHypothesis([measured(900), measured(null), measured(null)], null).text)
      .toContain("while the Mac was awake (the daemon's stall was measured for 1 of them and was too short to explain the silence; 2 have no measurement):")
    // M6 names the Mac as the place to fix it, with the stall and the load.
    const m6 = topHypothesis([
      { mech: 'M6', close: { loopDriftMax60sMs: 71_000 }, ctx: { load1: 301 } },
      { mech: 'M6', close: { loopDriftMax60sMs: 176_130 }, ctx: { load1: 280 } },
      { mech: 'M6', close: { loopDriftMax60sMs: 69_000 }, ctx: { load1: 150 } },
    ], null).text
    expect(m6).toContain('3 of 3 drops were the Walnut daemon on this Mac freezing: its event loop stalled for up to 176 s at a machine load of up to 301')
    expect(m6).toContain('the fix is on the Mac')
  })

  it('a day with no drops is only "clean" when the bridge was actually up', () => {
    const never = { observedH: 20, connectedPct: 0, awakeConnectedPct: 0, sleepKnown: true }
    const h = topHypothesis([], null, never)
    expect(h.state).toBe('never-connected')
    expect(h.text).not.toMatch(/No drops|stayed/)
    expect(topHypothesis([], null, { observedH: 20, connectedPct: 40, awakeConnectedPct: 41, sleepKnown: true }).text)
      .toBe('No drops on this day, but the bridge was connected only 41% of the awake time: it stayed down rather than flapping.')
    expect(topHypothesis([], null, { observedH: 20, connectedPct: 100, awakeConnectedPct: 100, sleepKnown: true }).text)
      .toBe('No drops on this day. The bridge stayed connected whenever the Mac was awake.')
    expect(topHypothesis([], null, { observedH: 20, connectedPct: 100, awakeConnectedPct: 100, sleepKnown: false }).text)
      .toBe('No drops on this day. The bridge stayed connected.')
    expect(topHypothesis([], null, { observedH: 0 }).state).toBe('no-records')
  })

  it('sleep is "known" for a day only where a pmset read or the kernel check covered it', () => {
    const records: AnyRec[] = [{ t: new Date(day.startMs + 60_000).toISOString(), kind: 'load' }, { t: new Date(day.endMs - 60_000).toISOString(), kind: 'load' }]
    const a = analyze(records, { dayBounds: [day], reportDay: day.day, nowMs: day.endMs })
    expect(a.days[0].sleepKnown).toBe(false)
    const read = { t: new Date(day.endMs + 3_600_000).toISOString(), kind: 'daily', pmsetEvents: 3 }
    expect(analyze([...records, read], { dayBounds: [day], reportDay: day.day, nowMs: day.endMs + 7_200_000 }).days[0].sleepKnown).toBe(true)
    // A read that was cut short does not vouch for anything.
    expect(analyze([...records, { ...read, pmsetError: 'timeout' }], { dayBounds: [day], reportDay: day.day, nowMs: day.endMs + 7_200_000 }).days[0].sleepKnown).toBe(false)
    const kernel = { t: new Date(day.startMs + 30_000).toISOString(), kind: 'start', sleepCheck: 'kernel' }
    expect(analyze([...records, kernel], { dayBounds: [day], reportDay: day.day, nowMs: day.endMs }).days[0].sleepKnown).toBe(true)
  })
})

describe('analyze (end to end on the fixtures)', () => {
  it('classifies each fixture drop from daemon + server + kernel + replica evidence', () => {
    const daemon = lines('daemon.log').map(parseDaemonLine).filter(Boolean).map((e: AnyRec) => ({ ...e, kind: 'daemon' }))
    const server = lines('server.log').map(parseServerLine).filter(Boolean).map((e: AnyRec) => ({ ...e, kind: 'server' }))
    const replica = lines('replica.log').map(parseReplicaLine).filter((r: AnyRec | null) => r && r.alias === '__local__')
    const day = { day: '2026-03-10', startMs: Date.parse('2026-03-10T00:00:00Z'), endMs: Date.parse('2026-03-11T00:00:00Z') }
    const a = analyze([...daemon, ...server], { dayBounds: [day], reportDay: '2026-03-10', nowMs: day.endMs, replica })
    // The silence has no power data and no collector samples: the Mac's state is unknown, so M?, not "asleep".
    expect(a.drops.map((d: AnyRec) => [d.cause, d.mech])).toEqual([['closed', 'M1'], ['silence', 'M?'], ['restart', 'M4']])
    expect(a.drops[0].ctx.sshDied).toBe(true) // M1 still wins: the replica saw the close
    expect(a.drops[0].ctx.configured).toBe(true) // a bridge.configure push 0.7 s before
    expect(a.days[0]).toMatchObject({ drops: 3, byMech: { M1: 1, 'M?': 1, M4: 1 } })
    expect(a.outages.map((o: AnyRec) => Math.round(o.durS))).toEqual([150])
  })

  it('the kernel rows alone can classify a close when no replica log exists', () => {
    const tcp = parseTcpSummaries(fs.readFileSync(path.join(FIX, 'tcp-ndjson.txt'), 'utf-8')).map((r: AnyRec) => ({ ...r, kind: 'tcp' }))
    const daemon = [dev(0, 'connected'), dev(300.4, 'closed'), dev(301, 'connected')]
    const a = analyze([...daemon, ...tcp], { nowMs: T0 + 3_600_000 })
    expect(a.drops[0]).toMatchObject({ mech: 'M1', basis: 'kernel: peer-reset' })
  })
})

describe('records written before the sleep fix, and the report-day hypothesis', () => {
  const T = Date.parse('2026-03-10T10:00:00Z')
  const iso = (dS: number) => new Date(T + dS * 1000).toISOString()

  it('an old gap that reads "slept 0" is settled by a pmset sleep inside it; a new one is left alone', () => {
    const pmset = [{ t: iso(-500), kind: 'pmset', state: 'asleep' }]
    const [old, starved, fresh] = settleOldGaps([
      { t: iso(0), kind: 'gap', wallMs: 600_000, monoMs: 600_010, sleptMs: 0 },
      { t: iso(3600), kind: 'gap', wallMs: 176_000, monoMs: 176_000, sleptMs: 0 },
      { t: iso(0), kind: 'gap', wallMs: 600_000, monoMs: 600_000, sleptMs: 0, kernelWakeAt: null },
    ], pmset)
    expect(old).toMatchObject({ sleptMs: 600_000, sleptBy: 'pmset' })
    expect(starved.sleptMs).toBe(0)
    expect(fresh.sleptMs).toBe(0) // the collector already asked the kernel
  })

  it('the top hypothesis is about the report day, not the whole table window', () => {
    const dev = (dS: number, ev: string) => ({ t: iso(dS), kind: 'daemon', ev })
    const DAY1 = { day: '2026-03-09', startMs: Date.parse('2026-03-09T00:00:00Z'), endMs: Date.parse('2026-03-10T00:00:00Z') }
    const DAY2 = { day: '2026-03-10', startMs: DAY1.endMs, endMs: Date.parse('2026-03-11T00:00:00Z') }
    // The day before: ten unexplained closes. The report day: three kernel peer resets.
    const records: AnyRec[] = [dev(-80_000, 'connected')]
    for (let k = 0; k < 10; k++) records.push(dev(-79_000 + k * 600, 'closed'), dev(-79_000 + k * 600 + 1, 'connected'))
    for (let k = 0; k < 3; k++) {
      const down = 600 + k * 900
      records.push(dev(down, 'closed'), dev(down + 1, 'connected'))
      records.push({ t: iso(down + 0.5), kind: 'tcp', durS: 299, closefn: 'tcp_close', state: 'ESTABLISHED', rstIn: 1 })
    }
    const a = analyze(records, { dayBounds: [DAY1, DAY2], reportDay: DAY2.day, nowMs: DAY2.endMs })
    expect(a.hypothesis.mech).toBe('M1')
    expect(a.hypothesis.text).toMatch(/^3 of 3 drops were reset or closed from the far side/)
  })
})
