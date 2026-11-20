/**
 * A decision letter waits on a thread of the task that sent it, on a real server (experiment
 * letters_as_threads, src/core/human-inbox/letter-threads.ts; 2026-11-20, the user, on a decision
 * letter in his inbox and atop his VP's chat but not in its Threads: "why it exist in both place?").
 *
 *   Orchard VP (lead)   "Choose the orchard trees" (Threads on)   "Mend the fence" (no Threads)
 *
 *   1. off: a decision letter is a letter only (its Action needed item, its Needs you);
 *   2. on: a letter already sent gets one needs thread, and the migration run again makes no other;
 *      the letter leaves the Action needed items and the thread is the one Needs you;
 *   3. a new decision letter makes one needs thread with its options and a link to it;
 *   4. his answer from the thread card (the letter's own answer route) answers the letter, its asker
 *      hears it as today, and the thread closes as known;
 *   5. an answer for him in the inbox (human_inbox_answer) answers the thread, as news for him;
 *   6. the VP's own letter waits on the VP's Threads with no Letter item on its strip; archived, its
 *      thread drops;
 *   7. a letter from a task that keeps no Threads stays a letter only;
 *   8. off again closes the open ones and the letter counts as a letter; on again opens them again.
 *
 * What's real: server, bus, task store, inbox, threads store, the queue, the session runner, the
 * status sync. Mocked: constants, the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-letters-as-threads'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { readThreads, threadTaskIds, writeThreadsFor } from '../../src/core/org/threads-store.js'
import { getLetter } from '../../src/core/human-inbox/store.js'
import { lettersAsThreadsNow, syncAllLetterThreads, syncLetterThread } from '../../src/core/human-inbox/letter-threads.js'
import { letterThreadId } from '../../src/core/org/letter-thread-model.js'
import { executeOp } from '../../src/ops/index.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

let server: Server
let daemon: MockDaemon
let port = 0
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

type Node = { taskId: string; sid: string }
let vp: Node
let trees: Node
let fence: Node
const queued = new Map<string, string[]>()

async function startSessionFor(taskId: string, project: string): Promise<string> {
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project, preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
  return sid
}

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

async function flag(on: boolean): Promise<void> {
  expect((await api('PUT', '/api/config', { experimental: { letters_as_threads: on } })).status).toBe(200)
  await vi.waitFor(() => expect(lettersAsThreadsNow()).toBe(on), { timeout: 5000 })
}

const op = async (name: string, args: Record<string, unknown>, sid: string) => {
  const out = await executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: '__local__', callerMode: 'session', callerSid: sid })
  if (!out.ok) throw new Error(out.message)
  return out.result as Record<string, any>
}

/** A decision letter from `node`, as its session sends one. */
async function decide(node: Node, subject: string, labels: [string, string]): Promise<string> {
  const out = await op('human_inbox_send', {
    subject, type: 'action_required', markdown: `${subject} Both fit the orchard plan.`,
    actions: [{ id: 'one', label: labels[0] }, { id: 'two', label: labels[1] }],
    user_kind: 'user_own', user_kind_why: 'He asked to choose the orchard trees himself',
  }, node.sid)
  expect(out.letterId).toMatch(/^lt-/)
  return out.letterId as string
}

/** Every record of a letter's thread on any node (a moved pointer is not a copy). */
async function threadsOfLetter(letterId: string): Promise<Array<OrgThread & { node: string }>> {
  const out: Array<OrgThread & { node: string }> = []
  for (const node of await threadTaskIds()) {
    for (const t of (await readThreads(node)).threads) if (t.letter?.id === letterId && !t.movedTo) out.push({ ...t, node })
  }
  return out
}
const threadOf = async (letterId: string) => (await threadsOfLetter(letterId))[0]

