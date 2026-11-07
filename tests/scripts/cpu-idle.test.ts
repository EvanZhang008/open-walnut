/**
 * tests/setup/cpu-idle.ts: the free-CPU rule the machine gates share (Playwright's overload
 * wait, vitest's admission). 2026-11-07: the Mac sat at load 27 to 53 on 14 cores with 30 to
 * 48% of its CPU idle, and every load-only gate stayed shut.
 */
import { describe, expect, it } from 'vitest'
import {
  capacityVerdict, cpuIdlePct, cpuIdlePctSync, idlePctBetween, MAX_LOAD_PER_CORE, MIN_IDLE_PCT, pctFromEnv, positiveFromEnv,
} from '../setup/cpu-idle.js'

const bars = { minIdlePct: MIN_IDLE_PCT, maxLoadPerCore: MAX_LOAD_PER_CORE }

describe('capacityVerdict', () => {
  it('free CPU decides: the 2026-11-07 Mac (load 53 on 14 cores, 45% idle) has room', () => {
    expect(capacityVerdict({ idlePct: 45, loadPerCore: 53 / 14, cores: 14 }, bars)).toEqual({ ok: true, why: '45% of the CPU idle, load 53 on 14 cores' })
  })
  it('a machine with its CPU used up waits, whatever its load', () => {
    expect(capacityVerdict({ idlePct: 10, loadPerCore: 0.5, cores: 14 }, bars))
      .toEqual({ ok: false, why: 'only 10% of the CPU is idle (1.4 of 14 cores), under 20%' })
  })
  it('the load is a backstop above 4 per core, checked first', () => {
    expect(capacityVerdict({ idlePct: 90, loadPerCore: 4.5, cores: 14 }, bars))
      .toEqual({ ok: false, why: 'load 63 on 14 cores is over 4 per core' })
    expect(capacityVerdict({ idlePct: 90, loadPerCore: 4, cores: 14 }, bars).ok).toBe(true)
  })
  it('an idle share that could not be read does not block', () => {
    expect(capacityVerdict({ idlePct: null, loadPerCore: 1, cores: 8 }, bars)).toEqual({ ok: true, why: '?% of the CPU idle, load 8 on 8 cores' })
  })
})

describe('idle CPU samples', () => {
  it('reads the idle share between two tick samples, none when no tick passed', () => {
    expect(idlePctBetween({ idle: 100, total: 1000 }, { idle: 400, total: 2000 })).toBe(30)
    expect(idlePctBetween({ idle: 100, total: 1000 }, { idle: 100, total: 1000 })).toBeNull()
  })
  it('measures this machine, sync and async, as a percent', async () => {
    for (const v of [cpuIdlePctSync(300), await cpuIdlePct(300)]) {
      expect(v === null || (v >= 0 && v <= 100)).toBe(true)
    }
  })
  it('the bars follow the environment, a bad value keeps the default', () => {
    expect(pctFromEnv('35', 20)).toBe(35)
    expect(pctFromEnv('0', 20)).toBe(0)
    for (const bad of [undefined, '', 'x', '150', '-1']) expect(pctFromEnv(bad, 20)).toBe(20)
    expect(positiveFromEnv('30', 0)).toBe(30)
    expect(positiveFromEnv(undefined, 0)).toBe(0)
  })
})
