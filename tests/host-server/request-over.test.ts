/**
 * requestOver (src/core/host-server/request-over.ts) bounds its own wait: a stream that is already connected (a
 * daemon's relayed stream, a unix socket) gets no socket timeout from http.request's `timeout` option, so a peer that
 * takes the connection and never answers would hold the caller for good. The bound is idle time: a long answer or
 * upload that keeps moving is never cut. Real unix sockets on a temp dir.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { requestOver } from '../../src/core/host-server/request-over.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-over-'))
const servers: net.Server[] = []
const peers: net.Socket[] = []
afterAll(async () => {
  for (const p of peers) p.destroy()
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
  fs.rmSync(base, { recursive: true, force: true })
})

async function listen(name: string, onConnection: (s: net.Socket) => void): Promise<string> {
  const sock = path.join(base, `${name}.sock`)
  const srv = net.createServer((s) => { peers.push(s); onConnection(s) })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(sock, () => r()))
  return sock
}

async function connect(sock: string): Promise<net.Socket> {
  const s = net.connect({ path: sock })
  await new Promise((r) => s.once('connect', r))
  return s
}

describe('requestOver on a stream that is already connected', () => {
  it('a peer that takes the connection and never answers: rejected near its bound, the stream destroyed', async () => {
    const sock = await listen('silent', (s) => { s.pause() })
    const s = await connect(sock)
    const t0 = Date.now()
    await expect(requestOver(s, 'GET', '/x', null, 500)).rejects.toThrow(/did not answer within/)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(s.destroyed).toBe(true)
  }, 10_000)

  it('a peer that reads the request and never answers: the same', async () => {
    const sock = await listen('reads', (s) => { s.resume() })
    const s = await connect(sock)
    await expect(requestOver(s, 'POST', '/x', Buffer.from('{"a":1}'), 400)).rejects.toThrow(/did not answer within/)
  }, 10_000)

  it('an answer that keeps coming past the bound, a chunk each 200 ms for 1.6 s: never cut (the bound is idle time)', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      let n = 0
      const t = setInterval(() => { res.write(`part ${n}\n`); if (++n === 8) { clearInterval(t); res.end() } }, 200)
    })
    const sock = path.join(base, 'slow-answer.sock')
    await new Promise<void>((r) => srv.listen(sock, () => r()))
    try {
      const r = await requestOver(await connect(sock), 'GET', '/x', null, 600)
      expect((await r.text()).split('\n').filter(Boolean)).toHaveLength(8)
    } finally { await new Promise<void>((r) => srv.close(() => r())) }
  }, 10_000)

  it('a large upload the peer reads slowly past the bound: never cut while it moves', async () => {
    const body = Buffer.alloc(8 * 1024 * 1024, 7)
    const srv = http.createServer((req, res) => {
      let got = 0
      req.on('data', (c: Buffer) => {
        got += c.length
        // Read a while, then hold off: the writer waits on backpressure, then moves again.
        req.pause()
        setTimeout(() => req.resume(), 20)
      })
      req.on('end', () => { res.writeHead(200); res.end(String(got)) })
    })
    const sock = path.join(base, 'slow-read.sock')
    await new Promise<void>((r) => srv.listen(sock, () => r()))
    try {
      const t0 = Date.now()
      const r = await requestOver(await connect(sock), 'POST', '/x', body, 300)
      expect(await r.text()).toBe(String(body.length))
      // It did run past its bound (else this proves nothing about the idle reset).
      expect(Date.now() - t0).toBeGreaterThan(300)
    } finally { await new Promise<void>((r) => srv.close(() => r())) }
  }, 30_000)
})

describe('no stream goes to http.request with only the socket timeout option', () => {
  it('every http.request over a given connection in src/ bounds its wait itself (requestOver), not by `timeout:`', () => {
    const root = path.resolve(__dirname, '../../src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8')
          for (const m of src.matchAll(/http\.request\(\{/g)) {
            // The options literal: up to its `as http.RequestOptions` (how every such call here is written), else its line.
            const ahead = src.slice(m.index!, m.index! + 800)
            const end = ahead.indexOf('as http.RequestOptions')
            const opts = end >= 0 ? ahead.slice(0, end) : ahead.split('\n')[0]!
            if (/createConnection\s*:/.test(opts) && /\btimeout\s*:/.test(opts)) offenders.push(`${path.relative(root, p)}:${src.slice(0, m.index).split('\n').length}`)
          }
        }
      }
    }
    walk(root)
    // A stream already connected never fires that option (createConnection hands it over connected): use requestOver.
    expect(offenders).toEqual([])
  })
})
