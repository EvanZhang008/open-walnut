/**
 * GET /api/v1/sessions/:id/transcript paging: `before`, `visible`, `pageable`.
 *
 * The 2026-10-04 phone report: on a busy session the page folded a turn's tool
 * calls into one line, and scrolling to the top ended at that line with the
 * user's own messages nowhere above it. The route only ever answered the newest
 * ~100 history messages. These cases pin the additive paging contract the phone
 * now walks back with, through the real server and a real JSONL on disk:
 *  - a rich inline answer says `pageable: true`; a default answer is unchanged;
 *  - `visible` reaches back to text, and junk values are ignored, not rejected;
 *  - `before` answers only older rows and never the exported file (which holds
 *    the NEWEST tail, so prepending it would duplicate the conversation);
 *  - a malformed `before` is a 400 the client can see, not an empty page.
 *
 * Mocked: constants (temp dirs) and the '__local__' daemon file reader, which in
 * production expands `~/.claude` via its own HOME and cannot see the fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-transcript-paging'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { buildSessionTranscript, SESSION_TRANSCRIPTS_DIR } from '../../../src/core/session-projection.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'

const CWD = '/Users/test/transcript-paging'

let server: HttpServer
let port: number

interface Row { role: string; text: string; timestamp: string; kind?: string }
interface Body {
  truncated: boolean
  messages: Row[]
  rich?: boolean
  pageable?: boolean
  error?: { code: string }
}

async function getTranscript(sid: string, qs = ''): Promise<{ status: number; text: string; body: Body }> {
  const res = await fetch(`http://localhost:${port}/api/v1/sessions/${sid}/transcript${qs}`)
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) as Body : ({} as Body) }
}

const stripExportedAt = (s: string): string => s.replace(/"exportedAt":"[^"]*"/g, '"exportedAt":"<t>"')

let seq = 0
const at = (): string => new Date(Date.UTC(2026, 0, 1) + (++seq) * 1000).toISOString()

const userLine = (text: string): unknown => ({
  type: 'user', uuid: `u-${++seq}`, timestamp: at(),
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const proseLine = (id: string, text: string): unknown => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp: at(),
  message: { id, role: 'assistant', content: [{ type: 'text', text }] },
})
const toolCall = (id: string, command: string): unknown[] => [
  {
    type: 'assistant', uuid: `t-${++seq}`, timestamp: at(),
    message: { id, role: 'assistant', content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command } }] },
  },
  {
    type: 'user', uuid: `r-${++seq}`, timestamp: at(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: 'ok' }] },
  },
]

/** The reported shape: one ask, then turns of many tool calls closed by one line. */
async function seedBusySession(sid: string, turns: number, callsPerTurn: number): Promise<void> {
  await createSessionRecord(sid, '', '', CWD, { title: 'Busy session', initialProcessStatus: 'idle' })
  const lines: unknown[] = [userLine('Clean up the orphaned records and report back.')]
  for (let t = 0; t < turns; t++) {
    for (let c = 0; c < callsPerTurn; c++) lines.push(...toolCall(`m-${t}-${c}`, `step ${t}.${c}`))
    lines.push(proseLine(`p-${t}`, `Turn ${t} done.`))
  }
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** The export sweep's slim NEWEST tail, with text no JSONL row has. */
async function writeExportedTail(sid: string): Promise<void> {
  await fs.mkdir(SESSION_TRANSCRIPTS_DIR, { recursive: true })
  await fs.writeFile(
    path.join(SESSION_TRANSCRIPTS_DIR, `${sid}.json`),
    JSON.stringify({
      version: 1, sessionId: sid, exportedAt: '2026-01-01T00:00:00.000Z', truncated: false,
      messages: [{ role: 'user', text: 'FROM THE SWEEP FILE', timestamp: '2026-01-01T00:00:00.000Z' }],
    }),
  )
}

const texts = (rows: Row[]): string[] => rows.filter((m) => !m.kind).map((m) => m.text)

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
})

