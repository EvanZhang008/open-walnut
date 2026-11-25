/**
 * The old leader takes the permission back after a switch whose trial failed, with the failed machine's witness out of
 * reach (its door closed with its server) and the two others running out of the handover at different times: the old
 * leader's own witness counts the record again from the restart of that leader's server (a reloaded witness counts it
 * from the reload, witness.ts), the remote one from when it took it (the remote rehearsal's trial-fails: 17 minutes
 * with no leader, review round 3 of B2b step 4).
 *
 * The real permit runtime (runtime.ts) over three witness dirs. The first witness to run out takes the runtime's grant
 * alone; the rule as it was then refused every later grant of that process there ('held', its own live grant), while
 * the other took a later one alone once its handover ran out: no record could stand on both until a grant came after
 * both ran out, which the runtime's rounds (shorter than a hold) never wait for. The bound asserted is
 * retakeWithinMs (runtime.ts) after the last of the handover's holds ran out; with the old rule the first possible
 * lead is a whole hold later than that (the first witness's own grant must run out first), past the bound.
 * MACHINE SAFETY: one temp root per test; witnesses in it; no server, no port, no process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { forgetLocalWitnesses, serveLocalWitness, setUpLocalWitnesses } from '../../../../src/core/leader/switch/local-witnesses.js'
import { retakeAfterRestartMs, retakeWithinMs, startPermitRuntime, type PermitRuntime } from '../../../../src/core/leader/switch/runtime.js'
import { takeBackMs } from '../../../../src/core/leader/switch/flow.js'
import { permitParamsFor } from '../../../../src/core/leader/switch/settings.js'
import { setOutwardDoorChecker } from '../../../../src/core/leader/switch/doors.js'
import { witnessHoldMs } from '../../../../src/core/leader/permit/rules.js'
import { DEFAULT_PERMIT_PARAMS, type PermitParams, type PermitRecord } from '../../../../src/core/leader/permit/types.js'
import type { LeaderSwitchSettings, LocalWitnessPlace } from '../../../../src/core/leader/switch/settings.js'

let root = ''
let settings: LeaderSwitchSettings & { witnesses: LocalWitnessPlace[] }
const runtimes: PermitRuntime[] = []
const home = (m: string) => path.join(root, m, 'home')

/** A 20 s permit (margins scaled as settings.ts permitParamsFor does), rounds a second apart, a short back-off. */
const PARAMS: PermitParams = (() => {
  const f = 20_000 / DEFAULT_PERMIT_PARAMS.validMs
  const d = DEFAULT_PERMIT_PARAMS
  return {
    ...d, validMs: 20_000, renewEveryMs: 1_000, holderMarginMs: Math.round(d.holderMarginMs * f), witnessMarginMs: Math.round(d.witnessMarginMs * f),
    minSendRemainingMs: Math.round(d.minSendRemainingMs * f), backoffBaseMs: 50, backoffMaxMs: 100,
  }
})()
/** The failed trial: from the handover to the old leader's server starting again (a little more than a round with the third witness silent). */
const TRIAL_MS = 9_000

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-retake-'))
  const witnesses = ['w1', 'w2', 'w3'].map((id) => ({ id, dir: path.join(root, 'witnesses', id) }))
  setUpLocalWitnesses(witnesses)
  settings = {
    witnesses,
    machines: ['machine-a', 'machine-b'].map((id, i) => ({ id, home: home(id), standbyDir: path.join(root, id, 'standby'), port: 4900 + i })),
    backWindowHours: 24,
    params: PARAMS,
  }
  for (const m of settings.machines) fs.mkdirSync(m.home, { recursive: true })
})

afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.stop()
  setOutwardDoorChecker(null)
  forgetLocalWitnesses()
  fs.rmSync(root, { recursive: true, force: true })
})

