/**
 * spawn-prefix: a fork must reproduce the parent's LIVE argv prefix, never a
 * fresh build. Pure parsing + the source-order resolver with injected readers;
 * nothing here touches a daemon, a process or the filesystem.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  MAX_SPAWN_PROMPT_BYTES,
  parseSpawnPrefixFromArgs,
  readParentSpawnPrefix,
  spawnPrefixFromRecord,
} from '../../src/core/sessions/spawn-prefix.js'
import type { SessionRecord } from '../../src/core/types.js'

const LIVE_ARGS = [
  'claude', '-p', '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'bypassPermissions',
  '--model', 'global.anthropic.claude-fable-5[1m]',
  '--effort', 'max',
  '--resume', 'c6ce9199-ca8b-4bd2-a111-0b19a9285515',
  '--append-system-prompt', 'You are a coding session opened by Walnut.\n\nExact bytes — 你好.',
  '--input-format', 'stream-json',
]

function parent(extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: 'c6ce9199-ca8b-4bd2-a111-0b19a9285515',
    taskId: 'task-1', project: 'proj', process_status: 'running', mode: 'bypass',
    last_status_change: 't', startedAt: 't', lastActiveAt: 't', messageCount: 3, type: 'interactive',
    host: 'clouddev',
    ...extra,
  } as SessionRecord
}

describe('parseSpawnPrefixFromArgs', () => {
  it('reads the append prompt, model, effort and permission mode verbatim', () => {
    const p = parseSpawnPrefixFromArgs(LIVE_ARGS)
    expect(p.appendSystemPrompt).toBe('You are a coding session opened by Walnut.\n\nExact bytes — 你好.')
    expect(p.model).toBe('global.anthropic.claude-fable-5[1m]')
    expect(p.effort).toBe('max')
    expect(p.permissionMode).toBe('bypassPermissions')
    expect(p.source).toBe('live-process')
  })

  it('reports an explicit NONE when the process runs without an append prompt', () => {
    const p = parseSpawnPrefixFromArgs(LIVE_ARGS.filter((a, i, all) =>
      a !== '--append-system-prompt' && all[i - 1] !== '--append-system-prompt'))
    expect(p.appendSystemPrompt).toBeNull()
    expect(p.model).toBe('global.anthropic.claude-fable-5[1m]')
  })

  it('treats a dangling flag or a flag-shaped value as absent', () => {
    expect(parseSpawnPrefixFromArgs(['claude', '--append-system-prompt']).appendSystemPrompt).toBeNull()
    expect(parseSpawnPrefixFromArgs(['claude', '--model', '--effort', 'max']).model).toBeUndefined()
    expect(parseSpawnPrefixFromArgs(['claude', '--effort', 'turbo']).effort).toBeUndefined()
  })

  it('refuses an oversized prompt (spawn-argv safety cap)', () => {
    const p = parseSpawnPrefixFromArgs(['claude', '--append-system-prompt', 'x'.repeat(MAX_SPAWN_PROMPT_BYTES + 1)])
    expect(p.appendSystemPrompt).toBeNull()
  })
})

describe('spawnPrefixFromRecord', () => {
  it('returns the stored prompt', () => {
    expect(spawnPrefixFromRecord({ appliedAppendSystemPrompt: 'stored' }))
      .toEqual({ appendSystemPrompt: 'stored', source: 'record' })
  })
  it("'' means the parent was launched without one (known, not unknown)", () => {
    expect(spawnPrefixFromRecord({ appliedAppendSystemPrompt: '' }))
      .toEqual({ appendSystemPrompt: null, source: 'record' })
  })
  it('undefined is unknown, and still resolves to none (never a fresh build)', () => {
    expect(spawnPrefixFromRecord({})).toEqual({ appendSystemPrompt: null, source: 'unknown' })
  })
})

describe('readParentSpawnPrefix', () => {
  it('prefers the live argv and backfills the record with the actual prompt', async () => {
    const persist = vi.fn(async () => undefined)
    const p = await readParentSpawnPrefix(parent({ appliedAppendSystemPrompt: undefined }), {
      readLiveArgs: async () => LIVE_ARGS, persist,
    })
    expect(p.source).toBe('live-process')
    expect(p.appendSystemPrompt).toContain('opened by Walnut')
    await Promise.resolve()
    expect(persist).toHaveBeenCalledWith('c6ce9199-ca8b-4bd2-a111-0b19a9285515', p.appendSystemPrompt)
  })

  it("backfills '' when the live process has no append prompt but the record remembers one", async () => {
    const persist = vi.fn(async () => undefined)
    const noPrompt = LIVE_ARGS.slice(0, LIVE_ARGS.indexOf('--append-system-prompt'))
    const p = await readParentSpawnPrefix(parent({ appliedAppendSystemPrompt: 'stale from an older spawn' }), {
      readLiveArgs: async () => noPrompt, persist,
    })
    expect(p.appendSystemPrompt).toBeNull()
    expect(persist).toHaveBeenCalledWith('c6ce9199-ca8b-4bd2-a111-0b19a9285515', '')
  })

  it('does not write when live and record already agree', async () => {
    const persist = vi.fn(async () => undefined)
    const prompt = LIVE_ARGS[LIVE_ARGS.indexOf('--append-system-prompt') + 1]!
    await readParentSpawnPrefix(parent({ appliedAppendSystemPrompt: prompt }), {
      readLiveArgs: async () => LIVE_ARGS, persist,
    })
    expect(persist).not.toHaveBeenCalled()
  })

  it('falls back to the record when the daemon has no argv (old daemon, dead process, not connected)', async () => {
    const p = await readParentSpawnPrefix(parent({ appliedAppendSystemPrompt: 'stored' }), {
      readLiveArgs: async () => null,
    })
    expect(p).toEqual({ appendSystemPrompt: 'stored', source: 'record' })
  })

  it('a throwing reader degrades to the record, never to a rejection', async () => {
    const p = await readParentSpawnPrefix(parent({}), {
      readLiveArgs: async () => { throw new Error('tunnel down') },
    })
    expect(p).toEqual({ appendSystemPrompt: null, source: 'unknown' })
  })

  it('local sessions probe the __local__ daemon', async () => {
    const seen: string[] = []
    await readParentSpawnPrefix(parent({ host: undefined }), {
      readLiveArgs: async (hostKey) => { seen.push(hostKey); return null },
    })
    expect(seen).toEqual(['__local__'])
  })
})
