/**
 * A pull request a session opens is linked to its task (src/core/pull-requests/pr-link-hook.ts):
 * the Bash call that ran `gh pr create` is remembered, and the URL gh printed is tagged on the
 * task when the result arrives, past the link cap. Other commands, other tools and a result
 * whose tool use was never seen tag nothing. Real tasks under a temp home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-pr-link-hook'))

import { _resetForTesting, addTask, getTask } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetPrLinkHookForTesting, prLinkHook, runsGhPrCreate, createdPrUrl } from '../../../src/core/pull-requests/pr-link-hook.js'
import type { SessionHookContext } from '../../../src/core/session-hooks/types.js'

async function freshHome(): Promise<void> {
  if (!WALNUT_HOME.includes('walnut-pr-link-hook')) throw new Error(`refusing to run against ${WALNUT_HOME}`)
  closeDb()
  _resetForTesting()
  _resetPrLinkHookForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

beforeEach(freshHome)
afterEach(freshHome)

const use = (taskId: string, toolUseId: string, command: string, toolName = 'Bash') =>
  prLinkHook.handler!({ taskId, sessionId: 's1', toolName, toolUseId, input: { command } } as unknown as SessionHookContext)
const result = (taskId: string, toolUseId: string, text: string) =>
  prLinkHook.handler!({ taskId, sessionId: 's1', toolUseId, result: text } as unknown as SessionHookContext)

describe('gh pr create in a session', () => {
  it('knows the command wherever it sits in a line', () => {
    expect(runsGhPrCreate('gh pr create --fill')).toBe(true)
    expect(runsGhPrCreate('git push -u origin fix && gh pr create --title "Fix" --body x')).toBe(true)
    expect(runsGhPrCreate('cd repo; GH_PROMPT_DISABLED=1 gh  pr create -f')).toBe(true)
    expect(runsGhPrCreate('gh pr view 12')).toBe(false)
    expect(runsGhPrCreate('echo "use gh-pr-create-helper"')).toBe(false)
  })

  it('tags the pull request it printed, even on a task already holding three links', async () => {
    const { task } = await addTask({ title: 'Fix the parser', project: 'Local', source: 'local', tags: ['doc:https://a.example.com/1', 'doc:https://a.example.com/2', 'doc:https://a.example.com/3'] } as never)
    await use(task.id, 'tu-1', 'git push -u origin fix && gh pr create --fill')
    await result(task.id, 'tu-1', 'Creating pull request for fix into main in acme/app\n\nhttps://github.com/acme/app/pull/58\n')
    expect((await getTask(task.id)).tags).toContain('pr:https://github.com/acme/app/pull/58')
  })

  it('tags the one that already existed for the branch', async () => {
    const { task } = await addTask({ title: 'Fix', project: 'Local', source: 'local' } as never)
    await use(task.id, 'tu-2', 'gh pr create --fill')
    await result(task.id, 'tu-2', 'a pull request for branch "fix" into branch "main" already exists:\nhttps://github.com/acme/app/pull/57')
    expect((await getTask(task.id)).tags).toEqual(['pr:https://github.com/acme/app/pull/57'])
  })

  it('tags nothing for another command, another tool, or a result it never saw start', async () => {
    const { task } = await addTask({ title: 'Read', project: 'Local', source: 'local' } as never)
    await use(task.id, 'tu-3', 'gh pr view 12 --web')
    await result(task.id, 'tu-3', 'https://github.com/acme/app/pull/12')
    await use(task.id, 'tu-4', 'gh pr create', 'Read')
    await result(task.id, 'tu-4', 'https://github.com/acme/app/pull/13')
    await result(task.id, 'tu-5', 'https://github.com/acme/app/pull/14')
    expect((await getTask(task.id)).tags ?? []).toEqual([])
  })
})

describe('which URL gh printed for the pull request', () => {
  it('takes the last line that is only a pull request URL, nothing else the command printed', () => {
    expect(createdPrUrl('Creating pull request for csv into main in acme/app\n\nhttps://github.com/acme/app/pull/58\n')).toBe('https://github.com/acme/app/pull/58')
    expect(createdPrUrl('a pull request for branch "csv" into branch "main" already exists:\nhttps://github.com/acme/app/pull/41')).toBe('https://github.com/acme/app/pull/41')
    // `gh pr create && gh pr list`: the list's rows carry more than the URL, and an issue link is not one.
    expect(createdPrUrl('https://github.com/acme/app/pull/58\n#57  Fix login  https://github.com/acme/app/pull/57\nsee https://github.com/acme/app/issues/9')).toBe('https://github.com/acme/app/pull/58')
    expect(createdPrUrl('no pull request here: https://github.com/acme/app/pull/3 was mentioned')).toBeNull()
    expect(createdPrUrl('')).toBeNull()
  })
})
