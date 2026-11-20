/**
 * A link into the tree under the old vault place is never taken in as a stray
 * (src/core/artifacts/unify/migrate-unified.ts adoptStrayVault): a release that links the old
 * places to the tree may run before an older one, which must not put a link where a note is.
 * Review 2026-11-20: taking one in replaced the real note with a link that points nowhere.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { adoptStrayVault, readUnified, unifyTree } from '../../../src/core/artifacts/unify/migrate-unified.js'

describe('adoptStrayVault and links into the tree', () => {
  it('leaves the tree\'s notes whole and takes in only the real stray', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-adopt-links-'))
    const dirs = { notes: path.join(home, 'notes'), artifacts: path.join(home, 'artifacts') }
    const put = async (rel: string, text: string) => { await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true }); await fs.writeFile(path.join(home, rel), text) }
    await put('notes/cove/a.md', 'A\n')
    await put('notes/top.md', 'Top\n')
    await unifyTree(dirs, { projects: ['Cove'], nodes: [] })
    const record = (await readUnified(dirs))!
    // The old places as links (a folder, a file), no marker, and one real file written beside them.
    await fs.mkdir(dirs.notes, { recursive: true })
    await fs.symlink('../artifacts/projects/Cove/notes', path.join(dirs.notes, 'cove'))
    await fs.symlink('../artifacts/notes/top.md', path.join(dirs.notes, 'top.md'))
    await put('notes/seawall/new.md', 'New\n')
    expect(await adoptStrayVault(dirs, record)).toBe(1)
    expect(await fs.readFile(path.join(dirs.artifacts, 'projects/Cove/notes/a.md'), 'utf-8')).toBe('A\n')
    expect((await fs.lstat(path.join(dirs.artifacts, 'notes/top.md'))).isSymbolicLink()).toBe(false)
    expect(await fs.readFile(path.join(dirs.artifacts, 'notes/top.md'), 'utf-8')).toBe('Top\n')
    expect(await fs.readFile(path.join(dirs.artifacts, 'notes/seawall/new.md'), 'utf-8')).toBe('New\n')
  })

  it('takes in nothing when only links stand there', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-adopt-links-'))
    const dirs = { notes: path.join(home, 'notes'), artifacts: path.join(home, 'artifacts') }
    await fs.mkdir(path.join(dirs.notes, 'cove'), { recursive: true })
    await fs.writeFile(path.join(dirs.notes, 'cove/a.md'), 'A\n')
    await unifyTree(dirs, { projects: ['Cove'], nodes: [] })
    await fs.mkdir(dirs.notes, { recursive: true })
    await fs.symlink('../artifacts/projects/Cove/notes', path.join(dirs.notes, 'cove'))
    expect(await adoptStrayVault(dirs, (await readUnified(dirs))!)).toBe(0)
    expect((await fs.lstat(path.join(dirs.notes, 'cove'))).isSymbolicLink()).toBe(true)
  })
})
