/**
 * The inbox as every thread that needs him, on a real server (experiment inbox_needs_threads,
 * src/core/human-inbox/needs-threads.ts, GET /api/v1/inbox/needs, push/needs-push.ts).
 *
 *   Orchard VP (lead)          "Pick the trees" (Threads on)        "Mend the fence" (no Threads)
 *   a thread waiting on him    a decision letter, so a needs thread  an FYI letter
 *
 *   1. off: no threads listed; the count is the unread letters, as today; the decision letter
 *      buzzes as a letter;
 *   2. on: both needs threads, oldest first; the decision letter is held by its thread, so it is
 *      counted once (as the thread) and the FYI letter is the one letter counted;
 *   3. pinning the newer one moves it first;
 *   4. a new decision letter buzzes once, as its thread (type org_thread), never as a letter, and
 *      its thread's move into needs buzzes nothing more; a thread that only has news never buzzes;
 *   5. answering the letter (its own route) takes its thread off the list and the count;
 *   6. off again: no threads, the count is the unread letters again.
 *
 * What's real: server, bus, task store, inbox, threads store, letter threads, the push policy.
 * Mocked: constants, Apple's push service (what reaches it is what the phone would get).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('inbox-needs-threads-e2e', { IS_EPHEMERAL: true }))
const sendApns = vi.hoisted(() => vi.fn(async (targets: unknown[]) => ({ attempted: true, sent: targets.length, failed: 0, deadTokens: [] as string[] })))
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test' })),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { executeOp } from '../../src/ops/index.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { listLetters } from '../../src/core/human-inbox/store.js'
import { lettersAsThreadsNow } from '../../src/core/human-inbox/letter-threads.js'
import { letterThreadId } from '../../src/core/org/letter-thread-model.js'
import { log } from '../../src/logging/index.js'

let server: Server
let root = ''
const KIND = { user_kind: 'user_own', user_kind_why: 'He asked to choose the orchard trees himself' }
type Node = { id: string; sid: string }
let vp: Node
let trees: Node
let fence: Node
let prune: Node
/** Every `letter push` and `thread push` line (one per letter, one per move into needs). */
const lines: Array<{ msg: string; letterId?: string; threadId?: string; sent?: number; reason?: string; outcome?: string }> = []

interface NeedsBody {
  enabled: boolean
  threads: Array<{ id: string; title: string; state: string; node: { task_id: string; title: string }; urgency: { rank: number; why: string }; letter?: { id: string } }>
  held_letter_ids: string[]
  counts: { threads: number; letters: number; total: number }
}

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${root}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}
const needs = async () => {
  const r = await api<NeedsBody>('GET', '/inbox/needs')
  expect(r.status).toBe(200)
  return r.json
}
const unreadLetters = async () => (await listLetters({ archived: false })).unreadCount

async function flags(experimental: Record<string, boolean>): Promise<void> {
  expect((await api('PUT', '/api/config', { experimental })).status).toBe(200)
}

const op = async (node: Node, name: string, args: Record<string, unknown>) => {
  const out = await executeOp(name, args, { apiBase: root, origin: '__local__', callerMode: 'session', callerSid: node.sid })
  if (!out.ok) throw new Error(out.message)
  return out.result as Record<string, any>
}

async function decide(node: Node, subject: string): Promise<string> {
  const out = await op(node, 'human_inbox_send', {
    subject, type: 'action_required', markdown: `${subject} Both fit the orchard plan.`,
    actions: [{ id: 'apples', label: 'Apples', recommended: true }, { id: 'pears', label: 'Pears' }], ...KIND,
  })
  expect(out.letterId).toMatch(/^lt-/)
  return out.letterId as string
}

/** The letter's thread, once letters_as_threads opened it on the sender's Threads. */
async function letterThread(node: Node, letterId: string): Promise<string> {
  const id = letterThreadId(letterId)
  await vi.waitFor(async () => expect((await readThreads(node.id)).threads.find((t) => t.id === id)?.state).toBe('needs'), { timeout: 10_000, interval: 50 })
  return id
}

