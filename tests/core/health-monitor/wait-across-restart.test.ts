/**
 * A wait that crosses a server restart leaves out what the earlier server knew
 * was not the delivery path's, and the time no server ran.
 *
 * 2026-11-21, the send.resume alarm at 1,633 s and 1,238 s: two messages were
 * queued in dark wakes at 07:33:36 and 07:40:09 UTC, a deploy stopped the server
 * at 07:40:45 in another dark wake, and the next server started at 08:00:21 when
 * the lid opened. The sleep ledger lived in the old process's memory and nothing
 * recorded the twenty minutes no server ran, so the new server read the whole
 * wait as the resume path's (src/lib/sleep-ledger.ts).
 *
 * The guard: every out-of-path wait a delivery reads (OutOfPathWaits in
 * src/providers/delivery-latency.ts) is named here with the ledger that keeps it
 * on disk and the boot loader that reads it back before the queue loads. A new
 * kind of wait fails here until it says how it survives a restart.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deliveryLatency, type OutOfPathWaits } from '../../../src/providers/delivery-latency.js'
import {
  __resetSleepLedgerForTest, ALIVE_STAMP_MS, flushSleepLedger, loadSleepLedger, noteSleepSinceLastLook,
  serverDownIntervals, sleepIntervals,
} from '../../../src/lib/sleep-ledger.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * Each out-of-path wait, the file that keeps it on disk, its boot loader, and where the loader
 * runs: `before` holds the loader's call and must come before `then` in `file`.
 */
