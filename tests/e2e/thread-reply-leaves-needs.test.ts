/**
 * His reply on a card takes it out of Needs you at once, by every way he replies, before the task
 * reads it (2026-11-20, the user, on a task's card at its leader that stayed in Needs you after he
 * answered in its box: "why this even keep showing after I replied?"). The card leaves Needs you
 * for the task's move (Working) and comes back only when the task asks again.
 *
 *   Orchard VP ─ "Plan the orchard" (lead of the card, Threads on) ─ "Order the seed trays" (owner)
 *   Garden VP (a moved thread's new holder)
 *
 * Every path the server knows that files a person's reply on a thread is listed in PATHS, by the
 * call that files it (replyOnThread, fileThreadMessage, answerLetterOnThread, answerChoiceOnThread);
 * the guard at the end fails when a new call appears without a case here (or a named test of it).
 * Each case replies on a thread in needs and reads the leader's Threads the way the web does (GET
 * .../threads, then the web's group rule) right after, while the owner has not read the reply.
 *
 * What's real: server, bus, task store, threads store, the queue, the session runner. Mocked:
 * constants, the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-reply-leaves-needs'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { openNodeThread, readThreads, updateReplyDeliveries } from '../../src/core/org/threads-store.js'
import { sweepThreadReplies } from '../../src/core/org/thread-reply.js'
import { deleteMessage, enqueueMessage, findQueuedMessage, getQueue, markProcessing, removeProcessed, unparkMessage } from '../../src/core/session-message-queue.js'
import { threadsPopUpNow } from '../../src/core/org/thread-popup.js'
import { oneCardNow } from '../../src/core/org/one-card.js'
import { listedForHim } from '../../src/core/org/thread-view.js'
import { threadGroupOf } from '../../src/core/org/thread-groups.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
let server: Server
let daemon: MockDaemon
let port: number
type Node = { taskId: string; sid: string }
let plan: Node
let trays: Node
let garden: Node

/**
 * Each call that files a person's reply on a thread, by file, and the case that replies through it.
 * A case named with a path is covered by that test file (it asserts the thread leaves needs).
 */
const PATHS: Record<string, string> = {
  'src/web/routes/org-threads-v1.ts replyOnThread': 'card box on a thread below (web card, choice button, top card)',
  'src/web/routes/org-threads-v1.ts fileThreadMessage': 'card box on a thread of its own',
  'src/core/org/thread-reply.ts fileThreadMessage': 'card box on a thread below (web card, choice button, top card)',
  'src/core/org/thread-capture.ts replyOnThread': 'chat Follow up naming a thread below (quick bar, an older phone)',
  'src/core/org/thread-capture.ts fileThreadMessage': 'chat Follow up naming a thread of its own',
  'src/core/org/thread-follow.ts fileThreadMessage': 'chat Follow up naming a thread that moved on',
  'src/core/org/threads-store.ts fileThreadMessage': 'chat Follow up naming a thread that moved on',
  'src/web/routes/session-chat.ts answerLetterOnThread': 'tests/e2e/letter-thread-follow-up.test.ts',
  'src/web/routes/session-send-v1.ts answerLetterOnThread': 'tests/e2e/letter-thread-follow-up.test.ts',
  'src/web/routes/session-chat.ts answerChoiceOnThread': 'tests/e2e/brief-off.test.ts',
  'src/web/routes/session-send-v1.ts answerChoiceOnThread': 'tests/e2e/brief-off.test.ts',
}
const covered = new Set<string>()

async function startSessionFor(taskId: string, project: string): Promise<string> {
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project, preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/), { timeout: 20_000 })
  return sid
}

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown, callerSid?: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method, headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

type Listed = OrgThread & { owner?: { task_id: string }; heldAsk?: { id: string } }
async function listOf(taskId: string): Promise<Listed[]> {
  const r = await api<{ threads: Listed[] }>('GET', `/tasks/${taskId}/threads`)
  expect(r.status).toBe(200)
  return r.json.threads
}

/** The group the web draws a thread in on this node's Threads (OrgThreadsByState), or null when not listed. */
async function groupAt(viewer: string, id: string): Promise<{ state: string; group: string; held: boolean; closed: boolean } | null> {
  const threads = await listOf(viewer)
  const t = threads.find((x) => x.id === id)
  if (!t) return null
  return { state: t.state, group: threadGroupOf(t, listedForHim(threads).includes(t)), held: !!t.heldAsk, closed: !!t.closed }
}

const ask = (taskId: string, title: string) => openNodeThread(taskId, {
  title, text: `${title} Either fits the orchard budget.`, from: 'task', state: 'needs', user_kind: 'spending', user_kind_why: 'It buys orchard supplies with real money',
}, `task:${taskId}`)

