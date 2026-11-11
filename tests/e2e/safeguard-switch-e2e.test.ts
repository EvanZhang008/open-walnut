/**
 * A session the model's safeguards refuse twice in a row moves to another model by itself, through
 * the real server (mock daemon + mock CLI; src/core/sessions/safeguard-switch.ts). The mock refuses
 * every line while its model is one of MOCK_SAFEGUARD_REFUSE_MODELS, in Claude Code 2.1.322's own
 * stream shape (2026-11-11: one task got "API Error: Opus 5.5's safeguards flagged this message"
 * 19 times and stayed stuck until the user typed /model).
 *
 * Pinned: one refusal switches nothing; the second switches the live CLI to another model and one
 * Walnut note resends the person's words; the new model answers and the task is handed back with
 * its session; the lead hears it once on its next message; the second refusal raised no error card.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-safeguard-switch-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { ridingKeys } from '../../src/core/sessions/status-riding.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
const results = new Map<string, Array<{ isError: boolean; text: string; refused: boolean }>>()

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
const sessionCards = async (sid: string): Promise<any[]> => ((await req('GET', '/api/notifications')).json?.feed ?? [])
  .filter((n: any) => n.recoveryKey === `session:${sid}`)

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  process.env.WALNUT_IDLE_COMPACTION = '0'
  process.env.MOCK_SAFEGUARD_REFUSE_MODELS = 'mock-model'
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  bus.subscribe('safeguard-e2e-results', (e) => {
    const d = e.data as { sessionId?: string; isError?: boolean; result?: string; safeguardStop?: unknown }
    if (!d.sessionId) return
    const list = results.get(d.sessionId) ?? []
    list.push({ isError: d.isError === true, text: String(d.result ?? ''), refused: !!d.safeguardStop })
    results.set(d.sessionId, list)
  }, { global: true, interest: [EventNames.SESSION_RESULT] })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 120_000)

afterAll(async () => {
  for (const k of ['WALNUT_IDLE_COMPACTION', 'MOCK_SAFEGUARD_REFUSE_MODELS']) delete process.env[k]
  sessionRunner.setTestDaemonUrl(undefined)
  bus.unsubscribe('safeguard-e2e-results')
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a session the model\'s safeguards refuse', () => {
  it('moves to another model after two refusals, resends the words, and its lead hears it once', async () => {
    // The lead: a session of its own the worker's line rides to.
    process.env.MOCK_SAFEGUARD_REFUSE_MODELS = ''
    const leadStart = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'big-context-turn:20000:1h' })
    expect(leadStart.status, JSON.stringify(leadStart.json)).toBe(200)
    const lead = { sid: leadStart.json.sessionId as string, taskId: leadStart.json.taskId as string }
    // Its CLI reads the refusal list when it spawns: wait for its clean first answer before turning it on.
    await until('lead answered', async () => results.get(lead.sid) ?? [], (l) => l.some((r) => !r.isError))

    process.env.MOCK_SAFEGUARD_REFUSE_MODELS = 'mock-model'
    const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello' })
    expect(started.status, JSON.stringify(started.json)).toBe(200)
    const w = { sid: started.json.sessionId as string, taskId: started.json.taskId as string }
    const patched = await req('PATCH', `/api/tasks/${w.taskId}`, { parent_task_id: lead.taskId })
    expect(patched.status, JSON.stringify(patched.json)).toBeLessThan(300)

    await until('first refusal', async () => results.get(w.sid) ?? [], (l) => l.filter((r) => r.refused).length === 1)
    await until('idle after the first', () => getSessionByClaudeId(w.sid), (r) => r?.process_status !== 'running')
    expect((await getSessionByClaudeId(w.sid))?.safeguardSwitch?.streak).toBe(1)
    expect(sentTexts(w.sid).some((t) => t.includes('Walnut switched this session'))).toBe(false)

    await sendMessageToSession(w.sid, 'please finish the flag registry', { source: 'ui', taskId: w.taskId })
    const note = await until('the resend note', async () => sentTexts(w.sid).filter((t) => t.includes('Walnut switched this session')),
      (l) => l.length === 1, 30_000)
    expect(note[0]).toContain('please finish the flag registry')
    expect(note[0]).toContain('from the user')
    expect(note[0]).toContain('[reasoning_extraction]')

    // The new model answered the note: a clean turn, the task handed back and still holding its session.
    await until('a clean answer', async () => results.get(w.sid) ?? [], (l) => l.length >= 3 && !l[l.length - 1]!.isError)
    const rec = await until('switched record', () => getSessionByClaudeId(w.sid), (r) => (r?.safeguardSwitch?.switches?.length ?? 0) === 1 && r?.process_status !== 'running')
    expect(rec!.cliModel).toBeTruthy()
    expect(rec!.cliModel).not.toContain('mock-model')
    expect(rec!.safeguardSwitch).toMatchObject({ streak: 0 })
    expect(rec!.safeguardSwitch!.switches![0]!.resent).toBeGreaterThanOrEqual(1)
    await until('handed back after the answer', () => task(w.taskId), (t) => t.phase === 'NEED_ACTION')
    expect((await task(w.taskId)).session_id).toBe(w.sid)
    // Only the first refusal's card: the second was the switch's to handle.
    const cards = await sessionCards(w.sid)
    expect(cards.length).toBeLessThanOrEqual(1)
    // The lead's next message carries one line about it.
    expect(ridingKeys(lead.sid)).toContain(`safeguard-switch:${w.taskId}`)
  }, 120_000)
})
