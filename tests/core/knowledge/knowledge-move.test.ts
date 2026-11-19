/**
 * The move into Walnut's knowledge folder (src/core/knowledge/): skills become SKILL.md files, a
 * memory folder moves to knowledge/nodes/<id>/notes, each MEMORY.md gets a copy beside them, and
 * the places they came from stay current for the release before this one:
 *   - a scope never moved reads from its JSON file and moves whole at its first write
 *   - every change writes the JSON copy too, so the release before reads the same skills
 *   - a SKILL.md a person edited is what Walnut reads
 *   - the boot move backs the old folders up once, moves notes, copies MEMORY.md, and is a no-op again
 *   - after a roll back the older release's newer writes come forward at the next boot
 *   - a memory-folder note is written to both places and read from the old one where the new lacks it
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-knowledge-move'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { deleteAgentSkill, findAgentSkill, listAgentSkills, writeAgentSkill } from '../../../src/core/sessions/agent-skills.js'
import { listMemoryFiles, readMemoryFile, writeOwnNote } from '../../../src/core/sessions/memory-folder.js'
import { moveIntoKnowledge } from '../../../src/core/knowledge/migrate.js'
import { parseSkillFile, renderSkillFile } from '../../../src/core/knowledge/skill-files.js'

const K = () => path.join(WALNUT_HOME, 'knowledge')
const legacyJson = (key: string) => path.join(WALNUT_HOME, 'agent-skills', `${key}.json`)
const skillFile = (scope: 'org' | string, name: string) => scope === 'org'
  ? path.join(K(), 'org', 'skills', name, 'SKILL.md') : path.join(K(), 'nodes', scope, 'skills', name, 'SKILL.md')
const jsonSkills = async (key: string) => JSON.parse(await fs.readFile(legacyJson(key), 'utf-8')).skills.map((s: { name: string }) => s.name).sort()
const exists = async (p: string) => !!(await fs.stat(p).catch(() => null))

async function legacy(key: string, skills: Array<{ name: string; description: string; text: string }>) {
  await fs.mkdir(path.dirname(legacyJson(key)), { recursive: true })
  await fs.writeFile(legacyJson(key), JSON.stringify({ version: 1, skills: skills.map((s) => ({ ...s, at: '2026-11-01T00:00:00.000Z' })) }), 'utf-8')
}
const old = (p: string, minutes: number) => { const t = new Date(Date.now() - minutes * 60_000); return fs.utimes(p, t, t) }

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('skills in the knowledge folder', () => {
  it('reads a scope not moved yet from its JSON file, and moves it whole at the first write', async () => {
    await legacy('_org', [{ name: 'open-a-major-version', description: 'When upstream moves a major version', text: '1. Open it.' }])
    expect((await listAgentSkills('org', 'vp-1')).map((s) => s.name)).toEqual(['open-a-major-version'])
    expect(await exists(skillFile('org', 'open-a-major-version'))).toBe(false)

    await writeAgentSkill('org', 'vp-1', { name: 'try-once-on-real-accounts', description: 'Before automating a real account: one try', content: 'Try once. Stop on a failure.' }, { by: 'task:vp-1', by_name: 'Marina VP' })
    expect(await exists(skillFile('org', 'open-a-major-version'))).toBe(true)
    expect(await exists(skillFile('org', 'try-once-on-real-accounts'))).toBe(true)
    // The JSON copy holds the same skills, for the release before this one.
    expect(await jsonSkills('_org')).toEqual(['open-a-major-version', 'try-once-on-real-accounts'])
    const read = await findAgentSkill('w-1', 'try-once-on-real-accounts')
    expect(read).toMatchObject({ scope: 'org', skill: { description: 'Before automating a real account: one try', text: 'Try once. Stop on a failure.', by: 'task:vp-1', by_name: 'Marina VP' } })
  })

  it('keeps the JSON copy in line on an edit and a delete, and reads a hand-edited SKILL.md', async () => {
    await writeAgentSkill('own', 'vp-1', { name: 'weekly-review', description: 'The weekly review: "what moved", step by step', content: 'Step one.' }, null)
    await writeAgentSkill('own', 'vp-1', { name: 'weekly-review', edits: [{ old: 'Step one.', new: 'Step one, then two.' }] }, null)
    expect(JSON.parse(await fs.readFile(legacyJson('vp-1'), 'utf-8')).skills[0].text).toBe('Step one, then two.')
    // A person edits the file in the folder: Walnut reads it.
    const f = skillFile('vp-1', 'weekly-review')
    await fs.writeFile(f, (await fs.readFile(f, 'utf-8')).replace('Step one, then two.', 'Step one, two and three.'), 'utf-8')
    expect((await listAgentSkills('own', 'vp-1'))[0]).toMatchObject({ description: 'The weekly review: "what moved", step by step', text: 'Step one, two and three.' })
    expect(await deleteAgentSkill('own', 'vp-1', 'weekly-review')).toBe(true)
    expect(await exists(f)).toBe(false)
    expect(await jsonSkills('vp-1')).toEqual([])
  })

  it('reads a folder a move left half done as not moved, so no skill of the JSON is lost', async () => {
    await legacy('_org', [{ name: 'a-one', description: 'One', text: '1' }, { name: 'b-two', description: 'Two', text: '2' }])
    // A move cut short: one file written, no mark.
    await fs.mkdir(path.dirname(skillFile('org', 'a-one')), { recursive: true })
    await fs.writeFile(skillFile('org', 'a-one'), '---\ndescription: "One"\n---\n\n1\n', 'utf-8')
    expect((await listAgentSkills('org', 'vp-1')).map((s) => s.name)).toEqual(['a-one', 'b-two'])
    await writeAgentSkill('org', 'vp-1', { name: 'c-three', description: 'Three', content: '3' }, null)
    expect((await listAgentSkills('org', 'vp-1')).map((s) => s.name)).toEqual(['a-one', 'b-two', 'c-three'])
    expect(await jsonSkills('_org')).toEqual(['a-one', 'b-two', 'c-three'])
  })

  it('refuses a write when a skill cannot be read, rather than reading fewer skills', async () => {
    if (process.getuid?.() === 0) return // root reads every file
    await writeAgentSkill('org', 'vp-1', { name: 'a-one', description: 'One', content: '1' }, null)
    await writeAgentSkill('org', 'vp-1', { name: 'b-two', description: 'Two', content: '2' }, null)
    await fs.chmod(skillFile('org', 'a-one'), 0o000)
    try {
      await expect(writeAgentSkill('org', 'vp-1', { name: 'c-three', description: 'Three', content: '3' }, null)).rejects.toThrow()
      expect(await jsonSkills('_org')).toEqual(['a-one', 'b-two'])
    } finally {
      await fs.chmod(skillFile('org', 'a-one'), 0o644)
    }
  })

  it('keeps a skill a person deleted from the folder deleted at the next boot', async () => {
    await writeAgentSkill('org', 'vp-1', { name: 'a-one', description: 'One', content: '1' }, null)
    await writeAgentSkill('org', 'vp-1', { name: 'b-two', description: 'Two', content: '2' }, null)
    // The JSON copy was written a minute before the person's delete.
    await old(legacyJson('_org'), 1)
    await fs.rm(path.dirname(skillFile('org', 'a-one')), { recursive: true })
    await moveIntoKnowledge([])
    expect((await listAgentSkills('org', 'vp-1')).map((s) => s.name)).toEqual(['b-two'])
  })

  it('reads a SKILL.md back as it was written, a bare value a person typed included', () => {
    const s = { name: 'x-y', description: 'When: a colon, "quotes" and \u4e2d\u6587', text: 'Body\n\n- a list', at: '2026-11-19T00:00:00.000Z', by: 'task:vp-1', by_name: 'Marina VP' }
    expect(parseSkillFile('x-y', renderSkillFile(s, 'org'), 'x')).toEqual(s)
    expect(parseSkillFile('z', '---\ndescription: Typed by hand\n---\nDo it.', '2026-01-01T00:00:00.000Z'))
      .toEqual({ name: 'z', description: 'Typed by hand', text: 'Do it.', at: '2026-01-01T00:00:00.000Z' })
    expect(parseSkillFile('z', 'No front matter at all', 'x')).toBeNull()
  })
})

describe('the boot move', () => {
  const vp = { id: 'vp-1', title: 'Marina VP', org_role: 'lead', agent_memory: { text: '## Pending\n- CR 2 waits', at: '2026-11-19T10:00:00.000Z' } } as Task

  it('backs the old folders up once, moves skills and notes, copies MEMORY.md, and does nothing again', async () => {
    await legacy('vp-1', [{ name: 'weekly-review', description: 'The weekly review', text: 'Step one.' }])
    const notes = path.join(WALNUT_HOME, 'agent-memory', 'vp-1')
    await fs.mkdir(notes, { recursive: true })
    await fs.writeFile(path.join(notes, 'people.md'), 'Who owns what.\n', 'utf-8')

    const first = await moveIntoKnowledge([vp])
    expect(first).toMatchObject({ skillScopes: 1, skills: 1, notes: 1, memories: 1 })
    expect(await fs.readFile(path.join(first.backup!, 'agent-memory', 'vp-1', 'people.md'), 'utf-8')).toBe('Who owns what.\n')
    expect(await exists(path.join(first.backup!, 'agent-skills', 'vp-1.json'))).toBe(true)
    expect(await fs.readFile(path.join(K(), 'nodes', 'vp-1', 'notes', 'people.md'), 'utf-8')).toBe('Who owns what.\n')
    expect(await exists(skillFile('vp-1', 'weekly-review'))).toBe(true)
    expect(await fs.readFile(path.join(K(), 'nodes', 'vp-1', 'MEMORY.md'), 'utf-8')).toContain('- CR 2 waits')
    // The places it came from are untouched.
    expect(await fs.readFile(path.join(notes, 'people.md'), 'utf-8')).toBe('Who owns what.\n')
    expect(await jsonSkills('vp-1')).toEqual(['weekly-review'])

    const again = await moveIntoKnowledge([vp])
    expect(again).toEqual({ backup: null, skillScopes: 0, skills: 0, notes: 0, memories: 0 })
    // The memory is cleared: so is its copy.
    await moveIntoKnowledge([{ ...vp, agent_memory: undefined } as Task])
    expect(await exists(path.join(K(), 'nodes', 'vp-1', 'MEMORY.md'))).toBe(false)
  })

  it('brings forward what the release before wrote after a roll back, and never overwrites newer knowledge', async () => {
    await writeAgentSkill('own', 'vp-1', { name: 'weekly-review', description: 'The weekly review', content: 'Step one.' }, null)
    await writeOwnNote('vp-1', 'people.md', 'Who owns what.')
    await moveIntoKnowledge([])
    await old(skillFile('vp-1', 'weekly-review'), 30)
    await old(path.join(K(), 'nodes', 'vp-1', 'notes', 'people.md'), 30)
    // The release before writes its places (as it would after a roll back).
    await legacy('vp-1', [{ name: 'weekly-review', description: 'The weekly review', text: 'Step one, changed by the older release.' }, { name: 'new-one', description: 'Added there', text: 'x' }])
    await fs.writeFile(path.join(WALNUT_HOME, 'agent-memory', 'vp-1', 'people.md'), 'Changed by the older release.\n', 'utf-8')
    const r = await moveIntoKnowledge([])
    expect(r.notes).toBe(1)
    expect((await listAgentSkills('own', 'vp-1')).map((s) => [s.name, s.text])).toEqual([['new-one', 'x'], ['weekly-review', 'Step one, changed by the older release.']])
    expect((await readMemoryFile('vp-1', 'people.md')).text).toBe('Changed by the older release.\n')
    // Now the knowledge folder is the newer: a later boot leaves it.
    await fs.writeFile(path.join(K(), 'nodes', 'vp-1', 'notes', 'people.md'), 'Edited in the folder.\n', 'utf-8')
    await old(path.join(WALNUT_HOME, 'agent-memory', 'vp-1', 'people.md'), 30)
    await moveIntoKnowledge([])
    expect((await readMemoryFile('vp-1', 'people.md')).text).toBe('Edited in the folder.\n')
  })
})

describe('a roll back within seconds', () => {
  it('still brings forward a skill the release before added, since the two differ and its file is the later', async () => {
    await writeAgentSkill('org', 'vp-1', { name: 'probe', description: 'Written by this release', content: 'x' }, null)
    await moveIntoKnowledge([])
    const cur = JSON.parse(await fs.readFile(legacyJson('_org'), 'utf-8')).skills
    await fs.writeFile(legacyJson('_org'), JSON.stringify({ version: 1, skills: [...cur, { name: 'from-older', description: 'Written after a roll back', text: 'y', at: new Date().toISOString() }] }), 'utf-8')
    // A second later than the folder's last change, as the older release's write would be.
    const later = new Date(Date.now() + 1_000)
    await fs.utimes(legacyJson('_org'), later, later)
    await moveIntoKnowledge([])
    expect((await listAgentSkills('org', 'vp-1')).map((s) => s.name)).toEqual(['from-older', 'probe'])
  })
})

describe('the memory folder in the knowledge folder', () => {
  it('writes a note to both places, removes it from both, and reads the old place where the new lacks a file', async () => {
    await writeOwnNote('vp-1', 'plan.md', 'The plan.')
    const now = path.join(K(), 'nodes', 'vp-1', 'notes', 'plan.md')
    const before = path.join(WALNUT_HOME, 'agent-memory', 'vp-1', 'plan.md')
    expect(await fs.readFile(now, 'utf-8')).toBe('The plan.\n')
    expect(await fs.readFile(before, 'utf-8')).toBe('The plan.\n')
    await fs.writeFile(path.join(WALNUT_HOME, 'agent-memory', 'vp-1', 'only-old.md'), 'Not moved yet.\n', 'utf-8')
    expect((await listMemoryFiles('vp-1')).filter((f) => !f.shared).map((f) => f.name)).toEqual(['only-old.md', 'plan.md'])
    expect((await readMemoryFile('vp-1', 'only-old.md')).text).toBe('Not moved yet.\n')
    await writeOwnNote('vp-1', 'plan.md', '')
    expect(await exists(now)).toBe(false)
    expect(await exists(before)).toBe(false)
  })
})
