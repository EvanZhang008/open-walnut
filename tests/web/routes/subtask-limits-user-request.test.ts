/**
 * The running-subtask brake's two 2026-10-27 additions (core/sessions/subtask-limits.ts):
 * a start the user asked for (`user_request`, their own words) goes past the 8
 * up to a ceiling of 16, and a subtask waiting for its isolated workspace counts
 * as running, so workspace starts cannot fan out around the brake.
 *
 * Its own file and server: the older subtask-limits file makes a background
 * model call that the test guard blames on whichever test is running.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-subtask-user-request'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import {
  MAX_RUNNING_SUBTASKS, MAX_RUNNING_SUBTASKS_USER_ASKED, SubtaskLimitError, admitSubtaskStart,
} from '../../../src/core/sessions/subtask-limits.js'
import { admitStartWithinLimits } from '../../../src/core/sessions/task-start.js'
import { QuickStartError } from '../../../src/core/sessions/quick-start.js'

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`

let seq = 0
async function sessionFor(taskId: string, project: string): Promise<string> {
  seq += 1
  const sid = `33333333-4444-5555-6666-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, taskId, project, `/repo/${project}`, { title: `Session ${seq}` })
  return sid
}

async function children(parentId: string, phases: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const [i, phase] of phases.entries()) {
    const { task } = await addTask({ title: `Child ${i}`, project: 'fanout', parent_task_id: parentId })
    if (phase !== 'TODO') await updateTaskRaw(task.id, { phase: phase as never })
    ids.push(task.id)
  }
  return ids
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

describe('running subtasks: the user\'s ask and workspace starts', () => {
  it('a start the user asked for goes past the brake, up to the higher ceiling, and no further', async () => {
    // 2026-10-27: a start the user wanted now could only wait behind eight running workers.
    const { task: lead } = await addTask({ title: 'Lead at the brake', project: 'fanout' })
    await children(lead.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const sid = await sessionFor(lead.id, 'fanout')
    const words = 'start the release notes task now, do not wait'

    const [asked] = await children(lead.id, ['TODO'])
    const target = await getTask(asked)
    await expect(admitStartWithinLimits(target, sid)).rejects.toBeInstanceOf(SubtaskLimitError)
    const refusal = await admitStartWithinLimits(target, sid).catch((e: unknown) => e) as SubtaskLimitError
    // The brake names the way past it, so the session can act on the user's ask.
    expect(refusal.message).toContain('user_request')
    ;(await admitStartWithinLimits(target, sid, words))()

    // A token is not the user's words.
    await expect(admitStartWithinLimits(target, sid, 'now')).rejects.toBeInstanceOf(QuickStartError)

    // Fill to the ceiling: even the user's ask stops there (a loop on the claim stops here).
    await children(lead.id, Array(MAX_RUNNING_SUBTASKS_USER_ASKED - MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const ceiling = await admitStartWithinLimits(target, sid, words).catch((e: unknown) => e) as SubtaskLimitError
    expect(ceiling).toBeInstanceOf(SubtaskLimitError)
    expect(ceiling.code).toBe('too_many_running_subtasks')
    expect(ceiling.message).toContain(`at most ${MAX_RUNNING_SUBTASKS_USER_ASKED} run at once`)
    expect(ceiling.message).toContain('task_stop')
  })

  it('the start route refuses at the brake without user_request, and refuses a token in its place', async () => {
    const { task: lead } = await addTask({ title: 'Lead route', project: 'fanout' })
    await children(lead.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const [waiting] = await children(lead.id, ['TODO'])
    const sid = await sessionFor(lead.id, 'fanout')
    const start = (body: Record<string, unknown>) => fetch(api(`/api/v1/tasks/${waiting}/start`), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': sid },
      body: JSON.stringify(body),
    })

    const plain = await start({ message: 'go' })
    expect(plain.status).toBe(409)
    expect(((await plain.json()) as { error: { code: string } }).error.code).toBe('too_many_running_subtasks')

    // A too-short quote is a 400 and records nothing.
    const token = await start({ message: 'go', user_request: 'now' })
    expect(token.status).toBe(400)
    expect((await getTask(waiting)).last_start).toBeUndefined()
  })
  it('a subtask waiting for its isolated workspace counts as running (the brake holds for workspace starts)', async () => {
    const { task: lead } = await addTask({ title: 'Workspace fan-out', project: 'fanout' })
    const waiting = await children(lead.id, Array(MAX_RUNNING_SUBTASKS).fill('TODO'))
    for (const id of waiting) {
      await updateTaskRaw(id, { workspace: {
        provider: 'git-worktree', host: '__local__', anchor: '/repo', repos: [], state: 'creating',
        pending_start: { via: 'task-start', message: 'go', at: new Date().toISOString() },
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      } as never })
    }
    const [next] = await children(lead.id, ['TODO'])
    await expect(admitSubtaskStart(lead.id, next)).rejects.toBeInstanceOf(SubtaskLimitError)
  })
})
