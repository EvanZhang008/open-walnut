/**
 * The server's side of a check the machine failed (trigger-apply.ts applyTriggerChecked): a
 * `trigger.checked` error that carries `fault` is shown on the card and in the audit trail, and
 * nothing else: no count toward the five that stop a trigger, no "Trigger check failed" to the
 * owner's session, no "keeps failing" after 3 checks or 30 minutes, no stop. Past 6 hours the
 * owner hears it once for the outage, still with no count and no stop. A script's error still does
 * all of that, before, between and after the machine's.
 *
 * 2026-11-16 11:36Z: a full Mac disk failed nine triggers' checks at once, and each woke its
 * task's session. The loop over MACHINE_FAULT_KINDS makes a new kind meet the same rule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { MACHINE_FAULT_QUIET_MAX_MS, applyTriggerChecked, type TriggerCheckedApplied } from '../../../src/core/cron/trigger-apply.js'
import type { CronServiceState } from '../../../src/core/cron/types.js'
import { MACHINE_FAULT_KINDS, MAX_CONSECUTIVE_CHECK_ERRORS, type TriggerCheckedEvent } from '../../../src/providers/trigger-check-core.js'

const MIN = 60_000
const now = { value: Date.UTC(2026, 10, 16, 11, 0, 0) }
let counter = 0

function makeState(): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => now.value, log, storePath: path.join(WALNUT_HOME, `cron-fault-${++counter}.json`), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), runExecutor: vi.fn(),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  } as unknown as CronServiceState
}

async function addTrigger(state: CronServiceState) {
  return await ops.add(state, {
    name: 'DoorDash reschedule mail', enabled: true, wakeMode: 'now', schedule: { kind: 'every', everyMs: 5 * MIN },
    executor: { type: 'session', config: { target: 't-owner', prompt: 'p' } },
    check: { run: `walnut trigger-check mail:new-mail '{"from":"doordash"}'`, host: '__local__' },
  } as any)
}

function checked(id: string, extra: Partial<TriggerCheckedEvent>): TriggerCheckedEvent {
  now.value += 5 * MIN
  return { type: 'trigger.checked', id, atMs: now.value, outcome: 'error', durationMs: 208, nextRunAtMs: now.value + 5 * MIN, consecutiveErrors: 0, ...extra }
}

/** Every notice reportTriggerHealth sends, read off what the apply returned (trigger-health.ts). */
function told(a: TriggerCheckedApplied): string[] {
  return [
    ...(a.disabled ? ['disabled'] : []), ...(a.tellSessionError ? ['failed'] : []), ...(a.tellFailing ? ['failing'] : []),
    ...(a.warningsToTell?.length ? ['repaired'] : []), ...(a.budgetHeld ? ['budget'] : []), ...(a.tellMachineFault ? ['machine'] : []),
  ]
}

const DISK_ERROR = 'exit 1: walnut trigger-check mail:new-mail: Walnut API error (507): Data disk is critically full (99% used)'

