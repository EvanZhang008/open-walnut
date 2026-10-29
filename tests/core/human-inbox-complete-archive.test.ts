/**
 * A completed task's own "please check this" letters are archived
 * (src/core/human-inbox/complete-archive.ts): review / completion letters the
 * task sent, with the reason `task_completed`; its decisions are settled (reason `settled`,
 * decision-settle.ts); reports, mail items,
 * pinned letters and other tasks' letters stay; a reopen brings nothing back;
 * a letter someone un-archived is never archived again; a session's completion
 * keeps the letters the user has not read yet.
 *
 * Real task store, real letter store, real bus; WALNUT_HOME is an isolated tmpdir.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-inbox-complete-archive'))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask, completeTask, updateTask } from '../../src/core/task-manager.js'
import { getLetter, listLetters, sendLetter, setArchived, setPinned, setRead, agentReply } from '../../src/core/human-inbox/store.js'
import {
  archivesOnCompletion,
  completedByPerson,
  startCompleteArchive,
  stopCompleteArchive,
  sweepCompletedTasks,
} from '../../src/core/human-inbox/complete-archive.js'
import type { LetterRecord, LetterType, NewLetter } from '../../src/core/human-inbox/types.js'

function senderOf(taskId: string): NewLetter['sender'] {
  return { sessionId: `sess-${taskId}`, host: 'workstation', taskId }
}

async function letterFrom(taskId: string, type: LetterType, extra: Partial<NewLetter> = {}): Promise<string> {
  const l = await sendLetter({
    subject: `${type} from ${taskId}`,
    type,
    markdown: '# Build 127\nPlease install it and check the video plays.',
    ...(type === 'action_required' ? { actions: [{ id: 'a', label: 'Plan A' }, { id: 'b', label: 'Plan B' }] } : {}),
    ...extra,
    sender: senderOf(taskId),
  })
  return l.id
}

/** The watcher archives off the event; wait for its write to land. */
async function settled(id: string, archived: boolean): Promise<LetterRecord> {
  for (let i = 0; i < 100; i++) {
    const l = await getLetter(id)
    if (l && l.archived === archived) return l as LetterRecord
    await new Promise((r) => setTimeout(r, 20))
  }
  return (await getLetter(id)) as LetterRecord
}

/** Long enough for an archive that should NOT happen to have happened. */
const quiet = () => new Promise((r) => setTimeout(r, 300))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  startCompleteArchive()
})
afterAll(async () => {
  stopCompleteArchive()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the rule', () => {
  const base: LetterRecord = {
    id: 'lt-x-abcd', subject: 's', type: 'review', bodyFormat: 'markdown', textPreview: '', createdAt: 1000,
    sender: { sessionId: 's', host: 'h', taskId: 't1' }, read: true, pinned: false, archived: false, thread: [],
  }
  const person = { byPerson: true }
  it('takes a review or completion letter of the task, nothing else', () => {
    expect(archivesOnCompletion(base, 't1', person)).toBe(true)
    expect(archivesOnCompletion({ ...base, type: 'completion' }, 't1', person)).toBe(true)
    expect(archivesOnCompletion({ ...base, type: 'info' }, 't1', person)).toBe(false)
    expect(archivesOnCompletion({ ...base, type: 'action_required', actions: [{ id: 'a', label: 'A' }] }, 't1', person)).toBe(false)
    expect(archivesOnCompletion(base, 't2', person)).toBe(false)
    expect(archivesOnCompletion({ ...base, sender: { ...base.sender, pluginId: 'mail' } }, 't1', person)).toBe(false)
    expect(archivesOnCompletion({ ...base, items: [{} as never] }, 't1', person)).toBe(false)
    expect(archivesOnCompletion({ ...base, pinned: true }, 't1', person)).toBe(false)
    expect(archivesOnCompletion({ ...base, archivedAt: 5 }, 't1', person)).toBe(false)
  })
  it('keeps an unread letter when a session completed the task, and letters sent after the completion', () => {
    expect(archivesOnCompletion({ ...base, read: false }, 't1', person)).toBe(true)
    expect(archivesOnCompletion({ ...base, read: false }, 't1', { byPerson: false })).toBe(false)
    expect(archivesOnCompletion(base, 't1', { byPerson: false })).toBe(true)
    expect(archivesOnCompletion(base, 't1', { byPerson: false, completedAtMs: 999 })).toBe(false)
    expect(archivesOnCompletion(base, 't1', { byPerson: false, completedAtMs: 1000 })).toBe(true)
  })
  it('reads a person from the phase event', () => {
    expect(completedByPerson({ source: 'api' })).toBe(true)
    expect(completedByPerson({ source: 'sync' })).toBe(true)
    expect(completedByPerson({ source: 'api', actorSid: 'sid-1' })).toBe(false)
    expect(completedByPerson({ source: 'bulk' })).toBe(true)
    expect(completedByPerson({ source: 'session' })).toBe(false)
    expect(completedByPerson({ source: 'agent' })).toBe(false)
    // Internal closers are not the user's check: a triage run, an org handover, a plugin, anything unnamed.
    for (const source of ['triage', 'org', 'plugin', 'internal', undefined]) expect(completedByPerson({ source }), String(source)).toBe(false)
  })
  it('keeps a letter whose last turn is the user\'s reply, still waiting on the agent', () => {
    const asked = { ...base, thread: [{ from: 'agent' as const, text: 'Try 127', at: 1 }, { from: 'human' as const, text: 'It still fails', at: 2 }] }
    expect(archivesOnCompletion(asked, 't1', person)).toBe(false)
    expect(archivesOnCompletion({ ...asked, thread: [...asked.thread, { from: 'agent' as const, text: 'Fixed in 128', at: 3 }] }, 't1', person)).toBe(true)
  })
})

