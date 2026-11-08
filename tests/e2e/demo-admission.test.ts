import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('walnut-demo-admission'))
import { startServer, stopServer } from '../../src/web/server.js'
import { listSessions } from '../../src/core/session-tracker.js'
import { listTasks } from '../../src/core/task-manager.js'
import {
  enqueueMessage, getQueue, markNextProcessing, markProcessing, sendMessageToSession,
} from '../../src/core/session-message-queue.js'
import {
  closeDemoWork, demoAdmissionClosed, DemoAdmissionClosedError, resetDemoAdmissionForTests,
} from '../../src/core/sessions/demo-admission.js'
import { waitUntilArmed, WAIT_UNTIL_SEND_SOURCE } from '../../src/core/task-wait-until.js'
import { trackedPromiseAlarms } from '../../src/core/sessions/promise-alarm.js'

let server: Server
let root: string
let stopping = false
beforeAll(async () => {
  server = await startServer({
    port: 0, dev: true, bindAddress: '127.0.0.1',
    beforeRoutes: (_req, res, next) => {
      if (stopping) { res.status(503).json({ error: 'Demo is stopping' }); return }
      next()
    },
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server address')
  root = `http://127.0.0.1:${address.port}`
}, 120_000)
afterAll(async () => {
  resetDemoAdmissionForTests()
  await stopServer({ dropConnections: true })
})

describe('Demo admission over a real isolated server', () => {
  it('serves its config on loopback, then refuses new work before route execution', async () => {
    const address = server.address()
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1')
    expect((await fetch(`${root}/api/config`)).status).toBe(200)
    const before = (await listSessions()).length
    const tasksBefore = (await listTasks()).length
    stopping = true
    const create = await fetch(`${root}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Must not be created while Demo stops' }),
    })
    expect(create.status).toBe(503)
    expect(await create.json()).toEqual({ error: 'Demo is stopping' })
    expect((await listSessions()).length).toBe(before)
    expect((await listTasks()).length).toBe(tasksBefore)
    expect((await fetch(`${root}/api/config`)).status).toBe(503)
  })
})

describe('Demo stop fence inside the process (core/sessions/demo-admission.ts)', () => {
  const sid = 'demo-fence-session'

  it('a stop that fails stays closed: an internal wake or retry neither queues nor hands a row to a launch', async () => {
    // A row a timer queued before the stop began.
    const before = await enqueueMessage(sid, 'queued before the stop')
    expect((await getQueue(sid)).map((m) => m.id)).toEqual([before.id])
    const sessionsBefore = (await listSessions()).length

    // The Demo stop's first step, then a failure further on (stopDemoProcesses refusing).
    const failedStop = (async () => {
      await closeDemoWork()
      throw new Error('Demo session did not confirm its stop; data was kept')
    })()
    expect(demoAdmissionClosed()).toBe(true) // closed before the stop's first await
    await expect(failedStop).rejects.toThrow(/did not confirm/)
    expect(demoAdmissionClosed()).toBe(true)
    expect(waitUntilArmed()).toBe(false)
    expect(trackedPromiseAlarms().size).toBe(0)

    // A wait_until clock already in flight, an alarm, a direct enqueue: all refused.
    await expect(sendMessageToSession(sid, 'wake from a clock', { source: WAIT_UNTIL_SEND_SOURCE }))
      .rejects.toBeInstanceOf(DemoAdmissionClosedError)
    await expect(sendMessageToSession('demo-fence-other', 'promise alarm', { source: 'promise-alarm' }))
      .rejects.toThrow('Demo is stopping; no new work is accepted')
    await expect(enqueueMessage(sid, 'retry')).rejects.toBeInstanceOf(DemoAdmissionClosedError)

    // The delivery points a live write or a cold --resume reads from take nothing.
    expect(await markProcessing(sid, null, { midTurn: false })).toEqual([])
    expect(await markNextProcessing(sid)).toEqual([])
    const after = await getQueue(sid)
    expect(after.map((m) => [m.id, m.status])).toEqual([[before.id, 'pending']])
    expect(await getQueue('demo-fence-other')).toEqual([])
    expect((await listSessions()).length).toBe(sessionsBefore)

    // A retried stop closes it again; nothing in the server reopens it.
    await closeDemoWork()
    expect(demoAdmissionClosed()).toBe(true)
  })

  it('Demo stop closes the fence before its first await and never reopens it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/demo-server.ts'), 'utf8')
    const body = src.slice(src.indexOf('const stop = (): Promise<void> => {'))
    expect(body.indexOf('closeDemoWork()')).toBeGreaterThan(0)
    expect(body.indexOf('closeDemoWork()')).toBeLessThan(body.indexOf('await '))
    const srcRoot = path.join(__dirname, '../../src')
    const reopeners: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name) && !full.endsWith('demo-admission.ts')
          && fs.readFileSync(full, 'utf8').includes('resetDemoAdmissionForTests')) reopeners.push(full)
      }
    }
    walk(srcRoot)
    expect(reopeners).toEqual([])
  })
})
