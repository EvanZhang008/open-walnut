/**
 * A node's count of threads is the cards its Threads draw in Needs you and Done, on every node
 * above a task's thread (2026-11-21, the user, on his Walnut VP: a red "1" on its row, a red "1
 * thread: <title>" line and a red "1 thread" in its header, while its Threads showed only Working,
 * Waiting and Done: "It show 1 but there isn't any").
 *
 * His data then: a task below the VP had asked him with a decision letter, its thread waiting on
 * him; he wrote on it, the task withdrew the letter (settled, "asked again in the same thread") and
 * asked again on the thread; he answered that from the VP's card box. His reply was on its way to
 * the task (its turn still running) for 3.5 minutes: the thread was listed above the VP for that
 * (thread-view.ts listedAbove), so every count held it, while the grouped Threads drew it in Working.
 *
 *   Main ─ Orchard VP ─ "Settings pages" (a Director, Threads on) ─ "Phones and Cloud" (owner, Threads on)
 *
 * Each node above reads the same: before his reply, 1 everywhere and the card in Needs you; after
 * it, 0 everywhere (badge, header, red line, top of the chat) and the card in Working with his
 * words, while the reply is still undelivered. Read the way each surface reads: GET .../threads
 * (the header, the top and the groups the web draws), `shown_count`, and `user_status.threads` (the
 * Org row's badge and red line, the phone's drawer).
 *
 * What's real: server, bus, task store, threads store, inbox, queue, session runner, status sync.
 * Mocked: constants, the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-count-one-rule'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { letterThreadId } from '../../src/core/org/letter-thread-model.js'
import { listedForHim, threadLine } from '../../src/core/org/thread-view.js'
import { threadGroupOf } from '../../src/core/org/thread-groups.js'
import { threadsPopUpNow } from '../../src/core/org/thread-popup.js'
import { lettersAsThreadsNow } from '../../src/core/human-inbox/letter-threads.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'
import { executeOp } from '../../src/ops/index.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
let server: Server
let daemon: MockDaemon
let port: number
const ids = { main: '', vp: '', director: '', owner: '', ownerSid: '', worker: '' }

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown, callerSid?: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method, headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

type Listed = OrgThread & { owner?: { task_id: string }; shown?: boolean; counted?: boolean }
type Counts = { shown: number; needs: number; title?: string; id?: string; below?: number }

/** What each surface of one node reads for him now. */
async function surfaces(node: string, threadId: string) {
  const read = await api<{ threads: Listed[]; shown_count: number }>('GET', `/tasks/${node}/threads`)
  expect(read.status).toBe(200)
  const list = read.json.threads
  const listed = listedForHim(list)
  // The groups the web draws (OrgThreadsByState), by the web's own rule.
  const groups: Record<string, string[]> = {}
  for (const t of list) (groups[threadGroupOf(t, listed.includes(t))] ??= []).push(t.id)
  const card = list.find((t) => t.id === threadId)
  const status = (await api<{ task: { user_status?: { threads?: Counts } } }>('GET', `/api/tasks/${node}`)).json.task.user_status?.threads
  return {
    // The Org row's badge and its red line (org-channels-model.ts threadsBadge / threadLine), the
    // phone's drawer: Main's and a VP's rows. A Director is a task card, not a row with a badge: its
    // status carries counts only for a thread of its own waiting on him (user-status.ts taskThreadNeeds).
    badge: status?.shown ?? 0,
    line: status ? threadLine(status as never) : '',
    // The header's pill and the phone's tab, from the same read.
    header: read.json.shown_count,
    counted: list.filter((t) => t.counted).length,
    // What the grouped Threads draw for him: Needs you and Done.
    panel: (groups.needs?.length ?? 0) + (groups.read?.length ?? 0),
    group: card ? threadGroupOf(card, listed.includes(card)) : null,
    card,
  }
}

async function settle(): Promise<void> {
  await settleUserStatusSync()
  await syncUserStatuses(new Set([ids.main, ids.vp, ids.director, ids.owner]))
}

const op = async (name: string, args: Record<string, unknown>, sid: string) => {
  const out = await executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: '__local__', callerMode: 'session', callerSid: sid })
  if (!out.ok) throw new Error(out.message)
  return out.result as Record<string, any>
}

