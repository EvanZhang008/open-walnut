/**
 * Idle compaction through the real server (mock daemon + mock CLI): a big Claude Code session with
 * a 1-hour prompt cache is compacted shortly before the cache expires, as a quiet turn
 * (src/core/sessions/idle-compaction.ts, quiet-turn.ts). The lead is moved so the compaction fires
 * a few seconds after the turn instead of 57 minutes.
 *
 * Pinned: the bare `/compact` reaches the CLI unframed; the task stays NEED_ACTION and never reads
 * Working while the compaction runs; the record says when and from what; the facts say compacted;
 * a 5-minute cache and a small session are left alone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-idle-compaction-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
// The cache lives an hour; this lead sends the compaction 5 s after the request.
const LEAD_MS = 3_600_000 - 5_000

let server: HttpServer
let port: number
let daemon: MockDaemon

async function req(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function until<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await probe()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    v = await probe()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 400)}`)
  return v
}

async function task(id: string): Promise<any> {
  const r = await req('GET', `/api/tasks/${id}`)
  return r.json.task ?? r.json
}

const sentTexts = (sid: string) => daemon.getCommandHistoryFor('send')
  .filter((c) => c.payload.sid === sid)
  .map((c) => String(c.payload.text ?? c.payload.message ?? ''))

async function startBig(message: string): Promise<{ sid: string; taskId: string }> {
  const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message })
  expect(started.status, JSON.stringify(started.json)).toBe(200)
  const w = { sid: started.json.sessionId as string, taskId: started.json.taskId as string }
  await until('first hand-back', () => task(w.taskId), (t) => t.phase === 'NEED_ACTION')
  return w
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  process.env.WALNUT_IDLE_COMPACT_LEAD_MS = String(LEAD_MS)
  process.env.MOCK_COMPACT_MS = '2500'
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 120_000)

afterAll(async () => {
  delete process.env.WALNUT_IDLE_COMPACT_LEAD_MS
  delete process.env.MOCK_COMPACT_MS
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a big idle session with a 1-hour cache', () => {
  it('is compacted before the cache expires, quietly', async () => {
    const w = await startBig('big-context-turn:400000:1h')
    const facts = await until('facts stored', () => getSessionByClaudeId(w.sid), (r) => !!r?.promptCache?.expiresAt)
    expect(facts!.promptCache).toMatchObject({ tokens: 400_040, ttlMs: 3_600_000 })
    const before = await task(w.taskId)

    // The compaction goes out as the bare command.
    await until('/compact sent', async () => sentTexts(w.sid), (t) => t.some((s) => s.trim() === '/compact'), 20_000)
    const compactLine = sentTexts(w.sid).find((s) => s.includes('/compact'))!
    expect(compactLine.trim()).toBe('/compact')

    // While it runs and after it ends: no phase move, never Working.
    const seen = new Set<string>()
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const t = await task(w.taskId)
      seen.add(`${t.phase}/${t.user_status?.state ?? '-'}`)
      await new Promise((r) => setTimeout(r, 150))
    }
    expect([...seen].every((s) => s.startsWith('NEED_ACTION/')), [...seen].join(',')).toBe(true)
    expect([...seen].some((s) => s.endsWith('/working')), [...seen].join(',')).toBe(false)

    const rec = await until('compacted facts', () => getSessionByClaudeId(w.sid), (r) => !!r?.promptCache?.compactedAt)
    expect(rec!.promptCache!.tokens).toBe(18_000)
    expect(rec!.idleCompaction).toMatchObject({ tokens: 400_040 })
    expect(Date.parse(rec!.idleCompaction!.priorTurnEnd!)).toBeLessThanOrEqual(Date.parse(rec!.idleCompaction!.sentAt))
    await until('quiet end stored', () => getSessionByClaudeId(w.sid), (r) => !!r?.idleCompaction?.endedAt)

    // Nothing else was sent to the session for it (no status question, no notice).
    expect(sentTexts(w.sid).filter((s) => s.trim() !== '/compact' && !s.includes('big-context-turn'))).toEqual([])
    const after = await task(w.taskId)
    expect(after.phase).toBe(before.phase)
  }, 90_000)

  it('a person writing while it compacts is answered as an ordinary turn, never a quiet one', async () => {
    const w = await startBig('big-context-turn:400000:1h')
    await until('/compact sent', async () => sentTexts(w.sid), (t) => t.some((s) => s.trim() === '/compact'), 20_000)
    await sendMessageToSession(w.sid, 'big-context-turn:60000:1h', { source: 'ui', taskId: w.taskId })
    // Their turn reads as Working at some point and ends handed back, with its own answer.
    const seen = new Set<string>()
    const t = await until('their turn handed back', async () => {
      const t = await task(w.taskId)
      seen.add(t.user_status?.state ?? '-')
      return t
    }, (t) => seen.has('working') && t.phase === 'NEED_ACTION' && t.user_status?.state !== 'working', 30_000)
    expect(t.phase).toBe('NEED_ACTION')
    await until('their answer recorded', () => getSessionByClaudeId(w.sid), (r) => (r?.promptCache?.tokens ?? 0) > 50_000 && !r?.promptCache?.compactedAt, 20_000)
  }, 90_000)

  // 2026-11-04 review: a plain message typed while it compacts. Claude Code 2.1.312 runs it after
  // the compaction as its own turn (started, init, answer, result); that turn hands the task back.
  it('a plain message typed while it compacts is answered and hands the task back', async () => {
    const w = await startBig('big-context-turn:400000:1h')
    await until('/compact sent', async () => sentTexts(w.sid), (t) => t.some((s) => s.trim() === '/compact'), 20_000)
    await sendMessageToSession(w.sid, 'what changed in the parser?', { source: 'ui', taskId: w.taskId })
    const seen = new Set<string>()
    const t = await until('their turn handed back', async () => {
      const t = await task(w.taskId)
      seen.add(`${t.phase}/${t.user_status?.state ?? '-'}`)
      return t
    }, (t) => [...seen].some((s) => s.startsWith('IN_PROGRESS/')) && t.phase === 'NEED_ACTION' && t.user_status?.state !== 'working', 30_000)
    expect(t.phase, [...seen].join(',')).toBe('NEED_ACTION')
    const rec = await getSessionByClaudeId(w.sid)
    expect(rec!.promptCache!.compactedAt).toBeUndefined()
  }, 90_000)

  // Stopped while it compacts: Claude Code cancels it ("Compaction canceled.", no boundary). The
  // context stays whole, the task does not move, and Walnut does not try again for that request.
  it('a Stop while it compacts cancels it, and nothing else moves', async () => {
    const w = await startBig('big-context-turn:400000:1h')
    const before = await task(w.taskId)
    await until('/compact sent', async () => sentTexts(w.sid), (t) => t.some((s) => s.trim() === '/compact'), 20_000)
    await until('compacting', async () => sessionRunner.findSessionByClaudeId(w.sid)?.inTurn ?? false, (v) => v, 10_000)
    const stop = await req('POST', `/api/sessions/${w.sid}/interrupt`)
    expect(stop.status, JSON.stringify(stop.json)).toBeLessThan(300)
    const rec = await until('the quiet turn ended', () => getSessionByClaudeId(w.sid), (r) => !!r?.idleCompaction?.endedAt, 20_000)
    expect(rec!.promptCache).toMatchObject({ tokens: 400_040 })
    expect(rec!.promptCache!.compactedAt).toBeUndefined()
    await new Promise((r) => setTimeout(r, 1500))
    const after = await task(w.taskId)
    expect(after.phase).toBe(before.phase)
    expect(sentTexts(w.sid).filter((s) => s.trim() === '/compact')).toHaveLength(1)
  }, 90_000)

  it('a 5-minute cache and a small session are left alone', async () => {
    const short = await startBig('big-context-turn:400000:5m')
    const small = await startBig('big-context-turn:60000:1h')
    await new Promise((r) => setTimeout(r, 9_000))
    expect(sentTexts(short.sid).some((s) => s.trim() === '/compact')).toBe(false)
    expect(sentTexts(small.sid).some((s) => s.trim() === '/compact')).toBe(false)
    expect((await getSessionByClaudeId(short.sid))?.idleCompaction).toBeUndefined()
    expect((await getSessionByClaudeId(small.sid))?.idleCompaction).toBeUndefined()
  }, 90_000)
})
