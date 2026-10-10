/**
 * A write that died part way (r4c gate F1): the daemon notes a `begin` record
 * before a line's first byte, so a resend can tell that an earlier write of
 * the line into this process never finished, and whether the piece it left
 * may be cut inside the body (lineWriteBegun, lineWriteCut). Pure, so every
 * rule is pinned here; the twins run the same function text.
 */
import { describe, it, expect } from 'vitest'
import { lineFateScan, lineFateVerdict, lineTornEnd, lineWriteBegun, lineWriteCut } from '../../src/providers/line-fate-core.js'

const q = { uuid: 'u-1', messageIds: ['qm-1'], pid: 7 }
const begin = (pid: number, ids: string[], at: number) => JSON.stringify({ pid, uuid: 'u-1', begin: ids, at })
const whole = (pid: number, ids: string[], at: number) => JSON.stringify({ pid, uuid: 'u-1', ids, at })
const marker = (id: string, pid: number, at?: number) => JSON.stringify({
  type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'x' },
  walnutMessageId: id, walnutDelivery: 'ordered', walnutPid: pid,
  ...(at !== undefined ? { timestamp: new Date(at).toISOString() } : {}),
})
const lines = (...l: string[]) => l.join('\n') + '\n'

describe('lineWriteBegun: the newest record of the line in this process', () => {
  it('a begin with no whole-write record after it: the time it began', () => {
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000)), q)).toBe(1000)
  })
  it('a begin followed by its whole-write record: null (the write finished)', () => {
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000), whole(7, ['qm-1'], 1001)), q)).toBeNull()
  })
  it('a newer begin after an older whole write (a rewrite that died): the newer begin', () => {
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000), whole(7, ['qm-1'], 1001), begin(7, ['qm-1'], 2000)), q)).toBe(2000)
  })
  it('a begin taken back (the write put not one byte in): null, until a newer begin', () => {
    const unbegun = JSON.stringify({ pid: 7, uuid: 'u-1', unbegun: ['qm-1'], at: 1001 })
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000), unbegun), q)).toBeNull()
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000), unbegun, begin(7, ['qm-1'], 3000)), q)).toBe(3000)
    // An older daemon's verdict reads only `ids`: neither record looks like a whole write to it.
    expect(lineFateVerdict(null, lines(begin(7, ['qm-1'], 1000), unbegun), q)).toBeNull()
  })
  // The r5 gate's N3 (probe PA): an unbegun takes back the begin of its own attempt, the one
  // right before it, never an older attempt's begin that never finished.
  it('a write that died, then a resend that put not one byte in: the first begin still stands', () => {
    const unbegun = (at: number) => JSON.stringify({ pid: 7, uuid: 'u-1', unbegun: ['qm-1'], at })
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000), begin(7, ['qm-1'], 2000), unbegun(2001)), q)).toBe(1000)
    // Two resends that put nothing in, after the one that died: still the one that died.
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000), begin(7, ['qm-1'], 2000), unbegun(2001),
      begin(7, ['qm-1'], 3000), unbegun(3001)), q)).toBe(1000)
    // Another line's records in between change nothing.
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000), begin(7, ['qm-2'], 1500), begin(7, ['qm-1'], 2000), unbegun(2001)), q)).toBe(1000)
    // Every attempt taken back: nothing stands.
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000), unbegun(1001), begin(7, ['qm-1'], 2000), unbegun(2001)), q)).toBeNull()
    // A whole write before the attempt that put nothing in: finished.
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000), whole(7, ['qm-1'], 1001), begin(7, ['qm-1'], 2000), unbegun(2001)), q)).toBeNull()
    // So the resend after them is ended and said cut, as after the first one.
    const begunAt = lineWriteBegun(lines(begin(7, ['qm-1'], 1000), begin(7, ['qm-1'], 2000), unbegun(2001)), q)
    expect([lineTornEnd(null, q, null, begunAt), lineWriteCut(null, q, null, begunAt)]).toEqual([true, true])
  })
  it('another process\'s begin, or another line\'s, says nothing about this one', () => {
    expect(lineWriteBegun(lines(begin(8, ['qm-1'], 1000)), q)).toBeNull()
    expect(lineWriteBegun(lines(begin(7, ['qm-2'], 1000)), q)).toBeNull()
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000), begin(7, ['qm-2'], 1500)), q)).toBe(1000)
  })
  it('no pid, no ids, no records, a torn record: null', () => {
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000)), { ...q, pid: null })).toBeNull()
    expect(lineWriteBegun(lines(begin(7, ['qm-1'], 1000)), { ...q, messageIds: [] })).toBeNull()
    expect(lineWriteBegun('', q)).toBeNull()
    expect(lineWriteBegun('{"pid":7,"begin":["qm-1"],"a', q)).toBeNull()
  })
  it('a begin record never proves a line in: the verdict still answers null', () => {
    expect(lineFateVerdict(null, lines(begin(7, ['qm-1'], 1000)), q)).toBeNull()
    expect(lineFateVerdict(lineFateScan(marker('qm-1', 7, 1001), q, null), lines(begin(7, ['qm-1'], 1000)), q)).toBeNull()
  })
})

