/**
 * The server holds its port from before the local daemon starts until it listens
 * (src/web/port-hold.ts). 2026-10-30: the daemon, listening on a port the OS picks,
 * was handed the port the server was about to take, and the server died with
 * EADDRINUSE on its own daemon.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { holdPort } from '../../src/web/port-hold.js'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
  })
}

function listen(port: number, host = '127.0.0.1'): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(port, host, () => resolve(s))
  })
}

describe('holdPort', () => {
  it('port 0 needs no hold', async () => {
    expect(await holdPort(0)).toBeNull()
  })

  it('holds the port until released, then the real listen gets it', async () => {
    const port = await freePort()
    const hold = (await holdPort(port, '127.0.0.1'))!
    await expect(listen(port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await hold.release()
    await hold.release() // idempotent
    const real = await listen(port)
    await new Promise<void>((r) => real.close(() => r()))
  })

  it('a port the OS picks while it is held is never the held one', async () => {
    const port = await freePort()
    const hold = (await holdPort(port, '127.0.0.1'))!
    const picked: net.Server[] = []
    try {
      for (let i = 0; i < 20; i++) {
        const s = await listen(0)
        picked.push(s)
        expect((s.address() as net.AddressInfo).port).not.toBe(port)
      }
    } finally {
      for (const s of picked) await new Promise<void>((r) => s.close(() => r()))
      await hold.release()
    }
  })

  it('a client connecting meanwhile is cut at once, not left hanging', async () => {
    const port = await freePort()
    const hold = (await holdPort(port, '127.0.0.1'))!
    try {
      const started = Date.now()
      await new Promise<void>((resolve) => {
        const c = net.connect(port, '127.0.0.1')
        c.on('error', () => resolve())
        c.on('close', () => resolve())
      })
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await hold.release()
    }
  })

  it('rejects a busy port as listen does', async () => {
    const port = await freePort()
    const other = await listen(port)
    try {
      await expect(holdPort(port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' })
    } finally {
      await new Promise<void>((r) => other.close(() => r()))
    }
  })
})

describe('the boot order', () => {
  it('the server takes its port before it starts the local daemon, and frees it right before listen', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/web/server.ts'), 'utf8')
    const hold = src.indexOf('serverPortHold = await holdPort(')
    const daemon = src.indexOf('await localDaemon.ensureRunning()')
    const release = src.lastIndexOf('await serverPortHold?.release()')
    const listenAt = src.indexOf('httpServer!.listen(port')
    expect(hold).toBeGreaterThan(0)
    expect(daemon).toBeGreaterThan(hold)
    expect(release).toBeGreaterThan(daemon)
    expect(listenAt).toBeGreaterThan(release)
  })
})