const line = (msg: string, pick: (l: (typeof lines)[number]) => boolean) =>
  vi.waitFor(() => { const hit = lines.find((l) => l.msg === msg && pick(l)); expect(hit).toBeTruthy(); return hit! }, { timeout: 10_000, interval: 25 })
const payloads = () => sendApns.mock.calls.map((c) => (c as unknown as [unknown, Record<string, unknown>])[1])

let nodeThread = ''
let early = ''
let earlyThread = ''

beforeAll(async () => {
  for (const level of ['info', 'warn', 'error'] as const) {
    const orig = log.notif[level].bind(log.notif)
    vi.spyOn(log.notif, level).mockImplementation(((msg: string, fields?: Record<string, unknown>) => {
      if (msg === 'letter push' || msg === 'thread push') lines.push({ msg, ...(fields as object) })
      return orig(msg, fields as never)
    }) as never)
  }
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await updateConfig({ push_tokens: [{ token: 'b'.repeat(64), platform: 'ios' }] } as never)
  await flags({ letters_as_threads: true, inbox_needs_threads: false })
  await vi.waitFor(() => expect(lettersAsThreadsNow()).toBe(true), { timeout: 5000 })
  const lead = (await addTask({ title: 'Orchard VP', project: 'Orchard', source: 'local', org_role: 'lead' } as never)).task
  const treesTask = (await addTask({ title: 'Pick the trees', project: 'Grove', source: 'local' })).task
  const fenceTask = (await addTask({ title: 'Mend the fence', project: 'Yard', source: 'local' })).task
  const pruneTask = (await addTask({ title: 'Prune the rows', project: 'Rows', source: 'local' })).task
  await updateTaskRaw(treesTask.id, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  await updateTaskRaw(pruneTask.id, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  vp = { id: lead.id, sid: 'inbox-needs-vp' }
  trees = { id: treesTask.id, sid: 'inbox-needs-trees' }
  fence = { id: fenceTask.id, sid: 'inbox-needs-fence' }
  prune = { id: pruneTask.id, sid: 'inbox-needs-prune' }
  await createSessionRecord(vp.sid, vp.id, 'Orchard')
  await createSessionRecord(trees.sid, trees.id, 'Grove')
  await createSessionRecord(fence.sid, fence.id, 'Yard')
  await createSessionRecord(prune.sid, prune.id, 'Rows')
}, 60_000)

afterAll(async () => {
  vi.restoreAllMocks()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('the inbox lists every thread that needs him', () => {
  it('off: nothing listed, the count is the unread letters, and a decision letter buzzes as a letter', async () => {
    const opened = await op(vp, 'thread_create', {
      title: 'Open the orchard to visitors?', text: 'The paths are dry now.', from: 'node',
      options: [{ label: 'Open it', recommended: true }, { label: 'Keep it closed' }], ...KIND,
    })
    nodeThread = opened.thread?.id ?? opened.id
    early = await decide(trees, 'Plant apples or pears along the fence?')
    earlyThread = await letterThread(trees, early)
    const fyi = await op(fence, 'human_inbox_send', { subject: 'The fence posts arrived', type: 'info', markdown: 'Twelve posts, all straight.' })
    expect(fyi.letterId).toMatch(/^lt-/)

    expect(await line('letter push', (l) => l.letterId === early)).toMatchObject({ sent: 1 })
    expect(payloads().some((p) => p.type === 'human_inbox_letter' && p.letterId === early)).toBe(true)
    const off = await needs()
    expect(off).toMatchObject({ enabled: false, threads: [], held_letter_ids: [] })
    const unread = await unreadLetters()
    expect(off.counts).toEqual({ threads: 0, letters: unread, total: unread })
  })

  it('on: both needs threads, the longest waiting first; the held letter counts once, as its thread', async () => {
    await flags({ inbox_needs_threads: true })
    const on = await needs()
    expect(on.enabled).toBe(true)
    expect(on.threads.map((t) => t.id)).toEqual([nodeThread, earlyThread])
    expect(on.threads.map((t) => t.node.task_id)).toEqual([vp.id, trees.id])
    expect(on.threads[1].letter?.id).toBe(early)
    expect(on.threads.every((t) => t.state === 'needs' && t.urgency.why === 'waiting')).toBe(true)
    expect(on.held_letter_ids).toEqual([early])
    const unread = await unreadLetters()
    // The decision letter is one of the unread letters, and it is the second thread: counted once.
    expect(on.counts).toEqual({ threads: 2, letters: unread - 1, total: unread + 1 })
  })

  it('pinning the newer thread moves it first', async () => {
    expect((await api('PATCH', `/tasks/${trees.id}/threads/${earlyThread}`, { pin: true })).status).toBe(200)
    const pinned = await needs()
    expect(pinned.threads.map((t) => t.id)).toEqual([earlyThread, nodeThread])
    expect(pinned.threads[0].urgency).toMatchObject({ rank: 0, why: 'pinned' })
  })

  it('a new decision buzzes once, as its thread; its thread\'s move into needs and a thread with news buzz nothing', async () => {
    const before = sendApns.mock.calls.length
    // Another task: an unread decision of the same absence keeps the next one quiet (away-thread.ts), as before.
    const fresh = await decide(prune, 'Water the saplings at dawn or at dusk?')
    const freshThread = letterThreadId(fresh)
    expect(await line('letter push', (l) => l.letterId === fresh)).toMatchObject({ outcome: 'as_thread', threadId: freshThread, sent: 1 })
    await letterThread(prune, fresh)
    // Its thread holds the letter: its move into needs never buzzes (threads-store.ts mutateThreads).
    expect(lines.some((l) => l.msg === 'thread push' && l.threadId === freshThread)).toBe(false)
    const sent = payloads().slice(before)
    expect(sent.filter((p) => p.threadId === freshThread)).toEqual([expect.objectContaining({ type: 'org_thread', taskId: prune.id, threadId: freshThread })])
    // The banner reads as the letter's would: who it is from first, then its subject and its preview.
    const alert = (sent.find((p) => p.threadId === freshThread) as { aps: { alert: { title: string; body: string } } }).aps.alert
    expect(alert.title).toContain('Prune the rows')
    expect(alert.body).toMatch(/^Water the saplings at dawn or at dusk\?\n\S/)
    expect(sent.some((p) => p.letterId === fresh)).toBe(false)

    // News only: an answered thread, and an update the task files on its thread instead of a letter.
    const news = await op(vp, 'thread_create', { title: 'The visitor count', text: 'Forty came on Sunday.', from: 'node', state: 'answered' })
    const newsId = news.thread?.id ?? news.id
    const filed = await op(trees, 'human_inbox_send', { subject: 'The saplings are in', type: 'info', markdown: 'All twelve planted.' })
    expect(filed.letterId).toBeUndefined()
    expect((await needs()).threads.map((t) => t.id)).toEqual([earlyThread, nodeThread, freshThread])
    expect(lines.some((l) => l.threadId === newsId)).toBe(false)
    expect(payloads().slice(before)).toHaveLength(1)
  })

  it('an answer through the letter\'s own route takes its thread off the list and the count', async () => {
    const was = await needs()
    expect((await api('POST', `/human-inbox/${early}/answer`, { actionId: 'pears' })).status).toBeLessThan(300)
    await vi.waitFor(async () => expect((await needs()).threads.map((t) => t.id)).not.toContain(earlyThread), { timeout: 10_000, interval: 50 })
    const now = await needs()
    expect(now.held_letter_ids).not.toContain(early)
    expect(now.threads.map((t) => t.id)).toEqual(was.threads.map((t) => t.id).filter((id) => id !== earlyThread))
    expect(now.counts.threads).toBe(was.counts.threads - 1)
    expect(now.counts.total).toBe(now.counts.threads + now.counts.letters)
  })

  it('off again: no threads, and the count is the unread letters again', async () => {
    await flags({ inbox_needs_threads: false })
    const off = await needs()
    expect(off).toMatchObject({ enabled: false, threads: [], held_letter_ids: [] })
    const unread = await unreadLetters()
    expect(off.counts).toEqual({ threads: 0, letters: unread, total: unread })
  })
})
