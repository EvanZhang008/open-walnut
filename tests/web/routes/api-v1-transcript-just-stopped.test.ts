/**
 * GET /api/v1/sessions/:id/transcript (the plain read task_history makes) for a
 * session that has just ENDED.
 *
 * The defect: the plain read serves the sweep-exported tail, and when that file
 * did not exist yet it built inline only for a running/idle session. A session
 * that stopped inside the sweep's minute (a subtask that completes its own task
 * is stopped when that turn ends) therefore answered 404 "No transcript for
 * session" while its JSONL sat on disk and `?fresh=1` read it fine. A leader
 * reading its subtask's result right when it ended got the 404.
 *
 * The neighbour of the same gap: a tail exported while the session was still
 * alive is frozen as its archive once it stops, so the archive kept a tail
 * without the final turn. Both are covered here, plus the 404 contract the old
 * gate existed to keep (unknown ids, dead sessions with nothing to read) and a
 * deadline so a slow host read cannot pin the connection.
 *
 * Real: Express server, api-v1 router, SQLite session records, the whole read
 * pipeline against JSONL on disk. Mocked: constants (temp dirs) and the
 * '__local__' daemon file reader (see mock-local-daemon-reader.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-transcript-stopped'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord, updateSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { SESSION_TRANSCRIPTS_DIR } from '../../../src/core/session-projection.js'
import { DaemonFileReader } from '../../../src/core/daemon-file-reader.js'

const CWD = '/Users/test/transcript-stopped'

let server: HttpServer
let port: number

interface Body {
  sessionId: string
  exportedAt: string
  messages: Array<{ role: string; text: string }>
  error?: { code: string; message: string }
}

async function getTranscript(sid: string, qs = ''): Promise<{ status: number; body: Body; ms: number }> {
  const t0 = Date.now()
  const res = await fetch(`http://localhost:${port}/api/v1/sessions/${sid}/transcript${qs}`)
  return { status: res.status, body: await res.json() as Body, ms: Date.now() - t0 }
}

let seq = 0
const at = (): string => new Date(Date.UTC(2026, 9, 26, 0, 0, ++seq)).toISOString()
const userLine = (text: string): unknown => ({
  type: 'user', uuid: `u-${++seq}`, timestamp: at(),
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const assistantLine = (text: string): unknown => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp: at(),
  message: { id: `msg-${seq}`, role: 'assistant', content: [{ type: 'text', text }] },
})

const jsonlPath = (sid: string): string => path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${sid}.jsonl`)

async function writeJsonl(sid: string, lines: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(jsonlPath(sid)), { recursive: true })
  await fs.writeFile(jsonlPath(sid), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** What the sweep writes, with a marker text so a case can tell which source answered. */
async function writeExportedTail(sid: string, exportedAt: string, text = 'FROM THE SWEEP FILE'): Promise<void> {
  await fs.mkdir(SESSION_TRANSCRIPTS_DIR, { recursive: true })
  await fs.writeFile(path.join(SESSION_TRANSCRIPTS_DIR, `${sid}.json`), JSON.stringify({
    version: 1, sessionId: sid, exportedAt, truncated: false,
    messages: [{ role: 'user', text, timestamp: exportedAt }],
  }))
}

