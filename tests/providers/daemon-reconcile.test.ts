/**
 * L1.3 daemon-reconcile — startup adopt/reap sweep.
 *
 * Validates P4:
 *   - ESRCH → reapSession(reason='reconcile-dead')
 *   - EPERM → reapSession(reason='reconcile-not-ours')
 *   - PID recycled (start_time mismatch) → reapSession('reconcile-pid-recycled')
 *   - startTime null in entry OR readStartTime returns null → skip recycle check
 *   - Alive + ours → adopt (broadcast running {adopted:true}, start orphan poll)
 *   - Zombie FIFO sweep in streamsDir
 *   - pid <= 0 skipped
 *   - Mixed batch: each entry goes through correct branch
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  buildDeps,
  makeRegistryEntry,
  makeTestSession,
  createDaemonCore,
  killWithDead,
  killWithEperm,
} from '../helpers/daemon-core-fixtures.js'

describe('L1.3 daemon-reconcile: startup adopt/reap', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>

  beforeEach(async () => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (ctx) await ctx.cleanup()
  })

  async function writeRegistry(entries: Record<string, ReturnType<typeof makeRegistryEntry>>) {
    await fsp.writeFile(ctx.registryFile, JSON.stringify({ version: 1, sessions: entries }))
  }

  // C1 — empty registry → no-op
  it('empty registry produces no sessions and no broadcasts', async () => {
    ctx = await buildDeps()
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()
    expect(ctx.sessions.size).toBe(0)
    expect(ctx.spies.broadcastSessionStateFn).not.toHaveBeenCalled()
  })

  // C2 — all alive adopted
  it('3 alive entries → 3 adopted with state=running + orphan poll started', async () => {
    ctx = await buildDeps({
      killImpl: () => {},  // all alive
      readStartTimeImpl: () => null,  // skip recycle check
    })
    await writeRegistry({
      a: makeRegistryEntry({ pid: 100, startTime: null }),
      b: makeRegistryEntry({ pid: 200, startTime: null }),
      c: makeRegistryEntry({ pid: 300, startTime: null }),
    })

    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    expect(ctx.sessions.size).toBe(3)
    expect(ctx.sessions.get('a')!.state).toBe('running')
    expect(ctx.sessions.get('a')!.parented).toBe(false)
    expect(ctx.spies.broadcastSessionStateFn).toHaveBeenCalledTimes(3)
    for (const call of ctx.spies.broadcastSessionStateFn.mock.calls) {
      expect(call[0]).toMatchObject({ state: 'running', adopted: true })
    }
    // orphan poll started for each (3 setIntervals)
    expect(ctx.spies.setIntervalFn).toHaveBeenCalledTimes(3)
  })

  // C3 — ESRCH reap
  it('ESRCH on kill(pid,0) → reapSession(reason=reconcile-dead)', async () => {
    ctx = await buildDeps({ killImpl: killWithDead(new Set([500])) })
    await writeRegistry({
      dead: makeRegistryEntry({ pid: 500 }),
    })
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    expect(ctx.sessions.get('dead')!.state).toBe('dead')
    expect(ctx.sessions.get('dead')!.exitReason).toBe('reconcile-dead')
  })

  // C4 — EPERM reap
  it('EPERM on kill(pid,0) → reapSession(reason=reconcile-not-ours)', async () => {
    ctx = await buildDeps({ killImpl: killWithEperm(new Set([600])) })
    await writeRegistry({
      notours: makeRegistryEntry({ pid: 600 }),
    })
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    expect(ctx.sessions.get('notours')!.state).toBe('dead')
    expect(ctx.sessions.get('notours')!.exitReason).toBe('reconcile-not-ours')
  })

  // C5 — pid recycled
  it('start_time mismatch → reapSession(reason=reconcile-pid-recycled)', async () => {
    ctx = await buildDeps({
      killImpl: () => {},  // alive
      readStartTimeImpl: () => 'DIFFERENT',  // registry says 'original'
    })
    await writeRegistry({
      recycled: makeRegistryEntry({ pid: 700, startTime: 'original' }),
    })
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    expect(ctx.sessions.get('recycled')!.state).toBe('dead')
    expect(ctx.sessions.get('recycled')!.exitReason).toBe('reconcile-pid-recycled')
  })

  // C6 — entry.startTime null → skip recycle check, adopt
  it('entry.startTime=null → adopt without recycle check', async () => {
    ctx = await buildDeps({
      killImpl: () => {},
      readStartTimeImpl: () => 'anything',  // would mismatch if checked
    })
    await writeRegistry({
      legacy: makeRegistryEntry({ pid: 800, startTime: null }),
    })
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    expect(ctx.sessions.get('legacy')!.state).toBe('running')
  })

  // C7 — readStartTime returns null → skip recycle check (macOS case)
  it('readStartTime returns null (macOS) → adopt without recycle check', async () => {
    ctx = await buildDeps({
      killImpl: () => {},
      readStartTimeImpl: () => null,
    })
    await writeRegistry({
      mac: makeRegistryEntry({ pid: 900, startTime: 'was-set-on-linux' }),
    })
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    expect(ctx.sessions.get('mac')!.state).toBe('running')
  })

  // C8 — zombie FIFO sweep
  it('zombie *.pipe files in streamsDir are unlinked if not in sessions', async () => {
    ctx = await buildDeps({ killImpl: () => {}, readStartTimeImpl: () => null })
    // Pre-create 2 *.pipe files in streamsDir
    const pipeAlive = path.join(ctx.streamsDir, 'alive.pipe')
    const pipeZombie = path.join(ctx.streamsDir, 'zombie.pipe')
    fs.writeFileSync(pipeAlive, '')
    fs.writeFileSync(pipeZombie, '')
    // Non-pipe file should NOT be deleted
    const other = path.join(ctx.streamsDir, 'other.log')
    fs.writeFileSync(other, '')

    await writeRegistry({
      alive: makeRegistryEntry({ pid: 1000, startTime: null, pipePath: pipeAlive }),
    })
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    expect(fs.existsSync(pipeAlive)).toBe(true)
    expect(fs.existsSync(pipeZombie)).toBe(false)
    expect(fs.existsSync(other)).toBe(true)
  })

  // C9 — adopted session has parented=false
  it('adopted session has parented=false', async () => {
    ctx = await buildDeps({ killImpl: () => {}, readStartTimeImpl: () => null })
    await writeRegistry({
      s: makeRegistryEntry({ pid: 1100, startTime: null, parented: true }),
    })
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    expect(ctx.sessions.get('s')!.parented).toBe(false)
  })

  // C10 — orphan poll timer fires after 1s
  it('orphan poll started for adopted session fires kill probe after 1s', async () => {
    ctx = await buildDeps({
      killImpl: () => {},  // stay alive
      readStartTimeImpl: () => null,
    })
    await writeRegistry({
      poll: makeRegistryEntry({ pid: 1200, startTime: null }),
    })
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    // killFn called once during reconcile (pid probe)
    expect(ctx.spies.killFn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1001)

    // Orphan poll tick called kill(pid, 0) again
    expect(ctx.spies.killFn).toHaveBeenCalledTimes(2)
    expect(ctx.spies.killFn).toHaveBeenLastCalledWith(1200, 0)
  })

  // C11 — re-entrant reconcile doesn't double up
  it('calling reconcileRegistry twice does not start duplicate orphan polls', async () => {
    ctx = await buildDeps({ killImpl: () => {}, readStartTimeImpl: () => null })
    await writeRegistry({
      x: makeRegistryEntry({ pid: 1300, startTime: null }),
    })
    const core = createDaemonCore(ctx.deps)

    await Promise.all([core.reconcileRegistry(), core.reconcileRegistry()])

    // Only one orphan poll timer should be set (startOrphanPoll is idempotent)
    expect(ctx.spies.setIntervalFn).toHaveBeenCalledTimes(1)
  })

  // C12 — pid <= 0 is skipped entirely
  it('entries with pid=0 or negative are skipped silently', async () => {
    ctx = await buildDeps()
    await writeRegistry({
      bad1: makeRegistryEntry({ pid: 0 }),
      bad2: makeRegistryEntry({ pid: -1 }),
    })
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    expect(ctx.sessions.size).toBe(0)
    expect(ctx.spies.broadcastSessionStateFn).not.toHaveBeenCalled()
  })

  // C13 — mixed batch
  it('mixed registry (2 alive / 1 ESRCH / 1 EPERM / 1 recycled) branches correctly', async () => {
    const deadPids = new Set([2001])
    const epermPids = new Set([2002])
    ctx = await buildDeps({
      killImpl: (pid) => {
        if (deadPids.has(pid)) {
          const e = new Error('ESRCH') as NodeJS.ErrnoException
          e.code = 'ESRCH'
          throw e
        }
        if (epermPids.has(pid)) {
          const e = new Error('EPERM') as NodeJS.ErrnoException
          e.code = 'EPERM'
          throw e
        }
      },
      readStartTimeImpl: (pid) => (pid === 2003 ? 'MISMATCH' : null),
    })
    await writeRegistry({
      alive1: makeRegistryEntry({ pid: 2000, startTime: null }),
      gone: makeRegistryEntry({ pid: 2001 }),
      notours: makeRegistryEntry({ pid: 2002 }),
      recycled: makeRegistryEntry({ pid: 2003, startTime: 'original' }),
      alive2: makeRegistryEntry({ pid: 2004, startTime: null }),
    })
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()

    expect(ctx.sessions.get('alive1')!.state).toBe('running')
    expect(ctx.sessions.get('alive2')!.state).toBe('running')
    expect(ctx.sessions.get('gone')!.state).toBe('dead')
    expect(ctx.sessions.get('gone')!.exitReason).toBe('reconcile-dead')
    expect(ctx.sessions.get('notours')!.state).toBe('dead')
    expect(ctx.sessions.get('notours')!.exitReason).toBe('reconcile-not-ours')
    expect(ctx.sessions.get('recycled')!.state).toBe('dead')
    expect(ctx.sessions.get('recycled')!.exitReason).toBe('reconcile-pid-recycled')
  })

  // C14 — a registry write that fails during the reconcile does not halt it. S7-L3 (2026-11-22
  // review): this test asserted not.toThrow on the promise the async pass returns, and spied on
  // writeFileSync, which the async writer never calls, so it tested nothing. The pass writes once,
  // at its end (S7-M3), through fs.promises: that write fails here.
  it('a registry write that fails at the end of the pass: every entry still reconciled, and the next write lands the inventory', async () => {
    vi.useRealTimers()
    ctx = await buildDeps({ killImpl: killWithDead(new Set([3001])), readStartTimeImpl: () => null })
    await writeRegistry({
      s1: makeRegistryEntry({ pid: 3000, startTime: null }),
      s2: makeRegistryEntry({ pid: 3001 }),  // ESRCH: reaped, which asks for a write
      s3: makeRegistryEntry({ pid: 3002, startTime: null }),
    })
    const onDisk = () => Object.keys(JSON.parse(fs.readFileSync(ctx.registryFile, 'utf8')).sessions).sort()
    const realRename = fs.promises.rename.bind(fs.promises)
    let renames = 0
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      renames++
      if (renames === 1) throw Object.assign(new Error('EIO: rename'), { code: 'EIO' })
      return realRename(from, to)
    })
    try {
      const core = createDaemonCore(ctx.deps)
      await expect(core.reconcileRegistry()).resolves.toBeUndefined()
      expect(ctx.sessions.get('s1')!.state).toBe('running')
      expect(ctx.sessions.get('s2')!.state).toBe('dead')
      expect(ctx.sessions.get('s3')!.state).toBe('running')
      // The pass's own write was made, and failed.
      await vi.waitFor(() => expect(renames).toBeGreaterThanOrEqual(1))
      // A write asked for after it takes the inventory again and lands it.
      await core.persistRegistryDurable()
      expect(renames).toBeGreaterThanOrEqual(2)
      expect(onDisk()).toEqual(['s1', 's3'])
    } finally {
      renameSpy.mockRestore()
      for (const session of ctx.sessions.values()) if (session.orphanPollTimer) clearInterval(session.orphanPollTimer as NodeJS.Timeout)
    }
  })

  // S7-L3 + S7-M3 (2026-11-22 review): the async reconcile with an async fold that yields between
  // entries. A reap in the middle wrote the entries reconciled so far, and every live CLI later in
  // the pass was missing on disk until the next change.
  it('async folds, a yield after every entry: one write at the end, every live CLI in it, and a start meanwhile keeps its record', async () => {
    vi.useRealTimers()
    ctx = await buildDeps({ killImpl: killWithDead(new Set([3001])), readStartTimeImpl: () => null })
    await writeRegistry({
      gone: makeRegistryEntry({ pid: 3001 }),
      live1: makeRegistryEntry({ pid: 3002, startTime: null }),
      started: makeRegistryEntry({ pid: 3003, startTime: null }),
      live2: makeRegistryEntry({ pid: 3004, startTime: null }),
    })
    const writes: string[] = []
    const onDisk = () => Object.keys(JSON.parse(fs.readFileSync(ctx.registryFile, 'utf8')).sessions).sort()
    const seenDuringPass: string[][] = []
    const sync = ctx.deps.createAdoptedSession
    const startedRecord = makeTestSession({ pid: 4000, startTime: null })
    ctx.deps.reconcileSliceMs = 0
    ctx.deps.onRegistryWrite = (kind) => { writes.push(kind) }
    ctx.deps.createAdoptedSession = async (sid, entry) => {
      await new Promise((r) => setTimeout(r, 5))
      seenDuringPass.push(onDisk())
      // A start of this sid lands while its fold runs.
      if (sid === 'started') ctx.sessions.set('started', startedRecord)
      return sync(sid, entry)
    }
    const core = createDaemonCore(ctx.deps)
    await core.reconcileRegistry()
    // The file stayed whole while the pass ran (the reap of "gone" wrote nothing partial).
    for (const seen of seenDuringPass) expect(seen).toEqual(['gone', 'live1', 'live2', 'started'])
    expect(ctx.sessions.get('gone')!.state).toBe('dead')
    expect(ctx.sessions.get('started')).toBe(startedRecord)
    await core.persistRegistryDurable()
    expect(onDisk()).toEqual(['live1', 'live2', 'started'])
    expect(JSON.parse(fs.readFileSync(ctx.registryFile, 'utf8')).sessions.started.pid).toBe(4000)
    // One write for the pass (plus the durable one just asked for).
    expect(writes.length).toBeLessThanOrEqual(2)
    for (const session of ctx.sessions.values()) if (session.orphanPollTimer) clearInterval(session.orphanPollTimer as NodeJS.Timeout)
  })
})
