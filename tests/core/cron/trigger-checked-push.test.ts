/**
 * A quiet trigger check's `cron:job-updated` push carries the job as stored, so a page puts it in
 * place without reading it back (2026-11-16, task 9bceb9f2: every page read GET /api/routines/:id
 * for each push, about 50 a minute from the Mac app, each a reload of the whole routine store under
 * the cron lock). An error check carries none: it changes the run history, which pages read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { applyTriggerChecked } from '../../../src/core/cron/trigger-apply.js'
import type { CronEvent, CronServiceState } from '../../../src/core/cron/types.js'

const MIN = 60_000
const now = { value: Date.UTC(2026, 10, 16, 8, 0, 0) }
let counter = 0

function makeState(events: CronEvent[]): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => now.value, log, storePath: path.join(WALNUT_HOME, `cron-push-${++counter}.json`), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), runExecutor: vi.fn(),
      // What the server's broadcast does with it: serialize on the spot.
      onEvent: (evt: CronEvent) => { events.push(JSON.parse(JSON.stringify(evt))) },
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  } as unknown as CronServiceState
}

beforeEach(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

describe('a trigger check push', () => {
  it('a quiet check carries the job as stored after it; an error check carries none', async () => {
    const events: CronEvent[] = []
    const state = makeState(events)
    const job = await ops.add(state, {
      name: 'Watch CI', enabled: true, wakeMode: 'now', schedule: { kind: 'every', everyMs: 5 * MIN },
      executor: { type: 'session', config: { target: 't-1', prompt: 'p' } },
      check: { run: 'true', host: '__local__' },
    } as any)
    events.length = 0

    now.value += 5 * MIN
    await applyTriggerChecked(state, { type: 'trigger.checked', id: job.id, atMs: now.value, outcome: 'quiet', reason: 'all-seen', durationMs: 40, nextRunAtMs: now.value + 5 * MIN, consecutiveErrors: 0 })
    const quiet = events.find((e) => e.action === 'updated')
    expect(quiet?.job?.id).toBe(job.id)
    const stored = (await ops.list(state, { includeDisabled: true, recompute: false })).find((j) => j.id === job.id)
    expect(quiet?.job).toEqual(JSON.parse(JSON.stringify(stored)))
    expect(quiet?.job?.state.lastCheck?.atMs).toBe(now.value)

    events.length = 0
    now.value += 5 * MIN
    await applyTriggerChecked(state, { type: 'trigger.checked', id: job.id, atMs: now.value, outcome: 'error', error: 'exit 1', durationMs: 40, nextRunAtMs: now.value + 5 * MIN, consecutiveErrors: 1 })
    const failed = events.find((e) => e.action === 'updated')
    expect(failed).toMatchObject({ jobId: job.id, status: 'error' })
    expect(failed?.job).toBeUndefined()
  })
})
