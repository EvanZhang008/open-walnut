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
 *   - O3: a background upload whose bulk channel does not come back in time fails with
 *     nothing sent, never the session link (2026-11-11: uploads fell back there and took it
 *     down); a person's own upload still rides the session link after the wait;
 *   - O4: a forward that cannot open leaves the bulk channel on the session link, and
 *     uploads go at once;
 *   - O5: bytes heard on that bulk socket never count as the session link's (its pongs
 *     would otherwise keep a dead session link reading alive);
 *   - O6: fs.write rides the bulk channel only when big;
 *   - O7: own connections that keep ending soon back off before they dial again;
 *   - O8: the host's whole read copy rides the bulk channel unbound (host-slice-unbound-v1),
 *     after leader.configure bound the session socket; its probe stays on the session link;
 *   - O9: a daemon that refuses leader.configure takes the copy bound, on the session link;
 *   - O10: a read sent while MB of upload parts wait on the paced connection takes the session
 *     link and answers at once (2026-11-12: history reads behind parts said "did not answer in
 *     time" while the link read connected); with nothing waiting it rides the bulk channel;
 *   - O11: a read whose answer never comes fails alone while uploads still move on the channel:
 *     the channel and the parts on it stay (2026-11-12: reads timed out behind 1 MB parts, each
 *     timeout ended the channel and cut the part going up, over and over, and a move failed).
 *   - O13: a host whose second login is refused from the first dial (no own connection yet in this
 *     process, as after a server restart under an expired certificate) holds background uploads too,
 *     and the retry opens beside the channel in use: a command on it is not cut by a failed retry;
 *   - O12: an own connection that worked and then will not open (2026-11-14: an expired SSH
 *     certificate while the session link still rode its old master) keeps background uploads off
 *     the session link, lets a person's upload through, and is dialled again until it opens.
 * The mock forward is a TCP proxy to the mock daemon (no SSH in tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { _setBulkForwardForTesting, type LaneForward } from '../../src/providers/stream-lane.js'
import { pacedForward } from '../../src/providers/paced-forward.js'
import { linkFailureKind } from '../../src/providers/link-failure.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }
type Statics = { BULK_REDIAL_DELAY_MS: number; BULK_UPLOAD_WAIT_MS: number; BULK_OWN_RETRY_MS: number }
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
    saved = { BULK_REDIAL_DELAY_MS: statics.BULK_REDIAL_DELAY_MS, BULK_UPLOAD_WAIT_MS: statics.BULK_UPLOAD_WAIT_MS, BULK_OWN_RETRY_MS: statics.BULK_OWN_RETRY_MS }
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

  async function connectWithForward(pace?: { bytesPerSec: number; burstBytes: number }): Promise<void> {
    _setBulkForwardForTesting(async () => {
      const f = await proxyForward(daemon.port)
      forwards.push(f)
      return pace ? pacedForward(f, pace) : f
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

  it('O3: a background upload whose bulk channel does not come back in time fails with nothing sent', async () => {
    await connectWithForward()
    statics.BULK_REDIAL_DELAY_MS = 60_000
    statics.BULK_UPLOAD_WAIT_MS = 300
    forwards[0].cut()
    await waitFor(() => !conn.bulkChannelActive, 5_000, 'bulk channel down')
    daemon.clearCommandHistory()
    const startedAt = Date.now()
    for (const [cmd, params] of [
      ['fs.writePart', { path: '/tmp/x', offset: 0, data: 'AAAA' }],
      ['replica.put', { home: '/h', kind: 'notes', files: [{ path: 'a.md', data: 'AAAA' }] }],
      ['host.slice', { sliceGz: 'AAAA', bind: false }],
    ] as const) {
      const err = await conn.send(cmd, params as Record<string, unknown>).then(() => null, (e: Error) => e)
      expect(err?.message, cmd).toMatch(/nothing was sent/)
      expect(linkFailureKind(err), cmd).toBe('no-link')
    }
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250)
    // None reached the daemon, and the session link is still up.
    for (const cmd of ['fs.writePart', 'replica.put']) expect(daemon.getCommandHistoryFor(cmd), cmd).toEqual([])
    expect(daemon.getCommandHistoryFor('host.slice').filter((c) => c.payload.bind === false)).toEqual([])
    expect(conn.connected).toBe(true)
    // A person's own upload (a picture pasted into a session, a file saved) is not lost: after
    // the wait it rides the session link.
    await conn.send('fs.write', { path: '/tmp/big', data: 'A'.repeat(300 * 1024), encoding: 'base64' })
    expect(daemon.getCommandHistoryFor('fs.write')[0].connIndex).toBe(0)
    // A small command still goes on the session link at once.
    await conn.send('fs.ls', { path: '/tmp' })
    expect(daemon.getCommandHistoryFor('fs.ls')[0].connIndex).toBe(0)
  })

  it('O8: the whole host copy rides the bulk channel unbound, after leader.configure on the session link', async () => {
    daemon.answerWith('leader.configure', { epoch: 1, holder: 'primary' })
    await connectWithForward()
    await waitFor(() => daemon.getCommandHistoryFor('host.slice').some((c) => typeof c.payload.sliceGz === 'string'), 10_000, 'the host copy')
    const slices = daemon.getCommandHistoryFor('host.slice')
    const copy = slices.find((c) => typeof c.payload.sliceGz === 'string')!
    expect(copy.payload.bind).toBe(false)
    expect(copy.connIndex).toBe(1)
    // The probe (names the copy, carries no bytes) binds the session socket and stays there.
    for (const probe of slices.filter((c) => c.payload.sliceGz === undefined)) expect(probe.connIndex).toBe(0)
    const leader = daemon.getCommandHistoryFor('leader.configure')
    expect(leader.length).toBeGreaterThanOrEqual(1)
    expect(leader[0].connIndex).toBe(0)
    expect(leader[0].timestamp).toBeLessThanOrEqual(copy.timestamp)
  })

  it('O9: a daemon that refuses leader.configure takes the copy bound, on the session link', async () => {
    await connectWithForward()
    await waitFor(() => daemon.getCommandHistoryFor('host.slice').some((c) => typeof c.payload.sliceGz === 'string'), 10_000, 'the host copy')
    const copy = daemon.getCommandHistoryFor('host.slice').find((c) => typeof c.payload.sliceGz === 'string')!
    expect(copy.payload.bind).toBeUndefined()
    expect(copy.connIndex).toBe(0)
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

  it('O10: a read sent while MB of upload parts wait on the paced connection takes the session link and answers at once', async () => {
    // 1 MB/s here stands for the relay's 20 KB/s: 3 MB ahead would hold a read 3 s on the bulk channel.
    await connectWithForward({ bytesPerSec: 1024 * 1024, burstBytes: 32 * 1024 })
    const file = path.join(os.tmpdir(), `bulk-own-q-${process.pid}-${Date.now()}.bin`)
    fs.writeFileSync(file, Buffer.alloc(8 * 1024, 7))
    try {
      daemon.clearCommandHistory()
      const part = 'A'.repeat(1024 * 1024)
      // The mock answers a part it has no handler for with ok:false; what counts is that each is answered.
      const parts = [0, 1, 2].map((i) => conn.send('fs.writePart', { path: '/tmp/q', offset: i * part.length, data: part }, 60_000))
      const startedAt = Date.now()
      const read = await conn.send('fs.readRange', { path: file, start: 0, length: 4096 }, 1_000)
      expect(read.ok).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(daemon.getCommandHistoryFor('fs.readRange')[0].connIndex).toBe(0)
      await Promise.all(parts)
      expect(forwards).toHaveLength(1)
      expect(daemon.getCommandHistoryFor('fs.writePart').map((c) => c.connIndex)).toEqual([1, 1, 1])
      // With nothing waiting to go up, a read rides the bulk channel again.
      await conn.send('fs.readRange', { path: file, start: 0, length: 4096 }, 1_000)
      expect(daemon.getCommandHistoryFor('fs.readRange')[1].connIndex).toBe(1)
    } finally {
      fs.rmSync(file, { force: true })
    }
  }, 20_000)

  it('O11: a read whose answer never comes fails alone while uploads still move behind it; the channel and its parts stay', async () => {
    await connectWithForward({ bytesPerSec: 1024 * 1024, burstBytes: 32 * 1024 })
    const part = 'A'.repeat(1024 * 1024)
    const send = (i: number) => conn.send('fs.writePart', { path: '/tmp/q', offset: i * part.length, data: part }, 60_000)
    daemon.clearCommandHistory()
    daemon.swallowNextCommand('fs.readRange')
    // Sent on an empty queue, it rides the bulk channel; parts after it keep the channel busy past its last window.
    const read = conn.send('fs.readRange', { path: '/tmp/none', start: 0, length: 4096 }, 1_000)
    const behind = [0, 1, 2, 3, 4, 5].map(send)
    await expect(read).rejects.toThrow(/daemon command timeout: fs.readRange/)
    expect(daemon.getCommandHistoryFor('fs.readRange')[0].connIndex).toBe(1)
    await Promise.all(behind)
    expect(forwards).toHaveLength(1)
    expect(daemon.getCommandHistoryFor('fs.writePart')).toHaveLength(6)
  }, 30_000)

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
    // A host that takes no second connection (not a refused login): as before, no wait, no retry.
    _setBulkForwardForTesting(async () => { throw new Error('its SSH forward did not open (channel 0: open failed: administratively prohibited)') })
    statics.BULK_UPLOAD_WAIT_MS = 5_000
    conn = new DaemonConnection('bulk-single-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn.bulkChannelActive, 5_000, 'bulk channel up on the session tunnel')
    daemon.clearCommandHistory()
    await conn.send('fs.writePart', { path: '/tmp/x', offset: 0, data: 'AAAA' })
    expect(daemon.getCommandHistoryFor('fs.writePart')[0].connIndex).toBe(1)
  })
  it('O12: an own connection that worked and now will not open keeps background uploads off the session link, and is dialled again', async () => {
    let refuse = false
    _setBulkForwardForTesting(async () => {
      if (refuse) throw new Error('its SSH forward did not open (code 255: Permission denied (publickey).)')
      const f = await proxyForward(daemon.port)
      forwards.push(f)
      return f
    })
    conn = new DaemonConnection('bulk-own-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn.bulkChannelActive, 5_000, 'bulk channel up')
    statics.BULK_OWN_RETRY_MS = 60_000
    statics.BULK_UPLOAD_WAIT_MS = 300
    refuse = true
    forwards[0].cut()
    // The redial is refused: the channel rides the session tunnel for now.
    await waitFor(() => conn.bulkChannelActive && (conn as unknown as { bulkSocketOwn: boolean }).bulkSocketOwn === false
      && (conn as unknown as { bulkOwnWanted: boolean }).bulkOwnWanted, 5_000, 'bulk channel on the session tunnel')
    daemon.clearCommandHistory()
    const err = await conn.send('fs.writePart', { path: '/tmp/x', offset: 0, data: 'AAAA' }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/nothing was sent/)
    expect(linkFailureKind(err)).toBe('no-link')
    expect(daemon.getCommandHistoryFor('fs.writePart')).toEqual([])
    // A person's own upload is not held.
    await conn.send('fs.write', { path: '/tmp/big', data: 'A'.repeat(300 * 1024), encoding: 'base64' })
    expect(daemon.getCommandHistoryFor('fs.write')).toHaveLength(1)
    // The login works again: the retry finds it, and uploads ride the own connection.
    refuse = false
    statics.BULK_OWN_RETRY_MS = 100
    // The pending retry waits a minute: start it again on a short clock (the next try's timer).
    const c = conn as unknown as { bulkOwnRetryTimer: ReturnType<typeof setTimeout> | null; retryBulkOwnLink(): void }
    if (c.bulkOwnRetryTimer) clearTimeout(c.bulkOwnRetryTimer)
    c.bulkOwnRetryTimer = null
    c.retryBulkOwnLink()
    await waitFor(() => forwards.length === 2 && conn.bulkChannelActive && (conn as unknown as { bulkSocketOwn: boolean }).bulkSocketOwn, 5_000, 'own connection back')
    daemon.clearCommandHistory()
    await conn.send('fs.writePart', { path: '/tmp/x', offset: 0, data: 'AAAA' })
    expect(daemon.getCommandHistoryFor('fs.writePart')).toHaveLength(1)
    expect((conn as unknown as { bulkOwnWanted: boolean }).bulkOwnWanted).toBe(false)
  })
  it('O14: while the own connection is refused, a big automatic copy is not sent on the session link, a small one is, and the held one goes when it opens', async () => {
    let refuse = true
    _setBulkForwardForTesting(async () => {
      if (refuse) throw new Error('its SSH forward did not open (code 255: user@devbox: Permission denied (publickey).)')
      const f = await proxyForward(daemon.port)
      forwards.push(f)
      return f
    })
    statics.BULK_OWN_RETRY_MS = 60_000
    conn = new DaemonConnection('bulk-copy-held-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn.bulkChannelActive && (conn as unknown as { bulkOwnWanted: boolean }).bulkOwnWanted, 5_000, 'own connection wanted')
    const repushed: string[] = []
    ;(conn as unknown as { repushCopy(cmd: string): void }).repushCopy = (cmd) => { repushed.push(cmd) }
    daemon.clearCommandHistory()
    for (const cmd of DaemonConnection.AUTOMATIC_COPIES) {
      const err = await conn.send(cmd, { blob: 'A'.repeat(DaemonConnection.COPY_HOLD_BYTES) }).then(() => null, (e: Error) => e)
      expect(err?.message, cmd).toMatch(/waits for the upload channel's own connection.*nothing was sent/)
      expect(linkFailureKind(err)).toBe('no-link')
      expect(daemon.getCommandHistoryFor(cmd), cmd).toEqual([])
    }
    // A dial in progress (a reconnect under the same refused login) sets bulkOwnLink before it
    // knows the login works: the copy still waits.
    const d = conn as unknown as { bulkOwnLink: boolean }
    d.bulkOwnLink = true
    const during = await conn.send('skills.sync', { blob: 'A'.repeat(DaemonConnection.COPY_HOLD_BYTES) }).then(() => null, (e: Error) => e)
    expect(during?.message).toMatch(/nothing was sent/)
    d.bulkOwnLink = false
    // A small one (a probe naming a hash) still goes.
    await conn.send('host.slice', { home: '/h', hash: 'abc', asOf: 1 })
    expect(daemon.getCommandHistoryFor('host.slice')).toHaveLength(1)
    expect(conn.connected).toBe(true)
    // The login works again: every held copy is pushed again, once.
    refuse = false
    statics.BULK_OWN_RETRY_MS = 100
    const c = conn as unknown as { bulkOwnRetryTimer: ReturnType<typeof setTimeout> | null; retryBulkOwnLink(): void }
    if (c.bulkOwnRetryTimer) clearTimeout(c.bulkOwnRetryTimer)
    c.bulkOwnRetryTimer = null
    c.retryBulkOwnLink()
    await waitFor(() => (conn as unknown as { bulkSocketOwn: boolean }).bulkSocketOwn, 5_000, 'own connection back')
    expect(repushed.sort()).toEqual([...DaemonConnection.AUTOMATIC_COPIES].sort())
  })

  // Every copy Walnut pushes by itself is in AUTOMATIC_COPIES and has a re-push: a new push*()
  // command that is not would ride the session link whole under a refused login.
  it('O15: every command a push*() method sends is an automatic copy with a re-push', () => {
    const src = fs.readFileSync(path.resolve('src/providers/daemon-connection.ts'), 'utf8')
    const sent = new Set<string>()
    const starts = [...src.matchAll(/^  (?:private |public )?(?:async )?push[A-Z]\w*\([^)]*\)[^{\n]*\{$/gm)]
    expect(starts.length).toBeGreaterThan(4)
    for (const m of starts) {
      const from = m.index! + m[0].length
      const end = src.indexOf('\n  }\n', from)
      for (const s of src.slice(from, end).matchAll(/this\.send\('([^']+)'/g)) sent.add(s[1])
    }
    expect([...sent].sort()).toEqual([...DaemonConnection.AUTOMATIC_COPIES].sort())
    const repush = src.slice(src.indexOf('private repushCopy('), src.indexOf('\n  }\n', src.indexOf('private repushCopy(')))
    for (const cmd of DaemonConnection.AUTOMATIC_COPIES) expect(repush, cmd).toContain(`case '${cmd}':`)
  })

  it('O13: a login refused from the first dial holds background uploads, and a failed retry cuts nothing in flight', async () => {
    let tries = 0
    _setBulkForwardForTesting(async () => { tries++; throw new Error('its SSH forward did not open (code 255: user@devbox: Permission denied (publickey).)') })
    statics.BULK_OWN_RETRY_MS = 150
    statics.BULK_UPLOAD_WAIT_MS = 300
    conn = new DaemonConnection('bulk-refused-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn.bulkChannelActive && (conn as unknown as { bulkOwnWanted: boolean }).bulkOwnWanted, 5_000, 'bulk channel on the session tunnel, own wanted')
    daemon.clearCommandHistory()
    const err = await conn.send('replica.put', { home: '/h', kind: 'notes', files: [{ path: 'a.md', data: 'AAAA' }] }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/its own SSH connection will not open: .*Permission denied/)
    expect(daemon.getCommandHistoryFor('replica.put')).toEqual([])
    // Retries run on their own and leave the channel in use alone: a big read on it keeps going.
    const bulkBefore = (conn as unknown as { bulkWs: unknown }).bulkWs
    await waitFor(() => tries >= 3, 5_000, 'two retries')
    expect((conn as unknown as { bulkWs: unknown }).bulkWs).toBe(bulkBefore)
    expect(conn.connected).toBe(true)
  })
})
