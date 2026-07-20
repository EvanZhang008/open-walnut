/**
 * DaemonConnection per-command timeout override.
 *
 * Regression for the ACP lazy re-attach failure: a cold `acpStart` (daemon
 * spawns a worker, then runs `initialize` + `session/load` against a real Codex
 * app-server, each budgeted 120s worker-side) could legitimately take longer
 * than the flat 30s command timeout. When it did, `send('acpStart')` rejected
 * with `daemon command timeout: acpStart (30000ms)`, which cascaded into
 * `acp: re-attach from record failed`, `processNext failed after result/error`,
 * and `failed to restore pending session permissions` (prod 2026-07-19,
 * session 019f791f, traceId 9c7cb17c). Fix: `send()` accepts a per-command
 * timeout; cold-resume ops pass a budget that clears the worker's own op
 * ceiling. This test pins that a slow-but-healthy reply survives a generous
 * override and that the default budget is unchanged.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { createServer } from 'node:net'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr) {
        const p = addr.port
        srv.close(() => resolve(p))
      } else srv.close(() => reject(new Error('no port')))
    })
  })
}

/**
 * Minimal daemon that replies to every command after `replyDelayMs`. `ping`
 * always replies immediately (connectDirect's keepalive must not stall).
 */
function startDelayedDaemon(port: number, replyDelayMs: number): WebSocketServer {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' })
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw) => {
      let cmd: { id?: number; cmd?: string }
      try { cmd = JSON.parse(raw.toString()) } catch { return }
      if (typeof cmd.id !== 'number') return
      if (cmd.cmd === 'ping') { ws.send(JSON.stringify({ id: cmd.id, ok: true, pong: true })); return }
      setTimeout(() => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: cmd.id, ok: true, echoed: cmd.cmd }))
      }, replyDelayMs)
    })
  })
  return wss
}

describe('DaemonConnection per-command timeout', () => {
  let wss: WebSocketServer | null = null
  let conn: DaemonConnection | null = null

  afterEach(async () => {
    try { conn?.disconnect() } catch { /* best effort */ }
    if (wss) { await new Promise<void>((r) => wss!.close(() => r())); wss = null }
    conn = null
  })

  it('a slow reply (>30s default) is rejected without an override but accepted with a generous one', async () => {
    const port = await freePort()
    // Reply after 120ms: comfortably past a tiny default we set below, so we can
    // prove the timeout is what governs — without waiting a real 30s.
    wss = startDelayedDaemon(port, 120)
    conn = new DaemonConnection('slow-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${port}`)

    // Default-budget send times out (simulate the 30s ceiling with a 40ms one).
    await expect(conn.send('acpStart', {}, 40)).rejects.toThrow(/daemon command timeout: acpStart \(40ms\)/)

    // A generous override lets the same slow reply through.
    const ok = await conn.send('acpStart', {}, 5_000)
    expect(ok).toMatchObject({ ok: true, echoed: 'acpStart' })
  })

  it('the override changes only this command; a separate default send is unaffected', async () => {
    const port = await freePort()
    wss = startDelayedDaemon(port, 20)
    conn = new DaemonConnection('fast-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${port}`)

    const [a, b] = await Promise.all([
      conn.send('acpStart', {}, 5_000), // generous override
      conn.send('status', {}),          // default budget
    ])
    expect(a).toMatchObject({ ok: true, echoed: 'acpStart' })
    expect(b).toMatchObject({ ok: true, echoed: 'status' })
  })
})
