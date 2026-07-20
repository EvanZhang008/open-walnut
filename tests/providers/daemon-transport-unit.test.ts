/**
 * Unit tests for RemoteSessionManager + DaemonConnection — no real daemon needed.
 *
 * Tests the session manager abstraction at the unit level:
 * - B1: createSessionManager factory dispatch (RemoteSessionManager)
 * - B2: RemoteSessionManager.writeMessage guard (before start)
 * - B3: DaemonConnection.disconnect cleanup
 * - B5: ClaudeCodeSession.transport getter
 *
 * What's real: RemoteSessionManager, DaemonConnection, ClaudeCodeSession instances.
 * What's mocked: constants.js (temp dir) — no daemon, no SSH, no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import type { SessionManager } from '../../src/providers/session-manager.js'
import type { SshTarget } from '../../src/providers/session-io.js'

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 100))
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// Helper: shared SshTarget for RemoteSessionManager tests
const testSshTarget: SshTarget = {
  hostname: 'myhost.example.com',
  user: 'testuser',
  use_daemon: true,
}

// ═══════════════════════════════════════════════════════════════════
//  B0: non-ephemeral server is never read-only (mock IS_EPHEMERAL: false)
// ═══════════════════════════════════════════════════════════════════

describe('B0: ephemeral attach-only discriminator (non-ephemeral)', () => {
  it('remote host under NON-ephemeral → NOT read-only (deploy/start allowed)', () => {
    const conn = new DaemonConnection('myhost', testSshTarget)
    expect((conn as unknown as { isReadOnlyRemote: boolean }).isReadOnlyRemote).toBe(false)
  })

  // CONTRAST to the ephemeral attach-only suite: proves the gate is
  // load-bearing, not a universal no-op. With IS_EPHEMERAL=false, the same
  // "no daemon running" path that THROWS for ephemeral instead DOES deploy +
  // start the daemon. If this regressed, the gate would block production too.
  it('Test 6 — CONTRAST: non-ephemeral connect() with no daemon DOES deploy/start', async () => {
    const conn = new DaemonConnection('myhost', testSshTarget)
    const priv = conn as unknown as Record<string, (...args: unknown[]) => unknown>

    vi.spyOn(priv, 'ensureControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv, 'checkDaemonRunning').mockResolvedValue(null)
    const deploy = vi.spyOn(priv, 'deployDaemon').mockResolvedValue(undefined)
    const start = vi.spyOn(priv, 'startDaemon').mockResolvedValue(42424)
    vi.spyOn(priv, 'createTunnel').mockResolvedValue(5555)
    vi.spyOn(priv, 'connectWebSocket').mockResolvedValue(undefined)
    vi.spyOn(priv, 'verifyCapabilities').mockResolvedValue(true)
    // Fire-and-forget post-connect recovery would otherwise attempt real SSH.
    vi.spyOn(priv, 'recoverDisconnectedSessions').mockResolvedValue(undefined)

    await expect(conn.connect()).resolves.toBeUndefined()
    expect(deploy).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)

    // connect() started a ping interval — clear it to avoid leaking a handle.
    conn.disconnect()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  B1: createSessionManager factory dispatch
// ═══════════════════════════════════════════════════════════════════

describe('B1: createSessionManager factory dispatch', () => {
  it('RemoteSessionManager: isRemote === true, host === myhost, processName === daemon', () => {
    const transport = new RemoteSessionManager('daemon-b1-001', 'myhost', testSshTarget)
    expect(transport.isRemote).toBe(true)
    expect(transport.host).toBe('myhost')
    expect(transport.processName).toBe('daemon')
  })

  it('RemoteSessionManager has all SessionManager interface methods', () => {
    const transport: SessionManager = new RemoteSessionManager('daemon-b1-002', 'myhost', testSshTarget)

    // Startup / Attach
    expect(typeof transport.start).toBe('function')
    expect(typeof transport.attach).toBe('function')

    // Messaging
    expect(typeof transport.writeMessage).toBe('function')
    expect(typeof transport.writeSyntheticUserEvent).toBe('function')

    // Process Control
    expect(typeof transport.stop).toBe('function')
    expect(typeof transport.kill).toBe('function')
    expect(typeof transport.interrupt).toBe('function')
    expect(typeof transport.isAlive).toBe('function')

    // Session Management
    expect(typeof transport.renameForSession).toBe('function')
    expect(typeof transport.detach).toBe('function')
    expect(typeof transport.cleanup).toBe('function')
    expect(typeof transport.deletePipe).toBe('function')

    // Message Processing
    expect(typeof transport.prepareOutbound).toBe('function')
    expect(typeof transport.processInbound).toBe('function')

    // Streaming Control
    expect(typeof transport.flushTail).toBe('function')
    expect(typeof transport.stopTail).toBe('function')

    // Properties
    expect('pid' in transport).toBe(true)
    expect('outputFile' in transport).toBe(true)
    expect('hasPipe' in transport).toBe(true)
    expect('tailOffset' in transport).toBe(true)
    expect('fileSize' in transport).toBe(true)
    expect('processName' in transport).toBe(true)
    expect('host' in transport).toBe(true)
    expect('isRemote' in transport).toBe(true)
    expect('imageCache' in transport).toBe(true)
    expect('lastEventAt' in transport).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  B2: RemoteSessionManager.writeMessage guard
// ═══════════════════════════════════════════════════════════════════

describe('B2: RemoteSessionManager.writeMessage guard (before start)', () => {
  it('writeMessage resolves to false without calling start()', async () => {
    const transport = new RemoteSessionManager('daemon-b2-001', 'testhost', testSshTarget)

    // No start() called — should resolve false (no conn, no sid), not throw
    const result = await transport.writeMessage('hello')
    expect(result).toBe(false)
  })

  it('hasPipe is false before start()', () => {
    const transport = new RemoteSessionManager('daemon-b2-002', 'testhost', testSshTarget)
    expect(transport.hasPipe).toBe(false)
  })

  it('pid is null before start()', () => {
    const transport = new RemoteSessionManager('daemon-b2-003', 'testhost', testSshTarget)
    expect(transport.pid).toBeNull()
  })

  it('no exceptions thrown/rejected on writeMessage before start', async () => {
    const transport = new RemoteSessionManager('daemon-b2-004', 'testhost', testSshTarget)

    // Async signature — must not throw synchronously nor reject.
    await expect(transport.writeMessage('hello')).resolves.toBe(false)
    await expect(transport.writeMessage('')).resolves.toBe(false)
    await expect(transport.writeMessage('a'.repeat(10000))).resolves.toBe(false)
  })

  it('lastEventAt is 0 before start()', () => {
    const transport = new RemoteSessionManager('daemon-b2-005', 'testhost', testSshTarget)
    expect(transport.lastEventAt).toBe(0)
  })

  it('outputFile is null for remote sessions', () => {
    const transport = new RemoteSessionManager('daemon-b2-006', 'testhost', testSshTarget)
    expect(transport.outputFile).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  B2b: writeMessage must not short-circuit on stale _hasPipe cache.
//
//  Before fix: after a WS reconnect, `_hasPipe` stayed false → writeMessage
//  short-circuited → session runner fell back to `--resume` spawn, producing
//  synthetic `[Request interrupted by user]` + `No response requested.` in
//  the transcript.
//  This block locks in the "daemon is the arbiter of pipe liveness" property.
// ═══════════════════════════════════════════════════════════════════

describe('B2b: writeMessage asks daemon as source of truth (strict ack, no stale cache short-circuit)', () => {
  // Minimal DaemonConnection-shaped mock. RemoteSessionManager only uses
  // `.connected` + `.send(...)` in writeMessage, so a plain object suffices.
  function makeMockConn(sendImpl: (cmd: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>) {
    return {
      connected: true,
      send: vi.fn(sendImpl),
    }
  }

  // Simulates "session alive on daemon, local `_hasPipe` cache out-of-sync"
  // (e.g. after WS disconnect/reconnect). Bypassing `start()` is intentional:
  // these tests isolate the writeMessage gate, not the startup path.
  function injectState(
    transport: RemoteSessionManager,
    conn: { connected: boolean; send: unknown },
    sid: string | null,
    hasPipe: boolean,
  ) {
    const internal = transport as unknown as {
      conn: unknown
      _sid: string | null
      _hasPipe: boolean
    }
    internal.conn = conn
    internal._sid = sid
    internal._hasPipe = hasPipe
  }

  it('calls daemon send even when _hasPipe=false (bug scenario: cache desynced after WS reconnect)', async () => {
    const transport = new RemoteSessionManager('daemon-b2b-001', 'testhost', testSshTarget)
    const mockConn = makeMockConn(async () => ({ ok: true }))

    // Simulate post-WS-reconnect state: session alive on daemon, but local
    // _hasPipe cache was cleared and never restored. Writer must ignore the
    // stale local cache and ask the daemon (source of truth).
    injectState(transport, mockConn, 'session-abc', false)

    // Strict-ack contract: awaits the daemon's reply before returning.
    const result = await transport.writeMessage('hello')
    expect(result).toBe(true)

    expect(mockConn.send).toHaveBeenCalledTimes(1)
    // Exact payload match — prepareOutbound is identity for plain text. If it
    // ever starts rewriting messages, this assertion should catch it.
    expect(mockConn.send).toHaveBeenCalledWith('send', { sid: 'session-abc', message: 'hello' })
  })

  it('resolves false when WS is disconnected (conn.connected=false)', async () => {
    const transport = new RemoteSessionManager('daemon-b2b-002', 'testhost', testSshTarget)
    const mockConn = { connected: false, send: vi.fn(async () => ({ ok: true })) }
    injectState(transport, mockConn, 'session-def', true)

    const result = await transport.writeMessage('hello')

    expect(result).toBe(false)
    expect(mockConn.send).not.toHaveBeenCalled()
  })

  it('resolves false when session has no sid yet (start not completed)', async () => {
    const transport = new RemoteSessionManager('daemon-b2b-003', 'testhost', testSshTarget)
    const mockConn = makeMockConn(async () => ({ ok: true }))
    injectState(transport, mockConn, null, true)

    const result = await transport.writeMessage('hello')

    expect(result).toBe(false)
    expect(mockConn.send).not.toHaveBeenCalled()
  })

  it('resolves false and clears _hasPipe + fires onExit when daemon reports ENXIO (remote process truly dead)', async () => {
    const transport = new RemoteSessionManager('daemon-b2b-004', 'testhost', testSshTarget)
    const mockConn = makeMockConn(async () => ({ ok: false, reason: 'ENXIO' }))
    injectState(transport, mockConn, 'session-xyz', true)

    let exitCode: number | null = null
    ;(transport as unknown as { _onExit: (code: number) => void })._onExit = (code) => {
      exitCode = code
    }

    // Strict-ack: writeMessage awaits the daemon response and surfaces the
    // failure. Caller (SessionRunner.processNext) sees `false`, leaves the
    // message queued, and falls through to gracefulStop + --resume respawn.
    const result = await transport.writeMessage('hello')
    expect(result).toBe(false)

    // Dead-pipe bookkeeping still happens so downstream cleanup runs.
    expect(transport.hasPipe).toBe(false)
    expect(exitCode).toBe(1)
  })

  it('resolves false on EAGAIN (FIFO buffer full) — caller can retry via respawn path', async () => {
    const transport = new RemoteSessionManager('daemon-b2b-005', 'testhost', testSshTarget)
    const mockConn = makeMockConn(async () => ({ ok: false, reason: 'EAGAIN' }))
    injectState(transport, mockConn, 'session-eagain', true)

    const result = await transport.writeMessage('hello')
    expect(result).toBe(false)
  })

  it('resolves false when daemon.send throws (transport error)', async () => {
    const transport = new RemoteSessionManager('daemon-b2b-006', 'testhost', testSshTarget)
    const mockConn = makeMockConn(async () => {
      throw new Error('ws closed mid-send')
    })
    injectState(transport, mockConn, 'session-throw', true)

    const result = await transport.writeMessage('hello')
    expect(result).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  B3: DaemonConnection.disconnect cleanup
// ═══════════════════════════════════════════════════════════════════

describe('B3: DaemonConnection.disconnect cleanup', () => {
  it('connected is false before connect()', () => {
    const conn = new DaemonConnection('cleanup-host', testSshTarget)
    expect(conn.connected).toBe(false)
  })

  it('disconnect is idempotent — calling twice does not throw', () => {
    const conn = new DaemonConnection('cleanup-host', testSshTarget)

    // First call
    expect(() => conn.disconnect()).not.toThrow()

    // Second call — should be safe
    expect(() => conn.disconnect()).not.toThrow()
  })

  it('send throws "not connected" after disconnect', async () => {
    const conn = new DaemonConnection('cleanup-host', testSshTarget)
    conn.disconnect()

    // send() should throw because we never connected (and we're destroyed)
    await expect(conn.send('ping', {})).rejects.toThrow(/not connected/i)
  })

  it('internal state is clean after disconnect', () => {
    const conn = new DaemonConnection('cleanup-host', testSshTarget)
    conn.disconnect()

    // Access private fields via type cast for testing
    const internal = conn as unknown as {
      _destroyed: boolean
      pendingCommands: Map<number, unknown>
      reconnectTimer: ReturnType<typeof setTimeout> | null
      pingTimer: ReturnType<typeof setInterval> | null
    }

    expect(internal._destroyed).toBe(true)
    expect(internal.pendingCommands.size).toBe(0)
    expect(internal.reconnectTimer).toBeNull()
    expect(internal.pingTimer).toBeNull()
  })

  it('connected is false after disconnect', () => {
    const conn = new DaemonConnection('cleanup-host', testSshTarget)
    conn.disconnect()
    expect(conn.connected).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  B5: ClaudeCodeSession.transport getter
// ═══════════════════════════════════════════════════════════════════

describe('B5: ClaudeCodeSession.transport getter', () => {
  it('transport is null before send()', async () => {
    const { ClaudeCodeSession } = await import('../../src/providers/claude-code-session.js')
    const session = new ClaudeCodeSession('test-task', 'TestProject')

    expect(session.transport).toBeNull()
  })

  it('hasPipe is false before send()', async () => {
    const { ClaudeCodeSession } = await import('../../src/providers/claude-code-session.js')
    const session = new ClaudeCodeSession('test-task', 'TestProject')

    expect(session.hasPipe).toBe(false)
  })

  it('transport getter exists on ClaudeCodeSession', async () => {
    const { ClaudeCodeSession } = await import('../../src/providers/claude-code-session.js')
    const session = new ClaudeCodeSession('test-task', 'TestProject')

    // Verify the getter is defined on the prototype
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(session),
      'transport',
    )
    expect(descriptor).toBeDefined()
    expect(typeof descriptor!.get).toBe('function')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  B6: recoverDisconnectedSessions host normalization (regression)
//
//  Bug: a local session persists NO host field (host=null), but the local
//  connection's hostKey is '__local__'. The reconnect-recovery loop filtered
//  with a raw `s.host !== this.hostKey`, which is ALWAYS true for local
//  sessions → every local session was skipped → after a local-daemon WS flap
//  its daemon-side subscriber was never re-added → UI froze ("running, no
//  output") until a manual refresh. Fix normalizes `s.host ?? '__local__'`.
// ═══════════════════════════════════════════════════════════════════

describe('B6: recoverDisconnectedSessions host normalization (local sessions)', () => {
  afterEach(() => { vi.resetModules() })

  // Build a __local__ DaemonConnection whose recovery loop we can drive with a
  // mocked session list + a spied conn.send. Returns the spy so the test can
  // assert which sessions the loop actually processed (vs silently skipped).
  async function runRecoverWith(sessionRecords: Array<Record<string, unknown>>) {
    vi.doMock('../../src/core/session-tracker.js', () => ({
      listSessions: vi.fn().mockResolvedValue(sessionRecords),
      updateSessionRecord: vi.fn(async (
        sessionId: string,
        updates: Record<string, unknown>,
      ) => ({
        ...sessionRecords.find((record) => record.claudeSessionId === sessionId),
        ...updates,
      })),
      emitSessionStatusChanged: vi.fn(),
    }))
    vi.doMock('../../src/core/event-bus.js', () => ({
      bus: { emit: vi.fn() },
      EventNames: { SESSION_STATUS_CHANGED: 'session:status-changed' },
    }))
    const { DaemonConnection: DC } = await import('../../src/providers/daemon-connection.js')
    const conn = new DC('__local__', null)
    const priv = conn as unknown as Record<string, (...a: unknown[]) => unknown>
    // status → alive so the loop proceeds to reattach; attach → ok no-op.
    const send = vi.spyOn(priv, 'send').mockResolvedValue({ ok: true, alive: true } as never)
    // getRegisteredSessionManager has no manager in this unit context → the
    // loop logs "no manager to reattach" and moves on. We only assert the
    // host-filter decision (did send('status') fire for this sid?).
    await (priv.recoverDisconnectedSessions as () => Promise<void>)()
    return send
  }

  it('processes a local idle session (host=null) — not skipped by host filter', async () => {
    const send = await runRecoverWith([
      { claudeSessionId: 'local-idle-1', host: null, process_status: 'idle', archived: false },
    ])
    const statusCalls = send.mock.calls.filter(
      ([cmd, payload]) => cmd === 'status' && (payload as { sid?: string })?.sid === 'local-idle-1',
    )
    expect(statusCalls.length).toBe(1)
  })

  it('still skips a terminal (stopped) local session', async () => {
    const send = await runRecoverWith([
      { claudeSessionId: 'local-stopped-1', host: null, process_status: 'stopped', archived: false },
    ])
    const statusCalls = send.mock.calls.filter(([cmd]) => cmd === 'status')
    expect(statusCalls.length).toBe(0)
  })

  it('still skips a remote session (host=myhost) on the __local__ connection', async () => {
    const send = await runRecoverWith([
      { claudeSessionId: 'remote-1', host: 'myhost', process_status: 'idle', archived: false },
    ])
    const statusCalls = send.mock.calls.filter(([cmd]) => cmd === 'status')
    expect(statusCalls.length).toBe(0)
  })
})
