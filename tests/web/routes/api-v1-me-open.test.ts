/**
 * What is still open for a session's task (GET /api/v1/me/open + the open_items
 * op), which every Claude Code session reads back right after a compaction
 * through its SessionStart hook (src/providers/compact-open-items-hook.ts).
 *
 * Real startServer({ port: 0, dev: true }) with an isolated home; the caller is a
 * real session record whose task has real subtasks, and the requests are real
 * rows in the request store. Nothing is faked.
 *
 * The contract pinned here:
 *   - unfinished DIRECT subtasks only: a finished one and a grandchild stay out;
 *   - pending requests both ways, a settled one never;
 *   - a caller with no task (no header, an unknown id) gets nothing, so the hook
 *     injects nothing;
 *   - the op's hook mode prints exactly the JSON a SessionStart hook reads, and
 *     `{}` when nothing is open;
 *   - the list stays a few lines however many subtasks there are.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-me-open'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, completeTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { createSessionRequest, settleReplied } from '../../../src/core/session-requests.js'
import { executeOp } from '../../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import '../../../src/ops/index.js'

let server: HttpServer
let port: number

const api = (p: string): string => `http://localhost:${port}${p}`

async function open(sid?: string): Promise<Record<string, any>> {
  const res = await fetch(api('/api/v1/me/open'), { headers: sid ? { 'x-walnut-caller-sid': sid } : {} })
  expect(res.status).toBe(200)
  return await res.json() as Record<string, any>
}

let seq = 0
async function seedSession(title: string, parent?: string): Promise<{ id: string; sid: string }> {
  seq += 1
  const { task } = await addTask({ title, project: 'Acme', ...(parent ? { parent_task_id: parent } : {}) })
  const sid = `22222222-3333-4444-5555-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, task.id, 'Acme', '/repo/acme', { title })
  return { id: task.id, sid }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/me/open', () => {
  it('a caller with no task gets nothing: no header, an unknown id', async () => {
    for (const body of [await open(), await open('not-a-session')]) {
      expect(body).toMatchObject({ subtasks: [], waitingOn: [], askedOfYou: [], text: '' })
      expect(body.task).toBeUndefined()
    }
  })

  it('a task with nothing open: empty text, so the hook injects nothing', async () => {
    const parent = await seedSession('Quiet parent')
    const { task: done } = await addTask({ title: 'Already done', project: 'Acme', parent_task_id: parent.id })
    await completeTask(done.id)
    const body = await open(parent.sid)
    expect(body.task.id).toBe(parent.id)
    expect(body.subtasks).toEqual([])
    expect(body.text).toBe('')
  })

  it('a task with a Board is never "nothing open": one line with version, threads, user messages and marks', async () => {
    // A compaction summary that forgot the board leaves the user reading a stale page.
    const leader = await seedSession('Leads with a board')
    const { setBoardHtml, postBoardMessage, setBoardMark } = await import('../../../src/core/boards/board-store.js')
    await setBoardHtml(leader.id, '<html><walnut-thread id="a"></walnut-thread></html>', { by: `task:${leader.id}` })
    await postBoardMessage(leader.id, 'a', { author: 'user', text: 'Why is this red?' })
    await postBoardMessage(leader.id, 'a', { author: `task:${leader.id}`, text: 'Because.' })
    await postBoardMessage(leader.id, 'b', { author: 'user', text: 'And this?' })
    await setBoardMark(leader.id, 'a', { state: 'revisit' })
    const body = await open(leader.sid)
    expect(body.subtasks).toEqual([])
    expect(body.board).toEqual({ version: 1, updatedAt: expect.any(String), threads: 2, userMessages: 2, marks: 1 })
    expect(body.text).toContain('Your task has a Board (version 1, 2 threads, 2 messages from the user, 1 mark): the user follows your work there. board_get reads it; keep it current (skill walnut-board).')
    // A task without a board has no such line.
    const plain = await seedSession('No board')
    expect((await open(plain.sid)).board).toBeUndefined()
  })

  it('lists unfinished direct subtasks and pending requests both ways, nothing settled', async () => {
    const parent = await seedSession('Ship the marina dashboard')
    const a = await seedSession('Build the page', parent.id)
    const b = await seedSession('Wire the API 测试', parent.id)
    const finished = await seedSession('Write the spec', parent.id)
    await completeTask(finished.id)
    const grandchild = await seedSession('Fix one test', a.id)

    const waiting = await createSessionRequest({ fromSessionId: parent.sid, toTaskId: a.id, text: 'Tell me when the page renders' })
    const answered = await createSessionRequest({ fromSessionId: parent.sid, toTaskId: b.id, text: 'Old question' })
    await settleReplied(answered.id)
    const asked = await createSessionRequest({ fromSessionId: b.sid, toTaskId: parent.id, text: 'Which currency first?' })

    const body = await open(parent.sid)
    expect(body.task).toEqual({ id: parent.id, title: 'Ship the marina dashboard' })
    expect(body.subtasks.map((t: { id: string }) => t.id).sort()).toEqual([a.id, b.id].sort())
    expect(body.moreSubtasks).toBe(0)
    expect(body.waitingOn).toEqual([expect.objectContaining({ id: waiting.id, to: a.id })])
    expect(body.askedOfYou).toEqual([expect.objectContaining({ id: asked.id, from: b.id })])

    const text = body.text as string
    expect(text).toContain(`${a.id} [TODO] Build the page`)
    expect(text).toContain('Wire the API 测试')
    expect(text).toContain(`${waiting.id} to ${a.id}`)
    expect(text).toContain(`${asked.id} from ${b.id}`)
    expect(text).toContain('task_send in_reply_to')
    for (const absent of [finished.id, grandchild.id, answered.id]) expect(text).not.toContain(absent)
  })

  it('stays a few lines: 20 subtasks listed, the rest counted, long titles cut', async () => {
    const parent = await seedSession('Big fan-out')
    const long = `Investigate ${'very '.repeat(40)}long title\nwith a newline`
    for (let i = 0; i < 25; i++) await addTask({ title: i === 0 ? long : `Shard ${i}`, project: 'Acme', parent_task_id: parent.id })
    const body = await open(parent.sid)
    expect(body.subtasks).toHaveLength(20)
    expect(body.moreSubtasks).toBe(5)
    const text = body.text as string
    expect(text).toContain('Unfinished subtasks of your task (25):')
    expect(text).toContain(`and 5 more: task_list with parent_task_id ${parent.id}`)
    for (const line of text.split('\n')) expect(line.length).toBeLessThan(300)
    expect(text.split('\n').length).toBeLessThan(30)
  })

  it('a title cut never splits an emoji (the hook JSON carries no lone surrogate)', async () => {
    const parent = await seedSession('Emoji parent')
    // U+1F600 is two UTF-16 units; placed on units 88-89 it straddles the 89-unit cut.
    const title = `${'a'.repeat(88)}\u{1F600}${'b'.repeat(20)}`
    const { task: child } = await addTask({ title, project: 'Acme', parent_task_id: parent.id })
    const res = await fetch(api('/api/v1/me/open'), { headers: { 'x-walnut-caller-sid': parent.sid } })
    const raw = await res.text()
    expect(raw).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i)
    const text = (JSON.parse(raw) as { text: string }).text
    expect(text).toContain(`${child.id} [TODO] ${'a'.repeat(88)}…`)
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})

describe('open_items op', () => {
  it('hook mode prints the SessionStart hook JSON, and {} when nothing is open', async () => {
    const parent = await seedSession('Hooked parent')
    const child = await seedSession('Hooked child', parent.id)
    const apiBase = `http://localhost:${port}`
    const r = await executeOp('open_items', { hook: 'compact' }, { apiBase, callerSid: parent.sid, origin: LOCAL_ORIGIN })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const out = (r as { result: any }).result
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext).toContain(`${child.id} [TODO] Hooked child`)
    expect(Object.keys(out)).toEqual(['hookSpecificOutput'])

    await completeTask(child.id)
    const none = await executeOp('open_items', { hook: 'compact' }, { apiBase, callerSid: parent.sid, origin: LOCAL_ORIGIN })
    expect(none.ok).toBe(true)
    expect((none as { result: unknown }).result).toEqual({})
  })

  it('called directly: the lists plus an outcome', async () => {
    const parent = await seedSession('Direct parent')
    await seedSession('Direct child', parent.id)
    const r = await executeOp('open_items', {}, { apiBase: `http://localhost:${port}`, callerSid: parent.sid, origin: LOCAL_ORIGIN })
    expect(r.ok).toBe(true)
    const out = (r as { result: any }).result
    expect(out.subtasks).toHaveLength(1)
    expect(out.outcome).toBe('These are still open for your task.')
  })
})
