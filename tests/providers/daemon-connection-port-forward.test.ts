/**
 * DaemonConnection.ensurePortForward — the SSH local forward behind embedded VS
 * Code and service previews, with `ssh` replaced by a fake that does what ssh
 * does locally: listen on the `-L` local port. Everything else is the real
 * class: the key format, reuse, the in-flight dedupe, eviction, and close.
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => [] as Array<{ args: string[]; killed: boolean; server: import('node:net').Server | null }>)

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn((cmd: string, args: string[]) => {
      if (cmd !== 'ssh') return original.spawn(cmd, args)
      const proc = new EventEmitter() as EventEmitter & {
        exitCode: number | null; stderr: PassThrough; unref(): void; kill(sig?: string): boolean
      }
      proc.stderr = new PassThrough()
      proc.unref = () => {}
      if (!args.includes('-L')) {
        // ControlMaster housekeeping (`-O exit` on disconnect): exits at once.
        proc.exitCode = 0
        proc.kill = () => true
        setImmediate(() => proc.emit('exit', 0))
        return proc
      }
      const rec = { args, killed: false, server: null as import('node:net').Server | null }
      spawned.push(rec)
      proc.exitCode = null
      proc.kill = () => {
        rec.killed = true
        rec.server?.close()
        proc.exitCode = 143
        setImmediate(() => proc.emit('exit', 143))
        return true
      }
      const spec = args[args.indexOf('-L') + 1]
      const localPort = Number(spec.split(':')[0])
      // Like ssh: bind shortly after spawn.
      setTimeout(() => {
        const srv = net.createServer((sock) => sock.end())
        srv.listen(localPort, '127.0.0.1')
        rec.server = srv
      }, 20)
      return proc
    }),
  }
})

import { DaemonConnection } from '../../src/providers/daemon-connection.js'

const TARGET = { hostname: 'dev-box.corp.example.test', user: 'developer', port: undefined }
const conns: DaemonConnection[] = []

function makeConn(): DaemonConnection {
  const c = new DaemonConnection('studio', TARGET)
  conns.push(c)
  return c
}

const forwardSpec = (i: number) => {
  const a = spawned[i].args
  return a[a.indexOf('-L') + 1]
}

afterEach(() => {
  for (const c of conns.splice(0)) c.disconnect()
  for (const s of spawned.splice(0)) s.server?.close()
})

describe('ensurePortForward', () => {
  it('defaults to 127.0.0.1 on the host (the embedded VS Code call is unchanged)', async () => {
    const conn = makeConn()
    const local = await conn.ensurePortForward(39000)
    expect(forwardSpec(0)).toBe(`${local}:127.0.0.1:39000`)
    expect(spawned[0].args.at(-1)).toBe('developer@dev-box.corp.example.test')
  })

  it('forwards to the named target, and reuses a live forward per target:port', async () => {
    const conn = makeConn()
    const a = await conn.ensurePortForward(8080, 'localhost', { evictable: true })
    const again = await conn.ensurePortForward(8080, 'localhost', { evictable: true })
    const other = await conn.ensurePortForward(8080, 'dev-box.corp.example.test', { evictable: true })
    expect(again).toBe(a)
    expect(other).not.toBe(a)
    expect(spawned).toHaveLength(2)
    expect(forwardSpec(0)).toBe(`${a}:localhost:8080`)
    expect(forwardSpec(1)).toBe(`${other}:dev-box.corp.example.test:8080`)
  })

  it('concurrent calls for one forward share ONE ssh (a double click cannot orphan a process)', async () => {
    const conn = makeConn()
    const [x, y, z] = await Promise.all([
      conn.ensurePortForward(8377, 'localhost', { evictable: true }),
      conn.ensurePortForward(8377, 'localhost', { evictable: true }),
      conn.ensurePortForward(8377, 'localhost', { evictable: true }),
    ])
    expect(new Set([x, y, z]).size).toBe(1)
    expect(spawned).toHaveLength(1)
  })

  it('closePortForward kills that ssh, and the next call dials again', async () => {
    const conn = makeConn()
    await conn.ensurePortForward(8080, 'localhost', { evictable: true })
    conn.closePortForward(8080, 'localhost')
    expect(spawned[0].killed).toBe(true)
    await conn.ensurePortForward(8080, 'localhost', { evictable: true })
    expect(spawned).toHaveLength(2)
  })

  it('keeps at most 12 service forwards, least recently used first, and never evicts VS Code', async () => {
    const conn = makeConn()
    await conn.ensurePortForward(39000) // VS Code: not evictable
    for (let p = 9000; p < 9012; p++) await conn.ensurePortForward(p, 'localhost', { evictable: true })
    // Touch the oldest service forward so it becomes the most recent.
    await conn.ensurePortForward(9000, 'localhost', { evictable: true })
    await conn.ensurePortForward(9012, 'localhost', { evictable: true })
    const byPort = (port: number) => spawned.find((s) => s.args.some((a) => a.endsWith(`:localhost:${port}`)))!
    expect(byPort(9001).killed).toBe(true)
    expect(byPort(9000).killed).toBe(false)
    expect(spawned[0].killed).toBe(false)
    expect(spawned.filter((s) => s.killed)).toHaveLength(1)
  })

  it('disconnect kills every forward', async () => {
    const conn = makeConn()
    await conn.ensurePortForward(8080, 'localhost', { evictable: true })
    await conn.ensurePortForward(39000)
    conn.disconnect()
    expect(spawned.every((s) => s.killed)).toBe(true)
  })
})
