/**
 * The Brief off, on a real server (experiment brief_off, src/core/org/brief-off.ts and
 * src/core/boards/choice-threads.ts; step 5 of "Only Threads").
 *
 *   Garden VP (lead, keeps a Board)   "Plant the beds" (its worker)
 *
 *   1. off: brief_write writes; a Board choice about the worker makes the worker read Needs you
 *      (source choice) and opens no thread; the lead's prompt keeps the Brief rules;
 *   2. on: the choice waits on the lead's Threads as one needs thread with its options and
 *      recommended one, the worker no longer reads Needs you from it, and the thread-states route
 *      gives the lead `needs`; the lead's prompt drops the Brief rules and is not longer than before;
 *   3. his answer from the thread card (the Board's own choice route) answers the choice, the lead's
 *      session hears it as a Board answer, and the thread closes as known;
 *   4. an answer on the Board for him by an agent settles a second choice's thread as news;
 *   5. brief_write answers the off note and writes nothing; brief_read still reads the old letter,
 *      and a person's client gets none;
 *   6. off again: an open choice thread is set aside and the choice counts on its task again.
 *
 * What's real: server, bus, task store, Boards, threads store, the queue, the session runner, the
 * status sync, the ops. Mocked: constants, the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-brief-off'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { readThreads, writeThreadsFor } from '../../src/core/org/threads-store.js'
import { syncAllChoiceThreads, syncBoardChoiceThreads } from '../../src/core/boards/choice-threads.js'
import { getBoard, setBoardHtml } from '../../src/core/boards/board-store.js'
import { choiceThreadId } from '../../src/core/org/choice-thread-model.js'
import { briefOffNow } from '../../src/core/org/brief-off.js'
import { orgRoleLine } from '../../src/core/sessions/session-context.js'
import { executeOp } from '../../src/ops/index.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'

let server: Server
let daemon: MockDaemon
let port = 0
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
let leadId = ''
let leadSid = ''
let bedsId = ''
const queued = new Map<string, string[]>()

async function startSessionFor(taskId: string, project: string): Promise<string> {
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project, preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
  return sid
}

async function api<T = Record<string, any>>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

async function flag(on: boolean): Promise<void> {
  expect((await api('PUT', '/api/config', { experimental: { brief_off: on } })).status).toBe(200)
  await vi.waitFor(() => expect(briefOffNow()).toBe(on), { timeout: 5000 })
}

const op = async (name: string, args: Record<string, unknown>, sid: string) => {
  const out = await executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: '__local__', callerMode: 'session', callerSid: sid })
  if (!out.ok) throw new Error(out.message)
  return out as { ok: true; result: Record<string, any>; message?: string; next?: string } & Record<string, any>
}

async function statusOf(taskId: string) {
  await settleUserStatusSync()
  await syncUserStatuses(new Set([taskId]))
  return (await getTask(taskId)).user_status
}

function rpc(method: string, payload: unknown): Promise<{ ok: boolean; result?: Record<string, any>; error?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const id = `t-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => { ws.close(); reject(new Error(`rpc ${method} timed out`)) }, 20_000)
    ws.once('error', reject)
    ws.on('message', (raw: Buffer | string) => {
      const frame = JSON.parse(raw.toString()) as { type: string; id?: string; ok?: boolean; error?: string; payload?: Record<string, any>; result?: Record<string, any> }
      if (frame.type !== 'res' || frame.id !== id) return
      clearTimeout(timer)
      ws.close()
      resolve({ ok: !!frame.ok, result: frame.payload ?? frame.result, error: frame.error })
    })
    ws.once('open', () => ws.send(JSON.stringify({ type: 'req', id, method, payload })))
  })
}

/** The lead's Board file on disk (board-store.ts keeps one JSON per task). */
async function boardPath(): Promise<string> {
  const names = await fs.readdir(WALNUT_HOME, { recursive: true }) as string[]
  const hit = names.find((n) => n.endsWith(`${path.sep}${leadId}.json`) && n.includes('board'))
  if (!hit) throw new Error('no board file')
  return path.join(WALNUT_HOME, hit)
}

