/**
 * The stored status of a completed task (phase.ts phaseDerivedFields and its raw twin in
 * prepareRawUpdate): every completing write stores Done, so the row never keeps its last open
 * words; a reopen drops that Done so the phase speaks until the status sync derives it again.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-complete-verified-store'))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask, completeTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'

const WAITING_ON_USER = { state: 'waiting', waitingOn: 'The user installs TestFlight 127' }

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})
afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

describe('a completed task stores Done', () => {
  it('through completeTask, and a reopen drops it', async () => {
    const t = (await addTask({ title: 'Phone video', project: 'Walnut' })).task
    await updateTaskRaw(t.id, { user_status: WAITING_ON_USER } as never)
    await completeTask(t.id)
    expect((await getTask(t.id)).user_status).toEqual({ state: 'done' })
    await updateTask(t.id, { phase: 'IN_PROGRESS' } as never, { source: 'api' } as never)
    const reopened = await getTask(t.id)
    expect(reopened.phase).toBe('IN_PROGRESS')
    expect(reopened.user_status?.state).not.toBe('done')
  })

  it('through a raw write (a sync pull closing it), and a raw reopen drops it', async () => {
    const t = (await addTask({ title: 'Remote closed', project: 'Walnut' })).task
    await updateTaskRaw(t.id, { user_status: WAITING_ON_USER } as never)
    await updateTaskRaw(t.id, { phase: 'COMPLETE', status: 'done' } as never)
    expect((await getTask(t.id)).user_status).toEqual({ state: 'done' })
    await updateTaskRaw(t.id, { phase: 'IN_PROGRESS' } as never, { reopenTerminal: true })
    expect((await getTask(t.id)).user_status?.state).not.toBe('done')
  })
})
