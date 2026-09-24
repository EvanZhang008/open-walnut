/**
 * Shipped skills (dist/data/skills) on a package the server cannot write.
 *
 * The cloud companion's code tree is root's and read-only to the service user,
 * so editing or deleting a shipped skill used to answer a 500 (EACCES). Pinned:
 *  - a writable package keeps editing the shipped file in place (unchanged);
 *  - a read-only one refuses the edit and the delete with a readable 409 on
 *    both routers, writes nothing, and makes NO override copy in the walnut
 *    skills dir (that dir git-syncs to the primary, where a copy would outrank
 *    the shipped skill and hide every later release of it).
 * The read-only package is a real 0555/0444 tree, so the store's own access
 * check decides. Skipped as root, which chmod does not restrict.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-skill-readonly-pkg'))

import { WALNUT_HOME, BUILTIN_SKILLS_DIR, GLOBAL_SKILLS_DIR } from '../../src/constants.js'
import { updateSkill, deleteSkill, getSkill } from '../../src/core/skill-store.js'
import { SHIPPED_SKILL_READ_ONLY_EDIT, SHIPPED_SKILL_READ_ONLY_DELETE } from '../../src/core/skill-errors.js'
import { clearSkillsCache } from '../../src/core/skill-loader.js'
import { createSkillsRouter } from '../../src/web/routes/skills.js'
import { libraryV1Router } from '../../src/web/routes/library-v1.js'
import { errorHandler } from '../../src/web/middleware/error-handler.js'

const SHIPPED = () => path.join(BUILTIN_SKILLS_DIR, 'guides', 'shipped-demo')
const ORIGINAL = '---\nname: shipped-demo\ndescription: shipped\n---\nshipped body\n'
const EDITED = '---\nname: shipped-demo\ndescription: edited\n---\nedited body\n'

async function seedShipped(): Promise<void> {
  await fs.mkdir(path.join(SHIPPED(), 'references'), { recursive: true })
  await fs.writeFile(path.join(SHIPPED(), 'SKILL.md'), ORIGINAL)
  await fs.writeFile(path.join(SHIPPED(), 'references', 'notes.md'), 'ref\n')
}

/** Make the shipped tree what the box has: readable, writable by nobody here. */
async function makeReadOnly(dir: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await makeReadOnly(full)
    else await fs.chmod(full, 0o444)
  }
  await fs.chmod(dir, 0o555)
}

async function makeWritable(dir: string): Promise<void> {
  await fs.chmod(dir, 0o755).catch(() => {})
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await makeWritable(full)
    else await fs.chmod(full, 0o644).catch(() => {})
  }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await seedShipped()
  clearSkillsCache()
})

afterEach(async () => {
  await makeWritable(BUILTIN_SKILLS_DIR)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a writable package', () => {
  it('edits the shipped file in place, as before', async () => {
    const skill = await updateSkill('shipped-demo', EDITED)
    expect(skill.content).toBe(EDITED)
    expect(await fs.readFile(path.join(SHIPPED(), 'SKILL.md'), 'utf-8')).toBe(EDITED)
    await expect(fs.stat(path.join(GLOBAL_SKILLS_DIR, 'guides', 'shipped-demo'))).rejects.toThrow()
  })
})

describe.skipIf(process.getuid?.() === 0)('a package the server cannot write', () => {
  beforeEach(async () => { await makeReadOnly(BUILTIN_SKILLS_DIR) })

  it('refuses an edit with a readable reason, writes nothing, and makes no override copy', async () => {
    await expect(updateSkill('shipped-demo', EDITED)).rejects.toThrow(SHIPPED_SKILL_READ_ONLY_EDIT)
    expect(await fs.readFile(path.join(SHIPPED(), 'SKILL.md'), 'utf-8')).toBe(ORIGINAL)
    // A copy in the walnut dir would git-sync to the primary and hide every
    // later release of the shipped skill there.
    await expect(fs.stat(path.join(GLOBAL_SKILLS_DIR, 'guides', 'shipped-demo'))).rejects.toThrow()
    clearSkillsCache()
    const still = await getSkill('shipped-demo')
    expect(still?.content).toBe(ORIGINAL)
    expect(still?.location).toBe(path.join(SHIPPED(), 'SKILL.md'))
  })

  it('refuses a delete with a readable reason', async () => {
    await expect(deleteSkill('shipped-demo')).rejects.toThrow(SHIPPED_SKILL_READ_ONLY_DELETE)
    expect(await fs.readFile(path.join(SHIPPED(), 'SKILL.md'), 'utf-8')).toBe(ORIGINAL)
  })

  it('both routers answer 409 (not 500) for the edit and the delete', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/skills', createSkillsRouter())
    app.use('/api/v1', libraryV1Router)
    app.use(errorHandler)

    const put = await request(app).put('/api/skills/shipped-demo').send({ content: EDITED })
    expect(put.status).toBe(409)
    expect(put.body.error).toBe(SHIPPED_SKILL_READ_ONLY_EDIT)
    const putV1 = await request(app).put('/api/v1/skills/shipped-demo').send({ content: EDITED })
    expect(putV1.status).toBe(409)
    expect(JSON.stringify(putV1.body)).toContain('Edit it on your primary Mac instead.')

    const del = await request(app).delete('/api/skills/shipped-demo')
    expect(del.status).toBe(409)
    expect(del.body.error).toBe(SHIPPED_SKILL_READ_ONLY_DELETE)
    const delV1 = await request(app).delete('/api/v1/skills/shipped-demo')
    expect(delV1.status).toBe(409)
    expect(JSON.stringify(delV1.body)).toContain('Disable it instead.')

    expect(await fs.readFile(path.join(SHIPPED(), 'SKILL.md'), 'utf-8')).toBe(ORIGINAL)
    await expect(fs.stat(path.join(GLOBAL_SKILLS_DIR, 'guides', 'shipped-demo'))).rejects.toThrow()
  })
})
