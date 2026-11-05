/**
 * dial (src/core/hosts/host-exec.ts) against a real link: the quiet check answers on the probe's own
 * clock, so a loop held past the check's time still sends the work when the pong came meanwhile
 * (review 3: the dial's own 3.25 s timer called that link silent, and the call was refused while
 * the probe it had started read alive). This machine's own daemon is never asked, and a host network
 * machine whose relay (this machine's daemon) does not answer either is refused but kept up.
 * Review 4: after a wake or network signal only a pong to a ping sent after it proves the link
 * (bytes in flight at the sleep are read on waking), only the main socket answers the check, a slow
 * link gets the time its round trip needs, and a timer late by any amount watches that much more.
 * Review 5: a download still streaming after a signal keeps the link up (no work goes on it until it
 * answers), and a signal that comes while a dial awaits its check voids what that check heard before.
 *
 * Real pieces: dial() and link() with a config naming the host, a DaemonConnection in the pool over
 * a loopback WebSocket to a MockDaemon, through a proxy that can go silent.
 *
 * MACHINE SAFETY: loopback sockets only; the mock daemon, the proxies and the config are this
 * test's own (a temp home).
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-dial-real'))

import { CONFIG_FILE } from '../../../src/constants.js'
import { dial, type HostExecError } from '../../../src/core/hosts/host-exec.js'
import { resetLinkTargetsForTest } from '../../../src/core/hosts/link.js'
import { DaemonConnection, linkSignalGeneration, pingPayloadId, recheckQuietLinks, setPooledConnectionForTest } from '../../../src/providers/daemon-connection.js'
import { noteHostSignal, resetHostSignalForTest } from '../../../src/providers/daemon-reconnect-cause.js'
import { createMockDaemon, type MockDaemon } from '../../helpers/mock-daemon.js'
import { startSilentLinkProxy, type SilentLinkProxy } from '../../helpers/silent-link-proxy.js'

let daemon: MockDaemon
const cleanups: Array<() => Promise<void> | void> = []

beforeAll(async () => {
  daemon = await createMockDaemon()
  fs.writeFileSync(CONFIG_FILE, 'version: 1\nhosts:\n  pcbox:\n    transport: net\n    hostname: 127.0.0.1\n')
  resetLinkTargetsForTest()
})
afterAll(async () => { await daemon.stop() })
afterEach(async () => {
  for (const host of ['pcbox', '__local__']) setPooledConnectionForTest(host, null)
  for (const c of cleanups.splice(0).reverse()) await c()
  resetHostSignalForTest()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A pooled link to `host` (a host network machine unless `__local__`), through a proxy unless `direct`. */
async function pooled(host: 'pcbox' | '__local__', direct = false): Promise<{ conn: DaemonConnection; proxy: SilentLinkProxy | null }> {
  const conn = new DaemonConnection(host, host === 'pcbox' ? { hostname: '127.0.0.1', via: 'net' } as never : null)
  const proxy = direct ? null : await startSilentLinkProxy(daemon.port)
  await conn.connectDirect(`ws://127.0.0.1:${proxy ? proxy.port : daemon.port}`)
  ;(conn as unknown as { hasCapability: () => boolean }).hasCapability = () => true
  setPooledConnectionForTest(host, conn)
  cleanups.push(async () => { conn.disconnect(); await proxy?.close() })
  return { conn, proxy }
}

/** The dial reads the link as quiet for 30 s, whatever came in just before (the incident's shape). */
function quietFor30s(conn: DaemonConnection): void {
  const recheck = conn.recheckQuiet.bind(conn)
  conn.recheckQuiet = (o) => {
    const old = Date.now() - 30_000
    Object.assign(conn as unknown as Record<string, number>, { lastPongAt: old, _lastFrameAt: old, _lastMainByteAt: old })
    return recheck(o)
  }
}

/** This loop held for `ms` right after the next ping on the link's main socket (the probe's). */
function holdAfterNextPing(conn: DaemonConnection, ms: number): void {
  const ws = (conn as unknown as { ws: { ping: (...a: unknown[]) => void } }).ws
  const ping = ws.ping.bind(ws)
  let armed = true
  ws.ping = (...a: unknown[]) => {
    ping(...a)
    if (!armed) return
    armed = false
    const until = Date.now() + ms
    while (Date.now() < until) { /* this loop is held */ }
  }
}

