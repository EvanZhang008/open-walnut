/**
 * The incremental read state survives a restart and an eviction, through the disk cache.
 *
 * 2026-11-03: 2.5 GB of whole-transcript reads from one remote host in a day. 247 reads
 * were cold (the in-memory cache empty), each followed by a full read; 126 were a
 * session's first read after one of 31 server restarts. The disk cache kept the parse
 * but not the incremental state, so the first append after a restart (or after the
 * byte budget evicted a large session) read the whole file again. And one 28 MB
 * transcript never seeded at all: every boundary tried split a tool call from its
 * result, so it was read whole 54 times.
 *
 * Pinned here, against the real read pipeline over a temp CLAUDE_HOME and disk cache:
 *   - after a restart, an append is read as a range, and the result equals a cold parse;
 *   - a disk hit on an unchanged file restores the state, so its next append is a range read;
 *   - a file rewritten while the server was down is read whole, correctly;
 *   - a kept state whose messages do not match is dropped, never trusted;
 *   - a seed boundary that splits a tool call moves before it and still seeds.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

const reads = vi.hoisted(() => ({ full: 0, range: 0 }))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-history-inc-disk', {
  HISTORY_CACHE_DIR: path.join(os.tmpdir(), `walnut-history-inc-disk-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'cache', 'history'),
}))
vi.mock('../../src/core/daemon-file-reader.js', async () => {
  const { mockLocalDaemonReader } = await import('../helpers/mock-local-daemon-reader.js')
  const Base = mockLocalDaemonReader().DaemonFileReader
  class Counting extends Base {
    async readFile(p: string) { reads.full++; return super.readFile(p) }
    async findSession(sid: string) { reads.full++; return super.findSession(sid) }
    async readFileRange(p: string, start: number) { reads.range++; return super.readFileRange(p, start) }
  }
  return { DaemonFileReader: Counting }
})

import { CLAUDE_HOME, HISTORY_CACHE_DIR } from '../../src/constants.js'
import {
  encodeProjectPath,
  readSessionHistory,
  _resetHistoryCacheForTesting,
  _historyCacheGetForTesting,
  _historyCacheSetForTesting,
} from '../../src/core/session-history.js'
import { deleteHistoryCache, flushHistoryCacheWrites } from '../../src/core/history-disk-cache.js'

const CWD = '/tmp/inc-disk-project'
const opts = { skipSubagents: true }

beforeEach(async () => {
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true })
  await fs.rm(HISTORY_CACHE_DIR, { recursive: true, force: true })
  // The cache module makes its dir once per process: keep it there for every test.
  await fs.mkdir(HISTORY_CACHE_DIR, { recursive: true })
  await fs.mkdir(CLAUDE_HOME, { recursive: true })
  _resetHistoryCacheForTesting()
  reads.full = 0
  reads.range = 0
})
afterEach(async () => {
  flushHistoryCacheWrites()
  await new Promise((r) => setTimeout(r, 20))
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})
afterAll(async () => {
  await fs.rm(path.dirname(path.dirname(HISTORY_CACHE_DIR)), { recursive: true, force: true }).catch(() => {})
})

const jsonl = (sid: string) => path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${sid}.jsonl`)
async function write(sid: string, lines: unknown[]) {
  await fs.mkdir(path.dirname(jsonl(sid)), { recursive: true })
  await fs.writeFile(jsonl(sid), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
async function append(sid: string, lines: unknown[]) {
  await fs.appendFile(jsonl(sid), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const t = new Date(Date.now() + 2_000 + Math.floor(Math.random() * 50_000))
  await fs.utimes(jsonl(sid), t, t)
}

let n = 0
const user = (text: string) => ({ type: 'user', uuid: `u-${++n}`, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })
const reply = (text: string) => ({ type: 'assistant', uuid: `a-${++n}`, timestamp: new Date().toISOString(), message: { id: `msg_${n}`, role: 'assistant', content: [{ type: 'text', text }] } })
const toolUse = (id: string) => ({ type: 'assistant', uuid: `a-${++n}`, timestamp: new Date().toISOString(), message: { id: `msg_${n}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { cmd: 'x' } }] } })
const toolResult = (id: string, text: string) => ({ type: 'user', uuid: `u-${++n}`, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } })

/** ~3 MB of paired tool turns: big enough that the boundary leaves a real frozen prefix. */
function bulk(prefix: string, count = 12, each = 250_000): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < count; i++) out.push(toolUse(`toolu_${prefix}_${i}_padpad`), toolResult(`toolu_${prefix}_${i}_padpad`, 'X'.repeat(each)))
  return out
}