/** Waits on him at `viewer` before the reply: in Needs you there. */
async function inNeeds(viewer: string, id: string): Promise<void> {
  await vi.waitFor(async () => expect(await groupAt(viewer, id)).toMatchObject({ group: 'needs' }), { timeout: 10_000, interval: 200 })
}

/** Right after his reply: out of Needs you at `viewer` (listed as the task's move, or gone), his words on the record. */
async function leftNeeds(viewer: string, holder: string, id: string, words: string, path: string): Promise<void> {
  await vi.waitFor(async () => {
    expect((await readThreads(holder)).threads.find((t) => t.id === id)?.messages.map((m) => m.text)).toContain(words)
  }, { timeout: 10_000, interval: 100 })
  const g = await groupAt(viewer, id)
  if (g) {
    // A pointer a moved thread left behind is closed here (Done): its stored state is history.
    if (!g.closed) expect(g.state).not.toBe('needs')
    expect(g.group).not.toBe('needs')
    expect(g.held).toBe(false)
  }
  covered.add(path)
}

/** The owner has not read it: his reply is still on its way (the wake waits WALNUT_THREAD_REPLY_GATHER_MS). */
async function unread(owner: string, id: string, words: string): Promise<void> {
  const m = (await readThreads(owner)).threads.find((t) => t.id === id)?.messages.find((x) => x.text === words)
  expect(m?.delivery?.state).toBe('pending')
}