/** `fn` run inside a socket's data callback, as a request handler runs (Bun orders its immediates differently there). */
function inSocketCallback<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const srv = net.createServer((c) => {
      c.once('data', () => { fn().then(resolve, reject).finally(() => { c.destroy(); srv.close() }) })
    })
    srv.listen(0, '127.0.0.1', () => {
      const cl = net.connect((srv.address() as net.AddressInfo).port, '127.0.0.1', () => cl.write('go'))
      cl.on('error', () => {})
    })
  })
}

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (cond()) return
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * A reply already on its way when the path dies (the Mac falls asleep, or its network changes):
 * the request reaches the daemon, its reply crosses the link 600 ms later, and from the moment the
 * reply is on the wire nothing else crosses. Returns right after the path died, the reply still on
 * its way (wrapped: an awaited promise would wait for it).
 */
async function replyInFlightThenDeadPath(conn: DaemonConnection, proxy: SilentLinkProxy): Promise<{ reply: Promise<string> }> {
  proxy.setMode('slow', { delayMs: 600, bytesPerSec: 50 * 1024 * 1024 })
  daemon.clearCommandHistory()
  const reply = conn.send('fs.ls', { path: os.tmpdir() }, 20_000).then(() => 'answered', (e: Error) => e.message)
  await waitFor(() => daemon.getCommandHistoryFor('fs.ls').length > 0, 'the request at the daemon')
  await sleep(50) // the reply is in the proxy's queue now
  proxy.setMode('blackhole')
  return { reply }
}

const outcome = (p: Promise<unknown>) => p.then(() => 'sent', (e: HostExecError) => `refused ${e.status} ${String(e.data?.quietLink)}`)

describe('the dial\'s quiet check, on a real link', () => {
  it('a loop held 3.5 s right after the check\'s ping still sends: the pong came meanwhile (review 3)', async () => {
    // The daemon shares this process, so its pong cannot even leave while the loop is held: the
    // check's clock fired late, and watched the wire one round more before it judged.
    const { conn } = await pooled('pcbox', true)
    quietFor30s(conn)
    holdAfterNextPing(conn, 3_500)
    expect(await outcome(dial('pcbox', 15_000))).toBe('sent')
    expect(conn.connected).toBe(true)
    expect((await conn.send('fs.ls', { path: os.tmpdir() }, 5_000)).ok).toBe(true)
  }, 30_000)

  it('a hold that ends 200 ms past the check\'s deadline, in a request\'s socket callback, still sends (review 4)', async () => {
    // A 300 ms overrun got no extra watch, and the check closed a healthy link.
    const { conn } = await pooled('pcbox', true)
    quietFor30s(conn)
    holdAfterNextPing(conn, 3_200)
    expect(await inSocketCallback(() => outcome(dial('pcbox', 15_000)))).toBe('sent')
    expect(conn.connected).toBe(true)
  }, 30_000)

  it('a slow link that answers gets the time its round trip needs: sent (review 4)', async () => {
    // A 3.4 s round trip was refused at the check's old 3 s cap, its pong 0.4 s later.
    const { conn, proxy } = await pooled('pcbox')
    await sleep(300)
    proxy!.setMode('slow', { delayMs: 1_700, bytesPerSec: 50 * 1024 * 1024 })
    conn.recordRoundTrip(3_400)
    quietFor30s(conn)
    expect(await outcome(dial('pcbox', 15_000))).toBe('sent')
    expect(conn.connected).toBe(true)
  }, 30_000)

  it('a dead link whose probe a slow round trip stretched past the dial\'s time: refused silent by then, left to the probe', async () => {
    const { conn, proxy } = await pooled('pcbox')
    conn.recordRoundTrip(4_000) // the probe's own deadline is now 8.5 s
    quietFor30s(conn)
    proxy!.setMode('blackhole')
    await sleep(300)
    const t0 = Date.now()
    expect(await outcome(dial('pcbox', 4_000))).toBe('refused 503 silent')
    expect(Date.now() - t0).toBeLessThan(6_000)
    expect(conn.connected).toBe(true)
  }, 30_000)

  it('this machine\'s own daemon is never asked: a quiet loopback link that does not answer still gets the work (review 3)', async () => {
    const { conn, proxy } = await pooled('__local__')
    const asked = vi.spyOn(conn, 'recheckQuiet')
    quietFor30s(conn)
    proxy!.setMode('blackhole')
    const t0 = Date.now()
    expect(await outcome(dial('__local__', 15_000))).toBe('sent')
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(asked).not.toHaveBeenCalled()
  }, 30_000)

  it('a host network link whose relay (this machine\'s daemon) does not answer either is refused, and stays up (review 3)', async () => {
    const net = await pooled('pcbox')
    const local = await pooled('__local__')
    quietFor30s(net.conn)
    net.proxy!.setMode('blackhole')
    local.proxy!.setMode('blackhole')
    await sleep(300)
    expect(await outcome(dial('pcbox', 15_000))).toBe('refused 503 silent')
    await sleep(1_500) // past the probe's own verdict
    expect(net.conn.connected).toBe(true)
  }, 30_000)

  it('one whose relay answers is closed so it reconnects, and the refusal says so', async () => {
    const net = await pooled('pcbox')
    await pooled('__local__', true)
    quietFor30s(net.conn)
    net.proxy!.setMode('blackhole')
    await sleep(300)
    expect(await outcome(dial('pcbox', 15_000))).toBe('refused 503 dropped')
    expect(net.conn.connected).toBe(false)
  }, 30_000)
})