describe('completing a task', () => {
  it('archives its review and completion letters, with the reason, and leaves the rest', async () => {
    const t = (await addTask({ title: 'Phone video fix', project: 'Walnut' })).task
    const other = (await addTask({ title: 'Other work', project: 'Walnut' })).task
    const review = await letterFrom(t.id, 'review')
    const completion = await letterFrom(t.id, 'completion', { markdown: '# Shipped\n\u89c6\u9891\u5df2\u4e0a\u7ebf\uff0c\u8bf7\u770b\u3002' /* Chinese body: Unicode survives */ })
    const decision = await letterFrom(t.id, 'action_required')
    const report = await letterFrom(t.id, 'info')
    const pinned = await letterFrom(t.id, 'review')
    await setPinned(pinned, true)
    const otherTask = await letterFrom(other.id, 'review')

    await completeTask(t.id) // a person: no caller session

    for (const id of [review, completion]) {
      const l = await settled(id, true)
      expect(l.archived).toBe(true)
      expect(l.archivedReason).toBe('task_completed')
    }
    // Its decision letter is settled (2026-10-29): a completed task waits on no answer.
    const dec = await settled(decision, true)
    expect(dec.archivedReason).toBe('settled')
    expect(dec.settled?.reason).toMatch(/"Phone video fix" was completed/)
    await quiet()
    for (const id of [report, pinned, otherTask]) {
      const l = await getLetter(id)
      expect(l?.archived, id).toBe(false)
      expect(l?.archivedReason).toBeUndefined()
    }
    // Archived, not deleted: the archive list holds them.
    const shelf = (await listLetters({ archived: true })).letters.map((l) => l.id)
    expect(shelf).toEqual(expect.arrayContaining([review, completion]))

    // A reopen brings nothing back.
    await updateTask(t.id, { phase: 'IN_PROGRESS' } as never, { source: 'api' })
    await quiet()
    expect((await getLetter(review))?.archived).toBe(true)

    // Un-archived by the user, then completed again: it stays where the user put it, and its reason is gone.
    await setArchived(review, false)
    expect((await getLetter(review))?.archivedReason).toBeUndefined()
    await completeTask(t.id)
    await quiet()
    expect((await getLetter(review))?.archived).toBe(false)
  })

  it('by a session keeps the letters the user has not read', async () => {
    const t = (await addTask({ title: 'Worker closes itself', project: 'Walnut' })).task
    const unread = await letterFrom(t.id, 'review')
    const read = await letterFrom(t.id, 'review')
    await setRead(read, true)
    await completeTask(t.id, { actorSid: 'sid-worker' })
    expect((await settled(read, true)).archived).toBe(true)
    await quiet()
    expect((await getLetter(unread))?.archived).toBe(false)
  })

  it('by an internal closer (a triage run) keeps the letters the user has not read', async () => {
    const t = (await addTask({ title: 'Triage run', project: 'Walnut' })).task
    const unread = await letterFrom(t.id, 'review')
    await completeTask(t.id, { source: 'triage' })
    await quiet()
    expect((await getLetter(unread))?.archived).toBe(false)
  })

  it('an agent reply on an archived letter brings it back, and it is not archived again', async () => {
    const t = (await addTask({ title: 'Reply after close', project: 'Walnut' })).task
    const id = await letterFrom(t.id, 'review')
    await completeTask(t.id)
    expect((await settled(id, true)).archived).toBe(true)
    await agentReply(id, { text: 'One more thing about build 127.' })
    const back = await getLetter(id)
    expect(back?.archived).toBe(false)
    expect(back?.archivedReason).toBeUndefined()
    await updateTask(t.id, { phase: 'IN_PROGRESS' } as never, { source: 'api' })
    await completeTask(t.id)
    await quiet()
    expect((await getLetter(id))?.archived).toBe(false)
  })
})

describe('the boot pass', () => {
  it('takes read letters sent before the completion of tasks completed earlier', async () => {
    stopCompleteArchive()
    try {
      const t = (await addTask({ title: 'Closed while away', project: 'Walnut' })).task
      const read = await letterFrom(t.id, 'review')
      await setRead(read, true)
      const unread = await letterFrom(t.id, 'completion')
      await completeTask(t.id)
      await new Promise((r) => setTimeout(r, 5))
      const after = await letterFrom(t.id, 'review')
      await setRead(after, true)
      expect((await getLetter(read))?.archived).toBe(false) // nothing listening yet

      const ids = await sweepCompletedTasks()
      expect(ids).toEqual([read])
      expect((await getLetter(read))?.archivedReason).toBe('task_completed')
      expect((await getLetter(unread))?.archived).toBe(false)
      expect((await getLetter(after))?.archived).toBe(false)
      // A second pass finds nothing and writes nothing.
      expect(await sweepCompletedTasks()).toEqual([])
      // A later pass looks only at tasks completed since the last one: the letter the user read
      // meanwhile, from a task completed long before, stays where it is.
      expect(await sweepCompletedTasks(Date.now() + 60 * 60_000)).toEqual([]) // the pass an hour later
      await setRead(unread, true)
      expect(await sweepCompletedTasks(Date.now() + 2 * 60 * 60_000)).toEqual([])
      expect((await getLetter(unread))?.archived).toBe(false)
    } finally {
      // Not restarted: its own boot pass would race the teardown's removal of WALNUT_HOME.
    }
  })
})
