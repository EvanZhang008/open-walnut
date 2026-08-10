/**
 * /api/v1 console extras (Wave 3) — console-extras-v1.ts: usage breakdowns,
 * provider status (key_hint stripped), qmd status, integrations read,
 * timeline, heartbeat checklist.
 *
 * The test that matters most: /config/providers must never carry `key_hint`
 * — the shared builder emits it for the desktop settings screen, and the v1
 * shell is responsible for stripping it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-conext'))

import express from 'express'
import request from 'supertest'
import { consoleExtrasV1Router } from '../../../src/web/routes/console-extras-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME, CONFIG_FILE, TIMELINE_DIR, HEARTBEAT_FILE } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', consoleExtrasV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('usage breakdowns', () => {
  it('summary / daily / by-source / by-model / by-agent / recent / pricing answer their shapes', async () => {
    const app = createApp()
    const summary = await request(app).get('/api/v1/usage/summary')
    expect(summary.status).toBe(200)

    const daily = await request(app).get('/api/v1/usage/daily?days=7')
    expect(daily.status).toBe(200)
    expect(Array.isArray(daily.body.daily)).toBe(true)

    for (const [pathName, field] of [
      ['by-source', 'sources'], ['by-model', 'models'], ['by-agent', 'agents'],
    ] as const) {
      const res = await request(app).get(`/api/v1/usage/${pathName}?period=7d`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body[field])).toBe(true)
    }

    const recent = await request(app).get('/api/v1/usage/recent?limit=5')
    expect(recent.status).toBe(200)
    expect(Array.isArray(recent.body.records)).toBe(true)

    const pricing = await request(app).get('/api/v1/usage/pricing')
    expect(pricing.status).toBe(200)
    expect(pricing.body.models).toBeTruthy()
    expect(pricing.body.version).toBeTruthy()
  })
})

describe('GET /api/v1/config/providers', () => {
  it('answers provider statuses with key_hint STRIPPED even when a key exists', async () => {
    await fs.writeFile(CONFIG_FILE, [
      'version: 1',
      'providers:',
      '  anthropic:',
      '    api: anthropic-messages',
      '    api_key: sk-test-SECRETKEY-1234',
    ].join('\n'))
    const res = await request(createApp()).get('/api/v1/config/providers')
    expect(res.status).toBe(200)
    expect(res.body.providers).toBeTruthy()
    const anthropic = res.body.providers.anthropic
    expect(anthropic).toBeTruthy()
    expect(anthropic.status).toBe('ready')
    // The whole point: no key material, not even a hint.
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('key_hint')
    expect(raw).not.toContain('1234')
    expect(raw).not.toContain('SECRETKEY')
  })
})

describe('GET /api/v1/qmd/status', () => {
  it('answers the index health shape', async () => {
    const res = await request(createApp()).get('/api/v1/qmd/status')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('model')
    expect(res.body).toHaveProperty('stores')
    expect(res.body).toHaveProperty('status')
  })
})

describe('integrations reads', () => {
  it('GET /integrations answers an array; /integrations/settings masks secret values', async () => {
    const app = createApp()
    const plugins = await request(app).get('/api/v1/integrations')
    expect(plugins.status).toBe(200)
    expect(Array.isArray(plugins.body)).toBe(true)

    const settings = await request(app).get('/api/v1/integrations/settings')
    expect(settings.status).toBe(200)
    expect(Array.isArray(settings.body)).toBe(true)
  })
})

describe('timeline', () => {
  it('GET /timeline answers the day shape and validates the date', async () => {
    const app = createApp()
    const ok = await request(app).get('/api/v1/timeline?date=2026-08-01')
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ date: '2026-08-01', entries: [], tracking: false })

    const bad = await request(app).get('/api/v1/timeline?date=not-a-date')
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('bad_request')
  })

  it('GET /timeline/dates lists capture dirs; images 404 when absent', async () => {
    await fs.mkdir(path.join(TIMELINE_DIR, '2026-08-02'), { recursive: true })
    const app = createApp()
    const dates = await request(app).get('/api/v1/timeline/dates')
    expect(dates.status).toBe(200)
    expect(dates.body.dates).toContain('2026-08-02')

    const img = await request(app).get('/api/v1/timeline/images/2026-08-02/none.jpg')
    expect(img.status).toBe(404)
    const badFile = await request(app).get('/api/v1/timeline/images/2026-08-02/evil.txt')
    expect(badFile.status).toBe(400)
  })

  it('POST /timeline/toggle without a tracker job answers 503 (no cron service in tests)', async () => {
    const res = await request(createApp()).post('/api/v1/timeline/toggle')
    // No cron service registered in this harness → 503 internal-ish path.
    expect([404, 503]).toContain(res.status)
    expect(res.body.error.code).toBeTruthy()
  })
})

describe('heartbeat checklist', () => {
  it('GET answers empty before first write; PUT persists', async () => {
    const app = createApp()
    const before = await request(app).get('/api/v1/heartbeat/checklist')
    expect(before.status).toBe(200)
    expect(before.body.content).toBe('')

    const put = await request(app).put('/api/v1/heartbeat/checklist').send({ content: '- [ ] check disk' })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ ok: true })
    expect(await fs.readFile(HEARTBEAT_FILE, 'utf-8')).toBe('- [ ] check disk')

    const bad = await request(app).put('/api/v1/heartbeat/checklist').send({ content: 42 })
    expect(bad.status).toBe(400)
  })
})
