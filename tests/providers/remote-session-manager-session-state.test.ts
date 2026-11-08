/**
 * L2.1 — RemoteSessionManager session_state subscription (8 tests).
 *
 * Verifies the client-side contract for the `session_state` daemon event:
 *   - sid / _prevSid matching
 *   - idempotent _hasPipe dedup (state=dead + legacy exit should fire _onExit once)
 *   - adopted:true is informational only (does NOT fire _onExit)
 *   - un-started manager ignores events
 *   - missing exitCode falls back to 1
 *
 * Strategy: construct a real DaemonConnection via `connectDirect(ws://...)` to a
 * MockDaemon. Call `RemoteSessionManager.start()` so _sid and handlers are wired
 * up, then directly emit session_state events from the mock daemon to all
 * connected clients. Assert on spies passed as onExit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { SendHeldError } from '../../src/providers/delivery-failure.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { WALNUT_HOME } from '../../src/constants.js'

const TEST_TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

describe('L2.1 RemoteSessionManager session_state wire-level contract', () => {
  let daemon: MockDaemon
  let mgr: RemoteSessionManager
  let onExit: ReturnType<typeof vi.fn>
  let onOutput: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    daemon = await createMockDaemon()
    onExit = vi.fn()
    onOutput = vi.fn()
    mgr = new RemoteSessionManager(
      'sid-test',
      'testhost',
      TEST_TARGET,
      `ws://127.0.0.1:${daemon.port}`,
    )
    // The CLI must stay alive for the whole test, as Walnut's long-running
    // stream-json CLI does: these tests count onExit calls, and a CLI that exits
    // on its own makes the daemon send a real `exit` on top of the injected ones.
    // With no flags and a message the mock CLI ran one json turn and exited, and
    // its `exit` (about 100ms later, on a busy box inside the test) was the flake.
    // An init-only FIFO spawn idles on stdin until the daemon stops it.
    await mgr.start({
      args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      message: '',
      cwd: '/tmp',
      onOutput,
      onExit,
    })
  })

  // Every frame of a test crosses one socket in order, and the manager handles
  // exit/session_state synchronously, so once a sentinel line emitted after them
  // reaches onOutput every earlier frame has been handled. Never a fixed sleep:
  // a busy event loop runs an expired timer before it reads the frame.
  let barrierSeq = 0
  async function framesHandled(sid = 'sid-test'): Promise<void> {
    const line = `BARRIER:${++barrierSeq}`
    daemon.emitEvent('jsonl', { sid, line })
    await vi.waitFor(() => expect(onOutput.mock.calls.some((c) => c[0]?.line === line)).toBe(true))
  }

  afterEach(async () => {
    try { await mgr.cleanup() } catch { /* best effort */ }
    await daemon.stop()
  })

  it('separates maintenance, user stop and refused idle cleanup', async () => {
    const conn = (mgr as unknown as { conn: { send: (...args: unknown[]) => Promise<unknown> } }).conn
    const send = vi.spyOn(conn, 'send').mockResolvedValue({ ok: true, stopped: true })
    try {
      await mgr.stop()
      // Every stop names this Walnut to a daemon that checks ownership (owner-home-v1).
      expect(send.mock.calls[0]).toEqual(['stop', { sid: 'sid-test', reason: 'maintenance', home: WALNUT_HOME, initiator: 'human' }, 10_000])
      send.mockResolvedValueOnce({ ok: true, stopped: false, reason: 'cron_supervised' })
      expect(await mgr.stopForIdle()).toBe('refused')
      expect(mgr.hasPipe).toBe(true)
      await mgr.stop('user')
      expect(send.mock.calls[2]).toEqual(['stop', { sid: 'sid-test', reason: 'user', home: WALNUT_HOME, initiator: 'human' }, 10_000])
      // Interrupt is a process stop that keeps cron supervision armed; a user's
      // Terminate sends reason 'user' through sessionStops instead (same contract
      // as session-stop-delivery.test.ts).
      await mgr.interrupt()
      expect(send.mock.calls[3]).toEqual(['stop', { sid: 'sid-test', reason: 'maintenance', home: WALNUT_HOME, initiator: 'human' }, 10_000])
    } finally { send.mockRestore() }
  })

  // M1 — session_state=dead flips _hasPipe=false and calls _onExit(exitCode)
  it('M1: session_state=dead calls _onExit(exitCode) and clears hasPipe', async () => {
    expect(mgr.hasPipe).toBe(true)
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 42 })
    // Poll, never a fixed sleep: the frame crosses a real socket, so a busy event
    // loop runs an expired 30ms timer before it reads the frame.
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(42, undefined))
    expect(mgr.hasPipe).toBe(false)
  })

  // A CLI that failed at startup: the daemon's stderr tail rides the broadcast,
  // so the session shows the message, not a bare exit code.
  it('M1b: session_state=dead hands the daemon stderr tail to _onExit', async () => {
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 1, stderr: 'Error: MCP config is not a valid JSON' })
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(1, 'Error: MCP config is not a valid JSON'))
  })

  // M2 — two session_state=dead in a row → _onExit only called once (dedup via _hasPipe)
  it('M2: repeated session_state=dead fires _onExit only once (dedup)', async () => {
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 7 })
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 99 })
    await framesHandled()
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith(7, undefined)
  })

  // M3 — sid mismatch → event ignored
  it('M3: session_state for unrelated sid is ignored', async () => {
    daemon.emitSessionState('OTHER-SID', 'dead', { exitCode: 1 })
    await framesHandled()
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
  })

  // M4 — event tagged with _prevSid (old sid during rename) still triggers onExit
  it('M4: session_state tagged with _prevSid also matches', async () => {
    // Simulate mid-rename: tmpId was 'sid-test', server now knows new 'sid-real'
    mgr.renameForSession('sid-real')
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 5 })
    await framesHandled()
    expect(onExit).toHaveBeenCalledWith(5, undefined)
  })

  // M5 — session_state=running {adopted:true} does NOT fire _onExit
  it('M5: session_state=running with adopted:true does NOT fire onExit', async () => {
    daemon.emitSessionState('sid-test', 'running', { adopted: true })
    await framesHandled()
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
  })

  // M6 — manager before start() (no _sid) should ignore events gracefully
  it('M6: events for un-started manager are ignored (no crash, no onExit)', async () => {
    const mgr2 = new RemoteSessionManager(
      'never-started',
      'testhost',
      TEST_TARGET,
      `ws://127.0.0.1:${daemon.port}`,
    )
    const onExit2 = vi.fn()
    // Do NOT call start — just attach event listener path by touching conn
    daemon.emitSessionState('never-started', 'dead', { exitCode: 1 })
    await framesHandled()
    expect(onExit2).not.toHaveBeenCalled()
    try { await mgr2.cleanup() } catch { /* no-op */ }
  })

  // M7 — session_state=dead without exitCode → onExit called with default 1
  it('M7: session_state=dead without exitCode falls back to 1', async () => {
    daemon.emitSessionState('sid-test', 'dead')
    await framesHandled()
    expect(onExit).toHaveBeenCalledWith(1, undefined)
  })

  // M8 — receiving both legacy `exit` and session_state=dead → only one onExit fire
  it('M8: legacy exit + session_state=dead fires onExit only once', async () => {
    // Legacy exit first
    daemon.emitEvent('exit', { sid: 'sid-test', code: 11 })
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 22 })
    await framesHandled()
    expect(onExit).toHaveBeenCalledTimes(1)
    // legacy exit path passes (code, stderr); we only assert on the first arg.
    expect(onExit.mock.calls[0][0]).toBe(11)
  })

  // M9 (Bug 1+2 regression) — writeMessage hits session_dead with a CLEAN
  // exitCode 0 (daemon normalized a turn-end). onExit MUST receive the real 0,
  // not a hardcoded 1. Downstream handleRemoteProcessExit gates on `code !== 0`,
  // so 0 short-circuits the bogus session:error while _hasPipe cleanup still
  // runs and writeMessage returns false (→ caller --resume recovers).
  it('M9: writeMessage on clean-exit session_dead passes REAL exitCode 0 to onExit (no fake crash)', async () => {
    daemon.simulateDeath('sid-test', 0)
    const ok = await mgr.writeMessage('next turn')
    await new Promise((r) => setTimeout(r, 20))
    expect(ok).toBe(false)                 // send failed → caller falls back to --resume
    expect(onExit).toHaveBeenCalledWith(0, undefined) // real code, NOT hardcoded 1
    expect(mgr.hasPipe).toBe(false)        // cleanup still ran
  })

  // M10 (Bug 1+2 regression) — a genuine non-zero crash exitCode is still
  // forwarded faithfully (we didn't break the real-error path).
  it('M10: writeMessage on crash session_dead forwards the real non-zero exitCode', async () => {
    daemon.simulateDeath('sid-test', 137)
    const ok = await mgr.writeMessage('next turn')
    await new Promise((r) => setTimeout(r, 20))
    expect(ok).toBe(false)
    expect(onExit).toHaveBeenCalledWith(137, undefined)
  })

  it.each([true, false])('sends markers once using daemon capability=%s', async (supportsMarkers) => {
    const conn = (mgr as unknown as { conn: { hasCapability: (cap: string) => boolean; send: (...args: unknown[]) => Promise<unknown> } }).conn
    const capability = vi.spyOn(conn, 'hasCapability').mockImplementation((cap: string) => cap === 'send-markers-v1' && supportsMarkers)
    const send = vi.spyOn(conn, 'send').mockResolvedValue({ ok: true })
    const prepare = vi.spyOn(mgr, 'prepareOutbound').mockResolvedValue('prepared text')
    const markers = [{ message: 'original text', messageId: 'qm-marker' }]
    try {
      expect(await mgr.writeMessage('original text', { markers })).toBe(true)
      // Only the marker capability is under test; unrelated capabilities stay off.
      expect(send.mock.calls).toEqual(supportsMarkers ? [
        ['send', { sid: 'sid-test', message: 'prepared text', markers }],
      ] : [
        ['send', { sid: 'sid-test', message: 'prepared text' }],
        ['appendUserMarker', { sid: 'sid-test', message: 'original text', messageId: 'qm-marker' }],
      ])
    } finally {
      capability.mockRestore()
      send.mockRestore()
      prepare.mockRestore()
    }
  })

  it.each([true, false])('resume marker delivery uses the ordered send path when supported=%s', async (supportsMarkers) => {
    const conn = (mgr as unknown as { conn: { hasCapability: (cap: string) => boolean; send: (...args: unknown[]) => Promise<unknown> } }).conn
    const capability = vi.spyOn(conn, 'hasCapability').mockImplementation((cap) => cap === 'send-markers-v1' && supportsMarkers)
    const connect = vi.spyOn(mgr as unknown as { ensureConnected(): Promise<unknown> }, 'ensureConnected').mockResolvedValue(conn)
    const send = vi.spyOn(conn, 'send').mockResolvedValue({ ok: true, pid: 4242, offset: 100 })
    const prepare = vi.spyOn(mgr, 'prepareOutbound').mockResolvedValue('prepared resume')
    const markers = [{ message: 'resume text', messageId: 'qm-resume' }]
    try {
      await mgr.start({ args: [], cwd: '/tmp', message: 'resume text', resume: true, markers, onOutput, onExit })
      expect(send.mock.calls.map(([command]) => command)).toEqual(supportsMarkers ? ['start', 'send'] : ['start', 'appendUserMarker'])
      expect(send.mock.calls[0][1]).toMatchObject({ message: supportsMarkers ? '' : 'prepared resume', resume: true })
      if (supportsMarkers) {
        expect(send.mock.calls[0][1]).toMatchObject({ deferMessage: true })
        expect(send.mock.calls[1][1]).toMatchObject({ message: 'prepared resume', markers })
      } else expect(send.mock.calls[0][1]).not.toHaveProperty('deferMessage')
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(mgr.lastPreparedOutbound).toBe('prepared resume')
    } finally {
      connect.mockRestore()
      capability.mockRestore()
      send.mockRestore()
      prepare.mockRestore()
    }
  })

  // send-boot-wait-v1 (2026-10-30): the first line after a start may wait through a
  // long CLI boot, so it carries bootWait and the client waits past the daemon's
  // 120s boot deadline. Only that first ask; never to a daemon without the capability.
  it.each([true, false])('the first line after a start waits through the boot when the daemon can (boot-wait=%s)', async (bootWait) => {
    const conn = (mgr as unknown as { conn: { hasCapability: (cap: string) => boolean; send: (...args: unknown[]) => Promise<unknown> } }).conn
    // A daemon with send-boot-wait-v1 but not write-boot-wait-v1 (one older than
    // 2026-11-05): only the first line waits. The newer rule is the next test.
    const capability = vi.spyOn(conn, 'hasCapability').mockImplementation((cap: string) =>
      cap === 'write-boot-wait-v1' ? false : cap !== 'send-boot-wait-v1' || bootWait)
    const connect = vi.spyOn(mgr as unknown as { ensureConnected(): Promise<unknown> }, 'ensureConnected').mockResolvedValue(conn)
    const send = vi.spyOn(conn, 'send').mockResolvedValue({ ok: true, pid: 4242, offset: 100 })
    const prepare = vi.spyOn(mgr, 'prepareOutbound').mockResolvedValue('prepared resume')
    const markers = [{ message: 'resume text', messageId: 'qm-boot' }]
    try {
      await mgr.start({ args: [], cwd: '/tmp', message: 'resume text', resume: true, markers, onOutput, onExit })
      expect(send.mock.calls.map(([command]) => command)).toEqual(['start', 'send'])
      // The start itself carries no message here (deferred), so it waits as before.
      expect(send.mock.calls[0][1]).not.toHaveProperty('bootWait')
      expect(send.mock.calls[0][2]).toBeUndefined()
      if (bootWait) {
        expect(send.mock.calls[1][1]).toMatchObject({ message: 'prepared resume', bootWait: true })
        expect(send.mock.calls[1][2]).toBe(150_000)
      } else {
        expect(send.mock.calls[1][1]).not.toHaveProperty('bootWait')
        expect(send.mock.calls[1][2]).toBeUndefined()
      }
      // A later line is a plain send.
      send.mockClear()
      expect(await mgr.writeMessage('next', { markers: [{ message: 'next', messageId: 'qm-next' }] })).toBe(true)
      expect(send.mock.calls[0][1]).not.toHaveProperty('bootWait')
      expect(send.mock.calls[0][2]).toBeUndefined()
    } finally {
      connect.mockRestore()
      capability.mockRestore()
      send.mockRestore()
      prepare.mockRestore()
    }
  })

  // write-boot-wait-v1 (2026-11-05): a daemon that waits through a boot for EVERY
  // write answers a send into a CLI still booting only once it read the line, so
  // within the boot window after a spawn here every send waits as long; past it,
  // or with a daemon without the capability, a send keeps the plain budget.
  it.each([
    ['in the boot window, daemon can', true, 0, 150_000],
    ['in the boot window, daemon cannot', false, 0, undefined],
    ['past the boot window, daemon can', true, 151_000, undefined],
  ] as const)('a later line %s', async (_label, writeBootWait, ageMs, timeout) => {
    const conn = (mgr as unknown as { conn: { hasCapability: (cap: string) => boolean; send: (...args: unknown[]) => Promise<unknown> } }).conn
    const capability = vi.spyOn(conn, 'hasCapability').mockImplementation((cap: string) =>
      cap === 'write-boot-wait-v1' ? writeBootWait : cap !== 'send-boot-wait-v1')
    const connect = vi.spyOn(mgr as unknown as { ensureConnected(): Promise<unknown> }, 'ensureConnected').mockResolvedValue(conn)
    const send = vi.spyOn(conn, 'send').mockResolvedValue({ ok: true, pid: 4242, offset: 100 })
    const prepare = vi.spyOn(mgr, 'prepareOutbound').mockResolvedValue('prepared')
    try {
      await mgr.start({ args: [], cwd: '/tmp', message: 'first', resume: true, markers: [{ message: 'first', messageId: 'qm-first' }], onOutput, onExit })
      const internals = mgr as unknown as { _spawnedAtMs: number }
      internals._spawnedAtMs -= ageMs
      send.mockClear()
      expect(await mgr.writeMessage('next', { markers: [{ message: 'next', messageId: 'qm-next' }] })).toBe(true)
      expect(send.mock.calls[0][0]).toBe('send')
      expect(send.mock.calls[0][1]).not.toHaveProperty('bootWait')
      expect(send.mock.calls[0][2]).toBe(timeout)
    } finally {
      connect.mockRestore()
      capability.mockRestore()
      send.mockRestore()
      prepare.mockRestore()
    }
  })

  it.each([
    { bootWait: false, writeBootWait: false },
    { bootWait: true, writeBootWait: false },
    { bootWait: false, writeBootWait: true },
    { bootWait: true, writeBootWait: true },
  ])('write-boot-wait window is independent of send-boot-wait ($bootWait/$writeBootWait)', async ({ bootWait, writeBootWait }) => {
    const conn = (mgr as unknown as { conn: { hasCapability: (cap: string) => boolean; send: (...args: unknown[]) => Promise<unknown> } }).conn
    const capability = vi.spyOn(conn, 'hasCapability').mockImplementation((cap) =>
      cap === 'send-markers-v1'
      || (cap === 'send-boot-wait-v1' && bootWait)
      || (cap === 'write-boot-wait-v1' && writeBootWait))
    const connect = vi.spyOn(mgr as unknown as { ensureConnected(): Promise<unknown> }, 'ensureConnected').mockResolvedValue(conn)
    const send = vi.spyOn(conn, 'send').mockResolvedValue({ ok: true, pid: 4242, offset: 100 })
    const prepare = vi.spyOn(mgr, 'prepareOutbound').mockImplementation(async (text) => text)
    // Mock only the clock: the real socket and its cleanup timers keep running.
    const spawnedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(spawnedAt)
    const markers = [{ message: 'first', messageId: 'qm-window' }]
    try {
      await mgr.start({ args: [], cwd: '/tmp', message: 'first', resume: true, markers, onOutput, onExit })
      expect(send.mock.calls.map(([command]) => command)).toEqual(['start', 'send'])
      expect(send.mock.calls[0][2]).toBeUndefined()
      expect(send.mock.calls[1]).toEqual([
        'send', { sid: 'sid-test', message: 'first', markers, ...(bootWait ? { bootWait: true } : {}) },
        ...((bootWait || writeBootWait) ? [150_000] : []),
      ])
      const nextMarkers = [{ message: 'next', messageId: 'qm-window-next' }]
      const raw = JSON.stringify({ type: 'user', message: { role: 'user', content: 'raw' } })
      // The last millisecond waits; the exact boundary and every later write do not.
      for (const elapsed of [0, 149_999, 150_000, 150_001]) {
        clock.mockReturnValue(spawnedAt + elapsed)
        send.mockClear()
        expect(await mgr.writeMessage('next', { markers: nextMarkers })).toBe(true)
        expect(await mgr.writeRaw(raw)).toBe(true)
        const timeout = writeBootWait && elapsed < 150_000 ? [150_000] : []
        expect(send.mock.calls).toEqual([
          ['send', { sid: 'sid-test', message: 'next', markers: nextMarkers }, ...timeout],
          ['sendRaw', { sid: 'sid-test', raw }, ...timeout],
        ])
      }
    } finally {
      clock.mockRestore()
      connect.mockRestore()
      capability.mockRestore()
      send.mockRestore()
      prepare.mockRestore()
    }
  })

  it('an attached manager has no write-boot-wait spawn window', async () => {
    const attached = new RemoteSessionManager('sid-test', 'testhost', TEST_TARGET, `ws://127.0.0.1:${daemon.port}`)
    try {
      await attached.attach({ sessionId: 'sid-test', onOutput, onExit })
      const conn = (attached as unknown as { conn: { hasCapability: (cap: string) => boolean; send: (...args: unknown[]) => Promise<unknown> } }).conn
      const capability = vi.spyOn(conn, 'hasCapability').mockImplementation((cap) => cap === 'write-boot-wait-v1')
      const send = vi.spyOn(conn, 'send').mockResolvedValue({ ok: true })
      const prepare = vi.spyOn(attached, 'prepareOutbound').mockImplementation(async (text) => text)
      try {
        expect(await attached.writeMessage('next')).toBe(true)
        expect(send.mock.calls).toEqual([['send', { sid: 'sid-test', message: 'next' }]])
      } finally {
        capability.mockRestore()
        send.mockRestore()
        prepare.mockRestore()
      }
    } finally { await attached.cleanup() }
  })

  it('a start that carries its own message waits through the boot when the daemon can', async () => {
    const conn = (mgr as unknown as { conn: { hasCapability: (cap: string) => boolean; send: (...args: unknown[]) => Promise<unknown> } }).conn
    // No send-markers-v1: the message rides the start.
    const capability = vi.spyOn(conn, 'hasCapability').mockImplementation((cap) => cap === 'send-boot-wait-v1')
    const connect = vi.spyOn(mgr as unknown as { ensureConnected(): Promise<unknown> }, 'ensureConnected').mockResolvedValue(conn)
    const send = vi.spyOn(conn, 'send').mockResolvedValue({ ok: true, pid: 4242, offset: 100 })
    const prepare = vi.spyOn(mgr, 'prepareOutbound').mockResolvedValue('prepared first')
    try {
      await mgr.start({ args: [], cwd: '/tmp', message: 'first', resume: true, onOutput, onExit })
      expect(send.mock.calls[0][0]).toBe('start')
      expect(send.mock.calls[0][1]).toMatchObject({ message: 'prepared first', bootWait: true })
      expect(send.mock.calls[0][2]).toBe(150_000)
    } finally {
      connect.mockRestore()
      capability.mockRestore()
      send.mockRestore()
      prepare.mockRestore()
    }
  })

  it('rejects resume success when its first message was not delivered', async () => {
    const conn = (mgr as unknown as { conn: { hasCapability: (cap: string) => boolean; send: (...args: unknown[]) => Promise<unknown> } }).conn
    const capability = vi.spyOn(conn, 'hasCapability').mockImplementation((cap) => cap === 'send-markers-v1')
    const connect = vi.spyOn(mgr as unknown as { ensureConnected(): Promise<unknown> }, 'ensureConnected').mockResolvedValue(conn)
    const send = vi.spyOn(conn, 'send').mockResolvedValueOnce({ ok: true, pid: 4242, offset: 100 })
      .mockResolvedValueOnce({ ok: false, reason: 'rejected' })
    const prepare = vi.spyOn(mgr, 'prepareOutbound').mockResolvedValue('resume text')
    try {
      // A refusal is not a death verdict (5408d5875): the first line is held, and the
      // start still rejects, so the resume is never counted a success.
      const started = mgr.start({ args: [], cwd: '/tmp', message: 'resume text', resume: true,
        markers: [{ message: 'resume text', messageId: 'qm-failed' }], onOutput, onExit,
      })
      await expect(started).rejects.toBeInstanceOf(SendHeldError)
      await expect(started).rejects.toThrow('the session host refused delivery (rejected)')
      expect(send.mock.calls.map(([command]) => command)).toEqual(['start', 'send'])
    } finally {
      connect.mockRestore()
      capability.mockRestore()
      send.mockRestore()
      prepare.mockRestore()
    }
  })

  it('does not append a marker after a refused legacy send', async () => {
    const conn = (mgr as unknown as { conn: { hasCapability: (cap: string) => boolean; send: (...args: unknown[]) => Promise<unknown> } }).conn
    const capability = vi.spyOn(conn, 'hasCapability').mockReturnValue(false)
    const send = vi.spyOn(conn, 'send').mockResolvedValue({ ok: false, reason: 'rejected' })
    const prepare = vi.spyOn(mgr, 'prepareOutbound').mockResolvedValue('text')
    try {
      await expect(mgr.writeMessage('text', { markers: [{ message: 'text', messageId: 'qm-failed' }] })).rejects.toBeInstanceOf(SendHeldError)
      expect(send.mock.calls).toEqual([['send', { sid: 'sid-test', message: 'text' }]])
    } finally {
      capability.mockRestore()
      send.mockRestore()
      prepare.mockRestore()
    }
  })

  // ── L1 versioned events: skip by `v` (covers duplicate + out-of-order in one comparison) ──
  // The daemon stamps each jsonl event with `v` (end-of-line byte offset, monotonic per session,
  // identical live vs replay). RSM drops any event whose v <= the highest already delivered. This
  // replaces the uuid-Set dedup for daemons that send `v`, and uniquely also catches out-of-order
  // (which uuid dedup never did) and uuid-less lines (which uuid dedup let through).
  //
  // Count ONLY our own marker lines. The live CLI's own init line also arrives, stamped with its
  // small real offset at any moment, so every `v` here sits far above it (V0): whichever comes
  // first, neither makes the other look stale.
  const V0 = 1_000_000_000
  const countDelivered = (prefix: string) =>
    onOutput.mock.calls.filter((c) => typeof c[0]?.line === 'string' && (c[0].line as string).startsWith(prefix)).length

  it('L1-1: forwards lines with strictly increasing v (no false skip)', async () => {
    daemon.emitEvent('jsonl', { sid: 'sid-test', line: 'L1A:x1', v: V0 + 100 })
    daemon.emitEvent('jsonl', { sid: 'sid-test', line: 'L1A:x2', v: V0 + 200 })
    await framesHandled()
    expect(countDelivered('L1A:')).toBe(2)
  })

  it('L1-2: skips a duplicate replay (same v) even with NO uuid', async () => {
    const line = 'L1B:no-uuid' // uuid-less: uuid dedup would NOT catch this; only version-skip does
    daemon.emitEvent('jsonl', { sid: 'sid-test', line, v: V0 + 300 })
    daemon.emitEvent('jsonl', { sid: 'sid-test', line, v: V0 + 300 }) // replay at same v → must skip
    await framesHandled()
    expect(countDelivered('L1B:')).toBe(1)
  })

  it('L1-3: skips an OUT-OF-ORDER stale line (v < last seen) — uuid dedup never did this', async () => {
    daemon.emitEvent('jsonl', { sid: 'sid-test', line: 'L1C:newer', v: V0 + 500 })
    daemon.emitEvent('jsonl', { sid: 'sid-test', line: 'L1C:older', v: V0 + 400 }) // stale → skip
    await framesHandled()
    expect(countDelivered('L1C:')).toBe(1)
  })

  it('L1-4: a replay window [from,current) after live delivery is fully skipped', async () => {
    // Live delivery advances the watermark to 800.
    daemon.emitEvent('jsonl', { sid: 'sid-test', line: 'L1D:a', v: V0 + 600 })
    daemon.emitEvent('jsonl', { sid: 'sid-test', line: 'L1D:b', v: V0 + 700 })
    daemon.emitEvent('jsonl', { sid: 'sid-test', line: 'L1D:c', v: V0 + 800 })
    await framesHandled()
    // Reconnect replays [600, 800] — all <= 800 → every one skipped.
    daemon.emitEvent('jsonl', { sid: 'sid-test', line: 'L1D:a', v: V0 + 600 })
    daemon.emitEvent('jsonl', { sid: 'sid-test', line: 'L1D:b', v: V0 + 700 })
    daemon.emitEvent('jsonl', { sid: 'sid-test', line: 'L1D:c', v: V0 + 800 })
    await framesHandled()
    expect(countDelivered('L1D:')).toBe(3) // only the 3 live ones
  })
})
