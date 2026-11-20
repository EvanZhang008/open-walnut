/**
 * A Brief write waits for the status pass of the tasks it names only so long (user-status-sync.ts
 * STATUS_ANSWER_WAIT_MS). On a busy Mac (2026-11-20) that pass took 2 to 18 s, the write went past
 * its caller's 10 s gateway timeout, and a write that went through read as a failure.
 * Real task store against a temp WALNUT_HOME; only the status pass is held.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-brief-write-status-wait'))
const pass = vi.hoisted(() => ({ started: 0 }))
vi.mock('../../../src/core/user-status-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/user-status-sync.js')>()),
  // A pass that never ends: the write must not wait for it.
  syncUserStatuses: () => { pass.started += 1; return new Promise<number>(() => {}) },
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, getTask } from '../../../src/core/task-manager.js'
import { writeNodeBrief } from '../../../src/core/sessions/brief-write.js'
import { STATUS_ANSWER_WAIT_MS } from '../../../src/core/user-status-sync.js'

beforeAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })
afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {}) })

describe('writeNodeBrief and a slow status pass', () => {
  it('stores the Brief once its bound passes, with the pass still running', async () => {
    const { task: lead } = await addTask({ title: 'Orchard lead', project: 'Orchard', source: 'local', org_role: 'lead' } as never)
    const started = Date.now()
    const out = await writeNodeBrief(lead.id, { content: '### Needs you\n- None\n### Working\n- None\n### Waiting / snoozed\n- None' })
    expect(pass.started).toBe(1)
    // Its bound and the write's own work, far under the gateway's 10 s.
    expect(Date.now() - started).toBeLessThan(STATUS_ANSWER_WAIT_MS + 5_000)
    expect(out.brief.text).toContain('### Working')
    expect((await getTask(lead.id)).brief?.text).toBe(out.brief.text)
  }, 20_000)
})
