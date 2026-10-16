/**
 * The leader's side of the sessions copy (core/replication/kinds/sessions.ts
 * SESSIONS_KIND) over the Mac's real session store: rows come out projected
 * (no pid, no output file, no prompt text), a row's hash is worked out once per
 * stored object, and every committed store write wakes the copy's scheduler.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-sessions-leader', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting, isFollower } from '../../../../src/core/server-role.js'
import * as sessionDb from '../../../../src/core/session-db.js'
import * as tracker from '../../../../src/core/session-tracker.js'
import { SESSIONS_KIND } from '../../../../src/core/replication/kinds/sessions.js'

beforeAll(async () => {
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterAll(async () => {
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the leader rows of the sessions copy', () => {
  it('are the store rows projected, hashed once per stored object, and a write wakes the scheduler', async () => {
    expect(isFollower()).toBe(false)
    let woke = 0
    const stop = SESSIONS_KIND.watch(() => { woke++ })
    await new Promise((r) => setTimeout(r, 20)) // the watch attaches after its import
    await tracker.createSessionRecord('sid-marina-lead-1', 'task-marina', 'Marina', '/home/acme/marina', {
      pid: 4242, outputFile: '/tmp/streams/sid-marina-lead-1.jsonl', title: 'Lead', appliedAppendSystemPrompt: 'a long prompt', host: 'devbox',
    })
    await tracker.createSessionRecord('sid-marina-lead-2', 'task-marina', 'Marina', undefined, { pid: 4243, title: 'Worker' })
    expect(woke).toBeGreaterThanOrEqual(2)
    const rows = await SESSIONS_KIND.rows()
    expect(rows.map((r) => r.claudeSessionId).sort()).toEqual(['sid-marina-lead-1', 'sid-marina-lead-2'])
    for (const r of rows) {
      expect(r).not.toHaveProperty('pid')
      expect(r).not.toHaveProperty('outputFile')
      expect(r).not.toHaveProperty('appliedAppendSystemPrompt')
    }
    expect(rows.find((r) => r.claudeSessionId === 'sid-marina-lead-1')).toMatchObject({ title: 'Lead', host: 'devbox', taskId: 'task-marina' })
    // An unchanged row is the same projected object (and hash) the next round.
    const again = await SESSIONS_KIND.rows()
    const one = (xs: typeof rows) => xs.find((r) => r.claudeSessionId === 'sid-marina-lead-2')!
    expect(one(again)).toBe(one(rows))
    await tracker.updateSessionRecord('sid-marina-lead-2', { title: 'Worker, renamed' })
    const after = await SESSIONS_KIND.rows()
    expect(one(after)).not.toBe(one(rows))
    expect(SESSIONS_KIND.hash(one(after))).not.toBe(SESSIONS_KIND.hash(one(rows)))
    stop()
  })
})