/** A session that ran a turn and then stopped (the self-complete stop's shape). */
async function seedStoppedSession(sid: string, finalReply = 'Done: the result is 42.'): Promise<void> {
  await createSessionRecord(sid, '', '', CWD, { title: 'Subtask', initialProcessStatus: 'idle' })
  await writeJsonl(sid, [userLine('compute the answer'), assistantLine(finalReply)])
  await updateSessionRecord(sid, { process_status: 'stopped' })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.WALNUT_TRANSCRIPT_READ_DEADLINE_MS
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('plain transcript read of a session that just ended', () => {
  it('answers the JSONL, not 404, when the sweep has not exported it yet', async () => {
    const sid = 'sess-just-stopped'
    await seedStoppedSession(sid)
    const { status, body } = await getTranscript(sid)
    expect(status).toBe(200)
    expect(body.sessionId).toBe(sid)
    expect(body.messages.map((m) => m.text)).toEqual(['compute the answer', 'Done: the result is 42.'])
    // Same rows the fresh path reads.
    const fresh = await getTranscript(sid, '?fresh=1')
    expect(fresh.body.messages.map((m) => m.text)).toEqual(body.messages.map((m) => m.text))
  })

  it('serves the same answer to concurrent readers', async () => {
    const sid = 'sess-just-stopped-concurrent'
    await seedStoppedSession(sid, 'Parallel result.')
    const reads = await Promise.all(Array.from({ length: 6 }, () => getTranscript(sid)))
    for (const r of reads) {
      expect(r.status).toBe(200)
      expect(r.body.messages.at(-1)!.text).toBe('Parallel result.')
    }
  })

  it('rebuilds an archive exported before the session ended (it lacks the last turn)', async () => {
    const sid = 'sess-stale-archive'
    await seedStoppedSession(sid, 'The final reply.')
    // Exported while the session was alive, before its last activity.
    await writeExportedTail(sid, '2026-01-01T00:00:00.000Z')
    const { status, body } = await getTranscript(sid)
    expect(status).toBe(200)
    expect(body.messages.at(-1)!.text).toBe('The final reply.')
  })

  it('keeps serving an archive written after the end, without reading the JSONL', async () => {
    const sid = 'sess-fresh-archive'
    await seedStoppedSession(sid)
    const after = new Date(Date.parse((await getSessionByClaudeId(sid))!.lastActiveAt) + 60_000).toISOString()
    await writeExportedTail(sid, after)
    const reads = vi.spyOn(DaemonFileReader.prototype, 'readFile')
    const { status, body } = await getTranscript(sid)
    expect(status).toBe(200)
    expect(body.messages.map((m) => m.text)).toEqual(['FROM THE SWEEP FILE'])
    expect(reads).not.toHaveBeenCalled()
  })

  it('keeps a stale archive when the JSONL is gone, rather than answering empty', async () => {
    const sid = 'sess-stale-archive-purged'
    await seedStoppedSession(sid)
    await writeExportedTail(sid, '2026-01-01T00:00:00.000Z', 'THE ONLY COPY LEFT')
    await fs.rm(jsonlPath(sid))
    const { status, body } = await getTranscript(sid)
    expect(status).toBe(200)
    expect(body.messages.map((m) => m.text)).toEqual(['THE ONLY COPY LEFT'])
    // The empty refresh is remembered for this end: the next open reads nothing.
    const reads = vi.spyOn(DaemonFileReader.prototype, 'stat')
    const again = await getTranscript(sid)
    expect(again.body.messages.map((m) => m.text)).toEqual(['THE ONLY COPY LEFT'])
    expect(reads).not.toHaveBeenCalled()
  })

  it('reads past a half-written export file', async () => {
    const sid = 'sess-half-written-export'
    await seedStoppedSession(sid, 'Survived a torn export.')
    await fs.mkdir(SESSION_TRANSCRIPTS_DIR, { recursive: true })
    await fs.writeFile(path.join(SESSION_TRANSCRIPTS_DIR, `${sid}.json`), '{"version":1,"sessionId":"sess-half-wr')
    const { status, body } = await getTranscript(sid)
    expect(status).toBe(200)
    expect(body.messages.at(-1)!.text).toBe('Survived a torn export.')
  })

  it('reads the tail window of a stopped session over the 4 MB ceiling', async () => {
    const sid = 'sess-stopped-whale'
    await createSessionRecord(sid, '', '', CWD, { title: 'Whale', initialProcessStatus: 'idle' })
    const pad = 'x'.repeat(50_000)
    const lines: unknown[] = []
    for (let i = 0; i < 100; i++) lines.push(userLine(`turn ${i} ${pad}`), assistantLine(`reply ${i}`))
    lines.push(userLine('last ask'), assistantLine('Whale final reply.'))
    await writeJsonl(sid, lines)
    expect((await fs.stat(jsonlPath(sid))).size).toBeGreaterThan(4 * 1024 * 1024)
    await updateSessionRecord(sid, { process_status: 'stopped' })
    const { status, body } = await getTranscript(sid)
    expect(status).toBe(200)
    expect(body.messages.at(-1)!.text).toBe('Whale final reply.')
  })

  it('still 404s an unknown id and a dead session with nothing to read', async () => {
    expect((await getTranscript('sess-never-existed')).status).toBe(404)
    const sid = 'sess-dead-no-jsonl'
    await createSessionRecord(sid, '', '', CWD, { title: 'Gone', initialProcessStatus: 'idle' })
    await updateSessionRecord(sid, { process_status: 'stopped' })
    const { status, body } = await getTranscript(sid)
    expect(status).toBe(404)
    expect(body.error!.code).toBe('not_found')
  })

  it('answers 503 within the deadline when the host read hangs, and the retry reads it', async () => {
    const sid = 'sess-stopped-slow-host'
    await seedStoppedSession(sid, 'Read after the hang.')
    process.env.WALNUT_TRANSCRIPT_READ_DEADLINE_MS = '300'
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const realStat = DaemonFileReader.prototype.stat
    vi.spyOn(DaemonFileReader.prototype, 'stat').mockImplementation(async function (this: DaemonFileReader, p: string) {
      await gate
      return realStat.call(this, p)
    })
    const slow = await getTranscript(sid)
    expect(slow.status).toBe(503)
    expect(slow.body.error!.code).toBe('transcript_unavailable')
    expect(slow.ms).toBeLessThan(5_000)
    release()
    vi.restoreAllMocks()
    const retry = await getTranscript(sid)
    expect(retry.status).toBe(200)
    expect(retry.body.messages.at(-1)!.text).toBe('Read after the hang.')
  })
})
