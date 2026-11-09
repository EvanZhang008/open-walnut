/**
 * The person's own command metrics (core/health-monitor/custom-metrics.ts): which
 * config entries count, the alarm each one asks for, the number a command printed,
 * and the runner that runs each one when it is due and never twice at once.
 */
import { describe, expect, it } from 'vitest'
import { CustomMetricRunner, customAlarmDefs, firstNumber, readCustomMetrics } from '../../../src/core/health-monitor/custom-metrics.js'

describe('custom metrics', () => {
  it('keeps valid entries only: an id, a command, no repeats', () => {
    const list = readCustomMetrics([
      { id: 'deploy-wait', command: 'echo 3' },
      { id: 'deploy-wait', command: 'echo 4' },
      { id: 'bad id!', command: 'echo 1' },
      { id: 'no-command' },
      null,
      { id: 'gate', command: 'echo 1', every_min: 2 },
    ], false)
    expect(list.map((m) => m.id)).toEqual(['deploy-wait', 'gate'])
    expect(readCustomMetrics('nope', false)).toEqual([])
  })

  it('an alarm only for an entry with a threshold, held for its minutes, a fix task by default', () => {
    const defs = customAlarmDefs([
      { id: 'deploy-wait', title: 'Deploy queue wait', command: 'x', unit: 'min', alarm: { comparison: '>', threshold: 60, minutes: 15 }, owner_task: 'mw72orri-1' },
      { id: 'free-slots', command: 'y', alarm: { comparison: '<', threshold: 1 } },
      { id: 'just-a-number', command: 'z' },
    ])
    expect(defs.map((d) => d.id)).toEqual(['custom.deploy-wait', 'custom.free-slots'])
    expect(defs[0]).toMatchObject({ metric: 'custom.deploy-wait', stat: 'max', evaluationPeriods: 15, datapointsToAlarm: 15, ownerTask: 'mw72orri-1', action: { then: 'fix-task' } })
    expect(defs[1]).toMatchObject({ stat: 'min', comparison: '<', evaluationPeriods: 15, title: 'free-slots' })
  })

  it('reads the first number a command printed', () => {
    expect(firstNumber('oldest: 42.5 minutes\n')).toBe(42.5)
    expect(firstNumber('-3')).toBe(-3)
    expect(firstNumber('none')).toBeNull()
  })

  it('runs each one when due, reports its number or no data, and never overlaps a slow run', async () => {
    const gauges: Array<[string, number | null]> = []
    const runs: string[] = []
    let release: (v: string) => void = () => {}
    const runner = new CustomMetricRunner((k, v) => { gauges.push([k, v]) }, (cmd) => {
      runs.push(cmd)
      if (cmd === 'slow' && runs.filter((r) => r === 'slow').length === 1) return new Promise((r) => { release = r })
      if (cmd === 'fail') return Promise.reject(new Error('exit 1'))
      return Promise.resolve('7\n')
    })
    const list = [{ id: 'a', command: 'fast', every_min: 5 }, { id: 'b', command: 'slow', every_min: 1 }, { id: 'c', command: 'fail', every_min: 1 }]
    const t0 = Date.parse('2026-11-09T10:00:00Z')
    const first = runner.tick(list, t0)
    void runner.tick(list, t0 + 60_000) // all three still running: none again
    expect(runs).toEqual(['fast', 'slow', 'fail'])
    release('12')
    await first
    expect(gauges).toContainEqual(['custom.a', 7])
    expect(gauges).toContainEqual(['custom.b', 12])
    expect(gauges).toContainEqual(['custom.c', null])
    await runner.tick(list, t0 + 5 * 60_000)
    expect(runs.filter((r) => r === 'fast')).toHaveLength(2)
    expect(runs.filter((r) => r === 'fail')).toHaveLength(2)
  })
})
