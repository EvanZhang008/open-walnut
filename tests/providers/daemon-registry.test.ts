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

  // G5 — atomic write sequence: writeFileSync → fsync → rename
  it('persistRegistry uses atomic tmp → fsync → rename sequence', () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid-atomic', makeTestSession({ pid: 2000, state: 'running' }))

    const order: string[] = []
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((p) => {
      order.push(`write:${String(p).endsWith('.tmp') ? 'tmp' : 'final'}`)
    })
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      order.push('fsync')
    })
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      order.push('rename')
    })
    vi.spyOn(fs, 'openSync').mockImplementation(() => 99)
    vi.spyOn(fs, 'closeSync').mockImplementation(() => {})

    core.persistRegistry()

    expect(order).toEqual(['write:tmp', 'fsync', 'rename'])

    writeSpy.mockRestore()
    fsyncSpy.mockRestore()
    renameSpy.mockRestore()
  })

  // G6 — only running sessions with pid are persisted
  it('persistRegistry skips dead sessions and pid-less sessions', () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('live', makeTestSession({ pid: 3000, state: 'running' }))
    ctx.sessions.set('dead', makeTestSession({ pid: 3001, state: 'dead' }))
    ctx.sessions.set('no-pid', makeTestSession({ pid: null, state: 'running' }))

    core.persistRegistry()

    const reg = JSON.parse(fs.readFileSync(ctx.registryFile, 'utf-8'))
    expect(Object.keys(reg.sessions)).toEqual(['live'])
  })

  // G7 — entry shape is exact
  it('persisted entry contains exactly the RegistryEntry fields', () => {
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

    core.persistRegistry()

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

  it('keeps the original process stream boundary across registry writes', () => {
    const core = createDaemonCore(ctx.deps)
    const origin = { identity: 'boot:4000:99999:stream', offset: 150, startedAt: 1000 }
    ctx.sessions.set('origin', makeTestSession({ pid: 4000, cronMetadataOrigin: origin }))
    core.persistRegistry()
    expect(core.readRegistry().origin.cronMetadataOrigin).toEqual(origin)
    core.persistRegistry()
    expect(core.readRegistry().origin.cronMetadataOrigin).toEqual(origin)
  })

  // G8 — envelope format
  it('persisted file has version + sessions envelope', () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 5000 }))
    core.persistRegistry()

    const reg = JSON.parse(fs.readFileSync(ctx.registryFile, 'utf-8'))
    expect(reg.version).toBe(1)
    expect(typeof reg.sessions).toBe('object')
  })

  // G9 — disk full / write error surfaces as warn log, doesn't throw
  it('persistRegistry logs warn and does not throw on write failure', () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 6000 }))
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left')
    })

    expect(() => core.persistRegistry()).not.toThrow()
    expect(ctx.spies.logger).toHaveBeenCalledWith(
      'warn',
      'registry persist failed',
      expect.objectContaining({ error: expect.stringContaining('ENOSPC') }),
    )

    writeSpy.mockRestore()
  })

  // G10 — round-trip: persist then readRegistry returns same entries (sans spawnedAt)
  it('persist → readRegistry round-trips entries (except spawnedAt timestamp)', () => {
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

    core.persistRegistry()
    const reg = core.readRegistry()

    expect(Object.keys(reg).sort()).toEqual(['a', 'b'])
    expect(reg.a.pid).toBe(7000)
    expect(reg.a.startTime).toBe('st-a')
    expect(reg.a.args).toEqual(['x', 'y'])
    expect(reg.a.parented).toBe(true)
    expect(reg.b.pid).toBe(7001)
    expect(reg.b.parented).toBe(false)
  })
})
