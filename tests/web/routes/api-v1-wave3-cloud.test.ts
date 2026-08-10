/**
 * /api/v1 Wave 3 — CLOUD_MODE (REPLICA) behavior across the Wave-3 routers:
 *
 * - library-v1: agent WRITES answer 501 (machine-local config, no write-back);
 *   agent READS + commands/skills/repositories stay local (git-synced).
 * - console-extras-v1: usage / qmd / timeline / heartbeat-runner answer 501;
 *   config/providers + integrations + heartbeat checklist answer locally.
 * - routines-v1 draft: relays as `server.routines.draft` over the bridge.
 * - projects-v1 metadata PUT + summary regenerate answer 501; metadata GET local.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-wave3-cloud', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
}))

import express from 'express'
import request from 'supertest'
import { libraryV1Router } from '../../../src/web/routes/library-v1.js'
import { consoleExtrasV1Router } from '../../../src/web/routes/console-extras-v1.js'
import { routinesV1Router } from '../../../src/web/routes/routines-v1.js'
import { projectsV1Router } from '../../../src/web/routes/projects-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', libraryV1Router)
  app.use('/api/v1', consoleExtrasV1Router)
  app.use('/api/v1', routinesV1Router)
  app.use('/api/v1', projectsV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('library on a REPLICA', () => {
  it('agent writes answer 501 not_supported_cloud; reads stay local', async () => {
    const app = createApp()
    for (const call of [
      request(app).post('/api/v1/agents').send({ id: 'x', name: 'X' }),
      request(app).patch('/api/v1/agents/general').send({ name: 'Y' }),
      request(app).delete('/api/v1/agents/general'),
      request(app).post('/api/v1/agents/general/clone').send({ id: 'copy' }),
    ]) {
      const res = await call
      expect(res.status).toBe(501)
      expect(res.body.error.code).toBe('not_supported_cloud')
    }
    // Reads answer with the replica's own (builtin) agents.
    const detail = await request(app).get('/api/v1/agents/general')
    expect(detail.status).toBe(200)
    expect(detail.body.agent.id).toBe('general')
  })

  it('commands and repositories stay writable (git-synced dirs)', async () => {
    const app = createApp()
    const cmd = await request(app).post('/api/v1/commands').send({ name: 'c1', content: 'body' })
    expect(cmd.status).toBe(201)
    const repo = await request(app).post('/api/v1/repositories/r1').send({ content: 'name: r1\n' })
    expect(repo.status).toBe(200)
  })
})

describe('console extras on a REPLICA', () => {
  it('primary-bound stores answer 501', async () => {
    const app = createApp()
    for (const p of [
      '/api/v1/usage/summary', '/api/v1/usage/daily', '/api/v1/usage/by-source',
      '/api/v1/usage/by-model', '/api/v1/usage/by-agent', '/api/v1/usage/recent',
      '/api/v1/qmd/status', '/api/v1/timeline', '/api/v1/timeline/dates',
      '/api/v1/heartbeat',
    ]) {
      const res = await request(app).get(p)
      expect(res.status, p).toBe(501)
      expect(res.body.error.code, p).toBe('not_supported_cloud')
    }
    const trigger = await request(app).post('/api/v1/heartbeat/trigger')
    expect(trigger.status).toBe(501)
    const toggle = await request(app).post('/api/v1/timeline/toggle')
    expect(toggle.status).toBe(501)
  })

  it('pricing / providers / integrations / checklist answer locally', async () => {
    const app = createApp()
    expect((await request(app).get('/api/v1/usage/pricing')).status).toBe(200)
    const providers = await request(app).get('/api/v1/config/providers')
    expect(providers.status).toBe(200)
    expect(providers.body.cloud).toBe(true)
    expect((await request(app).get('/api/v1/integrations')).status).toBe(200)
    expect((await request(app).get('/api/v1/heartbeat/checklist')).status).toBe(200)
  })
})

describe('routines draft on a REPLICA', () => {
  it('relays server.routines.draft with the text', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { draft: { name: 'X' } } })
    const res = await request(createApp()).post('/api/v1/routines/draft').send({ text: 'every morning say hi' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ draft: { name: 'X' } })
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.routines.draft', sessionId: '__server__', params: { text: 'every morning say hi' } },
      30_000,
    )
  })

  it('empty text is a local 400 (no bridge round trip)', async () => {
    const res = await request(createApp()).post('/api/v1/routines/draft').send({ text: '  ' })
    expect(res.status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('bridge offline → 503 bridge_offline', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).post('/api/v1/routines/draft').send({ text: 'remind me' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })
})

describe('project metadata on a REPLICA', () => {
  it('GET metadata answers locally; PUT + summary regenerate answer 501', async () => {
    const app = createApp()
    const get = await request(app).get('/api/v1/projects/someproj/metadata')
    expect(get.status).toBe(200)
    expect(get.body.name).toBe('someproj')

    const put = await request(app).put('/api/v1/projects/someproj/metadata').send({ default_cwd: '/tmp' })
    expect(put.status).toBe(501)
    expect(put.body.error.code).toBe('not_supported_cloud')

    const regen = await request(app).post('/api/v1/projects/someproj/summary/regenerate')
    expect(regen.status).toBe(501)
  })
})
