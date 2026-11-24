/**
 * One subject shows once on his lead's Threads (2026-11-24, the user: "why the fuck there are so
 * many dupciated thread"). His VP's card was his own request with the designs' result on it (Done),
 * beside the card of the task it was handed to, which asked him to pick; he answered on the VP's
 * and the task's kept waiting.
 *
 *   Orchard VP (his request, its result in, naming the task) ─ "Ten panel designs" (Threads on, its card asks him)
 *
 * The VP's result waits behind the task's card (thread-task-ask.ts heldResults) on every surface
 * that reads it: GET .../threads (`shown`, `counted`, `shown_count`), GET .../threads/:id, the
 * Board's thread states and the VP's `user_status.threads`. While the task asks, only its card is
 * in his sight; once he answers there, nothing of the subject is, until the VP writes its card
 * again (news). A result of the VP on another subject stays in his sight throughout.
 * Two asks are never hidden behind one another: the VP handing him a thread while the task's
 * thread asks its subject is refused at the write (thread-same-subject.ts refuseSameSubjectAsk),
 * and so is the task's while the VP's asks.
 *
 * What's real: server, task store, threads store, status sync. Mocked: constants, the CLI.
 * Chinese test data is written with \u escapes (his titles of that day).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-fold-under-task'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { openNodeThread, patchThread, readThreads } from '../../src/core/org/threads-store.js'
import { listedForHim } from '../../src/core/org/thread-view.js'
import { threadsPopUpNow } from '../../src/core/org/thread-popup.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

let server: Server
let port: number
const ids = { main: '', vp: '', ten: '', three: '', result: '', other: '', tenAsk: '', vpAsk: '', threeAsk: '' }
const HIS_REQUEST = '\u65b0\u4efb\u52a1\u9762\u677f\u592a\u5c0f\uff0c\u8981 10 \u4e2a\u8bbe\u8ba1\u9009'
const PICK_OF_TEN = '\u65b0\u5efa\u4efb\u52a1\u9762\u677f\uff1a10 \u4e2a\u65b9\u6848\uff0c\u8bf7\u6311\u4e00\u4e2a'
const VP_ASKS = '\u65b0\u5efa\u4efb\u52a1\u9762\u677f\uff1a\u65b0\u4e00\u7248 3 \u4e2a\u65b9\u6848\uff0c\u8bf7\u6311\u4e00\u4e2a\uff08\u63a8\u8350 A\uff09'
const TASK_ASKS = '\u65b0\u5efa\u4efb\u52a1\u9762\u677f\uff1a\u6309\u4f60\u7684\u56de\u7b54\u51fa\u65b0\u4e00\u7248 3 \u4e2a\u65b9\u6848\uff0c\u8bf7\u6311\u4e00\u4e2a'
const KIND = { user_kind: 'user_own', user_kind_why: 'A look of his own screen that only he picks', design_review: 'sol: function 8/10, experience 8/10, interface 8/10; nothing to change' }
const PICKS = [{ id: 'a', label: 'Design A (recommended)', recommended: true }, { id: 'b', label: 'Design B' }]

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

type Listed = OrgThread & { owner?: { task_id: string }; shown?: boolean; counted?: boolean; askedIn?: { task: string; via: string; thread?: string; answered?: true } }

/** What the VP's surfaces read for him now. */
async function vpReads() {
  await settleUserStatusSync()
  await syncUserStatuses(new Set([ids.main, ids.vp, ids.ten, ids.three]))
  const read = await api<{ threads: Listed[]; shown_count: number }>('GET', `/tasks/${ids.vp}/threads`)
  expect(read.status).toBe(200)
  const list = read.json.threads
  const one = (await api<{ thread: Listed }>('GET', `/tasks/${ids.vp}/threads/${ids.result}`)).json.thread
  const status = (await api<{ task: { user_status?: { threads?: { shown: number; needs: number } } } }>('GET', `/api/tasks/${ids.vp}`)).json.task.user_status?.threads
  const states = (await api<{ states: Record<string, { state: string; id: string }> }>('GET', `/thread-states?ids=${ids.vp}`)).json.states?.[ids.vp]
  return {
    inSight: list.filter((t) => t.counted).map((t) => t.id).sort(),
    web: listedForHim(list).map((t) => t.id).sort(),
    result: list.find((t) => t.id === ids.result),
    one: { state: one.state, shown: one.shown, counted: one.counted, askedIn: one.askedIn },
    header: read.json.shown_count,
    badge: status?.shown ?? 0,
    board: states,
  }
}

