/**
 * The manual leader switch with real servers (docs/reference/leader-switch.md): the rehearsal's
 * scenarios of a switch that is cancelled or rolls back (scripts/leader-switch/rehearsal.ts,
 * stop-rehearsal.ts) as assertions: a cancel by hand, a signal or a kill in the final batch, no
 * switch stop, and the trial's failures. Real servers on synthetic homes in a temp folder, three
 * local witnesses, the real `walnut leader switch` command. No :3456, no ~/.open-walnut.
 *
 * The scaled permit (tests/helpers/leader-switch-real.ts): the old leader takes its permission back
 * once the handover ran out, 6 s here for the product's 60 s. Each case asserts the outcome, which
 * either permit path reaches. One path differs from the product's: the signal case holds the final
 * batch for 30 s (WALNUT_LEADER_SWITCH_PAUSE_AFTER_FIRST_BATCH_MS) so the signal lands inside it, and
 * under the scaled lease the handover has run out by then, where the product's 60 s still holds it.
 * The case's checks are the same (no mark, the server ends within 60 s, the switch rolls back, A
 * leads again with everything); the product's timing of it is the rehearsal script's run
 * (scripts/leader-switch-rehearsal.ts, the default clocks).
 */
import { describe, it } from 'vitest'
import path from 'node:path'
import { rehearseServerKilledInFinalBatch, rehearseSignalInFinalBatch, rehearseStopWait } from '../../scripts/leader-switch/stop-rehearsal.js'
import { TRIAL_FAILURES, rehearseCancel, rehearseCancelAfterCommit, rehearseTrialFailure } from '../../scripts/leader-switch/rehearsal.js'
import { failed, portsFrom, realSwitchRoot, useScaledPermit, worldSlots } from '../helpers/leader-switch-real.js'

const root = realSwitchRoot('rollback')
const ports = portsFrom(3)
const slot = worldSlots()
/** Two worlds at a time: each scenario keeps its own budget inside its slot (worldSlots); a test's timeout also counts its wait for one. */
const FILE_BUDGET_MS = 900_000
useScaledPermit()

describe('the manual leader switch, real servers: cancels and rollbacks', () => {
  it.concurrent('a switch killed after its commit stood and then cancelled by hand goes forward: B leads', async ({ expect }) => {
    const c = await slot(300_000, () => rehearseCancelAfterCommit(path.join(root, 'cancel-after-commit'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)

  it.concurrent('a switch cut off after its handover and cancelled by hand gives A its permission back', async ({ expect }) => {
    const c = await slot(300_000, () => rehearseCancel(path.join(root, 'cancel'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)

  it.concurrent('a signal during the final batch writes no mark, ends the server within 60 s and rolls back', async ({ expect }) => {
    const c = await slot(400_000, () => rehearseSignalInFinalBatch(path.join(root, 'signal-in-final-batch'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)

  it.concurrent('the old leader\'s server killed during its final batch rolls the switch back', async ({ expect }) => {
    const c = await slot(400_000, () => rehearseServerKilledInFinalBatch(path.join(root, 'server-killed-in-final-batch'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)

  it.concurrent('with no switch stop after the handover, the old leader cancels it itself and leads on', async ({ expect }) => {
    const c = await slot(400_000, () => rehearseStopWait(path.join(root, 'stop-wait'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)

  for (const kind of TRIAL_FAILURES) {
    it.concurrent(`a trial that finds ${kind} cancels, and the old leader leads with everything`, async ({ expect }) => {
      const c = await slot(300_000, () => rehearseTrialFailure(path.join(root, `trial-${kind}`), kind, () => {}, ports()))
      expect(failed(c.all)).toEqual([])
    }, FILE_BUDGET_MS)
  }
})
