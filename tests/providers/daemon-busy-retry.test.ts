/**
 * A daemon update refused as busy is asked again on one clock (src/providers/daemon-busy-retry.ts):
 * on disk, so a leader deploy does not start it over, growing with how long the refusals last, and
 * bounded. 2026-11-25: clouddev's daemon refused 266 tries in 38 minutes, each SSH try a minute
 * after the last for as long as each server lived, and each try 15 asks 2 s apart.
 *
 * The ratchet half: every file that reads a busy refusal is listed in BUSY_REFUSAL_READERS; an
 * update path ('clock') notes every refusal it reads and checks the clock before it tries; the
 * CLI's own asks within one try grow their pauses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acpUpgradeHoldFlushedForTest, setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'
import {
  BUSY_REFUSAL_READERS, BUSY_RETRY_OVERDUE_MAX_MS, BUSY_RETRY_STALE_MS, DAEMON_BUSY_RETRY_MAX_MS,
  busyRetryLeftMs, busyRetryWaitMs, endBusyRefusals, noteBusyRefusal,
} from '../../src/providers/daemon-busy-retry.js'
import { busyPauses } from '../../src/providers/daemon-service-cli.js'
import { DAEMON_UPDATE_BEHIND_MAX_MS } from '../../src/providers/daemon-update-behind.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const MIN = 60_000

describe('the busy clock', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-retry-'))
    file = path.join(dir, 'holds.json')
    setAcpUpgradeHoldFileForTest(file)
  })
  afterEach(() => {
    setAcpUpgradeHoldFileForTest(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('waits longer the longer the refusals last, and never past its bound', () => {
    const t0 = 1_800_000_000_000
    const waits: number[] = []
    let t = t0
    // A daemon busy at every ask, each try made the moment its wait ends: over four hours.
    while (t - t0 < 4 * 60 * MIN) {
      const w = noteBusyRefusal('box', 'v1', {}, t)
      waits.push(w)
      t += w
    }
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1])
    expect(waits.slice(0, 3)).toEqual([MIN, MIN, MIN])
    expect(Math.max(...waits)).toBe(DAEMON_BUSY_RETRY_MAX_MS)
    // About 30 tries in 4 hours, where a minute apart made 240.
    expect(waits.length).toBeLessThan(35)
    // Overdue, a refused forced swap is asked again within minutes.
    expect(busyRetryWaitMs(3 * 60 * MIN, { overdue: true })).toBe(BUSY_RETRY_OVERDUE_MAX_MS)
    expect(busyRetryWaitMs(0, { overdue: true })).toBe(MIN)
  })

  it('a new server reads it from disk and starts no try before the wait ends', async () => {
    const t0 = 1_800_000_000_000
    for (let i = 0; i < 6; i++) noteBusyRefusal('box', 'v1', {}, t0 + i * 2 * MIN)
    const last = t0 + 10 * MIN
    await acpUpgradeHoldFlushedForTest()
    // A deploy: a new process reads the file again.
    setAcpUpgradeHoldFileForTest(file)
    expect(busyRetryLeftMs('box', 'v1', {}, last + MIN)).toBe(4 * MIN)
    expect(busyRetryLeftMs('box', 'v1', {}, last + 5 * MIN)).toBe(0)
    // Another host name has its own row; another build running there has none.
    expect(busyRetryLeftMs('other', 'v1', {}, last + MIN)).toBe(0)
    expect(busyRetryLeftMs('box', 'v2', {}, last + MIN)).toBe(0)
    // ...and the row of the build that no longer runs is gone.
    expect(busyRetryLeftMs('box', 'v1', {}, last + MIN)).toBe(0)
  })

  it('ends once the host runs the new build, or when no refusal was seen for a while', () => {
    const t0 = 1_800_000_000_000
    noteBusyRefusal('box', 'v1', {}, t0)
    expect(busyRetryLeftMs('box', 'v1', {}, t0 + 1_000)).toBeGreaterThan(0)
    endBusyRefusals('box')
    expect(busyRetryLeftMs('box', 'v1', {}, t0 + 1_000)).toBe(0)
    noteBusyRefusal('box', 'v1', {}, t0)
    // A refusal row seen again after it went stale starts over at the first wait.
    expect(noteBusyRefusal('box', 'v1', {}, t0 + BUSY_RETRY_STALE_MS + 1)).toBe(MIN)
  })

  it('a clock that stepped back never holds a try longer than one wait', () => {
    const t0 = 1_800_000_000_000
    for (let i = 0; i < 12; i++) noteBusyRefusal('box', 'v1', {}, t0 + i * 10 * MIN)
    // The machine's clock stepped back two hours: the row is dated in the future.
    expect(busyRetryLeftMs('box', 'v1', {}, t0 - 2 * 60 * MIN)).toBe(0)
    // Within the stale window but before its last refusal: at most one wait from now.
    expect(busyRetryLeftMs('box', 'v1', {}, t0 + 100 * MIN)).toBeLessThanOrEqual(DAEMON_BUSY_RETRY_MAX_MS)
  })

  it('a wait never runs past the moment the update turns overdue', () => {
    // Refused for an hour (a 15 min wait), with 4 min left before the 3 h bound: the next try comes then.
    expect(busyRetryWaitMs(2 * 60 * MIN, { behindMs: DAEMON_UPDATE_BEHIND_MAX_MS - 4 * MIN })).toBe(4 * MIN)
    // At the bound already (overdue not yet read): the first step, never at once.
    expect(busyRetryWaitMs(2 * 60 * MIN, { behindMs: DAEMON_UPDATE_BEHIND_MAX_MS + MIN })).toBe(MIN)
    // Far from it: the step as it is.
    expect(busyRetryWaitMs(2 * 60 * MIN, { behindMs: 0 })).toBe(DAEMON_BUSY_RETRY_MAX_MS)
    const t0 = 1_800_000_000_000
    // Refused for 20 min (a 5 min wait), 2 min before the bound: 2 min.
    noteBusyRefusal('box', 'v1', {}, t0 - 20 * MIN)
    expect(noteBusyRefusal('box', 'v1', { behindMs: DAEMON_UPDATE_BEHIND_MAX_MS - 2 * MIN }, t0)).toBe(2 * MIN)
  })

  it('a host name with a colon in it has its own row, never a prefix of another name', () => {
    const t0 = 1_800_000_000_000
    noteBusyRefusal('box', 'v1', {}, t0)
    noteBusyRefusal('box:2222', 'v1', {}, t0)
    expect(busyRetryLeftMs('box', 'v1', {}, t0 + 1_000)).toBeGreaterThan(0)
    expect(busyRetryLeftMs('box:2222', 'v1', {}, t0 + 1_000)).toBeGreaterThan(0)
    endBusyRefusals('box')
    expect(busyRetryLeftMs('box', 'v1', {}, t0 + 1_000)).toBe(0)
    expect(busyRetryLeftMs('box:2222', 'v1', {}, t0 + 1_000)).toBeGreaterThan(0)
  })

  it('the CLI asks again within one try after growing pauses: 2, 4, then 8 s', () => {
    const next = busyPauses(2_000)
    expect(Array.from({ length: 6 }, () => next())).toEqual([2_000, 4_000, 8_000, 8_000, 8_000, 8_000])
  })
})

/** Code only: words in a comment do nothing. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const READS = /must finish first|has active operations|daemonBusyRefusal\(|DAEMON_BUSY_WORDS|handoverBusy\(/

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...sources(rel))
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(rel)
  }
  return out
}

describe('every path that asks for an update again after a busy refusal uses the busy clock', () => {
  it('every reader of a busy refusal is listed, and every listed file is there', () => {
    const readers = sources('src').filter((f) => f !== 'src/providers/daemon-busy-retry.ts' && READS.test(read(f)))
    for (const f of readers) expect(BUSY_REFUSAL_READERS[f], `${f} reads a daemon's busy refusal: list it in BUSY_REFUSAL_READERS (daemon-busy-retry.ts) with how it asks again`).toBeDefined()
    for (const f of Object.keys(BUSY_REFUSAL_READERS)) expect(fs.existsSync(path.join(ROOT, f)), `${f} is listed but gone`).toBe(true)
  })

  const clocks = Object.entries(BUSY_REFUSAL_READERS).filter(([, r]) => r.asks === 'clock').map(([f]) => f)

  it.each(clocks)('%s notes every busy refusal it reads on the clock', (f) => {
    const lines = code(read(f)).split('\n')
    const refusals = lines.flatMap((l, i) => (/daemonBusyRefusal\(|if \(outcome === 'busy'\)/.test(l) ? [i] : []))
    expect(refusals.length, `${f}: no busy refusal found; is it still an update path?`).toBeGreaterThan(0)
    for (const i of refusals) {
      expect(lines.slice(i, i + 12).join('\n'), `${f}:${i + 1} reads a busy refusal: its next try must wait on noteBusyRefusal (daemon-busy-retry.ts)`).toMatch(/noteBusyRefusal\(/)
    }
  })

  it.each(clocks)('%s checks the clock before it tries', (f) => {
    expect(code(read(f)), `${f}: a try must wait while busyRetryLeftMs says so (a new server's first try included)`).toMatch(/busyRetryLeftMs\(/)
  })

  it('the asks within one try grow their pauses, and the runner\'s tries are bounded', () => {
    for (const [f] of Object.entries(BUSY_REFUSAL_READERS).filter(([, r]) => r.asks === 'pauses')) {
      const text = code(read(f))
      expect(text, `${f} asks a busy daemon again at a fixed pause`).not.toMatch(/delay\(wait\.pauseMs/)
      // Each function that waits out a busy refusal takes its pauses from busyPauses.
      const loops = text.split(/\n(?=export (?:async )?function )/).filter((fn) => /handoverBusy\(error\)/.test(fn) && /await delay\(/.test(fn))
      expect(loops.length, `${f}: no busy wait found`).toBeGreaterThan(0)
      for (const fn of loops) expect(fn, `${f}: ${fn.slice(0, 80)} waits out a busy daemon without busyPauses`).toMatch(/busyPauses\(/)
    }
    for (const [f] of Object.entries(BUSY_REFUSAL_READERS).filter(([, r]) => r.asks === 'runner')) {
      expect(read(f)).toMatch(/export const RUNNER_TRIES = \d+/)
    }
  })
})
