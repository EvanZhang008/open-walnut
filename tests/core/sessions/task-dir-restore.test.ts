/**
 * A session's folder that was only Walnut's pick (task-dir-place.ts):
 *   - restoreOwnTaskDir: a task directory the 7-day sweep removed comes back at the
 *     same path before a resume, so the conversation goes on there instead of
 *     stopping as "folder gone"; any other gone folder stays gone.
 *   - isFallbackFolder: only the memory tree itself and one project's folder in it
 *     count as Walnut's old pick; a folder the user keeps deeper is the user's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('task-dir-restore'))

import { PROJECTS_MEMORY_DIR } from '../../../src/constants.js'
import { isFallbackFolder, isLocalFallbackFolder, restoreOwnTaskDir, taskDirForHost } from '../../../src/core/sessions/task-dir-place.js'

let root: string
const prevRoot = process.env.WALNUT_TASK_DIR_ROOT
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-dir-restore-'))
  process.env.WALNUT_TASK_DIR_ROOT = root
})
afterEach(() => {
  if (prevRoot === undefined) delete process.env.WALNUT_TASK_DIR_ROOT
  else process.env.WALNUT_TASK_DIR_ROOT = prevRoot
  fs.rmSync(root, { recursive: true, force: true })
})

describe('restoreOwnTaskDir', () => {
  it('remakes the task\'s own directory the sweep removed, at the same path', async () => {
    const own = (await taskDirForHost('t-swept', '__local__'))!
    expect(own.startsWith(root)).toBe(true)
    expect(fs.existsSync(own)).toBe(false)
    expect(await restoreOwnTaskDir('t-swept', own, undefined)).toBe(true)
    expect(fs.statSync(own).isDirectory()).toBe(true)
    // Present already: nothing to do.
    expect(await restoreOwnTaskDir('t-swept', own + '/', '__local__')).toBe(false)
  })

  it('never makes any other folder: another task\'s directory or a gone repository stays gone', async () => {
    const other = (await taskDirForHost('t-other', '__local__'))!
    expect(await restoreOwnTaskDir('t-mine', other, undefined)).toBe(false)
    expect(fs.existsSync(other)).toBe(false)
    const repo = path.join(root, '..', 'gone-repo-' + path.basename(root))
    expect(await restoreOwnTaskDir('t-mine', repo, undefined)).toBe(false)
    expect(fs.existsSync(repo)).toBe(false)
    expect(await restoreOwnTaskDir('', other, undefined)).toBe(false)
  })
})

describe('isFallbackFolder', () => {
  it('the memory tree and one project folder in it, never a folder the user keeps deeper', async () => {
    expect(await isFallbackFolder(PROJECTS_MEMORY_DIR, undefined)).toBe(true)
    expect(await isFallbackFolder(path.join(PROJECTS_MEMORY_DIR, 'marina'), undefined)).toBe(true)
    expect(await isFallbackFolder(path.join(PROJECTS_MEMORY_DIR, 'marina', 'repo'), undefined)).toBe(false)
    expect(isLocalFallbackFolder(path.join(PROJECTS_MEMORY_DIR, 'marina') + '/', PROJECTS_MEMORY_DIR)).toBe(true)
    expect(isLocalFallbackFolder(path.join(PROJECTS_MEMORY_DIR, 'marina', 'repo'), PROJECTS_MEMORY_DIR)).toBe(false)
    expect(await isFallbackFolder((await taskDirForHost('t-any', '__local__'))!, undefined)).toBe(true)
    expect(await isFallbackFolder('/srv/marina', undefined)).toBe(false)
  })
})

describe('the spawn pre-flight', () => {
  it('gives a task its own directory back before it checks the folder exists', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/providers/claude-code-session.ts'), 'utf8')
    const restore = src.indexOf('restoreOwnTaskDir(')
    expect(restore).toBeGreaterThan(-1)
    expect(restore).toBeLessThan(src.indexOf('await checkCwdExists('))
  })
})
