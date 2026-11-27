/**
 * A trigger check's Walnut call refused for its arguments is never read as "nothing yet"
 * (src/core/routines/check-call-refused.ts).
 *
 * 2026-11-26 22:50Z to 11-27 07:55Z: a check called host_exec with `"timeout":15` (the key is
 * timeout_ms) every 15 minutes, dropped the refusal (`2>/dev/null`) and printed `fire: false`; it
 * never saw what it watched, and nobody heard. Pinned:
 *   - the relay that answers a check's call hands such a refusal on, for an armed trigger and for a
 *     test run alike, and nothing else (a call no check made, a call that ran);
 *   - an armed trigger's task hears it once a day per trigger and op, with the refusal's words;
 *   - trigger_test's answer names the refused call and says to fix it first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-check-call-refused'))

const told: Array<{ taskId?: string; jobId: string; reach: string; text: string }> = []
vi.mock('../../../src/core/routines/trigger-health.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/routines/trigger-health.js')>()
  return {
    ...real,
    tellTriggerTeam: async (input: { taskId?: string; jobId: string; reach: string; text: (a: { kind: 'owner' }) => string }) => {
      told.push({ taskId: input.taskId, jobId: input.jobId, reach: input.reach, text: input.text({ kind: 'owner' }) })
      return { to: 'owner', taskId: input.taskId }
    },
  }
})
const routines: Record<string, unknown> = {}
vi.mock('../../../src/core/routines/routines-core.js', () => ({
  getRoutine: async (id: string) => {
    if (!routines[id]) throw new Error(`Cron job not found: ${id}`)
    return { job: routines[id] }
  },
}))

vi.mock('../../../src/core/task-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/task-manager.js')>()
  return { ...real, getTask: async (id: string) => { if (!id.startsWith('task-')) throw new Error(`no task ${id}`); return { id, title: id } } }
})

import { _resetCheckCallRefusalsForTesting, noteCheckCallRefused, testRunRefusals } from '../../../src/core/routines/check-call-refused.js'
import { _resetTriggerCallersForTesting, noteTestRun } from '../../../src/core/hosts/trigger-caller.js'
import { _resetTriggerNoticesForTest } from '../../../src/core/routines/trigger-health.js'
import { handleGatewayCapability } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'
import { getOp } from '../../../src/ops/index.js'

const SID = '5f1c2a77-0b2e-4d43-9c55-2f6ad3e0c1ab'
const HOST = 'remote-dev'
const relay = (payload: Record<string, unknown>, host = HOST) => handleGatewayCapability('tools.call', 'external', payload, host, { throttle: new PeerThrottle(), cloudMode: false })
/** An armed trigger whose check runs on `host`, written by task-42's session. */
const armed = (id: string, extra: Record<string, unknown> = {}) => {
  routines[id] = { id, name: 'iOS touch fleet run window', enabled: true, check: { run: 'bash check.sh', host: HOST }, checkActsFor: 'task-42', executor: { type: 'session', config: { target: 'task-42' } }, ...extra }
}
/** Let the relay's hand-off (started, not awaited) run: its first run loads its modules. */
const settle = () => new Promise((r) => setTimeout(r, 300))

beforeEach(() => {
  told.length = 0
  for (const k of Object.keys(routines)) delete routines[k]
  _resetCheckCallRefusalsForTesting()
  _resetTriggerNoticesForTest()
  _resetTriggerCallersForTesting()
})
afterEach(() => vi.useRealTimers())

