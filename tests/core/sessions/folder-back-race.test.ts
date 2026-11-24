/**
 * A remake of a task's released workspace that ends while a refusal parks its lines
 * (src/core/sessions/folder-gone.ts noteFolderGone): the remake's own send ran before the
 * lines were parked and found nothing, so the recorder, finding the folder there again,
 * sends them, once. Any other folder found present only loses its mark here: the recorder does not
 * send on a refusal that check contradicts. The delivery clock does, on its growing wait (1, 2, 5,
 * 10, 30 minutes, then every hour), as for every message not confirmed delivered
 * (src/core/sessions/folder-wait.ts, tests/core/sessions/folder-wait.test.ts).
 *
 * Real: the session store, the queue and its park, folder-gone.ts, the folder check (a local
 * directory). Faked: the task store the workspace code reads (one task's workspace record).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-folder-back-race'))

import { SID, probeSetup, probeTeardown } from '../../helpers/runner-probe-harness.js'
import { updateSessionRecord } from '../../../src/core/session-tracker.js'
import { enqueueMessage, getQueue, parkMessages } from '../../../src/core/session-message-queue.js'
import { noteFolderGone } from '../../../src/core/sessions/folder-gone.js'
import { __setWorkspaceManagerDepsForTesting } from '../../../src/core/workspaces/manager.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import type { Task } from '../../../src/core/types.js'
import type { TaskWorkspace } from '../../../src/core/workspaces/types.js'

const TASK = 'gate-task'
let root: string
let sends: unknown[]

function workspace(extra: Partial<TaskWorkspace> = {}): TaskWorkspace {
  const at = new Date().toISOString()
  return {
    state: 'ready', provider: 'git-worktree', host: '__local__', root, cwd: root, anchor: '/repos/acme',
    inputs: {}, created_at: at, updated_at: at,
    remade: { from: at, root, at, ready_at: at },
    ...extra,
  } as TaskWorkspace
}

function taskWith(ws: TaskWorkspace | undefined): void {
  __setWorkspaceManagerDepsForTesting({ cloudMode: () => false, getTask: async (id: string) => (id === TASK ? ({ id: TASK, phase: 'IN_PROGRESS', workspace: ws } as unknown as Task) : null) })
}

/** A line the gone folder parked (the refusal's park), on the task's session in the workspace. */
async function parkedLine(id: string): Promise<void> {
  await updateSessionRecord(SID, { cwd: root, process_status: 'stopped' } as never)
  await enqueueMessage(SID, 'wake up', { id, sentBy: 'person' })
  const rows = await getQueue(SID)
  await parkMessages(rows, `Working directory no longer exists: ${root}`)
}

beforeEach(async () => {
  await probeSetup()
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-remade-ws-')))
  sends = []
  bus.subscribe('test-folder-back-race', (e) => { if (e.name === EventNames.SESSION_SEND) sends.push(e.data) }, { global: true, interest: [EventNames.SESSION_SEND] })
})
afterEach(async () => {
  bus.unsubscribe('test-folder-back-race')
  __setWorkspaceManagerDepsForTesting(null)
  fs.rmSync(root, { recursive: true, force: true })
  await probeTeardown()
})

describe('a refusal recorded after the remake of its folder ended', () => {
  it('sends what it parked, once', async () => {
    taskWith(workspace())
    await parkedLine('qm-race-1')
    // The folder is back (made again) before the refusal is recorded.
    expect(await noteFolderGone(SID, { cwd: root, host: null })).toBeNull()
    expect((await getQueue(SID)).map((m) => `${m.id}:${m.status}`)).toEqual(['qm-race-1:pending'])
    await vi.waitFor(() => expect(sends).toEqual([expect.objectContaining({ sessionId: SID })]))
    // The same refusal reported again (the spawn's catch and the queue's settle): one send, one row.
    await noteFolderGone(SID, { cwd: root, host: null })
    expect(sends).toHaveLength(1)
    expect((await getQueue(SID)).map((m) => m.id)).toEqual(['qm-race-1'])
  })

  it('a present folder that is no remade workspace keeps its line parked here (only the mark goes; the clock sends it later)', async () => {
    taskWith(workspace({ remade: undefined }))
    await parkedLine('qm-race-2')
    expect(await noteFolderGone(SID, { cwd: root, host: null })).toBeNull()
    expect((await getQueue(SID)).map((m) => `${m.id}:${m.status}`)).toEqual(['qm-race-2:parked'])
    expect(sends).toEqual([])
  })
})
