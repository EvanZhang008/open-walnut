/**
 * The host link ledger knows a link that never came up in this process, and what
 * earlier servers saw (src/providers/host-link-ledger.ts).
 *
 * 2026-11-12, the send.resume alarm at 18 to 52 minutes: clouddev's SSH
 * certificate expired at 17:04 and three server restarts followed. No process saw
 * the link fall (it was never up in them), and each forgot what the one before
 * knew, so messages that waited for clouddev read "slow to wake".
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetHostLinkLedgerForTest, flushHostLinkLedger, linkDownIntervals, loadHostLinkLedger,
  noteHostLinkDialing, noteHostLinkDown, noteHostLinkUp,
} from '../../src/providers/host-link-ledger.js'

const dirs: string[] = []
function tmpFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'host-link-ledger-'))
  dirs.push(d)
  return path.join(d, 'cache', 'host-link-ledger.json')
}
const total = (list: Array<{ start: number; end: number }>) => list.reduce((n, i) => n + i.end - i.start, 0)

afterEach(() => {
  __resetHostLinkLedgerForTest()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const T = Date.parse('2026-11-12T17:20:00.014Z')

describe('host link ledger', () => {
  it('a link that never came up is down from its connection until the first connect', () => {
    noteHostLinkDialing('clouddev', false, T)
    expect(total(linkDownIntervals('clouddev', T, T + 60_000, T + 60_000))).toBe(60_000)
    noteHostLinkUp('clouddev', T + 90_000)
    expect(total(linkDownIntervals('clouddev', T - 1_000, T + 200_000, T + 200_000))).toBe(90_000)
  })

  it('a new connection beside one that is up records nothing', () => {
    noteHostLinkDialing('clouddev', true, T)
    expect(linkDownIntervals('clouddev', T, T + 60_000, T + 60_000)).toEqual([])
  })

  it('an outage open when the last server stopped stays open until a link of the next one is up', async () => {
    const file = tmpFile()
    // Server 1: the link falls at 17:04 and never comes back before it stops.
    await loadHostLinkLedger(file, T - 16 * 60_000)
    noteHostLinkDown('clouddev', Date.parse('2026-11-12T17:04:00Z'))
    await flushHostLinkLedger(T)
    __resetHostLinkLedgerForTest()
    // Server 2 boots at 18:05, dials (still down), and the link is back at 18:12:40.
    const boot = Date.parse('2026-11-12T18:05:04.871Z')
    noteHostLinkDialing('clouddev', false, boot)
    await loadHostLinkLedger(file, boot + 1_000)
    const up = Date.parse('2026-11-12T18:12:40.500Z')
    noteHostLinkUp('clouddev', up)
    const delivered = Date.parse('2026-11-12T18:12:40.837Z')
    // The 17:20 wake-up message: all but the last third of a second was the link's.
    expect(delivered - T - total(linkDownIntervals('clouddev', T, delivered, delivered))).toBe(delivered - up)
  })

  it('read before any dial (the boot order), an outage left open stays open until the link is up', async () => {
    const file = tmpFile()
    await loadHostLinkLedger(file, T)
    noteHostLinkDown('clouddev', T)
    await flushHostLinkLedger(T + 1)
    __resetHostLinkLedgerForTest()
    await loadHostLinkLedger(file, T + 60_000)
    expect(total(linkDownIntervals('clouddev', T, T + 120_000, T + 120_000))).toBe(120_000)
    noteHostLinkUp('clouddev', T + 150_000)
    expect(linkDownIntervals('clouddev', T - 1, T + 200_000, T + 200_000)).toEqual([{ start: T, end: T + 150_000 }])
  })

  it('every edge reaches the file', async () => {
    const file = tmpFile()
    await loadHostLinkLedger(file, T)
    noteHostLinkDown('h', T)
    noteHostLinkUp('h', T + 1_000)
    await flushHostLinkLedger()
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(data.hosts.h).toEqual({ closed: [{ start: T, end: T + 1_000 }] })
  })

  it('an outage left open closes where this process first came up, when that was before the load', async () => {
    const file = tmpFile()
    await loadHostLinkLedger(file, T)
    noteHostLinkDown('clouddev', T)
    await flushHostLinkLedger(T + 1)
    __resetHostLinkLedgerForTest()
    noteHostLinkUp('clouddev', T + 10_000) // connected before the boot read the file
    await loadHostLinkLedger(file, T + 20_000)
    expect(linkDownIntervals('clouddev', T - 1, T + 30_000, T + 30_000)).toEqual([{ start: T, end: T + 10_000 }])
  })

  it('closed intervals survive a restart; a missing or broken file starts empty', async () => {
    const file = tmpFile()
    await loadHostLinkLedger(file, T)
    noteHostLinkDown('h', T)
    noteHostLinkUp('h', T + 5_000)
    await flushHostLinkLedger(T + 6_000)
    __resetHostLinkLedgerForTest()
    await loadHostLinkLedger(file, T + 7_000)
    expect(linkDownIntervals('h', T - 1, T + 9_000, T + 9_000)).toEqual([{ start: T, end: T + 5_000 }])
    __resetHostLinkLedgerForTest()
    fs.writeFileSync(file, '{not json')
    await loadHostLinkLedger(file, T)
    expect(linkDownIntervals('h', T - 1, T + 9_000, T + 9_000)).toEqual([])
    __resetHostLinkLedgerForTest()
    await loadHostLinkLedger(path.join(path.dirname(file), 'none.json'), T)
    expect(linkDownIntervals('h', T - 1, T + 9_000, T + 9_000)).toEqual([])
  })
})
