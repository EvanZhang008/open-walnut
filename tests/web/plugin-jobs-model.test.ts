/**
 * What a plugin's jobs rows say on its page (web/src/components/settings/plugin-jobs-model.ts):
 * the server's view read defensively, and the words of the "Runs on" row and each job row.
 */
import { describe, expect, it } from 'vitest'
import {
  formatLogLine, hostOptionLabel, jobHelp, jobTag, metricsLine, placementHelp, readPluginJobsState, spanWords,
  type PluginJobRow,
} from '../../web/src/components/settings/plugin-jobs-model'

const NOW = 1_800_000_000_000
const MIN = 60_000

function view(over: Record<string, unknown> = {}) {
  return {
    pluginId: 'acme-jobs',
    declared: [{ name: 'worker', kind: 'long-running' }, { name: 'poll', kind: 'every', every: '5m' }],
    runOn: 'devbox', runOnLabel: 'Dev box',
    placement: { state: 'running', message: 'running on Dev box' },
    jobs: [],
    live: true,
    elsewhere: [],
    hosts: [{ key: '__local__', label: 'This computer', connected: true, supported: true }, { key: 'devbox', label: 'Dev box', connected: true, supported: true }],
    ...over,
  }
}

function row(over: Partial<PluginJobRow> = {}): PluginJobRow {
  return { job: 'poll', kind: 'every', everyMs: 5 * MIN, version: '1.0.0', state: 'idle', restarts: 0, runs: 0, failures: 0, metrics: {}, host: 'devbox', ...over }
}

describe('readPluginJobsState', () => {
  it('reads the server view and drops what it cannot read', () => {
    const v = readPluginJobsState(view({
      declared: [{ name: 'worker', kind: 'long-running' }, { name: 'x', kind: 'cron' }, 'junk'],
      jobs: [{ job: 'worker', kind: 'long-running', state: 'running', restarts: 2, runs: 0, failures: 1, metrics: { processed: 7, bad: 'x' }, host: 'devbox', version: '1.0.0' }, { job: 'nokind' }],
      hosts: [{ key: 'devbox' }, { label: 'no key' }],
    }))!
    expect(v.declared).toEqual([{ name: 'worker', kind: 'long-running' }])
    expect(v.jobs).toHaveLength(1)
    expect(v.jobs[0]).toMatchObject({ job: 'worker', state: 'running', restarts: 2, failures: 1, metrics: { processed: 7 } })
    expect(v.hosts).toEqual([{ key: 'devbox', label: 'devbox', connected: false, supported: true }])
  })

  it('answers null for an answer that is not a jobs view (an older server, an error body)', () => {
    expect(readPluginJobsState(null)).toBeNull()
    expect(readPluginJobsState({ error: 'this plugin has no jobs' })).toBeNull()
    expect(readPluginJobsState({ pluginId: 'x' })).toBeNull()
  })
})

describe('the Runs on row', () => {
  it('says where they run, the age of a report that is not live, and any machine still reporting them', () => {
    const v = readPluginJobsState(view({
      live: false, checkedAt: NOW - 3 * MIN,
      placement: { state: 'host-offline', message: 'Dev box is not connected now; it keeps the jobs running and this is its last report' },
      elsewhere: [{ host: '__local__', jobs: 2 }],
    }))!
    expect(placementHelp(v, NOW)).toBe('Dev box is not connected now; it keeps the jobs running and this is its last report. Last report 3 min ago. This computer still reports 2 jobs; they stop when it next connects.')
  })

  it('marks a machine that cannot take jobs yet', () => {
    expect(hostOptionLabel({ key: 'a', label: 'A', connected: true, supported: true })).toBe('A')
    expect(hostOptionLabel({ key: 'a', label: 'A', connected: false, supported: true })).toBe('A (not connected)')
    expect(hostOptionLabel({ key: 'a', label: 'A', connected: true, supported: false })).toBe('A (needs a newer daemon)')
  })
})