beforeAll(async () => {
  process.env.WALNUT_THREAD_FOLLOW = '0'
  // Replies below stay on their way for the whole file: every read is "before the task reads it".
  process.env.WALNUT_THREAD_REPLY_GATHER_MS = '600000'
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  expect((await api('PUT', '/api/config', { experimental: { threads_pop_up: true, threads_one_card: true } })).status).toBe(200)
  await vi.waitFor(() => expect(threadsPopUpNow() && oneCardNow()).toBe(true), { timeout: 5000 })
  await ensureMainTask()
  const vpTask = await ensureProjectLead('Orchard')
  const gardenTask = await ensureProjectLead('Garden')
  const planId = (await addTask({ title: 'Plan the orchard', project: 'Orchard', parent_task_id: vpTask.id })).task.id
  const traysId = (await addTask({ title: 'Order the seed trays', project: 'Orchard', parent_task_id: planId })).task.id
  for (const id of [planId, traysId]) await updateTaskRaw(id, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  plan = { taskId: planId, sid: await startSessionFor(planId, 'Orchard') }
  trays = { taskId: traysId, sid: await startSessionFor(traysId, 'Orchard') }
  garden = { taskId: gardenTask.id, sid: await startSessionFor(gardenTask.id, 'Garden') }
}, 150_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  delete process.env.WALNUT_THREAD_FOLLOW
  delete process.env.WALNUT_THREAD_REPLY_GATHER_MS
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('his reply takes the card out of Needs you at once', () => {
  // First: the task's ask goes on its only open thread (thread-report-ask.ts askThreadFor).
  it('card box on a thread below holding the task\'s own ask (the 2026-11-20 card)', async () => {
    const t = await openNodeThread(trays.taskId, { title: 'Slack notes for the orchard manager', text: 'The first note is short now.', from: 'task', state: 'answered' }, `task:${trays.taskId}`)
    const at = new Date().toISOString()
    await updateTaskRaw(trays.taskId, {
      phase: 'NEED_ACTION', phase_changed_at: at,
      status_report: { state: 'needs', ask: 'Delete the two long notes too?', ask_id: 'ask-trays01', at, turn_ended_at: at, session_id: trays.sid },
    } as never, { source: 'test' })
    await settleUserStatusSync()
    await syncUserStatuses(new Set([trays.taskId]))
    await vi.waitFor(async () => expect((await listOf(trays.taskId)).find((x) => x.id === t.id)).toMatchObject({ state: 'needs', heldAsk: { id: 'ask-trays01' } }), { timeout: 10_000, interval: 200 })
    const words = 'Delete them, just do it'
    expect((await api('POST', `/tasks/${plan.taskId}/threads`, { text: words, thread: t.id })).status).toBe(200)
    await leftNeeds(plan.taskId, trays.taskId, t.id, words, 'card box on a thread below (web card, choice button, top card)')
    expect(await groupAt(plan.taskId, t.id)).toMatchObject({ group: 'working', held: false })
    // The owner's own Threads read it as stored too: no second Needs you for it while the task reads him.
    expect((await listOf(trays.taskId)).find((x) => x.id === t.id)).toMatchObject({ state: 'working' })
    await unread(trays.taskId, t.id, words)
  })

  it('card box on a thread below: a thread in needs', async () => {
    const t = await ask(trays.taskId, 'Buy the 72-cell trays or the 128-cell ones?')
    await inNeeds(plan.taskId, t.id)
    const words = 'The 72-cell ones, two boxes'
    expect((await api('POST', `/tasks/${plan.taskId}/threads`, { text: words, thread: t.id })).status).toBe(200)
    await leftNeeds(plan.taskId, trays.taskId, t.id, words, 'card box on a thread below (web card, choice button, top card)')
    // Listed as the task's move while his reply is on its way, his words with it (ThreadSentWords).
    expect(await groupAt(plan.taskId, t.id)).toMatchObject({ state: 'working', group: 'working' })
    await unread(trays.taskId, t.id, words)
  })

  it('chat Follow up naming a thread below (quick bar, an older phone)', async () => {
    const t = await ask(trays.taskId, 'Ship the trays to the barn or the shed?')
    await inNeeds(plan.taskId, t.id)
    const words = 'To the barn'
    expect((await api('POST', `/sessions/${plan.sid}/messages`, { text: words, threadId: t.id })).status).toBeLessThan(300)
    await leftNeeds(plan.taskId, trays.taskId, t.id, words, 'chat Follow up naming a thread below (quick bar, an older phone)')
    await unread(trays.taskId, t.id, words)
  })

  it('a phone Follow up through the companion naming a thread below', async () => {
    const t = await ask(trays.taskId, 'Paint the gate green or leave it bare?')
    await inNeeds(plan.taskId, t.id)
    const words = 'Green, like the shed'
    const messageId = 'qm-mobile-leaves-needs-1'
    expect((await api('PUT', `/tasks/${plan.taskId}/threads/${t.id}/follow-ups/${messageId}`)).status).toBe(200)
    const conn = new DaemonConnection('__local__', null)
    ;(conn as unknown as { send: () => Promise<unknown> }).send = async () => ({ ok: true })
    await (conn as unknown as { handleMessageRequest: (e: Record<string, unknown>) => Promise<void> })
      .handleMessageRequest({ ev: 'message-request', relayId: 11, sessionId: plan.sid, message: words, messageId })
    await leftNeeds(plan.taskId, trays.taskId, t.id, words, 'chat Follow up naming a thread below (quick bar, an older phone)')
  })

  it('chat Follow up naming a thread of its own', async () => {
    const t = await ask(plan.taskId, 'Prune the apple rows this week?')
    await inNeeds(plan.taskId, t.id)
    const words = 'Yes, this week'
    expect((await api('POST', `/sessions/${plan.sid}/messages`, { text: words, threadId: t.id })).status).toBeLessThan(300)
    await leftNeeds(plan.taskId, plan.taskId, t.id, words, 'chat Follow up naming a thread of its own')
  })

  it('card box on a thread of its own', async () => {
    const t = await ask(plan.taskId, 'Mulch the pear rows or leave them?')
    await inNeeds(plan.taskId, t.id)
    const words = 'Mulch them'
    expect((await api('POST', `/tasks/${plan.taskId}/threads`, { text: words, thread: t.id })).status).toBeLessThan(300)
    await leftNeeds(plan.taskId, plan.taskId, t.id, words, 'card box on a thread of its own')
  })

  it('chat Follow up naming a thread that moved on', async () => {
    const t = await ask(plan.taskId, 'Where do the spare seedlings go?')
    expect((await api('POST', `/tasks/${plan.taskId}/threads/${t.id}/move`, { to: garden.taskId })).status).toBe(200)
    await vi.waitFor(async () => expect((await readThreads(garden.taskId)).threads.find((x) => x.id === t.id)?.state).toBe('needs'), { timeout: 10_000, interval: 200 })
    const words = 'On the bench by the gate'
    expect((await api('POST', `/sessions/${plan.sid}/messages`, { text: words, threadId: t.id })).status).toBeLessThan(300)
    await leftNeeds(garden.taskId, garden.taskId, t.id, words, 'chat Follow up naming a thread that moved on')
    await leftNeeds(plan.taskId, garden.taskId, t.id, words, 'chat Follow up naming a thread that moved on')
  })
})

describe('a reply on its way is sent once, across a restart too', () => {
  /** His reply filed below and claimed into the owner's queue under `qm`, as the wake does. */
  async function claimed(title: string, words: string, qm: string): Promise<{ thread: string; message: string }> {
    const t = await ask(trays.taskId, title)
    const r = await api<{ message: { id: string } }>('POST', `/tasks/${plan.taskId}/threads`, { text: words, thread: t.id })
    expect(r.status).toBe(200)
    await updateReplyDeliveries(trays.taskId, (_t, m) => (m.id === r.json.message.id ? { ...m.delivery!, state: 'claimed', at: new Date().toISOString(), queued: qm } : undefined))
    await enqueueMessage(trays.sid, words, { id: qm, sentBy: 'person', heldReason: 'test: held so no delivery takes it' })
    return { thread: t.id, message: r.json.message.id }
  }
  const deliveryOf = async (id: string) => (await readThreads(trays.taskId)).threads.flatMap((t) => t.messages).find((m) => m.id === id)?.delivery

  // Review of 2026-11-20: after a restart the after-turn release can deliver a held reply before the
  // reply sweep maps its row, so its delivered event finds no owner; the sweep then read the row as
  // lost and sent his words a second time.
  it('a claimed reply whose row went out as a line before the sweep mapped it is delivered, never sent again', async () => {
    const qm = `qm-reply-${randomUUID()}`
    const { message } = await claimed('Water the trays at dawn or at dusk?', 'At dawn', qm)
    // The row goes out as a line and leaves the queue (its delivered event fell before the mapping).
    await unparkMessage(trays.sid, qm)
    expect((await markProcessing(trays.sid)).map((m) => m.id)).toContain(qm)
    await removeProcessed(trays.sid, [qm])
    expect(await findQueuedMessage(qm)).toBeNull()
    await sweepThreadReplies()
    expect((await deliveryOf(message))?.state).toBe('delivered')
    expect((await getQueue(trays.sid)).some((m) => m.message.includes('At dawn'))).toBe(false)
  })

  // 2026-11-20: the owner read his reply in its own Threads while its queue row was held, and
  // every thread_update it made was refused with reply_pending while its stop hook asked for it.
  it('the owner reading its Threads takes his reply: delivered, its waiting row withdrawn, its update no longer refused', async () => {
    const qm = `qm-reply-${randomUUID()}`
    const { thread, message } = await claimed('Stack the trays in the barn or the shed?', 'In the barn', qm)
    const update = () => api('PATCH', `/tasks/${trays.taskId}/threads/${thread}`, { state: 'answered', reply: 'Stacked in the barn.' }, trays.sid)
    const refused = await update()
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.json)).toContain('reply_pending')
    // The owner's thread_list: its own session reads its Threads.
    expect((await api('GET', `/tasks/${trays.taskId}/threads?open=1`, undefined, trays.sid)).status).toBe(200)
    expect(await deliveryOf(message)).toMatchObject({ state: 'delivered', read: 'threads' })
    expect(await findQueuedMessage(qm)).toBeNull()
    expect((await update()).status).toBe(200)
    // A read by anyone else (the user, another task) takes nothing.
    const other = await claimed('Mark the trays with chalk or tape?', 'Chalk', `qm-reply-${randomUUID()}`)
    expect((await api('GET', `/tasks/${trays.taskId}/threads?open=1`)).status).toBe(200)
    expect((await api('GET', `/tasks/${trays.taskId}/threads?open=1`, undefined, plan.sid)).status).toBe(200)
    expect((await deliveryOf(other.message))?.state).toBe('claimed')
  })

  it('a claimed reply whose row is still in the owner\'s queue stays claimed: it goes when that row goes, once', async () => {
    const qm = `qm-reply-${randomUUID()}`
    const { message } = await claimed('Label the trays by row or by seed?', 'By seed', qm)
    await sweepThreadReplies()
    expect((await deliveryOf(message))).toMatchObject({ state: 'claimed', queued: qm })
    expect((await getQueue(trays.sid)).filter((m) => m.message === 'By seed')).toHaveLength(1)
    await deleteMessage(trays.sid, qm)
  })
})

