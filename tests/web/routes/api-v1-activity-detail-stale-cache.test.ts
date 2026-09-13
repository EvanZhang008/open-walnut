/**
 * The drawer must never call a capped prefix "complete", whichever cache it came from.
 *
 * The device report (2026-09-12): `GET /api/v1/activity/detail?ref=…` answered
 * `resultChars: 4999, truncated: false`, no cursor, for a `note_search` result whose
 * source is 17,781 units. 18 of 54 real refs across 5 sessions did it. The text on the
 * phone stopped mid-string and nothing said so, which is the exact "confident wrong
 * answer" this endpoint exists to end.
 *
 * The rows did not come from today's parser. They came from the DISK PARSE CACHE, which
 * is validated by the source JSONL's mtime — and a stopped session's JSONL never
 * changes again, so a parse written before `resultChars` became load-bearing is served
 * forever. `resultChars: undefined` used to mean "this result is whole"; on those rows
 * it only meant "written by an older build".
 *
 * Two independent repairs, one case each, because either alone leaves a hole:
 *  1. the cache is VERSIONED, so an old-shape entry is dropped and re-parsed;
 *  2. the resolver REFUSES to trust a cap-length prefix that carries no stamp, whatever
 *     produced it (the in-memory cache has the same shape across a hot reload, and a
 *     stream-snapshot row never had a stamp at all). It re-reads the row, and when the
 *     source cannot be reached it says truncated with no cursor.
 *
 * Real: Express server (startServer), the api-v1 router, a session record, the disk
 * cache on disk and the whole read pipeline against a JSONL. Mocked: constants (temp
 * dirs, plus HISTORY_CACHE_DIR which the shared helper leaves unset — that omission is
 * why this path had no coverage) and the '__local__' daemon file reader.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-stale-cache', {
  HISTORY_CACHE_DIR: path.join(os.tmpdir(), `walnut-apiv1-stale-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'cache', 'history'),
}))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME, HISTORY_CACHE_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath, HISTORY_TOOL_RESULT_MAX } from '../../../src/core/session-history.js'
import { activityRef } from '../../../src/core/activity-detail.js'
import type { SessionHistoryMessage } from '../../../src/core/session-history.js'

const CWD = '/Users/test/stale-cache'
const MSG_ID = 'msg_search'
const TOOL_USE_ID = 'toolu_search'
const END_MARKER = 'NOTE-SEARCH-TAIL-MARKER'
/** The measured shape: a note_search result three and a half times the retained cap. */
const RESULT = 'note hit: deploy runbook, paragraph of context\n'.repeat(370) + END_MARKER
const TOOL_NAME = 'mcp__walnut__note_search'

let server: HttpServer
let port: number

interface Detail {
  kind: string
  toolName?: string
  result?: string
  resultChars?: number
  resultNextOffset?: number
  resultTruncated?: boolean
  offset: number
  truncated: boolean
  error?: { code: string }
}

async function detail(ref: string, extra = ''): Promise<{ status: number; body: Detail }> {
  const res = await fetch(`http://localhost:${port}/api/v1/activity/detail?ref=${encodeURIComponent(ref)}${extra}`)
  return { status: res.status, body: await res.json() as Detail }
}

let seq = 0
const at = (): string => new Date(Date.UTC(2026, 8, 12, 15, 0, ++seq)).toISOString()

async function seedSession(sessionId: string): Promise<{ jsonlPath: string; mtimeMs: number }> {
  await createSessionRecord(sessionId, '', '', CWD, { title: 'Coding session', initialProcessStatus: 'stopped' })
  const lines: unknown[] = [
    { type: 'user', uuid: `u-${++seq}`, timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: 'find the runbook' }] } },
    {
      type: 'assistant', uuid: `a-${++seq}`, timestamp: at(),
      message: {
        id: MSG_ID, role: 'assistant',
        content: [{ type: 'tool_use', id: TOOL_USE_ID, name: TOOL_NAME, input: { query: 'deploy runbook' } }],
      },
    },
    { type: 'user', uuid: `tr-${++seq}`, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: RESULT }] } },
    { type: 'assistant', uuid: `a-${++seq}`, timestamp: at(), message: { id: 'msg_done', role: 'assistant', content: [{ type: 'text', text: 'Found it.' }] } },
  ]
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD))
  await fs.mkdir(dir, { recursive: true })
  const jsonlPath = path.join(dir, `${sessionId}.jsonl`)
  await fs.writeFile(jsonlPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const st = await fs.stat(jsonlPath)
  return { jsonlPath, mtimeMs: st.mtimeMs }
}

/**
 * One cached message carrying the defective row: the result cut at the retained cap
 * with NO `resultChars`. `toolUseId` decides whether the resolver's re-read can find
 * the row again, which is the difference between the two cases below.
 */
