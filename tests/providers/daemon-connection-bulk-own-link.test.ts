/**
 * A host reached over SSH gets a bulk channel on an SSH connection of its own
 * (daemon-connection.ts bulkForward). 2026-11-10: the relay path to a dev host
 * ended an SSH connection every few MB carried up, and a file copied onto the
 * host (fs.writePart) through the session tunnel took the session link down,
 * once per retry: host.link.lost 8 an hour. Pins:
 *   - O1: the bulk socket rides the forward, and the uploads ride the bulk socket;
 *   - O2: the forward's connection ending drops only the bulk channel (the session
 *     link stays up), and an upload sent meanwhile waits for the new bulk socket
 *     instead of taking the session link;
 *   - O3: an upload whose bulk channel does not come back in time rides the session link;
 *   - O4: a forward that cannot open leaves the bulk channel on the session link, and
 *     uploads go at once;
 *   - O5: bytes heard on that bulk socket never count as the session link's (its pongs
 *     would otherwise keep a dead session link reading alive);
 *   - O6: fs.write rides the bulk channel only when big;
 *   - O7: own connections that keep ending soon back off before they dial again.
 * The mock forward is a TCP proxy to the mock daemon (no SSH in tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { _setBulkForwardForTesting, type LaneForward } from '../../src/providers/stream-lane.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }
type Statics = { BULK_REDIAL_DELAY_MS: number; BULK_UPLOAD_WAIT_MS: number }
const statics = DaemonConnection as unknown as Statics

async function waitFor(cond: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** A forward like ssh -L: a local port onto the daemon's, which `cut()` ends as the relay does. */
async function proxyForward(daemonPort: number): Promise<LaneForward & { cut(): void; accepted: () => number }> {
  const sockets = new Set<net.Socket>()
  let accepted = 0
  const server = net.createServer((client) => {
    accepted++
    const up = net.connect(daemonPort, '127.0.0.1')
    sockets.add(client); sockets.add(up)
    client.pipe(up); up.pipe(client)
    const end = () => { client.destroy(); up.destroy() }
    client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  const exitCbs: Array<(why: string) => void> = []
  let exited: string | null = null
  const finish = (why: string) => {
    if (exited !== null) return
    exited = why
    server.close()
    for (const s of sockets) s.destroy()
    for (const cb of exitCbs.splice(0)) cb(why)
  }
  return {
    port,
    onExit: (cb) => { if (exited !== null) cb(exited); else exitCbs.push(cb) },
    stop: () => finish('stopped'),
    cut: () => finish('code 255: client_loop: send disconnect: Broken pipe'),
    accepted: () => accepted,
  }
}

describe('DaemonConnection: the bulk channel on a connection of its own', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection
  let forwards: Array<Awaited<ReturnType<typeof proxyForward>>>
  let saved: Statics

  beforeEach(async () => {
    saved = { BULK_REDIAL_DELAY_MS: statics.BULK_REDIAL_DELAY_MS, BULK_UPLOAD_WAIT_MS: statics.BULK_UPLOAD_WAIT_MS }
    statics.BULK_REDIAL_DELAY_MS = 300
    daemon = await createMockDaemon()
    forwards = []
  })

  afterEach(async () => {
    Object.assign(statics, saved)
    _setBulkForwardForTesting(null)
    try { conn.disconnect() } catch { /* best effort */ }
    for (const f of forwards) f.stop()
    await daemon.stop()
  })

  async function connectWithForward(): Promise<void> {
    _setBulkForwardForTesting(async () => {
      const f = await proxyForward(daemon.port)
      forwards.push(f)
      return f
    })
    conn = new DaemonConnection('bulk-own-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn.bulkChannelActive, 5_000, 'bulk channel up')
  }

  it('O1: the bulk socket rides its own forward, and uploads ride it', async () => {
    await connectWithForward()
    expect(forwards).toHaveLength(1)
    expect(forwards[0].accepted()).toBe(1)
    daemon.clearCommandHistory()
    await conn.send('fs.writePart', { path: '/tmp/x', offset: 0, data: 'AAAA' })
    await conn.send('fs.ls', { path: '/tmp' })
    expect(daemon.getCommandHistoryFor('fs.writePart')[0].connIndex).toBe(1)
    expect(daemon.getCommandHistoryFor('fs.ls')[0].connIndex).toBe(0)
  })

  it('O2: the forward ending drops only the bulk channel; an upload waits for the new one', async () => {
    await connectWithForward()
    forwards[0].cut()
    await waitFor(() => !conn.bulkChannelActive, 5_000, 'bulk channel down')
    expect(conn.connected).toBe(true)
    daemon.clearCommandHistory()
    // Sent while the bulk channel is down: it waits for the redial, never the session link.
    const reply = await conn.send('fs.writePart', { path: '/tmp/x', offset: 0, data: 'AAAA' })
    expect(reply).toBeDefined()
    expect(forwards).toHaveLength(2)
    const parts = daemon.getCommandHistoryFor('fs.writePart')
    expect(parts).toHaveLength(1)
    expect(parts[0].connIndex).toBeGreaterThan(1)
    expect(conn.connected).toBe(true)
    // A download goes on whichever socket is open, as before.
    await conn.send('fs.ls', { path: '/tmp' })
    expect(daemon.getCommandHistoryFor('fs.ls')[0].connIndex).toBe(0)
  })

  it('O3: an upload whose bulk channel does not come back in time rides the session link', async () => {
    await connectWithForward()
    statics.BULK_REDIAL_DELAY_MS = 60_000
    statics.BULK_UPLOAD_WAIT_MS = 300
    forwards[0].cut()
    await waitFor(() => !conn.bulkChannelActive, 5_000, 'bulk channel down')
    daemon.clearCommandHistory()
    const startedAt = Date.now()
    await conn.send('fs.writePart', { path: '/tmp/x', offset: 0, data: 'AAAA' })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250)
    expect(daemon.getCommandHistoryFor('fs.writePart')[0].connIndex).toBe(0)
  })

  it('O5: bytes and replies on the own-connection bulk socket are not the session link\'s', async () => {
    await connectWithForward()
    const file = path.join(os.tmpdir(), `bulk-own-${process.pid}-${Date.now()}.bin`)
    fs.writeFileSync(file, Buffer.alloc(300 * 1024, 7))
    try {
      const c = conn as unknown as { _heardBytes: number; _ownBulkHeardBytes: number; _lastReplyAt: number }
      // Let the connect's own pushes (hooks, bridge, slice) answer first: quiet for 500 ms.
      let last = c._lastReplyAt
      let quietSince = Date.now()
      await waitFor(() => {
        if (c._lastReplyAt !== last) { last = c._lastReplyAt; quietSince = Date.now() }
        return Date.now() - quietSince >= 500
      }, 10_000, 'the session link to go quiet')
      const heard = c._heardBytes
      const own = c._ownBulkHeardBytes
      const replyAt = c._lastReplyAt
      const read = await conn.send('fs.read', { path: file, encoding: 'base64' })
      expect(read.ok).toBe(true)
      expect(c._ownBulkHeardBytes - own).toBeGreaterThan(300 * 1024)
      // The session link heard at most its own small frames meanwhile, not the 400 KB reply.
      expect(c._heardBytes - heard).toBeLessThan(20_000)
      // Nor is the reply an answer of the session link (checkUpstream reads _lastReplyAt).
      expect(c._lastReplyAt).toBe(replyAt)
    } finally {
      fs.rmSync(file, { force: true })
    }
  })

  it('O6: a small fs.write stays on the session link, a big one rides the bulk channel', async () => {
    await connectWithForward()
    daemon.clearCommandHistory()
    await conn.send('fs.write', { path: '/tmp/small', data: 'AAAA', encoding: 'base64' })
    await conn.send('fs.write', { path: '/tmp/big', data: 'A'.repeat(300 * 1024), encoding: 'base64' })
    const writes = daemon.getCommandHistoryFor('fs.write')
    expect(writes.map((w) => [w.payload.path, w.connIndex])).toEqual([['/tmp/small', 0], ['/tmp/big', 1]])
  })

  it('O7: own connections that end soon after opening back off', async () => {
    await connectWithForward()
    forwards[0].cut()
    await waitFor(() => forwards.length === 2 && conn.bulkChannelActive, 5_000, 'first redial')
    const cutAt = Date.now()
    forwards[1].cut()
    // Two short lives in a row: the redial waits twice the base delay (600 ms here, not 300).
    await waitFor(() => forwards.length === 3, 5_000, 'second redial')
    expect(Date.now() - cutAt).toBeGreaterThanOrEqual(550)
  })

  it('O4: a forward that cannot open leaves the bulk channel on the session link, with no wait', async () => {
    _setBulkForwardForTesting(async () => { throw new Error('its SSH forward did not open (Permission denied)') })
    statics.BULK_UPLOAD_WAIT_MS = 5_000
    conn = new DaemonConnection('bulk-own-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn.bulkChannelActive, 5_000, 'bulk channel up on the session tunnel')
    daemon.clearCommandHistory()
    await conn.send('fs.writePart', { path: '/tmp/x', offset: 0, data: 'AAAA' })
    expect(daemon.getCommandHistoryFor('fs.writePart')[0].connIndex).toBe(1)
  })
})