const choiceHtml = (...choices: string[]) => `<html><body><h1>Garden</h1>${choices.join('')}</body></html>`
const plantWhen = () => `<walnut-choice id="plant-when" title="Plant the beds this week or next?" options="now:This week,later:Next week" recommended="later" task="${bedsId}"></walnut-choice>`
const waterHow = () => `<walnut-choice id="water-how" title="Drip or sprinkler for the beds?" options="drip:Drip,spray:Sprinkler" task="${bedsId}"></walnut-choice>`
const threadOn = async (choice: string) => (await readThreads(leadId)).threads.find((t) => t.id === choiceThreadId(leadId, choice))

const BRIEF = '### Needs you\n- Nothing\n\n### Working\n- The beds are being dug\n\n### Waiting\n- Nothing'

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await ensureMainTask()
  const lead = await ensureProjectLead('Garden')
  leadId = lead.id
  bedsId = (await addTask({ title: 'Plant the beds', project: 'Garden', parent_task_id: leadId })).task.id
  await updateTaskRaw(bedsId, { phase: 'NEED_ACTION' } as never, { emitEvent: true })
  leadSid = await startSessionFor(leadId, 'Garden')
  bus.subscribe('test-brief-off', (event) => {
    const d = event.data as { sessionId: string; message?: string }
    queued.set(d.sessionId, [...(queued.get(d.sessionId) ?? []), d.message ?? ''])
  }, { global: true, interest: [EventNames.SESSION_MESSAGE_QUEUED] })
}, 150_000)

