/**
 * L1.1 daemon-reaper — idempotent single death funnel.
 *
 * Validates the P1 reaper primitive:
 *   - Idempotent (state==='dead' guard)
 *   - All death paths converge and cleanup runs once
 *   - Persist before broadcast (so crash mid-reap still has durable state)
 *   - Every step isolated in try/catch (unlink race or missing file can't wedge)
 *   - Broadcasts legacy exit (watchers) AND session_state=dead (all clients)
 *   - Process group SIGTERM then SIGKILL after 2s
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore } from '../helpers/daemon-core-fixtures.js'

describe('L1.1 daemon-reaper: idempotent cleanup + broadcast', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>

  beforeEach(async () => {
    vi.useFakeTimers()
    ctx = await buildDeps()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await ctx.cleanup()
  })

  // R1
  it('first reapSession flips state=dead and sets exitCode/exitReason/exitedAt', () => {
    const core = createDaemonCore(ctx.deps)
    const session = makeTestSession({ pid: 1000 })
    ctx.sessions.set('sid1', session)

    const t0 = Date.now()
    vi.setSystemTime(t0)
    core.reapSession('sid1', 42, 'test-reason')

    expect(session.state).toBe('dead')
    expect(session.exitCode).toBe(42)
    expect(session.exitReason).toBe('test-reason')
    expect(session.exitedAt).toBe(t0)
  })

  // R2
  it('second reapSession call with different reason is a no-op (idempotent)', () => {
    const core = createDaemonCore(ctx.deps)
    const session = makeTestSession({ pid: 1001 })
    ctx.sessions.set('sid2', session)

    core.reapSession('sid2', 1, 'first')
    core.reapSession('sid2', 99, 'second-ignored')

    expect(session.exitCode).toBe(1)
    expect(session.exitReason).toBe('first')
  })

  // R3 — two concurrent death signals only reap once
  it('concurrent reap calls produce exactly one broadcast + one persist', () => {
    const core = createDaemonCore(ctx.deps)
    const session = makeTestSession({ pid: 1002 })
    ctx.sessions.set('sid3', session)

    core.reapSession('sid3', -1, 'proc-exit')
    core.reapSession('sid3', -1, 'send-enxio')

    // broadcastSessionStateFn called once (session_state=dead)
    expect(ctx.spies.broadcastSessionStateFn).toHaveBeenCalledTimes(1)
    // broadcastExitToWatchersFn called once (legacy exit)
    expect(ctx.spies.broadcastExitToWatchersFn).toHaveBeenCalledTimes(1)
  })

  // R4 — persist happens before broadcast (crash-safe ordering)
  it('persistRegistry fires before session_state broadcast', () => {
    const core = createDaemonCore(ctx.deps)
    const session = makeTestSession({ pid: 1003 })
    ctx.sessions.set('sid4', session)

    const order: string[] = []
    // Patch writeFileSync to record persist timing.
    const originalWrite = fs.writeFileSync
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      order.push('persist')
      return originalWrite.apply(fs, args as Parameters<typeof fs.writeFileSync>)
    })
    ctx.spies.broadcastSessionStateFn.mockImplementation(() => {
      order.push('broadcast')
    })

    core.reapSession('sid4', 1, 'ordering-test')

    expect(order).toEqual(['persist', 'broadcast'])
    writeSpy.mockRestore()
  })

  // R5 — orphanPollTimer cleared on reap
  it('reapSession clears session.orphanPollTimer and sets to null', () => {
    const core = createDaemonCore(ctx.deps)
    const timer = setInterval(() => {}, 1000)
    const session = makeTestSession({ pid: 1004, orphanPollTimer: timer })
    ctx.sessions.set('sid5', session)

    core.reapSession('sid5', 1, 'timer-cleanup')

    expect(session.orphanPollTimer).toBeNull()
    expect(ctx.spies.clearIntervalFn).toHaveBeenCalledWith(timer)
  })

  // R6 — unlinkSync(pipePath) called and unlink failure does not propagate
  it('unlinks pipePath; unlink-missing-file does not throw', () => {
    const core = createDaemonCore(ctx.deps)
    const pipePath = path.join(ctx.tmpDir, 'pipe-r6.pipe')
    // Don't create the file — unlink will throw ENOENT internally.
    const session = makeTestSession({ pid: 1005, pipePath })
    ctx.sessions.set('sid6', session)

    expect(() => core.reapSession('sid6', 1, 'unlink-missing')).not.toThrow()
  })

  // R7 — SIGTERM immediately, SIGKILL after 2s
  it('kills process group SIGTERM immediately then SIGKILL 2s later', () => {
    const core = createDaemonCore(ctx.deps)
    const session = makeTestSession({ pid: 1006 })
    ctx.sessions.set('sid7', session)

    core.reapSession('sid7', 1, 'kill-sequence')

    expect(ctx.spies.killProcessGroupFn).toHaveBeenCalledTimes(1)
    expect(ctx.spies.killProcessGroupFn).toHaveBeenNthCalledWith(1, 1006, 'SIGTERM')

    vi.advanceTimersByTime(2000)

    expect(ctx.spies.killProcessGroupFn).toHaveBeenCalledTimes(2)
    expect(ctx.spies.killProcessGroupFn).toHaveBeenNthCalledWith(2, 1006, 'SIGKILL')
  })

  // R8 — session stays in Map after reap (for follow-up cmdStatus queries)
  it('session record remains in sessions Map after reap', () => {
    const core = createDaemonCore(ctx.deps)
    const session = makeTestSession({ pid: 1007 })
    ctx.sessions.set('sid8', session)

    core.reapSession('sid8', 1, 'keep-in-map')

    expect(ctx.sessions.has('sid8')).toBe(true)
    expect(ctx.sessions.get('sid8')!.state).toBe('dead')
  })

  // R9 — broadcasts both legacy exit AND session_state=dead
  it('broadcasts legacy exit to watchers + session_state=dead to all clients', () => {
    const core = createDaemonCore(ctx.deps)
    const session = makeTestSession({ pid: 1008 })
    ctx.sessions.set('sid9', session)

    core.reapSession('sid9', 7, 'dual-broadcast')

    expect(ctx.spies.broadcastExitToWatchersFn).toHaveBeenCalledTimes(1)
    expect(ctx.spies.broadcastExitToWatchersFn).toHaveBeenCalledWith(session, 7, undefined)

    expect(ctx.spies.broadcastSessionStateFn).toHaveBeenCalledTimes(1)
    const payload = ctx.spies.broadcastSessionStateFn.mock.calls[0][0]
    expect(payload).toMatchObject({
      sid: 'sid9',
      state: 'dead',
      exitCode: 7,
      reason: 'dual-broadcast',
    })
  })

  // R10 — stderr tail capped at 4096 bytes
  it('stderr tail is capped at 4096 bytes when .err file is larger', () => {
    const core = createDaemonCore(ctx.deps)
    const jsonlPath = path.join(ctx.tmpDir, 'jsonl-r10')
    const errPath = jsonlPath + '.err'
    // 5000 bytes, last 4096 should be in tail
    const big = 'X'.repeat(1000) + 'Y'.repeat(4000)
    fs.writeFileSync(errPath, big)
    const session = makeTestSession({ pid: 1009, jsonlPath })
    ctx.sessions.set('sid10', session)

    core.reapSession('sid10', 1, 'stderr-tail')

    const payload = ctx.spies.broadcastSessionStateFn.mock.calls[0][0] as Record<string, unknown>
    const stderr = payload.stderr as string
    expect(stderr.length).toBeLessThanOrEqual(4096)
    // Last 4000 Y's must be in tail
    expect(stderr.endsWith('Y'.repeat(100))).toBe(true)
  })

  // R11 — persistRegistry throwing does not block broadcast
  it('persist failure (disk error) does not block broadcast', () => {
    const core = createDaemonCore(ctx.deps)
    const session = makeTestSession({ pid: 1010 })
    ctx.sessions.set('sid11', session)

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC')
    })

    core.reapSession('sid11', 1, 'persist-fail')

    expect(ctx.spies.broadcastSessionStateFn).toHaveBeenCalledTimes(1)
    writeSpy.mockRestore()
  })

  // R12 — unknown sid is silent no-op
  it('reapSession on unknown sid returns silently (no broadcast, no kill)', () => {
    const core = createDaemonCore(ctx.deps)

    core.reapSession('nonexistent', 1, 'ghost')

    expect(ctx.spies.broadcastSessionStateFn).not.toHaveBeenCalled()
    expect(ctx.spies.killProcessGroupFn).not.toHaveBeenCalled()
  })

  // R13 — session.reap hook: strip-own-rows actually rewrites scheduled_tasks.json
  // (positive case — the default fixture omits hookActionsFn, so every other
  // test here exercises the never-strip path; this one proves the wired path).
  it('reapSession strips the dying session durable rows when the hook dep says strip-own-rows', () => {
    const cwd = fs.mkdtempSync(path.join(ctx.tmpDir, 'reap-strip-'))
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    const tasksPath = path.join(cwd, '.claude', 'scheduled_tasks.json')
    fs.writeFileSync(tasksPath, JSON.stringify({
      version: 1,
      tasks: [
        { id: 'own-task', createdBySessionId: 'sid13', prompt: 'x' },
        { id: 'sibling-task', createdBySessionId: 'other-live-sid', prompt: 'y' },
      ],
    }))

    const hookActionsFn = vi.fn(() => ['strip-own-rows'])
    const core = createDaemonCore({ ...ctx.deps, hookActionsFn })
    ctx.sessions.set('sid13', makeTestSession({ pid: 1013, cwd }))

    core.reapSession('sid13', 0, 'test-strip')

    expect(hookActionsFn).toHaveBeenCalledWith('session.reap', { sid: 'sid13', cwd })
    const after = JSON.parse(fs.readFileSync(tasksPath, 'utf-8')) as { tasks: Array<{ id: string }> }
    expect(after.tasks.map((t) => t.id)).toEqual(['sibling-task'])
  })

  // R14 — no strip-own-rows action ⇒ the file is untouched (zero-hook default)
  it('reapSession leaves scheduled_tasks.json alone when the hook dep returns nothing', () => {
    const cwd = fs.mkdtempSync(path.join(ctx.tmpDir, 'reap-nostrip-'))
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    const tasksPath = path.join(cwd, '.claude', 'scheduled_tasks.json')
    const original = JSON.stringify({ version: 1, tasks: [{ id: 'own-task', createdBySessionId: 'sid14' }] })
    fs.writeFileSync(tasksPath, original)

    const core = createDaemonCore({ ...ctx.deps, hookActionsFn: () => [] })
    ctx.sessions.set('sid14', makeTestSession({ pid: 1014, cwd }))

    core.reapSession('sid14', 0, 'test-nostrip')

    expect(fs.readFileSync(tasksPath, 'utf-8')).toBe(original)
  })
})
