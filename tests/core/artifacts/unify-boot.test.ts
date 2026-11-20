/**
 * The one tree at boot (src/core/artifacts/unify/boot.ts), end to end on a temp home: the switch
 * on moves the notes and the artifacts in and puts every way in on the tree (old note paths,
 * a task's memory and skills, the bookmarks, the old knowledge/ paths); a task that changes
 * project takes its memory along; the switch off brings it all back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-unify-boot'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, getTask, updateTask } from '../../../src/core/task-manager.js'
import { getConfig, updateConfig } from '../../../src/core/config-manager.js'
import { startUnifiedTree } from '../../../src/core/artifacts/unify/boot.js'
import { followTaskProject } from '../../../src/core/artifacts/unify/task-homes.js'
import { notesRoot, resolveNotePath } from '../../../src/core/notes/note-paths.js'
import { memoryCopyOf, nodeArtifactsDir, skillsDirOf } from '../../../src/core/artifacts/paths.js'
import { readNodeMemory, changeNodeMemory } from '../../../src/core/artifacts/node-memory.js'
import type { Task } from '../../../src/core/types.js'

const at = (...p: string[]) => path.join(WALNUT_HOME, ...p)
async function put(rel: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(at(rel)), { recursive: true })
  await fs.writeFile(at(rel), text)
}

let task: Task
let main: Task

beforeEach(async () => {
  for (const d of ['notes', 'artifacts', 'knowledge']) await fs.rm(at(d), { recursive: true, force: true })
  task = (await addTask({ title: 'Marina pier lead', project: 'Marina' })).task
  main = (await addTask({ title: 'Lagoon errand' })).task
  await put('notes/marina/plan.md', '# Plan\n')
  await put('notes/Projects/Marina/Tracking.md', '# Tracking\n')
  await put('notes/tidepool/pier.md', 'Pier.\n')
  await put(`artifacts/nodes/${task.id}/MEMORY.md`, '---\nkind: memory\n---\n\n- the pier opens Friday\n')
  await put(`artifacts/nodes/${task.id}/reflections/2026-11-19.md`, '# Session reflection\n')
  await put(`artifacts/nodes/${task.id}/skills/pier-steps/SKILL.md`, '---\nname: pier-steps\ndescription: Pier steps\n---\nStep one.\n')
  await put(`artifacts/nodes/${main.id}/MEMORY.md`, '---\nkind: memory\n---\n\n- errands\n')
  await put('artifacts/org/skills/proof-video/SKILL.md', '---\nname: proof-video\ndescription: Videos\n---\nSharp.\n')
  await updateConfig({ favorites: { projects: [], notes: ['marina/plan.md', 'tidepool/pier.md'] } } as never)
})

const boot = async (on: boolean) => startUnifiedTree({ on, leader: true, tasks: [task, main], projects: ['Marina', 'Lagoon'] })

describe('the one tree at boot', () => {
  it('moves in, puts every way in on the tree, and moves back when the switch goes off', async () => {
    expect(await boot(true)).toBe('tree')
    expect(notesRoot()).toBe(at('artifacts'))
    // An old note path, and the tree's own.
    expect(resolveNotePath('marina/plan.md')).toBe(at('artifacts/projects/Marina/notes/plan.md'))
    expect(resolveNotePath('notes/tidepool/pier.md')).toBe(at('artifacts/notes/tidepool/pier.md'))
    expect(await fs.readFile(resolveNotePath('Projects/Marina/Tracking.md')!, 'utf-8')).toBe('# Tracking\n')
    // A task's memory and skills, under its project; a task with none, at the root.
    expect(nodeArtifactsDir(task.id)).toBe(at(`artifacts/projects/Marina/memory/${task.id}`))
    expect((await readNodeMemory(task.id))?.text).toContain('the pier opens Friday')
    expect(skillsDirOf('own', task.id)).toBe(at('artifacts/projects/Marina/skills'))
    expect(skillsDirOf('org', task.id)).toBe(at('artifacts/skills'))
    expect(memoryCopyOf(main.id)).toBe(at(`artifacts/memory/${main.id}/MEMORY.md`))
    expect(fss.existsSync(at('artifacts/skills/proof-video/SKILL.md'))).toBe(true)
    // The bookmarks follow; the old folders are gone, kept in the backup.
    expect((await getConfig()).favorites?.notes).toEqual(['projects/Marina/notes/plan.md', 'notes/tidepool/pier.md'])
    expect(fss.existsSync(at('notes'))).toBe(false)
    // A path a message named under the folder's first name still opens.
    expect(await fs.readFile(at(`knowledge/nodes/${task.id}/reflections/2026-11-19.md`), 'utf-8')).toBe('# Session reflection\n')
    expect(await fs.readFile(at('knowledge/org/skills/proof-video/SKILL.md'), 'utf-8')).toContain('Sharp.')

    // A write lands in the tree.
    await changeNodeMemory(task.id, (m) => ({ text: `${m?.text ?? ''}\n- a new line`, at: new Date().toISOString() }))
    expect(await fs.readFile(at(`artifacts/projects/Marina/memory/${task.id}/MEMORY.md`), 'utf-8')).toContain('- a new line')

    // A second boot with the switch on changes nothing.
    expect(await boot(true)).toBe('tree')
    expect(resolveNotePath('marina/plan.md')).toBe(at('artifacts/projects/Marina/notes/plan.md'))

    // Off: everything back where it was, the new line included.
    expect(await boot(false)).toBe('folders')
    expect(notesRoot()).toBe(at('notes'))
    expect(await fs.readFile(at('notes/marina/plan.md'), 'utf-8')).toBe('# Plan\n')
    expect(await fs.readFile(at(`artifacts/nodes/${task.id}/MEMORY.md`), 'utf-8')).toContain('- a new line')
    expect(nodeArtifactsDir(task.id)).toBe(at(`artifacts/nodes/${task.id}`))
    expect((await getConfig()).favorites?.notes).toEqual(['marina/plan.md', 'tidepool/pier.md'])
    expect(fss.existsSync(at('knowledge/.walnut-links'))).toBe(false)
    expect(fss.existsSync(at('artifacts/projects'))).toBe(false)
  })

  it('takes a task\'s memory along when it moves to another project', async () => {
    await boot(true)
    await updateTask(task.id, { project: 'Lagoon' })
    await followTaskProject(task.id, 'Lagoon')
    expect(nodeArtifactsDir(task.id)).toBe(at(`artifacts/projects/Lagoon/memory/${task.id}`))
    expect((await readNodeMemory(task.id))?.text).toContain('the pier opens Friday')
    expect(fss.existsSync(at(`artifacts/projects/Marina/memory/${task.id}`))).toBe(false)
    await updateTask(task.id, { project: '' })
    // An event that carried an older copy of the task never moves it back.
    await followTaskProject(task.id, 'Lagoon')
    expect(nodeArtifactsDir(task.id)).toBe(at(`artifacts/memory/${task.id}`))
    expect((await readNodeMemory(task.id))?.text).toContain('the pier opens Friday')
    expect((await getTask(task.id)).id).toBe(task.id)
    await boot(false)
  })

  it('leaves the notes where they are when the switch stays off', async () => {
    expect(await boot(false)).toBe('folders')
    expect(fss.existsSync(at('notes/marina/plan.md'))).toBe(true)
    expect(fss.existsSync(at('artifacts/.unified.json'))).toBe(false)
  })
})

describe('what names a note follows the tree (review 2026-11-20)', () => {
  it('keeps a private folder out of the replicas and the search, both ways', async () => {
    await put('notes/Projects/Marina/Pilings/a.md', 'private\n')
    await updateConfig({ hosts: { lagoon: { keep: { notes_exclude: ['Projects/Marina', 'tidepool/pier.md'] } } }, search: { excluded_folders: ['tidepool'] } } as never)
    await boot(true)
    const on = await getConfig() as never as { hosts: { lagoon: { keep: { notes_exclude: string[] } } }; search: { excluded_folders: string[] } }
    expect(on.hosts.lagoon.keep.notes_exclude).toEqual(['projects/Marina', 'notes/tidepool/pier.md'])
    expect(on.search.excluded_folders).toEqual(['notes/tidepool'])
    await boot(false)
    const off = await getConfig() as never as typeof on
    expect(off.hosts.lagoon.keep.notes_exclude).toEqual(['Projects/Marina', 'tidepool/pier.md'])
    expect(off.search.excluded_folders).toEqual(['tidepool'])
  })

  it('moves a renamed project\'s folder, and an old path still lands', async () => {
    await boot(true)
    const { followProjectRename } = await import('../../../src/core/artifacts/unify/boot.js')
    await followProjectRename('Marina', 'Cove')
    expect(await fs.readFile(at('artifacts/projects/Cove/notes/plan.md'), 'utf-8')).toBe('# Plan\n')
    expect(resolveNotePath('marina/plan.md')).toBe(at('artifacts/projects/Cove/notes/plan.md'))
    expect(nodeArtifactsDir(task.id)).toBe(at(`artifacts/projects/Cove/memory/${task.id}`))
    expect(fss.existsSync(at('artifacts/projects/Marina'))).toBe(false)
    await boot(false)
    expect(await fs.readFile(at('notes/marina/plan.md'), 'utf-8')).toBe('# Plan\n')
  })
})
