/**
 * A check may say nothing of what it watches is in flight now (`"idle": true`, trigger-check-core.ts
 * checkIdleOf), and the server records it on the trigger's lastCheck (trigger-apply.ts), where a
 * watch of the task's own work stops reading as that work going on (task-wait-wake.ts
 * ownWorkInFlight). 2026-11-23: a task read Working with its session idle and its Mac queue empty,
 * because the queue's result watch (watches:"own") stays armed until the task completes.
 *
 * Covered: the parse (true kept, a wrong value dropped with a warning, absent stays absent), which
 * quiet runs report it (fire:false and all-seen, never a fire or a held one), and the server side
 * (a quiet event's idle lands on lastCheck; an error, a later quiet run without it and a fire clear it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import * as ops from '../../src/core/cron/ops.js'
import { applyTriggerChecked, applyTriggerFired } from '../../src/core/cron/trigger-apply.js'
import type { CronServiceState } from '../../src/core/cron/types.js'
import {
  ackFire, applyCheckOutcome, checkIdleOf, decideCheck, emptyHostState, parseCheckStdout,
  type TriggerCheckedEvent, type TriggerDef,
} from '../../src/providers/trigger-check-core.js'

const NOW = Date.parse('2026-11-23T10:00:00Z')
const def: TriggerDef = { id: 'job-1', name: 'Mac queue results', everyMs: 60_000, check: { run: 'true' } }

function parsed(stdout: string) {
  const p = parseCheckStdout(stdout)
  if (!p.ok) throw new Error(`expected ok, got ${p.error}`)
  return p.output
}

describe('the check output may say it is idle', () => {
  it('keeps "idle": true, leaves it out when absent or false, and drops a wrong value with a warning', () => {
    expect(parsed('{"fire": false, "idle": true}').idle).toBe(true)
    expect(parsed('{"fire": false}').idle).toBeUndefined()
    expect(parsed('{"fire": false, "idle": false}').idle).toBeUndefined()
    const wrong = parsed('{"fire": false, "idle": "yes"}')
    expect(wrong.idle).toBeUndefined()
    expect(wrong.warnings?.join(' ')).toContain('"idle" must be true or false')
    // A wrong idle never fails the run: its cursor still goes through.
    expect(parsed('{"fire": false, "idle": 1, "state": {"c": 2}}').state).toEqual({ c: 2 })
  })

  it('only a quiet run with nothing new reports it: fire:false and every item already delivered', () => {
    const state = emptyHostState(NOW)
    const quiet = parsed('{"fire": false, "idle": true}')
    expect(checkIdleOf(quiet, decideCheck(def, quiet, state, NOW), state)).toBe(true)

    // A fire is news, whatever the script said.
    const news = parsed('{"fire": true, "items": [{"id": "r1"}], "idle": true}')
    const first = decideCheck(def, news, state, NOW)
    expect(first.kind).toBe('fire')
    expect(checkIdleOf(news, first, state)).toBe(false)
    const fire = applyCheckOutcome(state, news, first, NOW, 10)!
    // The same result again, its fire not acked yet: its wake is still owed, so not idle.
    const again = decideCheck(def, news, state, NOW + 60_000)
    expect(again).toMatchObject({ kind: 'quiet', reason: 'all-seen' })
    expect(state.pendingFires.length).toBe(1)
    expect(checkIdleOf(news, again, state)).toBe(false)
    expect(checkIdleOf(quiet, decideCheck(def, quiet, state, NOW + 60_000), state)).toBe(false)
    // Acked (the server took it): delivered, so nothing is in flight.
    ackFire(state, fire.seq)
    expect(state.pendingFires.length).toBe(0)
    expect(checkIdleOf(news, decideCheck(def, news, state, NOW + 120_000), state)).toBe(true)

    // A fire the budget holds back still owes the task a wake: not idle.
    const held = emptyHostState(NOW)
    held.budget = { used: 1_000, atMs: NOW }
    const late = parsed('{"fire": true, "items": [{"id": "r2"}], "idle": true}')
    const decision = decideCheck(def, late, held, NOW)
    expect(decision).toMatchObject({ kind: 'quiet', reason: 'rate-limited' })
    expect(checkIdleOf(late, decision, held)).toBe(false)

    // No idle printed: never idle.
    const plain = parsed('{"fire": false}')
    expect(checkIdleOf(plain, decideCheck(def, plain, state, NOW), state)).toBe(false)
  })
})

const MIN = 60_000
const clock = { value: Date.UTC(2026, 10, 23, 10, 0, 0) }
let counter = 0

function makeState(): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => clock.value, log, storePath: path.join(WALNUT_HOME, `cron-idle-${++counter}.json`), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), runExecutor: vi.fn(),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  } as unknown as CronServiceState
}

function checked(id: string, extra: Partial<TriggerCheckedEvent>): TriggerCheckedEvent {
  clock.value += MIN
  return { type: 'trigger.checked', id, atMs: clock.value, outcome: 'quiet', reason: 'fire-false', durationMs: 40, nextRunAtMs: clock.value + MIN, consecutiveErrors: 0, ...extra }
}

beforeEach(async () => { await fs.mkdir(WALNUT_HOME, { recursive: true }) })

describe('the server records it on the trigger\'s last check', () => {
  it('a quiet idle report lands; an error, a quiet report without it and a fire clear it', async () => {
    const state = makeState()
    const job = await ops.add(state, {
      name: 'Mac queue results of t-owner', enabled: true, wakeMode: 'now', schedule: { kind: 'every', everyMs: MIN },
      executor: { type: 'session', config: { target: 't-owner', prompt: 'p' } }, ownWork: true,
      check: { run: 'walnut-dev mac-unread t-owner', host: '__local__' },
    } as any)
    const last = async () => (await ops.list(state, { includeDisabled: true, recompute: false })).find((j) => j.id === job.id)!.state?.lastCheck

    await applyTriggerChecked(state, checked(job.id, { idle: true }))
    expect(await last()).toMatchObject({ outcome: 'quiet', idle: true })

    // An error says nothing of the work: the old reading (in flight) comes back.
    await applyTriggerChecked(state, checked(job.id, { outcome: 'error', reason: undefined, error: 'exit 1', idle: true }))
    expect((await last())?.idle).toBeUndefined()

    await applyTriggerChecked(state, checked(job.id, { idle: true }))
    expect((await last())?.idle).toBe(true)
    // An older daemon (or a check that found work in flight) sends no idle.
    await applyTriggerChecked(state, checked(job.id, {}))
    expect((await last())?.idle).toBeUndefined()

    await applyTriggerChecked(state, checked(job.id, { idle: true }))
    clock.value += MIN
    await applyTriggerFired(state, { type: 'trigger.fired', id: job.id, epoch: 'e1', seq: 1, atMs: clock.value, items: [{ id: 'r1' }], durationMs: 30, nextRunAtMs: clock.value + MIN }, async () => ({ status: 'ok' as const, summary: 'delivered' }))
    expect(await last()).toMatchObject({ outcome: 'fired' })
    expect((await last())?.idle).toBeUndefined()
  })
})