const start = async (id: string) => {
  const r = await startPermitRuntime({ home: home(id), holderId: id, settings, trial: false })
  runtimes.push(r)
  return r
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const heldAt = (w: LocalWitnessPlace): PermitRecord | null => {
  try { return (JSON.parse(fs.readFileSync(path.join(w.dir, 'permit-record.json'), 'utf8')) as { held: PermitRecord | null }).held } catch { return null }
}
const show = (r: PermitRecord | null) => (r ? `${r.kind} ${r.number} ${r.nonce.slice(0, 6)}` : 'none')

describe('the old leader after a failed trial, one witness out of reach and two that run out at different times', () => {
  it(`takes the permission back within retakeWithinMs (${retakeWithinMs(PARAMS)} ms here) of the last hold running out`, async () => {
    const [w1, w2, w3] = settings.witnesses as [LocalWitnessPlace, LocalWitnessPlace, LocalWitnessPlace]
    const first = await start('machine-b')
    expect(first.decision.kind).toBe('lead')
    // The switch: its handover to machine-a stands at all three; the old leader's server stops (no release: it handed over).
    const h = await first.handover('machine-a')
    expect(h.ok).toBe(true)
    await first.stop()
    // The trial on machine-a fails and its server is not running: its witness's door is closed for the rest.
    fs.renameSync(w1.dir, `${w1.dir}.off`)
    await sleep(TRIAL_MS)
    // The old leader's server starts again: its own witness (w2) is served by the new process, which counts the
    // handover from now on; the remote one (w3) keeps its time.
    forgetLocalWitnesses([w2.dir])
    const reloadedAt = Date.now()
    expect((await serveLocalWitness(w2, { type: 'read' }, PARAMS))?.held?.number).toBe(h.record!.number)
    const lastHoldEnds = reloadedAt + witnessHoldMs(PARAMS)
    const again = await start('machine-b')
    expect(again.decision.kind).toBe('waiting')
    expect(again.decision.kind === 'waiting' && again.decision.why).toMatch(/earlier handover/)

    const bound = retakeWithinMs(PARAMS)
    const seen: string[] = []
    let ledAt = NaN
    for (const end = lastHoldEnds + bound; Date.now() < end;) {
      const line = `${w2.id} ${show(heldAt(w2))} | ${w3.id} ${show(heldAt(w3))}`
      if (seen.at(-1)?.endsWith(line) !== true) seen.push(`${((Date.now() - lastHoldEnds) / 1000).toFixed(1)} s: ${line}`)
      if (again.mayAct()) { ledAt = Date.now(); break }
      await sleep(100)
    }
    const after = ledAt - lastHoldEnds
    console.log(`retake: ${Number.isFinite(after) ? `${(after / 1000).toFixed(1)} s after the last hold ran out (bound ${bound / 1000} s)` : `none within ${bound / 1000} s`}\n  ${seen.join('\n  ')}`)
    expect({ led: Number.isFinite(ledAt), witnesses: seen.at(-1) }).toMatchObject({ led: true })
    expect(after).toBeLessThanOrEqual(bound)
    expect(again.status().state === 'leading' || again.mayAct()).toBe(true)
  }, 90_000)

  it('the bounds in seconds: 42.5 s after the last hold ran out, 105.8 s after the restart; the switch waits longer than that for it', () => {
    expect(retakeWithinMs(DEFAULT_PERMIT_PARAMS)).toBe(42_500)
    expect(retakeAfterRestartMs(DEFAULT_PERMIT_PARAMS)).toBe(105_766)
    // source-job.ts start-source waits takeBackMs for the restarted old leader's doors to open: that covers the
    // retake and a server's boot (well under 15 s) before it, with the default clocks and the scaled ones of the tests.
    const witnesses = [{ id: 'w1', dir: '/x/w1' }, { id: 'w2', dir: '/x/w2' }, { id: 'w3', dir: '/x/w3' }]
    for (const params of [DEFAULT_PERMIT_PARAMS, permitParamsFor({ WALNUT_LEADER_PERMIT_VALID_MS: '15000' }, witnesses), permitParamsFor({ WALNUT_LEADER_PERMIT_VALID_MS: '6000' }, witnesses)]) {
      expect(takeBackMs({ params } as never)).toBeGreaterThanOrEqual(retakeAfterRestartMs(params) + 15_000)
    }
  })
})