beforeEach(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

describe('a check the machine failed', () => {
  it.each(MACHINE_FAULT_KINDS)('%s: shown, never counted, told or stopped, however long it lasts', async (fault) => {
    const state = makeState()
    const job = await addTrigger(state)
    // Longer than both "keeps failing" thresholds (3 checks, 30 minutes) and the stop at five.
    for (let i = 0; i < MAX_CONSECUTIVE_CHECK_ERRORS * 3; i++) {
      const a = await applyTriggerChecked(state, checked(job.id, { error: DISK_ERROR, fault }))
      expect(a.found).toBe(true)
      expect(told(a), `check ${i + 1}`).toEqual([])
      expect(a.consecutiveErrors).toBe(0)
      expect(a.fault).toBe(fault)
    }
    const stored = (await ops.list(state, { includeDisabled: true, recompute: false })).find((j) => j.id === job.id)!
    expect(stored.enabled).toBe(true)
    expect(stored.state.consecutiveErrors ?? 0).toBe(0)
    expect(stored.state.nextRunAtMs).toBe(now.value + 5 * MIN)
    expect(stored.state.lastCheck).toMatchObject({ outcome: 'error', fault })
    expect(stored.state.lastCheck?.error).toContain('507')
    expect(stored.state.lastError).toContain('507')
    expect(stored.state.checkLog?.[0]).toMatchObject({ outcome: 'error', fault })
  })

  it('past its quiet window it is told once for the outage, and still never counts or stops', async () => {
    const state = makeState()
    const job = await addTrigger(state)
    const first = await applyTriggerChecked(state, checked(job.id, { error: DISK_ERROR, fault: 'disk_full' }))
    expect(told(first)).toEqual([])
    const since = now.value
    now.value += MACHINE_FAULT_QUIET_MAX_MS
    const late = await applyTriggerChecked(state, checked(job.id, { error: DISK_ERROR, fault: 'disk_full' }))
    expect(told(late)).toEqual(['machine'])
    expect(late.tellMachineFault).toEqual({ sinceMs: since })
    expect(late.consecutiveErrors).toBe(0)
    // The rest of the outage: told no more, and the trigger is never stopped.
    for (let i = 0; i < MAX_CONSECUTIVE_CHECK_ERRORS * 2; i++) {
      const a = await applyTriggerChecked(state, checked(job.id, { error: DISK_ERROR, fault: 'disk_full' }))
      expect(told(a)).toEqual([])
    }
    expect((await ops.list(state, { includeDisabled: true, recompute: false })).find((j) => j.id === job.id)!.enabled).toBe(true)
    // A check that works ends the outage: the next one starts quiet, and is told again past its own window.
    await applyTriggerChecked(state, checked(job.id, { outcome: 'quiet', reason: 'fire-false' }))
    expect(told(await applyTriggerChecked(state, checked(job.id, { error: DISK_ERROR, fault: 'disk_full' })))).toEqual([])
    now.value += MACHINE_FAULT_QUIET_MAX_MS
    expect(told(await applyTriggerChecked(state, checked(job.id, { error: DISK_ERROR, fault: 'disk_full' })))).toEqual(['machine'])
  })

  it('a replayed status neither starts nor ends a run of faults', async () => {
    const state = makeState()
    const job = await addTrigger(state)
    await applyTriggerChecked(state, checked(job.id, { error: DISK_ERROR, fault: 'disk_full' }))
    const since = (await ops.list(state, { includeDisabled: true, recompute: false })).find((j) => j.id === job.id)!.state.machineFaultSinceMs
    expect(since).toBe(now.value)
    await applyTriggerChecked(state, checked(job.id, { outcome: 'quiet', reason: 'fire-false', replay: true }))
    expect((await ops.list(state, { includeDisabled: true, recompute: false })).find((j) => j.id === job.id)!.state.machineFaultSinceMs).toBe(since)
  })

  it('an unknown fault from a newer daemon is a plain error, counted as before', async () => {
    const state = makeState()
    const job = await addTrigger(state)
    const a = await applyTriggerChecked(state, checked(job.id, { error: 'exit 1', fault: 'cosmic_ray' as never }))
    expect(a.consecutiveErrors).toBe(1)
    expect(a.fault).toBeUndefined()
    expect(told(a)).toEqual(['failed'])
  })
})

describe('a script error is told and counted as before', () => {
  it('the first tells the owner, the third tells again, the fifth stops it; machine faults between change nothing', async () => {
    const state = makeState()
    const job = await addTrigger(state)
    const script = () => applyTriggerChecked(state, checked(job.id, { error: 'exit 1: jq: parse error' }))
    const machine = () => applyTriggerChecked(state, checked(job.id, { error: DISK_ERROR, fault: 'disk_full' }))

    expect(told(await script())).toEqual(['failed'])
    expect(told(await machine())).toEqual([])
    const second = await script()
    expect(second.consecutiveErrors).toBe(2)
    expect(told(await machine())).toEqual([])
    const third = await script()
    expect(third.consecutiveErrors).toBe(3)
    expect(told(third)).toEqual(['failing'])
    expect(told(await script())).toEqual([])
    const fifth = await script()
    expect(fifth.consecutiveErrors).toBe(MAX_CONSECUTIVE_CHECK_ERRORS)
    expect(told(fifth)).toEqual(['disabled'])
  })

  it('a good check after machine faults clears nothing it should not, and a later script error starts a new run', async () => {
    const state = makeState()
    const job = await addTrigger(state)
    await applyTriggerChecked(state, checked(job.id, { error: DISK_ERROR, fault: 'disk_full' }))
    const quiet = await applyTriggerChecked(state, checked(job.id, { outcome: 'quiet', reason: 'fire-false' }))
    expect(told(quiet)).toEqual([])
    expect(quiet.recovered).toBeUndefined()
    const after = await applyTriggerChecked(state, checked(job.id, { error: 'exit 2' }))
    expect(after.consecutiveErrors).toBe(1)
  })
})
