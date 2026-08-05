/**
 * Bulk data channel — a second WS to the same daemon carrying MB-scale
 * response frames (fs.read / fs.readRange / fs.readImage / git.diff) so they
 * can't head-of-line-block interactive commands on the main socket.
 *
 * Pins the contract:
 *   - B1: bulk commands route to socket #2, interactive commands stay on #1
 *   - B2: bulk socket death → silent fallback to main + background redial
 *   - B3: events broadcast to BOTH sockets dispatch to handlers exactly once
 *     (the bulk handler drops ev frames — session_state goes to ALL clients)
 *   - B4: stt-request arriving on the bulk socket still reaches the relay
 *     (daemon picks its FIRST client; after a main reconnect that can be bulk)
 *   - B5: a bulk-routed command timeout terminates the bulk socket (self-heal)
 *   - B6: hello instanceId mismatch → bulk channel refused, no routing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

async function waitFor(cond: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('DaemonConnection bulk channel', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection
  let tmpFile: string
  let savedRedialDelay: number

  beforeEach(async () => {
    // Shrink the redial delay (private static, prod default 10s) so B2 can
    // observe a redial without a 10s wait. Restored in afterEach.
    savedRedialDelay = (DaemonConnection as unknown as { BULK_REDIAL_DELAY_MS: number }).BULK_REDIAL_DELAY_MS
    ;(DaemonConnection as unknown as { BULK_REDIAL_DELAY_MS: number }).BULK_REDIAL_DELAY_MS = 100

    daemon = await createMockDaemon()
    conn = new DaemonConnection('bulk-test-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn.bulkChannelActive, 5_000, 'bulk channel to connect')

    tmpFile = path.join(os.tmpdir(), `bulk-channel-test-${Date.now()}.txt`)
    fs.writeFileSync(tmpFile, 'bulk channel payload')
  })

  afterEach(async () => {
    ;(DaemonConnection as unknown as { BULK_REDIAL_DELAY_MS: number }).BULK_REDIAL_DELAY_MS = savedRedialDelay
    try { conn.disconnect() } catch { /* best effort */ }
    await daemon.stop()
    try { fs.unlinkSync(tmpFile) } catch { /* best effort */ }
  })

  // B1 — routing split: bulk commands on socket #2, interactive on socket #1
  it('B1: fs.read rides the bulk socket, fs.ls stays on the main socket', async () => {
    expect(daemon.clientCount).toBe(2)

    const read = await conn.send('fs.read', { path: tmpFile })
    expect(read.ok).toBe(true)
    const ls = await conn.send('fs.ls', { path: os.tmpdir() })
    expect(ls.ok).toBe(true)
    const range = await conn.send('fs.readRange', { path: tmpFile, start: 0, length: 4 })
    expect(range.ok).toBe(true)
    expect(Buffer.from(range.data as string, 'base64').toString()).toBe('bulk')

    // Main socket = connIndex 0 (first connection), bulk = connIndex 1.
    expect(daemon.getCommandHistoryFor('fs.read')[0].connIndex).toBe(1)
    expect(daemon.getCommandHistoryFor('fs.readRange')[0].connIndex).toBe(1)
    expect(daemon.getCommandHistoryFor('fs.ls')[0].connIndex).toBe(0)
  })

  // B2 — bulk socket dies → fallback to main, then background redial restores it
  it('B2: bulk socket death falls back to main and redials', async () => {
    daemon.clearCommandHistory()
    expect(daemon.killClient(1)).toBe(true)
    await waitFor(() => !conn.bulkChannelActive, 5_000, 'bulk channel to drop')

    // Fallback: bulk command still succeeds, over the MAIN socket.
    const read = await conn.send('fs.read', { path: tmpFile })
    expect(read.ok).toBe(true)
    expect(daemon.getCommandHistoryFor('fs.read')[0].connIndex).toBe(0)

    // Background redial restores the channel (delay shrunk to 100ms above).
    await waitFor(() => conn.bulkChannelActive, 5_000, 'bulk channel to redial')
    daemon.clearCommandHistory()
    await conn.send('fs.read', { path: tmpFile })
    // Redialed socket is connection #3 (index 2) — the point is it's not main.
    expect(daemon.getCommandHistoryFor('fs.read')[0].connIndex).toBeGreaterThan(0)
  })

  // B3 — events broadcast to both sockets must dispatch exactly once
  it('B3: session_state broadcast to both sockets dispatches once', async () => {
    const received: unknown[] = []
    conn.onEvent((e) => { if (e.ev === 'session_state') received.push(e) })
    daemon.emitSessionState('sid-1', 'dead', { exitCode: 3 })
    await new Promise((r) => setTimeout(r, 100))
    expect(received).toHaveLength(1)
  })

  // B4 — stt-request delivered on the BULK socket still triggers the relay
  it('B4: stt-request on the bulk socket reaches the STT relay handler', async () => {
    daemon.clearCommandHistory()
    // Deliver to connIndex 1 (the bulk socket) only — mirrors the daemon
    // picking its first client after a main-WS reconnect.
    expect(daemon.emitEventTo(1, 'stt-request', { relayId: 42, audio: 'AAAA', format: 'webm' })).toBe(true)
    // No STT engine is configured in tests → the relay replies with an error
    // stt-result. Either way, an stt-result command must arrive at the daemon.
    await waitFor(() => daemon.getCommandHistoryFor('stt-result').length > 0, 10_000, 'stt-result reply')
    const reply = daemon.getCommandHistoryFor('stt-result')[0]
    expect(reply.payload.relayId).toBe(42)
  })

  // B5 — bulk-routed timeout terminates the bulk socket (half-dead self-heal)
  it('B5: bulk command timeout terminates the bulk socket; next read uses main', async () => {
    daemon.swallowNextCommand('fs.read')
    await expect(conn.send('fs.read', { path: tmpFile }, 200)).rejects.toThrow(/daemon command timeout/)
    await waitFor(() => !conn.bulkChannelActive, 5_000, 'bulk channel torn down after timeout')

    daemon.clearCommandHistory()
    const read = await conn.send('fs.read', { path: tmpFile })
    expect(read.ok).toBe(true)
    expect(daemon.getCommandHistoryFor('fs.read')[0].connIndex).toBe(0)
  })

  // B6 — daemon-identity mismatch on the bulk hello → channel refused
  it('B6: hello instanceId mismatch refuses the bulk channel', async () => {
    // Pin the main connection's expected identity, then force hello to lie.
    ;(conn as unknown as { _daemonInstanceId: string | null })._daemonInstanceId = daemon.instanceId
    daemon.injectHelloInstanceMismatch(true)
    ;(conn as unknown as { closeBulkChannel: () => void }).closeBulkChannel()
    ;(conn as unknown as { dialBulkChannel: () => void }).dialBulkChannel()

    // Give the dial time to complete its hello exchange — it must NOT activate.
    await new Promise((r) => setTimeout(r, 500))
    expect(conn.bulkChannelActive).toBe(false)

    // Bulk commands still work over the main socket.
    daemon.clearCommandHistory()
    const read = await conn.send('fs.read', { path: tmpFile })
    expect(read.ok).toBe(true)
    expect(daemon.getCommandHistoryFor('fs.read')[0].connIndex).toBe(0)
  })
})
