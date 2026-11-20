/**
 * The move into one tree by project, on disk (src/core/artifacts/unify/migrate-unified.ts): the
 * shadow, the byte check, the switch with the old trees kept whole, a crash part way, and the way
 * back with what was written since. Temp folders only.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { abortRollback, abortSwitch, adoptStrayVault, finishSwitch, readUnified, rollbackUnified, unifyTree, type UnifyDirs } from '../../../src/core/artifacts/unify/migrate-unified.js'
import { mapPath } from '../../../src/core/artifacts/unify/layout.js'

let home = ''
let dirs: UnifyDirs

async function put(rel: string, text: string): Promise<void> {
  const f = path.join(home, rel)
  await fs.mkdir(path.dirname(f), { recursive: true })
  await fs.writeFile(f, text)
}
const read = (rel: string) => fs.readFile(path.join(home, rel), 'utf-8')
const exists = (rel: string) => fss.existsSync(path.join(home, rel))

async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const f of (await fs.readdir(root, { recursive: true })).map(String)) {
    const st = await fs.lstat(path.join(root, f))
    const key = f.split(path.sep).join('/')
    if (st.isSymbolicLink()) out[key] = `link:${await fs.readlink(path.join(root, f))}`
    else if (st.isFile() && !f.endsWith('.DS_Store')) out[key] = await fs.readFile(path.join(root, f), 'utf-8')
  }
  return out
}

const input = { projects: ['Marina', 'Lagoon'], nodes: [{ id: 'vp-1', project: 'Marina' }, { id: 'main', project: '' }] }

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-unify-'))
  dirs = { notes: path.join(home, 'notes'), artifacts: path.join(home, 'artifacts') }
  await put('notes/marina/plan.md', '# Plan\n\nSee [the pier](../tidepool/pier.md).\n')
  await put('notes/Projects/Marina/Tracking.md', '# Marina tracking\n')
  await put('notes/Projects/Marina/Pier review (t-1)/Flow.excalidraw', '{"type":"excalidraw"}')
  await put('notes/Projects/Marina/Pier review (t-1)/Flow.drawing.md', '---\nkind: walnut-drawing\n---\n')
  await put('notes/tidepool/pier.md', 'The pier opens at noon.\n')
  await put('notes/inbox/Sketch.excalidraw', '{}')
  await put('notes/_attachment/photo.png', '\u0000\u0001binary')
  await put('notes/global-notes.md', 'global\n')
  await put('artifacts/nodes/vp-1/MEMORY.md', '---\nkind: memory\n---\n\n- pending\n')
  await put('artifacts/nodes/vp-1/skills/pier-steps/SKILL.md', '---\nname: pier-steps\n---\nSteps.\n')
  await put('artifacts/nodes/main/MEMORY.md', 'main memory\n')
  await put('artifacts/org/skills/proof-video/SKILL.md', 'org skill\n')
  await put('artifacts/shared/notes/skills-index.md', 'index\n')
  await put('artifacts/.moved.json', '{"version":2}')
  await fs.symlink('/somewhere/else/Archive', path.join(home, 'notes/tidepool/archive-link'))
})

describe('the move into one tree', () => {
  it('puts every file in its new place, byte for byte, and keeps the old trees whole as the backup', async () => {
    const before = { ...(await tree(dirs.notes)) }
    const artBefore = await tree(dirs.artifacts)
    const r = await unifyTree(dirs, input)
    expect(r.moved).toBe(14)
    // The user's own link comes along as a link, pointing where it did.
    expect(await fs.readlink(path.join(home, 'artifacts/notes/tidepool/archive-link'))).toBe('/somewhere/else/Archive')
    expect(await read("artifacts/.moved.json")).toBe('{"version":2}')
    expect(await read('artifacts/projects/Marina/notes/plan.md')).toBe(before['marina/plan.md'])
    expect(await read('artifacts/projects/Marina/notes/Tracking.md')).toBe('# Marina tracking\n')
    expect(await read('artifacts/projects/Marina/drawings/Pier review (t-1)/Flow.excalidraw')).toBe('{"type":"excalidraw"}')
    expect(await read('artifacts/drawings/Sketch.excalidraw')).toBe('{}')
    expect(await read('artifacts/notes/tidepool/pier.md')).toBe('The pier opens at noon.\n')
    expect(await read('artifacts/notes/_attachment/photo.png')).toBe('\u0000\u0001binary')
    expect(await read('artifacts/projects/Marina/memory/vp-1/MEMORY.md')).toContain('- pending')
    expect(await read('artifacts/projects/Marina/skills/pier-steps/SKILL.md')).toContain('Steps.')
    expect(await read('artifacts/memory/main/MEMORY.md')).toBe('main memory\n')
    expect(await read('artifacts/skills/proof-video/SKILL.md')).toBe('org skill\n')
    expect(await read('artifacts/memory/_shared/notes/skills-index.md')).toBe('index\n')
    // The old places are gone, kept whole in the backup.
    expect(exists('notes')).toBe(false)
    expect(exists('artifacts/nodes')).toBe(false)
    const rec = (await readUnified(dirs))!
    expect(rec.state).toBe('live')
    expect(await tree(path.join(dirs.artifacts, rec.backup, 'notes'))).toEqual(before)
    expect((await tree(path.join(dirs.artifacts, rec.backup, 'artifacts')))['nodes/vp-1/MEMORY.md']).toBe(artBefore['nodes/vp-1/MEMORY.md'])
    expect(exists('artifacts/.unify-stage')).toBe(false)
    // An old path still finds its file, and a relative link resolves from where its note used to be.
    const map = { exact: rec.vault.exact, rules: rec.vault.rules }
    expect(mapPath('marina/plan.md', map)).toBe('projects/Marina/notes/plan.md')
    expect(mapPath(path.posix.normalize('marina/../tidepool/pier.md'), map)).toBe('notes/tidepool/pier.md')
    await expect(unifyTree(dirs, input)).rejects.toThrow(/already/)
  })

  it('finishes a switch a crash cut short, and loses no file', async () => {
    await unifyTree(dirs, input)
    const rec = (await readUnified(dirs))!
    const want = await tree(dirs.artifacts)
    // As if the process died after the old notes moved out and part of the shadow moved in.
    const stage = path.join(dirs.artifacts, '.unify-stage')
    await fs.mkdir(stage, { recursive: true })
    await fs.rename(path.join(dirs.artifacts, 'projects'), path.join(stage, 'projects'))
    await fs.mkdir(path.join(stage, 'notes'), { recursive: true })
    await fs.rename(path.join(dirs.artifacts, 'notes', 'tidepool'), path.join(stage, 'notes', 'tidepool'))
    await fs.writeFile(path.join(dirs.artifacts, '.unified.json'), JSON.stringify({ ...rec, state: 'switching' }))
    await finishSwitch(dirs, { ...rec, state: 'switching' })
    expect(await tree(dirs.artifacts)).toEqual({ ...want, '.unified.json': expect.any(String) })
    expect((await readUnified(dirs))!.state).toBe('live')
  })

  it('goes back with what was written since: an edit, a new note, a new drawing, a new memory', async () => {
    const before = await tree(dirs.notes)
    await unifyTree(dirs, input)
    await put('artifacts/projects/Marina/notes/plan.md', '# Plan, edited after the move\n')
    await put('artifacts/projects/Marina/notes/new-idea.md', 'New.\n')
    await put('artifacts/notes/tidepool/new.md', 'Tidepool, new.\n')
    await put('artifacts/drawings/Later.excalidraw', '{"later":1}')
    await put('artifacts/projects/Marina/memory/vp-1/notes/later.md', 'later note\n')
    const r = await rollbackUnified(dirs)
    expect(r.madeSince).toBe(5 - 1)
    expect(await read('notes/marina/plan.md')).toBe('# Plan, edited after the move\n')
    // A new note in a folder two old ones met in goes to the Projects/ one.
    expect(await read('notes/Projects/Marina/new-idea.md')).toBe('New.\n')
    expect(await read('notes/tidepool/new.md')).toBe('Tidepool, new.\n')
    expect(await read('notes/inbox/Later.excalidraw')).toBe('{"later":1}')
    expect(await read('artifacts/nodes/vp-1/notes/later.md')).toBe('later note\n')
    expect(await read('artifacts/org/skills/proof-video/SKILL.md')).toBe('org skill\n')
    expect(await read('notes/Projects/Marina/Pier review (t-1)/Flow.drawing.md')).toBe(before['Projects/Marina/Pier review (t-1)/Flow.drawing.md'])
    expect(await read('notes/_attachment/photo.png')).toBe('\u0000\u0001binary')
    expect(exists('artifacts/projects')).toBe(false)
    expect(await readUnified(dirs)).toBeNull()
    // The tree as it was is kept too.
    expect(exists(path.join('artifacts', r.kept, 'projects/Marina/notes/plan.md'))).toBe(true)
    // And forward again works on what the roll back left.
    const again = await unifyTree(dirs, input)
    expect(again.moved).toBe(r.restored)
    expect(await read('artifacts/projects/Marina/notes/new-idea.md')).toBe('New.\n')
  })
})

describe('the move and the way back, cut short or raced (review 2026-11-20)', () => {
  const crash = async () => { throw new Error('stopped here') }

  it('a switch a stop cut short, with an empty notes/ made again and a late write, finishes losing nothing', async () => {
    await expect(unifyTree(dirs, input, crash)).rejects.toThrow('stopped here')
    const rec = (await readUnified(dirs))!
    expect(rec.state).toBe('switching')
    // A boot made notes/ again (init), and a writer reached the old vault in the backup late.
    await fs.mkdir(dirs.notes, { recursive: true })
    await put(path.join('artifacts', rec.backup, 'notes/tidepool/late.md'), 'written late\n')
    await put(path.join('artifacts', rec.backup, 'notes/tidepool/pier.md'), 'The pier opens at one.\n')
    await finishSwitch(dirs, rec)
    expect((await readUnified(dirs))!.state).toBe('live')
    expect(exists('notes')).toBe(false)
    expect(await read('artifacts/notes/tidepool/late.md')).toBe('written late\n')
    expect(await read('artifacts/notes/tidepool/pier.md')).toBe('The pier opens at one.\n')
  })

  it('a way back a stop cut short is finished, and a notes/ something made meanwhile keeps its files', async () => {
    await unifyTree(dirs, input)
    await put('artifacts/projects/Lagoon/memory/t-new/MEMORY.md', 'made since under a project\n')
    await put('artifacts/projects/Lagoon/notes/new.md', 'a new project note\n')
    await put('notes/written-by-old-release.md', 'kept\n')
    await expect(rollbackUnified(dirs, crash)).rejects.toThrow('stopped here')
    expect((await readUnified(dirs))!.state).toBe('rolling-back')
    await rollbackUnified(dirs)
    expect(await readUnified(dirs)).toBeNull()
    expect(await read('notes/tidepool/pier.md')).toBe('The pier opens at noon.\n')
    expect(await read('notes/written-by-old-release.md')).toBe('kept\n')
    // A task made or moved after the switch: its memory goes to its nodes/ folder.
    expect(await read('artifacts/nodes/t-new/MEMORY.md')).toBe('made since under a project\n')
    // A project made after the switch: its notes go to its tracking folder.
    expect(await read('notes/Projects/Lagoon/new.md')).toBe('a new project note\n')
  })

  it('leaves a vault that is a link where it is', async () => {
    const real = path.join(home, 'synced-vault')
    await fs.rename(dirs.notes, real)
    await fs.symlink(real, dirs.notes)
    await expect(unifyTree(dirs, input)).rejects.toThrow('is a link')
    expect(await readUnified(dirs)).toBeNull()
    expect(await read('notes/tidepool/pier.md')).toBe('The pier opens at noon.\n')
  })
})

describe('a step that cannot finish is undone (review round 2)', () => {
  const crash = async () => { throw new Error('stopped here') }

  it('a switch undone puts every file back where it began, and the move can run again', async () => {
    const before = await tree(dirs.notes)
    const artBefore = await tree(path.join(dirs.artifacts, 'nodes'))
    await expect(unifyTree(dirs, input, crash)).rejects.toThrow('stopped here')
    await abortSwitch(dirs, (await readUnified(dirs))!)
    expect(await readUnified(dirs)).toBeNull()
    expect(await tree(dirs.notes)).toEqual(before)
    expect(await tree(path.join(dirs.artifacts, 'nodes'))).toEqual(artBefore)
    expect(exists('artifacts/projects')).toBe(false)
    await fs.rm(path.join(dirs.artifacts, '.unify-aborted.json'))
    await unifyTree(dirs, input)
    expect((await readUnified(dirs))!.state).toBe('live')
  })

  it('an undo a stop cut short resumes the undo, never the switch, and the move is not tried again by itself', async () => {
    const before = await tree(dirs.notes)
    await expect(unifyTree(dirs, input, crash)).rejects.toThrow('stopped here')
    const rec = (await readUnified(dirs))!
    // The undo was cut short right after it recorded itself.
    await fs.writeFile(path.join(dirs.artifacts, '.unified.json'), JSON.stringify({ ...rec, state: 'aborting-switch', aside: path.join(rec.backup, 'aborted-tree-x') }))
    await abortSwitch(dirs, (await readUnified(dirs))!)
    expect(await readUnified(dirs)).toBeNull()
    expect(await tree(dirs.notes)).toEqual(before)
    expect(exists('artifacts/.unify-aborted.json')).toBe(true)
  })

  it('a way back undone leaves the tree live, whole', async () => {
    await unifyTree(dirs, input)
    const treeBefore = await tree(path.join(dirs.artifacts, 'projects'))
    await expect(rollbackUnified(dirs, crash)).rejects.toThrow('stopped here')
    await abortRollback(dirs, (await readUnified(dirs))!)
    expect((await readUnified(dirs))!.state).toBe('live')
    expect(await tree(path.join(dirs.artifacts, 'projects'))).toEqual(treeBefore)
    expect(exists('notes')).toBe(false)
    expect(exists('artifacts/nodes')).toBe(false)
  })

  it('two files going back to one place are both kept, the later numbered', async () => {
    await unifyTree(dirs, input)
    // A merge left a task's memory in two homes.
    await put('artifacts/memory/vp-1/MEMORY.md', 'the other copy\n')
    await rollbackUnified(dirs)
    expect(await read('artifacts/nodes/vp-1/MEMORY.md')).toContain('pending')
    expect(await read('artifacts/nodes/vp-1/MEMORY 2.md')).toBe('the other copy\n')
  })

  it('takes in a file written to the old vault place while the tree is live', async () => {
    await unifyTree(dirs, input)
    await put('notes/tidepool/stray.md', 'written to the old place\n')
    expect(await adoptStrayVault(dirs, (await readUnified(dirs))!)).toBe(1)
    expect(await read('artifacts/notes/tidepool/stray.md')).toBe('written to the old place\n')
    expect(exists('notes')).toBe(false)
  })
})