describe('after a wake or network signal, and with the main socket dead', () => {
  it('a reply in flight when the path died lands during the wake recheck: not an answer, the link is closed and the dial sends nothing (review 4)', async () => {
    const { conn, proxy } = await pooled('pcbox')
    await sleep(300)
    const { reply } = await replyInFlightThenDeadPath(conn, proxy!)
    let landed = 0
    void reply.then(() => { landed = Date.now() })
    // The signal's recheck as host-connect-action runs it; the old reply arrives about 0.5 s in.
    const checkedAt = Date.now()
    expect(await recheckQuietLinks({ quietMs: 0, deadlineMs: 3_000 })).toEqual({ pcbox: 'dropped' })
    expect(landed).toBeGreaterThan(checkedAt) // it did land inside the check
    expect(await reply).toBe('answered')
    expect(conn.connected).toBe(false)
    expect(await outcome(dial('pcbox', 3_000))).toMatch(/^refused 503/)
  }, 30_000)

  it('a dial after a signal takes only a pong to a ping sent since, however lately the link was heard (review 4)', async () => {
    const { conn, proxy } = await pooled('pcbox')
    await sleep(300)
    const { reply } = await replyInFlightThenDeadPath(conn, proxy!)
    let landed = 0
    void reply.then(() => { landed = Date.now() })
    noteHostSignal(Date.now()) // a wake, before any recheck ran
    // Heard under a second ago, and the old reply lands inside the check: neither proves the path.
    const checkedAt = Date.now()
    expect(await outcome(dial('pcbox', 15_000))).toBe('refused 503 silent')
    expect(landed).toBeGreaterThan(checkedAt)
    expect(await reply).toBe('answered')
    // Its check closes the link one window after its deadline, not at it (review 6).
    await waitFor(() => !conn.connected, 'the close after one more window', 8_000)
  }, 30_000)

  it('a busy link whose path died 2 s before a network signal is asked anyway: dropped, and the dial 11 s on sends nothing (review 4)', async () => {
    const { conn, proxy } = await pooled('pcbox')
    for (let i = 0; i < 5; i++) { await conn.send('fs.ls', { path: os.tmpdir() }, 2_000); await sleep(300) }
    proxy!.setMode('blackhole')
    const diedAt = Date.now()
    await sleep(2_000)
    // Even with the old wiring's 5 s window: the signal makes every link prove itself.
    expect(await recheckQuietLinks({ quietMs: 5_000, deadlineMs: 3_000 })).toEqual({ pcbox: 'dropped' })
    await sleep(Math.max(0, 11_000 - (Date.now() - diedAt)))
    expect(await outcome(dial('pcbox', 3_000))).toMatch(/^refused 503/)
  }, 40_000)

  it('bytes on a bulk socket on a live path never answer the check of a dead main socket: refused, kept up (review 4)', async () => {
    // Review 3 fixed the 'heard' shortcut; the probe still took bulk bytes, and exec.run went into
    // the dead main socket.
    const p1 = await startSilentLinkProxy(daemon.port)
    const p2 = await startSilentLinkProxy(daemon.port)
    const conn = new DaemonConnection('pcbox', { hostname: '127.0.0.1', via: 'net' } as never)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-dial-bulk-')), 'big.txt')
    fs.writeFileSync(file, 'x'.repeat(4 * 1024 * 1024))
    cleanups.push(async () => { conn.disconnect(); await p1.close(); await p2.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }) })
    await conn.connectDirect(`ws://127.0.0.1:${p1.port}`)
    ;(conn as unknown as { hasCapability: () => boolean }).hasCapability = () => true
    setPooledConnectionForTest('pcbox', conn)
    // A relay that does not answer either keeps the link up after the verdict.
    const local = await pooled('__local__')
    await waitFor(() => conn.bulkChannelActive, 'the bulk socket')
    // The bulk socket comes up again on a live, slow path (p2); the main socket stays on p1.
    const bulk = conn as unknown as { _lastWsUrl: string; dialBulkChannel: () => void }
    bulk._lastWsUrl = `ws://127.0.0.1:${p2.port}`
    bulk.dialBulkChannel()
    await waitFor(() => conn.bulkChannelActive && p2.accepted() > 0, 'the bulk socket on p2')
    p2.setMode('slow', { delayMs: 0, bytesPerSec: 1024 * 1024 })
    p1.setMode('blackhole')
    local.proxy!.setMode('blackhole')
    await sleep(300)
    quietFor30s(conn)
    const read = conn.send('fs.read', { path: file }, 30_000).then(() => 'read', (e: Error) => e.message)
    await sleep(200)
    const heard = conn.heardBytes
    expect(await outcome(dial('pcbox', 15_000))).toBe('refused 503 silent')
    expect(conn.heardBytes).toBeGreaterThan(heard) // the bulk read was streaming all along
    expect(conn.connected).toBe(true)
    void read
  }, 40_000)

  it('a healthy link carrying a download on one shared link, its relay answering: the signal\'s check keeps it, no work goes on it until it answers, the download finishes (review 5)', async () => {
    // Its pong waited behind the download, so the check closed a healthy link and failed the read.
    const { conn, proxy } = await pooled('pcbox')
    await pooled('__local__', true) // the relay (this machine's daemon) answers
    await waitFor(() => conn.bulkChannelActive, 'the bulk socket')
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-dial-download-')), 'big.txt')
    fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024))
    cleanups.push(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }))
    proxy!.setMode('slow', { delayMs: 0, bytesPerSec: 256 * 1024, shared: true, queueBytes: 4 * 1024 * 1024 })
    const read = conn.send('fs.read', { path: file }, 60_000).then((r) => (r.ok ? 'read' : 'refused'), (e: Error) => e.message)
    await sleep(500)
    const heard = conn.heardBytes
    expect(await recheckQuietLinks({ quietMs: 0, deadlineMs: 3_000 })).toEqual({ pcbox: 'silent' })
    expect(conn.heardBytes - heard).toBeGreaterThan(256 * 1024) // the download went on through the check
    expect(conn.connected).toBe(true)
    // No pong to a ping sent since the signal yet: the download's bytes let no work onto the main socket.
    expect(await outcome(dial('pcbox', 3_000))).toBe('refused 503 silent')
    expect(await read).toBe('read')
    expect(conn.connected).toBe(true)
    // The queue drained and the check's pong came: the link has proven itself.
    expect(await outcome(dial('pcbox', 15_000))).toBe('sent')
  }, 60_000)

  /**
   * Until nothing has come on the link for `ms`: the replies to the pushes right after a connect
   * would otherwise cross the slowed path inside the scenario and read as the far side still sending.
   */
  async function wireQuiet(conn: DaemonConnection, ms = 600): Promise<void> {
    let last = conn.heardBytes
    let quietSince = Date.now()
    for (const until = Date.now() + 15_000; Date.now() < until;) {
      await sleep(50)
      if (conn.heardBytes !== last) { last = conn.heardBytes; quietSince = Date.now() } else if (Date.now() - quietSince >= ms) return
    }
    throw new Error('the link never went quiet')
  }

  /** Pongs to pings of a generation before `gen()` and of it, as they land on the link's main socket. */
  function watchPongs(conn: DaemonConnection, gen: () => number): { oldAt: number; freshAt: number } {
    const seen = { oldAt: 0, freshAt: 0 }
    const ws = (conn as unknown as { ws: { on: (e: 'pong', fn: (d: Buffer) => void) => void } }).ws
    ws.on('pong', (d) => {
      const ping = pingPayloadId(d)
      if (!ping) return
      if (ping.gen < gen()) { if (!seen.oldAt) seen.oldAt = Date.now() } else if (!seen.freshAt) seen.freshAt = Date.now()
    })
    return seen
  }

  it('a signal while a dial awaits a delayed pong voids that pong: on a path dead since, the dial sends nothing (review 5)', async () => {
    // The pong to the dial's own ping, already on its way back when the path died, answered the dial
    // after the signal, and the work went into the dead path.
    const { conn, proxy } = await pooled('pcbox')
    await waitFor(() => conn.bulkChannelActive, 'the bulk socket')
    ;(conn as unknown as { closeBulkChannel: () => void }).closeBulkChannel()
    await wireQuiet(conn)
    proxy!.setMode('slow', { delayMs: 600, bytesPerSec: 50 * 1024 * 1024 })
    quietFor30s(conn)
    let signalAt = Infinity
    let signalGen = Infinity
    const pongs = watchPongs(conn, () => signalGen)
    const t0 = Date.now()
    const dialed = outcome(dial('pcbox', 15_000))
    await sleep(900) // the check's ping is across (600 ms), its pong on its way back (lands at 1.2 s)
    proxy!.setMode('blackhole')
    signalAt = Date.now()
    noteHostSignal(signalAt)
    signalGen = linkSignalGeneration()
    const recheck = recheckQuietLinks({ quietMs: 0, deadlineMs: 3_000 })
    expect(await dialed).toBe('refused 503 silent')
    expect(pongs.oldAt).toBeGreaterThan(signalAt) // the old pong did land inside the dial's check
    expect(Date.now() - t0).toBeGreaterThan(2_000) // and did not answer it
    expect(await recheck).toEqual({ pcbox: 'dropped' })
    expect(conn.connected).toBe(false)
  }, 30_000)

  it('a signal while a dial awaits a delayed pong, the new path slower: the older check never closes the healthy link, and no work goes before a pong to a ping sent since (review 5)', async () => {
    // The older check's own pong came after the signal and no longer counts; the newer check's pong
    // comes after the older check's deadline. Closing there would drop a healthy link.
    const { conn, proxy } = await pooled('pcbox')
    await waitFor(() => conn.bulkChannelActive, 'the bulk socket')
    ;(conn as unknown as { closeBulkChannel: () => void }).closeBulkChannel()
    await wireQuiet(conn)
    proxy!.setMode('slow', { delayMs: 600, bytesPerSec: 50 * 1024 * 1024 })
    quietFor30s(conn)
    let signalAt = Infinity
    let signalGen = Infinity
    const pongs = watchPongs(conn, () => signalGen)
    let dialDoneAt = 0
    const dialed = outcome(dial('pcbox', 15_000)).finally(() => { dialDoneAt = Date.now() })
    await sleep(900) // as above: the older pong lands at 1.2 s, before the older check's second half
    proxy!.setMode('slow', { delayMs: 1_200, bytesPerSec: 50 * 1024 * 1024 }) // the network changed: a slower path
    signalAt = Date.now()
    noteHostSignal(signalAt)
    signalGen = linkSignalGeneration()
    const recheck = recheckQuietLinks({ quietMs: 0, deadlineMs: 3_000 })
    const verdict = await dialed
    expect(conn.connected).toBe(true)
    // Sent only once a pong to a ping sent after the signal came (a loaded run's late timer can wait for it).
    if (verdict === 'sent') expect(dialDoneAt).toBeGreaterThanOrEqual(pongs.freshAt)
    else expect(verdict).toBe('refused 503 silent')
    expect(await recheck).toEqual({ pcbox: 'alive' })
    expect(pongs.oldAt).toBeGreaterThan(signalAt)
    expect(conn.connected).toBe(true)
    expect(await outcome(dial('pcbox', 15_000))).toBe('sent')
  }, 30_000)

  it('a network change to a healthy path with a 3.5 s round trip, only the old fast one measured, its relay answering: the link stays up, dials are refused until the new path answers, then sent (review 6)', async () => {
    // The check's 3 s deadline came from the old path's round trips, and it closed the healthy link.
    const { conn, proxy } = await pooled('pcbox')
    await pooled('__local__', true) // the relay (this machine's daemon) answers
    await waitFor(() => conn.bulkChannelActive, 'the bulk socket')
    ;(conn as unknown as { closeBulkChannel: () => void }).closeBulkChannel()
    await wireQuiet(conn)
    expect(conn.roundTripMs).toBeLessThan(500) // only the fast path's round trip is known
    proxy!.setMode('slow', { delayMs: 1_750, bytesPerSec: 50 * 1024 * 1024 }) // the new path
    let signalGen = Infinity
    const pongs = watchPongs(conn, () => signalGen)
    const t0 = Date.now()
    const recheck = recheckQuietLinks({ quietMs: 0, deadlineMs: 3_000 }) // counts the signal at once
    signalGen = linkSignalGeneration()
    // The new path has not answered yet: refused, nothing sent.
    expect(await outcome(dial('pcbox', 1_000))).toBe('refused 503 silent')
    // Past the check's deadline with still no answer, the link is up (it was closed right here).
    await sleep(Math.max(0, 3_250 - (Date.now() - t0)))
    expect(pongs.freshAt).toBe(0)
    expect(conn.connected).toBe(true)
    expect(await recheck).toEqual({ pcbox: 'alive' })
    expect(pongs.freshAt - t0).toBeGreaterThan(3_000) // the new path's pong, at about 3.5 s
    expect(conn.connected).toBe(true)
    expect(await outcome(dial('pcbox', 15_000))).toBe('sent')
  }, 30_000)
})
