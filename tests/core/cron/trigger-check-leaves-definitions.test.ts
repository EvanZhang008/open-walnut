/**
 * A trigger's check changes its runtime state (cron-state.json), never its definition
 * (cron-jobs.json, which git-sync commits). A good check once bumped the job's updatedAtMs, so
 * every check of every trigger rewrote the 0.9 MB definitions file: about 690 writes in 10
 * minutes on the Mac (2026-11-22), each one also a git-sync change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { applyTriggerChecked, flushRoutineChecks } from '../../../src/core/cron/trigger-apply.js'
import { cronStatePath } from '../../../src/core/cron/store.js'
import type { CronServiceState } from '../../../src/core/cron/types.js'
import type { TriggerCheckedEvent } from '../../../src/providers/trigger-check-core.js'
import { _resetJsonIoForTesting, jsonIoTop } from '../../../src/core/observability/json-io.js'

const MIN = 60_000
const now = { value: Date.UTC(2026, 10, 22, 11, 0, 0) }

function makeState(): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => now.value, log, storePath: path.join(WALNUT_HOME, 'cron-check-defs.json'), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), runExecutor: vi.fn(),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  } as unknown as CronServiceState
}

function checked(id: string, extra: Partial<TriggerCheckedEvent>): TriggerCheckedEvent {
  now.value += 5 * MIN
  return { type: 'trigger.checked', id, atMs: now.value, outcome: 'quiet', durationMs: 120, nextRunAtMs: now.value + 5 * MIN, consecutiveErrors: 0, ...extra } as TriggerCheckedEvent
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

describe('a trigger check leaves the definitions file alone', () => {
  // A failed check is recorded as a failed run (applyJobResult), which still stamps the run's end.
  it.each(['quiet'] as const)('a %s check writes the runtime state only', async (outcome) => {
    const state = makeState()
    const job = await ops.add(state, {
      name: 'New mail', enabled: true, wakeMode: 'now', schedule: { kind: 'every', everyMs: 5 * MIN },
      executor: { type: 'session', config: { target: 't-owner', prompt: 'p' } },
      check: { run: 'true', host: '__local__' },
    } as any)
    const before = await fs.readFile(state.deps.storePath, 'utf-8')
    _resetJsonIoForTesting()
    for (let i = 0; i < 5; i++) {
      const applied = await applyTriggerChecked(state, checked(job.id, { outcome }))
      expect(applied.found).toBe(true)
    }
    await flushRoutineChecks(state)
    const rows = jsonIoTop(50)
    expect(rows.find((r) => r.file === state.deps.storePath)?.writes ?? 0).toBe(0)
    expect(rows.find((r) => r.file === cronStatePath(state.deps.storePath))?.writes ?? 0).toBeGreaterThan(0)
    expect(await fs.readFile(state.deps.storePath, 'utf-8')).toBe(before)
    const [stored] = await ops.list(state, { includeDisabled: true })
    expect(stored!.state.lastCheck?.outcome).toBe(outcome)
  })
})