const cachedRow = (toolUseId: string): SessionHistoryMessage[] => [{
  role: 'assistant',
  text: '',
  msgId: MSG_ID,
  timestamp: at(),
  tools: [{
    name: TOOL_NAME,
    input: { query: 'deploy runbook' },
    toolUseId,
    result: RESULT.slice(0, HISTORY_TOOL_RESULT_MAX),
  }],
}] as unknown as SessionHistoryMessage[]

/** Write a cache entry by hand, with or without today's stamp. */
async function writeCacheEntry(sessionId: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(HISTORY_CACHE_DIR, { recursive: true })
  await fs.writeFile(path.join(HISTORY_CACHE_DIR, `${sessionId}.json`), JSON.stringify(payload), 'utf-8')
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(path.dirname(path.dirname(HISTORY_CACHE_DIR)), { recursive: true, force: true }).catch(() => {})
})

describe('activity detail vs. a stale parse cache', () => {
  it('re-parses past an unstamped cache entry and reads the result to its end', async () => {
    const sid = 'stale-cache-old-shape'
    const { mtimeMs } = await seedSession(sid)
    // The old writer's payload exactly: no `schema`, and an mtime that MATCHES the
    // JSONL, which is what made the fast-path serve it forever.
    await writeCacheEntry(sid, {
      messages: cachedRow(TOOL_USE_ID),
      cachedAt: '2026-09-12T15:17:26.000Z',
      mtimeMs,
    })

    // First read of this session in-process, so the disk entry is the only cache in
    // play (an earlier list read would have seeded the in-memory one).
    const ref = activityRef(sid, MSG_ID, { kind: 'tool', index: 0 })!
    const { status, body } = await detail(ref)
    expect(status).toBe(200)
    expect(body.toolName).toBe(TOOL_NAME)
    // The defect's exact numbers: 4,999/5,000 reported complete.
    expect(body.resultChars).toBeGreaterThan(17_000)
    expect(body.truncated).toBe(false)
    expect(body.resultTruncated).toBeUndefined()
    expect(body.result!.endsWith(END_MARKER)).toBe(true)

    // …and the entry has been rewritten in today's shape, so the next read is a cache
    // HIT rather than another full parse (the version check is a one-time cost).
    const rewritten = JSON.parse(await fs.readFile(path.join(HISTORY_CACHE_DIR, `${sid}.json`), 'utf-8')) as {
      schema?: number; messages: Array<{ tools?: Array<{ resultChars?: number }> }>
    }
    expect(rewritten.schema).toBe(2)
    expect(rewritten.messages.some((m) => m.tools?.some((t) => t.resultChars === RESULT.length))).toBe(true)
  })

  it('says truncated, with no cursor, for an unstamped cap-length prefix it cannot re-read', async () => {
    const sid = 'stale-cache-unreachable'
    const { mtimeMs } = await seedSession(sid)
    // A CURRENT-schema entry whose row still has the defective shape, and whose
    // tool_use_id is not in the transcript — so the per-row re-read finds nothing,
    // exactly like a message that has slid out of a whale's bounded window. The
    // version check cannot help here, which is why part 2 exists.
    await writeCacheEntry(sid, {
      schema: 2,
      messages: cachedRow('toolu_not_in_transcript'),
      cachedAt: '2026-09-12T15:17:26.000Z',
      mtimeMs,
    })

    const ref = activityRef(sid, MSG_ID, { kind: 'tool', index: 0 })!
    const { status, body } = await detail(ref)
    expect(status).toBe(200)
    // Not "complete". The server has no evidence that the 5,000 units it holds are the
    // whole output, so it says so and offers no page that would answer empty.
    expect(body.resultTruncated).toBe(true)
    expect(body.truncated).toBe(true)
    expect(body.resultNextOffset).toBeUndefined()
    // The only honest number left is what was delivered.
    expect(body.result!.length).toBe(HISTORY_TOOL_RESULT_MAX)
    expect(body.resultChars).toBe(HISTORY_TOOL_RESULT_MAX)
  })

  it('leaves a genuinely complete result alone (no false truncation)', async () => {
    // The other side of the trade: a short result has no stamp either, and it must
    // still read as whole. This is the case that fails if the ambiguity rule is
    // written as "no resultChars means re-read" instead of "at the cap and no stamp".
    const sid = 'stale-cache-short'
    await seedSession(sid)
    const shortRef = activityRef(sid, 'msg_short', { kind: 'tool', index: 0 })
    expect(shortRef).toBeDefined()
    await writeCacheEntry(sid, {
      schema: 2,
      messages: [{
        role: 'assistant', text: '', msgId: 'msg_short', timestamp: at(),
        tools: [{ name: 'Read', input: { file_path: '/tmp/x.ts' }, toolUseId: 'toolu_short', result: 'export const x = 1' }],
      }],
      cachedAt: 'now',
      mtimeMs: (await fs.stat(path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${sid}.jsonl`))).mtimeMs,
    })
    const { status, body } = await detail(shortRef!)
    expect(status).toBe(200)
    expect(body.truncated).toBe(false)
    expect(body.resultTruncated).toBeUndefined()
    expect(body.result).toBe('export const x = 1')
  })
})
