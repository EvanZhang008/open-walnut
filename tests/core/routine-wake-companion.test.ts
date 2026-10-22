/**
 * The wake counter on the cloud companion (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md): the box's engine runs only its
 * own infra jobs (cron/jobs.ts cloudModeSkipsJob), so a wake routine there is the
 * Mac's. The box must never count it into cron-jobs.json or start it; the Mac
 * counts and runs its own. An infra job the box does run keeps its counter.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-wake-companion', { CLOUD_MODE: true }))

import { bus } from '../../src/core/event-bus.js'
import { startRoutineWake, type RoutineWakeHandle } from '../../src/core/routines/wake-events.js'
import type { CronJob } from '../../src/core/cron/types.js'

const MAIL_EVENT = 'plugin:mail:messages-received'

function wakeJob(id: string, name: string): CronJob {
  return {
    id, name, enabled: true, createdAtMs: 0, updatedAtMs: 0,
    schedule: { kind: 'every', everyMs: 1_800_000, anchorMs: 0 },
    sessionTarget: 'isolated', wakeMode: 'next-cycle',
    payload: { kind: 'agentTurn', message: 'go' },
    executor: { type: 'claude-code', config: { instructions: 'go' } },
    wake: { events: [MAIL_EVENT], threshold: 1 },
    state: {},
  } as CronJob
}

let handle: RoutineWakeHandle | null = null
afterEach(() => { handle?.stop(); handle = null })

describe('routine wake on the companion', () => {
  it('arms no Mac routine: nothing is counted or run, and the bus pays nothing for it', async () => {
    const bump = vi.fn(async () => ({ count: 1, threshold: 1, due: true }))
    const runNow = vi.fn(async () => ({}))
    const listJobs = vi.fn(async () => [wakeJob('rt-acme-triage', 'Acme mail triage')])
    handle = startRoutineWake({ listJobs, bumpWake: bump, runNow, flushMs: 10, rearmMs: 1 })
    // The re-arm ran and found nothing to arm.
    await vi.waitFor(() => expect(listJobs).toHaveBeenCalled(), { timeout: 1_000 })
    await new Promise((r) => setTimeout(r, 20))
    expect(handle.stats()).toMatchObject({ watchers: 0, interest: [] })
    bus.emit(MAIL_EVENT, { count: 3 }, ['web-ui'])
    await new Promise((r) => setTimeout(r, 50))
    expect(bump).not.toHaveBeenCalled()
    expect(runNow).not.toHaveBeenCalled()
  })

  it('an infra job the box runs keeps its counter', async () => {
    const bump = vi.fn(async () => ({ count: 1, threshold: 5, due: false }))
    handle = startRoutineWake({ listJobs: async () => [wakeJob('rt-box-sync', 'Box git sync'), wakeJob('rt-acme-triage', 'Acme mail triage')], bumpWake: bump, runNow: async () => ({}), flushMs: 10, rearmMs: 1 })
    await vi.waitFor(() => expect(handle!.stats().watchers).toBe(1), { timeout: 1_000 })
    bus.emit(MAIL_EVENT, {}, ['web-ui'])
    await vi.waitFor(() => expect(bump).toHaveBeenCalledWith('rt-box-sync', 1), { timeout: 1_000 })
    expect(bump).toHaveBeenCalledTimes(1)
  })
})
