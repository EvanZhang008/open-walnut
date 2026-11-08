/**
 * tests/setup/cpu-idle.ts: the rule the machine gates share (Playwright's overload wait,
 * vitest's admission). The load line first (2 per core, 2026-11-08, the Operations VP: at a
 * backstop of 4 a lease booted at load 48 and the load went to 377), then memory, then idle
 * CPU as an extra condition (2026-11-07: a CPU can be busy at a low load).
 */
import { describe, expect, it } from 'vitest'
import {
  capacityVerdict, cpuIdlePct, cpuIdlePctSync, idlePctBetween, MAX_LOAD_PER_CORE, memoryTightWhy, MIN_IDLE_PCT, parseCompressorMb,
  parseSwapUsage, pctFromEnv, positiveFromEnv, readMemorySync,
} from '../setup/cpu-idle.js'

const bars = { minIdlePct: MIN_IDLE_PCT, maxLoadPerCore: MAX_LOAD_PER_CORE }

describe('capacityVerdict', () => {
  it('free CPU never replaces the load line: load 48 on 14 cores waits with 45% idle, load 28 starts', () => {
    expect(capacityVerdict({ idlePct: 45, loadPerCore: 48 / 14, cores: 14 }, bars)).toEqual({ ok: false, why: 'load 48 on 14 cores is over 2 per core' })
    expect(capacityVerdict({ idlePct: 45, loadPerCore: 2, cores: 14 }, bars)).toEqual({ ok: true, why: '45% of the CPU idle, load 28 on 14 cores' })
  })
  it('a machine with its CPU used up waits, whatever its load', () => {
    expect(capacityVerdict({ idlePct: 10, loadPerCore: 0.5, cores: 14 }, bars))
      .toEqual({ ok: false, why: 'only 10% of the CPU is idle (1.4 of 14 cores), under 20%' })
  })
  it('the load line is 2 per core, checked first', () => {
    expect(MAX_LOAD_PER_CORE).toBe(2)
    expect(capacityVerdict({ idlePct: 5, loadPerCore: 2.5, cores: 14 }, bars))
      .toEqual({ ok: false, why: 'load 35 on 14 cores is over 2 per core' })
  })
  it('tight memory waits whatever the load and idle CPU, by the load watchdog\'s rule', () => {
    const calm = { pressureLevel: 1, swapUsedMb: 0, swapTotalMb: 0, compressorMb: 2_000 }
    const at = (memory: typeof calm) => capacityVerdict({ idlePct: 90, loadPerCore: 0.5, cores: 14, memory }, bars)
    expect(at(calm).ok).toBe(true)
    expect(at({ ...calm, pressureLevel: 2 })).toEqual({ ok: false, why: 'memory is tight (pressure level 2, swap 0/0MB, compressor 2000MB)' })
    expect(at({ ...calm, compressorMb: 14_336 }).ok).toBe(false)
    expect(at({ ...calm, swapUsedMb: 900, swapTotalMb: 1_000, compressorMb: 10_240 }).ok).toBe(false)
    expect(at({ ...calm, swapUsedMb: 900, swapTotalMb: 1_000, compressorMb: 10_000 }).ok).toBe(true)
    expect(memoryTightWhy(calm)).toBeNull()
  })
  it('reads sysctl vm.swapusage and vm_stat as the shell gates do', () => {
    expect(parseSwapUsage('total = 4096.00M  used = 3404.25M  free = 691.75M  (encrypted)')).toEqual({ usedMb: 3404, totalMb: 4096 })
    expect(parseCompressorMb('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor:          420000.\n')).toBe(6562)
    const m = readMemorySync()
    if (process.platform === 'darwin') expect(m === null || Number.isInteger(m.pressureLevel)).toBe(true)
    else expect(m).toBeNull()
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
