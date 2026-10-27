/**
 * At start, the turn-end reports a restart lost are asked for again (sessions/report-phase.ts
 * askMissedReports): a recent hand-back with no report of its turn, on a session alive between
 * turns, is announced as settled once more; nothing else is.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-missed-reports'))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { askMissedReports } from '../../src/core/sessions/report-phase.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})
afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

async function handedBack(title: string, sid: string, status: 'idle' | 'stopped') {
  const t = (await addTask({ title, project: 'Acme' })).task
  await createSessionRecord(sid, t.id, 'Acme')
  await updateSessionRecord(sid, { process_status: status })
  await updateTaskRaw(t.id, { session_id: sid } as never)
  await updateTask(t.id, { phase: 'NEED_ACTION' }, { source: 'api' })
  return getTask(t.id)
}

describe('askMissedReports', () => {
  it('asks again only for a recent hand-back with no report, on a live session', async () => {
    const lost = await handedBack('Report lost in a deploy', 'sid-lost', 'idle')
    const dead = await handedBack('Session gone', 'sid-dead', 'stopped')
    const reported = await handedBack('Already reported', 'sid-reported', 'idle')
    await updateTaskRaw(reported.id, { status_report: { state: 'done', at: new Date(Date.now() + 1000).toISOString() } } as never)

    const heard: Array<{ sessionId: string }> = []
    bus.subscribe('test-missed', (e) => { if (e.name === EventNames.SESSION_TURN_SETTLED) heard.push(e.data as { sessionId: string }) },
      { global: true, interest: [EventNames.SESSION_TURN_SETTLED] })
    try {
      expect(await askMissedReports()).toBe(1)
      expect(heard.map((h) => h.sessionId)).toEqual(['sid-lost'])
      // Hours later the turn is too old to ask about.
      expect(await askMissedReports(Date.now() + 3 * 60 * 60_000)).toBe(0)
    } finally {
      bus.unsubscribe('test-missed')
    }
    expect(lost.phase).toBe('NEED_ACTION')
    expect(dead.phase).toBe('NEED_ACTION')
  })
})
