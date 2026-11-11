import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import type { Server } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-slot-wait-density'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { drainStartQueue } from '../../../src/core/sessions/start-queue.js'
import { __resetHostAdmissionForTesting, __setHostViewForTesting, slotHoldersOn } from '../../../src/core/sessions/host-admission.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'

let server: Server
let root: string
let unavailable = true
const spawned: string[] = []
const sid = '88888888-4444-5555-6666-000000000001'

async function boot() {
  server = await startServer({ port: 0, dev: true })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server port')
  root = `http://localhost:${address.port}`
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  process.env.WALNUT_START_QUEUE = '0'
  __setHostViewForTesting(async (host) => {
    const running = slotHoldersOn(host).length
    const full = unavailable || running >= 1
    return {
      host, label: 'One-slot host', known: true, running, runningLimit: 1,
      busy: full, reasons: full ? ['all slots taken'] : [],
      full, fullReasons: full ? ['all slots taken'] : [], score: full ? 0 : 1,
    }
  })
  vi.spyOn(sessionRunner, 'startSession').mockImplementation(async (data: any) => {
    spawned.push(data.taskId)
    await updateTaskRaw(data.taskId, { phase: 'IN_PROGRESS' })
    return { claudeSessionId: data.preassignedSessionId, title: data.title } as never
  })
  await boot()
}, 30_000)

afterAll(async () => {
  __setHostViewForTesting(null)
  __resetHostAdmissionForTesting()
  delete process.env.WALNUT_START_QUEUE
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('persistent automatic waits at real queue density', () => {
  it('ten concurrent starts survive server restart and share one slot without duplicates', async () => {
    const { task: parent } = await addTask({ title: 'Capacity leader', project: 'Capacity' })
    await createSessionRecord(sid, parent.id, parent.project, os.tmpdir(), { title: 'Capacity caller', initialProcessStatus: 'idle' })
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const { task } = await addTask({ title: `Capacity worker ${i}`, project: 'Capacity', parent_task_id: parent.id, cwd: os.tmpdir() })
      ids.push(task.id)
    }
    const answers = await Promise.all(ids.map(async (id) => {
      const res = await fetch(`${root}/api/v1/tasks/${id}/start`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': sid },
        body: JSON.stringify({ message: `Original work for ${id}`, expect_reply: false }),
      })
      return { status: res.status, body: await res.json() }
    }))
    for (const answer of answers) {
      expect(answer.status).toBe(202)
      expect(answer.body).toMatchObject({ started: false, queued: {} })
    }
    expect(spawned).toEqual([])
    const saved = await Promise.all(ids.map(async (id) => (await getTask(id)).start_queue))
    await stopServer()
    await boot()
    expect(await Promise.all(ids.map(async (id) => (await getTask(id)).start_queue))).toEqual(saved)
    expect((await drainStartQueue()).held).toHaveLength(10)

    unavailable = false
    for (let remaining = 10; remaining > 0; remaining--) {
      const passes = await Promise.all([drainStartQueue(), drainStartQueue(), drainStartQueue()])
      for (const pass of passes) {
        expect(pass.started).toHaveLength(1)
        expect(pass.held).toHaveLength(remaining - 1)
      }
      const id = passes[0].started[0]
      expect(spawned.filter((started) => started === id)).toHaveLength(1)
      expect(slotHoldersOn('__local__')).toEqual([id])
      expect((await getTask(id)).start_queue).toBeFalsy()
      await updateTaskRaw(id, { phase: 'COMPLETE' })
      __resetHostAdmissionForTesting()
    }
    expect(new Set(spawned)).toEqual(new Set(ids))
    expect(spawned).toHaveLength(10)
    expect((await drainStartQueue()).started).toEqual([])
  }, 60_000)
})
