/**
 * The premise behind letting a paired device or an API key run a trigger check
 * on this Mac (src/core/routines/check-host-policy.ts): both can already start a
 * coding session here, which does everything a check does. If a later change
 * narrows who may launch a session, this file fails, and the check rule (and the
 * Apple Health section of docs/reference/api-v1.md, which says the same) must be
 * narrowed with it.
 *
 * Real auth middleware and real routes, requests from this machine's private
 * IPv4 address. The launch cores are spies: nothing is started.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-paired-client-starts-work'))

const launches = vi.hoisted(() => ({ mobile: [] as unknown[], task: [] as unknown[] }))
vi.mock('../../../src/core/sessions/mobile-launch.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/core/sessions/mobile-launch.js')>(),
  performMobileLaunch: async (input: unknown) => {
    launches.mobile.push(input)
    return { sessionId: 'sid-launched', taskId: 'task-launched', title: 'Launched' }
  },
}))
vi.mock('../../../src/core/sessions/task-start.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/core/sessions/task-start.js')>(),
  startSessionForTask: async (input: unknown) => {
    launches.task.push(input)
    return { accepted: true }
  },
}))

import { authMiddleware } from '../../../src/web/middleware/auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { sessionLaunchV1Router } from '../../../src/web/routes/session-launch-v1.js'
import { taskV1Router } from '../../../src/web/routes/task-v1.js'
import { createDevice } from '../../../src/core/device-auth.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { getOp } from '../../../src/ops/index.js'

const API_KEY = 'wlnt_sk_paired_client_starts_work'

/** A private IPv4 address of this machine, when it has one (a laptop on Wi-Fi does). */
function privateIpv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const [p0, p1] = a.address.split('.').map(Number)
      if (p0 === 10 || (p0 === 172 && p1 >= 16 && p1 <= 31) || (p0 === 192 && p1 === 168)) return a.address
    }
  }
  return null
}
const LAN_IP = privateIpv4()

it('task_start and session_start are not local-only, so the actions route runs them for a paired client', () => {
  for (const name of ['task_start', 'session_start']) {
    const op = getOp(name)!
    expect(op.tags.remote, name).toBe('allow')
    expect(op.tags.localHostGateway, name).toBeFalsy()
  }
})

describe.skipIf(!LAN_IP)('a paired device and an API key start a coding session on this Mac', () => {
  let server: http.Server
  let port = 0
  let deviceToken = ''

  beforeAll(async () => {
    deviceToken = (await createDevice('lan-phone')).token
    await updateConfig({ api_keys: [{ name: 'script', key: API_KEY, created_at: new Date().toISOString() }] })
    // Same order as server.ts: the global auth on /api, then the routers.
    const app = express()
    app.use(express.json())
    app.use('/api', authMiddleware)
    app.use('/api/v1', sessionLaunchV1Router)
    app.use('/api/v1', taskV1Router)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    _resetAuthRateLimitForTesting()
    launches.mobile.length = 0
    launches.task.length = 0
  })

  function lanPost(p: string, headers: Record<string, string>, body: unknown): Promise<number> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body)
      const req = http.request({
        host: LAN_IP!, port, path: p, method: 'POST', localAddress: LAN_IP!,
        headers: { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
      req.on('error', reject)
      req.end(payload)
    })
  }

  it('POST /api/v1/sessions and POST /api/v1/tasks/:id/start reach the launch core', async () => {
    for (const token of [deviceToken, API_KEY]) {
      const auth = { authorization: `Bearer ${token}` }
      expect(await lanPost('/api/v1/sessions', auth, { cwd: '/tmp', message: 'hi' })).toBe(201)
      expect(await lanPost('/api/v1/tasks/task-1/start', auth, { message: 'go' })).toBe(202)
    }
    // No host named: the launch runs on the primary box, this Mac.
    expect(launches.mobile).toHaveLength(2)
    for (const input of launches.mobile) expect((input as { host?: string }).host || '').toBe('')
    expect(launches.task).toHaveLength(2)
  })

  it('without a credential the same requests are refused and nothing launches', async () => {
    expect(await lanPost('/api/v1/sessions', {}, { cwd: '/tmp', message: 'hi' })).toBe(401)
    expect(await lanPost('/api/v1/tasks/task-1/start', {}, { message: 'go' })).toBe(401)
    expect(launches.mobile).toHaveLength(0)
    expect(launches.task).toHaveLength(0)
  })
})