const SERVER = { file: 'src/web/server.ts', before: /acquireInstanceLock\(port\)[\s\S]*?loadSleepLedger\(/, then: /sessionRunner\.init\(reconnectable\)/ }
const RECOVERY = { file: 'src/providers/claude-code-session.ts', before: /const startupRecovery = async \(\) => \{[\s\S]*?await loadHostLinkLedger\(\)/, then: /await loadQueue\(\)/ }
const SURVIVES_RESTART: Record<string, { ledger: string; loader: string; site: typeof SERVER }> = {
  // The server's own, after the instance lock: a CLI running sessions must not write it.
  slept: { ledger: 'src/lib/sleep-ledger.ts', loader: 'loadSleepLedger', site: SERVER },
  serverDown: { ledger: 'src/lib/sleep-ledger.ts', loader: 'loadSleepLedger', site: SERVER },
  linkDown: { ledger: 'src/providers/host-link-ledger.ts', loader: 'loadHostLinkLedger', site: RECOVERY },
}

describe('every out-of-path wait survives a restart', () => {
  it('each OutOfPathWaits field is kept on disk and read back at boot before the queue loads', () => {
    const src = read('src/providers/delivery-latency.ts')
    const body = src.match(/export interface OutOfPathWaits \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const fields = [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1])
    expect(fields.length).toBeGreaterThanOrEqual(3)
    for (const f of fields) {
      expect(SURVIVES_RESTART[f], `OutOfPathWaits.${f} is new: keep it on disk and read it back at boot, then list it in SURVIVES_RESTART`).toBeDefined()
    }
    for (const f of Object.keys(SURVIVES_RESTART)) expect(fields, `SURVIVES_RESTART lists ${f}, which OutOfPathWaits no longer has`).toContain(f)
    // The real waits name every field, so a delivery reads each one.
    const real = src.match(/export const REAL_WAITS: OutOfPathWaits = \{([^}]*)\}/)?.[1] ?? ''
    const session = read('src/providers/claude-code-session.ts')
    const waitsLine = session.match(/const waits: OutOfPathWaits = \{([^\n]*)\}/)?.[1] ?? ''
    for (const f of fields) expect(`${real} ${waitsLine}`, `no delivery reads OutOfPathWaits.${f}`).toMatch(new RegExp(`\\b${f}:`))
    // Each loader runs at boot before the queue is read.
    for (const { ledger, loader, site } of Object.values(SURVIVES_RESTART)) {
      expect(read(ledger), `${ledger} no longer exports ${loader}`).toMatch(new RegExp(`export async function ${loader}\\(`))
      const text = read(site.file)
      const call = text.match(site.before)
      expect(call, `${site.file} no longer calls ${loader} where it must`).not.toBeNull()
      const next = text.slice(call!.index! + call![0].length).search(site.then)
      expect(next, `${loader} must run before ${site.then} in ${site.file}`).toBeGreaterThanOrEqual(0)
      expect(text.slice(0, call!.index!).search(site.then), `${site.then} must not run before ${loader}`).toBe(-1)
    }
    // A CLI that runs sessions (walnut session start) never keeps the server's sleep ledger.
    expect(session).not.toMatch(/loadSleepLedger/)
  })
})

describe('the sleep ledger across a restart', () => {
  let wall = 0
  let mono = 0
  const fake = { now: () => wall, monoNow: () => mono }
  const dirs: string[] = []
  const files = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-ledger-'))
    dirs.push(d)
    return { ledger: path.join(d, 'cache', 'sleep-ledger.json'), alive: path.join(d, 'cache', 'server-alive.json') }
  }
  /** A new server process: nothing in memory, booting at `at`. */
  const boot = (at: number) => { wall = at; mono = 1_000; __resetSleepLedgerForTest(fake) }
  const awake = (ms: number) => {
    // Look every second, as the event-loop probe does.
    for (let left = ms; left > 0; left -= 1_000) { const step = Math.min(1_000, left); wall += step; mono += step; noteSleepSinceLastLook() }
  }
  const asleep = (ms: number) => { wall += ms }
  const total = (list: Array<{ start: number; end: number }>) => list.reduce((n, i) => n + i.end - i.start, 0)
  afterEach(() => {
    __resetSleepLedgerForTest(null)
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  const at = (iso: string) => Date.parse(iso)

  it('the 2026-11-21 07:33 send reads its own few seconds, not 1,633 s', async () => {
    const f = files()
    // The old server, up since 07:06.
    boot(at('2026-11-21T07:06:08.000Z'))
    await loadSleepLedger(f)
    awake(at('2026-11-21T07:33:35.000Z') - wall)
    const enqueuedAt = at('2026-11-21T07:33:36.539Z')
    awake(enqueuedAt - wall)
    asleep(at('2026-11-21T07:40:06.000Z') - wall) // back to sleep, a dark wake at 07:40:06
    awake(at('2026-11-21T07:40:45.000Z') - wall) // a deploy stops this server
    await flushSleepLedger()

    // No server ran until the lid opened and the next one started at 08:00:21.
    boot(at('2026-11-21T08:00:21.210Z'))
    await loadSleepLedger(f)
    awake(at('2026-11-21T08:00:48.939Z') - wall)

    const waits: OutOfPathWaits = { slept: sleepIntervals, serverDown: serverDownIntervals }
    const lat = deliveryLatency([{ id: 'qm-1795246409720-uoajc2', enqueuedAt: new Date(enqueuedAt).toISOString() }], wall, undefined, waits)
    expect(lat.wallMs).toBe(1_632_400)
    expect(lat.sleptMs).toBe(at('2026-11-21T07:40:06.000Z') - enqueuedAt) // 389 s, seen by the old server
    // The old server's last stamp was at most ALIVE_STAMP_MS before it stopped.
    expect(lat.serverDownMs).toBeGreaterThanOrEqual(at('2026-11-21T08:00:21.210Z') - at('2026-11-21T07:40:45.000Z'))
    expect(lat.serverDownMs).toBeLessThanOrEqual(at('2026-11-21T08:00:21.210Z') - at('2026-11-21T07:40:45.000Z') + ALIVE_STAMP_MS)
    // What is left is the time awake in a server: the dark wake and this server's 27 s.
    expect(lat.deliveryMs).toBeLessThan(39_000 + 28_000 + ALIVE_STAMP_MS)
    expect(lat.deliveryMs).toBeGreaterThan(27_000)
  })

  it('reads back the sleep an earlier server saw', async () => {
    const f = files()
    boot(1_000_000)
    await loadSleepLedger(f)
    awake(2_000)
    asleep(300_000)
    awake(1_000)
    await flushSleepLedger()
    const end = wall
    boot(end + 60_000)
    expect(total(sleepIntervals(0, end))).toBe(0) // nothing in memory before the load
    await loadSleepLedger(f)
    expect(total(sleepIntervals(0, end))).toBe(300_000)
  })

  it('the time from the last alive stamp to the next start is server down; a server that ran beside this one adds none', async () => {
    const f = files()
    boot(5_000_000)
    await loadSleepLedger(f)
    awake(25_000) // stamps at the load, then every ALIVE_STAMP_MS
    await flushSleepLedger()
    const stamp = JSON.parse(fs.readFileSync(f.alive, 'utf8')).aliveAt as number
    expect(wall - stamp).toBeLessThan(ALIVE_STAMP_MS)
    boot(wall + 120_000)
    await loadSleepLedger(f)
    expect(serverDownIntervals(0, wall)).toEqual([{ start: stamp, end: wall }])

    // A stamp at or after this process's start: another server ran then, nothing was down.
    const g = files()
    fs.mkdirSync(path.dirname(g.alive), { recursive: true })
    boot(9_000_000)
    fs.writeFileSync(g.alive, JSON.stringify({ v: 1, aliveAt: 9_000_500 }))
    await loadSleepLedger(g)
    expect(serverDownIntervals(0, 10_000_000)).toEqual([])
  })

  it('the first server, and files it cannot read, start empty without throwing', async () => {
    const f = files()
    boot(1_000)
    await loadSleepLedger(f)
    expect(serverDownIntervals(0, 2_000)).toEqual([])
    await flushSleepLedger()
    fs.writeFileSync(f.ledger, '{not json')
    fs.writeFileSync(f.alive, '{"aliveAt":"soon"}')
    boot(50_000)
    await expect(loadSleepLedger(f)).resolves.toBeUndefined()
    expect(serverDownIntervals(0, 60_000)).toEqual([])
    expect(sleepIntervals(0, 60_000)).toEqual([])
  })

  it('a write that fails is told once, and never throws', async () => {
    const f = files()
    // cache/ is a file, so nothing can be written under it.
    fs.writeFileSync(path.dirname(f.ledger), 'not a folder')
    const told: string[] = []
    boot(1_000)
    await loadSleepLedger(f, { onWriteError: (e) => told.push(e) })
    awake(ALIVE_STAMP_MS * 3)
    await flushSleepLedger()
    expect(told).toHaveLength(1)
    expect(told[0]).toMatch(/sleep-ledger\.json|server-alive\.json/)
  })

  it('no file named: the ledger stays in memory, as before', async () => {
    boot(1_000)
    awake(1_000)
    asleep(60_000)
    awake(1_000)
    expect(total(sleepIntervals(0, wall))).toBe(60_000)
    expect(serverDownIntervals(0, wall)).toEqual([])
  })
})

describe('deliveryLatency with no server running', () => {
  const T = Date.parse('2026-11-21T07:40:09.899Z')
  const span = (s: number, e: number) => (from: number, to: number) =>
    Math.min(to, e) > Math.max(from, s) ? [{ start: Math.max(from, s), end: Math.min(to, e) }] : []

  it('sleep, no server and a down link that overlap are left out once, each named for its own share', () => {
    const waits: OutOfPathWaits = {
      slept: span(T + 10_000, T + 60_000),
      serverDown: span(T + 40_000, T + 100_000),
      linkDown: span(T + 90_000, T + 110_000),
    }
    expect(deliveryLatency([{ id: 'a', enqueuedAt: new Date(T).toISOString() }], T + 120_000, undefined, waits))
      .toEqual({ deliveryMs: 20_000, messageId: 'a', wallMs: 120_000, sleptMs: 50_000, serverDownMs: 40_000, linkDownMs: 10_000 })
  })
})
