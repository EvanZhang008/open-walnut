/**
 * WALNUT_LEADER_PERMIT_VALID_MS (src/core/leader/switch/settings.ts permitParamsFor): the live
 * tests' scaled permit clocks, honoured only when every witness is a witness dir (the one-computer
 * test layout). With a machine witness or a remote one the default clocks run: a witness this
 * machine keeps is also opened by other machines' calls with the default, and a witness elsewhere
 * refuses a scaled record.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PERMIT_PARAMS, checkTiming } from '../../../../src/core/leader/permit/index.js'
import { parseSwitchSettings, permitParamsFor } from '../../../../src/core/leader/switch/settings.js'

const env = { WALNUT_LEADER_PERMIT_VALID_MS: '6000' }
const dirs = [{ id: 'w1', dir: '/tmp/w1' }, { id: 'w2', dir: '/tmp/w2' }, { id: 'w3', dir: '/tmp/w3' }]

describe('the scaled permit clocks', () => {
  it('scale every time with the validity when every witness is a dir, and still pass the timing check', () => {
    const p = permitParamsFor(env, dirs)
    expect(p).toMatchObject({ validMs: 6_000, renewEveryMs: 1_500, holderMarginMs: 200, witnessMarginMs: 200, minSendRemainingMs: 1_500, maxDriftRate: DEFAULT_PERMIT_PARAMS.maxDriftRate })
    expect(() => checkTiming(p)).not.toThrow()
  })

  it('are the default with a machine witness, a remote one, no witnesses, or a value out of range', () => {
    expect(permitParamsFor(env, [...dirs.slice(0, 2), { id: 'w3', machine: 'm-mac' }])).toEqual(DEFAULT_PERMIT_PARAMS)
    expect(permitParamsFor(env, [...dirs.slice(0, 2), { id: 'w3', host: 'devbox' }])).toEqual(DEFAULT_PERMIT_PARAMS)
    expect(permitParamsFor(env, [{ id: 'w1', url: 'https://w.example.invalid/', key: 'k' }])).toEqual(DEFAULT_PERMIT_PARAMS)
    expect(permitParamsFor(env, [])).toEqual(DEFAULT_PERMIT_PARAMS)
    expect(permitParamsFor({ WALNUT_LEADER_PERMIT_VALID_MS: '1000' }, dirs)).toEqual(DEFAULT_PERMIT_PARAMS)
    expect(permitParamsFor({ WALNUT_LEADER_PERMIT_VALID_MS: '90000' }, dirs)).toEqual(DEFAULT_PERMIT_PARAMS)
    expect(permitParamsFor({}, dirs)).toEqual(DEFAULT_PERMIT_PARAMS)
  })

  it('a parsed leader_switch section with a machine witness runs the default whatever the environment says', () => {
    const saved = process.env.WALNUT_LEADER_PERMIT_VALID_MS
    process.env.WALNUT_LEADER_PERMIT_VALID_MS = '6000'
    try {
      const machines = [{ id: 'a', home: '/tmp/a', standby_dir: '/tmp/as', port: 4901 }, { id: 'b', home: '/tmp/b', standby_dir: '/tmp/bs', port: 4902 }]
      const local = parseSwitchSettings({ witnesses: dirs, machines })
      expect(local.settings?.params.validMs).toBe(6_000)
      const real = parseSwitchSettings({ witnesses: [{ id: 'w1', machine: 'a' }, { id: 'w2', machine: 'b' }, { id: 'w3', host: 'devbox' }], machines })
      expect(real.problem).toBeUndefined()
      expect(real.settings?.params).toEqual(DEFAULT_PERMIT_PARAMS)
    } finally {
      if (saved === undefined) delete process.env.WALNUT_LEADER_PERMIT_VALID_MS
      else process.env.WALNUT_LEADER_PERMIT_VALID_MS = saved
    }
  })
})
