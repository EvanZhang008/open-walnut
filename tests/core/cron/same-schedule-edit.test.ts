/**
 * Saving a routine with the schedule it already has (a form saves every field it
 * shows) keeps its anchor and next run: only a real schedule change starts it over
 * (2026-11-05, a review: renaming a 2-hourly routine put its next run 2 hours out).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import type { CronServiceState } from '../../../src/core/cron/types.js'

const MIN = 60_000
let now = { value: Date.UTC(2026, 10, 5, 12, 0, 0) }
let counter = 0

function makeState(): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => now.value, log, storePath: path.join(WALNUT_HOME, `cron-same-${++counter}.json`), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), runExecutor: vi.fn(), onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  } as unknown as CronServiceState
}

beforeEach(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  now = { value: Date.UTC(2026, 10, 5, 12, 0, 0) }
})

describe('an edit that keeps the schedule', () => {
  it('keeps an interval routine\'s anchor and next run; a new interval starts over', async () => {
    const state = makeState()
    const job = await ops.add(state, {
      name: 'Two hourly', enabled: true, wakeMode: 'now', schedule: { kind: 'every', everyMs: 120 * MIN },
      executor: { type: 'session', config: { target: 't', prompt: 'p' } },
    } as any)
    const next = job.state.nextRunAtMs
    now.value += 30 * MIN
    const renamed = await ops.update(state, job.id, { name: 'Renamed', schedule: { kind: 'every', everyMs: 120 * MIN } } as any)
    expect(renamed.state.nextRunAtMs).toBe(next)
    expect((renamed.schedule as any).anchorMs).toBe((job.schedule as any).anchorMs)
    const changed = await ops.update(state, job.id, { schedule: { kind: 'every', everyMs: 60 * MIN } } as any)
    expect(changed.state.nextRunAtMs).toBe(now.value + 60 * MIN)
  })

  it('compares cron and one-shot schedules by what they say', () => {
    expect(ops.sameScheduleAs({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' }, { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' })).toBe(true)
    expect(ops.sameScheduleAs({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' }, { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe(false)
    expect(ops.sameScheduleAs({ kind: 'every', everyMs: 1, anchorMs: 5 }, { kind: 'every', everyMs: 1, anchorMs: 6 })).toBe(false)
    expect(ops.sameScheduleAs({ kind: 'at', at: 'x' }, { kind: 'every', everyMs: 1 })).toBe(false)
  })
})
