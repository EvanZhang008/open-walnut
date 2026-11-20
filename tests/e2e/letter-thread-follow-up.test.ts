/**
 * His words typed on a thread that holds a decision letter answer that letter, on a real server
 * (src/core/org/letter-follow-up.ts; 2026-11-20, the user typed "K" in the box of a card asking
 * "release the new Mac app?" with two buttons: it went to his lead's chat as a follow-up filed
 * under the thread, the letter stayed unanswered and the card stayed as it was, "what the fuck?").
 *
 *   1. The console's send (session:send over /ws) naming the letter's thread: the letter reads
 *      answered in his words, its thread leaves needs, the asking session gets his words once, as
 *      the letter's answer (with the line telling it how to read a short yes), never as a chat row.
 *   2. The phone's send (POST .../messages with threadId) does the same.
 *   3. A send naming an ordinary thread stays a follow-up in the chat.
 *   4. An agent answering for him with his "K" picks the option (human_inbox_answer), no refusal.
 *
 * What's real: server, WebSocket, bus, task store, inbox, threads store, queue, session runner.
 * Mocked: constants, the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-letter-thread-follow-up'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { getLetter } from '../../src/core/human-inbox/store.js'
import { lettersAsThreadsNow } from '../../src/core/human-inbox/letter-threads.js'
import { letterThreadId } from '../../src/core/org/letter-thread-model.js'
import { WORDS_ANSWER_LINE } from '../../src/core/human-inbox/letter-ops.js'
import { executeOp } from '../../src/ops/index.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

let server: Server
let daemon: MockDaemon
let port = 0
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
let vp = { taskId: '', sid: '' }
const queued = new Map<string, string[]>()

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

const op = async (name: string, args: Record<string, unknown>, sid: string) => {
  const out = await executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: '__local__', callerMode: 'session', callerSid: sid })
  if (!out.ok) throw new Error(out.message)
  return out.result as Record<string, any>
}

/** A decision letter from the lead, as its session sends one; its thread waits on him. */
async function decide(subject: string): Promise<string> {
  const out = await op('human_inbox_send', {
    subject, type: 'action_required', markdown: `${subject} I recommend releasing it.`,
    actions: [{ id: 'release', label: 'Release it' }, { id: 'hold', label: 'Not yet' }],
    user_kind: 'user_own', user_kind_why: 'It ships his own app to him',
  }, vp.sid)
  const id = out.letterId as string
  await vi.waitFor(async () => expect((await readThreads(vp.taskId)).threads.find((t) => t.id === letterThreadId(id))?.state).toBe('needs'), { timeout: 10_000, interval: 200 })
  return id
}

