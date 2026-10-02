/**
 * Who may write a Board (src/core/boards/board-team.ts): humans always; a
 * session only when its task is the board task or below it. And which board a
 * team shares (resolveTeamBoardTask; board files are real). The task store and
 * the caller resolver are faked at their module seams so a cyclic parent chain
 * (which the real store's writers refuse to create) can be staged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-board-team'))

const tasks = new Map<string, { id: string; parent_task_id?: string }>()
const getTaskMock = vi.fn(async (id: string) => {
  const t = tasks.get(id)
  if (!t) throw new Error(`No task found matching ID prefix "${id}"`)
  return { ...t, title: id, project: '' }
})
vi.mock('../../../src/core/task-manager.js', () => ({ getTask: (id: string) => getTaskMock(id) }))

type Placement = import('../../../src/core/sessions/caller-placement.js').CallerPlacement
const callers = new Map<string, Placement>()
vi.mock('../../../src/core/sessions/caller-placement.js', () => ({
  resolveCallerPlacement: async (sid: string | undefined) => {
    if (!sid) return { kind: 'human' }
    return callers.get(sid) ?? { kind: 'external' }
  },
}))

import { callerMayWriteBoard, isWithinTeam, resolveTeamBoardTask, TEAM_WALK_CAP } from '../../../src/core/boards/board-team.js'
import { BoardError, setBoardHtml } from '../../../src/core/boards/board-store.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const session = (id: string) => ({ id, host: '' })
const worker = (sid: string, taskId: string): Placement => ({
  kind: 'worker', task: { id: taskId, title: taskId, project: 'acme' }, session: session(sid),
})

function seed(id: string, parent?: string): void {
  tasks.set(id, { id, ...(parent ? { parent_task_id: parent } : {}) })
}

async function refused(sid: string | undefined): Promise<BoardError> {
  try {
    await callerMayWriteBoard('lead', sid)
  } catch (err) {
    expect(err).toBeInstanceOf(BoardError)
    return err as BoardError
  }
  throw new Error('expected not_in_team')
}

beforeEach(() => {
  tasks.clear()
  callers.clear()
  getTaskMock.mockClear()
  seed('lead')
  seed('child', 'lead')
  seed('grandchild', 'child')
  seed('outsider')
  seed('outsider-child', 'outsider')
  callers.set('s-lead', worker('s-lead', 'lead'))
  callers.set('s-child', worker('s-child', 'child'))
  callers.set('s-grand', worker('s-grand', 'grandchild'))
  callers.set('s-out', worker('s-out', 'outsider-child'))
  callers.set('s-ask', { kind: 'ask', task: { id: 'child', title: 'Ask', project: 'Ask Walnut' }, session: session('s-ask') })
  callers.set('s-untracked', { kind: 'untracked', session: session('s-untracked') })
})

describe('callerMayWriteBoard', () => {
  it('a human (no caller sid) is always allowed', async () => {
    expect(await callerMayWriteBoard('lead', undefined)).toEqual({ kind: 'human' })
    expect(await callerMayWriteBoard('outsider', undefined)).toEqual({ kind: 'human' })
  })

  it('the board task\'s own session is allowed and named by its task', async () => {
    expect(await callerMayWriteBoard('lead', 's-lead')).toEqual({ kind: 'task', taskId: 'lead', sessionId: 's-lead' })
  })

  it('a child and a grandchild are allowed; an ask session is judged by its task the same way', async () => {
    expect(await callerMayWriteBoard('lead', 's-child')).toMatchObject({ kind: 'task', taskId: 'child' })
    expect(await callerMayWriteBoard('lead', 's-grand')).toMatchObject({ kind: 'task', taskId: 'grandchild' })
    expect(await callerMayWriteBoard('lead', 's-ask')).toMatchObject({ kind: 'task', taskId: 'child' })
  })

  it('a leader may not write its worker\'s board (the team is the subtree below the board task)', async () => {
    await expect(callerMayWriteBoard('child', 's-lead')).rejects.toMatchObject({ code: 'not_in_team', statusCode: 403 })
  })

  it('an outsider, an untracked session and an unidentified process are 403 not_in_team', async () => {
    expect(await refused('s-out')).toMatchObject({ code: 'not_in_team', statusCode: 403, details: { callerTaskId: 'outsider-child' } })
    expect(await refused('s-untracked')).toMatchObject({ code: 'not_in_team', statusCode: 403 })
    expect(await refused('external')).toMatchObject({ code: 'not_in_team', statusCode: 403 })
  })
})

describe('isWithinTeam', () => {
  it('self, descendants yes; ancestors, strangers and unknown ids no', async () => {
    expect(await isWithinTeam('lead', 'lead')).toBe(true)
    expect(await isWithinTeam('lead', 'grandchild')).toBe(true)
    expect(await isWithinTeam('grandchild', 'lead')).toBe(false)
    expect(await isWithinTeam('lead', 'outsider-child')).toBe(false)
    expect(await isWithinTeam('lead', 'no-such-task')).toBe(false)
  })

  it('a cyclic parent chain terminates (and is not a team)', async () => {
    seed('loop-a', 'loop-b')
    seed('loop-b', 'loop-a')
    expect(await isWithinTeam('lead', 'loop-a')).toBe(false)
    expect(getTaskMock.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('a chain longer than the cap stops walking', async () => {
    let parent = 'lead'
    for (let i = 0; i < TEAM_WALK_CAP + 5; i++) {
      seed(`deep-${i}`, parent)
      parent = `deep-${i}`
    }
    getTaskMock.mockClear()
    expect(await isWithinTeam('lead', parent)).toBe(false)
    expect(getTaskMock.mock.calls.length).toBeLessThanOrEqual(TEAM_WALK_CAP + 1)
    // Within the cap it is found.
    expect(await isWithinTeam('lead', 'deep-3')).toBe(true)
  })
})

describe('resolveTeamBoardTask', () => {
  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
  })

  it('self when the task has a board; else the parent; else the grandparent', async () => {
    await setBoardHtml('lead', '<p>team</p>', { by: 'human' })
    expect(await resolveTeamBoardTask('lead')).toEqual({ taskId: 'lead', title: 'lead', self: true, hasBoard: true })
    expect(await resolveTeamBoardTask('child')).toEqual({ taskId: 'lead', title: 'lead', self: false, hasBoard: true })
    expect(await resolveTeamBoardTask('grandchild')).toEqual({ taskId: 'lead', title: 'lead', self: false, hasBoard: true })
    // The NEAREST board wins: a sub-leader with its own board keeps its team on it.
    await setBoardHtml('child', '<p>sub-team</p>', { by: 'human' })
    expect(await resolveTeamBoardTask('grandchild')).toMatchObject({ taskId: 'child', self: false })
    expect(await resolveTeamBoardTask('child')).toMatchObject({ taskId: 'child', self: true })
  })

  it('no board anywhere: the root of the tree (the task itself when it has no parent)', async () => {
    expect(await resolveTeamBoardTask('grandchild')).toEqual({ taskId: 'lead', title: 'lead', self: false, hasBoard: false })
    expect(await resolveTeamBoardTask('outsider')).toEqual({ taskId: 'outsider', title: 'outsider', self: true, hasBoard: false })
    // A parent that no longer exists ends the walk at the last task that does.
    seed('orphan', 'deleted-parent')
    expect(await resolveTeamBoardTask('orphan')).toMatchObject({ taskId: 'orphan', self: true, hasBoard: false })
  })

  it('a cycle terminates: a board on the loop is found; with none, the task itself (never an arbitrary task in the loop)', async () => {
    seed('loop-a', 'loop-b')
    seed('loop-b', 'loop-a')
    expect(await resolveTeamBoardTask('loop-a')).toMatchObject({ taskId: 'loop-a', self: true, hasBoard: false })
    expect(getTaskMock.mock.calls.length).toBeLessThanOrEqual(4)
    await setBoardHtml('loop-b', '<p/>', { by: 'human' })
    expect(await resolveTeamBoardTask('loop-a')).toMatchObject({ taskId: 'loop-b', self: false, hasBoard: true })
  })

  it('a chain deeper than the cap stops walking; an unknown task throws', async () => {
    let parent = 'lead'
    for (let i = 0; i < TEAM_WALK_CAP + 5; i++) {
      seed(`deep-${i}`, parent)
      parent = `deep-${i}`
    }
    getTaskMock.mockClear()
    expect(await resolveTeamBoardTask(parent)).toMatchObject({ taskId: parent, self: true, hasBoard: false })
    expect(getTaskMock.mock.calls.length).toBeLessThanOrEqual(TEAM_WALK_CAP + 2)
    await expect(resolveTeamBoardTask('no-such-task')).rejects.toThrow(/No task found/)
  })
})
