/**
 * C2 intake — RemoteSessionManager routes {ev:'snapshot'} daemon pushes into
 * applySnapshot (contract §5 "Intake").
 *
 * Real path: a real DaemonConnection (connectDirect → MockDaemon over a real
 * WebSocket) delivers the event through the REAL handleDaemonEvent switch;
 * only the projection module is mocked (spy). Asserts sid matching (incl.
 * _prevSid rename mapping), source tag, error containment, and that unknown
 * `ev` types stay ignored.
 *
 * MACHINE SAFETY: MockDaemon binds an OS-assigned port; no real daemons,
 * never :3456.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const applySnapshotMock = vi.fn(async () => ({ outcome: 'shadow' as const, diverged: false }))
vi.mock('../../src/core/session-snapshot-apply.js', () => ({
  applySnapshot: (...args: unknown[]) => applySnapshotMock(...(args as [never, never, never])),
}))

import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { createServer } from 'node:net'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import {
  REQUIRED_DAEMON_CAPABILITIES,
  ADVERTISED_DAEMON_CAPABILITIES,
} from '../../src/providers/daemon-capabilities.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'

const TEST_TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

const SNAP: SessionSnapshot = {
  v: 512, cliState: 'idle', turnActive: false, pendingPermission: null,
  gatingBgCount: 0, teamActive: false,
  lastResult: { isError: false, endOffset: 480 }, pid: 4242, exitCode: null,
}

describe('RemoteSessionManager snapshot intake (real handleDaemonEvent via MockDaemon)', () => {
  let daemon: MockDaemon
  let mgr: RemoteSessionManager

  beforeEach(async () => {
    applySnapshotMock.mockClear()
    daemon = await createMockDaemon()
    mgr = new RemoteSessionManager(
      'sid-snap', 'testhost', TEST_TARGET, `ws://127.0.0.1:${daemon.port}`,
    )
    await mgr.start({ args: [], message: 'hello', cwd: '/tmp', onOutput: vi.fn(), onExit: vi.fn() })
    await new Promise((r) => setTimeout(r, 60))
  })

  afterEach(async () => {
    try { await mgr.cleanup() } catch { /* best effort */ }
    await daemon.stop()
  })

  it('routes a matching-sid snapshot event to applySnapshot with source daemon-push', async () => {
    daemon.emitEvent('snapshot', { sid: 'sid-snap', snapshot: SNAP })
    await new Promise((r) => setTimeout(r, 50))
    expect(applySnapshotMock).toHaveBeenCalledTimes(1)
    expect(applySnapshotMock).toHaveBeenCalledWith('sid-snap', SNAP, 'daemon-push')
  })

  it('ignores a snapshot for an unrelated sid', async () => {
    daemon.emitEvent('snapshot', { sid: 'OTHER-SID', snapshot: SNAP })
    await new Promise((r) => setTimeout(r, 50))
    expect(applySnapshotMock).not.toHaveBeenCalled()
  })

  it('ignores a snapshot event without a snapshot payload', async () => {
    daemon.emitEvent('snapshot', { sid: 'sid-snap' })
    await new Promise((r) => setTimeout(r, 50))
    expect(applySnapshotMock).not.toHaveBeenCalled()
  })

  it('maps a _prevSid event to the CURRENT sid during a rename transition', async () => {
    mgr.renameForSession('sid-snap-renamed')
    await new Promise((r) => setTimeout(r, 30))
    // The daemon may still emit events tagged with the OLD sid while the
    // rename is in flight — they must land on the NEW record.
    daemon.emitEvent('snapshot', { sid: 'sid-snap', snapshot: SNAP })
    await new Promise((r) => setTimeout(r, 50))
    expect(applySnapshotMock).toHaveBeenCalledWith('sid-snap-renamed', SNAP, 'daemon-push')
  })

  it('a rejecting applySnapshot never throws out of the event handler', async () => {
    applySnapshotMock.mockRejectedValueOnce(new Error('projection exploded') as never)
    daemon.emitEvent('snapshot', { sid: 'sid-snap', snapshot: SNAP })
    await new Promise((r) => setTimeout(r, 50))
    // Handler survived — a following event is still processed.
    daemon.emitEvent('snapshot', { sid: 'sid-snap', snapshot: { ...SNAP, v: 600 } })
    await new Promise((r) => setTimeout(r, 50))
    expect(applySnapshotMock).toHaveBeenCalledTimes(2)
  })

  it('unknown ev types remain ignored (old-walnut compat)', async () => {
    daemon.emitEvent('snapshot-v2-future', { sid: 'sid-snap', snapshot: SNAP })
    await new Promise((r) => setTimeout(r, 50))
    expect(applySnapshotMock).not.toHaveBeenCalled()
  })
})