afterAll(async () => {
  bus.unsubscribe('test-brief-off')
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the Brief off', () => {
  let offPrompt = ''

  it('off: the Brief is written, a Board choice is its task\'s Needs you and no thread, the prompt keeps the Brief', async () => {
    await flag(false)
    const wrote = await op('brief_write', { content: BRIEF }, leadSid)
    expect(wrote.result.off).toBeUndefined()
    expect((await getTask(leadId)).brief?.text).toContain('The beds are being dug')
    await setBoardHtml(leadId, choiceHtml(plantWhen()), { by: `task:${leadId}` })
    await vi.waitFor(async () => expect(await statusOf(bedsId)).toMatchObject({ state: 'needs', source: 'choice', ask: 'Plant the beds this week or next?' }), { timeout: 20_000 })
    expect(await threadOn('plant-when')).toBeUndefined()
    offPrompt = orgRoleLine(await getTask(leadId))
    expect(offPrompt).toContain('brief_write')
  }, 60_000)

  it('on: the choice waits on the lead\'s Threads, once, and its task no longer reads it as Needs you', async () => {
    await flag(true)
    await vi.waitFor(async () => expect(await threadOn('plant-when')).toBeTruthy(), { timeout: 20_000 })
    const t = (await threadOn('plant-when'))!
    expect(t).toMatchObject({
      state: 'needs', title: 'Plant the beds this week or next?', tasks: [bedsId],
      choice: { board: leadId, id: 'plant-when', task: bedsId, recommended: 'later', options: [{ value: 'now', label: 'This week' }, { value: 'later', label: 'Next week' }] },
    })
    // A second sync (a page write that keeps the choice) makes no second thread.
    await setBoardHtml(leadId, choiceHtml(plantWhen(), waterHow()), { by: `task:${leadId}` })
    await vi.waitFor(async () => expect(await threadOn('water-how')).toBeTruthy(), { timeout: 20_000 })
    expect((await readThreads(leadId)).threads.filter((x) => x.choice?.id === 'plant-when')).toHaveLength(1)
    await vi.waitFor(async () => expect((await statusOf(bedsId))?.source).not.toBe('choice'), { timeout: 20_000 })
    // The lead's card on a Board reads Needs you from its threads.
    const states = await api('GET', `/thread-states?ids=${leadId},${bedsId},../etc`)
    expect(states.json).toMatchObject({ on: true, states: { [leadId]: { state: 'needs' } } })
    expect(states.json.states[bedsId]).toBeUndefined()
    // The prompt drops the Brief rules, keeps the memory rule, and costs no more than before.
    const onPrompt = orgRoleLine(await getTask(leadId))
    expect(onPrompt).not.toContain('brief_write')
    expect(onPrompt).toContain('MEMORY.md')
    expect(onPrompt.length).toBeLessThan(offPrompt.length)
  }, 60_000)

  it('his answer from the thread card answers the choice, the lead hears it, the thread closes as known', async () => {
    const before = queued.get(leadSid)?.length ?? 0
    const r = await api('PUT', `/tasks/${leadId}/board/choices/plant-when`, { option: 'later' })
    expect(r.status).toBe(200)
    expect(r.json.choice).toMatchObject({ option: 'later' })
    const t = (await threadOn('plant-when'))!
    expect(t).toMatchObject({ state: 'answered', reply: 'You answered: Next week', closed: { how: 'acked', by: 'human' }, choice: { done: true } })
    await vi.waitFor(() => expect((queued.get(leadSid) ?? []).slice(before).join('\n')).toContain('On your Board'), { timeout: 20_000 })
    expect((await getTask(bedsId)).user_status?.source).not.toBe('choice')
  }, 60_000)

  it('an agent\'s answer for him on the Board settles the other thread as news', async () => {
    const r = await api('PUT', `/tasks/${leadId}/board/choices/water-how`, { option: 'drip', override_user: true }, { 'x-walnut-caller-sid': leadSid })
    expect(r.status).toBe(200)
    await vi.waitFor(async () => expect((await threadOn('water-how'))?.state).toBe('answered'), { timeout: 20_000 })
    const t = (await threadOn('water-how'))!
    expect(t.closed).toBeUndefined()
    expect(t.reply).toMatch(/^Answered for you by .*: Drip$/)
  }, 60_000)

  it('brief_write answers the off note and writes nothing; brief_read still reads; a person\'s client gets none', async () => {
    const wrote = await op('brief_write', { content: BRIEF.replace('dug', 'watered') }, leadSid)
    expect(wrote.result).toMatchObject({ off: true, written: false })
    expect(wrote.result.note).toContain('thread_update')
    expect((await getTask(leadId)).brief?.text).toContain('The beds are being dug')
    const read = await op('brief_read', {}, leadSid)
    expect(read.result).toMatchObject({ off: true })
    expect(read.result.brief.text).toContain('The beds are being dug')
    const person = await api('GET', `/tasks/${leadId}/brief`)
    expect(person.json).toMatchObject({ off: true, brief: null })
    const put = await api('PUT', `/tasks/${leadId}/brief`, { content: BRIEF })
    expect(put.status).toBe(200)
    expect(put.json).toMatchObject({ off: true, written: false })
  }, 60_000)

  it('off again: an open choice thread is set aside and the choice counts on its task again', async () => {
    await setBoardHtml(leadId, choiceHtml(plantWhen(), waterHow(), `<walnut-choice id="fence-wood" title="Cedar or pine for the fence?" options="cedar:Cedar,pine:Pine" task="${bedsId}"></walnut-choice>`), { by: `task:${leadId}` })
    await vi.waitFor(async () => expect((await threadOn('fence-wood'))?.state).toBe('needs'), { timeout: 20_000 })
    await flag(false)
    await vi.waitFor(async () => expect((await threadOn('fence-wood'))?.choice?.off).toBe(true), { timeout: 20_000 })
    expect((await threadOn('fence-wood'))?.closed).toBeTruthy()
    await vi.waitFor(async () => expect(await statusOf(bedsId)).toMatchObject({ state: 'needs', source: 'choice', ask: 'Cedar or pine for the fence?' }), { timeout: 20_000 })
    expect((await api('GET', `/thread-states?ids=${leadId}`)).json).toEqual({ on: false, states: {} })
    // Off, the Brief is written again, as before.
    expect((await op('brief_write', { content: BRIEF.replace('dug', 'mulched') }, leadSid)).result.off).toBeUndefined()
    expect((await getTask(leadId)).brief?.text).toContain('mulched')
  }, 60_000)

  it('a choice thread deleted a week after it closed is never opened again; one set aside and deleted opens once', async () => {
    // The sweep deletes a closed thread after its week (threads-model.ts prune): as it would, here.
    const prune = (id: string) => writeThreadsFor(leadId, (cur) => ({ file: { ...cur, threads: cur.threads.filter((t) => t.id !== id) }, out: true }))
    const fence = choiceThreadId(leadId, 'fence-wood')
    // Set aside while off (the last step), then deleted: on again opens it once.
    await prune(fence)
    await flag(true)
    await vi.waitFor(async () => expect((await threadOn('fence-wood'))?.state).toBe('needs'), { timeout: 20_000 })
    expect(await syncAllChoiceThreads()).toMatchObject({ opened: 0 })
    // He closes it without answering the choice; a week later it is deleted; nothing opens it again.
    expect((await api('PATCH', `/tasks/${leadId}/threads/${fence}`, { close: 'dropped' })).status).toBe(200)
    await prune(fence)
    expect(await syncAllChoiceThreads()).toMatchObject({ opened: 0 })
    expect(await syncBoardChoiceThreads(leadId)).toMatchObject({ opened: 0 })
    expect(await threadOn('fence-wood')).toBeUndefined()
  }, 60_000)

  it('his words typed on a choice thread answer the choice, on the console and the phone; a bare yes picks only the recommended one', async () => {
    const pathStone = '<walnut-choice id="path-stone" title="Gravel or flagstone for the path?" options="gravel:Gravel,flag:Flagstone" recommended="flag"></walnut-choice>'
    const gateColor = '<walnut-choice id="gate-color" title="Paint the gate green or blue?" options="green:Green,blue:Blue"></walnut-choice>'
    const benchWood = '<walnut-choice id="bench-wood" title="Oak or teak for the bench?" options="oak:Oak,teak:Teak"></walnut-choice>'
    await setBoardHtml(leadId, choiceHtml(plantWhen(), waterHow(), pathStone, gateColor, benchWood), { by: `task:${leadId}` })
    for (const c of ['path-stone', 'gate-color', 'bench-wood']) await vi.waitFor(async () => expect((await threadOn(c))?.state).toBe('needs'), { timeout: 20_000 })
    // The console (session:send naming the thread): "K" picks the recommended option.
    const k = await rpc('session:send', { sessionId: leadSid, message: 'K', threadId: choiceThreadId(leadId, 'path-stone'), userUuid: randomUUID() })
    expect(k.ok).toBe(true)
    expect(k.result?.answeredChoice).toMatchObject({ board: leadId, id: 'path-stone', threadId: choiceThreadId(leadId, 'path-stone') })
    expect((await getBoard(leadId))?.choices?.['path-stone']).toMatchObject({ option: 'flag' })
    expect(await threadOn('path-stone')).toMatchObject({ closed: { how: 'acked', by: 'human' }, choice: { done: true } })
    // The phone (POST /sessions/:id/messages with threadId): the words name an option.
    const phone = await api('POST', `/sessions/${leadSid}/messages`, { text: 'Blue', threadId: choiceThreadId(leadId, 'gate-color'), messageId: 'qm-choice-gate-1' })
    expect(phone.status).toBe(202)
    expect(phone.json.answeredChoice).toMatchObject({ id: 'gate-color' })
    expect((await getBoard(leadId))?.choices?.['gate-color']).toMatchObject({ option: 'blue' })
    // A bare yes on a choice that recommends nothing answers nothing: it stays a follow-up.
    const yes = await rpc('session:send', { sessionId: leadSid, message: 'ok', threadId: choiceThreadId(leadId, 'bench-wood'), userUuid: randomUUID() })
    expect(yes.ok).toBe(true)
    expect(yes.result?.answeredChoice).toBeUndefined()
    expect((await getBoard(leadId))?.choices?.['bench-wood']).toBeUndefined()
    expect((await threadOn('bench-wood'))?.choice?.done).toBeUndefined()
  }, 60_000)

  it('a Board Walnut cannot read settles none of its choice threads', async () => {
    const hedge = '<walnut-choice id="hedge-trim" title="Trim the hedge in spring or in fall?" options="spring:Spring,fall:Fall"></walnut-choice>'
    await setBoardHtml(leadId, choiceHtml(plantWhen(), waterHow(), hedge), { by: `task:${leadId}` })
    await vi.waitFor(async () => expect((await threadOn('hedge-trim'))?.state).toBe('needs'), { timeout: 20_000 })
    const file = await boardPath()
    const good = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, '{ "html": "<walnut-cho')
    try {
      expect(await syncBoardChoiceThreads(leadId)).toEqual({ opened: 0, settled: 0 })
      expect(await threadOn('hedge-trim')).toMatchObject({ state: 'needs' })
      expect((await threadOn('hedge-trim'))?.closed).toBeUndefined()
    } finally {
      await fs.writeFile(file, good)
    }
    // Read again, the Board still asks it: the thread still waits.
    await syncBoardChoiceThreads(leadId)
    expect(await threadOn('hedge-trim')).toMatchObject({ state: 'needs' })
  }, 60_000)
})
