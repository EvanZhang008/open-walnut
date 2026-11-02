/**
 * machineQuiet() in a container judges the container's own CPU use, never the host's load average
 * alone (tests/e2e/browser/cpu-reference.ts). On a shared 48 core host the load average counts every
 * container: at load 16 an idle 8 core container read "busy" and skipped its budgets, and an idle
 * host hid a container pinned at its quota (2026-11-02).
 */
import { describe, expect, it } from 'vitest'
import { quietVerdict, quotaCores, readCgroupCpu } from '../e2e/browser/cpu-reference'

const files = (map: Record<string, string>) => (file: string): string => map[file] ?? ''
const SEC = 1e9

describe('the quota a container may use', () => {
  it('reads cgroup v2 cpu.max and v1 cfs_quota_us, and none outside a container', () => {
    expect(quotaCores(files({ '/sys/fs/cgroup/cpu.max': '800000 100000' }), 48)).toBe(8)
    expect(quotaCores(files({ '/sys/fs/cgroup/cpu.max': 'max 100000' }), 48)).toBeNull()
    expect(quotaCores(files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '800000', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' }), 48)).toBe(8)
    expect(quotaCores(files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' }), 48)).toBeNull()
    expect(quotaCores(files({}), 14)).toBeNull()
  })
})

describe("the container's own CPU time", () => {
  it('reads cgroup v2 cpu.stat in microseconds', () => {
    expect(readCgroupCpu(files({ '/sys/fs/cgroup/cpu.stat': 'usage_usec 5000\nuser_usec 4000\nnr_throttled 2\nthrottled_usec 70' })))
      .toEqual({ usageNs: 5_000_000, throttledNs: 70_000 })
  })
  it('reads cgroup v1 cpuacct.usage and cpu.stat in nanoseconds', () => {
    expect(readCgroupCpu(files({ '/sys/fs/cgroup/cpuacct/cpuacct.usage': '98891036', '/sys/fs/cgroup/cpu/cpu.stat': 'nr_periods 3\nnr_throttled 1\nthrottled_time 1200' })))
      .toEqual({ usageNs: 98_891_036, throttledNs: 1200 })
  })
  it('has none outside a cgroup', () => {
    expect(readCgroupCpu(files({}))).toBeNull()
  })
})

describe('a core to spare', () => {
  it('outside a container: the load average against the cores', () => {
    expect(quietVerdict({ hostLoad: 3, hostCores: 14, quota: null })).toBe(true)
    expect(quietVerdict({ hostLoad: 14, hostCores: 14, quota: null })).toBe(false)
  })
  it('an idle container on a busy shared host is quiet', () => {
    expect(quietVerdict({ hostLoad: 16, hostCores: 48, quota: 8, window: { usageNs: 0.5 * SEC, throttledNs: 0, wallNs: SEC } })).toBe(true)
  })
  it('a container at its quota on an idle host is not', () => {
    expect(quietVerdict({ hostLoad: 2, hostCores: 48, quota: 8, window: { usageNs: 7.8 * SEC, throttledNs: 0, wallNs: SEC } })).toBe(false)
  })
  it('a throttled container is not, whatever its average', () => {
    expect(quietVerdict({ hostLoad: 2, hostCores: 48, quota: 8, window: { usageNs: 3 * SEC, throttledNs: 0.2 * SEC, wallNs: SEC } })).toBe(false)
  })
  it('a saturated host starves every container', () => {
    expect(quietVerdict({ hostLoad: 60, hostCores: 48, quota: 8, window: { usageNs: 0.1 * SEC, throttledNs: 0, wallNs: SEC } })).toBe(false)
  })
})
