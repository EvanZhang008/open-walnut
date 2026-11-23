/**
 * What a slow witness does to the 15 s renew and the 60 s validity, measured through the real
 * network transport (witness-transport.ts) in the simulated world: the leader can reach only two
 * of three witnesses, so the slower of the two sets the pace of every renew. One-way delays are
 * set per witness; the round trip is twice that. Printed as a table for docs/reference/leader-switch.md.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PERMIT_PARAMS } from '../../../../src/core/leader/permit/index.js'
import { WITNESS_REQUEST_TIMEOUT_MS } from '../../../../src/core/leader/switch/witness-transport.js'
import { CALM, SimStore, World, pilot } from './sim.js'

const W = ['w1', 'w2', 'w3']

/** A leader that reaches w2 (slow) and w3 (fast) only; samples its lease every 250 ms after two minutes. */
function run(roundTripMs: number, timeoutMs: number): { minLeftMs: number; actShare: number; sendShare: number } {
  const world = new World(DEFAULT_PERMIT_PARAMS, { ...CALM, delayMs: [5, 5] }, 4)
  world.transportTimeoutMs = timeoutMs
  // The real caps: a slow witness must not starve a renew with reads.
  world.transportMaxInFlight = undefined
  for (const id of W) world.addWitness(id, { store: new SimStore(), bootstrap: W })
  world.addMachine('A', W)
  world.partition('A', 'w1')
  world.intercept = (from, to, _msg, d) => (from === 'w2' || to === 'w2' ? d + roundTripMs / 2 : d)
  pilot(world, 'A', { wantsLead: true, tickMs: 5_000, exactTicks: true })
  let n = 0, act = 0, send = 0
  let min = Infinity
  const sample = (): void => {
    const left = world.machines.get('A')!.c.remainingMs()
    n++
    if (left > 0) act++
    if (left >= DEFAULT_PERMIT_PARAMS.minSendRemainingMs) send++
    min = Math.min(min, left)
    world.after(250, sample)
  }
  world.at(120_000, sample)
  world.run(600_000)
  expect(world.violations).toEqual([])
  return { minLeftMs: min, actShare: act / n, sendShare: send / n }
}

describe('a slow witness and the renew period', () => {
  const rows: string[] = []
  const renew = DEFAULT_PERMIT_PARAMS.renewEveryMs
  const cases = [10, 10_000, renew - 100, renew + 5_000, 30_000, 40_000]

  for (const rtt of cases) {
    it(`round trip ${rtt} ms, timeout ${WITNESS_REQUEST_TIMEOUT_MS} ms`, () => {
      const r = run(rtt, WITNESS_REQUEST_TIMEOUT_MS)
      rows.push(`rtt ${String(rtt).padStart(6)} ms: min lease left ${Math.round(r.minLeftMs)} ms, may act ${(r.actShare * 100).toFixed(0)}%, outward sends allowed ${(r.sendShare * 100).toFixed(0)}%`)
      if (rtt < renew) {
        // 58 s lease from the send, renewed every 15 s: the lease left just before the next answer is 43 s minus the round trip.
        expect(r.actShare).toBe(1)
        expect(r.sendShare).toBe(1)
        expect(r.minLeftMs).toBeGreaterThan(DEFAULT_PERMIT_PARAMS.validMs - DEFAULT_PERMIT_PARAMS.holderMarginMs - renew - rtt - 2_000)
      } else {
        // A reply counts only while its record is the open proposal, and the next renew replaces it after 15 s: no majority, no lease.
        expect(r.actShare).toBe(0)
      }
    })
  }

  it('without any timeout it is the same: a round trip over the renew period never gets a renew chosen, the open proposal is replaced first', () => {
    for (const rtt of [renew + 5_000, 40_000]) {
      const r = run(rtt, Infinity)
      rows.push(`no timeout: rtt ${rtt} ms: may act ${(r.actShare * 100).toFixed(0)}%`)
      expect(r.actShare).toBe(0)
    }
    // eslint-disable-next-line no-console
    console.log(`\nslow witness table:\n${rows.join('\n')}\n`)
  })
})