describe('transcript paging', () => {
  it('a rich live answer says pageable; a default answer is byte-for-byte unchanged', async () => {
    const sid = 'sess-paging-flag'
    await seedBusySession(sid, 2, 10)

    const rich = await getTranscript(sid, '?fresh=1&rich=1')
    expect(rich.status).toBe(200)
    expect(rich.body).toMatchObject({ rich: true, pageable: true })

    const plain = await getTranscript(sid, '?fresh=1')
    expect(plain.text).not.toContain('pageable')
    expect(stripExportedAt(plain.text)).toBe(stripExportedAt(JSON.stringify(await buildSessionTranscript(sid))))
  })

  it('a rich answer from the exported file is not pageable', async () => {
    // A stopped session whose JSONL is gone: the file is the only copy left, and
    // it is the newest tail, so the client must not be told it can page from it.
    const sid = 'sess-paging-sweep'
    await createSessionRecord(sid, '', '', CWD, { title: 'Archived', initialProcessStatus: 'stopped' })
    await writeExportedTail(sid)
    const fromFile = await getTranscript(sid, '?rich=1')
    expect(fromFile.status).toBe(200)
    expect(texts(fromFile.body.messages)).toEqual(['FROM THE SWEEP FILE'])
    expect(fromFile.body.rich).toBe(false)
    expect(fromFile.body.pageable).toBeUndefined()
  })

  it('visible reaches back to that many text rows', async () => {
    const sid = 'sess-paging-visible'
    await seedBusySession(sid, 6, 40)
    const tail = await getTranscript(sid, '?fresh=1&rich=1')
    const deep = await getTranscript(sid, '?fresh=1&rich=1&visible=5')
    expect(texts(tail.body.messages).length).toBeLessThan(5)
    expect(texts(deep.body.messages)).toEqual(['Turn 1 done.', 'Turn 2 done.', 'Turn 3 done.', 'Turn 4 done.', 'Turn 5 done.'])
    expect(deep.body.truncated).toBe(true)
  })

  it('a junk visible is ignored, never an error', async () => {
    const sid = 'sess-paging-junk'
    await seedBusySession(sid, 3, 40)
    const baseline = await getTranscript(sid, '?fresh=1&rich=1')
    for (const v of ['0', '-3', '2.5', 'abc', '']) {
      const r = await getTranscript(sid, `?fresh=1&rich=1&visible=${v}`)
      expect(r.status, `visible=${v}`).toBe(200)
      expect(r.body.messages.length, `visible=${v}`).toBe(baseline.body.messages.length)
    }
  })

  it('before walks back to the opening ask, never through the exported file', async () => {
    const sid = 'sess-paging-before'
    await seedBusySession(sid, 5, 90)
    await writeExportedTail(sid)

    let page = await getTranscript(sid, '?fresh=1&rich=1&visible=3')
    const pages: Row[][] = [page.body.messages]
    while (page.body.truncated) {
      const cursor = page.body.messages[0].timestamp
      // No fresh, no rich: `before` alone is still a live read.
      page = await getTranscript(sid, `?before=${encodeURIComponent(cursor)}&visible=3`)
      expect(page.status).toBe(200)
      expect(page.text).not.toContain('FROM THE SWEEP FILE')
      for (const m of page.body.messages) expect(m.timestamp < cursor).toBe(true)
      pages.push(page.body.messages)
      expect(pages.length).toBeLessThan(40)
    }
    const stitched = pages.reverse().flat()
    expect(stitched[0]).toMatchObject({ role: 'user', text: 'Clean up the orphaned records and report back.' })
    expect(texts(stitched).filter((t) => t.startsWith('Turn '))).toEqual(
      ['Turn 0 done.', 'Turn 1 done.', 'Turn 2 done.', 'Turn 3 done.', 'Turn 4 done.'])
    // Nothing twice: every row's identity is unique across the pages.
    const keys = stitched.map((m) => `${m.timestamp}|${m.kind ?? ''}|${m.text}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('a rich before page says pageable', async () => {
    const sid = 'sess-paging-before-rich'
    await seedBusySession(sid, 3, 60)
    const tail = await getTranscript(sid, '?fresh=1&rich=1')
    const older = await getTranscript(sid, `?fresh=1&rich=1&before=${encodeURIComponent(tail.body.messages[0].timestamp)}`)
    expect(older.body).toMatchObject({ rich: true, pageable: true })
    expect(older.body.messages.length).toBeGreaterThan(0)
  })

  it('a malformed before is a 400, not an empty page', async () => {
    const sid = 'sess-paging-bad'
    await seedBusySession(sid, 1, 3)
    for (const bad of ['yesterday', 'x'.repeat(60), '2026-13-45T99:99:99Z', 'Jan 1 2026']) {
      const r = await getTranscript(sid, `?before=${encodeURIComponent(bad)}`)
      expect(r.status, bad).toBe(400)
      expect(r.body.error?.code, bad).toBe('invalid_before')
    }
  })

  it('since reaches back to the newest row the client holds; a malformed one is a 400', async () => {
    const sid = 'sess-paging-since'
    await seedBusySession(sid, 2, 150)
    const whole = await getTranscript(sid, '?fresh=1&rich=1&visible=200')
    const held = whole.body.messages.find((m) => m.text === 'Turn 0 done.')!.timestamp
    const r = await getTranscript(sid, `?fresh=1&rich=1&since=${encodeURIComponent(held)}`)
    expect(r.body.messages[0]).toMatchObject({ text: 'Turn 0 done.' })
    expect(r.body.pageable).toBe(true)
    const bad = await getTranscript(sid, '?fresh=1&rich=1&since=soon')
    expect(bad.status).toBe(400)
    expect(bad.body.error?.code).toBe('invalid_since')
  })

  it('the replica relay builds the same pages the route serves', async () => {
    // A phone on the cloud companion pages through `session.control` action
    // `transcript`, answered here by the primary (session-transcript-relay.ts).
    const sid = 'sess-paging-relay'
    await seedBusySession(sid, 4, 60)
    const strip = (b: object): object => {
      const { exportedAt: _e, rich: _r, pageable: _p, ...rest } = b as Record<string, unknown>
      return rest
    }
    const relay = async (params: Record<string, unknown>) =>
      await handleSessionControlRelay('transcript', sid, params) as
        { ok: true; result: Body } | { ok: false; error: string; errorKind: string }

    const route = await getTranscript(sid, '?fresh=1&rich=1&visible=2')
    const relayed = await relay({ rich: true, visible: 2 })
    expect(relayed.ok).toBe(true)
    if (!relayed.ok) return
    expect(strip(relayed.result)).toEqual(strip(route.body))
    // The builder's own output: the replica adds `rich` / `pageable`, like the route.
    expect(relayed.result.pageable).toBeUndefined()

    const cursor = route.body.messages[0].timestamp
    const olderRoute = await getTranscript(sid, `?fresh=1&rich=1&visible=2&before=${encodeURIComponent(cursor)}`)
    const olderRelay = await relay({ rich: true, visible: 2, before: cursor })
    expect(olderRelay.ok && strip(olderRelay.result)).toEqual(strip(olderRoute.body))

    // A cursor the route would 400 is refused here too, never answered as a tail.
    for (const params of [{ before: 'yesterday' }, { since: 7 }, { before: 'x'.repeat(60) }]) {
      const bad = await relay({ rich: true, ...params })
      expect(bad.ok, JSON.stringify(params)).toBe(false)
    }
    expect((await handleSessionControlRelay('transcript', 'bad.id', { rich: true })).ok).toBe(false)
    // A junk visible is ignored, the way the route ignores it.
    const junk = await relay({ rich: true, visible: -3 })
    const plainRelay = await relay({ rich: true })
    expect(junk.ok && plainRelay.ok && junk.result.messages.length).toBe(plainRelay.ok && plainRelay.result.messages.length)
  })

  it('an unknown session pages to an empty page, and an unsafe id is a 404', async () => {
    const r = await getTranscript('sess-paging-nobody', `?before=${encodeURIComponent('2026-01-01T00:00:00Z')}`)
    expect(r.status).toBe(200)
    expect(r.body.messages).toEqual([])
    const unsafe = await getTranscript('bad.id', `?before=${encodeURIComponent('2026-01-01T00:00:00Z')}`)
    expect(unsafe.status).toBe(404)
  })
})
