/**
 * A session whose conversation no longer fits ("Prompt is too long") recovers by itself, through
 * the real server (mock daemon + mock CLI; src/core/sessions/context-full-recovery.ts). The mock
 * refuses every line but `/compact` once its context is at MOCK_CONTEXT_FULL_AT, the way Claude
 * Code 2.1.312 refuses at its blocking limit with auto-compact off (2026-11-05 transcript).
 *
 * Pinned: the person's message that got the error is compacted for and sent again, word for word,
 * in one Walnut note; the compaction is Walnut's listed command line; the session ends idle, not in error; at
 * most two compactions an hour start by themselves, the third overflow waits for a person's
 * Compact and resend (the Retry route), which works past the cap.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-context-full-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { CONTEXT_COMPACT_COMMAND as CONTEXT_COMPACT_TEXT } from '../../src/core/sessions/walnut-commands.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
/** sessionId → the turn ends the runner reported, in order. */
const results = new Map<string, Array<{ isError: boolean; text: string }>>()
const resultCount = async (sid: string) => results.get(sid)?.length ?? 0
/** The turn ends since index `from` whose reply says the mock read a full context (big-context-turn). */
const filledSince = async (sid: string, from: number) => (results.get(sid) ?? []).slice(from).some((r) => /Read 178K tokens/.test(r.text))

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
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 600)}`)
  return v
}

async function task(id: string): Promise<any> {
  const r = await req('GET', `/api/tasks/${id}`)
  return r.json.task ?? r.json
}

const sentTexts = (sid: string) => daemon.getCommandHistoryFor('send')
  .filter((c) => c.payload.sid === sid)
  .map((c) => String(c.payload.text ?? c.payload.message ?? ''))
const compacts = (sid: string) => sentTexts(sid).filter((s) => s.trim() === CONTEXT_COMPACT_TEXT).length
const sessionCards = async (sid: string): Promise<any[]> => ((await req('GET', '/api/notifications')).json?.feed ?? [])
  .filter((n: any) => n.recoveryKey === `session:${sid}`)

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  process.env.WALNUT_IDLE_COMPACTION = '0'
  process.env.MOCK_CONTEXT_WINDOW = '200000'
  process.env.MOCK_CONTEXT_FULL_AT = '177000'
  process.env.MOCK_COMPACT_MS = '800'
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  bus.subscribe('context-full-e2e-results', (e) => {
    const d = e.data as { sessionId?: string; isError?: boolean; result?: string }
    if (!d.sessionId) return
    const list = results.get(d.sessionId) ?? []
    list.push({ isError: d.isError === true, text: String(d.result ?? '') })
    results.set(d.sessionId, list)
  }, { global: true, interest: [EventNames.SESSION_RESULT] })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 120_000)

afterAll(async () => {
  for (const k of ['WALNUT_IDLE_COMPACTION', 'MOCK_CONTEXT_WINDOW', 'MOCK_CONTEXT_FULL_AT', 'MOCK_COMPACT_MS']) delete process.env[k]
  sessionRunner.setTestDaemonUrl(undefined)
  bus.unsubscribe('context-full-e2e-results')
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a session that reached its context limit', () => {
  let w: { sid: string; taskId: string }

  it('compacts and resends the message that got "Prompt is too long"', async () => {
    const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'big-context-turn:178000:1h' })
    expect(started.status, JSON.stringify(started.json)).toBe(200)
    w = { sid: started.json.sessionId, taskId: started.json.taskId }
    await until('first hand-back', () => task(w.taskId), (t) => t.phase === 'NEED_ACTION')

    await sendMessageToSession(w.sid, 'hi, where does the review stand?', { source: 'ui', taskId: w.taskId })

    // The bare command goes out, then one Walnut note carrying the person's words.
    await until('/compact sent', async () => compacts(w.sid), (n) => n === 1, 20_000)
    const resend = await until('resend note', async () => sentTexts(w.sid).filter((s) => s.includes('Prompt is too long')), (l) => l.length === 1, 20_000)
    expect(resend[0]).toContain('hi, where does the review stand?')
    expect(resend[0]).toContain('from the user')
    const rec = await until('recovered', () => getSessionByClaudeId(w.sid), (r) => r?.contextRecovery?.state === 'done' && r.process_status !== 'running')
    expect(rec!.contextRecovery).toMatchObject({ state: 'done', resent: 1 })
    expect(rec!.contextRecovery!.attempts).toHaveLength(1)
    expect(rec!.process_status).toBe('idle')
    expect(rec!.errorMessage ?? null).toBeNull()
    // The resend was answered as an ordinary turn: the task is handed back, not left in error.
    await until('handed back after the answer', () => task(w.taskId), (t) => t.phase === 'NEED_ACTION')
    // An overflow Walnut recovers by itself raises no error card on Home, and the task keeps its
    // session (an error result used to unlink it from the task).
    expect(await sessionCards(w.sid)).toEqual([])
    expect((await task(w.taskId)).session_id).toBe(w.sid)
  }, 90_000)

  it('stops compacting by itself after two an hour, and a person\'s Compact and resend still works', async () => {
    // Second overflow in the hour: compacted by itself. Each step waits for the turn it started to end.
    const fill = async () => {
      const before = await resultCount(w.sid)
      await sendMessageToSession(w.sid, 'big-context-turn:178000:1h', { source: 'ui', taskId: w.taskId })
      await until('the filling turn ended', () => filledSince(w.sid, before), (ok) => ok)
      await until('idle', () => getSessionByClaudeId(w.sid), (r) => r?.process_status === 'idle')
    }
    await until('settled', () => getSessionByClaudeId(w.sid), (r) => r?.process_status === 'idle')
    await fill()
    await sendMessageToSession(w.sid, 'second ask', { source: 'ui', taskId: w.taskId })
    await until('second /compact', async () => compacts(w.sid), (n) => n === 2, 20_000)
    await until('second recovery', () => getSessionByClaudeId(w.sid), (r) => r?.contextRecovery?.state === 'done' && r.contextRecovery.attempts.length === 2 && r.process_status === 'idle', 20_000)

    // Third overflow in the hour: the cap holds it for a person.
    await fill()
    await sendMessageToSession(w.sid, 'third ask', { source: 'ui', taskId: w.taskId })
    const failed = await until('held for a person', () => getSessionByClaudeId(w.sid), (r) => r?.contextRecovery?.state === 'failed')
    expect(failed!.process_status).toBe('error')
    expect(failed!.errorMessage).toBe('Prompt is too long')
    expect(failed!.contextRecovery!.reason).toMatch(/did not free enough room/)
    expect(compacts(w.sid)).toBe(2)
    // Given up: now it is the user's, with a card saying why.
    const raised = await until('error card raised', () => sessionCards(w.sid), (l) => l.some((n) => !n.resolved))
    expect(JSON.stringify(raised)).toMatch(/did not free enough room/)

    // The banner's button is the Retry route: it compacts, past the cap.
    const retried = await req('POST', `/api/sessions/${w.sid}/retry`, {})
    expect(retried.status, JSON.stringify(retried.json)).toBe(200)
    expect(retried.json.status).toBe('compacting')
    await until('third /compact', async () => compacts(w.sid), (n) => n === 3, 20_000)
    const done = await until('manual recovery', () => getSessionByClaudeId(w.sid), (r) => r?.contextRecovery?.state === 'done' && r.process_status === 'idle', 20_000)
    expect(done!.contextRecovery!.resent).toBe(1)
    // The card retires itself once the session works again.
    await until('error card retired', () => sessionCards(w.sid), (l) => l.length > 0 && l.every((n) => n.resolved === 'recovered'))
    expect(sentTexts(w.sid).filter((s) => s.includes('Prompt is too long')).at(-1)).toContain('third ask')
  }, 120_000)
})