describe('lineWriteCut: may the pipe hold a copy cut inside its body?', () => {
  const scanOf = (text: string) => lineFateScan(text, q, null)
  it('begun, no marker of this process since: cut', () => {
    expect(lineWriteCut(null, q, null, 1000)).toBe(true)
    expect(lineWriteCut(null, q, scanOf(''), 1000)).toBe(true)
  })
  it('a marker written at or after the begin: the body is whole, not cut', () => {
    expect(lineWriteCut(null, q, scanOf(lines(marker('qm-1', 7, 1000))), 1000)).toBe(false)
    expect(lineWriteCut(null, q, scanOf(lines(marker('qm-1', 7, 1005))), 1000)).toBe(false)
  })
  it('only a marker from before the begin (an older write of the line): cut', () => {
    expect(lineWriteCut(null, q, scanOf(lines(marker('qm-1', 7, 999))), 1000)).toBe(true)
  })
  it('the newest marker counts, scanned piece by piece', () => {
    const scan = lineFateScan(lines(marker('qm-1', 7, 1005)), q, lineFateScan(lines(marker('qm-1', 7, 500)), q, null))
    expect(scan.markerAt).toBe(1005)
    expect(lineWriteCut(null, q, scan, 1000)).toBe(false)
  })
  it('a marker without a time, or another process\'s, does not end the doubt', () => {
    expect(lineWriteCut(null, q, scanOf(lines(marker('qm-1', 7))), 1000)).toBe(true)
    expect(lineWriteCut(null, q, scanOf(lines(marker('qm-1', 8, 1005))), 1000)).toBe(true)
  })
  it('nothing begun, a line proven in, or a line without a uuid: never cut', () => {
    expect(lineWriteCut(null, q, null, null)).toBe(false)
    for (const fate of ['ran', 'cancelled', 'dropped', 'waiting'] as const) expect(lineWriteCut({ fate }, q, null, 1000)).toBe(false)
    expect(lineWriteCut(null, { ...q, uuid: '' }, null, 1000)).toBe(false)
  })
})

describe('lineTornEnd with a begin: the resend ends what the dead write left', () => {
  it('begun and unfinished, no marker: a newline goes first', () => {
    expect(lineTornEnd(null, q, null, 1000)).toBe(true)
  })
  it('without a begin the old rule holds (marker needed)', () => {
    expect(lineTornEnd(null, q, null, null)).toBe(false)
    expect(lineTornEnd(null, q, null)).toBe(false)
  })
  it('a line proven in, or without a uuid, gets nothing', () => {
    expect(lineTornEnd({ fate: 'waiting' }, q, null, 1000)).toBe(false)
    expect(lineTornEnd(null, { ...q, uuid: '' }, null, 1000)).toBe(false)
  })
})
