/**
 * The one user status end to end, on a real server (src/core/user-status-sync.ts): the
 * server derives `task.user_status` from live facts (a running session, an unanswered
 * action_required letter, an unanswered Board choice) and the session's own report, keeps
 * it current as they move, and every surface reads the same value: the v1 projection the
 * phone reads, and the Org page's counts (2026-10-25: the same team read "0 needs you",
 * "1 needs you" and "11 handed back" on three surfaces). Only the Claude CLI is mocked; no
 * session is started here, the session records are written directly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-user-status-sync'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { answerLetter, sendLetter } from '../../src/core/human-inbox/store.js'
import { setBoardHtml } from '../../src/core/boards/board-store.js'
import type { Task } from '../../src/core/types.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

let server: HttpServer
let port: number

async function v1<T>(p: string): Promise<T> {
  const res = await fetch(`http://localhost:${port}/api/v1${p}`)
  return await res.json() as T
}

/** The derived status, once the server wrote one that passes `ok`. */
async function statusOf(id: string, ok: (t: Task) => boolean, timeoutMs = 15_000): Promise<Task> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const t = await getTask(id)
    if (t.user_status && ok(t)) return t
    if (Date.now() > until) throw new Error(`no matching user_status for ${id}: ${JSON.stringify(t.user_status ?? null)}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('user status sync', () => {
  it('derives each state from the facts and keeps it current as they move', async () => {
    const lead = (await addTask({ title: 'Team lead', project: 'Acme' })).task
    const make = async (title: string) => {
      const t = (await addTask({ title, project: 'Acme' })).task
      await updateTask(t.id, { parent_task_id: lead.id })
      return t
    }
    const running = await make('Running worker')
    const ended = await make('Turn ended with nothing to ask')
    const asks = await make('Asks the user by letter')
    const choice = await make('Has a Board choice')
    const todo = await make('Not started yet')

    // A running session.
    await createSessionRecord('sess-running-1', running.id, 'Acme')
    await updateSessionRecord('sess-running-1', { process_status: 'running' })
    await updateTask(running.id, { phase: 'IN_PROGRESS' })
    // A turn that ended and handed the task back (NEED_ACTION) with its report of done: nothing to
    // answer (2026-10-27), it waits on its lead to check and close it, with its words.
    await createSessionRecord('sess-ended-1', ended.id, 'Acme')
    await updateSessionRecord('sess-ended-1', { process_status: 'stopped' })
    await updateTask(ended.id, { phase: 'NEED_ACTION' })
    await updateTaskRaw(ended.id, { status_report: { state: 'done', now: 'Shipped it.', at: new Date(Date.now() + 1000).toISOString() } }, { emitEvent: true })
    // An unanswered action_required letter from the task.
    await createSessionRecord('sess-asks-1', asks.id, 'Acme')
    await updateTask(asks.id, { phase: 'NEED_ACTION' })
    const letter = await sendLetter({
      subject: 'Pick a design', type: 'action_required', markdown: 'A or B?',
      actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      sender: { sessionId: 'sess-asks-1', taskId: asks.id },
    } as never)
    // An unanswered choice on the lead's Board about the task, handed back.
    await updateTask(choice.id, { phase: 'NEED_ACTION' })
    await setBoardHtml(lead.id, `<html><body><walnut-choice id="c1" title="Which host?" options="a:Mac,b:Cloud" task="${choice.id}"></walnut-choice></body></html>`, { by: `task:${lead.id}` })

    expect((await statusOf(running.id, (t) => t.user_status!.state === 'working')).user_status).toMatchObject({ state: 'working' })
    expect((await statusOf(ended.id, (t) => t.user_status!.state === 'waiting')).user_status).toMatchObject({ state: 'waiting', kind: 'lead', now: 'Shipped it.' })
    expect((await statusOf(asks.id, (t) => t.user_status!.state === 'needs')).user_status).toMatchObject({ state: 'needs', source: 'letter', ask: 'Pick a design' })
    expect((await statusOf(choice.id, (t) => t.user_status!.state === 'needs')).user_status).toMatchObject({ state: 'needs', source: 'choice', ask: 'Which host?' })
    expect((await statusOf(todo.id, (t) => t.user_status!.state === 'waiting')).user_status).toMatchObject({ kind: 'not-started' })

    // The phone's projection carries the same value.
    const { tasks } = await v1<{ tasks: { id: string; user_status?: { state: string } }[] }>('/tasks')
    expect(tasks.find((t) => t.id === asks.id)?.user_status?.state).toBe('needs')
    expect(tasks.find((t) => t.id === ended.id)?.user_status?.state).toBe('waiting')

    // The Org page counts by it: the letter and the choice need the user, the turn that only ended does not.
    const reports = await v1<{ rows: { project?: string; needs_you: number; running: number }[] }>('/org/reports')
    const acme = reports.rows.find((r) => (r.project ?? '').toLowerCase() === 'acme')
    expect(acme?.needs_you).toBe(2)
    expect(acme?.running).toBe(1)

    // Facts move, the status follows: the letter answered, the session stopped.
    // As letter-ops.ts answerLetterAndDeliver does: record, then announce (no session to deliver to here).
    await answerLetter(letter.id, { actionId: 'a' })
    bus.emit('human-inbox:answered', { letterId: letter.id, actionId: 'a' }, ['web-ui'], { source: 'human-inbox' })
    // Answered, the letter is no longer what it asks (its delivery would also start a turn).
    await statusOf(asks.id, (t) => t.user_status!.source !== 'letter')
    // As the session runtime does when a turn ends: the record, then the event.
    await updateSessionRecord('sess-running-1', { process_status: 'stopped' })
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: 'sess-running-1', process_status: 'stopped' }, ['web-ui'], { source: 'session-tracker' })
    await statusOf(running.id, (t) => t.user_status!.state === 'waiting')

    // A completed task reads Done everywhere, and the sync never writes it: a write to a
    // COMPLETE row would announce the completion again to every listener.
    const writes: string[] = []
    bus.subscribe('test-status-writes', (e) => {
      const id = (e.data as { task?: { id?: string } })?.task?.id
      if (id === choice.id && e.source === 'user-status') writes.push(e.name)
    }, { global: true, interest: ['task:'] })
    await updateTask(choice.id, { phase: 'COMPLETE' })
    // Past the debounce and a pass: the sync never touched it.
    await new Promise((r) => setTimeout(r, 4_000))
    expect(writes).toEqual([])
    // The completing write itself stores Done (phase.ts phaseDerivedFields), not the sync.
    expect((await getTask(choice.id)).user_status?.state).toBe('done')
    const after = await v1<{ tasks: { id: string; phase: string }[] }>('/tasks?include_done=1')
    const row = after.tasks.find((t) => t.id === choice.id)
    if (row) expect(row.phase).toBe('COMPLETE')
    const org = await v1<{ rows: { project?: string; needs_you: number }[] }>('/org/reports')
    // The answered letter's task has no ask of its own left: a worker, it waits on its lead (2026-10-31,
    // the user: no Needs you without a concrete ask), so nothing in Acme needs the user now.
    expect(org.rows.find((r) => (r.project ?? '').toLowerCase() === 'acme')?.needs_you).toBe(0)
    expect((await getTask(asks.id)).user_status).toMatchObject({ state: 'waiting', kind: 'lead' })
    bus.unsubscribe('test-status-writes')
  }, 90_000)
})
