/**
 * The old vault place's links (src/core/artifacts/unify/old-places.ts): which places link where,
 * and that only this module's links are ever taken out.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { linkKnowledgePlaces, linkVaultPlaces, obsidianExcludesNotes, unlinkKnowledgePlaces, unlinkVaultPlaces, vaultLinkPlan } from '../../../src/core/artifacts/unify/old-places.js'

describe('vaultLinkPlan', () => {
  it('links a folder that moved whole, and splits one whose files went two ways', () => {
    const plan = vaultLinkPlan([
      ['cove/a.md', 'projects/Cove/notes/a.md'],
      ['cove/deep/b.md', 'projects/Cove/notes/deep/b.md'],
      ['inbox/c.md', 'notes/inbox/c.md'],
      ['inbox/d.excalidraw', 'drawings/d.excalidraw'],
      ['Projects/Cove/Tracking.md', 'projects/Cove/notes/Tracking.md'],
      ['top.md', 'notes/top.md'],
    ])
    expect(plan).toEqual(expect.arrayContaining([
      ['cove', 'projects/Cove/notes'],
      ['inbox/c.md', 'notes/inbox/c.md'],
      ['inbox/d.excalidraw', 'drawings/d.excalidraw'],
      ['Projects/Cove', 'projects/Cove/notes'],
      ['top.md', 'notes/top.md'],
    ]))
    expect(plan).toHaveLength(5)
  })
})

describe('linkVaultPlaces / unlinkVaultPlaces', () => {
  let home: string
  const dirs = () => ({ notes: path.join(home, 'notes'), artifacts: path.join(home, 'artifacts') })
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-old-places-'))
    await fs.mkdir(path.join(home, 'artifacts/projects/Cove/notes'), { recursive: true })
    await fs.writeFile(path.join(home, 'artifacts/projects/Cove/notes/a.md'), 'A\n')
  })

  it('re-points a stale link, leaves a real file and the person\'s own link, and unlinks only its own', async () => {
    const pairs: Array<[string, string]> = [['cove/a.md', 'projects/Cove/notes/a.md'], ['ledger/x.md', 'notes/ledger/x.md']]
    await fs.mkdir(path.join(home, 'notes/ledger'), { recursive: true })
    await fs.writeFile(path.join(home, 'notes/ledger/x.md'), 'stray\n')
    await fs.symlink('/tmp', path.join(home, 'notes/mine'))
    const first = await linkVaultPlaces(dirs(), pairs)
    expect(first.made).toBe(1)
    expect(await fs.readFile(path.join(home, 'notes/cove/a.md'), 'utf-8')).toBe('A\n')
    // The folder renamed: the link follows on the next call.
    await fs.rename(path.join(home, 'artifacts/projects/Cove'), path.join(home, 'artifacts/projects/Seawall'))
    const again = await linkVaultPlaces(dirs(), [['cove/a.md', 'projects/Seawall/notes/a.md']])
    expect(again).toMatchObject({ made: 1, removed: 1 })
    expect(await fs.readFile(path.join(home, 'notes/cove/a.md'), 'utf-8')).toBe('A\n')
    expect(await unlinkVaultPlaces(dirs())).toBe(1)
    expect(await fs.readFile(path.join(home, 'notes/ledger/x.md'), 'utf-8')).toBe('stray\n')
    expect((await fs.lstat(path.join(home, 'notes/mine'))).isSymbolicLink()).toBe(true)
    await expect(fs.lstat(path.join(home, 'notes/cove'))).rejects.toThrow()
  })

  it('clears a link place that holds only leftovers, reports one with real files, and needs no mark to unlink', async () => {
    await fs.mkdir(path.join(home, 'artifacts/notes/ledger'), { recursive: true })
    await fs.writeFile(path.join(home, 'artifacts/notes/ledger/x.md'), 'X\n')
    await fs.mkdir(path.join(home, 'notes/cove'), { recursive: true })
    await fs.writeFile(path.join(home, 'notes/cove/.DS_Store'), '')
    await fs.mkdir(path.join(home, 'notes/ledger'), { recursive: true })
    await fs.writeFile(path.join(home, 'notes/ledger/real.md'), 'mine\n')
    const report = await linkVaultPlaces(dirs(), [['cove/a.md', 'projects/Cove/notes/a.md'], ['ledger/x.md', 'notes/ledger/x.md']])
    expect(report).toMatchObject({ made: 1, blocked: ['ledger'] })
    expect(await fs.readFile(path.join(home, 'notes/cove/a.md'), 'utf-8')).toBe('A\n')
    expect(await fs.readFile(path.join(home, 'notes/ledger/real.md'), 'utf-8')).toBe('mine\n')
    await fs.rm(path.join(home, 'notes/.walnut-links'))
    expect(await unlinkVaultPlaces(dirs())).toBe(1)
    await expect(fs.lstat(path.join(home, 'notes/cove'))).rejects.toThrow()
    expect(await fs.readFile(path.join(home, 'notes/ledger/real.md'), 'utf-8')).toBe('mine\n')
  })

  it('excludes notes/ from Obsidian while the links stand, and takes out only its own entry', async () => {
    const app = () => fs.readFile(path.join(home, '.obsidian/app.json'), 'utf-8').then((t) => JSON.parse(t))
    await fs.mkdir(path.join(home, '.obsidian'), { recursive: true })
    await fs.writeFile(path.join(home, '.obsidian/app.json'), JSON.stringify({ userIgnoreFilters: ['archive/'], theme: 'x' }))
    await linkVaultPlaces(dirs(), [['cove/a.md', 'projects/Cove/notes/a.md']])
    expect(await app()).toEqual({ userIgnoreFilters: ['archive/', 'notes/'], theme: 'x' })
    await unlinkVaultPlaces(dirs())
    expect(await app()).toEqual({ userIgnoreFilters: ['archive/'], theme: 'x' })
    // Nothing left: notes/ itself goes.
    await expect(fs.lstat(path.join(home, 'notes'))).rejects.toThrow()
    // A running Obsidian writes its old list back once: the next start on the folders takes it out again.
    await fs.writeFile(path.join(home, '.obsidian/app.json'), JSON.stringify({ userIgnoreFilters: ['archive/', 'notes/'], theme: 'x' }))
    await obsidianExcludesNotes(dirs(), false)
    expect(await app()).toEqual({ userIgnoreFilters: ['archive/'], theme: 'x' })
    await obsidianExcludesNotes(dirs(), false)
    // The person's own entry stays, through a whole on and off.
    await fs.writeFile(path.join(home, '.obsidian/app.json'), JSON.stringify({ userIgnoreFilters: ['notes/'] }))
    await linkVaultPlaces(dirs(), [['cove/a.md', 'projects/Cove/notes/a.md']])
    await unlinkVaultPlaces(dirs())
    await obsidianExcludesNotes(dirs(), false)
    expect(await app()).toEqual({ userIgnoreFilters: ['notes/'] })
  })
})

describe('linkKnowledgePlaces', () => {
  it('links a task folder and keeps a real file an older writer left when it unlinks', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-old-places-k-'))
    const art = path.join(home, 'artifacts'); const k = path.join(home, 'knowledge')
    await fs.mkdir(path.join(art, 'projects/Cove/memory/t1'), { recursive: true })
    await fs.writeFile(path.join(art, 'projects/Cove/memory/t1/MEMORY.md'), 'M\n')
    await fs.mkdir(path.join(art, 'skills'), { recursive: true })
    await linkKnowledgePlaces(k, art, [['a:nodes/t1/MEMORY.md', 'projects/Cove/memory/t1/MEMORY.md']])
    expect(await fs.readFile(path.join(k, 'nodes/t1/MEMORY.md'), 'utf-8')).toBe('M\n')
    await fs.mkdir(path.join(k, 'nodes/t2'), { recursive: true })
    await fs.writeFile(path.join(k, 'nodes/t2/late.md'), 'late\n')
    expect(await unlinkKnowledgePlaces(k, art)).toBeGreaterThan(0)
    expect(await fs.readFile(path.join(k, 'nodes/t2/late.md'), 'utf-8')).toBe('late\n')
    await expect(fs.lstat(path.join(k, 'nodes/t1'))).rejects.toThrow()
  })
})
