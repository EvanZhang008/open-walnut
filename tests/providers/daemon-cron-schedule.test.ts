import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliCronRestoreConfig, cliOneShotTime, nextCliCronMinute, parseCliCron } from '../../src/providers/daemon-cron-schedule.js'
import { DEFAULT_CRON_RESTORE_CONFIG as config } from '../../src/providers/daemon-cron-transcript.js'

const local = (year: number, month: number, day: number, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime()

afterEach(() => { vi.unstubAllEnvs() })

describe('CLI cron grammar and local-time scheduling', () => {
  it.each(['@daily', '* * * *', '* * * * * *', '0 0 * JAN *', '0 0 * * MON', '0 0 ? * *', '0 0 L * *', '1/5 * * * *', '*/0 * * * *', '60 * * * *', '0 24 * * *', '0 0 32 * *', '0 0 * 13 *', '0 0 * * 8', '3-1 * * * *', '*, * * * *'])('rejects syntax the CLI rejects: %s', (cron) => {
    expect(parseCliCron(cron)).toBeNull()
  })

  it('supports lists, ranges, steps and Sunday seven without extra scheduler syntax', () => {
    expect(parseCliCron('0,15,30-45/15 8-10 * 1,12 7')).toEqual([[0, 15, 30, 45], [8, 9, 10], Array.from({ length: 31 }, (_, i) => i + 1), [1, 12], [0]])
    expect(parseCliCron('0 0 * * 0-7')?.[4]).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(parseCliCron('0 0 * * 7-7')?.[4]).toEqual([0])
  })

  it('starts strictly after the creation minute and uses DOM/DOW OR', () => {
    expect(nextCliCronMinute('* * * * *', local(2026, 8, 1, 12, 0))).toBe(local(2026, 8, 1, 12, 1))
    expect(nextCliCronMinute('0 0 15 * 1', local(2026, 8, 1))).toBe(local(2026, 8, 3))
    expect(nextCliCronMinute('0 0 15 * *', local(2026, 8, 1))).toBe(local(2026, 8, 15))
    expect(nextCliCronMinute('0 0 * * 7', local(2026, 8, 1))).toBe(local(2026, 8, 2))
  })

  it('advances calendar fields over month and leap-year boundaries', () => {
    expect(nextCliCronMinute('0 0 1 * *', local(2026, 12, 31, 23, 59))).toBe(local(2027, 1, 1))
    expect(nextCliCronMinute('0 0 29 2 *', local(2027, 3, 1))).toBe(local(2028, 2, 29))
  })

  it('uses the host calendar across skipped and repeated daylight-saving hours', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    const spring = Date.parse('2026-03-08T01:59:00-08:00')
    expect(nextCliCronMinute('* * * * *', spring)).toBe(Date.parse('2026-03-08T03:00:00-07:00'))
    expect(nextCliCronMinute('30 2 * * *', spring)).toBe(Date.parse('2026-03-09T02:30:00-07:00'))
    const fall = Date.parse('2026-11-01T01:59:00-07:00')
    expect(nextCliCronMinute('0 2 * * *', fall)).toBe(Date.parse('2026-11-01T02:00:00-08:00'))
  })

  it('matches CLI one-shot early jitter only at configured minute multiples', () => {
    const created = local(2026, 8, 1, 12, 0)
    const next = local(2026, 8, 1, 12, 30)
    expect(cliOneShotTime('30 * * * *', created, '80000000', config)).toBe(next - 45000)
    expect(cliOneShotTime('31 * * * *', created, '80000000', config)).toBe(local(2026, 8, 1, 12, 31))
    expect(cliOneShotTime('30 * * * *', next - 10000, '80000000', config)).toBe(next - 10000)
    expect(cliOneShotTime('30 * * * *', created, 'not-hex', config)).toBe(next)
  })
})

describe('CLI cached cron configuration', () => {
  const supplied = {
    recurringFrac: 0.5, recurringCapMs: 100, oneShotMaxMs: 1000,
    oneShotFloorMs: 100, oneShotMinuteMod: 10,
  }

  it('uses defaults only when absent or when the whole schema is invalid', () => {
    expect(cliCronRestoreConfig({}, false)).toEqual(config)
    expect(cliCronRestoreConfig({ tengu_kairos_cron_config: { recurringMaxAgeMs: 0 } }, false)).toEqual(config)
    expect(cliCronRestoreConfig({ tengu_kairos_cron_config: { ...supplied, recurringFrac: 2 } }, false)).toEqual(config)
    expect(cliCronRestoreConfig({ tengu_kairos_cron_config: { ...supplied, oneShotFloorMs: 2000 } }, false)).toEqual(config)
  })

  it('honors complete overrides and the two optional schema defaults', () => {
    expect(cliCronRestoreConfig({ tengu_kairos_cron_config: supplied }, false)).toEqual({
      enabled: true, recurringMaxAgeMs: config.recurringMaxAgeMs,
      oneShotMaxMs: 1000, oneShotFloorMs: 100, oneShotMinuteMod: 10,
    })
    expect(cliCronRestoreConfig({ tengu_kairos_cron_config: { ...supplied, recurringMaxAgeMs: 0 } }, false).recurringMaxAgeMs).toBe(0)
  })

  it('honors both disable sources without changing expiry rules', () => {
    expect(cliCronRestoreConfig({ tengu_kairos_cron: false }, false)).toEqual({ ...config, enabled: false })
    expect(cliCronRestoreConfig({ tengu_kairos_cron: true }, true)).toEqual({ ...config, enabled: false })
  })
})
