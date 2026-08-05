/**
 * DaemonConnection ping/pong lifecycle — regressions for the 2026-08-01
 * instability incident:
 *
 *   1. Zombie ping timer: handleConnectionLost() early-returned on
 *      `!_connected` BEFORE clearing pingTimer, so a second loss signal left
 *      an interval logging "no pong received" every 15s forever (observed:
 *      lastPongAgoMs grew to 12.6h across 1138 warns in one day).
 *
 *   2. Sleep-poisoned staleness: staleness was `Date.now() - lastPongAt > 45s`.
 *      On Apple Silicon BOTH Date.now() and hrtime advance through system
 *      sleep, so every lid-close DarkWake instantly "detected" a stale
 *      connection and tore down a healthy link. Fix: count consecutive awake
 *      ping ticks with an outstanding pong (_missedPongs >= 3) — timer ticks
 *      don't run while asleep, so sleep costs at most one tick.
 *
 * These tests reach into privates deliberately (the bug WAS in private state).
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
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

/** Daemon that answers protocol pings; WS-frame pongs are ws-library automatic. */
function startDaemon(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' })
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw) => {
      let cmd: { id?: number; cmd?: string }
      try { cmd = JSON.parse(raw.toString()) } catch { return }
      if (typeof cmd.id === 'number') ws.send(JSON.stringify({ id: cmd.id, ok: true }))
    })
  })
  return wss
}

type Priv = {
  pingTimer: ReturnType<typeof setInterval> | null
  _pongPending: boolean
  _missedPongs: number
  handleConnectionLost(): void
  startPing(): void
}

describe('DaemonConnection ping lifecycle', () => {
  let wss: WebSocketServer | null = null
  let conn: DaemonConnection | null = null

  afterEach(async () => {
    try { conn?.disconnect() } catch { /* best effort */ }
    if (wss) { await new Promise<void>((r) => wss!.close(() => r())); wss = null }
    conn = null
  })

  it('handleConnectionLost clears the ping timer even when already disconnected (zombie-timer regression)', async () => {
    const port = await freePort()
    wss = startDaemon(port)
    conn = new DaemonConnection('ping-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${port}`)
    const priv = conn as unknown as Priv

    expect(priv.pingTimer).not.toBeNull()

    // First loss: normal path — timer cleared, disconnected.
    priv.handleConnectionLost()
    expect(priv.pingTimer).toBeNull()

    // Simulate the leak precondition: a timer that outlived its connection
    // (pre-fix this is exactly the state after ws 'close' raced a stale-pong
    // loss). A second loss signal must clear it despite _connected=false.
    priv.startPing()
    expect(priv.pingTimer).not.toBeNull()
    priv.handleConnectionLost()
    expect(priv.pingTimer).toBeNull()
  })

  it('staleness fires only after 3 consecutive missed ticks, not from clock deltas (sleep regression)', async () => {
    vi.useFakeTimers()
    try {
      const port = await freePort()
      wss = startDaemon(port)
      conn = new DaemonConnection('stale-host', TARGET)
      // connectDirect awaits real I/O; run it with timers real first.
      vi.useRealTimers()
      await conn.connectDirect(`ws://127.0.0.1:${port}`)
      vi.useFakeTimers()
      const priv = conn as unknown as Priv
      const lost = vi.spyOn(priv, 'handleConnectionLost')
      // The interval created during connectDirect is a REAL timer; re-arm it
      // under fake timers so advanceTimersByTime drives the ticks.
      priv.startPing()

      // Freeze pong receipt: make the underlying ws never deliver pongs by
      // forcing the pending flag after each tick. Simulate 2 missed ticks —
      // must NOT disconnect (a sleep gap costs at most one tick).
      priv._pongPending = true
      vi.advanceTimersByTime(15_000) // tick 1 → missed=1
      priv._pongPending = true
      vi.advanceTimersByTime(15_000) // tick 2 → missed=2
      expect(lost).not.toHaveBeenCalled()

      // Third consecutive miss → stale → connection torn down.
      priv._pongPending = true
      vi.advanceTimersByTime(15_000) // tick 3 → missed=3 → lost
      expect(lost).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a received pong resets the missed-tick counter', async () => {
    const port = await freePort()
    wss = startDaemon(port)
    conn = new DaemonConnection('reset-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${port}`)
    const priv = conn as unknown as Priv

    priv._pongPending = true
    priv._missedPongs = 2
    // Real pong round-trip: ws server auto-pongs our ping within the interval.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!priv._pongPending || priv._missedPongs === 0) { clearInterval(check); resolve() }
      }, 50)
      // Trigger a ping immediately rather than waiting 15s.
      ;(conn as unknown as { ws: { ping(): void } }).ws.ping()
    })
    expect(priv._missedPongs).toBe(0)
  })
})
