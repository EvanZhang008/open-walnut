/**
 * The history disk cache is VERSIONED, and an entry from an older shape is dropped.
 *
 * Why this is a correctness test and not housekeeping: the entry is validated by the
 * source JSONL's mtime, and a stopped session's JSONL never changes again, so a parse
 * written months ago is served forever. When the MEANING of a field changes, that old
 * entry keeps answering questions about today's semantics with yesterday's data.
 *
 * The shipped p1 (2026-09-12): `resultChars` became the evidence a tool row's
 * full-text read trusts ("absent = this result is whole"), and every session parsed
 * before that change had rows with a 5,000-character `result` and no `resultChars`.
 * The drawer then reported a 17,781-character tool result as 4,999 characters,
 * complete, with no cursor: 18 of 54 real rows across 5 sessions.
 *
 * So the file carries a schema stamp, a mismatch reads as no cache at all, and the
 * caller re-parses. Nothing deletes anything by hand — the next write overwrites it.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'

// The shared mock leaves HISTORY_CACHE_DIR unset (every test's disk cache is a silent
// no-op), which is exactly what let this path go untested. Override it for this file.
vi.mock('../../src/constants.js', () => createMockConstants('walnut-history-cache-schema', {
  HISTORY_CACHE_DIR: path.join(os.tmpdir(), `walnut-history-cache-schema-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'cache', 'history'),
}))

import { HISTORY_CACHE_DIR } from '../../src/constants.js'
import { readHistoryCache, writeHistoryCache } from '../../src/core/history-disk-cache.js'
import type { SessionHistoryMessage } from '../../src/core/session-history.js'

const SID = 'cache-schema-session'
const entryPath = (sid = SID): string => path.join(HISTORY_CACHE_DIR, `${sid}.json`)

/** A row in the shape the PRE-`resultChars` parser wrote: capped, unstamped. */
const staleMessages = (): SessionHistoryMessage[] => [{
  role: 'assistant',
  text: 'searched the notes',
  msgId: 'msg_stale',
  timestamp: '2026-09-12T15:17:26.000Z',
  tools: [{
    name: 'mcp__walnut__note_search',
    input: { query: 'deploy' },
    toolUseId: 'toolu_stale',
    // 5,000 characters and NO resultChars — the whole defect in one row.
    result: 'n'.repeat(5_000),
  }],
} as unknown as SessionHistoryMessage]

/** writeHistoryCache is fire-and-forget; wait for the file to land. */
async function waitForEntry(sid = SID): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try { return await fs.readFile(entryPath(sid), 'utf-8') } catch { await new Promise((r) => setTimeout(r, 10)) }
  }
  throw new Error('cache entry never appeared')
}

beforeEach(async () => {
  await fs.rm(HISTORY_CACHE_DIR, { recursive: true, force: true })
  await fs.mkdir(HISTORY_CACHE_DIR, { recursive: true })
})

afterAll(async () => {
  await fs.rm(path.dirname(path.dirname(HISTORY_CACHE_DIR)), { recursive: true, force: true }).catch(() => {})
})

describe('history disk cache: schema stamp', () => {
  it('drops an entry written before the stamp existed (the shipped p1)', async () => {
    // Byte-for-byte the old writer's payload: no `schema` key at all.
    await fs.writeFile(entryPath(), JSON.stringify({
      messages: staleMessages(),
      cachedAt: '2026-09-12T15:17:26.000Z',
      mtimeMs: 1_757_000_000_000,
    }), 'utf-8')

    // Null, not "here are your stale rows" — the caller's next step is a real parse.
    expect(await readHistoryCache(SID)).toBeNull()
    // And nothing was deleted behind the user's back: the file is still there for the
    // next write to overwrite (a read must never mutate the cache).
    await expect(fs.stat(entryPath())).resolves.toBeTruthy()
  })

  it('drops an entry stamped with any other version', async () => {
    for (const schema of [1, 3, '2', null]) {
      await fs.writeFile(entryPath(), JSON.stringify({
        schema, messages: staleMessages(), cachedAt: 'then', mtimeMs: 5,
      }), 'utf-8')
      expect(await readHistoryCache(SID), `schema ${JSON.stringify(schema)}`).toBeNull()
    }
  })

  it('reads back what the current writer wrote, stamp and all', async () => {
    writeHistoryCache(SID, staleMessages(), 1_757_000_000_000, ['agent-7'])
    const raw = await waitForEntry()
    // The stamp is a NUMBER in the payload, so an older build reading a newer file
    // makes the same "not mine" decision rather than half-trusting it.
    expect(typeof (JSON.parse(raw) as { schema: unknown }).schema).toBe('number')

    const back = await readHistoryCache(SID)
    expect(back?.messages).toHaveLength(1)
    expect(back?.mtimeMs).toBe(1_757_000_000_000)
    // The out-of-band proof rides along, as before (a restart re-marks orphans).
    expect(back?.finishedAgentIds).toEqual(['agent-7'])
  })

  it('still returns null for a missing or corrupt file', async () => {
    expect(await readHistoryCache('no-such-session')).toBeNull()
    await fs.writeFile(entryPath('corrupt'), '{not json', 'utf-8')
    expect(await readHistoryCache('corrupt')).toBeNull()
    // A stamped file with no messages is not a cache hit either.
    await fs.writeFile(entryPath('empty'), JSON.stringify({ schema: 2, messages: [], cachedAt: 'x' }), 'utf-8')
    expect(await readHistoryCache('empty')).toBeNull()
  })
})
