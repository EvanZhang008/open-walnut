/**
 * wait_for's port and file looks (src/providers/host-exec-probe.ts), from the 2026-11-04 code
 * review and usability review:
 *
 *   - a TCP connect that reached itself (simultaneous open on a port in the ephemeral range) is no
 *     listener (self-connect.ts made probePort report one that did not exist);
 *   - a file look counts as stuck (the JS twin's exit then SIGKILLs itself) only past an absolute
 *     age, never past a short deadline a look near a wait's bound gets;
 *   - a found file comes with its size: an empty file a job made and has not written yet is 0;
 *   - a file not found says why when a look can tell (2026-11-04 usability review: each read as
 *     "before it appeared"): a directory on its path closed to the user, a symlink to nothing;
 *   - on a host with socket tables (Linux) a listener is read from them, never connected to, so a
 *     server that serves one client (`nc -l`) is not used up by the look (2026-11-04 code review).
 *
 * MACHINE SAFETY: the sockets are stand-ins, except one loopback listener on a free port; the
 * files are in a temp dir.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { STUCK_LOOK_MS, lookFile, lookPort, probeFile, probePort, resetTablesForTest, stuckFileLooks, tableListeners } from '../../src/providers/host-exec-probe.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-probe-')))
afterAll(() => { if (root.includes('walnut-host-exec-probe-')) fs.rmSync(root, { recursive: true, force: true }) })

/** A socket that connects at once, from `localPort`. */
function connected(port: number, localPort: number) {
  return () => {
    const sock = Object.assign(new EventEmitter(), { localPort, localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', remotePort: port, destroy() { return sock } })
    setImmediate(() => sock.emit('connect'))
    return sock as unknown as net.Socket
  }
}

describe('a port look', () => {
  it('a connect that reached itself is no listener; one to another socket is', async () => {
    // A host with no socket tables (a Mac) connects.
    const noTable = async () => null
    expect(await probePort(40_123, 300, ['127.0.0.1'], connected(40_123, 40_123), noTable, () => false, false)).toBeNull()
    expect(await probePort(40_123, 300, ['127.0.0.1'], connected(40_123, 51_000), noTable, () => false, false)).toBe('127.0.0.1:40123')
  })

  it('reads listeners from the socket tables: an address, a wildcard, IPv6, and nothing but LISTEN', async () => {
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
    const tcp = head
      + '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1\n' // 127.0.0.1:8080 LISTEN
      + '   1: 00000000:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2\n' // 0.0.0.0:8081 LISTEN
      + '   2: 0100007F:1F92 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 3\n' // 8082 ESTABLISHED only
    const tcp6 = head
      + '   0: 00000000000000000000000001000000:1F93 00000000000000000000000000000000:0000 0A 0 0 0 1000 0 4\n' // [::1]:8083
      + '   1: 00000000000000000000000000000000:1F94 00000000000000000000000000000000:0000 0A 0 0 0 1000 0 5\n' // [::]:8084
      + '   2: 0000000000000000FFFF00000A00000A:1F95 00000000000000000000000000000000:0000 0A 0 0 0 1000 0 6\n' // ::ffff:10.0.0.10
    const read = async (p: string) => (p.endsWith('tcp6') ? tcp6 : tcp)
    expect(await tableListeners(8080, read)).toEqual(['127.0.0.1'])
    expect(await tableListeners(8081, read)).toEqual(['0.0.0.0'])
    expect(await tableListeners(8082, read)).toEqual([])
    expect(await tableListeners(8083, read)).toEqual(['::1'])
    expect(await tableListeners(8084, read)).toEqual(['::'])
    expect(await tableListeners(8085, read)).toEqual(['10.0.0.10'])
    expect(await tableListeners(8080, async () => { throw new Error('ENOENT') })).toBeNull()
    const never = () => { throw new Error('a table hit never connects') }
    const all = ['127.0.0.1', '::1', '10.0.0.10']
    expect(await probePort(8081, 300, all, never, (port) => tableListeners(port, read))).toBe('127.0.0.1:8081')
    expect(await probePort(8084, 300, all, never, (port) => tableListeners(port, read))).toBe('[::1]:8084')
    expect(await probePort(8085, 300, all, never, (port) => tableListeners(port, read))).toBe('10.0.0.10:8085')
    // A table that names nothing for the port is the answer: the look never connects (a one-shot
    // server that began listening right after the read would take the connect as its client)...
    expect(await probePort(8090, 300, ['127.0.0.1'], never, (port) => tableListeners(port, read), () => false)).toBeNull()
    // ...except on a host whose tables miss listeners (WSL: a Windows program's port).
    expect(await probePort(8090, 300, ['127.0.0.1'], connected(8090, 51_000), (port) => tableListeners(port, read), () => true)).toBe('127.0.0.1:8090')
  })

  it('a table read that does not answer in time is a look that saw nothing, never a connect; only one read is ever in flight', async () => {
    resetTablesForTest()
    let reads = 0
    const stuck = () => { reads += 1; return new Promise<string>(() => { /* a thread pool held by a stuck mount */ }) }
    const t0 = Date.now()
    expect(await tableListeners(8080, stuck, 100)).toBeNull()
    expect(await tableListeners(8080, stuck, 100)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(reads).toBe(2) // one read per table file, started once and waited on by both looks
    // 2026-11-05 code review: on the node twin with its pool held, a one-shot server got the look as its only client.
    const never = () => { throw new Error('a late table read never connects') }
    const t1 = Date.now()
    expect(await probePort(8091, 150, ['127.0.0.1'], never, (port) => tableListeners(port, stuck, 100), () => false, true)).toBeNull()
    expect(Date.now() - t1).toBeLessThan(1_000)
    expect(reads).toBe(2)
    // The look says it could not look, so the wait's answer can (2026-11-05 code review: ten minutes
    // of "did not see port N listening" on a host whose tables never answered).
    expect(await lookPort(8091, 150, ['127.0.0.1'], never, (port) => tableListeners(port, stuck, 100), () => false, true)).toEqual({ at: null, unread: true })
    expect(await lookPort(8091, 150, ['127.0.0.1'], never, async () => [], () => false, true)).toEqual({ at: null })
    // Where the tables miss listeners (WSL), a late read still gives way to a connect.
    expect(await probePort(8091, 150, ['127.0.0.1'], connected(8091, 51_000), (port) => tableListeners(port, stuck, 100), () => true, true)).toBe('127.0.0.1:8091')
    resetTablesForTest()
  })

  it('finds a listener in a table of 200 000 sockets quickly', async () => {
    resetTablesForTest()
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
    const row = (i: number) => `${String(i).padStart(6)}: 0A00000A:${(10_000 + (i % 50_000)).toString(16).toUpperCase().padStart(4, '0')} 0B00000A:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 ${i}\n`
    const big = head + Array.from({ length: 200_000 }, (_, i) => row(i)).join('') + '200000: 0100007F:EA60 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9\n'
    const read = async (p: string) => (p.endsWith('tcp6') ? head : big)
    const t0 = performance.now()
    expect(await tableListeners(60_000, read)).toEqual(['127.0.0.1'])
    // Split row by row this took 423 ms; found by text it is a few ms (the bound leaves room for a loaded host).
    expect(performance.now() - t0).toBeLessThan(300)
    resetTablesForTest()
  })

  it.runIf(fs.existsSync('/proc/net/tcp'))('a server that serves one client is not used up by the look', async () => {
    let clients = 0
    const server = net.createServer((sock) => { clients += 1; sock.destroy() })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as net.AddressInfo
    try {
      for (let i = 0; i < 3; i += 1) expect(await probePort(port)).toBe(`127.0.0.1:${port}`)
      await new Promise((r) => setTimeout(r, 50))
      expect(clients).toBe(0)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('a file look', () => {
  it('is stuck only once it has been in flight STUCK_LOOK_MS, not when it passed its own short deadline', async () => {
    let release = () => {}
    const slow = () => new Promise((r) => { release = () => r({ size: 1 }) })
    expect(await probeFile(path.join(root, 'slow-mount'), 200, slow)).toBe('unanswered')
    // Past its 200 ms deadline, but only just in flight: an orderly exit, no SIGKILL.
    expect(stuckFileLooks()).toBe(0)
    expect(stuckFileLooks(Date.now() + STUCK_LOOK_MS)).toBe(1)
    release()
    // Its answer came: once the look has taken it, nothing is in flight.
    await vi.waitFor(() => expect(stuckFileLooks(Date.now() + 10 * STUCK_LOOK_MS)).toBe(0), { timeout: 5_000, interval: 10 })
  })

  it('a found file says its size: 0 for one made and not written yet', async () => {
    const empty = path.join(root, 'big.json')
    fs.writeFileSync(empty, '')
    expect(await lookFile(empty)).toEqual({ state: 'yes', size: 0 })
    fs.writeFileSync(empty, '{"a":1}')
    expect(await lookFile(empty)).toEqual({ state: 'yes', size: 7 })
    expect(await lookFile(path.join(root, 'none'))).toEqual({ state: 'no' })
    // A directory is found as one: its size says nothing of what it holds.
    const dir = path.join(root, 'a-dir')
    fs.mkdirSync(dir)
    expect(await lookFile(dir)).toEqual({ state: 'yes', size: null, dir: true })
    expect(await probeFile(empty)).toBe('yes')
  })

  it('a file not found says why when a look can tell: closed to the user, or a symlink to a path that does not exist', async () => {
    const link = path.join(root, 'link')
    fs.symlinkSync(path.join(root, 'no-such-target'), link)
    expect(await lookFile(link)).toEqual({ state: 'dangling' })
    // Once its target exists, it counts (as `test -e`).
    fs.writeFileSync(path.join(root, 'no-such-target'), 'ok')
    expect(await lookFile(link)).toEqual({ state: 'yes', size: 2 })
    const denied = () => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
    expect(await lookFile('/root/secret.txt', 500, denied)).toEqual({ state: 'denied' })
    const gone = () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    expect(await lookFile(path.join(root, 'none-2'), 500, gone)).toEqual({ state: 'no' })
  })
})
