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
import http from 'node:http'
import { holdPort, listenAfterHold, listenAttempt } from '../../src/web/port-hold.js'
import { createSpawnPool } from '../../src/providers/spawn-pool.js'

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

describe('listenAttempt', () => {
  const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()))
  const listeners = (s: net.Server) => ({ error: s.listenerCount('error'), listening: s.listenerCount('listening') })

  // A listen callback stays as a 'listening' listener when the listen fails: ~80 of them in a 2 s
  // retry used to pile up on the one server object.
  it('leaves no listener behind, after many failed attempts and after the one that works', async () => {
    const port = await freePort()
    const other = await listen(port)
    const srv = net.createServer()
    const before = listeners(srv)
    try {
      for (let i = 0; i < 40; i++) {
        await expect(listenAttempt(srv, port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' })
      }
      expect(listeners(srv)).toEqual(before)
    } finally { await close(other) }
    await listenAttempt(srv, port, '127.0.0.1')
    expect((srv.address() as net.AddressInfo).port).toBe(port)
    expect(listeners(srv)).toEqual(before)
    await close(srv)
  })

  it('the same through listenAfterHold\'s retries', async () => {
    const port = await freePort()
    const holder = await listen(port)
    setTimeout(() => { void close(holder) }, 200)
    const srv = net.createServer()
    const before = listeners(srv)
    let retries = 0
    await listenAfterHold(() => listenAttempt(srv, port, '127.0.0.1'), { stepMs: 5, onRetry: (n) => { retries = n } })
    expect(retries).toBeGreaterThan(10)
    expect(listeners(srv)).toEqual(before)
    await close(srv)
  })
})

describe('the boot order', () => {
  it('the server takes its port before it starts the local daemon, and frees it right before listen', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/web/server.ts'), 'utf8')
    const hold = src.indexOf('serverPortHold = await holdPort(')
    const daemon = src.indexOf('await localDaemon.ensureRunning()')
    const release = src.lastIndexOf('await serverPortHold?.release()')
    const listenAt = src.indexOf('listenAttempt(httpServer!, port')
    expect(hold).toBeGreaterThan(0)
    expect(daemon).toBeGreaterThan(hold)
    expect(release).toBeGreaterThan(daemon)
    expect(listenAt).toBeGreaterThan(release)
  })
})

describe('listenAfterHold', () => {
  const httpListen = (srv: http.Server, port: number) => () => listenAttempt(srv, port, '127.0.0.1')
  const close = (s: net.Server | http.Server) => new Promise<void>((r) => s.close(() => r()))

  it('takes the port once a brief holder lets go, on the same server object', async () => {
    const port = await freePort()
    const holder = await listen(port)
    setTimeout(() => { void close(holder) }, 150)
    const srv = http.createServer()
    let retries = 0
    await listenAfterHold(httpListen(srv, port), { onRetry: (n) => { retries = n } })
    expect(retries).toBeGreaterThan(0)
    expect((srv.address() as net.AddressInfo).port).toBe(port)
    await close(srv)
  })

  it('a port still taken after the budget rejects with EADDRINUSE, as before', async () => {
    const port = await freePort()
    const holder = await listen(port)
    try {
      const t0 = Date.now()
      await expect(listenAfterHold(httpListen(http.createServer(), port), { budgetMs: 200 })).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(Date.now() - t0).toBeGreaterThanOrEqual(190)
    } finally { await close(holder) }
  })

  it('any other error is not retried', async () => {
    let calls = 0
    await expect(listenAfterHold(async () => { calls++; throw Object.assign(new Error('nope'), { code: 'EACCES' }) })).rejects.toMatchObject({ code: 'EACCES' })
    expect(calls).toBe(1)
  })

  // The case it is for: children started on another thread (the spawn pool) while this one releases
  // the hold and listens. A child mid-start holds a copy of the released hold, still listening.
  it('hold, release and listen while the spawn pool starts children: never EADDRINUSE', async () => {
    const pool = createSpawnPool({ umask: null })
    let stop = false
    const spawner = async () => {
      while (!stop) await new Promise<void>((r) => { pool.execFile('true', [], {}, () => r()) })
    }
    const spawners = [spawner(), spawner()]
    try {
      for (let i = 0; i < 60; i++) {
        const port = await freePort()
        const hold = (await holdPort(port, '127.0.0.1'))!
        await new Promise((r) => setTimeout(r, 2))
        await hold.release()
        const srv = http.createServer()
        await listenAfterHold(httpListen(srv, port))
        await close(srv)
      }
    } finally {
      stop = true
      await Promise.all(spawners)
      pool.close()
    }
  }, 60_000)
})