beforeAll(async () => {
  process.env.WALNUT_THREAD_FOLLOW = '0'
  // His reply stays on its way for the whole file, as the task's long turn kept it on 2026-11-21.
  process.env.WALNUT_THREAD_REPLY_GATHER_MS = '600000'
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  // The user's switches that reach this: threads pop up, letters as threads, one card, Threads by state, the top.
  const flags = { threads_pop_up: true, letters_as_threads: true, threads_one_card: true, brief_off: true, top_thread: true }
  expect((await api('PUT', '/api/config', { experimental: flags })).status).toBe(200)
  await vi.waitFor(() => expect(threadsPopUpNow() && lettersAsThreadsNow()).toBe(true), { timeout: 5000 })
  ids.main = (await ensureMainTask()).id
  ids.vp = (await ensureProjectLead('Orchard')).id
  ids.director = (await addTask({ title: 'Settings pages', project: 'Orchard', parent_task_id: ids.vp })).task.id
  ids.owner = (await addTask({ title: 'Phones and Cloud', project: 'Orchard', parent_task_id: ids.director })).task.id
  ids.worker = (await addTask({ title: 'Tunnel tab copy', project: 'Orchard', parent_task_id: ids.director })).task.id
  for (const id of [ids.director, ids.owner]) await updateTaskRaw(id, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  ids.ownerSid = (await sessionRunner.startSession({ taskId: ids.owner, cwd: WALNUT_HOME, message: 'Ready', project: 'Orchard', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => expect((await getSessionByClaudeId(ids.ownerSid))?.process_status).toMatch(/idle|stopped/), { timeout: 20_000 })
}, 150_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  delete process.env.WALNUT_THREAD_FOLLOW
  delete process.env.WALNUT_THREAD_REPLY_GATHER_MS
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('the 2026-11-21 VP: a withdrawn letter, the same thread asked again, his reply on its way', () => {
  let thread = ''
  const viewers = () => [ids.director, ids.vp, ids.main]
  /** The row's badge: Main's and the VP's; a Director has none (a task card under its VP). */
  const rowBadge = (node: string, n: number) => (node === ids.director ? 0 : n)

  it('the task\'s decision letter waits on him on its thread: 1 on every node above, in Needs you', async () => {
    const sent = await op('human_inbox_send', {
      subject: 'Wi-Fi sign-in button: All devices?', type: 'action_required',
      markdown: 'Done, not shipped: a browser on the same Wi-Fi can sign in without a tunnel. Ship its sign-in button under All devices in Phones & Cloud?',
      actions: [{ id: 'ship', label: 'Ship it under All devices', recommended: true }, { id: 'tunnel', label: 'Show it on the Tunnel tab instead' }, { id: 'hold', label: 'Keep it unshipped for now' }],
      user_kind: 'user_own', user_kind_why: 'It places a button on his own settings page',
    }, ids.ownerSid)
    const letter = sent.letterId as string
    thread = letterThreadId(letter)
    await vi.waitFor(async () => expect((await readThreads(ids.owner)).threads.find((t) => t.id === thread)?.state).toBe('needs'), { timeout: 10_000, interval: 200 })
    await settle()
    for (const node of viewers()) {
      const s = await surfaces(node, thread)
      expect(s, node).toMatchObject({ badge: rowBadge(node, 1), header: 1, counted: 1, panel: 1, group: 'needs' })
    }

    // He writes on it ("what are you talking about"); the task withdraws the letter and asks again on the same thread.
    expect((await api('POST', `/tasks/${ids.vp}/threads`, { text: 'What are you talking about?', thread })).status).toBe(200)
    expect((await api('POST', `/human-inbox/${letter}/settle`, { reason: 'The question was unclear; asked again in the same thread with screenshots' }, ids.ownerSid)).status).toBe(200)
    const asked = await api('PATCH', `/tasks/${ids.owner}/threads/${thread}`, {
      title: 'Same Wi-Fi browser sign-in: which settings page holds the button?', state: 'needs',
      reply: 'Two places, screenshots attached: All devices, or the Tunnel tab. Which one?',
      user_kind: 'user_own', user_kind_why: 'It places a button on his own settings page',
    }, ids.ownerSid)
    expect(asked.status, JSON.stringify(asked.json)).toBe(200)
    await settle()
    for (const node of viewers()) {
      const s = await surfaces(node, thread)
      expect(s, node).toMatchObject({ badge: rowBadge(node, 1), header: 1, counted: 1, panel: 1, group: 'needs' })
      if (node !== ids.director) expect(s.line, node).toBe('1 thread: Same Wi-Fi browser sign-in: which settings page holds the button?')
    }
  })

  it('he answers it from the VP\'s card: 0 on every surface of every node above, the card in Working with his words, still undelivered', async () => {
    const words = 'Put each code in the tab of the way it belongs to'
    expect((await api('POST', `/tasks/${ids.vp}/threads`, { text: words, thread })).status).toBe(200)
    await settle()
    const stored = (await readThreads(ids.owner)).threads.find((t) => t.id === thread)!
    expect(stored.messages.find((m) => m.text === words)?.delivery?.state).toBe('pending')
    for (const node of viewers()) {
      const s = await surfaces(node, thread)
      // Every count agrees with the panel: nothing waits on him, so nothing lights up.
      expect({ badge: s.badge, header: s.header, counted: s.counted, panel: s.panel, line: s.line }, node).toEqual({ badge: 0, header: 0, counted: 0, panel: 0, line: '' })
      // The card is still in his list, in Working, his words on it (the reply did not vanish).
      expect(s.group, node).toBe('working')
      expect(s.card?.shown, node).toBe(true)
      expect(s.card?.messages.map((m) => m.text), node).toContain(words)
    }
    // The owner's own Threads read it as the task's move too.
    const own = await surfaces(ids.owner, thread)
    expect(own).toMatchObject({ badge: 0, header: 0, panel: 0, group: 'working' })
  })
})