describe('the relay hands a check call refused for its arguments on', () => {
  it('a test run\'s call: kept for its answer; a call with no check behind it is not', async () => {
    const testId = noteTestRun('task-7', HOST, 30)!
    // The call of the 2026-11-26 check: `timeout` where host_exec takes `timeout_ms`.
    const call = { name: 'host_exec', args: { host: 'devbox', command: 'echo up', timeout: 15 }, triggerCaller: { kind: 'test', id: testId } }
    const r = await relay(call)
    expect(r.ok).toBe(false)
    await vi.waitFor(() => expect(testRunRefusals(testId)).toHaveLength(1), { timeout: 5_000 })
    expect(testRunRefusals(testId)[0]).toMatchObject({ op: 'host_exec', message: expect.stringContaining('timeout_ms') })
    // The same refusal again is kept once; the same call with no check behind it adds nothing.
    await relay(call)
    await relay({ ...call, triggerCaller: undefined })
    await settle()
    expect(testRunRefusals(testId)).toHaveLength(1)
    // A test id this server never minted, or one relayed by another host, is no test run.
    await relay({ ...call, triggerCaller: { kind: 'test', id: 'tt-forgedforged1234' } })
    await relay(call, 'other-host')
    await settle()
    expect(testRunRefusals('tt-forgedforged1234')).toEqual([])
    expect(testRunRefusals(testId)).toHaveLength(1)
    expect(told).toEqual([])
  })

  it('an armed trigger\'s call: its task hears it once a day per op, with Walnut\'s words and the fix', async () => {
    armed('mwy5baca-3989')
    const call = { name: 'host_exec', args: { host: 'devbox', command: 'test -e x', timeout: 15 }, triggerCaller: { kind: 'armed', id: 'mwy5baca-3989' } }
    await relay(call)
    await vi.waitFor(() => expect(told).toHaveLength(1), { timeout: 5_000 })
    expect(told[0]).toMatchObject({ taskId: 'task-42', jobId: 'mwy5baca-3989', reach: 'team' })
    expect(told[0].text).toContain('Your trigger "iOS touch fleet run window" (mwy5baca-3989)')
    expect(told[0].text).toContain('calls host_exec with arguments Walnut refuses')
    expect(told[0].text).toContain('timeout_ms')
    expect(told[0].text).toContain('trigger_update')
    // Every 15 minutes the same refusal: told once.
    await relay(call)
    await settle()
    expect(told).toHaveLength(1)
    // Another op of the same check is its own news.
    await relay({ name: 'host_copy', args: { from: '~/a', to: '~/b', timeout: 15 }, triggerCaller: { kind: 'armed', id: 'mwy5baca-3989' } })
    await settle()
    expect(told.map((t) => t.text.includes('calls host_copy'))).toEqual([false, true])
  })

  it('a trigger that is gone, paused, or whose check runs on another host, or a caller of another shape, tells nobody', async () => {
    armed('paused-trigger', { enabled: false })
    armed('elsewhere-trigger', { check: { run: 'bash check.sh', host: 'other-host' } })
    for (const raw of [{ kind: 'armed', id: 'no-such-trigger' }, { kind: 'armed', id: 'paused-trigger' }, { kind: 'armed', id: 'elsewhere-trigger' }, { kind: 'session', id: SID }, 'mwy5baca-3989']) {
      await noteCheckCallRefused(raw, HOST, 'host_exec', 'Invalid arguments')
    }
    expect(told).toEqual([])
  })
})

describe('trigger_test names a refused call', () => {
  const run = (body: Record<string, unknown>) => getOp('trigger_test')!.handler!({ run: 'bash check.sh' } as never, (async () => body) as never, {} as never) as Promise<{ outcome: string; next: string }>

  it('a run that parsed while one of its walnut calls never ran says so first, and what to do', async () => {
    const r = await run({
      result: { parsed: { fire: false }, wouldFire: false, newItemCount: 0, error: null },
      timeLimit: { seconds: 30, line: 'ran 0.4 s of its 30 s limit' },
      callsRefused: [{ op: 'host_exec', message: 'Invalid arguments for host_exec: (root): Unrecognized key: "timeout"' }],
    })
    expect(r.outcome).toContain('would NOT fire right now')
    expect(r.outcome).toContain('WARNING: the check\'s walnut call host_exec (Invalid arguments for host_exec')
    expect(r.outcome).toContain('never ran')
    expect(r.next).toMatch(/^Fix the refused call in the script/)
  })

  it('a run with none reads as before', async () => {
    const r = await run({ result: { parsed: { fire: false }, wouldFire: false, newItemCount: 0, error: null }, timeLimit: { seconds: 30 } })
    expect(r.outcome).not.toContain('refused')
    expect(r.next).not.toMatch(/refused call/)
  })
})
