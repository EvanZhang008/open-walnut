/**
 * /api/v1 library (Wave 3) — library-v1.ts: agents CRUD, commands CRUD,
 * skills write + references, repositories CRUD.
 *
 * The tests that matter most:
 * - the skills scope guard: a skill living in ~/.claude/skills (the CLI's own
 *   store) must be READ-only through v1 — update/delete answer 403 while the
 *   walnut-managed twin accepts the same call.
 * - repository slug validation (Express decodes %2F — traversal probe).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-library'))

import express from 'express'
import request from 'supertest'
import { libraryV1Router } from '../../../src/web/routes/library-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import {
  WALNUT_HOME, CONFIG_FILE, GLOBAL_SKILLS_DIR, CLAUDE_SKILLS_DIR,
  COMMANDS_DIR, REPOSITORIES_DIR,
} from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', libraryV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const { _resetForTest } = await import('../../../src/core/agent-registry.js')
  _resetForTest()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── Agents ───────────────────────────────────────────────────────────────────

describe('agents CRUD', () => {
  it('meta endpoints return catalogs', async () => {
    const app = createApp()
    const tools = await request(app).get('/api/v1/agents/meta/tools')
    expect(tools.status).toBe(200)
    expect(Array.isArray(tools.body.tools)).toBe(true)
    expect(tools.body.tools.length).toBeGreaterThan(0)

    const skills = await request(app).get('/api/v1/agents/meta/skills')
    expect(skills.status).toBe(200)
    expect(Array.isArray(skills.body.skills)).toBe(true)

    const models = await request(app).get('/api/v1/agents/meta/models')
    expect(models.status).toBe(200)
    expect(Array.isArray(models.body.models)).toBe(true)
  })

  it('create → detail → patch → clone → delete round trip', async () => {
    const app = createApp()
    const created = await request(app).post('/api/v1/agents')
      .send({ id: 'helper', name: 'Helper', description: 'test agent' })
    expect(created.status).toBe(201)
    expect(created.body.agent.id).toBe('helper')
    expect(created.body.agent.source).toBe('config')

    const detail = await request(app).get('/api/v1/agents/helper')
    expect(detail.status).toBe(200)
    expect(detail.body.agent.name).toBe('Helper')

    const patched = await request(app).patch('/api/v1/agents/helper').send({ name: 'Helper 2' })
    expect(patched.status).toBe(200)
    expect(patched.body.agent.name).toBe('Helper 2')

    const cloned = await request(app).post('/api/v1/agents/helper/clone').send({ id: 'helper-copy' })
    expect(cloned.status).toBe(201)
    expect(cloned.body.agent.id).toBe('helper-copy')

    const gone = await request(app).delete('/api/v1/agents/helper')
    expect(gone.status).toBe(204)
    const after = await request(app).get('/api/v1/agents/helper')
    expect(after.status).toBe(404)
    expect(after.body.error.code).toBe('not_found')
  })

  it('validates slug, duplicate id, unknown agent', async () => {
    const app = createApp()
    const badSlug = await request(app).post('/api/v1/agents').send({ id: 'Bad Slug!', name: 'x' })
    expect(badSlug.status).toBe(400)
    expect(badSlug.body.error.code).toBe('bad_request')

    await request(app).post('/api/v1/agents').send({ id: 'dup', name: 'Dup' })
    const dup = await request(app).post('/api/v1/agents').send({ id: 'dup', name: 'Dup 2' })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('conflict')

    const missing = await request(app).get('/api/v1/agents/no-such-agent')
    expect(missing.status).toBe(404)

    // Builtin agents refuse deletion (400, not 404).
    const builtin = await request(app).delete('/api/v1/agents/general')
    expect(builtin.status).toBe(400)
  })
})

// ── Commands ─────────────────────────────────────────────────────────────────

describe('commands CRUD', () => {
  it('create → list → get → update → delete round trip', async () => {
    const app = createApp()
    const created = await request(app).post('/api/v1/commands')
      .send({ name: 'greet', content: 'Say hello to $ARGUMENTS', description: 'greeting' })
    expect(created.status).toBe(201)
    expect(created.body.command.name).toBe('greet')

    const list = await request(app).get('/api/v1/commands')
    expect(list.status).toBe(200)
    expect(list.body.commands.some((c: { name: string }) => c.name === 'greet')).toBe(true)

    const got = await request(app).get('/api/v1/commands/greet')
    expect(got.status).toBe(200)
    expect(got.body.command.content).toContain('$ARGUMENTS')

    const updated = await request(app).put('/api/v1/commands/greet').send({ content: 'Hi $ARGUMENTS' })
    expect(updated.status).toBe(200)
    expect(updated.body.command.content).toBe('Hi $ARGUMENTS')

    const gone = await request(app).delete('/api/v1/commands/greet')
    expect(gone.status).toBe(204)
    const after = await request(app).get('/api/v1/commands/greet')
    expect(after.status).toBe(404)
  })

  it('validates input and duplicates', async () => {
    const app = createApp()
    const noContent = await request(app).post('/api/v1/commands').send({ name: 'x' })
    expect(noContent.status).toBe(400)

    await fs.mkdir(COMMANDS_DIR, { recursive: true })
    await request(app).post('/api/v1/commands').send({ name: 'dup', content: 'a' })
    const dup = await request(app).post('/api/v1/commands').send({ name: 'dup', content: 'b' })
    expect(dup.status).toBe(409)
  })
})

// ── Skills write + scope guard ───────────────────────────────────────────────

const SKILL_MD = '---\nname: NAME\ndescription: a test skill\n---\n# Body\n'

describe('skills write', () => {
  it('POST creates in the walnut-managed dir (never ~/.claude/skills)', async () => {
    const app = createApp()
    const created = await request(app).post('/api/v1/skills')
      .send({ dirName: 'my-skill', content: SKILL_MD.replace('NAME', 'my-skill') })
    expect(created.status).toBe(201)
    expect(created.body.skill.source).toBe('walnut')
    // The file must land under GLOBAL_SKILLS_DIR even though the shared
    // store's default target is 'claude'.
    const stat = await fs.stat(path.join(GLOBAL_SKILLS_DIR, 'my-skill', 'SKILL.md'))
    expect(stat.isFile()).toBe(true)
  })

  it('update/delete refuse a claude-store skill with 403 but allow the walnut twin', async () => {
    // One skill in each store.
    await fs.mkdir(path.join(CLAUDE_SKILLS_DIR, 'cli-skill'), { recursive: true })
    await fs.writeFile(path.join(CLAUDE_SKILLS_DIR, 'cli-skill', 'SKILL.md'), SKILL_MD.replace('NAME', 'cli-skill'))
    await fs.mkdir(path.join(GLOBAL_SKILLS_DIR, 'walnut-skill'), { recursive: true })
    await fs.writeFile(path.join(GLOBAL_SKILLS_DIR, 'walnut-skill', 'SKILL.md'), SKILL_MD.replace('NAME', 'walnut-skill'))

    const app = createApp()
    const putClaude = await request(app).put('/api/v1/skills/cli-skill').send({ content: '# rewritten' })
    expect(putClaude.status).toBe(403)
    expect(putClaude.body.error.code).toBe('forbidden')

    const delClaude = await request(app).delete('/api/v1/skills/cli-skill')
    expect(delClaude.status).toBe(403)

    const putWalnut = await request(app).put('/api/v1/skills/walnut-skill')
      .send({ content: SKILL_MD.replace('NAME', 'walnut-skill') + 'more\n' })
    expect(putWalnut.status).toBe(200)

    const delWalnut = await request(app).delete('/api/v1/skills/walnut-skill')
    expect(delWalnut.status).toBe(204)
  })

  it('PATCH enabled toggles ANY source (settings file, not the skill dir)', async () => {
    await fs.mkdir(path.join(CLAUDE_SKILLS_DIR, 'cli-skill'), { recursive: true })
    await fs.writeFile(path.join(CLAUDE_SKILLS_DIR, 'cli-skill', 'SKILL.md'), SKILL_MD.replace('NAME', 'cli-skill'))
    const app = createApp()
    const off = await request(app).patch('/api/v1/skills/cli-skill').send({ enabled: false })
    expect(off.status).toBe(200)
    expect(off.body.skill.enabled).toBe(false)
    const bad = await request(app).patch('/api/v1/skills/cli-skill').send({ enabled: 'yes' })
    expect(bad.status).toBe(400)
  })

  it('references list + read + 404', async () => {
    const refDir = path.join(GLOBAL_SKILLS_DIR, 'ref-skill', 'references')
    await fs.mkdir(refDir, { recursive: true })
    await fs.writeFile(path.join(GLOBAL_SKILLS_DIR, 'ref-skill', 'SKILL.md'), SKILL_MD.replace('NAME', 'ref-skill'))
    await fs.writeFile(path.join(refDir, 'notes.md'), 'ref body')

    const app = createApp()
    const list = await request(app).get('/api/v1/skills/ref-skill/references')
    expect(list.status).toBe(200)
    expect(list.body.files.map((f: { name: string }) => f.name)).toContain('notes.md')

    const file = await request(app).get('/api/v1/skills/ref-skill/references/notes.md')
    expect(file.status).toBe(200)
    expect(file.body.content).toBe('ref body')

    const missing = await request(app).get('/api/v1/skills/no-skill/references')
    expect(missing.status).toBe(404)
  })
})

// ── Repositories ─────────────────────────────────────────────────────────────

describe('repositories CRUD', () => {
  const YAML = 'name: demo\ndescription: a repo\ntech_stack: [ts]\nhosts:\n  local:\n    path: /tmp/demo\n'

  it('write → list → read → delete round trip', async () => {
    const app = createApp()
    const created = await request(app).post('/api/v1/repositories/demo').send({ content: YAML })
    expect(created.status).toBe(200)
    expect(created.body).toEqual({ ok: true, status: 'created' })

    const updated = await request(app).post('/api/v1/repositories/demo').send({ content: YAML + '# v2\n' })
    expect(updated.body.status).toBe('updated')

    const list = await request(app).get('/api/v1/repositories')
    expect(list.status).toBe(200)
    expect(list.body.repositories[0]).toMatchObject({ slug: 'demo', name: 'demo', description: 'a repo' })

    const read = await request(app).get('/api/v1/repositories/demo')
    expect(read.status).toBe(200)
    expect(read.body.content).toContain('# v2')

    const gone = await request(app).delete('/api/v1/repositories/demo')
    expect(gone.status).toBe(200)
    const after = await request(app).get('/api/v1/repositories/demo')
    expect(after.status).toBe(404)
    expect(after.body.error.code).toBe('not_found')
  })

  it('rejects traversal slugs and oversized content', async () => {
    const app = createApp()
    // Express decodes %2F — the slug regex is the only guard.
    const traversal = await request(app).get('/api/v1/repositories/..%2F..%2Fetc')
    expect(traversal.status).toBe(400)

    const big = await request(app).post('/api/v1/repositories/big')
      .send({ content: 'x'.repeat(100_001) })
    expect(big.status).toBe(413)
    expect(big.body.error.code).toBe('too_large')

    // Nothing may have been written outside REPOSITORIES_DIR.
    const entries = await fs.readdir(REPOSITORIES_DIR).catch(() => [])
    expect(entries).toEqual([])
  })
})

// Sanity: the config file used by agent CRUD is the mocked one.
it('agent create persists into the mocked config file', async () => {
  const app = createApp()
  await request(app).post('/api/v1/agents').send({ id: 'persisted', name: 'P' })
  const raw = await fs.readFile(CONFIG_FILE, 'utf-8')
  expect(raw).toContain('persisted')
})
