/**
 * Directory order is the same on both runtimes. Node's readdir returns names
 * sorted; bun returns them in the file system's own order. Where the first
 * entry wins, Walnut sorts (src/lib/dir-order.ts). These cases hand the code a
 * listing in reverse order, as bun may on any file system, and expect the entry
 * Node picks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-dir-order'))

import { CLAUDE_HOME } from '../../src/constants.js'
import { sortedByName, sortedNames } from '../../src/lib/dir-order.js'
import { findLocalJsonlPath } from '../../src/core/session-file-reader.js'

afterEach(() => { vi.restoreAllMocks() })

describe('dir-order', () => {
  it('sorts names and entries by name, in place', () => {
    const names = ['b.md', 'a.md', 'C.md', 'é.md']
    expect(sortedNames(names)).toBe(names)
    expect(names).toEqual(['C.md', 'a.md', 'b.md', 'é.md'])
    const entries = [{ name: 'zeta' }, { name: 'alpha' }, { name: 'mid' }]
    expect(sortedByName(entries).map((e) => e.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('a session found in two project dirs is read from the first by name, whatever order the listing has', async () => {
    const sid = '11111111-2222-4333-8444-555555555555'
    const projects = path.join(CLAUDE_HOME, 'projects')
    for (const dir of ['-a-first', '-b-second']) {
      await fsp.mkdir(path.join(projects, dir), { recursive: true })
      await fsp.writeFile(path.join(projects, dir, `${sid}.jsonl`), '{}\n')
    }
    const real = fsp.readdir.bind(fsp) as (p: fs.PathLike) => Promise<string[]>
    vi.spyOn(fsp, 'readdir').mockImplementation((async (p: fs.PathLike) => (await real(p)).reverse()) as never)
    expect(await findLocalJsonlPath(sid)).toBe(path.join(projects, '-a-first', `${sid}.jsonl`))
  })
})
