/**
 * A thread the task parked itself stays parked through its status answers
 * (src/core/sessions/status-threads.ts patchForLine, threads-store.ts writeOwnThreads, lineState;
 * 2026-11-22: a task set its thread pending four times with thread_update while its land sat in the
 * queue; each status answer said "working", the thread went back to working, and the 30-minute
 * overdue clock nagged it five times).
 *
 * Through the store: the task's own pending survives a "working" line (its words written quietly,
 * still out of his sight, no overdue clock); a pending a line set moves with the next line; any
 * other state write (the task's thread_update, his Acknowledge) makes the pending the task's own again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-threads-park'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { applyThreadLines } from '../../../src/core/sessions/status-threads.js'
import { patchThread, readThreads } from '../../../src/core/org/threads-store.js'
import { updateThread } from '../../../src/core/org/threads-model.js'
import { shownToHim, threadOverdue } from '../../../src/core/org/thread-view.js'
import type { OrgThread, ThreadsFile } from '../../../src/core/org/threads-model.js'

const TASK = 'orchard-park-task'
const HOUR_AGO = new Date(Date.now() - 3600_000).toISOString()

function thread(id: string, title: string, extra: Partial<OrgThread>): OrgThread {
  return {
    id, title, state: 'working', messages: [], createdAt: HOUR_AGO, updatedAt: HOUR_AGO,
    opener: { text: `${title} started.`, at: HOUR_AGO, from: 'node', by: `task:${TASK}` }, ...extra,
  } as OrgThread
}

async function seed(threads: OrgThread[]): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  const file: ThreadsFile = { version: 1, taskId: TASK, threads }
  await fs.writeFile(path.join(dir, `${TASK}.json`), JSON.stringify(file))
}

const PARKED = 'th-a1b2c3d4'
const BUSY = 'th-a1b2c3d5'
const line = (id: string, title: string, state: 'working' | 'waiting', progress: string) => ({ threads: [{ id, title, state, progress }] })
const get = async (id: string) => (await readThreads(TASK)).threads.find((t) => t.id === id)!

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await seed([
    thread(PARKED, 'Audit fixes', { state: 'pending', reply: 'Fixes done, the land is queued.', replyAt: HOUR_AGO }),
    thread(BUSY, 'Fence posts', { state: 'working' }),
  ])
})

describe('a status answer and a thread the task parked', () => {
  it('a working line keeps it pending, writes its words quietly, and arms no overdue clock', async () => {
    for (let turn = 0; turn < 3; turn++) {
      await applyThreadLines(TASK, line(PARKED, 'Audit fixes', 'working', `Twelve fixes done, the land is queued (turn ${turn}).`))
      const t = await get(PARKED)
      expect(t.state).toBe('pending')
      expect(t.reply).toBe(`Twelve fixes done, the land is queued (turn ${turn}).`)
      expect(t.lineState).toBeUndefined()
      expect(shownToHim(t)).toBe(false)
      expect(threadOverdue(t, Date.now() + 2 * 3600_000)).toBeNull()
    }
  })

  it('a pending a line set moves with the next line; the task\'s own pending does not', async () => {
    await applyThreadLines(TASK, line(BUSY, 'Fence posts', 'waiting', 'The wire comes Friday.'))
    expect((await get(BUSY)).state).toBe('pending')
    expect((await get(BUSY)).lineState).toBeTruthy()
    await applyThreadLines(TASK, line(BUSY, 'Fence posts', 'working', 'The wire came; stringing it.'))
    expect((await get(BUSY)).state).toBe('working')
    // The task parks it itself: the mark goes, and the next working line leaves it parked.
    await patchThread(TASK, BUSY, { state: 'pending', reply: 'Waiting for the posts to set.' }, `task:${TASK}`)
    expect((await get(BUSY)).lineState).toBeUndefined()
    await applyThreadLines(TASK, line(BUSY, 'Fence posts', 'working', 'Stringing it.'))
    expect((await get(BUSY)).state).toBe('pending')
  })

  it('a second waiting line keeps the first one\'s mark, so the next working line still moves it', async () => {
    await applyThreadLines(TASK, line(BUSY, 'Fence posts', 'waiting', 'The wire comes Friday.'))
    const mark = (await get(BUSY)).lineState
    expect(mark).toBeTruthy()
    await applyThreadLines(TASK, line(BUSY, 'Fence posts', 'waiting', 'The wire comes Saturday now.'))
    expect((await get(BUSY)).lineState).toBe(mark)
    await applyThreadLines(TASK, line(BUSY, 'Fence posts', 'working', 'The wire came; stringing it.'))
    expect((await get(BUSY)).state).toBe('working')
  })

  it('his Acknowledge (a pending he sets) makes it his: no mark left', async () => {
    await applyThreadLines(TASK, line(BUSY, 'Fence posts', 'waiting', 'The wire comes Friday.'))
    const file = await readThreads(TASK)
    const acked = updateThread(file, BUSY, { state: 'pending' }, 'human', new Date().toISOString()).thread
    expect(acked.lineState).toBeUndefined()
  })

  it('a close with words on a thread out of his sight still reads answered (the mark changes no other rule)', async () => {
    const file = await readThreads(TASK)
    const closed = updateThread(file, BUSY, { close: 'dropped', reply: 'The fence is up.' }, `task:${TASK}`, new Date().toISOString(), undefined, { line: true }).thread
    expect(closed.state).toBe('answered')
    expect(closed.closed?.how).toBe('dropped')
  })
})
