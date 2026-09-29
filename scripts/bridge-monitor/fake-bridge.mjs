#!/usr/bin/env node
/**
 * A local stand-in for the cloud `/bridge` endpoint, for testing the probe
 * without touching the real box. It follows the replica's contract
 * (src/web/ws/bridge-registry.ts): token auth on the upgrade (?token= or
 * Bearer), a hello within 10 s, `bridge-ping` answered with a `ping` RPC,
 * a silence sweep. On top, it checks every probe frame (seq continuity and
 * sha256) and acks it, and it can inject faults.
 *
 *   node fake-bridge.mjs --port 8799 --token dev-token
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

export async function createFakeBridge({ port = 0, token = 'test-token', helloTimeoutMs = 10_000, silenceMs = 75_000, sweepMs = 30_000 } = {}) {
  const stats = { upgrades: 0, rejected: 0, hellos: 0, pings: 0, rpcAnswered: 0, verified: 0, corrupt: 0, seqGaps: 0, bytesIn: 0, maxFrameBytes: 0 }
  const events = []
  const conns = new Set()
  let silent = false
  let rejectAuth = false
  const note = (ev, extra = {}) => events.push({ t: Date.now(), ev, ...extra })

  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    stats.upgrades++
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null
    const given = url.searchParams.get('token') ?? bearer
    if (url.pathname !== '/bridge' || rejectAuth || given !== token) {
      stats.rejected++
      note('rejected', { path: url.pathname })
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws))
  })

  function attach(ws) {
    const c = { ws, hostAlias: null, lastInbound: Date.now(), cmd: 0, lastSeq: null }
    conns.add(c)
    note('open')
    const helloTimer = setTimeout(() => { if (!c.hostAlias) ws.close() }, helloTimeoutMs)
    ws.on('message', (data) => {
      const text = data.toString()
      c.lastInbound = Date.now()
      const bytes = Buffer.byteLength(text)
      stats.bytesIn += bytes
      stats.maxFrameBytes = Math.max(stats.maxFrameBytes, bytes)
      let msg
      try { msg = JSON.parse(text) } catch { return }
      if (!c.hostAlias) {
        if (msg.ev !== 'hello' || typeof msg.hostAlias !== 'string') return
        clearTimeout(helloTimer)
        c.hostAlias = msg.hostAlias
        stats.hellos++
        note('hello', { hostAlias: msg.hostAlias })
        return
      }
      if (silent) return
      if (msg.ev === 'bridge-ping') {
        stats.pings++
        ws.send(JSON.stringify({ id: ++c.cmd, cmd: 'ping' }))
      } else if (typeof msg.id === 'number' && 'ok' in msg) {
        stats.rpcAnswered++
      } else if (msg.ev === 'probe-payload') {
        const ok = typeof msg.data === 'string' && msg.data.length === msg.bytes
          && crypto.createHash('sha256').update(msg.data).digest('hex') === msg.sha256
        if (ok) stats.verified++
        else stats.corrupt++
        if (c.lastSeq != null && msg.seq !== c.lastSeq + 1) stats.seqGaps++
        c.lastSeq = msg.seq
        ws.send(JSON.stringify({ ev: 'probe-ack', seq: msg.seq, ok }))
      }
    })
    ws.on('close', (code) => { clearTimeout(helloTimer); conns.delete(c); note('close', { code }) })
    ws.on('error', () => { /* close follows */ })
  }

  const sweep = setInterval(() => {
    for (const c of conns) if (Date.now() - c.lastInbound > silenceMs) { note('silence-sweep'); c.ws.close() }
  }, sweepMs)

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const actual = server.address().port
  return {
    url: `ws://127.0.0.1:${actual}/bridge`,
    port: actual,
    stats,
    events,
    connections: () => conns.size,
    setSilent(v) { silent = !!v },
    setRejectAuth(v) { rejectAuth = !!v },
    /** Server-initiated clean close (like a replica teardown). */
    closeAll(code = 1001, reason = 'going away') { for (const c of conns) c.ws.close(code, reason) },
    /** Abrupt TCP reset, no close frame (like a network drop). */
    destroyAll() { for (const c of conns) c.ws._socket?.destroy() },
    async close() {
      clearInterval(sweep)
      for (const c of conns) c.ws.terminate()
      await new Promise((resolve) => wss.close(() => server.close(() => resolve())))
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
  const fb = await createFakeBridge({ port: Number(arg('--port', 8799)), token: arg('--token', 'dev-token') })
  process.stdout.write(`fake bridge listening on ${fb.url}\n`)
  setInterval(() => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), conns: fb.connections(), ...fb.stats })}\n`), 30_000)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) await main()
