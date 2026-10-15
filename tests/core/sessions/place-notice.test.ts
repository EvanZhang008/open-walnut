/**
 * Place notice (src/core/sessions/place-notice.ts): a session whose task moved
 * after it was told its place hears the new place on the next message into it.
 *
 * 2026-10-14: a leader moved into another project a week earlier still read
 * its old project in its prompt (every resume replays the spawn-time prompt),
 * named it in task_create, and filed its subtask outside the team.
 *
 * Two halves: the pure parts (what a prompt says, what changed, the text), and
 * sendMessageToSession against the REAL task store, session registry and queue
 * in an isolated home, with the prompt the real buildSessionContext writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-place-notice'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  placeFromPrompt, placeChanges, buildPlaceNoticeText, toldPlaceOf, promptHash,
} from '../../../src/core/sessions/place-notice.js'
import { buildSessionContext } from '../../../src/core/sessions/session-context.js'
import { addTask, updateTask, createFolder, addToGroup, getTask } from '../../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { sendMessageToSession, getQueue, resetCache } from '../../../src/core/session-message-queue.js'

describe('placeFromPrompt (reads back the lines session-context.ts writes)', () => {
  it('a project, a folder and a leader', () => {
    const prompt = 'x\nYou are working on the task "Fix "quoted" bug" (id mt-1, project "marina", folder "Rail Top").\n\n'
      + 'Your task is a subtask of "Lead (v2)" (id mt-0), your leader. ...'
    expect(placeFromPrompt(prompt, 'mt-1')).toEqual({ project: 'marina', folder: 'Rail Top', leaderId: 'mt-0' })
  })
  it('the Inbox, no folder, no leader; an older prompt without a folder clause reads as no folder', () => {
    expect(placeFromPrompt('You are working on the task "T" (id mt-1, the Inbox (no project)).\n', 'mt-1'))
      .toEqual({ project: '', folder: null, leaderId: null })
    expect(placeFromPrompt('You are working on the task "T" (id mt-1, project "acme").\n\nmore', 'mt-1'))
      .toEqual({ project: 'acme', folder: null, leaderId: null })
  })
  it('no prompt, or no line for this task, says nothing', () => {
    expect(placeFromPrompt(undefined, 'mt-1')).toBeNull()
    expect(placeFromPrompt('You are working on the task "T" (id mt-2, project "acme").\n', 'mt-1')).toBeNull()
  })
})

describe('placeChanges', () => {
  const live = { project: 'Cluster', folderId: 'g_1', folder: 'Team', leaderId: 'mt-0', leader: 'Lead' }
  it('nothing changed: no note (project compared case-insensitively)', () => {
    expect(placeChanges({ project: 'cluster', folder: 'Team', leaderId: 'mt-0' }, live)).toEqual([])
    expect(placeChanges({ project: 'Cluster', folderId: 'g_1', folder: 'Team', leaderId: 'mt-0' }, live)).toEqual([])
  })
  it('names each change', () => {
    expect(placeChanges({ project: 'old-repo', folder: null, leaderId: null }, live)).toEqual([
      'project "old-repo" became project "Cluster"', 'folder none became "Team"', 'it has a new leader',
    ])
    expect(placeChanges({ project: 'Cluster', folder: 'Team', leaderId: 'mt-0' }, { project: '' }))
      .toEqual(['project "Cluster" became the Inbox', 'it left folder "Team"', 'it no longer has a leader'])
  })
  it('a folder told by id is compared by id, so a rename alone is no move', () => {
    expect(placeChanges({ project: 'Cluster', folderId: 'g_1', folder: 'Old name', leaderId: 'mt-0' }, live)).toEqual([])
  })
  it('a record with only its start project compares the project alone', () => {
    expect(placeChanges({ project: 'Cluster' }, live)).toEqual([])
    expect(placeChanges({ project: 'old' }, live)).toEqual(['project "old" became project "Cluster"'])
  })
})

describe('buildPlaceNoticeText', () => {
  it('is a Walnut status notice naming the new place, framed as data', () => {
    const text = buildPlaceNoticeText({ id: 'mt-1', title: 'Sync <worker>' },
      { project: 'Cluster', folderId: 'g_1', folder: 'Team', leaderId: 'mt-0', leader: 'Lead' }, ['project "a" became project "Cluster"'])
    expect(text).toMatch(/^<walnut-message kind="notification"/)
    expect(text).toContain('outcome="moved"')
    expect(text).toContain('now stands in project "Cluster", folder "Team". Its leader is "Lead" (mt-0).')
    expect(text).toContain('trust this over your prompt')
    expect(text).toContain('nothing waits on an answer')
    expect(text.trimEnd()).toMatch(/<\/walnut-message>$/)
  })
})

describe('toldPlaceOf', () => {
  const prompt = 'You are working on the task "T" (id mt-1, project "acme").\n'
  it('the note last given wins while the session runs on the same prompt; a new prompt voids it', () => {
    const noted = { promptHash: promptHash(prompt), project: 'Cluster', folderId: 'g_1', folder: 'Team' }
    expect(toldPlaceOf({ appliedAppendSystemPrompt: prompt, project: 'acme', placeNoted: noted }, 'mt-1'))
      .toEqual({ project: 'Cluster', folderId: 'g_1', folder: 'Team', leaderId: null })
    // A new prompt: what it says, not the note written against the old one.
    expect(toldPlaceOf({ appliedAppendSystemPrompt: prompt + 'changed', project: 'x', placeNoted: noted }, 'mt-1'))
      .toEqual({ project: 'acme', folder: null, leaderId: null })
    // No prompt at all: the project the record started in.
    expect(toldPlaceOf({ project: 'acme', placeNoted: noted }, 'mt-1')).toEqual({ project: 'acme' })
    expect(toldPlaceOf({ appliedAppendSystemPrompt: prompt, project: 'x' }, 'mt-1')).toEqual({ project: 'acme', folder: null, leaderId: null })
  })
})

describe('sendMessageToSession carries the note (real store and queue)', () => {
  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    resetCache()
  })

  /** A session spawned on the task as it stands now, with the prompt it really gets. */
  async function spawned(project: string, opts: { walnutAgent?: boolean; parent?: string } = {}) {
    const { task } = await addTask({
      title: 'Sync worker', project,
      ...(opts.walnutAgent ? { walnut_agent: true } : {}),
      ...(opts.parent ? { parent_task_id: opts.parent } : {}),
    } as Parameters<typeof addTask>[0])
    const sid = `sid-${task.id}`
    await createSessionRecord(sid, task.id, task.project ?? '', '/repo/marina', { title: task.title })
    const { systemPrompt } = await buildSessionContext(task.id)
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: systemPrompt })
    return { task, sid, systemPrompt }
  }
  const rows = async (sid: string) => (await getQueue(sid)).map((m) => m.message)

  it('no move: the message goes as typed', async () => {
    const { sid } = await spawned('acme')
    await sendMessageToSession(sid, 'hello', { source: 'ui' })
    expect(await rows(sid)).toEqual(['hello'])
  })

  it('the incident: moved to another project and folder, the next message carries the place, once', async () => {
    const { task, sid, systemPrompt } = await spawned('old-repo')
    expect(systemPrompt).toContain('project "old-repo")')
    const folder = await createFolder('Rearchitecture', 'Cluster Insights')
    await updateTask(task.id, { project: 'Cluster Insights' })
    await addToGroup(folder.group_id, [task.id], { move: true })
    expect((await getTask(task.id)).group_id).toBe(folder.group_id)

    await sendMessageToSession(sid, 'next step please', { source: 'ui' })
    const [first] = await rows(sid)
    expect(first).toMatch(/^<walnut-message kind="notification"/)
    expect(first).toContain('now stands in project "Cluster Insights", folder "Rearchitecture".')
    expect(first).toContain('project "old-repo" became project "Cluster Insights"')
    expect(first.endsWith('\n\nnext step please')).toBe(true)
    expect((await getSessionByClaudeId(sid))?.placeNoted).toMatchObject({ project: 'Cluster Insights', folderId: folder.group_id })

    // Told: the next message, a peer's, goes as written.
    await sendMessageToSession(sid, 'peer says hi', { source: 'peer' })
    expect((await rows(sid))[1]).toBe('peer says hi')
  })

  it('a later move is told again; a fresh spawn on the new place is not', async () => {
    const { task, sid } = await spawned('acme')
    await updateTask(task.id, { project: 'marina' })
    await sendMessageToSession(sid, 'one', { source: 'ui' })
    await updateTask(task.id, { project: 'lighthouse' })
    await sendMessageToSession(sid, 'two', { source: 'ui' })
    const [one, two] = await rows(sid)
    expect(one).toContain('project "acme" became project "marina"')
    expect(two).toContain('project "marina" became project "lighthouse"')
    // A new spawn writes a new prompt naming the live place: nothing to tell.
    const { systemPrompt } = await buildSessionContext(task.id)
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: systemPrompt })
    await sendMessageToSession(sid, 'three', { source: 'ui' })
    expect((await rows(sid))[2]).toBe('three')
  })

  it('a new leader reaches an idle worker on its next message', async () => {
    const { task: lead } = await addTask({ title: 'Release lead', project: 'acme' })
    const { task, sid } = await spawned('acme')
    await updateTask(task.id, { parent_task_id: lead.id })
    await sendMessageToSession(sid, 'status?', { source: 'peer' })
    expect((await rows(sid))[0]).toContain(`Its leader is "Release lead" (${lead.id}).`)
  })

  it('a phone repeat collapsing onto the queued row adds no second note', async () => {
    const { task, sid } = await spawned('acme')
    await updateTask(task.id, { project: 'marina' })
    await sendMessageToSession(sid, 'from the phone', { source: 'api-v1', messageId: 'qm-mobile-1' })
    await sendMessageToSession(sid, 'from the phone', { source: 'api-v1', messageId: 'qm-mobile-1' })
    const queued = await rows(sid)
    expect(queued).toHaveLength(1)
    expect(queued[0].match(/<walnut-message/g)).toHaveLength(1)
  })

  it('never for a Personal AI ask, nor a session with no task', async () => {
    const { task, sid } = await spawned('Ask Walnut', { walnutAgent: true })
    await updateTask(task.id, { project: 'marina' })
    await sendMessageToSession(sid, 'plain', { source: 'ui' })
    expect(await rows(sid)).toEqual(['plain'])
    await createSessionRecord('sid-free', '', '', '/tmp')
    await sendMessageToSession('sid-free', 'free', { source: 'ui' })
    expect(await rows('sid-free')).toEqual(['free'])
  })

  it('a record with no stored prompt is judged by the project it started in', async () => {
    const { task } = await addTask({ title: 'Old session', project: 'acme' })
    await createSessionRecord('sid-old', task.id, 'acme', '/repo')
    await sendMessageToSession('sid-old', 'a', { source: 'ui' })
    await updateTask(task.id, { project: 'marina' })
    await sendMessageToSession('sid-old', 'b', { source: 'ui' })
    const [a, b] = await rows('sid-old')
    expect(a).toBe('a')
    expect(b).toContain('project "acme" became project "marina"')
  })
})
