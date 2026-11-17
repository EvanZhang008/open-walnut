/**
 * /api/tasks/:id/changes routes (src/web/routes/task-changes.ts) through a REAL server
 * (startServer({ port: 0, dev: true })) and the real task store: the change links a provider reads,
 * a Refresh that reads and stores them, the experiment switched off, and a stage's live detail with
 * its one-minute cache and its deadline answer. The provider is a neutral review service registered
 * the way a plugin's is; nothing reaches a real service.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-changes-routes'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask } from '../../src/core/task-manager.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { registerChangeProvider } from '../../src/core/changes/registry.js'
import { startChangeWatch } from '../../src/core/changes/watch.js'
import { _resetStageDetailForTesting } from '../../src/core/changes/stage-detail.js'
import type { ChangeSnapshot, ChangeStageDetail } from '../../src/core/changes/model.js'

const CR = 'https://review.acme.dev/r/1001'
let server: HttpServer
let port: number
let taskId = ''
let stageCalls: string[] = []
let reads = 0
let watch: { stop(): void } | null = null

const url = (path: string) => `http://127.0.0.1:${port}${path}`
const getJson = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const res = await fetch(url(path), init)
  return { status: res.status, body: await res.json() as T }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  registerChangeProvider('acme', {
    id: 'acme:reviews',
    handles: (link) => link.url.startsWith('https://review.acme.dev/'),
    read: async (links) => {
      reads++
      return new Map(links.map((l) => [l.url, { ok: true, snapshot: { label: 'CR-1001', title: 'Fix login', review: { state: 'merged' }, deploy: { pipeline: 'acme-deployer', stages: [{ name: 'beta', status: 'failed' }, { name: 'slow', status: 'running' }], done: false } } }]))
    },
    stageDetail: async (_link, stage, ctx) => {
      stageCalls.push(stage)
      if (stage === 'slow') await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve))
      return { stage, steps: [{ name: 'Integration Test', status: 'failed', note: '2 failed' }], blockers: [{ kind: 'failure', text: 'Integration Test failed' }] } satisfies ChangeStageDetail
    },
  })
  watch = await startChangeWatch()
  taskId = (await addTask({ title: 'Fix login', project: 'Local', source: 'local', tags: [`cr:${CR}`, 'notes:/home/u/plan.md'] } as never)).task.id
})

afterAll(async () => {
  watch?.stop()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  stageCalls = []
  _resetStageDetailForTesting()
  await updateConfig({ experimental: { change_status: true } })
})

describe('GET and refresh', () => {
  it('lists the change links a provider reads, unread first, then read and stored by a Refresh', async () => {
    const before = await getJson<{ enabled: boolean; changes: ChangeSnapshot[] }>(`/api/tasks/${taskId}/changes`)
    expect(before.status).toBe(200)
    expect(before.body.enabled).toBe(true)
    expect(before.body.changes).toHaveLength(1)
    expect(before.body.changes[0]).toMatchObject({ provider: 'acme:reviews', url: CR })

    const after = await getJson<{ enabled: boolean; changes: ChangeSnapshot[]; stale?: boolean }>(`/api/tasks/${taskId}/changes/refresh`, { method: 'POST' })
    expect(after.status).toBe(200)
    expect(after.body.stale).toBeUndefined()
    expect(after.body.changes[0]).toMatchObject({ label: 'CR-1001', review: { state: 'merged' }, nextAt: expect.any(String) })
    expect(after.body.changes[0]!.checkedAt).not.toBe('')
    expect((await getTask(taskId)).change_status?.[CR]?.review?.state).toBe('merged')
  })

  it('off: says so and reads nothing', async () => {
    await updateConfig({ experimental: { change_status: false } })
    const was = reads
    const res = await getJson<{ enabled: boolean }>(`/api/tasks/${taskId}/changes/refresh`, { method: 'POST' })
    expect(res.body.enabled).toBe(false)
    expect(reads).toBe(was)
  })
})

describe('a stage\'s detail', () => {
  const stagePath = (stage: string, link = CR) => `/api/tasks/${taskId}/changes/stage?url=${encodeURIComponent(link)}&stage=${stage}`

  it('reads it live once a minute at most, and two asks at once share one read', async () => {
    const [first] = await Promise.all([getJson<{ detail: ChangeStageDetail | null }>(stagePath('beta')), getJson(stagePath('beta'))])
    expect(first.body.detail).toMatchObject({ stage: 'beta', steps: [{ name: 'Integration Test', status: 'failed' }] })
    await getJson(stagePath('beta'))
    expect(stageCalls).toEqual(['beta'])
  })

  it('reads only a stage the stored snapshot names, and nothing with the experiment off', async () => {
    expect((await getJson(stagePath('gamma'))).status).toBe(404)
    await updateConfig({ experimental: { change_status: false } })
    expect(await getJson(stagePath('beta'))).toEqual({ status: 409, body: { detail: null, error: 'disabled' } })
    expect(stageCalls).toEqual([])
  })

  it('answers a timeout instead of hanging', async () => {
    _resetStageDetailForTesting(300)
    const started = Date.now()
    const res = await getJson<{ detail: null; error?: string }>(stagePath('slow'))
    expect(res.body).toEqual({ detail: null, error: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('refuses a link the task does not hold, and a request without url or stage', async () => {
    expect((await getJson(`/api/tasks/${taskId}/changes/stage?url=${encodeURIComponent('https://review.acme.dev/r/9')}&stage=beta`)).status).toBe(404)
    expect((await getJson(`/api/tasks/${taskId}/changes/stage?stage=beta`)).status).toBe(400)
    expect(stageCalls).toEqual([])
  })
})
