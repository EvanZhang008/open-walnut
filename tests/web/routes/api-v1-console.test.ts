/**
 * /api/v1 console reads (Wave 2) — console-v1.ts: config projection, usage
 * overview, slash-commands, skills read.
 *
 * THE test that matters most here: the config projection is an ALLOWLIST —
 * we write a config file stuffed with every known credential field and assert
 * none of them (keys OR values) appear anywhere in the response. If someone
 * "helpfully" switches the projection to a redact-passthrough, this fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-console'))

import express from 'express'
import request from 'supertest'
import { consoleV1Router } from '../../../src/web/routes/console-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME, CONFIG_FILE, GLOBAL_SKILLS_DIR } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', consoleV1Router)
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

const SECRET_VALUE_MARKERS = [
  'SECRET-BEARER-XYZ', 'SECRET-APIKEY-XYZ', 'SECRET-SLACK-XYZ',
  'SECRET-OPENAI-XYZ', 'SECRET-PERPLEXITY-XYZ', 'SECRET-DEVICEKEY-XYZ',
]

const CONFIG_WITH_EVERY_SECRET = `
version: 1
user:
  name: Evan
defaults:
  priority: P2
provider:
  type: bedrock
  model: opus-4-8
  bedrock_region: us-west-2
  bedrock_bearer_token: SECRET-BEARER-XYZ
agent:
  main_model: opus-4-8
  fast_model: haiku
hosts:
  devbox:
    hostname: internal-hostname.example.com
    user: shelluser
    port: 2222
    label: Dev Box
    shell_setup: source /secret/profile
tools:
  slack:
    bot_token: SECRET-SLACK-XYZ
  web_search:
    api_key: SECRET-APIKEY-XYZ
    perplexity_api_key: SECRET-PERPLEXITY-XYZ
stt:
  engine: openai
  openai_api_key: SECRET-OPENAI-XYZ
api_keys:
  - id: dev-1
    key_hash: SECRET-DEVICEKEY-XYZ
    label: iPhone
session:
  idle_timeout_minutes: 45
`

describe('GET /api/v1/config — allowlist projection', () => {
  it('NEVER leaks a secret value, a credential key, or host connection details', async () => {
    await fs.writeFile(CONFIG_FILE, CONFIG_WITH_EVERY_SECRET)
    const res = await request(createApp()).get('/api/v1/config')
    expect(res.status).toBe(200)

    const raw = JSON.stringify(res.body)
    // No secret VALUE survives.
    for (const marker of SECRET_VALUE_MARKERS) {
      expect(raw, `secret value leaked: ${marker}`).not.toContain(marker)
    }
    // No credential KEY survives either — allowlist means the fields are
    // structurally absent, not masked.
    for (const key of [
      'bedrock_bearer_token', 'bot_token', 'api_key', 'perplexity_api_key',
      'openai_api_key', 'api_keys', 'key_hash', 'push_tokens',
    ]) {
      expect(raw, `credential key leaked: ${key}`).not.toContain(`"${key}"`)
    }
    // Host CONNECTION details stay private; only label/enabled project.
    expect(raw).not.toContain('internal-hostname.example.com')
    expect(raw).not.toContain('shelluser')
    expect(raw).not.toContain('shell_setup')
  })

  it('projects the allowlisted fields', async () => {
    await fs.writeFile(CONFIG_FILE, CONFIG_WITH_EVERY_SECRET)
    const res = await request(createApp()).get('/api/v1/config')
    expect(res.status).toBe(200)
    expect(res.body.config.user.name).toBe('Evan')
    expect(res.body.config.provider.type).toBe('bedrock')
    expect(res.body.config.provider.bedrock_region).toBe('us-west-2')
    expect(res.body.config.agent.main_model).toBe('opus-4-8')
    expect(res.body.config.hosts.devbox).toEqual({ label: 'Dev Box', enabled: true })
    expect(res.body.config.session.idle_timeout_minutes).toBe(45)
    // Box diagnostics ride along (bug-report flow).
    expect(res.body.cloud).toBe(false)
    expect(typeof res.body.processNice).toBe('number')
    expect(typeof res.body.memory.rssMb).toBe('number')
  })
})

describe('GET /api/v1/usage/overview', () => {
  it('returns the aggregate shape on the primary', async () => {
    const res = await request(createApp()).get('/api/v1/usage/overview?limit=5')
    expect(res.status).toBe(200)
    // Composite shape from usageTracker.getOverview.
    expect(res.body).toHaveProperty('summary')
  })
})

describe('GET /api/v1/slash-commands', () => {
  it('returns the palette items', async () => {
    const res = await request(createApp()).get('/api/v1/slash-commands')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.items)).toBe(true)
  })
})

describe('skills read', () => {
  it('GET /skills strips content; GET /skills/:dirName carries it; 404 unknown', async () => {
    const skillDir = path.join(GLOBAL_SKILLS_DIR, 'demo-skill')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: A demo\n---\n# Body here\n')

    const app = createApp()
    const list = await request(app).get('/api/v1/skills')
    expect(list.status).toBe(200)
    const entry = list.body.skills.find((s: { dirName: string }) => s.dirName === 'demo-skill')
    expect(entry).toBeDefined()
    expect(entry.content).toBeUndefined()

    const detail = await request(app).get('/api/v1/skills/demo-skill')
    expect(detail.status).toBe(200)
    expect(detail.body.skill.content).toContain('Body here')

    const missing = await request(app).get('/api/v1/skills/no-such-skill')
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')
  })

  it('400 for an unsafe skill name', async () => {
    const res = await request(createApp()).get('/api/v1/skills/..%2Fescape')
    expect(res.status).toBe(400)
  })
})
