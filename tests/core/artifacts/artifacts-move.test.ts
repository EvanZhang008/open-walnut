/**
 * Walnut's artifacts folder as the only place (src/core/artifacts/, 2026-11-20): skills are SKILL.md
 * files, a memory folder is artifacts/nodes/<id>/notes, each MEMORY.md is artifacts/nodes/<id>/MEMORY.md,
 * and the places before it are never written again:
 *   - a skill, a note or a MEMORY.md is written only in the artifacts folder
 *   - what an older release left in an old place is taken in at the next read (a skill added or
 *     replaced by a later one, never one removed; a MEMORY.md merged, losing no line) and moved to
 *     artifacts/.backup/taken/
 *   - the boot move backs everything up once (both old folders, the artifacts folder, every row's
 *     memory), takes all of it in, and is a no-op again
 *   - rollback.ts writes the old places back for the release before
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-artifacts-move'))

import { WALNUT_HOME } from '../../../src/constants.js'

import type { Task } from '../../../src/core/types.js'
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { deleteAgentSkill, findAgentSkill, listAgentSkills, writeAgentSkill } from '../../../src/core/sessions/agent-skills.js'
import { listMemoryFiles, readMemoryFile, writeOwnNote } from '../../../src/core/sessions/memory-folder.js'
import { mergeMemories, moveIntoArtifacts } from '../../../src/core/artifacts/migrate.js'
import { rollbackArtifacts } from '../../../src/core/artifacts/rollback.js'
import { changeNodeMemory, parseMemoryFile, readNodeMemory, renderMemoryFile } from '../../../src/core/artifacts/node-memory.js'
import { parseSkillFile, renderSkillFile } from '../../../src/core/artifacts/skill-files.js'

const K = () => path.join(WALNUT_HOME, 'artifacts')
const legacyJson = (key: string) => path.join(WALNUT_HOME, 'agent-skills', `${key}.json`)
const legacyNotes = (key: string) => path.join(WALNUT_HOME, 'agent-memory', key)
const skillFile = (scope: 'org' | string, name: string) => scope === 'org'
  ? path.join(K(), 'org', 'skills', name, 'SKILL.md') : path.join(K(), 'nodes', scope, 'skills', name, 'SKILL.md')
const memoryFile = (id: string) => path.join(K(), 'nodes', id, 'MEMORY.md')
const exists = async (p: string) => !!(await fs.stat(p).catch(() => null))
const rowMemory = async (id: string) => ((await getTask(id)) as Task & { agent_memory?: { text: string; at: string } }).agent_memory
const setRowMemory = (id: string, m: { text: string; at: string } | undefined) => updateTaskRaw(id, { agent_memory: m } as Partial<Task>)

async function legacy(key: string, skills: Array<{ name: string; description: string; text: string; at?: string }>) {
  await fs.mkdir(path.dirname(legacyJson(key)), { recursive: true })
  await fs.writeFile(legacyJson(key), JSON.stringify({ version: 1, skills: skills.map((s) => ({ at: '2026-11-01T00:00:00.000Z', ...s })) }), 'utf-8')
}
const old = (p: string, minutes: number) => { const t = new Date(Date.now() - minutes * 60_000); return fs.utimes(p, t, t) }
const takenFiles = async () => {
  const root = path.join(K(), '.backup', 'taken')
  return (await fs.readdir(root, { recursive: true }).catch(() => [] as string[])).map(String).filter((f) => /\.(json|md)$/.test(f)).map((f) => f.split(path.sep).slice(1).join('/')).sort()
}

beforeEach(async () => {
  await fs.rm(path.join(WALNUT_HOME, 'artifacts'), { recursive: true, force: true })
  await fs.rm(path.join(WALNUT_HOME, 'knowledge'), { recursive: true, force: true })
  await fs.rm(path.join(WALNUT_HOME, 'agent-skills'), { recursive: true, force: true })
  await fs.rm(path.join(WALNUT_HOME, 'agent-memory'), { recursive: true, force: true })
})

describe('skills', () => {
  it('are written only as SKILL.md files: no JSON file appears, on a write, an edit or a delete', async () => {
    await writeAgentSkill('own', 'vp-1', { name: 'weekly-review', description: 'The weekly review: "what moved", step by step', content: 'Step one.' }, null)
    await writeAgentSkill('own', 'vp-1', { name: 'weekly-review', edits: [{ old: 'Step one.', new: 'Step one, then two.' }] }, null)
    await writeAgentSkill('org', 'vp-1', { name: 'try-once', description: 'One try first', content: 'Try once.' }, { by: 'task:vp-1', by_name: 'Marina VP' })
    expect(await exists(path.join(WALNUT_HOME, 'agent-skills'))).toBe(false)
    // A person edits the file in the folder: Walnut reads it.
    const f = skillFile('vp-1', 'weekly-review')
    await fs.writeFile(f, (await fs.readFile(f, 'utf-8')).replace('Step one, then two.', 'Step one, two and three.'), 'utf-8')
    expect((await listAgentSkills('own', 'vp-1'))[0]).toMatchObject({ text: 'Step one, two and three.' })
    expect(await findAgentSkill('w-1', 'try-once')).toMatchObject({ scope: 'org', skill: { by: 'task:vp-1', by_name: 'Marina VP' } })
    expect(await deleteAgentSkill('own', 'vp-1', 'weekly-review')).toBe(true)
    expect(await exists(f)).toBe(false)
    expect(await exists(path.join(WALNUT_HOME, 'agent-skills'))).toBe(false)
  })

  it('takes in a JSON file an older release left, at the next read: added or later skills come in, none is removed', async () => {
    await writeAgentSkill('org', 'vp-1', { name: 'a-one', description: 'One', content: '1' }, null)
    await writeAgentSkill('org', 'vp-1', { name: 'b-two', description: 'Two', content: '2' }, null)
    await old(skillFile('org', 'b-two'), 5)
    // The older release wrote only what it knew: b-two changed, c-three new, a-one missing.
    await legacy('_org', [{ name: 'b-two', description: 'Two', text: '2, changed there' }, { name: 'c-three', description: 'Three', text: '3' }])
    expect((await listAgentSkills('org', 'vp-1')).map((s) => [s.name, s.text])).toEqual([['a-one', '1'], ['b-two', '2, changed there'], ['c-three', '3']])
    expect(await exists(legacyJson('_org'))).toBe(false)
    // The JSON file, and the folder's version of b-two it replaced.
    expect(await takenFiles()).toEqual(['agent-skills/_org.json', 'replaced/org/skills/b-two/SKILL.md'])
  })

  it('keeps a folder skill changed after the JSON file was written', async () => {
    await legacy('_org', [{ name: 'a-one', description: 'One', text: 'from the old file' }])
    await old(legacyJson('_org'), 5)
    await fs.mkdir(path.dirname(skillFile('org', 'a-one')), { recursive: true })
    await fs.writeFile(skillFile('org', 'a-one'), '---\ndescription: "One"\n---\n\nedited by hand\n', 'utf-8')
    expect((await listAgentSkills('org', 'vp-1')).map((s) => s.text)).toEqual(['edited by hand'])
  })

  it('refuses a write when a skill cannot be read, rather than reading fewer skills', async () => {
    if (process.getuid?.() === 0) return // root reads every file
    await writeAgentSkill('org', 'vp-1', { name: 'a-one', description: 'One', content: '1' }, null)
    await writeAgentSkill('org', 'vp-1', { name: 'b-two', description: 'Two', content: '2' }, null)
    await fs.chmod(skillFile('org', 'a-one'), 0o000)
    try {
      await expect(writeAgentSkill('org', 'vp-1', { name: 'c-three', description: 'Three', content: '3' }, null)).rejects.toThrow()
      expect(await exists(skillFile('org', 'c-three'))).toBe(false)
    } finally {
      await fs.chmod(skillFile('org', 'a-one'), 0o644)
    }
  })

  it('reads a SKILL.md back as it was written, a bare value a person typed included', () => {
    const s = { name: 'x-y', description: 'When: a colon, "quotes" and \u4e2d\u6587', text: 'Body\n\n- a list', at: '2026-11-19T00:00:00.000Z', by: 'task:vp-1', by_name: 'Marina VP' }
    expect(parseSkillFile('x-y', renderSkillFile(s, 'org'), 'x')).toEqual(s)
    expect(parseSkillFile('z', '---\ndescription: Typed by hand\n---\nDo it.', '2026-01-01T00:00:00.000Z'))
      .toEqual({ name: 'z', description: 'Typed by hand', text: 'Do it.', at: '2026-01-01T00:00:00.000Z' })
    expect(parseSkillFile('z', 'No front matter at all', 'x')).toBeNull()
  })
})

describe('the memory folder', () => {
  it('writes a note only in the artifacts folder, and takes in a file an older release left there', async () => {
    await writeOwnNote('vp-1', 'plan.md', 'The plan.')
    expect(await fs.readFile(path.join(K(), 'nodes', 'vp-1', 'notes', 'plan.md'), 'utf-8')).toBe('The plan.\n')
    expect(await exists(legacyNotes('vp-1'))).toBe(false)
    await fs.mkdir(legacyNotes('vp-1'), { recursive: true })
    await fs.writeFile(path.join(legacyNotes('vp-1'), 'only-old.md'), 'Written by the older release.\n', 'utf-8')
    expect((await listMemoryFiles('vp-1')).filter((f) => !f.shared).map((f) => f.name)).toEqual(['only-old.md', 'plan.md'])
    expect((await readMemoryFile('vp-1', 'only-old.md')).text).toBe('Written by the older release.\n')
    expect(await exists(legacyNotes('vp-1'))).toBe(false)
    expect(await takenFiles()).toEqual(['agent-memory/vp-1/only-old.md'])
    await writeOwnNote('vp-1', 'plan.md', '')
    expect(await exists(path.join(K(), 'nodes', 'vp-1', 'notes', 'plan.md'))).toBe(false)
  })
})

describe('MEMORY.md', () => {
  it('is a file: written and read there, the task row untouched', async () => {
    const id = (await addTask({ title: 'Marina VP', project: 'Marina' })).task.id
    await changeNodeMemory(id, () => ({ text: '## Pending\n- CR 2 waits', at: '2026-11-20T01:00:00.000Z', by: 'human' }))
    expect(await readNodeMemory(id)).toEqual({ text: '## Pending\n- CR 2 waits', at: expect.any(String), by: 'human' })
    expect(await fs.readFile(memoryFile(id), 'utf-8')).toContain('kind: "memory"')
    expect(await rowMemory(id)).toBeUndefined()
  })

  it('takes a row\'s old memory in at the first read, clearing the row only once the file holds it', async () => {
    const id = (await addTask({ title: 'Marina VP', project: 'Marina' })).task.id
    await setRowMemory(id, { text: '- 2026-11-19: from the older release', at: '2026-11-19T00:00:00.000Z' })
    expect((await readNodeMemory(id))?.text).toBe('- 2026-11-19: from the older release')
    expect(await rowMemory(id)).toBeUndefined()
    // Then the older release appends to the row again (after a roll back): both are kept.
    await changeNodeMemory(id, (cur) => ({ ...cur!, text: `${cur!.text}\n- 2026-11-20: written here` }))
    await setRowMemory(id, { text: '- 2026-11-20: written there', at: '2026-11-20T02:00:00.000Z' })
    const both = (await readNodeMemory(id))!.text
    expect(both).toContain('- 2026-11-20: written here')
    expect(both).toContain('- 2026-11-20: written there')
    expect(await rowMemory(id)).toBeUndefined()
  })

  it('reads the copy the release before wrote as the memory', async () => {
    const id = (await addTask({ title: 'Marina VP', project: 'Marina' })).task.id
    await fs.mkdir(path.dirname(memoryFile(id)), { recursive: true })
    await fs.writeFile(memoryFile(id), '<!-- Walnut keeps this file: a copy ... -->\n\n- kept in the copy\n', 'utf-8')
    expect((await readNodeMemory(id))?.text).toBe('- kept in the copy')
    expect(await fs.readFile(memoryFile(id), 'utf-8')).toContain('kind: "memory"')
  })

  it('takes the row whole, its writer record included, over the read copy of the same text', async () => {
    const id = (await addTask({ title: 'Marina VP', project: 'Marina' })).task.id
    await fs.mkdir(path.dirname(memoryFile(id)), { recursive: true })
    await fs.writeFile(memoryFile(id), '<!-- Walnut keeps this file: a copy ... -->\n\n- the same\n', 'utf-8')
    await setRowMemory(id, { text: '- the same', at: '2026-11-19T00:00:00.000Z', by: 'task:w-1', by_name: 'the task "Pier"', by_at: '2026-11-19T00:00:00.000Z' } as never)
    expect(await readNodeMemory(id)).toEqual({ text: '- the same', at: '2026-11-19T00:00:00.000Z', by: 'task:w-1', by_name: 'the task "Pier"', by_at: '2026-11-19T00:00:00.000Z' })
  })

  it('keeps its date when only the file\'s time moves (a sync, a touch), so a rewrite asked for still lands', async () => {
    const id = (await addTask({ title: 'Marina VP', project: 'Marina' })).task.id
    const written = await changeNodeMemory(id, () => ({ text: '- one', at: '2026-11-20T00:00:00.000Z' }))
    const later = new Date(Date.now() + 3_600_000)
    await fs.utimes(memoryFile(id), later, later)
    expect((await readNodeMemory(id))?.at).toBe(written!.at)
  })

  it('writes nothing when its guard says no, under the lock', async () => {
    const id = (await addTask({ title: 'Marina VP', project: 'Marina' })).task.id
    await changeNodeMemory(id, () => ({ text: '- kept', at: '2026-11-20T00:00:00.000Z' }))
    await changeNodeMemory(id, () => ({ text: '- not written', at: '2026-11-20T01:00:00.000Z' }), { shouldWrite: async () => false })
    expect((await readNodeMemory(id))?.text).toBe('- kept')
  })

  it('merges a file and a row losing no line of either', () => {
    const file = { text: '# Mine\n- a', at: '2026-11-20T00:00:00.000Z', ops: ['k1'] }
    // The same text: the row's fields (its writer record) win, the file's applied ops stay.
    expect(mergeMemories(file, { text: '# Mine\n- a', at: 'x', by: 'human' })).toEqual({ text: '# Mine\n- a', at: 'x', by: 'human', ops: ['k1'] })
    expect(mergeMemories(file, { text: '# Mine\n- a\n- b', at: '2026-11-21T00:00:00.000Z' })).toEqual({ text: '# Mine\n- a\n- b', at: '2026-11-21T00:00:00.000Z', ops: ['k1'] })
    expect(mergeMemories(file, { text: '- a', at: 'x' })).toBe(file)
    const both = mergeMemories(file, { text: '- other', at: '2026-11-21T00:00:00.000Z' })
    expect(both.text).toMatch(/^# Mine\n- a\n\n## Kept from an older Walnut .*\n\n- other$/)
    expect(both.at).toBe('2026-11-21T00:00:00.000Z')
    expect(mergeMemories(undefined, { text: '- x', at: 'y' })).toEqual({ text: '- x', at: 'y' })
  })

  it('reads its file back as written, and dates a hand edit by the file\'s time', () => {
    const m = { text: '- \u4f60\u597d', at: '2026-11-20T00:00:00.000Z', by: 'task:w-1' as const, by_name: 'the task "x: y"', by_at: '2026-11-20T00:00:00.000Z', refused: { at: '2026-11-20T00:00:00.000Z', chars: 20_100 }, ops: ['a', 'b'] }
    expect(parseMemoryFile(renderMemoryFile(m), Date.parse(m.at))).toEqual({ format: 'file', memory: m })
    // Only its time moved: the date it was written stays.
    expect(parseMemoryFile(renderMemoryFile(m), Date.parse(m.at) + 60_000)).toEqual({ format: 'file', memory: m })
    // Its text changed by hand: dated by the file's time.
    const edited = parseMemoryFile(renderMemoryFile(m).replace('- \u4f60\u597d', '- edited'), Date.parse(m.at) + 60_000)
    expect(edited.format === 'file' && edited.memory.at).toBe('2026-11-20T00:01:00.000Z')
  })
})

describe('the boot move', () => {
  it('backs everything up once, takes every old place in, and does nothing again', async () => {
    const id = (await addTask({ title: 'Marina VP', project: 'Marina' })).task.id
    await setRowMemory(id, { text: '## Pending\n- CR 2 waits', at: '2026-11-19T10:00:00.000Z' })
    await legacy(id, [{ name: 'weekly-review', description: 'The weekly review', text: 'Step one.' }])
    await fs.mkdir(legacyNotes(id), { recursive: true })
    await fs.writeFile(path.join(legacyNotes(id), 'people.md'), 'Who owns what.\n', 'utf-8')
    await fs.mkdir(path.join(K(), 'nodes', id), { recursive: true })
    await fs.writeFile(path.join(K(), 'nodes', id, 'guidance.md'), '- a lesson\n', 'utf-8')

    const tasks = [await getTask(id)]
    const first = await moveIntoArtifacts(tasks)
    expect(first).toMatchObject({ skillScopes: 1, skills: 1, notes: 1, memories: 1 })
    // The backup: both old folders, the artifacts folder as it was, every row's memory.
    expect(await fs.readFile(path.join(first.backup!, 'agent-memory', id, 'people.md'), 'utf-8')).toBe('Who owns what.\n')
    expect(await exists(path.join(first.backup!, 'agent-skills', `${id}.json`))).toBe(true)
    expect(await fs.readFile(path.join(first.backup!, 'artifacts', 'nodes', id, 'guidance.md'), 'utf-8')).toBe('- a lesson\n')
    expect(JSON.parse(await fs.readFile(path.join(first.backup!, 'memories.json'), 'utf-8'))[id].text).toBe('## Pending\n- CR 2 waits')
    // Everything is in the artifacts folder, and the old places are empty.
    expect(await fs.readFile(path.join(K(), 'nodes', id, 'notes', 'people.md'), 'utf-8')).toBe('Who owns what.\n')
    expect(await exists(skillFile(id, 'weekly-review'))).toBe(true)
    expect((await readNodeMemory(id))?.text).toBe('## Pending\n- CR 2 waits')
    expect(await rowMemory(id)).toBeUndefined()
    expect(await exists(path.join(WALNUT_HOME, 'agent-skills'))).toBe(false)
    expect(await exists(path.join(WALNUT_HOME, 'agent-memory'))).toBe(false)

    const again = await moveIntoArtifacts([await getTask(id)])
    expect(again).toEqual({ backup: null, renamed: false, skillScopes: 0, skills: 0, notes: 0, memories: 0 })
  })

  it('renames the folder\'s first name, knowledge/, to artifacts/, and merges one written beside it later', async () => {
    const old = path.join(WALNUT_HOME, 'knowledge')
    await fs.mkdir(path.join(old, 'nodes', 'vp-1', 'notes'), { recursive: true })
    await fs.writeFile(path.join(old, 'nodes', 'vp-1', 'guidance.md'), '- lesson one\n', 'utf-8')
    await fs.writeFile(path.join(old, 'nodes', 'vp-1', 'notes', 'plan.md'), 'The plan.\n', 'utf-8')
    expect(await moveIntoArtifacts([])).toMatchObject({ renamed: true })
    expect(await fs.readFile(path.join(K(), 'nodes', 'vp-1', 'guidance.md'), 'utf-8')).toBe('- lesson one\n')
    // The first name stays a link to the folder: a path an earlier message named still opens.
    expect((await fs.lstat(old)).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(old)).toBe('artifacts')
    expect(await fs.readFile(path.join(old, 'nodes', 'vp-1', 'notes', 'plan.md'), 'utf-8')).toBe('The plan.\n')
    expect(await moveIntoArtifacts([])).toMatchObject({ renamed: false })
    expect((await fs.lstat(old)).isSymbolicLink()).toBe(true)
    // A real knowledge/ again (an older release on a host the link never reached): its new file comes in, the newer one here stays.
    await fs.unlink(old)
    await fs.mkdir(path.join(old, 'nodes', 'vp-1', 'notes'), { recursive: true })
    await fs.writeFile(path.join(old, 'nodes', 'vp-1', 'notes', 'new.md'), 'From the older release.\n', 'utf-8')
    await fs.writeFile(path.join(old, 'nodes', 'vp-1', 'guidance.md'), '- stale\n', 'utf-8')
    const t = new Date(Date.now() - 3_600_000)
    await fs.utimes(path.join(old, 'nodes', 'vp-1', 'guidance.md'), t, t)
    expect(await moveIntoArtifacts([])).toMatchObject({ renamed: true })
    expect((await fs.lstat(old)).isSymbolicLink()).toBe(true)
    expect((await readMemoryFile('vp-1', 'new.md')).text).toBe('From the older release.\n')
    expect(await fs.readFile(path.join(K(), 'nodes', 'vp-1', 'guidance.md'), 'utf-8')).toBe('- lesson one\n')
  })
})

describe('going back', () => {
  it('writes the old places back from the artifacts folder, for the release before', async () => {
    const id = (await addTask({ title: 'Marina VP', project: 'Marina' })).task.id
    await moveIntoArtifacts([])
    await writeAgentSkill('own', id, { name: 'weekly-review', description: 'The weekly review', content: 'Step one.' }, null)
    await writeOwnNote(id, 'people.md', 'Who owns what.')
    await changeNodeMemory(id, () => ({ text: '- CR 2 waits', at: '2026-11-20T00:00:00.000Z', ops: ['k'] }))
    const r = await rollbackArtifacts()
    expect(r).toMatchObject({ skillScopes: 1, notes: 1, memories: 1, skipped: [] })
    expect(JSON.parse(await fs.readFile(legacyJson(id), 'utf-8')).skills.map((s: { name: string }) => s.name)).toEqual(['weekly-review'])
    expect(await fs.readFile(path.join(legacyNotes(id), 'people.md'), 'utf-8')).toBe('Who owns what.\n')
    expect(await rowMemory(id)).toEqual({ text: '- CR 2 waits', at: expect.any(String) })
    expect(JSON.parse(await fs.readFile(path.join(K(), '.moved.json'), 'utf-8')).version).toBe(1)
    // The release before reads skills and notes under the folder's first name, and its MEMORY.md on the row only.
    expect((await fs.lstat(path.join(WALNUT_HOME, 'knowledge'))).isDirectory()).toBe(true)
    expect(await exists(path.join(WALNUT_HOME, 'knowledge', 'nodes', id, 'skills', 'weekly-review', 'SKILL.md'))).toBe(true)
    expect(await exists(memoryFile(id))).toBe(false)
    // The older release rewrites the memory shorter; coming forward takes the row whole, not merged with the old file.
    await setRowMemory(id, { text: '- shorter', at: '2026-11-21T00:00:00.000Z' })
    const back = await moveIntoArtifacts([await getTask(id)])
    expect(back.backup).toBeTruthy()
    expect((await readNodeMemory(id))?.text).toBe('- shorter')
    expect((await listAgentSkills('own', id)).map((s) => s.name)).toEqual(['weekly-review'])
  })
})
