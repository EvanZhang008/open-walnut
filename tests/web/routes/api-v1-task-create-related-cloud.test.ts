/**
 * The related-open-tasks check never runs on a cloud REPLICA: a replica keeps no
 * session registry, so every caller resolves to `unknown`
 * (src/core/sessions/caller-placement.ts) and its creates are drained to the primary,
 * where refusing one would remove a task its caller was told exists.
 * Real startServer with the constants mock forcing CLOUD_MODE (as in
 * api-v1-task-create-cloud.test.ts), the check turned ON for this file.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskcreate-related-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { addTask, listTasks } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { _injectRelatedLookupForTesting } from '../../../src/core/sessions/related-open-tasks.js'

let server: HttpServer
let port: number
let token: string

beforeAll(async () => {
  process.env.WALNUT_RELATED_CHECK = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  token = (await createDevice('related-cloud-test-phone')).token
}, 30_000)

afterAll(async () => {
  _injectRelatedLookupForTesting(null)
  delete process.env.WALNUT_RELATED_CHECK
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a replica caller is untouched', () => {
  it('a look-alike create with a session header is created, and the lookup never runs', async () => {
    const lookup = vi.fn(async () => { throw new Error('must not be called on a replica') })
    _injectRelatedLookupForTesting(lookup)
    const { task } = await addTask({ title: 'Fix iOS keyboard layout', project: 'marina' })
    const sid = 'cccccccc-2222-3333-4444-000000000001'
    await createSessionRecord(sid, task.id, 'marina', '/repo/marina', { title: 'caller' })
    const before = (await listTasks()).length
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`http://localhost:${port}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-walnut-caller-sid': sid },
        body: JSON.stringify({ title: 'Fix iOS keyboard layout', project: 'marina' }),
      })
      expect(res.status).toBe(201)
    }
    expect((await listTasks()).length).toBe(before + 2)
    expect(lookup).not.toHaveBeenCalled()
  })
})