// ── C31: connectDirect must run the hello handshake ──────────────────────────
// Without it `_capabilities` stayed null forever on every direct connection, so
// `supportsSnapshots` was false for the LOCAL daemon (which reaches the pool via
// getDirectDaemonConnection → connectDirect) and getPooledSnapshotConnection
// never matched it. The 30s pull channel was dead for ALL local sessions and the
// reconnect pull always took the legacy branch: local sessions relied on pushes
// alone, with none of the contract's self-healing.
describe('connectDirect capability handshake (C31)', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection | null = null

  /** OS-assigned free port for the minimal hello fixtures below. */
  async function freePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (typeof addr === 'object' && addr) { const p = addr.port; srv.close(() => resolve(p)) }
        else srv.close(() => reject(new Error('no port')))
      })
    })
  }

  /** wss.close() waits for every client socket, and the DaemonConnection's
   *  socket is still open here (afterEach disconnects it) — terminate first or
   *  the close never resolves and the test hits its timeout. */
  async function closeServer(wss: WebSocketServer): Promise<void> {
    for (const client of wss.clients) { try { client.terminate() } catch { /* best effort */ } }
    await new Promise<void>((r) => wss.close(() => r()))
  }

  beforeEach(async () => { daemon = await createMockDaemon() })
  afterEach(async () => {
    try { conn?.disconnect() } catch { /* best effort */ }
    conn = null
    await daemon.stop()
  })

  it('a direct connection learns capabilities and reports supportsSnapshots', async () => {
    conn = new DaemonConnection('__local__', null)
    expect(conn.capabilitiesKnown, 'no handshake has run yet').toBe(false)
    expect(conn.supportsSnapshots).toBe(false)

    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)

    expect(conn.capabilitiesKnown, 'connectDirect must run hello').toBe(true)
    expect(
      conn.supportsSnapshots,
      'C31 REGRESSION: a direct (local-daemon) connection does not know it speaks snapshot-v1, '
      + 'so getPooledSnapshotConnection skips it and the C2 pull channel is dead for every '
      + 'local session',
    ).toBe(true)
    // A required capability is learned too — the handshake result is the real
    // list, not a hardcoded snapshot flag.
    expect(conn.hasCapability('getState')).toBe(true)
    expect(conn.hasCapability('definitely-not-a-capability')).toBe(false)
    expect(conn.connected).toBe(true)
  })

  it('a daemon WITHOUT snapshot-v1 is correctly reported as legacy (version-skew fallback)', async () => {
    // A rolled-back daemon answers hello with the REQUIRED set only. The
    // connection must still come up (nothing to redeploy on a direct link) and
    // report supportsSnapshots=false so the snapshot flow stays off for it.
    const port = await freePort()
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    wss.on('connection', (ws: WsSocket) => {
      ws.on('message', (raw) => {
        let cmd: { id?: number; cmd?: string }
        try { cmd = JSON.parse(raw.toString()) } catch { return }
        if (typeof cmd.id !== 'number') return
        if (cmd.cmd === 'hello') {
          ws.send(JSON.stringify({
            id: cmd.id, ok: true, version: 'old',
            capabilities: [...REQUIRED_DAEMON_CAPABILITIES], // no snapshot-v1
            instanceId: 'legacy-daemon', startedAt: Date.now(),
          }))
          return
        }
        ws.send(JSON.stringify({ id: cmd.id, ok: true }))
      })
    })
    try {
      conn = new DaemonConnection('legacy-direct', null)
      await conn.connectDirect(`ws://127.0.0.1:${port}`)
      expect(conn.connected).toBe(true)
      expect(conn.capabilitiesKnown).toBe(true)
      expect(conn.supportsSnapshots).toBe(false)
    } finally {
      await closeServer(wss)
    }
  })

  it('a hello-less daemon still connects (handshake failure is non-fatal on a direct link)', async () => {
    const port = await freePort()
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    wss.on('connection', (ws: WsSocket) => {
      ws.on('message', (raw) => {
        let cmd: { id?: number; cmd?: string }
        try { cmd = JSON.parse(raw.toString()) } catch { return }
        if (typeof cmd.id !== 'number') return
        if (cmd.cmd === 'hello') { ws.send(JSON.stringify({ id: cmd.id, ok: false, error: 'unknown command: hello' })); return }
        ws.send(JSON.stringify({ id: cmd.id, ok: true }))
      })
    })
    try {
      conn = new DaemonConnection('nohello-direct', null)
      await conn.connectDirect(`ws://127.0.0.1:${port}`)
      // Connected despite the failed hello — there is no SSH deploy to force,
      // and tests point connectDirect at minimal fixtures that answer no hello.
      expect(conn.connected).toBe(true)
      expect(conn.supportsSnapshots).toBe(false)
    } finally {
      await closeServer(wss)
    }
  })

  it('the MockDaemon fixture advertises the CURRENT capability set (snapshot-v1 included)', () => {
    // The intake tests above rely on this: a fixture stuck on REQUIRED-only
    // would model a rolled-back daemon and silently gate the C2 flow off.
    expect([...ADVERTISED_DAEMON_CAPABILITIES]).toContain('snapshot-v1')
  })

  it('THE PAYOFF: the pooled local connection is now selectable by the pull channel', async () => {
    // What C31 actually broke: the 30s pull step asks
    // getPooledSnapshotConnection('__local__') for a pooled, connected,
    // snapshot-capable connection. With no handshake it never found one.
    const { getDirectDaemonConnection, getPooledSnapshotConnection, disconnectAllDaemons } =
      await import('../../src/providers/daemon-connection.js')
    try {
      const pooled = await getDirectDaemonConnection('__local__', `ws://127.0.0.1:${daemon.port}`)
      expect(pooled.supportsSnapshots).toBe(true)
      // Both the null (record) and '__local__' (hostKey) spellings resolve.
      expect(getPooledSnapshotConnection(null)).toBe(pooled)
      expect(getPooledSnapshotConnection('__local__')).toBe(pooled)
      // A host with no pooled connection still yields null (never dials).
      expect(getPooledSnapshotConnection('some-other-host')).toBeNull()
    } finally {
      disconnectAllDaemons()
    }
  })
})
