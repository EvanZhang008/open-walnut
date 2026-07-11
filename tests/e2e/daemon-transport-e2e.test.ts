/**
 * E2E tests for RemoteSessionManager via MockDaemon.
 *
 * Uses a local MockDaemon WebSocket server instead of SSH.
 * Tests the real RemoteSessionManager + DaemonConnection code path
 * with mock-claude.mjs simulating the Claude CLI.
 *
 * What's real: RemoteSessionManager, DaemonConnection, FIFO + JSONL polling, event callbacks.
 * What's mocked: SSH (bypassed via directWsUrl), Claude CLI (mock-claude.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { SESSION_STREAMS_DIR } from '../../src/constants.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import type { SshTarget } from '../../src/providers/session-io.js'

// Fake SSH target (not used since we bypass SSH)
const fakeSshTarget: SshTarget = { hostname: 'localhost' }

let daemon: MockDaemon

beforeAll(async () => {
  fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })
  daemon = await createMockDaemon()
})

afterAll(async () => {
  await daemon.stop()
})

// ═══════════════════════════════════════════════════════════════════
//  1. Session lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('RemoteSessionManager session lifecycle', () => {
  it('start session → receives init + assistant + result events', async () => {
    const tmpId = `test-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    const lines: string[] = []
    let exitCode: number | null = null

    const result = await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'hello from test',
      onOutput: (event) => { lines.push(event.line) },
      onExit: (code) => { exitCode = code },
    })

    expect(result.pid).toBeGreaterThan(0)
    expect(result.outputFile).toContain(tmpId)

    // Wait for mock-claude to produce all events (init → assistant → result → exit)
    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    // Verify we received JSONL events
    expect(lines.length).toBeGreaterThanOrEqual(3) // init + assistant + result

    // Parse events
    const events = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const types = events.map(e => e.type)
    expect(types).toContain('system')    // init
    expect(types).toContain('assistant')  // response
    expect(types).toContain('result')     // final result

    // Verify result is success
    const resultEvent = events.find(e => e.type === 'result')
    expect(resultEvent.is_error).toBe(false)
    expect(resultEvent.result).toContain('hello from test')

    await transport.cleanup()
  })

  it('error message → session exits with error', async () => {
    const tmpId = `test-err-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    let exitCode: number | null = null

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'error',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    expect(exitCode).toBe(1)

    await transport.cleanup()
  })

  it('slow session → events arrive after delay', async () => {
    const tmpId = `test-slow-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    const lines: string[] = []
    let exitCode: number | null = null
    const startTime = Date.now()

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:500 delayed message',
      onOutput: (event) => { lines.push(event.line) },
      onExit: (code) => { exitCode = code },
    })

    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    const elapsed = Date.now() - startTime
    expect(elapsed).toBeGreaterThan(400) // slow:500 should take at least 400ms

    // Verify result arrived — the "slow:" prefix is parsed by mock-claude
    const events = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    expect(events.length).toBeGreaterThanOrEqual(2) // at least init + result
    const resultEvent = events.find(e => e.type === 'result')
    expect(resultEvent).toBeDefined()

    await transport.cleanup()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  2. Process control
// ═══════════════════════════════════════════════════════════════════

describe('RemoteSessionManager process control', () => {
  it('stop() → process ends gracefully', async () => {
    const tmpId = `test-stop-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    let exitCode: number | null = null

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:30000 long running',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    // Process should be running
    const alive = await transport.isAlive()
    expect(alive).toBe(true)

    // Stop it
    await transport.stop()

    // Wait for exit
    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    await transport.cleanup()
  })

  it('isAlive() → false after process exits', async () => {
    const tmpId = `test-alive-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    let exitCode: number | null = null

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'quick message',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    // Wait for exit
    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    // Process should be dead now
    const alive = await transport.isAlive()
    expect(alive).toBe(false)

    await transport.cleanup()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  3. Event tracking (no local file — uses lastEventAt instead)
// ═══════════════════════════════════════════════════════════════════

describe('RemoteSessionManager event tracking', () => {
  it('lastEventAt updated on JSONL events', async () => {
    const tmpId = `test-event-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    // Before start, lastEventAt should be 0
    expect(transport.lastEventAt).toBe(0)

    let exitCode: number | null = null

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'event tracking test',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    // After events, lastEventAt should be > 0
    expect(transport.lastEventAt).toBeGreaterThan(0)
    // Should be recent (within last 10 seconds)
    expect(Date.now() - transport.lastEventAt).toBeLessThan(10_000)

    await transport.cleanup()
  })

  it('fileSize property reflects accumulated bytes from events', async () => {
    const tmpId = `test-size-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    let exitCode: number | null = null

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'size test',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    // tailOffset tracks accumulated bytes from events
    expect(transport.tailOffset).toBeGreaterThan(0)

    await transport.cleanup()
  })

  it('outputFile is null for remote sessions', async () => {
    const tmpId = `test-nofile-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    // Remote sessions should not have a local output file
    expect(transport.outputFile).toBeNull()

    await transport.cleanup()
  })

  it('writeSyntheticUserEvent → daemon appends exactly ONE walnut-injected marker to the stream file', async () => {
    const tmpId = `test-marker-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    let exitCode: number | null = null
    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'marker test',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })
    await vi.waitFor(() => { expect(exitCode).not.toBeNull() }, { timeout: 10_000, interval: 100 })

    transport.writeSyntheticUserEvent('follow-up message', 'qm-777-marker')

    // Fire-and-forget RPC — wait for the marker to land on disk.
    const streamFile = daemon.streamFilePath(tmpId)
    await vi.waitFor(() => {
      expect(fs.readFileSync(streamFile, 'utf-8')).toContain('qm-777-marker')
    }, { timeout: 5_000, interval: 50 })

    const lines = fs.readFileSync(streamFile, 'utf-8').split('\n').filter(Boolean)
    const markers = lines.map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter((e): e is Record<string, unknown> => !!e)
      .filter(e => e.subtype === 'walnut-injected')
    // Exactly one marker per send — a double write would resurface as a
    // duplicated user bubble in the console (dedup is id-based, twins share the id).
    expect(markers.length).toBe(1)
    expect(markers[0].walnutMessageId).toBe('qm-777-marker')
    expect((markers[0].message as { content?: string }).content).toBe('follow-up message')

    await transport.cleanup()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  4. WebSocket disconnect
// ═══════════════════════════════════════════════════════════════════

describe('RemoteSessionManager disconnect handling', () => {
  it('WS disconnect during session → writeMessage returns false, isAlive stays true (grace period)', async () => {
    // Use a separate daemon instance for this test (we'll kill it)
    const isolatedDaemon = await createMockDaemon()

    const tmpId = `test-disconnect-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${isolatedDaemon.port}`)

    let exitCode: number | null = null

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:30000 will be interrupted',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    // Inject disconnect fault — next message will trigger WS close
    isolatedDaemon.injectFault('disconnect')

    // Send a command to trigger the disconnect — writeMessage resolves (not rejects)
    // on transport error under the strict-ack contract, so no await/catch needed.
    await transport.writeMessage('trigger disconnect').catch(() => {})

    // Wait for the disconnect to propagate
    await new Promise(r => setTimeout(r, 2000))

    // After WS disconnect:
    // - isAlive() returns true during the 5-minute grace period (disconnect ≠ process death)
    // - writeMessage() returns false (connection is down, can't deliver messages)
    const alive = await transport.isAlive()
    expect(alive).toBe(true) // grace period — process may still be alive on remote

    const sent = await transport.writeMessage('should fail')
    expect(sent).toBe(false) // connection is down — can't send

    await transport.cleanup()
    await isolatedDaemon.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  5. Multiple sessions
// ═══════════════════════════════════════════════════════════════════

describe('RemoteSessionManager concurrent sessions', () => {
  it('two sessions on same daemon → independent events', async () => {
    const tmpId1 = `test-multi1-${Date.now()}`
    const tmpId2 = `test-multi2-${Date.now() + 1}`
    const transport1 = new RemoteSessionManager(tmpId1, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)
    const transport2 = new RemoteSessionManager(tmpId2, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    const lines1: string[] = []
    const lines2: string[] = []
    let exit1: number | null = null
    let exit2: number | null = null

    // Start first session
    await transport1.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'session one',
      onOutput: (event) => { lines1.push(event.line) },
      onExit: (code) => { exit1 = code },
    })

    // Start second session (slight delay to avoid race)
    await new Promise(r => setTimeout(r, 100))

    await transport2.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'session two',
      onOutput: (event) => { lines2.push(event.line) },
      onExit: (code) => { exit2 = code },
    })

    // Wait for both to finish
    await vi.waitFor(() => {
      expect(exit1).not.toBeNull()
      expect(exit2).not.toBeNull()
    }, { timeout: 15_000, interval: 100 })

    // Each transport should have received events (at minimum init + result)
    expect(lines1.length).toBeGreaterThanOrEqual(2)
    expect(lines2.length).toBeGreaterThanOrEqual(2)

    // Events should have different session IDs (no cross-contamination)
    const events1 = lines1.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const events2 = lines2.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

    // Both should have a result event containing their respective message
    const result1 = events1.find(e => e.type === 'result')
    const result2 = events2.find(e => e.type === 'result')
    expect(result1).toBeDefined()
    expect(result2).toBeDefined()
    expect(result1!.result).toContain('session one')
    expect(result2!.result).toContain('session two')

    await transport1.cleanup()
    await transport2.cleanup()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  6. Session rename
// ═══════════════════════════════════════════════════════════════════

describe('RemoteSessionManager session rename', () => {
  it('renameForSession → events still arrive after _sid rename', async () => {
    const tmpId = `test-rename-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    const lines: string[] = []
    let exitCode: number | null = null

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:1000 rename test message',
      onOutput: (event) => { lines.push(event.line) },
      onExit: (code) => { exitCode = code },
    })

    // Wait for the init event to arrive so we can extract the session_id
    await vi.waitFor(() => {
      expect(lines.length).toBeGreaterThanOrEqual(1)
    }, { timeout: 5_000, interval: 50 })

    const initEvent = JSON.parse(lines[0])
    expect(initEvent.type).toBe('system')
    const realSessionId = initEvent.session_id
    expect(realSessionId).toBeTruthy()

    // Rename _sid from tmpId to the real session ID
    transport.renameForSession(realSessionId)

    // Wait for the session to complete — events should still arrive under new _sid
    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    // Verify we received assistant + result events after the rename
    const events = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const types = events.map(e => e.type)
    expect(types).toContain('assistant')
    expect(types).toContain('result')

    // Verify result contains our message
    const resultEvent = events.find(e => e.type === 'result')
    expect(resultEvent!.result).toContain('rename test message')

    await transport.cleanup()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  7. Tool use events
// ═══════════════════════════════════════════════════════════════════

describe('RemoteSessionManager tool events', () => {
  it('tool-test message → receives tool_use + tool_result + assistant + result events', async () => {
    const tmpId = `test-tool-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    const lines: string[] = []
    let exitCode: number | null = null

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'tool-test',
      onOutput: (event) => { lines.push(event.line) },
      onExit: (code) => { exitCode = code },
    })

    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    expect(exitCode).toBe(0)

    // Parse all events
    const events = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const types = events.map(e => e.type)

    // Should have: system (init), assistant (tool_use), user (tool_result), assistant (text), result
    expect(types).toContain('system')
    expect(types).toContain('assistant')
    expect(types).toContain('user')
    expect(types).toContain('result')

    // Find the tool_use event (assistant with tool_use content)
    const toolUseEvent = events.find(e =>
      e.type === 'assistant' &&
      e.message?.content?.some((c: Record<string, unknown>) => c.type === 'tool_use')
    )
    expect(toolUseEvent).toBeDefined()
    expect(toolUseEvent!.message.content[0].name).toBe('Read')

    // Find the tool_result event (user with tool_result content)
    const toolResultEvent = events.find(e =>
      e.type === 'user' &&
      e.message?.content?.some((c: Record<string, unknown>) => c.type === 'tool_result')
    )
    expect(toolResultEvent).toBeDefined()
    expect(toolResultEvent!.message.content[0].tool_use_id).toBe('toolu_mock_001')

    await transport.cleanup()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  8. Connection reuse
// ═══════════════════════════════════════════════════════════════════

describe('RemoteSessionManager connection reuse', () => {
  it('sequential sessions on same daemon → both succeed without redeploy', async () => {
    // First session
    const tmpId1 = `test-reuse1-${Date.now()}`
    const transport1 = new RemoteSessionManager(tmpId1, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    let exit1: number | null = null
    const result1 = await transport1.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'first session',
      onOutput: () => {},
      onExit: (code) => { exit1 = code },
    })

    await vi.waitFor(() => {
      expect(exit1).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    expect(result1.pid).toBeGreaterThan(0)
    await transport1.cleanup()

    // Second session on the same daemon — should work without any SSH/redeploy
    const tmpId2 = `test-reuse2-${Date.now()}`
    const transport2 = new RemoteSessionManager(tmpId2, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    let exit2: number | null = null
    const result2 = await transport2.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'second session',
      onOutput: () => {},
      onExit: (code) => { exit2 = code },
    })

    await vi.waitFor(() => {
      expect(exit2).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    expect(result2.pid).toBeGreaterThan(0)
    // Second session should get a different PID (different CLI process)
    expect(result2.pid).not.toBe(result1.pid)

    await transport2.cleanup()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  9. directWsUrl bypasses SSH
// ═══════════════════════════════════════════════════════════════════

describe('RemoteSessionManager source fallback', () => {
  it('directWsUrl set → manager connects without SSH', async () => {
    const tmpId = `test-direct-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    const lines: string[] = []
    let exitCode: number | null = null

    const result = await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'direct connect test',
      onOutput: (event) => { lines.push(event.line) },
      onExit: (code) => { exitCode = code },
    })

    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    // Verify the session worked end-to-end via direct WebSocket
    expect(result.pid).toBeGreaterThan(0)
    expect(exitCode).toBe(0)

    const events = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const resultEvent = events.find(e => e.type === 'result')
    expect(resultEvent).toBeDefined()
    expect(resultEvent!.result).toContain('direct connect test')

    await transport.cleanup()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  10. Interrupt and kill
// ═══════════════════════════════════════════════════════════════════

describe('RemoteSessionManager interrupt and kill', () => {
  it('interrupt() → process stops and hasPipe becomes false', async () => {
    const tmpId = `test-interrupt-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    let exitCode: number | null = null

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:30000 will be interrupted',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    // Process should be running
    expect(transport.hasPipe).toBe(true)
    const alive = await transport.isAlive()
    expect(alive).toBe(true)

    // Interrupt
    await transport.interrupt()

    // hasPipe should be false immediately after interrupt()
    expect(transport.hasPipe).toBe(false)

    // Wait for exit
    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    // Process should be dead
    const aliveAfter = await transport.isAlive()
    expect(aliveAfter).toBe(false)

    await transport.cleanup()
  })

  it('kill() → immediate termination, hasPipe false', async () => {
    const tmpId = `test-kill-${Date.now()}`
    const transport = new RemoteSessionManager(tmpId, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    let exitCode: number | null = null

    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:30000 will be killed',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    // Process should be running
    const alive = await transport.isAlive()
    expect(alive).toBe(true)

    // Kill — fire-and-forget, synchronous hasPipe = false
    transport.kill()

    // hasPipe should be false immediately
    expect(transport.hasPipe).toBe(false)

    // Wait for exit
    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 100 })

    // Process should be dead
    const aliveAfter = await transport.isAlive()
    expect(aliveAfter).toBe(false)

    await transport.cleanup()
  })
})
