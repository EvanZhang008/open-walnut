/**
 * Every shipped skill is named `walnut-<thing>`: the prefix tells a user (and the
 * model's skill index) which entries Walnut ships, next to the user's own and the
 * CLI's. The 2026-09-30 rename kept the old directory names resolving, so a routine,
 * a `skill_read`, a saved disabled entry or a bookmarked `/api/skills/<dirName>`
 * written before it still finds its skill, and a user skill under an old name wins.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-shipped-skill-prefix'))

import { WALNUT_HOME, BUILTIN_SKILLS_DIR, GLOBAL_SKILLS_DIR, SKILL_SETTINGS_FILE } from '../../src/constants.js'
import { getSkill, listAllSkills, setSkillEnabled, listReferences } from '../../src/core/skill-store.js'
import {
  clearSkillsCache,
  LEGACY_SKILL_DIR_ALIASES,
  resolveSkillDirName,
  expandDisabledSkillNames,
  buildSkillsPrompt,
} from '../../src/core/skill-loader.js'
import { createSkillsRouter } from '../../src/web/routes/skills.js'

const SHIPPED_ROOT = path.resolve(__dirname, '../../src/data/skills')
const TEMPLATES_ROOT = path.resolve(__dirname, '../../src/data/routine-templates')

describe('shipped skill names', () => {
  const dirs = fsSync.readdirSync(SHIPPED_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  it('every shipped skill directory starts with walnut', () => {
    expect(dirs.length).toBeGreaterThan(10)
    for (const dir of dirs) expect(dir, dir).toMatch(/^walnut(-[a-z0-9]+)*$/)
  })

  it('the frontmatter name is the directory name', () => {
    for (const dir of dirs) {
      const text = fsSync.readFileSync(path.join(SHIPPED_ROOT, dir, 'SKILL.md'), 'utf-8')
      expect(text, dir).toMatch(new RegExp(`^name: ${dir}$`, 'm'))
    }
  })

  it('every legacy alias points at a shipped skill and never at a live directory name', () => {
    for (const [legacy, renamed] of Object.entries(LEGACY_SKILL_DIR_ALIASES)) {
      expect(dirs, `${legacy} -> ${renamed}`).toContain(renamed)
      expect(dirs, legacy).not.toContain(legacy)
    }
  })

  it('shipped routine templates and prompts name skills by their current directory', () => {
    const texts = [
      ...fsSync.readdirSync(TEMPLATES_ROOT).map((f) => fsSync.readFileSync(path.join(TEMPLATES_ROOT, f), 'utf-8')),
      ...dirs.map((d) => fsSync.readFileSync(path.join(SHIPPED_ROOT, d, 'SKILL.md'), 'utf-8')),
    ]
    for (const text of texts) {
      for (const m of text.matchAll(/skill_read[^\n]*?"dirName\\?":\\?"([^"\\]+)/g)) {
        expect(dirs, m[1]).toContain(m[1])
      }
    }
  })
})

describe('legacy name resolution', () => {
  it('resolves an old name only when nothing is discovered under it', () => {
    const discovered = new Map([['walnut-triage', {}]])
    expect(resolveSkillDirName('triage', discovered)).toBe('walnut-triage')
    expect(resolveSkillDirName('walnut-triage', discovered)).toBe('walnut-triage')
    expect(resolveSkillDirName('nothing-here', discovered)).toBe('nothing-here')
    // A user's own skill under the old name wins over the alias.
    discovered.set('triage', {})
    expect(resolveSkillDirName('triage', discovered)).toBe('triage')
  })

  it('a disabled list disables the renamed form of every legacy name', () => {
    const set = expandDisabledSkillNames(['morning-brief', 'walnut-learn', 'mine'])
    expect([...set].sort()).toEqual(['mine', 'morning-brief', 'walnut-learn', 'walnut-morning-brief'])
  })
})

describe('the store under an old name', () => {
  const shipped = (dir: string) => path.join(BUILTIN_SKILLS_DIR, dir)

  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    await fs.mkdir(path.join(shipped('walnut-triage'), 'references'), { recursive: true })
    await fs.writeFile(path.join(shipped('walnut-triage'), 'SKILL.md'), '---\nname: walnut-triage\ndescription: shipped triage\n---\nbody\n')
    await fs.writeFile(path.join(shipped('walnut-triage'), 'references', 'notes.md'), 'ref\n')
    clearSkillsCache()
  })

  afterEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  it('getSkill, references and the HTTP route answer the renamed skill', async () => {
    const skill = await getSkill('triage')
    expect(skill?.dirName).toBe('walnut-triage')
    expect(skill?.name).toBe('walnut-triage')
    expect(await listReferences('triage')).toEqual([{ name: 'notes.md', size: 4 }])

    const app = express().use('/api/skills', createSkillsRouter())
    const res = await request(app).get('/api/skills/triage')
    expect(res.status).toBe(200)
    expect(res.body.skill.dirName).toBe('walnut-triage')
  })

  it('a disabled entry saved under the old name keeps the renamed skill off, and re-enabling clears it', async () => {
    await fs.writeFile(SKILL_SETTINGS_FILE, JSON.stringify({ disabled: ['triage'] }))
    clearSkillsCache()
    expect((await getSkill('walnut-triage'))?.enabled).toBe(false)
    expect((await listAllSkills()).find((s) => s.dirName === 'walnut-triage')?.enabled).toBe(false)
    expect(await buildSkillsPrompt()).not.toContain('walnut-triage')

    const on = await setSkillEnabled('triage', true)
    expect(on.enabled).toBe(true)
    expect(JSON.parse(await fs.readFile(SKILL_SETTINGS_FILE, 'utf-8')).disabled).toEqual([])
  })

  it("a user's own skill under the old name is the one answered", async () => {
    await fs.mkdir(path.join(GLOBAL_SKILLS_DIR, 'triage'), { recursive: true })
    await fs.writeFile(path.join(GLOBAL_SKILLS_DIR, 'triage', 'SKILL.md'), '---\nname: triage\ndescription: mine\n---\nmine\n')
    clearSkillsCache()
    const skill = await getSkill('triage')
    expect(skill?.dirName).toBe('triage')
    expect(skill?.description).toBe('mine')
  })
})
