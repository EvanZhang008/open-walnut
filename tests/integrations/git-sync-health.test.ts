/**
 * The Apple Health store (~/.open-walnut/health/health.sqlite) never rides the
 * git data plane: a fresh install ignores it, an existing install gets the rule
 * appended, a store that was somehow tracked is dropped from the index but kept on
 * disk, and a note folder called health inside notes/ is still the user's own
 * notes and keeps syncing (the rule is root-anchored).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-git-sync-health'))

import { ensureCriticalIgnores, ensureMachineLocalUntracked, initSync } from '../../src/integrations/git-sync.js'
import { WALNUT_HOME } from '../../src/constants.js'

let dir: string
const lines = async (): Promise<string[]> => (await fsp.readFile(path.join(dir, '.gitignore'), 'utf-8')).split('\n')
const tracked = (): string[] => execSync('git ls-files', { cwd: dir, encoding: 'utf-8' }).split('\n')

beforeEach(async () => {
  dir = WALNUT_HOME
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('git-sync keeps the Apple Health store on this Mac', () => {
  it('a fresh install ignores /health/ (root-anchored) from the first commit', async () => {
    initSync()
    expect(await lines()).toContain('/health/')
    await fsp.mkdir(path.join(dir, 'health'), { recursive: true })
    await fsp.writeFile(path.join(dir, 'health', 'health.sqlite'), 'sqlite-bytes')
    await fsp.writeFile(path.join(dir, 'health', 'health.sqlite-wal'), 'wal-bytes')
    execSync('git add -A', { cwd: dir })
    const staged = execSync('git diff --cached --name-only', { cwd: dir, encoding: 'utf-8' })
    expect(staged).not.toContain('health/')
  })

  it('repairs an old .gitignore, untracks a tracked store, keeps it on disk, and leaves notes alone', async () => {
    initSync()
    await fsp.writeFile(path.join(dir, '.gitignore'), 'images/\n', 'utf-8')
    const store = path.join(dir, 'health', 'health.sqlite')
    const note = path.join(dir, 'notes', 'life', 'health', 'checkup.md')
    await fsp.mkdir(path.dirname(store), { recursive: true })
    await fsp.mkdir(path.dirname(note), { recursive: true })
    await fsp.writeFile(store, 'sqlite-bytes')
    await fsp.writeFile(note, '# questions for the next visit\n')
    execSync('git add -A && git commit -q -m "legacy: store tracked"', { cwd: dir })

    ensureCriticalIgnores()
    expect(await lines()).toContain('/health/')
    expect(await lines()).not.toContain('health/')
    ensureCriticalIgnores()
    expect((await lines()).filter((l) => l === '/health/')).toHaveLength(1)

    expect(ensureMachineLocalUntracked()).toEqual(['health/health.sqlite'])
    expect(tracked()).not.toContain('health/health.sqlite')
    expect(tracked()).toContain('notes/life/health/checkup.md')
    await expect(fsp.readFile(store, 'utf-8')).resolves.toBe('sqlite-bytes')

    await fsp.writeFile(path.join(dir, 'notes', 'life', 'health', 'new.md'), 'new\n')
    execSync('git add -A', { cwd: dir })
    expect(execSync('git diff --cached --name-only', { cwd: dir, encoding: 'utf-8' })).toContain('notes/life/health/new.md')
  })
})