const refusal = async (p: Promise<unknown>) => p.then(() => null, (err: { code?: string; status?: number; message: string }) => err)

beforeAll(async () => {
  process.env.WALNUT_THREAD_FOLLOW = '0'
  // His reply stays on its way for the whole file: the tasks have no session to take it.
  process.env.WALNUT_THREAD_REPLY_GATHER_MS = '600000'
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  expect((await api('PUT', '/api/config', { experimental: { threads_pop_up: true, threads_one_card: true, brief_off: true } })).status).toBe(200)
  await vi.waitFor(() => expect(threadsPopUpNow()).toBe(true), { timeout: 5000 })
  ids.main = (await ensureMainTask()).id
  ids.vp = (await ensureProjectLead('Orchard')).id
  ids.ten = (await addTask({ title: 'Ten panel designs', project: 'Orchard', parent_task_id: ids.vp })).task.id
  ids.three = (await addTask({ title: 'Three panel designs', project: 'Orchard', parent_task_id: ids.vp })).task.id
  for (const id of [ids.ten, ids.three]) await updateTaskRaw(id, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  const result = (title: string, text: string) => openNodeThread(ids.vp, { title, text, from: 'node', state: 'answered', tasks: [ids.ten] }, `task:${ids.vp}`)
  // His own request to the VP, handed to a task, its result in (Done): no ask of the VP's.
  ids.result = (await result(HIS_REQUEST, 'Ten designs are on one page: /tmp/panel/ten.html')).id
  // Another result of the VP linked to the same task, on another subject.
  ids.other = (await result('Spring seed budget for the orchard: 40 trays ordered', 'Forty trays are ordered for the east rows.')).id
}, 120_000)

afterAll(async () => {
  await stopServer()
  delete process.env.WALNUT_THREAD_FOLLOW
  delete process.env.WALNUT_THREAD_REPLY_GATHER_MS
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('the 2026-11-24 VP: its result card beside the card of the task it was handed to', () => {
  it('before the task asks: both results of the VP are in his sight', async () => {
    const r = await vpReads()
    expect(r.inSight).toEqual([ids.result, ids.other].sort())
    expect(r).toMatchObject({ header: 2, badge: 2, one: { state: 'answered', shown: true, counted: true } })
  })

  it('while the task asks him: its card alone holds the subject, on every surface', async () => {
    ids.tenAsk = (await openNodeThread(ids.ten, {
      title: PICK_OF_TEN, text: 'Ten designs, one page.', from: 'node', state: 'needs',
      reply: 'Pick one of the ten designs; I recommend 9, the widest. Page: /tmp/panel/ten.html', options: PICKS, ...KIND,
    }, `task:${ids.ten}`)).id
    // The VP's result was written before the task asked, so it was in his view then: it stays there.
    const before = await vpReads()
    expect(before.inSight).toEqual([ids.tenAsk, ids.result, ids.other].sort())
    expect(before.one).toMatchObject({ state: 'answered', shown: true, counted: true })
    // The VP hears of the task's ask and writes its own card about it: a result, beside the task's ask.
    await patchThread(ids.vp, ids.result, { reply: 'Ten designs are on one page, and the task asks you to pick: /tmp/panel/ten.html', state: 'answered' }, `task:${ids.vp}`)
    const r = await vpReads()
    expect(r.inSight).toEqual([ids.tenAsk, ids.other].sort())
    expect(r.web).toEqual([ids.tenAsk, ids.other].sort())
    expect(r.result).toMatchObject({ state: 'pending', shown: false, counted: false, askedIn: { task: ids.ten, via: 'thread', thread: ids.tenAsk } })
    // One thread read alone says the same as the list, and so does the Board's state of the VP.
    expect(r.one).toMatchObject({ state: 'pending', shown: false, counted: false, askedIn: { thread: ids.tenAsk } })
    expect(r.board?.id).not.toBe(ids.result)
    expect({ header: r.header, badge: r.badge }).toEqual({ header: 2, badge: 2 })
    // The stored thread is untouched: the hold is a read, never a write.
    expect((await readThreads(ids.vp)).threads.find((t) => t.id === ids.result)?.state).toBe('answered')
  })

  it('he answers on the task\'s card: nothing of the subject is left for him, and the result does not come back', async () => {
    expect((await api('POST', `/tasks/${ids.vp}/threads`, { text: '6 and 8 are fine, 9 is not', thread: ids.tenAsk })).status).toBe(200)
    expect((await readThreads(ids.ten)).threads.find((t) => t.id === ids.tenAsk)?.state).not.toBe('needs')
    const r = await vpReads()
    expect(r.inSight).toEqual([ids.other])
    expect(r.result).toMatchObject({ state: 'pending', shown: false, counted: false, askedIn: { task: ids.ten, via: 'thread', thread: ids.tenAsk, answered: true } })
    expect(r.one).toMatchObject({ state: 'pending', shown: false, counted: false })
    expect({ header: r.header, badge: r.badge }).toEqual({ header: 1, badge: 1 })
  })

  it('the VP writing its card again, after his answer, is news', async () => {
    await new Promise((x) => setTimeout(x, 5))
    await patchThread(ids.vp, ids.result, { reply: 'A new set of three designs follows your answer: /tmp/panel/three.html', state: 'answered' }, `task:${ids.vp}`)
    const r = await vpReads()
    expect(r.inSight).toEqual([ids.result, ids.other].sort())
    expect(r.one).toMatchObject({ state: 'answered', shown: true, counted: true })
  })
})

describe('two asks of one decision: the second is refused at the write, never hidden', () => {
  it('the VP may not hand him a thread while the task\'s thread asks its subject', async () => {
    // The VP's own thread about the new designs (a result so far), naming the task that makes them.
    ids.vpAsk = (await openNodeThread(ids.vp, { title: VP_ASKS, text: 'Three new designs are being made.', from: 'node', state: 'answered', tasks: [ids.three] }, `task:${ids.vp}`)).id
    ids.threeAsk = (await openNodeThread(ids.three, {
      title: TASK_ASKS, text: 'Three designs, one page.', from: 'node', state: 'needs',
      reply: 'Pick one of the three designs; I recommend A. Page: /tmp/panel/three.html', options: PICKS, ...KIND,
    }, `task:${ids.three}`)).id
    const hand = { state: 'needs', reply: 'Three new designs are on one page; I recommend A, which keeps the host on the first row.', options: PICKS, ...KIND }
    const err = await refusal(patchThread(ids.vp, ids.vpAsk, hand as never, `task:${ids.vp}`))
    expect(err).toMatchObject({ code: 'same_subject', status: 409 })
    expect(err?.message).toContain(ids.threeAsk)
    expect(err?.message).toContain(ids.three)
    expect((await readThreads(ids.vp)).threads.find((t) => t.id === ids.vpAsk)?.state).toBe('answered')
    // Another decision, said so: it goes through. His own write is never asked.
    const other = await refusal(patchThread(ids.vp, ids.vpAsk, { ...hand, separate_reason: 'The accent colour, not which design' } as never, `task:${ids.vp}`))
    expect(other).toBeNull()
  })

  it('and the task may not hand him one while the VP\'s asks it', async () => {
    // The task's ask is settled; the VP's (handed to him above) stands. The task asks the same again.
    await patchThread(ids.three, ids.threeAsk, { state: 'working' }, `task:${ids.three}`)
    const err = await refusal(patchThread(ids.three, ids.threeAsk, { state: 'needs', reply: 'Pick one of the three designs; I recommend A.', options: PICKS, ...KIND, since_you_wrote: 'Nothing new.', decision: 'same' } as never, `task:${ids.three}`))
    expect(err).toMatchObject({ code: 'same_subject', status: 409 })
    expect(err?.message).toContain(ids.vpAsk)
  })
})