/** The disk entry, once its coalesced write has landed with the incremental state. */
async function diskEntry(sid: string): Promise<{ inc?: { prefixCount: number; parsedBytes: number }; messages: unknown[] }> {
  flushHistoryCacheWrites()
  for (let i = 0; i < 200; i++) {
    try {
      const e = JSON.parse(await fs.readFile(path.join(HISTORY_CACHE_DIR, `${sid}.json`), 'utf-8'))
      if (e.inc) return e
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('disk entry with inc never appeared')
}

/** A parse with no cache at all, memory or disk. */
async function cold(sid: string) {
  // The read before this queues its disk write a tick after it returns: let it, then drop it.
  await new Promise((r) => setTimeout(r, 20))
  await deleteHistoryCache(sid)
  _resetHistoryCacheForTesting()
  const before = reads.full
  const out = await readSessionHistory(sid, CWD, undefined, undefined, opts)
  expect(reads.full).toBeGreaterThan(before)
  return out
}

/** A cold parse to compare with, leaving the warm entry (and its incremental state) in place. */
async function coldKeepingWarm(sid: string) {
  const warm = _historyCacheGetForTesting(sid)!
  const out = await cold(sid)
  _resetHistoryCacheForTesting()
  _historyCacheSetForTesting(sid, warm)
  return out
}

describe('incremental state across a restart', () => {
  it('an append after a restart is read as a range, and matches a cold parse', async () => {
    const sid = 'inc-disk-restart'
    await write(sid, [user('start'), ...bulk('r'), reply('before restart')])
    await readSessionHistory(sid, CWD, undefined, undefined, opts)
    const kept = await diskEntry(sid)
    expect(kept.inc!.prefixCount).toBeGreaterThan(0)
    // The tail's text is read back from the transcript, never kept in the cache file.
    expect(kept.inc).not.toHaveProperty('tailText')

    _resetHistoryCacheForTesting() // the restart
    await append(sid, [user('after restart'), reply('answer after restart')])
    reads.full = 0
    reads.range = 0
    const warm = await readSessionHistory(sid, CWD, undefined, undefined, opts)
    expect(reads.full).toBe(0)
    expect(reads.range).toBe(1)
    expect(_historyCacheGetForTesting(sid)?.inc).toBeDefined()
    expect(warm.map((m) => m.text).slice(-2)).toEqual(['after restart', 'answer after restart'])
    expect(warm).toEqual(await cold(sid))
  })

  it('a disk hit on an unchanged file keeps the state, so the next append is a range read', async () => {
    const sid = 'inc-disk-hit'
    await write(sid, [user('start'), ...bulk('h'), reply('settled')])
    await readSessionHistory(sid, CWD, undefined, undefined, opts)
    await diskEntry(sid)

    _resetHistoryCacheForTesting()
    reads.full = 0
    await readSessionHistory(sid, CWD, undefined, undefined, opts) // the mtime match
    expect(reads.full).toBe(0)
    // Kept unread until the transcript changes: the hit itself reads nothing.
    expect(_historyCacheGetForTesting(sid)?.diskInc).toBeDefined()

    await append(sid, [user('next turn'), reply('next answer')])
    reads.full = 0
    reads.range = 0
    const warm = await readSessionHistory(sid, CWD, undefined, undefined, opts)
    expect([reads.full, reads.range]).toEqual([0, 1])
    expect(warm).toEqual(await cold(sid))
  })

  it('several appends across two restarts stay identical to a cold parse', async () => {
    const sid = 'inc-disk-twice'
    await write(sid, [user('start'), ...bulk('t')])
    await readSessionHistory(sid, CWD, undefined, undefined, opts)
    for (let round = 0; round < 2; round++) {
      await diskEntry(sid)
      _resetHistoryCacheForTesting()
      await append(sid, [user(`q${round}`), toolUse(`toolu_round_${round}_padpad`), toolResult(`toolu_round_${round}_padpad`, `r${round}`), reply(`a${round}`)])
      await readSessionHistory(sid, CWD, undefined, undefined, opts)
      await append(sid, [user(`q${round}b`), reply(`a${round}b`)])
      await readSessionHistory(sid, CWD, undefined, undefined, opts)
    }
    reads.full = 0
    const warm = await readSessionHistory(sid, CWD, undefined, undefined, opts)
    expect(reads.full).toBe(0)
    expect(warm).toEqual(await cold(sid))
  })

  it('a file rewritten while the server was down is read whole, and right', async () => {
    const sid = 'inc-disk-rewrite'
    await write(sid, [user('start'), ...bulk('w'), reply('old end')])
    await readSessionHistory(sid, CWD, undefined, undefined, opts)
    await diskEntry(sid)

    _resetHistoryCacheForTesting()
    // Rewritten in place and grown (a compaction followed by more work): the kept last line is gone.
    await write(sid, [user('compacted summary'), ...bulk('w2', 13), reply('new end')])
    const t = new Date(Date.now() + 60_000)
    await fs.utimes(jsonl(sid), t, t)
    reads.full = 0
    const after = await readSessionHistory(sid, CWD, undefined, undefined, opts)
    expect(reads.full).toBeGreaterThan(0)
    expect(after[0].text).toBe('compacted summary')
    expect(after.map((m) => m.text)).not.toContain('old end')
    expect(after).toEqual(await cold(sid))
  })

  it('a kept state whose messages do not match is dropped, never trusted', async () => {
    const sid = 'inc-disk-mismatch'
    await write(sid, [user('start'), ...bulk('m'), reply('end')])
    await readSessionHistory(sid, CWD, undefined, undefined, opts)
    const kept = await diskEntry(sid) as { inc: { prefixCount: number; prefixLastKey?: string }; messages: Array<{ msgId?: string }> }
    expect(kept.inc.prefixLastKey).toBeDefined()
    // The messages no longer line up with the state (an entry another writer replaced).
    kept.inc.prefixLastKey = 'msg_not_there'
    await fs.writeFile(path.join(HISTORY_CACHE_DIR, `${sid}.json`), JSON.stringify(kept))

    _resetHistoryCacheForTesting()
    await append(sid, [user('later'), reply('later answer')])
    reads.full = 0
    const after = await readSessionHistory(sid, CWD, undefined, undefined, opts)
    expect(reads.full).toBeGreaterThan(0)
    expect(after).toEqual(await cold(sid))
  })
})

describe('seeding a transcript whose boundary splits a tool call', () => {
  it('moves the boundary before the call and seeds, and later appends stay right', async () => {
    const sid = 'inc-seed-split'
    // A tool call made just before the last megabyte, its result well inside it: the
    // first boundary tried falls between them.
    await write(sid, [
      user('start'), ...bulk('s', 10),
      toolUse('toolu_long_running_call'),
      ...bulk('mid', 4, 300_000),
      toolResult('toolu_long_running_call', 'finished at last'),
      reply('done'),
    ])
    const first = await readSessionHistory(sid, CWD, undefined, undefined, opts)
    const inc = _historyCacheGetForTesting(sid)?.inc
    expect(inc).toBeDefined()
    expect(inc!.tailText).toContain('"id":"toolu_long_running_call"')
    const call = first.flatMap((m) => m.tools ?? []).find((t) => t.toolUseId === 'toolu_long_running_call')
    expect(call?.result).toContain('finished at last')

    await append(sid, [user('then'), reply('then answered')])
    reads.full = 0
    reads.range = 0
    const warm = await readSessionHistory(sid, CWD, undefined, undefined, opts)
    expect([reads.full, reads.range]).toEqual([0, 1])
    expect(warm).toEqual(await cold(sid))
  })
})

describe('a tail that outgrows the roll size', () => {
  it('is rolled in memory: appends past 4 MB never read the whole file, and stay right', async () => {
    const sid = 'inc-roll'
    await write(sid, [user('start'), reply('first answer')])
    await readSessionHistory(sid, CWD, undefined, undefined, opts)
    reads.full = 0
    reads.range = 0
    let moved = 0
    for (let round = 0; round < 6; round++) {
      await append(sid, [user(`round ${round} \u4f60\u597d \ud83d\ude80`), ...bulk(`roll${round}`, 4, 250_000), reply(`round ${round} done \u5b8c\u6210`)])
      reads.full = 0
      reads.range = 0
      const warm = await readSessionHistory(sid, CWD, undefined, undefined, opts)
      expect([reads.full, reads.range], `round ${round}`).toEqual([0, 1])
      moved = Math.max(moved, _historyCacheGetForTesting(sid)!.inc!.tailStartByte)
      expect(warm, `round ${round}`).toEqual(await coldKeepingWarm(sid))
    }
    // ~6 MB appended: the boundary moved past the start at least once.
    expect(moved).toBeGreaterThan(0)
  })

  it('multi-byte text across a roll and a restart keeps every offset', async () => {
    const sid = 'inc-roll-cjk'
    const wide = (k: string) => [user(`${k} \u4e2d\u6587\u5185\u5bb9 \ud83d\ude00`), toolUse(`toolu_${k}_cjk_pad`), toolResult(`toolu_${k}_cjk_pad`, '\u6c49\u5b57'.repeat(150_000)), reply(`${k} \u7ed3\u675f`)]
    await write(sid, [user('start'), ...wide('a'), ...wide('b')])
    await readSessionHistory(sid, CWD, undefined, undefined, opts)
    for (const k of ['c', 'd', 'e', 'f']) {
      await append(sid, wide(k))
      await readSessionHistory(sid, CWD, undefined, undefined, opts)
    }
    await diskEntry(sid)
    _resetHistoryCacheForTesting()
    await append(sid, wide('g'))
    reads.full = 0
    const warm = await readSessionHistory(sid, CWD, undefined, undefined, opts)
    expect(reads.full).toBe(0)
    expect(warm.map((m) => m.text).at(-1)).toBe('g \u7ed3\u675f')
    expect(warm).toEqual(await cold(sid))
  })
})

describe('a kept state that must not be resumed', () => {
  it('kept across other rewinds than the ones recorded now: read whole', async () => {
    const sid = 'inc-disk-cuts'
    await write(sid, [user('start'), ...bulk('c'), reply('end')])
    await readSessionHistory(sid, CWD, undefined, undefined, opts)
    const kept = await diskEntry(sid) as { inc: { cutsKey: string } }
    expect(kept.inc.cutsKey).toBe('')
    // A write that raced a rewind commit: its dead set is from before the cut.
    kept.inc.cutsKey = '1:u-rewound:u-last'
    await fs.writeFile(path.join(HISTORY_CACHE_DIR, `${sid}.json`), JSON.stringify(kept))
    _resetHistoryCacheForTesting()
    await append(sid, [user('later'), reply('later answer')])
    reads.full = 0
    reads.range = 0
    const after = await readSessionHistory(sid, CWD, undefined, undefined, opts)
    expect(reads.full).toBeGreaterThan(0)
    expect(after).toEqual(await cold(sid))
  })

  it('for a tail-bounded caller whose range would pass its window: the window read, not the range', async () => {
    const sid = 'inc-disk-window'
    await write(sid, [user('start'), ...bulk('w', 4)])
    await readSessionHistory(sid, CWD, undefined, undefined, opts)
    await diskEntry(sid)
    _resetHistoryCacheForTesting()
    // A long run while nobody watched: far more appended than the caller's window.
    await append(sid, [user('long run'), ...bulk('w2', 12), reply('long run done')])
    const tail = await readSessionHistory(sid, CWD, undefined, undefined, { ...opts, maxColdReadBytes: 1024 * 1024 })
    // The bounded window answered, not a resume from the kept state.
    expect(_historyCacheGetForTesting(sid)?.windowed).toBe(true)
    expect(_historyCacheGetForTesting(sid)?.inc).toBeUndefined()
    expect(tail.map((m) => m.text)).toContain('long run done')
  })
})
