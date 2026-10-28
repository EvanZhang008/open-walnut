/**
 * Who writes a Board (src/core/boards/board-team.ts): every caller, recorded,
 * never refused (2026-10-27, the user: "all human action can be done by agent
 * also"), and the writer's name as the user reads it. And which board a team
 * shares (resolveTeamBoardTask; board files are real). The task store and the
 * caller resolver are faked at their module seams so a cyclic parent chain
 * (which the real store's writers refuse to create) can be staged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-board-team'))

const tasks = new Map<string, { id: string; parent_task_id?: string; title?: string; org_role?: string; org_name?: string }>()
const getTaskMock = vi.fn(async (id: string) => {
  const t = tasks.get(id)
  if (!t) throw new Error(`No task found matching ID prefix "${id}"`)
  return { title: id, ...t, project: '' }
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

import {
  boardCallerBraked, boardWriter, boardWriterName, boardWriterStamp, resolveBoardCaller, resolveTeamBoardTask, TEAM_WALK_CAP,
} from '../../../src/core/boards/board-team.js'
import { setBoardHtml } from '../../../src/core/boards/board-store.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const session = (id: string) => ({ id, host: '' })
const worker = (sid: string, taskId: string): Placement => ({
  kind: 'worker', task: { id: taskId, title: taskId, project: 'acme' }, session: session(sid),
})

function seed(id: string, parent?: string, extra: { title?: string; org_role?: string; org_name?: string } = {}): void {
  tasks.set(id, { id, ...(parent ? { parent_task_id: parent } : {}), ...extra })
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

describe('resolveBoardCaller', () => {
  it('a human (no caller sid) is the user', async () => {
    expect(await resolveBoardCaller(undefined)).toEqual({ kind: 'human' })
    expect(boardWriter({ kind: 'human' })).toBe('human')
  })

  it('a session is named by its task, wherever the board is: its own, its leader\'s, a stranger\'s', async () => {
    expect(await resolveBoardCaller('s-lead')).toEqual({ kind: 'task', taskId: 'lead', sessionId: 's-lead' })
    expect(await resolveBoardCaller('s-grand')).toMatchObject({ kind: 'task', taskId: 'grandchild' })
    // An outsider's session and an ask session: the same answer, never a refusal.
    expect(await resolveBoardCaller('s-out')).toEqual({ kind: 'task', taskId: 'outsider-child', sessionId: 's-out' })
    expect(await resolveBoardCaller('s-ask')).toMatchObject({ kind: 'task', taskId: 'child' })
    expect(boardWriter({ kind: 'task', taskId: 'outsider-child', sessionId: 's-out' })).toBe('task:outsider-child')
  })

  it('a session with no task and an unidentified process are agents Walnut cannot name; their sid is kept for delivery', async () => {
    expect(await resolveBoardCaller('s-untracked')).toEqual({ kind: 'agent', sessionId: 's-untracked', untracked: true })
    expect(await resolveBoardCaller('external')).toEqual({ kind: 'agent', sessionId: 'external' })
    expect(boardWriter({ kind: 'agent', sessionId: 'external' })).toBe('agent')
  })

  it('the session brakes follow task_create (every session): a worker, an ask and a task-less session are braked; the user and a process are not', async () => {
    expect(await resolveBoardCaller('s-ask')).toEqual({ kind: 'task', taskId: 'child', sessionId: 's-ask' })
    expect(await resolveBoardCaller('s-child')).toEqual({ kind: 'task', taskId: 'child', sessionId: 's-child' })
    expect(boardCallerBraked(await resolveBoardCaller('s-child'))).toBe(true)
    expect(boardCallerBraked(await resolveBoardCaller('s-untracked'))).toBe(true)
    expect(boardCallerBraked(await resolveBoardCaller('s-ask'))).toBe(true)
    expect(boardCallerBraked(await resolveBoardCaller(undefined))).toBe(false)
    expect(boardCallerBraked(await resolveBoardCaller('external'))).toBe(false)
  })
})

describe('boardWriterName', () => {
  it('Main is the CEO, a lead its VP name, any other task its quoted title; the user has none', async () => {
    seed('main-1', undefined, { title: 'Main', org_role: 'main' })
    seed('lead-1', undefined, { title: 'Growth lead', org_role: 'lead' })
    seed('lead-2', undefined, { title: 'Payments lead', org_role: 'lead', org_name: 'Money' })
    seed('plain-1', undefined, { title: 'Fix the cache' })
    const task = (taskId: string) => ({ kind: 'task' as const, taskId, sessionId: 's' })
    expect(await boardWriterName(task('main-1'))).toBe('the CEO')
    expect(await boardWriterName(task('lead-1'))).toBe('the Growth VP')
    expect(await boardWriterName(task('lead-2'))).toBe('the Money VP')
    expect(await boardWriterName(task('plain-1'))).toBe('the task "Fix the cache"')
    expect(await boardWriterName({ kind: 'human' })).toBeUndefined()
    expect(await boardWriterName({ kind: 'agent', sessionId: 'external' })).toBe('an agent')
    // A task that is gone still leaves a name the user can read.
    expect(await boardWriterName(task('no-such-task'))).toBe('an agent')
  })

  it('a long title is cut; the stamp carries by and the name, the user\'s none', async () => {
    seed('long-1', undefined, { title: 'x'.repeat(80) })
    const name = await boardWriterName({ kind: 'task', taskId: 'long-1', sessionId: 's' })
    expect(name).toBe(`the task "${'x'.repeat(59)}\u2026"`)
    expect(await boardWriterStamp({ kind: 'task', taskId: 'long-1', sessionId: 's' })).toEqual({ by: 'task:long-1', by_name: name })
    expect(await boardWriterStamp({ kind: 'human' })).toEqual({ by: 'human' })
    expect(await boardWriterStamp({ kind: 'agent', sessionId: 's-untracked' })).toEqual({ by: 'agent', by_name: 'an agent' })
  })

  it('a multi-line title becomes one line (every run of whitespace one space), cut at 60; a lead\'s name too', async () => {
    seed('lines-1', undefined, { title: '  Fix the cache\n\nthen\tdeploy   it  ' })
    expect(await boardWriterName({ kind: 'task', taskId: 'lines-1', sessionId: 's' })).toBe('the task "Fix the cache then deploy it"')
    seed('lines-2', undefined, { title: `Line one\n${'y'.repeat(70)}` })
    const cut = await boardWriterName({ kind: 'task', taskId: 'lines-2', sessionId: 's' })
    expect(cut).toBe(`the task "Line one ${'y'.repeat(50)}\u2026"`)
    expect(cut).not.toMatch(/[\n\t]/)
    seed('lead-3', undefined, { title: 'Ops lead', org_role: 'lead', org_name: 'Site\nReliability' })
    expect(await boardWriterName({ kind: 'task', taskId: 'lead-3', sessionId: 's' })).toBe('the Site Reliability VP')
    seed('blank-1', undefined, { title: ' \n ' })
    expect(await boardWriterName({ kind: 'task', taskId: 'blank-1', sessionId: 's' })).toBe('a task')
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