async function statusOf(taskId: string) {
  await settleUserStatusSync()
  await syncUserStatuses(new Set([taskId]))
  return (await getTask(taskId)).user_status
}
const letterItems = async (taskId: string) => ((await statusOf(taskId))?.actions ?? []).filter((a) => a.kind === 'letter').map((a) => a.id)

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await ensureMainTask()
  const vpTask = await ensureProjectLead('Orchard')
  const treesId = (await addTask({ title: 'Choose the orchard trees', project: 'Orchard', parent_task_id: vpTask.id })).task.id
  const fenceId = (await addTask({ title: 'Mend the fence', project: 'Orchard', parent_task_id: vpTask.id })).task.id
  await updateTaskRaw(treesId, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  await updateTaskRaw(fenceId, { phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  vp = { taskId: vpTask.id, sid: await startSessionFor(vpTask.id, 'Orchard') }
  trees = { taskId: treesId, sid: await startSessionFor(treesId, 'Orchard') }
  fence = { taskId: fenceId, sid: await startSessionFor(fenceId, 'Orchard') }
  bus.subscribe('test-letters-as-threads', (event) => {
    const d = event.data as { sessionId: string; message?: string }
    queued.set(d.sessionId, [...(queued.get(d.sessionId) ?? []), d.message ?? ''])
  }, { global: true, interest: [EventNames.SESSION_MESSAGE_QUEUED] })
}, 150_000)

afterAll(async () => {
  bus.unsubscribe('test-letters-as-threads')
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

let early = ''
let fresh = ''
let late = ''

describe('decision letters wait on the thread', () => {
  it('off: a decision letter is a letter only', async () => {
    await flag(false)
    early = await decide(trees, 'Plant apples or pears along the fence?', ['Apples', 'Pears'])
    await new Promise((r) => setTimeout(r, 300))
    expect(await threadsOfLetter(early)).toEqual([])
    expect(await letterItems(trees.taskId)).toEqual([early])
    expect((await statusOf(trees.taskId))?.source).toBe('letter')
  })

  it('on: the letter already sent gets one needs thread; the migration run again makes no other', async () => {
    await flag(true)
    await vi.waitFor(async () => expect(await threadsOfLetter(early)).toHaveLength(1), { timeout: 10_000, interval: 200 })
    expect(await syncAllLetterThreads()).toEqual({ opened: 0, settled: 0 })
    expect(await syncAllLetterThreads()).toEqual({ opened: 0, settled: 0 })
    const all = await threadsOfLetter(early)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: letterThreadId(early), node: trees.taskId, state: 'needs', title: 'Plant apples or pears along the fence?' })
    // One place: the thread is its Needs you, the letter no Action needed item.
    expect(await letterItems(trees.taskId)).toEqual([])
    const s = await statusOf(trees.taskId)
    expect(s).toMatchObject({ state: 'needs', source: 'thread' })
    expect(s?.threads?.needs).toBe(1)
  })

  it('a new decision letter makes one needs thread with its options and a link to it', async () => {
    fresh = await decide(trees, 'Prune in winter or in summer?', ['Winter', 'Summer'])
    await vi.waitFor(async () => expect(await threadsOfLetter(fresh)).toHaveLength(1), { timeout: 10_000, interval: 200 })
    const listed = (await api<{ threads: OrgThread[] }>('GET', `/tasks/${trees.taskId}/threads`)).json.threads.find((t) => t.id === letterThreadId(fresh))
    expect(listed).toMatchObject({
      state: 'needs', ask: 'Prune in winter or in summer?',
      opener: { from: 'letter', ref: fresh },
      letter: { id: fresh, task: trees.taskId, options: [{ id: 'one', label: 'Winter' }, { id: 'two', label: 'Summer' }] },
    })
    // Two decisions, counted once each.
    expect(await letterItems(trees.taskId)).toEqual([])
    expect((await statusOf(trees.taskId))?.threads?.needs).toBe(2)
  })

  it('his answer from the thread card answers the letter, its asker hears it as today, and the thread closes as known', async () => {
    const before = queued.get(trees.sid)?.length ?? 0
    const stale = await getLetter(fresh)
    // The card's button sends the letter's own answer (web: OrgInlineAnswer, LetterAnswer).
    const r = await api<{ letter: { answered?: { label: string } } }>('POST', `/human-inbox/${fresh}/answer`, { actionId: 'one' })
    expect(r.status).toBeLessThan(300)
    expect(r.json.letter.answered?.label).toBe('Winter')
    await vi.waitFor(() => {
      const rows = (queued.get(trees.sid) ?? []).slice(before)
      expect(rows.some((m) => m.includes('[Letter reply]') && m.includes('Winter'))).toBe(true)
    }, { timeout: 15_000, interval: 200 })
    await vi.waitFor(async () => expect(await threadOf(fresh)).toMatchObject({ state: 'answered', reply: 'You answered: Winter', closed: { how: 'acked', by: 'human' } }), { timeout: 10_000, interval: 200 })
    expect((await getLetter(fresh))?.answered?.actionId).toBe('one')
    // One decision still waits on him (the first letter's thread); the status reads Working while the asker runs its turn on the answer.
    expect((await api<{ threads: OrgThread[] }>('GET', `/tasks/${trees.taskId}/threads`)).json.threads.filter((t) => t.state === 'needs' && !t.closed).map((t) => t.letter?.id)).toEqual([early])
    expect(await letterItems(trees.taskId)).toEqual([])
    // A sync handed the letter as it was before the answer reads it again: nothing opens.
    expect(await syncLetterThread(stale!)).toBeNull()
    expect(await threadOf(fresh)).toMatchObject({ closed: { how: 'acked' }, letter: { done: true } })
  })

  it('an answer for him in the inbox answers the thread, as news for him', async () => {
    await op('human_inbox_answer', { id: early, action_id: 'two', user_words: 'Pears along the fence' }, vp.sid)
    await vi.waitFor(async () => {
      const t = await threadOf(early)
      expect(t).toMatchObject({ state: 'answered' })
      expect(t.reply).toMatch(/^Answered for you by .+: Pears$/)
      expect(t.closed).toBeUndefined()
    }, { timeout: 10_000, interval: 200 })
    const s = await statusOf(trees.taskId)
    expect(s?.threads?.needs ?? 0).toBe(0)
    expect(s?.source).not.toBe('letter')
  })

  it('the VP\'s own letter waits on its Threads with no Letter item on its strip; archived, its thread drops', async () => {
    const own = await decide(vp, 'Open the orchard to visitors this spring?', ['Open it', 'Keep it closed'])
    await vi.waitFor(async () => expect(await threadOf(own)).toMatchObject({ node: vp.taskId, state: 'needs' }), { timeout: 10_000, interval: 200 })
    expect(await letterItems(vp.taskId)).toEqual([])
    expect((await statusOf(vp.taskId))?.threads?.needs).toBeGreaterThanOrEqual(1)
    expect((await api('POST', `/human-inbox/${own}/archive`, { archived: true })).status).toBeLessThan(300)
    await vi.waitFor(async () => expect(await threadOf(own)).toMatchObject({ closed: { how: 'dropped' } }), { timeout: 10_000, interval: 200 })
  })

  it('a letter from a task that keeps no Threads stays a letter only', async () => {
    const plain = await decide(fence, 'Wood or wire for the new fence?', ['Wood', 'Wire'])
    await new Promise((r) => setTimeout(r, 500))
    expect(await threadsOfLetter(plain)).toEqual([])
    expect(await letterItems(fence.taskId)).toEqual([plain])
  })

  it('a task that stops keeping Threads shows its letter again: never hidden in both places', async () => {
    const kept = await decide(trees, 'Water by hand or with the drip line?', ['By hand', 'Drip line'])
    await vi.waitFor(async () => expect(await threadOf(kept)).toMatchObject({ state: 'needs' }), { timeout: 10_000, interval: 200 })
    expect(await letterItems(trees.taskId)).toEqual([])
    expect((await api('PATCH', `/api/tasks/${trees.taskId}`, { threads_on: false })).status).toBe(200)
    await vi.waitFor(async () => expect(await letterItems(trees.taskId)).toEqual([kept]), { timeout: 10_000, interval: 300 })
    expect((await api('PATCH', `/api/tasks/${trees.taskId}`, { threads_on: true })).status).toBe(200)
    await vi.waitFor(async () => expect(await letterItems(trees.taskId)).toEqual([]), { timeout: 10_000, interval: 300 })
    expect((await api('POST', `/human-inbox/${kept}/answer`, { actionId: 'one' })).status).toBeLessThan(300)
  })

  it('off again closes the open ones and the letter counts as a letter; on again opens them again', async () => {
    late = await decide(trees, 'Mulch with straw or with bark?', ['Straw', 'Bark'])
    await vi.waitFor(async () => expect(await threadOf(late)).toMatchObject({ state: 'needs' }), { timeout: 10_000, interval: 200 })
    await flag(false)
    await vi.waitFor(async () => expect(await threadOf(late)).toMatchObject({ closed: { how: 'dropped' }, letter: { off: true } }), { timeout: 10_000, interval: 200 })
    expect(await letterItems(trees.taskId)).toEqual([late])
    await flag(true)
    await vi.waitFor(async () => {
      const t = await threadOf(late)
      expect(t.state).toBe('needs')
      expect(t.closed).toBeUndefined()
    }, { timeout: 10_000, interval: 200 })
    expect(await threadsOfLetter(late)).toHaveLength(1)
    expect(await letterItems(trees.taskId)).toEqual([])
  })

  it('a thread deleted a week after it closed is never opened again; one set aside and deleted opens once', async () => {
    // The sweep deletes a closed thread after its week (threads-model.ts prune): as it would, here.
    const prune = (node: string, id: string) => writeThreadsFor(node, (cur) => ({ file: { ...cur, threads: cur.threads.filter((t) => t.id !== id) }, out: true }))
    const dropped = await decide(trees, 'Net the cherries or let the birds have some?', ['Net them', 'Share'])
    await vi.waitFor(async () => expect(await threadOf(dropped)).toMatchObject({ state: 'needs' }), { timeout: 10_000, interval: 200 })
    // He closes the thread without answering the letter; a week later it is deleted.
    expect((await api('PATCH', `/tasks/${trees.taskId}/threads/${letterThreadId(dropped)}`, { close: 'dropped' })).status).toBe(200)
    await prune(trees.taskId, letterThreadId(dropped))
    expect(await syncAllLetterThreads()).toMatchObject({ opened: 0 })
    expect(await syncLetterThread((await getLetter(dropped))!)).toBeNull()
    expect(await threadsOfLetter(dropped)).toEqual([])
    // Set aside by the experiment going off, then deleted: on again opens it once.
    await flag(false)
    await vi.waitFor(async () => expect(await threadOf(late)).toMatchObject({ letter: { off: true } }), { timeout: 10_000, interval: 200 })
    await prune(trees.taskId, letterThreadId(late))
    await flag(true)
    await vi.waitFor(async () => expect(await threadsOfLetter(late)).toHaveLength(1), { timeout: 10_000, interval: 200 })
    expect(await syncAllLetterThreads()).toMatchObject({ opened: 0 })
    expect(await threadsOfLetter(late)).toHaveLength(1)
  })
})
