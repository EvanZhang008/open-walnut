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
 *   4. An agent answering for him with his "K" picks the recommended option only once Walnut reads
 *      his "K" on that card; a "K" it only quotes, or one for another option, is refused.
 *   5. Review findings (2026-11-20): a browser under automation never answers as him; a Retry, a
 *      resend after a lost receipt and the phone's resend of its qm- id answer once; a letter
 *      answered in the inbox meanwhile leaves his words a plain follow-up; a failed delivery comes
 *      back as an error and its Retry delivers that turn; a letter with no recommended option
 *      tells the asker to ask him which.
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
// A switch to make a letter answer's delivery fail (the session queue refuses it), as a dead host does.
const failing = vi.hoisted(() => ({ on: false }))
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/session-message-queue.js')>()
  return {
    ...real,
    sendMessageToSession: ((...args: Parameters<typeof real.sendMessageToSession>) => failing.on && args[2]?.source === 'human-inbox'
      ? Promise.reject(new Error('test: the session queue refused it'))
      : real.sendMessageToSession(...args)) as typeof real.sendMessageToSession,
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { getLetter } from '../../src/core/human-inbox/store.js'
import { lettersAsThreadsNow } from '../../src/core/human-inbox/letter-threads.js'
import { oneCardNow } from '../../src/core/org/one-card.js'
import { letterThreadId } from '../../src/core/org/letter-thread-model.js'
import { WORDS_ANSWER_ASK_LINE, WORDS_ANSWER_LINE, humanReplyAndDeliver } from '../../src/core/human-inbox/letter-ops.js'
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
async function decide(subject: string, recommended = true): Promise<string> {
  const out = await op('human_inbox_send', {
    subject, type: 'action_required', markdown: `${subject} I recommend releasing it.`,
    actions: [{ id: 'release', label: 'Release it', ...(recommended ? { recommended: true } : {}) }, { id: 'hold', label: 'Not yet' }],
    user_kind: 'user_own', user_kind_why: 'It ships his own app to him',
  }, vp.sid)
  const id = out.letterId as string
  await vi.waitFor(async () => expect((await readThreads(vp.taskId)).threads.find((t) => t.id === letterThreadId(id))?.state).toBe('needs'), { timeout: 10_000, interval: 200 })
  return id
}

function rpc(method: string, payload: unknown, query = ''): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`)
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
  // Typed words answering a letter on its thread are the one-card experiment's (threads_one_card).
  expect((await api('PUT', '/api/config', { experimental: { letters_as_threads: true, threads_one_card: true } })).status).toBe(200)
  await vi.waitFor(() => expect(lettersAsThreadsNow() && oneCardNow()).toBe(true), { timeout: 5000 })
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

async function expectAnsweredByWords(letterId: string, words: string, before: number, line = WORDS_ANSWER_LINE): Promise<void> {
  // The letter reads answered in his words, and its thread leaves needs: his words make it the node's turn (working).
  await vi.waitFor(async () => {
    const l = await getLetter(letterId)
    expect(l?.thread?.some((t) => t.from === 'human' && t.text === words)).toBe(true)
  }, { timeout: 10_000, interval: 200 })
  await vi.waitFor(async () => expect((await readThreads(vp.taskId)).threads.find((t) => t.id === letterThreadId(letterId))?.state).toBe('working'), { timeout: 10_000, interval: 200 })
  // The session gets his words once, as the letter's answer, never also as a chat row.
  await vi.waitFor(() => expect(rowsSince(before).filter((m) => m.includes('[Letter reply]') && m.includes(words))).toHaveLength(1), { timeout: 15_000, interval: 200 })
  await new Promise((r) => setTimeout(r, 500))
  const rows = rowsSince(before)
  expect(rows.filter((m) => m.includes(words))).toHaveLength(1)
  expect(rows.find((m) => m.includes('[Letter reply]'))).toContain(line)
}

const letterRows = (before: number, words: string) => rowsSince(before).filter((m) => m.includes('[Letter reply]') && m.includes(words))
const humanTurns = async (letterId: string) => ((await getLetter(letterId))?.thread ?? []).filter((t) => t.from === 'human')

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
    // The phone's resend of the same qm- id (its 202 was lost) is the same answer: nothing queued again.
    const again = await api<{ answeredLetter?: { id: string }; messageId?: string }>('POST', `/sessions/${vp.sid}/messages`, { text: 'ok go', threadId: letterThreadId(letter), messageId: 'qm-letter-follow-1' })
    expect(again.status).toBe(202)
    expect(again.json).toMatchObject({ messageId: 'qm-letter-follow-1', answeredLetter: { id: letter } })
    await new Promise((r) => setTimeout(r, 800))
    expect(rowsSince(before).filter((m) => m.includes('ok go'))).toHaveLength(1)
    expect(await humanTurns(letter)).toHaveLength(1)
  })

  it('a send naming an ordinary thread stays a follow-up in the chat', async () => {
    const filed = await api<{ thread: { id: string } }>('POST', `/tasks/${vp.taskId}/threads`, { text: 'Plan the spring planting' })
    const before = queued.get(vp.sid)?.length ?? 0
    const r = await rpc('session:send', { sessionId: vp.sid, message: 'Start with the pears', threadId: filed.json.thread.id, userUuid: randomUUID() })
    expect(r.ok, r.error).toBe(true)
    expect(r.result?.answeredLetter).toBeUndefined()
    await vi.waitFor(() => expect(rowsSince(before).some((m) => m.includes('Start with the pears') && !m.includes('[Letter reply]'))).toBe(true), { timeout: 10_000, interval: 200 })
  })

  it('an agent answering for him with his "K" picks the recommended option only once his "K" is on that card', async () => {
    const letter = await decide('Release the new web build?')
    // A "K" the agent only quotes: not his words on record, so one letter is not enough.
    await expect(op('human_inbox_answer', { id: letter, action_id: 'release', user_words: 'K' }, vp.sid)).rejects.toThrow(/own words/)
    // His "K" on the card is on record now (the letter's own reply).
    await humanReplyAndDeliver(letter, { text: 'K', clientId: 'test-his-k' })
    // It picks the recommended option, and no other.
    await expect(op('human_inbox_answer', { id: letter, action_id: 'hold', user_words: 'K' }, vp.sid)).rejects.toThrow(/recommended/)
    await op('human_inbox_answer', { id: letter, action_id: 'release', user_words: 'K' }, vp.sid)
    await vi.waitFor(async () => expect((await getLetter(letter))?.answered?.actionId).toBe('release'), { timeout: 10_000, interval: 200 })
  })

  it('a browser under automation never answers a letter as him', async () => {
    const letter = await decide('Release the new tablet build?')
    const before = queued.get(vp.sid)?.length ?? 0
    const was = process.env.WALNUT_AUTOMATED_CLIENT_AGENT
    process.env.WALNUT_AUTOMATED_CLIENT_AGENT = '1'
    try {
      const r = await rpc('session:send', { sessionId: vp.sid, message: 'K from a robot', threadId: letterThreadId(letter), userUuid: randomUUID() }, '?automated=1')
      expect(r.ok, r.error).toBe(true)
      expect(r.result?.answeredLetter).toBeUndefined()
    } finally {
      if (was === undefined) delete process.env.WALNUT_AUTOMATED_CLIENT_AGENT; else process.env.WALNUT_AUTOMATED_CLIENT_AGENT = was
    }
    // Its words stay a follow-up in the chat; the letter still waits for him.
    await vi.waitFor(() => expect(rowsSince(before).some((m) => m.includes('K from a robot') && !m.includes('[Letter reply]'))).toBe(true), { timeout: 10_000, interval: 200 })
    expect(await humanTurns(letter)).toHaveLength(0)
    expect((await getLetter(letter))?.answered).toBeUndefined()
  })

  it('a Retry and a resend after a lost receipt answer once', async () => {
    const letter = await decide('Release the new watch build?')
    const before = queued.get(vp.sid)?.length ?? 0
    const userUuid = randomUUID()
    const first = await rpc('session:send', { sessionId: vp.sid, message: 'K', threadId: letterThreadId(letter), userUuid })
    expect(first.result?.answeredLetter).toMatchObject({ id: letter })
    await vi.waitFor(() => expect(letterRows(before, 'K')).toHaveLength(1), { timeout: 15_000, interval: 200 })
    // The web's Retry of that bubble (retryOf, the same uuid, the thread named again).
    const retry = await rpc('session:send', { sessionId: vp.sid, message: 'K', threadId: letterThreadId(letter), userUuid, retryOf: 'temp-1' })
    expect(retry.result?.answeredLetter).toMatchObject({ id: letter })
    // The web asking after a lost receipt: found by the uuid, never recorded again.
    const asked = await rpc('session:send', { sessionId: vp.sid, message: 'K', threadId: letterThreadId(letter), userUuid, confirmLetterAnswer: true })
    expect(asked.result?.answeredLetter).toMatchObject({ id: letter })
    const unknown = await rpc('session:send', { sessionId: vp.sid, message: 'K', threadId: letterThreadId(letter), userUuid: randomUUID(), confirmLetterAnswer: true })
    expect(unknown.result).toMatchObject({ notKept: true })
    await new Promise((r) => setTimeout(r, 800))
    expect(rowsSince(before).filter((m) => m.includes('K') && m.includes(letter))).toHaveLength(1)
    expect(await humanTurns(letter)).toHaveLength(1)
  })

  it('a letter answered in the inbox meanwhile leaves his words a plain follow-up', async () => {
    const letter = await decide('Release the new desktop build?')
    // The store's own check, under the letter's lock: an answered letter takes no words answer.
    expect((await api('POST', `/human-inbox/${letter}/answer`, { actionId: 'hold' })).status).toBeLessThan(300)
    await expect(humanReplyAndDeliver(letter, { text: 'K', clientId: 'test-late-k', whileWaiting: true })).rejects.toMatchObject({ code: 'already_answered' })
    const before = queued.get(vp.sid)?.length ?? 0
    const r = await rpc('session:send', { sessionId: vp.sid, message: 'K after hold', threadId: letterThreadId(letter), userUuid: randomUUID() })
    expect(r.ok, r.error).toBe(true)
    expect(r.result?.answeredLetter).toBeUndefined()
    await vi.waitFor(() => expect(rowsSince(before).some((m) => m.includes('K after hold'))).toBe(true), { timeout: 10_000, interval: 200 })
    const rows = rowsSince(before).filter((m) => m.includes('K after hold'))
    expect(rows.every((m) => !m.includes('[Letter reply]') && !m.includes(WORDS_ANSWER_LINE))).toBe(true)
  })

  it('a failed delivery comes back as an error, and its Retry delivers that turn once', async () => {
    const letter = await decide('Release the new server build?')
    const before = queued.get(vp.sid)?.length ?? 0
    const userUuid = randomUUID()
    failing.on = true
    let r: Awaited<ReturnType<typeof rpc>>
    try {
      r = await rpc('session:send', { sessionId: vp.sid, message: 'K', threadId: letterThreadId(letter), userUuid })
    } finally {
      failing.on = false
    }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/did not reach the task/)
    expect((await humanTurns(letter)).map((t) => t.delivery?.status)).toEqual(['failed'])
    const retry = await rpc('session:send', { sessionId: vp.sid, message: 'K', threadId: letterThreadId(letter), userUuid, retryOf: 'temp-2' })
    expect(retry.ok, retry.error).toBe(true)
    expect(retry.result?.answeredLetter).toMatchObject({ id: letter })
    await vi.waitFor(() => expect(rowsSince(before).filter((m) => m.includes('[Letter reply]') && m.includes(letter))).toHaveLength(1), { timeout: 15_000, interval: 200 })
    expect(await humanTurns(letter)).toHaveLength(1)
  })

  it('with no option recommended, the asker is told to ask him which', async () => {
    const letter = await decide('Release the new kiosk build?', false)
    const before = queued.get(vp.sid)?.length ?? 0
    const r = await rpc('session:send', { sessionId: vp.sid, message: 'K', threadId: letterThreadId(letter), userUuid: randomUUID() })
    expect(r.result?.answeredLetter).toMatchObject({ id: letter })
    await expectAnsweredByWords(letter, 'K', before, WORDS_ANSWER_ASK_LINE)
  })
})

describe('with the one-card setting off (threads_one_card), his words on it stay as before', () => {
  beforeAll(async () => {
    expect((await api('PUT', '/api/config', { experimental: { letters_as_threads: true, threads_one_card: false } })).status).toBe(200)
    await vi.waitFor(() => expect(oneCardNow()).toBe(false), { timeout: 5000 })
  })
  afterAll(async () => {
    await api('PUT', '/api/config', { experimental: { letters_as_threads: true, threads_one_card: true } })
  })

  it('a send naming the letter\'s thread is a follow-up in the chat, and the letter still waits', async () => {
    const letter = await decide('Move the garden shed to the north corner?')
    const before = queued.get(vp.sid)?.length ?? 0
    const r = await rpc('session:send', { sessionId: vp.sid, message: 'Sounds right to me', threadId: letterThreadId(letter), userUuid: randomUUID() })
    expect(r.ok, r.error).toBe(true)
    expect(r.result?.answeredLetter).toBeUndefined()
    await vi.waitFor(() => expect(rowsSince(before).some((m) => m.includes('Sounds right to me') && !m.includes('[Letter reply]'))).toBe(true), { timeout: 10_000, interval: 200 })
    expect(await humanTurns(letter)).toHaveLength(0)
    expect((await getLetter(letter))?.answered).toBeFalsy()
  })

  it('his "K" on the card is the strict old rule: no words line, and no agent picks for him with it', async () => {
    const letter = await decide('Paint the fence green this weekend?')
    const before = queued.get(vp.sid)?.length ?? 0
    await humanReplyAndDeliver(letter, { text: 'K', clientId: 'test-his-k-off' })
    await vi.waitFor(() => expect(letterRows(before, letter)).toHaveLength(1), { timeout: 15_000, interval: 200 })
    expect(letterRows(before, letter)[0]).not.toContain(WORDS_ANSWER_LINE)
    expect(letterRows(before, letter)[0]).not.toContain(WORDS_ANSWER_ASK_LINE)
    await expect(op('human_inbox_answer', { id: letter, action_id: 'release', user_words: 'K' }, vp.sid)).rejects.toThrow()
    expect((await getLetter(letter))?.answered).toBeFalsy()
  })

  it('the phone\'s thread list carries one_card only while the setting is on', async () => {
    const off = await api<{ threads: Array<Record<string, unknown>> }>('GET', `/tasks/${vp.taskId}/threads`)
    expect(off.status).toBe(200)
    expect(off.json.threads.length).toBeGreaterThan(0)
    expect(off.json.threads.every((t) => !('one_card' in t))).toBe(true)
    await api('PUT', '/api/config', { experimental: { letters_as_threads: true, threads_one_card: true } })
    await vi.waitFor(() => expect(oneCardNow()).toBe(true), { timeout: 5000 })
    const on = await api<{ threads: Array<Record<string, unknown>> }>('GET', `/tasks/${vp.taskId}/threads`)
    expect(on.json.threads.every((t) => t.one_card === true)).toBe(true)
  })
})