describe('every way a reply is filed has a case', () => {
  const SINKS = ['replyOnThread', 'fileThreadMessage', 'answerLetterOnThread', 'answerChoiceOnThread']
  function callers(): string[] {
    const out = new Set<string>()
    const walk = (dir: string): void => {
      for (const e of fss.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) {
          const src = fss.readFileSync(p, 'utf8')
          for (const fn of SINKS) {
            // A call (await fn( or store.fn( or a bare call), never the definition.
            const calls = src.split('\n').filter((l) => new RegExp(`(^|[^\\w.])(\\w+\\.)?${fn}\\(`).test(l) && !new RegExp(`function ${fn}\\(`).test(l))
            if (calls.length) out.add(`${path.relative(ROOT, p).split(path.sep).join('/')} ${fn}`)
          }
        }
      }
    }
    walk(path.join(ROOT, 'src'))
    return [...out].sort()
  }

  it('each call that files his reply on a thread is listed, and each listed one still exists', () => {
    expect(callers()).toEqual(Object.keys(PATHS).sort())
  })

  it('each listed case ran here, or names a test file that exists', () => {
    for (const [where, how] of Object.entries(PATHS)) {
      if (how.startsWith('tests/')) expect(fss.existsSync(path.join(ROOT, how)), where).toBe(true)
      else expect(covered.has(how), `${where}: ${how}`).toBe(true)
    }
  })
})
