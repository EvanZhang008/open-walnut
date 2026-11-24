/**
 * A thread he wrote in leaves Needs you, comes back only from his words, and one matter is asked in
 * one place, on a real server (src/core/org/thread-return.ts, thread-supersede.ts; 2026-11-21, the
 * user: "I already replied, why is it still there?").
 *
 * The shape of the case, with invented garden data: a decision letter (approve turning a sprinkler
 * back on with the shared garden key) waited on its thread; he wrote back a question; the task answered and put
 * the thread back in needs with ANOTHER decision (open it from the garden panel), under the
 * letter's old buttons, the letter left open in his inbox.
 *
 * What's real: server, inbox, letter threads, threads store, ops, the status sync. Mocked: constants,
 * the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-one-matter'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { getLetter } from '../../src/core/human-inbox/store.js'
import { lettersAsThreadsNow } from '../../src/core/human-inbox/letter-threads.js'
import { letterThreadId } from '../../src/core/org/letter-thread-model.js'
import { executeOp } from '../../src/ops/index.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'

let server: Server
let daemon: MockDaemon
let port = 0
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
let taskId = ''
let sid = ''
const KIND = { user_kind: 'permissions', user_kind_why: 'It uses the shared garden key, which needs his approval' }

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}
const op = (name: string, args: Record<string, unknown>) => executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: '__local__', callerMode: 'session', callerSid: sid })
const thread = async (id: string) => (await readThreads(taskId)).threads.find((t) => t.id === id)!
async function statusOf() {
  await settleUserStatusSync()
  await syncUserStatuses(new Set([taskId]))
  return (await getTask(taskId)).user_status
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await ensureMainTask()
  const vp = await ensureProjectLead('Triage')
  taskId = (await addTask({ title: 'Ticket triage', project: 'Triage', parent_task_id: vp.id })).task.id
  await updateTaskRaw(taskId, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project: 'Triage', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/), { timeout: 20_000 })
  expect((await api('PUT', '/api/config', { experimental: { letters_as_threads: true, task_threads: true } })).status).toBe(200)
  await vi.waitFor(() => expect(lettersAsThreadsNow()).toBe(true), { timeout: 5000 })
}, 150_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

let letter = ''
let held = ''

describe('the switch case, replayed', () => {
  it('the decision letter waits on its thread', async () => {
    const out = await op('human_inbox_send', {
      subject: 'The sprinkler has been off 5 days: turn it on with the shared garden key?', type: 'action_required',
      markdown: 'Approve running start_sprinkler with the shared garden key? I recommend it: the beds stay dry while it is off.',
      actions: [{ id: 'run', label: 'Approve, run this one', recommended: true }, { id: 'skip', label: 'Do not run it' }], ...KIND,
    })
    expect(out.ok).toBe(true)
    letter = (out as { result: { letterId: string } }).result.letterId
    held = letterThreadId(letter)
    await vi.waitFor(async () => expect((await thread(held))?.state).toBe('needs'), { timeout: 10_000, interval: 200 })
  })

  it('his question takes the card off Needs you at once', async () => {
    const r = await api('POST', `/tasks/${taskId}/threads`, { text: 'Wait: is it off because of a bug, or is there no way back? Check first.', thread: held })
    expect(r.status).toBeLessThan(300)
    expect((await thread(held)).state).toBe('working')
    expect((await statusOf())?.threads?.needs ?? 0).toBe(0)
  })

  it('back in needs with a new decision on the old card is refused, every way it was tried', async () => {
    const bare = await op('thread_update', { id: held, state: 'needs', reply: 'Open the valve fully from the garden panel so the timer turns the sprinkler on? I recommend it.', ...KIND })
    expect(bare.ok).toBe(false)
    expect((bare as { message: string }).message).toMatch(/they wrote in this thread since it last waited on them.*since_you_wrote/)
    const asNew = await op('thread_update', { id: held, state: 'needs', reply: 'Open the valve from the garden panel? I recommend it.', since_you_wrote: 'It is a bug: the timer waited 2 minutes, gave up and never retried.', decision: 'new', ...KIND })
    expect((asNew as { message: string }).message).toMatch(/a new decision is its own card.*supersedes.*lt-/)
    expect((await thread(held)).state).toBe('working')
  })

  it('answered here, the new decision opens on its own card, and the old thread and letter leave his Needs you', async () => {
    expect((await op('thread_update', { id: held, state: 'answered', reply: 'It is a bug, not a missing way back: the timer waited 2 minutes for the health check, gave up and never retried.' })).ok).toBe(true)
    const draft = {
      title: 'Turn the sprinkler back on from the garden panel?', from: 'task', ...KIND,
      text: 'Open the valve fully from the garden panel (it is already open, so no water moves) so the timer turns the sprinkler back on? I recommend it.',
      reply: 'Turn the sprinkler back on from the garden panel? I recommend it: it moves no water and the timer then re-enables the sprinkler.',
      options: [{ label: 'Open it from the panel (recommended)', recommended: true }, { label: 'Leave the sprinkler off' }],
    }
    const unnamed = await op('thread_create', draft)
    expect(unnamed.ok).toBe(false)
    expect((unnamed as { message: string }).message).toMatch(/your task still asks them this too: .*th-.*One matter is asked in one place/)
    const made = await op('thread_create', { ...draft, supersedes: [held] })
    expect(made.ok).toBe(true)
    const fresh = (made as { result: { thread: { id: string } } }).result.thread.id
    // Its answer to his question stays his to read; its letter, with the old buttons, is settled.
    expect((await thread(held))).toMatchObject({ state: 'answered' })
    expect((await thread(held)).reply).toMatch(/It is a bug, not a missing way back/)
    expect((await getLetter(letter))?.settled?.reason).toMatch(/Asked now in "Turn the sprinkler back on/)
    const s = await statusOf()
    expect(s?.threads?.needs).toBe(1)
    expect(s?.threads?.id).toBe(fresh)
  })

  it('the same decision again starts from his words', async () => {
    const fresh = (await readThreads(taskId)).threads.find((t) => t.state === 'needs')!
    expect((await api('POST', `/tasks/${taskId}/threads`, { text: 'Did you not answer me already?', thread: fresh.id })).status).toBeLessThan(300)
    const back = await op('thread_update', { id: fresh.id, state: 'needs', reply: 'Turn the sprinkler back on from the garden panel? I recommend it.', since_you_wrote: 'Yes: it is a bug, answered in the other thread; nothing else changed.', decision: 'same', ...KIND })
    expect(back.ok).toBe(true)
    const t = await thread(fresh.id)
    expect(t.state).toBe('needs')
    expect(t.reply).toMatch(/^Turn the sprinkler back on[\s\S]*\*\*Since your message at \d\d:\d\d UTC:\*\* Yes: it is a bug/)
    expect(t.reply).not.toContain('Did you not answer me already')
  })
})

describe('his request in needs, then a card of the node\'s own for the same task (the threads inspection, item 9)', () => {
  let fence = ''
  let his = ''
  const OTHER = { separate_reason: 'The sprinkler valve is another decision, about another task.' }

  it('the second card for the same task\'s decision is refused until it names his card as replaced', async () => {
    fence = (await addTask({ title: 'Orchard fence posts', project: 'Triage', parent_task_id: taskId })).task.id
    // Ten minutes before his last message above, so it opens its own thread (a message within 3 minutes joins his last one's).
    const at = new Date(Date.now() - 10 * 60_000).toISOString()
    const r = await api<{ thread: { id: string }; created: boolean }>('POST', `/tasks/${taskId}/threads`, { text: 'Which fence posts should we order for the orchard?', at })
    expect(r.json.created).toBe(true)
    his = r.json.thread.id
    const put = await op('thread_update', {
      id: his, state: 'needs', add_tasks: [fence], ...KIND, ...OTHER,
      reply: 'Order oak or larch posts for the orchard fence? I recommend larch: it lasts as long and costs a third less.',
      options: [{ label: 'Larch (recommended)', recommended: true }, { label: 'Oak' }],
    })
    expect(put.ok, JSON.stringify(put)).toBe(true)
    const draft = {
      title: 'Orchard fence: larch or oak posts?', from: 'task', tasks: [fence], ...KIND,
      text: 'Order larch posts for the orchard fence (a third cheaper, lasts as long as oak)? I recommend it.',
      reply: 'Order larch posts for the orchard fence? I recommend it: a third cheaper than oak and it lasts as long.',
      options: [{ label: 'Larch (recommended)', recommended: true }, { label: 'Oak' }],
    }
    // Before this change his card was no ask of the node's own, so only the sprinkler card was named.
    const unnamed = await op('thread_create', draft)
    expect(unnamed.ok).toBe(false)
    expect((unnamed as { message: string }).message).toContain(his)
  })

  it('named, his old card closes with where it is asked now, and one card asks it', async () => {
    const made = await op('thread_create', {
      title: 'Orchard fence: larch or oak posts?', from: 'task', tasks: [fence], ...KIND, ...OTHER, supersedes: [his],
      text: 'Order larch posts for the orchard fence (a third cheaper, lasts as long as oak)? I recommend it.',
      reply: 'Order larch posts for the orchard fence? I recommend it: a third cheaper than oak and it lasts as long.',
      options: [{ label: 'Larch (recommended)', recommended: true }, { label: 'Oak' }],
    })
    expect(made.ok, JSON.stringify(made)).toBe(true)
    const fresh = (made as { result: { thread: { id: string } } }).result.thread.id
    const old = await thread(his)
    expect(old.closed).toMatchObject({ how: 'dropped', told: true })
    expect(old.reply).toMatch(/Asked now in "Orchard fence: larch or oak posts\?" \(th-/)
    expect(old.options).toBeUndefined()
    const open = (await readThreads(taskId)).threads.filter((t) => !t.closed && t.state === 'needs' && t.tasks?.includes(fence))
    expect(open.map((t) => t.id)).toEqual([fresh])
  })
})