describe('a job row', () => {
  it('tags each state', () => {
    expect(jobTag(undefined, 'running').label).toBe('Not running')
    expect(jobTag(undefined, 'plugin-off').label).toBe('Off')
    expect(jobTag(row({ state: 'running' }), 'running')).toEqual({ label: 'Running', tone: 'success' })
    expect(jobTag(row({ state: 'retrying' }), 'running')).toEqual({ label: 'Restarting', tone: 'warning' })
    expect(jobTag(row({ state: 'refused' }), 'running')).toEqual({ label: 'Refused', tone: 'error' })
    expect(jobTag(row({ lastError: 'exited with code 1' }), 'running')).toEqual({ label: 'Last run failed', tone: 'error' })
    expect(jobTag(row(), 'running')).toEqual({ label: 'Waiting', tone: 'neutral' })
  })

  it('says an every job\'s last run, its next one and its numbers', () => {
    const r = row({ runs: 12, failures: 1, lastRunAt: NOW - 2 * MIN, lastRunMs: 1_400, nextRunAt: NOW + 3 * MIN, metrics: { processed: 40, queue: 3 } })
    expect(jobHelp({ kind: 'every', every: '5m' }, r, NOW)).toBe('Every 5m. Last run 2 min ago, took 1 s. Next in 3 min. 12 runs, 1 failed. Processed 40, queue 3.')
    expect(jobHelp({ kind: 'every', every: '5m' }, row({ state: 'running', startedAt: NOW - 30_000 }), NOW)).toBe('Every 5m. Running now, started just now.')
    expect(jobHelp({ kind: 'every', every: '5m' }, row({ runs: 1, failures: 1, lastRunAt: NOW - MIN, lastRunMs: 0, lastError: 'exited with code 2', nextRunAt: NOW - 1 }), NOW))
      .toBe('Every 5m. Last run 1 min ago, took under a second. Next run soon. 1 run, 1 failed. Last error: exited with code 2.')
    expect(jobHelp({ kind: 'every', every: '1h' }, undefined, NOW)).toBe('Every 1h.')
  })

  it('says a long-running job\'s uptime, a restart on its way and why it does not start', () => {
    const lr = (over: Partial<PluginJobRow>) => row({ job: 'worker', kind: 'long-running', everyMs: undefined, ...over })
    expect(jobHelp({ kind: 'long-running' }, lr({ state: 'running', startedAt: NOW - 3 * 3_600_000, restarts: 2, failures: 1 }), NOW))
      .toBe('Runs all the time; restarted when it stops. Up since 3 h ago. Restarted 2 times, 1 after a failure.')
    expect(jobHelp({ kind: 'long-running' }, lr({ state: 'retrying', nextRunAt: NOW + 10_000, restarts: 1, failures: 1, lastError: 'exited with code 1' }), NOW))
      .toBe('Runs all the time; restarted when it stops. Starting again in 10 s. Restarted once, 1 after a failure. Last error: exited with code 1.')
    expect(jobHelp({ kind: 'long-running' }, lr({ state: 'refused', lastError: 'its code is not on this machine yet' }), NOW))
      .toBe('Runs all the time; restarted when it stops. Not started: its code is not on this machine yet.')
    // An old error under a job that runs again is not repeated.
    expect(jobHelp({ kind: 'long-running' }, lr({ state: 'running', startedAt: NOW - MIN, lastError: 'exited with code 1' }), NOW)).not.toContain('error')
  })

  it('keeps a long error and many metrics short', () => {
    const long = 'x'.repeat(400)
    expect(jobHelp({ kind: 'long-running' }, row({ job: 'worker', kind: 'long-running', state: 'refused', lastError: long }), NOW).length).toBeLessThan(260)
    expect(metricsLine({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 0.25 })).toBe('a 1, b 2, c 3, d 4, e 5, f 6 and 2 more')
    expect(metricsLine({ ratio: 0.3333 })).toBe('ratio 0.33')
    expect(metricsLine({})).toBe('')
  })
})

describe('spanWords', () => {
  it('uses the largest unit that fits', () => {
    expect(spanWords(400)).toBe('0 s')
    expect(spanWords(45_000)).toBe('45 s')
    expect(spanWords(5 * MIN)).toBe('5 min')
    expect(spanWords(2 * 3_600_000)).toBe('2 h')
    expect(spanWords(3 * 86_400_000)).toBe('3 days')
  })
})

describe('formatLogLine', () => {
  it('shows a harness line as time, level, message and data, in this browser\'s time', () => {
    const t = '2026-10-31T06:16:05.652Z'
    const d = new Date(t)
    const hh = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
    expect(formatLogLine(JSON.stringify({ t, level: 'info', msg: 'worker up', data: { queue: 'q1' } }))).toBe(`${hh} info  worker up {"queue":"q1"}`)
    expect(formatLogLine(JSON.stringify({ t, level: 'error', msg: 'run failed', data: { ms: 3, error: 'Error: boom\n    at job (x.mjs:1:1)' } })))
      .toBe(`${hh} error run failed {"ms":3}\n  Error: boom\n      at job (x.mjs:1:1)`)
    expect(formatLogLine(JSON.stringify({ t, level: 'warn', msg: 'slow' }))).toBe(`${hh} warn  slow`)
  })

  it('leaves anything else as the job printed it', () => {
    expect(formatLogLine('plain text from console.log')).toBe('plain text from console.log')
    expect(formatLogLine('{not json')).toBe('{not json')
    expect(formatLogLine('{"a":1}')).toBe('{"a":1}')
  })
})
