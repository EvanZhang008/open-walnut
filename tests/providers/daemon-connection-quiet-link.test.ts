/**
 * DaemonConnection.recheckQuiet: a link that has been quiet is asked whether it still answers.
 * 2026-11-04: after a 6-minute sleep of the Mac, its link to a host network machine answered
 * nothing for 30 s before the ping loop dropped it, and a pinned run sent on it 11 s after the
 * wake was lost (the machine never created the job).
 *
 * Real pieces: DaemonConnection over a loopback WebSocket to a MockDaemon, through a proxy that
 * can go silent (a black hole: bytes in, nothing out), as a link that died out of sight does.
 *
 * MACHINE SAFETY: loopback sockets only; the mock daemon and the proxies are this test's own.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-quiet-link'))

import { DaemonConnection, recheckQuietLinks, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { noteHostSignal, resetHostSignalForTest } from '../../src/providers/daemon-reconnect-cause.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { startSilentLinkProxy } from '../helpers/silent-link-proxy.js'

let daemon: MockDaemon
beforeAll(async () => { daemon = await createMockDaemon() })
afterAll(async () => { await daemon.stop() })
afterEach(() => { resetHostSignalForTest(); vi.restoreAllMocks() })

/** A link to `host`: an SSH host's by default, a host network machine's with `net` (no SSH: the probe closes it). */
async function linked(host = 'devbox', net = false) {
  const conn = new DaemonConnection(host, net ? { hostname: '127.0.0.1', via: 'net' } as never : null)
  const proxy = await startSilentLinkProxy(daemon.port)
  await conn.connectDirect(`ws://127.0.0.1:${proxy.port}`)
  return { conn, proxy, done: async () => { conn.disconnect(); await proxy.close() } }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Until nothing has come on the link for `ms`: the replies to the pushes right after a connect
 * would otherwise cross a slowed path inside the check.
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

/**
 * Make the proxy a black hole and let what was already on its way land first: the daemon's pushes
 * right after a connect could otherwise arrive inside the probe and read as an answer (a test that
 * flaked under a loaded run).
 */
async function blackhole(proxy: { setMode: (m: 'blackhole') => void }): Promise<void> {
  proxy.setMode('blackhole')
  await sleep(300)
}

describe('a quiet link, asked again', () => {
  it('one heard from within quietMs is not asked; one that answers is alive', async () => {
    const { conn, done } = await linked()
    try {
      expect(await conn.recheckQuiet({ quietMs: 60_000, deadlineMs: 500 })).toBe('heard')
      expect(await conn.recheckQuiet({ quietMs: 0, deadlineMs: 1_500 })).toBe('alive')
      expect(conn.connected).toBe(true)
    } finally { await done() }
  })

  it('a silent one with no SSH (a host network machine) is closed, and what waits on it fails now', async () => {
    const { conn, proxy, done } = await linked('pcbox', true)
    try {
      await blackhole(proxy)
      const waiting = conn.send('fs.ls', { path: '/' }).then(() => null, (e: Error) => e)
      const t0 = Date.now()
      expect(await conn.recheckQuiet({ quietMs: 0, deadlineMs: 300 })).toBe('dropped')
      expect(conn.connected).toBe(false)
      expect((await waiting)?.message).toBe('DaemonConnection not connected to pcbox: the link stopped answering')
      expect(Date.now() - t0).toBeLessThan(2_000)
    } finally { await done() }
  }, 20_000)

  it('a silent SSH host is only reported silent and left to its ping loop: a busy daemon can hold a pong there', async () => {
    const { conn, proxy, done } = await linked()
    try {
      await blackhole(proxy)
      expect(await conn.recheckQuiet({ quietMs: 0, deadlineMs: 300 })).toBe('silent')
      expect(conn.connected).toBe(true)
    } finally { await done() }
  }, 20_000)

  it('a socket that took the probed one\'s place during the probe is alive, and stays (2026-11-05 review)', async () => {
    // The old socket closed while the probe ran and a caller's dial brought up a new one: the
    // recheck closed the new, healthy socket, and a run sent on it read "may have started".
    const p1 = await startSilentLinkProxy(daemon.port)
    const p2 = await startSilentLinkProxy(daemon.port)
    const conn = new DaemonConnection('devbox', null)
    await conn.connectDirect(`ws://127.0.0.1:${p1.port}`)
    try {
      p1.setMode('blackhole')
      const verdict = conn.recheckQuiet({ quietMs: 0, deadlineMs: 2_500 })
      await sleep(100)
      p1.setMode('drop-hold')
      for (let i = 0; i < 50 && conn.connected; i++) await sleep(20)
      expect(conn.connected).toBe(false)
      await conn.connectDirect(`ws://127.0.0.1:${p2.port}`)
      expect(await verdict).toBe('alive')
      expect(conn.connected).toBe(true)
      expect(await conn.send('fs.ls', { path: '/' }, 2_000).then(() => 'answered', (e: Error) => e.message)).toBe('answered')
    } finally {
      conn.disconnect()
      await p1.close()
      await p2.close()
    }
  }, 30_000)

  it('a recheck never counts as a missed pong: checks asked often leave an SSH link to its ping loop (2026-11-05 review)', async () => {
    const { conn, proxy, done } = await linked()
    try {
      await blackhole(proxy)
      for (let i = 0; i < 3; i++) expect(await conn.recheckQuiet({ quietMs: 0, deadlineMs: 200 })).toBe('silent')
      expect((conn as unknown as { _missedPongs: number })._missedPongs).toBe(0)
      expect(conn.connected).toBe(true)
    } finally { await done() }
  }, 20_000)

  it('a link a probe just found silent is not "heard" from its last byte; it is asked again (2026-11-05 review)', async () => {
    const { conn, proxy, done } = await linked()
    try {
      await blackhole(proxy)
      expect(await conn.recheckQuiet({ quietMs: 0, deadlineMs: 200 })).toBe('silent')
      // Its last byte came well within 60 s, but the verdict since says it has not answered.
      expect(await conn.recheckQuiet({ quietMs: 60_000, deadlineMs: 200 })).toBe('silent')
    } finally { await done() }
  }, 20_000)

  it('this loop held past the probe\'s deadline still reads the pong that came meanwhile: alive, never dropped (2026-11-05 review)', async () => {
    // A 3.5 s stall here dropped a host network link whose pong came back in 1 ms.
    // Here the daemon and the proxy share this process, so its pong cannot even be sent while the
    // loop is held: a timer that fired well past its time watches the wire one round more.
    const { conn, done } = await linked('pcbox', true)
    try {
      const verdict = conn.recheckQuiet({ quietMs: 0, deadlineMs: 300 })
      const until = Date.now() + 2_500
      while (Date.now() < until) { /* this loop is held past the probe's deadline */ }
      expect(await verdict).toBe('alive')
      expect(conn.connected).toBe(true)
    } finally { await done() }
  }, 20_000)

  it('a probe of a socket since replaced is never handed to a caller of the new one, a read\'s or a check\'s (review 3)', async () => {
    // The old probe ran on a socket that closed; a caller on the new, healthy socket joined it and
    // read 'silent' at its timer, though nobody had pinged the new socket.
    const p1 = await startSilentLinkProxy(daemon.port)
    const p2 = await startSilentLinkProxy(daemon.port)
    const conn = new DaemonConnection('devbox', null)
    await conn.connectDirect(`ws://127.0.0.1:${p1.port}`)
    try {
      p1.setMode('blackhole')
      const oldRead = conn.probeLiveness(3_000, { countMiss: false })
      const oldCheck = conn.recheckQuiet({ quietMs: 0, deadlineMs: 3_000 })
      await sleep(100)
      p1.setMode('drop-hold')
      for (let i = 0; i < 50 && conn.connected; i++) await sleep(20)
      await conn.connectDirect(`ws://127.0.0.1:${p2.port}`)
      const t0 = Date.now()
      expect(await conn.recheckQuiet({ quietMs: 0, deadlineMs: 1_500 })).toBe('alive')
      expect(await conn.probeLiveness(1_500)).toBe(true)
      expect(Date.now() - t0).toBeLessThan(1_000)
      expect(await oldRead).toBe(false)
      expect(await oldCheck).toBe('alive') // its socket was replaced by one that answered
    } finally {
      conn.disconnect()
      await p1.close()
      await p2.close()
    }
  }, 30_000)

  it('bytes on the bulk socket never make a quiet main socket "heard"; they still count as heard bytes (review 3)', async () => {
    // A bulk socket redialled after a wake can sit on a live path while the main socket sits on a
    // dead one: its bytes said nothing of where the work would go.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-quiet-bulk-')), 'read.txt')
    fs.writeFileSync(file, 'x'.repeat(4_096))
    // Its own daemon: another test's sockets on the shared one bring frames to every client.
    const own = await createMockDaemon()
    const conn = new DaemonConnection('devbox', null)
    await conn.connectDirect(`ws://127.0.0.1:${own.port}`)
    try {
      for (let i = 0; i < 250 && !conn.bulkChannelActive; i++) await sleep(20)
      expect(conn.bulkChannelActive).toBe(true)
      const old = Date.now() - 30_000
      Object.assign(conn as unknown as Record<string, number>, { lastPongAt: old, _lastFrameAt: old, _lastMainByteAt: old })
      const before = conn.heardBytes
      own.clearCommandHistory()
      expect((await conn.send('fs.read', { path: file }, 5_000)).ok).toBe(true)
      expect(own.getCommandHistoryFor('fs.read')[0].connIndex).toBeGreaterThan(0)
      expect(conn.heardBytes).toBeGreaterThan(before)
      // Asked (and answering), not taken as heard from 30 s ago.
      expect(await conn.recheckQuiet({ quietMs: 20_000, deadlineMs: 1_500 })).toBe('alive')
    } finally {
      conn.disconnect()
      await own.stop()
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  }, 20_000)

  it('a link that closed by itself during the check is down: Walnut did not close it (review 3)', async () => {
    const { conn, proxy, done } = await linked('pcbox', true)
    try {
      await blackhole(proxy)
      const verdict = conn.recheckQuiet({ quietMs: 0, deadlineMs: 2_000 })
      await sleep(100)
      proxy.setMode('drop-hold')
      expect(await verdict).toBe('down')
    } finally { await done() }
  }, 20_000)

  it('nothing connected is down', async () => {
    expect(await new DaemonConnection('devbox', null).recheckQuiet({ quietMs: 0, deadlineMs: 100 })).toBe('down')
  })
})

describe('after a wake or a network change', () => {
  it('every quiet link to another machine is asked at once; a host network one whose relay answers is closed', async () => {
    const net = await linked('pcbox', true)
    const ssh = await linked('devbox')
    const local = await linked('__local__')
    setPooledConnectionForTest('pcbox', net.conn)
    setPooledConnectionForTest('devbox', ssh.conn)
    setPooledConnectionForTest('__local__', local.conn)
    try {
      for (const l of [net, ssh]) l.proxy.setMode('blackhole')
      await sleep(300)
      expect(await recheckQuietLinks({ quietMs: 0, deadlineMs: 300 })).toEqual({ pcbox: 'dropped', devbox: 'silent' })
      expect(net.conn.connected).toBe(false)
      expect(ssh.conn.connected).toBe(true)
      expect(local.conn.connected).toBe(true)
    } finally {
      for (const h of ['pcbox', 'devbox', '__local__']) setPooledConnectionForTest(h, null)
      for (const l of [net, ssh, local]) await l.done()
    }
  }, 20_000)

  it('a host network link whose relay (this machine\'s own daemon) is not answering either reads silent and stays up (review 3)', async () => {
    // Its pong rides that daemon's forward: a starved local daemon is no proof the far side is gone.
    const net = await linked('pcbox', true)
    const local = await linked('__local__')
    setPooledConnectionForTest('pcbox', net.conn)
    setPooledConnectionForTest('__local__', local.conn)
    try {
      for (const l of [net, local]) l.proxy.setMode('blackhole')
      await sleep(300)
      expect(await recheckQuietLinks({ quietMs: 0, deadlineMs: 300 })).toEqual({ pcbox: 'silent' })
      expect(net.conn.connected).toBe(true)
      expect(local.conn.connected).toBe(true)
    } finally {
      for (const h of ['pcbox', '__local__']) setPooledConnectionForTest(h, null)
      for (const l of [net, local]) await l.done()
    }
  }, 20_000)

  it('a signal during a check voids what it heard: the check asks again within the caller\'s time, and answers on a pong to a ping sent since (review 5)', async () => {
    // The pong to the check's own ping, sent before the signal, answered it after the signal.
    const { conn, proxy, done } = await linked()
    try {
      await wireQuiet(conn)
      proxy.setMode('slow', { delayMs: 600, bytesPerSec: 50 * 1024 * 1024 })
      const t0 = Date.now()
      // Its probe's own deadline is 1.5 s; the caller has 6 s.
      const verdict = conn.recheckQuiet({ quietMs: 0, deadlineMs: 1_500, withinMs: 6_000 })
      await sleep(500)
      noteHostSignal(Date.now()) // a wake: its pong (due back at 1.2 s) proves nothing now
      expect(await verdict).toBe('alive')
      // Answered by the ping sent at 1.5 s (back at 2.7 s), not by the old one.
      expect(Date.now() - t0).toBeGreaterThan(2_200)
      expect(conn.connected).toBe(true)
    } finally { await done() }
  }, 20_000)

  it('a check\'s probe takes no answer from before the newest signal, also when the signal came after the probe began (review 5)', async () => {
    // Its acceptance was fixed when it began: a pong to its own ping, sent before the signal,
    // answered it after the signal.
    const { conn, proxy, done } = await linked()
    try {
      await wireQuiet(conn)
      proxy.setMode('slow', { delayMs: 600, bytesPerSec: 50 * 1024 * 1024 })
      const verdict = conn.recheckQuiet({ quietMs: 0, deadlineMs: 2_000 })
      const probe = (conn as unknown as { _checkProbe: { answered: () => boolean; promise: Promise<boolean> } })._checkProbe
      let settled: boolean | null = null
      void probe.promise.then((v) => { settled = v })
      let oldPongAt = 0
      ;(conn as unknown as { ws: { on: (e: 'pong', fn: () => void) => void } }).ws.on('pong', () => { if (!oldPongAt) oldPongAt = Date.now() })
      await sleep(500)
      const signalAt = Date.now()
      noteHostSignal(signalAt) // its pong is due back at 1.2 s
      for (let i = 0; i < 100 && !oldPongAt; i++) await sleep(20)
      expect(oldPongAt).toBeGreaterThan(signalAt)
      await sleep(50)
      expect(probe.answered()).toBe(false)
      expect(settled).toBe(null)
      // Nothing sent since the signal answered within the caller's time (the probe's own).
      expect(await verdict).toBe('silent')
      expect(settled).toBe(false)
      expect(conn.connected).toBe(true)
    } finally { await done() }
  }, 20_000)

  describe('a ping and a signal in the same millisecond (review 6)', () => {
    // Times cannot order them: a ping whose timestamp equalled the signal's read as sent after it.
    it('ping first, then the signal: its pong proves nothing, and on a path dead since the check reads silent', async () => {
      const { conn, proxy, done } = await linked()
      try {
        await wireQuiet(conn)
        proxy.setMode('slow', { delayMs: 600, bytesPerSec: 50 * 1024 * 1024 })
        let pongs = 0
        ;(conn as unknown as { ws: { on: (e: 'pong', fn: () => void) => void } }).ws.on('pong', () => { pongs++ })
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
        const verdict = conn.recheckQuiet({ quietMs: 0, deadlineMs: 3_000, withinMs: 3_000 }) // its ping, this millisecond
        const probe = (conn as unknown as { _checkProbe: { superseded: () => boolean } })._checkProbe
        noteHostSignal(Date.now()) // then a signal, the same millisecond
        clock.mockRestore()
        expect(probe.superseded()).toBe(true)
        await sleep(900)
        proxy.setMode('blackhole') // the old pong is on its way back (due at 1.2 s); nothing else crosses
        expect(await verdict).toBe('silent')
        expect(pongs).toBeGreaterThan(0) // the old pong did land during the check
      } finally { await done() }
    }, 20_000)

    it('the signal first, then the ping: its pong proves the path', async () => {
      const { conn, proxy, done } = await linked()
      try {
        await wireQuiet(conn)
        proxy.setMode('slow', { delayMs: 600, bytesPerSec: 50 * 1024 * 1024 })
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
        noteHostSignal(Date.now())
        const verdict = conn.recheckQuiet({ quietMs: 0, deadlineMs: 3_000, withinMs: 3_000 }) // its ping, the same millisecond
        clock.mockRestore()
        expect(await verdict).toBe('alive')
        expect(conn.connected).toBe(true)
      } finally { await done() }
    }, 20_000)
  })
})