function rpc(method: string, payload: unknown): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const id = `t-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => { ws.close(); reject(new Error(`rpc ${method} timed out`)) }, 20_000)
    ws.once('error', reject)
    ws.on('message', (raw: Buffer | string) => {
      const frame = JSON.parse(raw.toString()) as { type: string; id?: string; ok?: boolean; error?: string; payload?: Record<string, unknown>; result?: Record<string, unknown> }
      if (frame.type !== 'res' || frame.id !== id) return
      clearTimeout(timer)
      ws.close()
      resolve({ ok: !!frame.ok, result: frame.payload ?? frame.result, error: frame.error })
    })
    ws.once('open', () => ws.send(JSON.stringify({ type: 'req', id, method, payload })))
  })
}

const rowsSince = (n: number) => (queued.get(vp.sid) ?? []).slice(n)

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await ensureMainTask()
  expect((await api('PUT', '/api/config', { experimental: { letters_as_threads: true } })).status).toBe(200)
  await vi.waitFor(() => expect(lettersAsThreadsNow()).toBe(true), { timeout: 5000 })
  const lead = await ensureProjectLead('Orchard')
  const sid = (await sessionRunner.startSession({ taskId: lead.id, cwd: WALNUT_HOME, message: 'Ready', project: 'Orchard', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/), { timeout: 20_000 })
  vp = { taskId: lead.id, sid }
  bus.subscribe('test-letter-thread-follow-up', (event) => {
    const d = event.data as { sessionId: string; message?: string }
    queued.set(d.sessionId, [...(queued.get(d.sessionId) ?? []), d.message ?? ''])
  }, { global: true, interest: [EventNames.SESSION_MESSAGE_QUEUED] })
}, 120_000)

afterAll(async () => {
  bus.unsubscribe('test-letter-thread-follow-up')
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

async function expectAnsweredByWords(letterId: string, words: string, before: number): Promise<void> {
  // The letter reads answered in his words, and its thread leaves needs.
  await vi.waitFor(async () => {
    const l = await getLetter(letterId)
    expect(l?.thread?.some((t) => t.from === 'human' && t.text === words)).toBe(true)
  }, { timeout: 10_000, interval: 200 })
  await vi.waitFor(async () => expect((await readThreads(vp.taskId)).threads.find((t) => t.id === letterThreadId(letterId))?.state).not.toBe('needs'), { timeout: 10_000, interval: 200 })
  // The session gets his words once, as the letter's answer, never also as a chat row.
  await vi.waitFor(() => expect(rowsSince(before).filter((m) => m.includes('[Letter reply]') && m.includes(words))).toHaveLength(1), { timeout: 15_000, interval: 200 })
  await new Promise((r) => setTimeout(r, 500))
  const rows = rowsSince(before)
  expect(rows.filter((m) => m.includes(words))).toHaveLength(1)
  expect(rows.find((m) => m.includes('[Letter reply]'))).toContain(WORDS_ANSWER_LINE)
}

describe('his words on a thread holding a letter answer the letter', () => {
  it('the console\'s send naming the thread answers the letter, once', async () => {
    const letter = await decide('Release the new Mac app?')
    const before = queued.get(vp.sid)?.length ?? 0
    const r = await rpc('session:send', { sessionId: vp.sid, message: 'K', threadId: letterThreadId(letter), userUuid: randomUUID() })
    expect(r.ok, r.error).toBe(true)
    expect(r.result?.answeredLetter).toMatchObject({ id: letter, threadId: letterThreadId(letter) })
    await expectAnsweredByWords(letter, 'K', before)
  })

  it('the phone\'s send naming the thread does the same', async () => {
    const letter = await decide('Release the new phone build?')
    const before = queued.get(vp.sid)?.length ?? 0
    const r = await api<{ answeredLetter?: { id: string } }>('POST', `/sessions/${vp.sid}/messages`, { text: 'ok go', threadId: letterThreadId(letter), messageId: 'qm-letter-follow-1' })
    expect(r.status).toBe(202)
    expect(r.json.answeredLetter?.id).toBe(letter)
    await expectAnsweredByWords(letter, 'ok go', before)
  })

  it('a send naming an ordinary thread stays a follow-up in the chat', async () => {
    const filed = await api<{ thread: { id: string } }>('POST', `/tasks/${vp.taskId}/threads`, { text: 'Plan the spring planting' })
    const before = queued.get(vp.sid)?.length ?? 0
    const r = await rpc('session:send', { sessionId: vp.sid, message: 'Start with the pears', threadId: filed.json.thread.id, userUuid: randomUUID() })
    expect(r.ok, r.error).toBe(true)
    expect(r.result?.answeredLetter).toBeUndefined()
    await vi.waitFor(() => expect(rowsSince(before).some((m) => m.includes('Start with the pears') && !m.includes('[Letter reply]'))).toBe(true), { timeout: 10_000, interval: 200 })
  })

  it('an agent answering for him with his "K" picks the option', async () => {
    const letter = await decide('Release the new web build?')
    await op('human_inbox_answer', { id: letter, action_id: 'release', user_words: 'K' }, vp.sid)
    await vi.waitFor(async () => expect((await getLetter(letter))?.answered?.actionId).toBe('release'), { timeout: 10_000, interval: 200 })
  })
})
