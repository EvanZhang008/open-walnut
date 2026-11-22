/**
 * L1.2 daemon-registry — write-ahead persistence + atomic rename.
 *
 * Validates P2:
 *   - Atomic: writeFile to tmp → fsync → rename
 *   - Only `state==='running' && pid` sessions are persisted
 *   - Corrupt/missing file reads as `{}` (no throw)
 *   - Envelope is `{version:1, sessions:{...}}`
 *   - Entry shape is exactly the RegistryEntry interface
 *   - Disk full (writeFileSync throws) is logged as warn but doesn't propagate
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore } from '../helpers/daemon-core-fixtures.js'

describe('L1.2 daemon-registry: write-ahead + atomic rename', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>

  beforeEach(async () => {
    ctx = await buildDeps()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.cleanup()
  })

  // G1 — missing file → {}
  it('readRegistry returns {} when file does not exist', () => {
    const core = createDaemonCore(ctx.deps)
    expect(core.readRegistry()).toEqual({})
  })

  // G2 — corrupt JSON → {}
  it('readRegistry returns {} on corrupt JSON', async () => {
    await fsp.writeFile(ctx.registryFile, '{not json}')
    const core = createDaemonCore(ctx.deps)
    expect(core.readRegistry()).toEqual({})
  })

  // G3 — valid JSON but missing `sessions` key → {}
  it('readRegistry returns {} when envelope is malformed', async () => {
    await fsp.writeFile(ctx.registryFile, JSON.stringify({ version: 1 }))
    const core = createDaemonCore(ctx.deps)
    expect(core.readRegistry()).toEqual({})
  })

  // G4 — truncated file
  it('readRegistry returns {} on truncated JSON', async () => {
    await fsp.writeFile(ctx.registryFile, '{"version":1,"sessions":{"sid1":{"pid":')
    const core = createDaemonCore(ctx.deps)
    expect(core.readRegistry()).toEqual({})
  })

  // G5 — atomic write sequence: write tmp → fsync → rename, off the thread (fs.promises),
  // and the exit's synchronous write in the same order (registry-writer-core.ts).
  it('persistRegistry uses atomic tmp → fsync → rename sequence', async () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid-atomic', makeTestSession({ pid: 2000, state: 'running' }))

    const order: string[] = []
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike) => ({
      writeFile: async () => { order.push(`write:${String(p).endsWith('.tmp') ? 'tmp' : 'final'}`) },
      sync: async () => { order.push('fsync') },
      close: async () => {},
    })) as unknown as typeof fs.promises.open)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async () => { order.push('rename') })

    core.persistRegistry()
    await core.persistRegistryDurable()
    expect(order).toEqual(['write:tmp', 'fsync', 'rename'])
    vi.restoreAllMocks()

    const syncOrder: string[] = []
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p) => { syncOrder.push(`write:${String(p).endsWith('.tmp') ? 'tmp' : 'final'}`) })
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { syncOrder.push('fsync') })
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { syncOrder.push('rename') })
    vi.spyOn(fs, 'openSync').mockImplementation(() => 99)
    vi.spyOn(fs, 'closeSync').mockImplementation(() => {})
    core.persistRegistrySync()
    expect(syncOrder).toEqual(['write:tmp', 'fsync', 'rename'])
  })

  // G6 — only running sessions with pid are persisted
  it('persistRegistry skips dead sessions and pid-less sessions', async () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('live', makeTestSession({ pid: 3000, state: 'running' }))
    ctx.sessions.set('dead', makeTestSession({ pid: 3001, state: 'dead' }))
    ctx.sessions.set('no-pid', makeTestSession({ pid: null, state: 'running' }))

    await core.persistRegistryDurable()

    const reg = JSON.parse(fs.readFileSync(ctx.registryFile, 'utf-8'))
    expect(Object.keys(reg.sessions)).toEqual(['live'])
  })

  // G7 — entry shape is exact
  it('persisted entry contains exactly the RegistryEntry fields', async () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('shape', makeTestSession({
      pid: 4000,
      startTime: '99999',
      pipePath: '/s/fifo',
      jsonlPath: '/s/jsonl',
      pgidPath: '/s/pgid',
      cwd: '/work',
      args: ['claude', '-p'],
      parented: false,
    }))

    await core.persistRegistryDurable()

    const reg = JSON.parse(fs.readFileSync(ctx.registryFile, 'utf-8'))
    const entry = reg.sessions.shape
    expect(Object.keys(entry).sort()).toEqual([
      'args',
      'cwd',
      'jsonlPath',
      'parented',
      'pgidPath',
      'pid',
      'pipePath',
      'spawnedAt',
      'startTime',
    ])
    expect(entry.pid).toBe(4000)
    expect(entry.startTime).toBe('99999')
    expect(entry.parented).toBe(false)
  })

  it('keeps the original process stream boundary across registry writes', async () => {
    const core = createDaemonCore(ctx.deps)
    const origin = { identity: 'boot:4000:99999:stream', offset: 150, startedAt: 1000 }
    ctx.sessions.set('origin', makeTestSession({ pid: 4000, cronMetadataOrigin: origin }))
    await core.persistRegistryDurable()
    expect(core.readRegistry().origin.cronMetadataOrigin).toEqual(origin)
    await core.persistRegistryDurable()
    expect(core.readRegistry().origin.cronMetadataOrigin).toEqual(origin)
  })

  // G8 — envelope format
  it('persisted file has version + sessions envelope', async () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 5000 }))
    await core.persistRegistryDurable()

    const reg = JSON.parse(fs.readFileSync(ctx.registryFile, 'utf-8'))
    expect(reg.version).toBe(1)
    expect(typeof reg.sessions).toBe('object')
  })

  // G9 — disk full / write error surfaces as warn log, doesn't throw
  it('persistRegistry logs warn and does not throw on write failure', async () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 6000 }))
    vi.spyOn(fs.promises, 'open').mockImplementation(async () => { throw new Error('ENOSPC: no space left') })

    expect(() => core.persistRegistry()).not.toThrow()
    // Not a managed service: the write-ahead resolves, the failure is a warning.
    await expect(core.persistRegistryDurable()).resolves.toBeUndefined()
    expect(ctx.spies.logger).toHaveBeenCalledWith(
      'warn',
      'registry persist failed',
      expect.objectContaining({ error: expect.stringContaining('ENOSPC') }),
    )
  })

  // G10 — round-trip: persist then readRegistry returns same entries (sans spawnedAt)
  it('persist → readRegistry round-trips entries (except spawnedAt timestamp)', async () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('a', makeTestSession({
      pid: 7000,
      startTime: 'st-a',
      pipePath: '/p/a',
      jsonlPath: '/j/a',
      pgidPath: '/g/a',
      cwd: '/c/a',
      args: ['x', 'y'],
      parented: true,
    }))
    ctx.sessions.set('b', makeTestSession({
      pid: 7001,
      startTime: 'st-b',
      pipePath: '/p/b',
      jsonlPath: '/j/b',
      pgidPath: '/g/b',
      cwd: '/c/b',
      args: ['z'],
      parented: false,
    }))

    await core.persistRegistryDurable()
    const reg = core.readRegistry()

    expect(Object.keys(reg).sort()).toEqual(['a', 'b'])
    expect(reg.a.pid).toBe(7000)
    expect(reg.a.startTime).toBe('st-a')
    expect(reg.a.args).toEqual(['x', 'y'])
    expect(reg.a.parented).toBe(true)
    expect(reg.b.pid).toBe(7001)
    expect(reg.b.parented).toBe(false)
  })

  // S7-H1 (2026-11-22 review): a wedged fs pool (open() on a FIFO with no writer, a dead mount)
  // never answers an async write. The write-ahead of a start, an update's strict write and the
  // exit hold must still finish, with the spawned session on disk.
  it('a file pool that never answers: the write-ahead and the exit hold finish, the session on disk', async () => {
    const core = createDaemonCore({ ...ctx.deps, bootId: 'boot-1', registryAsyncDeadlineMs: 30 })
    // Wedged means every pool call waits, the deadline's probe (a stat, file-pool-deadline.ts) included.
    vi.spyOn(fs.promises, 'open').mockImplementation((() => new Promise(() => {})) as unknown as typeof fs.promises.open)
    vi.spyOn(fs.promises, 'stat').mockImplementation((() => new Promise(() => {})) as unknown as typeof fs.promises.stat)
    ctx.sessions.set('spawned', makeTestSession({ pid: 7100, state: 'running', bootId: 'boot-1' } as Parameters<typeof makeTestSession>[0]))
    await core.persistRegistryDurable(true)
    expect(Object.keys(core.readRegistry())).toEqual(['spawned'])
    ctx.sessions.set('second', makeTestSession({ pid: 7101, state: 'running' }))
    await core.holdRegistryForExit()
    expect(Object.keys(core.readRegistry()).sort()).toEqual(['second', 'spawned'])
  })
})
