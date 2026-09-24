import fs from 'node:fs/promises'
import { renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CRON_PROMPT_LIMIT, createCronMetadataTracker, readCronMetadataStream, type CronMetadataProcess } from '../../src/providers/daemon-cron-metadata.js'
import { cliOneShotTime, nextCliCronMinute } from '../../src/providers/daemon-cron-schedule.js'
import { DEFAULT_CRON_RESTORE_CONFIG } from '../../src/providers/daemon-cron-transcript.js'
import { SESSION_CRON_PROMPT_LIMIT, type SessionCronMetadata } from '../../src/core/types.js'

const process: CronMetadataProcess = { identity: 'process-1', alive: true, version: '2.1.258' }
const at = Date.UTC(2026, 8, 11, 12)
const config = { enabled: true, recurringMaxAgeMs: 604800000 }
const call = (name: string, input: Record<string, unknown> = {}, id = 'call', timestamp?: number) => JSON.stringify({
  type: 'assistant',
  ...(timestamp === undefined ? {} : { timestamp: new Date(timestamp).toISOString() }),
  message: { content: [{ type: 'tool_use', id, name, input }] },
})
const result = (value: unknown, id = 'call', error = false, timestamp?: number) => JSON.stringify({
  type: 'user', tool_use_result: value,
  ...(timestamp === undefined ? {} : { timestamp: new Date(timestamp).toISOString() }),
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] },
})
function fixture(options: { nextRun?: boolean; oneShot?: boolean } = {}) {
  let now = at
  const values: SessionCronMetadata[] = []
  const tracker = createCronMetadataTracker({
    epoch: 'daemon-1', clock: () => now, changed: (value) => values.push(value),
    ...(options.nextRun ? { nextRun: nextCliCronMinute } : {}),
    ...(options.oneShot ? { oneShotTime: (cron, createdAt, id) => cliOneShotTime(cron, createdAt, id, DEFAULT_CRON_RESTORE_CONFIG) } : {}),
  })
  tracker.configure('session', process, config)
  tracker.state('session', process, false, true)
  return { tracker, values, advance: (ms: number) => { now += ms }, value: () => tracker.list().find((v) => v.sessionId === 'session')! }
}
function create(f: ReturnType<typeof fixture>, id = 'job') {
  f.tracker.observe('session', process, call('CronCreate', { cron: '* * * * *', prompt: 'Example' }))
  f.tracker.observe('session', process, result({ id, humanSchedule: 'Every minute', recurring: true, durable: false }))
}

describe('read-only cron metadata', () => {
  it('requires a confirmed create and reports the job only once it is confirmed', () => {
    const f = fixture()
    expect(f.value()).toMatchObject({ presence: 'inactive', jobs: [] })
    f.tracker.observe('session', process, call('CronCreate', { cron: '* * * * *', prompt: 'Pending text' }))
    expect(f.value().presence).toBe('inactive')
    expect(JSON.stringify(f.values)).not.toContain('Pending text')
    f.tracker.observe('session', process, result({ id: 'job', humanSchedule: 'Every minute', recurring: true, durable: false }))
    expect(f.value()).toMatchObject({ presence: 'active', known: true, source: 'cron', validUntil: at + config.recurringMaxAgeMs })
    expect(f.value().jobs).toEqual([{
      id: 'job', cron: '* * * * *', schedule: 'Every minute', prompt: 'Pending text', promptTruncated: false,
      recurring: true, durable: false, createdAt: at, nextRunAt: null, expiresAt: at + config.recurringMaxAgeMs,
    }])
  })

  it('bounds the prompt at the shared limit and flags the cut', () => {
    expect(CRON_PROMPT_LIMIT).toBe(SESSION_CRON_PROMPT_LIMIT)
    const f = fixture()
    const prompt = 'x'.repeat(SESSION_CRON_PROMPT_LIMIT + 1)
    f.tracker.observe('session', process, call('CronCreate', { cron: '* * * * *', prompt }))
    f.tracker.observe('session', process, result({ id: 'job', recurring: true, durable: false }))
    expect(f.value().jobs?.[0]).toMatchObject({ prompt: 'x'.repeat(SESSION_CRON_PROMPT_LIMIT), promptTruncated: true })
  })

  it('computes the next run by the CLI rule, orders jobs by it, and republishes once it passes', () => {
    const f = fixture({ nextRun: true })
    f.tracker.observe('session', process, call('CronCreate', { cron: '0 0 * * *', prompt: 'Nightly' }, 'nightly'))
    f.tracker.observe('session', process, result({ id: 'nightly', humanSchedule: 'Every day at midnight', recurring: true, durable: false }, 'nightly'))
    f.tracker.observe('session', process, call('CronCreate', { cron: '*/5 * * * *', prompt: 'Often' }, 'often'))
    f.tracker.observe('session', process, result({ id: 'often', humanSchedule: 'Every 5 minutes', recurring: true, durable: false }, 'often'))
    const before = f.value()
    expect(before.jobs?.map((job) => job.id)).toEqual(['often', 'nightly'])
    expect(before.jobs?.[0].nextRunAt).toBe(nextCliCronMinute('*/5 * * * *', at))
    expect(before.jobs?.[1].nextRunAt).toBe(nextCliCronMinute('0 0 * * *', at))
    const published = f.values.length
    f.advance(60_000)
    f.tracker.refresh()
    expect(f.values).toHaveLength(published)
    f.advance(5 * 60_000)
    f.tracker.refresh()
    expect(f.values).toHaveLength(published + 1)
    expect(f.value().jobs?.[0].nextRunAt).toBe(nextCliCronMinute('*/5 * * * *', at + 6 * 60_000))
    expect(f.value().jobs?.[1].nextRunAt).toBe(before.jobs?.[1].nextRunAt)
  })

  it('lists only the jobs still alive and drops a deleted job from the details', () => {
    const f = fixture()
    create(f, 'one'); create(f, 'two')
    expect(f.value().jobs?.map((job) => job.id)).toEqual(['one', 'two'])
    f.tracker.observe('session', process, call('CronDelete', { id: 'one' }))
    f.tracker.observe('session', process, result({}))
    expect(f.value().jobs?.map((job) => job.id)).toEqual(['two'])
    f.advance(config.recurringMaxAgeMs)
    expect(f.value()).toMatchObject({ presence: 'unknown', jobs: [] })
  })

  it('lets a list refresh the details of a confirmed job without inventing its creation time', () => {
    const f = fixture()
    f.tracker.observe('session', process, call('CronCreate', { cron: '23 9 * * *' }))
    f.tracker.observe('session', process, result({ id: 'job', recurring: true, durable: false }))
    expect(f.value().jobs?.[0]).toMatchObject({ schedule: null, prompt: null, createdAt: at })
    f.tracker.observe('session', process, call('CronList'))
    f.tracker.observe('session', process, result({ jobs: [{ id: 'job', cron: '23 9 * * *', humanSchedule: 'Every day at 9:23 AM', prompt: 'Daily disk inspection', recurring: true, durable: false }] }))
    expect(f.value()).toMatchObject({ presence: 'active' })
    expect(f.value().jobs?.[0]).toMatchObject({ schedule: 'Every day at 9:23 AM', prompt: 'Daily disk inspection', createdAt: at, expiresAt: at + config.recurringMaxAgeMs })
  })

  it('uses the CLI line stamp as the creation time on replay and leaves it unknown without one', () => {
    const f = fixture()
    const adopted = { ...process, identity: 'adopted', startedAt: at - 3_600_000, startOffset: 0 }
    f.tracker.configure('session', adopted, config)
    f.tracker.replay('session', adopted, true)
    f.tracker.observe('session', adopted, call('CronCreate', { cron: '* * * * *', prompt: 'Stamped' }, 'stamped'), true, 0)
    f.tracker.observe('session', adopted, result({ id: 'stamped', recurring: true, durable: false }, 'stamped', false, at - 1_800_000), true, 100)
    f.tracker.observe('session', adopted, call('CronCreate', { cron: '* * * * *', prompt: 'Bare' }, 'bare'), true, 200)
    f.tracker.observe('session', adopted, result({ id: 'bare', recurring: true, durable: false }, 'bare'), true, 300)
    f.tracker.replay('session', adopted, false)
    const jobs = f.value().jobs ?? []
    expect(jobs.find((job) => job.id === 'stamped')).toMatchObject({ createdAt: at - 1_800_000, expiresAt: at - 1_800_000 + config.recurringMaxAgeMs })
    expect(jobs.find((job) => job.id === 'bare')).toMatchObject({ createdAt: null, expiresAt: at - 3_600_000 + config.recurringMaxAgeMs })
  })

  describe('job list edge cases', () => {
    const ids = (f: ReturnType<typeof fixture>) => (f.value().jobs ?? []).map((job) => job.id)
    const remove = (f: ReturnType<typeof fixture>, id: string, call_ = `delete-${id}`) => {
      f.tracker.observe('session', process, call('CronDelete', { id }, call_))
      f.tracker.observe('session', process, result({}, call_))
    }

    it('deleting the last of two jobs empties the list and the badge together', () => {
      const f = fixture(); create(f, 'one'); create(f, 'two')
      remove(f, 'one')
      expect(f.value()).toMatchObject({ presence: 'active', jobs: [expect.objectContaining({ id: 'two' })] })
      remove(f, 'two')
      expect(f.value()).toMatchObject({ presence: 'inactive', source: null, jobs: [] })
    })

    it('a successful delete of an id it never saw changes nothing', () => {
      const f = fixture(); create(f)
      const before = f.value()
      remove(f, 'ghost')
      expect(f.value()).toBe(before)
    })

    it('re-creating an id after its deletion starts a fresh job with the new details', () => {
      const f = fixture(); create(f)
      remove(f, 'job')
      f.advance(60_000)
      f.tracker.observe('session', process, call('CronCreate', { cron: '5 * * * *', prompt: 'Second life' }, 'again'))
      f.tracker.observe('session', process, result({ id: 'job', humanSchedule: 'Every hour at :05', recurring: true, durable: false }, 'again'))
      expect(f.value().jobs).toEqual([expect.objectContaining({
        id: 'job', cron: '5 * * * *', schedule: 'Every hour at :05', prompt: 'Second life',
        createdAt: at + 60_000, expiresAt: at + 60_000 + config.recurringMaxAgeMs,
      })])
    })

    it('a one-shot job is listed as non-recurring until its run time, then leaves the list without claiming a run', () => {
      const f = fixture({ oneShot: true, nextRun: true })
      f.tracker.observe('session', process, call('CronCreate', { cron: '30 14 16 9 *', prompt: 'Once', recurring: false }))
      f.tracker.observe('session', process, result({ id: 'once', humanSchedule: 'On September 16 at 2:30 PM', recurring: false, durable: false }))
      const fire = cliOneShotTime('30 14 16 9 *', at, 'once', DEFAULT_CRON_RESTORE_CONFIG)!
      expect(fire).toBeGreaterThan(at)
      expect(f.value()).toMatchObject({ presence: 'active', validUntil: fire })
      expect(f.value().jobs).toEqual([expect.objectContaining({ id: 'once', recurring: false, expiresAt: fire, nextRunAt: nextCliCronMinute('30 14 16 9 *', at) })])
      f.advance(fire - at + 1)
      expect(f.value()).toMatchObject({ presence: 'unknown', known: true, jobs: [] })
    })

    it('a directory-shared durable job never appears next to a session-only one', () => {
      const f = fixture(); create(f, 'mine')
      f.tracker.observe('session', process, call('CronCreate', { cron: '0 * * * *', prompt: 'Shared' }, 'shared'))
      f.tracker.observe('session', process, result({ id: 'shared', recurring: true, durable: true }, 'shared'))
      expect(f.value()).toMatchObject({ presence: 'active' })
      expect(ids(f)).toEqual(['mine'])
      remove(f, 'mine')
      // The durable row is still known to exist, so the badge is unknown, not cleared.
      expect(f.value()).toMatchObject({ presence: 'unknown', jobs: [] })
    })

    it('two jobs expiring at different times drop out one at a time', () => {
      const f = fixture(); create(f, 'early')
      f.advance(3_600_000)
      create(f, 'late')
      expect(ids(f)).toEqual(['early', 'late'])
      expect(f.value().validUntil).toBe(at + 3_600_000 + config.recurringMaxAgeMs)
      f.advance(config.recurringMaxAgeMs - 3_600_000)
      expect(f.value()).toMatchObject({ presence: 'active', validUntil: at + 3_600_000 + config.recurringMaxAgeMs })
      expect(ids(f)).toEqual(['late'])
      f.advance(3_600_000)
      expect(f.value()).toMatchObject({ presence: 'unknown', jobs: [] })
    })

    it('a prompt exactly at the limit is kept whole', () => {
      const f = fixture()
      const prompt = 'y'.repeat(SESSION_CRON_PROMPT_LIMIT)
      f.tracker.observe('session', process, call('CronCreate', { cron: '* * * * *', prompt }))
      f.tracker.observe('session', process, result({ id: 'job', recurring: true, durable: false }))
      expect(f.value().jobs?.[0]).toMatchObject({ prompt, promptTruncated: false })
    })

    it('a list without a prompt keeps the prompt the create carried', () => {
      const f = fixture(); create(f)
      f.tracker.observe('session', process, call('CronList', {}, 'list'))
      f.tracker.observe('session', process, result({ jobs: [{ id: 'job', cron: '* * * * *', recurring: true, durable: false }] }, 'list'))
      expect(f.value()).toMatchObject({ presence: 'active' })
      expect(f.value().jobs?.[0]).toMatchObject({ prompt: 'Example', schedule: 'Every minute', createdAt: at })
    })

    it('an expression the CLI rule cannot evaluate stays listed with no next run', () => {
      const f = fixture({ nextRun: true })
      f.tracker.observe('session', process, call('CronCreate', { cron: 'every 5 minutes', prompt: 'Odd' }))
      f.tracker.observe('session', process, result({ id: 'odd', recurring: true, durable: false }))
      expect(f.value()).toMatchObject({ presence: 'active' })
      expect(f.value().jobs?.[0]).toMatchObject({ cron: 'every 5 minutes', nextRunAt: null, expiresAt: at + config.recurringMaxAgeMs })
    })

    it('orders equal next runs by id and caps the reported list at 32 without dropping the badge', () => {
      const f = fixture({ nextRun: true })
      for (const id of ['zeta', 'alpha', 'mid']) {
        f.tracker.observe('session', process, call('CronCreate', { cron: '* * * * *', prompt: id }, id))
        f.tracker.observe('session', process, result({ id, recurring: true, durable: false }, id))
      }
      expect(ids(f)).toEqual(['alpha', 'mid', 'zeta'])
      for (let i = 0; i < 30; i++) {
        const id = `bulk-${String(i).padStart(2, '0')}`
        f.tracker.observe('session', process, call('CronCreate', { cron: '* * * * *', prompt: id }, id))
        f.tracker.observe('session', process, result({ id, recurring: true, durable: false }, id))
      }
      expect(f.value()).toMatchObject({ presence: 'active' })
      expect(f.value().jobs).toHaveLength(32)
    })

    it('handles a create and a delete issued as parallel tool calls in one message', () => {
      const f = fixture(); create(f, 'old')
      f.tracker.observe('session', process, JSON.stringify({
        type: 'assistant',
        message: { content: [
          { type: 'tool_use', id: 'c', name: 'CronCreate', input: { cron: '*/10 * * * *', prompt: 'New' } },
          { type: 'tool_use', id: 'd', name: 'CronDelete', input: { id: 'old' } },
        ] },
      }))
      expect(ids(f)).toEqual(['old'])
      // The CLI answers parallel calls one result line each, delete first here.
      f.tracker.observe('session', process, result({}, 'd'))
      expect(f.value()).toMatchObject({ presence: 'inactive', jobs: [] })
      f.tracker.observe('session', process, result({ id: 'new', humanSchedule: 'Every 10 minutes', recurring: true, durable: false }, 'c'))
      expect(f.value()).toMatchObject({ presence: 'active' })
      expect(ids(f)).toEqual(['new'])
    })

    it('rename carries the job details to the new key', () => {
      const f = fixture(); create(f)
      expect(f.tracker.rename('session', 'renamed', process)).toBe(true)
      expect(f.tracker.list()[0]).toMatchObject({ sessionId: 'renamed', jobs: [expect.objectContaining({ id: 'job', prompt: 'Example' })] })
    })
  })

  it('ignores failed creates and failed deletes', () => {
    const f = fixture()
    f.tracker.observe('session', process, call('CronCreate'))
    f.tracker.observe('session', process, result({}, 'call', true))
    expect(f.value().presence).toBe('inactive')
    create(f)
    f.tracker.observe('session', process, call('CronDelete', { id: 'job' }))
    f.tracker.observe('session', process, result({}, 'call', true))
    expect(f.value().presence).toBe('active')
  })

  it('clears only the deleted job and clears the last job', () => {
    const f = fixture()
    create(f, 'one'); create(f, 'two')
    f.tracker.observe('session', process, call('CronDelete', { id: 'one' }))
    f.tracker.observe('session', process, result({}))
    expect(f.value().presence).toBe('active')
    f.tracker.observe('session', process, call('CronDelete', { id: 'two' }))
    f.tracker.observe('session', process, result({}))
    expect(f.value().presence).toBe('inactive')
  })

  it('becomes unknown at expiry without claiming a scheduler deletion', () => {
    const f = fixture(); create(f)
    const rev = f.value().revision
    f.advance(config.recurringMaxAgeMs)
    expect(f.value()).toMatchObject({ presence: 'unknown', known: true })
    expect(f.value().revision).toBeGreaterThan(rev)
  })

  it('does not treat old stream history as live after a new process starts', () => {
    const f = fixture(); create(f)
    f.tracker.state('session', { ...process, identity: 'process-2' })
    expect(f.value()).toMatchObject({ presence: 'unknown', known: true })
  })

  it('keeps live evidence through compaction in the same process', () => {
    const f = fixture(); create(f)
    f.tracker.observe('session', process, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))
    expect(f.value().presence).toBe('active')
  })

  it('does not arm from a subagent or an unsupported CLI', () => {
    const f = fixture()
    f.tracker.observe('session', process, JSON.stringify({ ...JSON.parse(call('CronCreate')), parent_tool_use_id: 'agent' }))
    f.tracker.observe('session', process, result({ id: 'job', recurring: true }))
    expect(f.value().presence).toBe('inactive')
    create(f)
    // A CLI outside the verified 2.1.224+ band cannot be parsed with confidence.
    f.tracker.state('session', { ...process, version: '2.2.0' })
    expect(f.value().presence).toBe('unknown')
  })

  it('marks dead processes stale and does not infer active from protection', () => {
    const f = fixture()
    f.tracker.state('session', process, true)
    expect(f.value()).toMatchObject({ presence: 'inactive', known: true })
    create(f)
    f.tracker.state('session', { ...process, alive: false })
    expect(f.value()).toMatchObject({ presence: 'unknown', stale: true })
  })

  it('uses the real list result as complete evidence without inventing creation dates', () => {
    const f = fixture()
    f.tracker.observe('session', process, call('CronList'))
    f.tracker.observe('session', process, result({ jobs: [{ id: 'job', cron: '* * * * *', recurring: true, durable: false }] }))
    expect(f.value()).toMatchObject({ presence: 'unknown', known: true, validUntil: null })
    f.tracker.observe('session', process, call('CronList'))
    f.tracker.observe('session', process, result({ jobs: [] }))
    expect(f.value().presence).toBe('inactive')
  })

  it('never treats a scheduled wakeup or its cancellation as a cron creation', () => {
    const f = fixture()
    f.tracker.observe('session', process, call('ScheduleWakeup', { delaySeconds: 60 }))
    f.tracker.observe('session', process, result({ scheduledFor: at + 60_000 }))
    expect(f.value()).toMatchObject({ presence: 'inactive', source: null, known: false })
    f.tracker.observe('session', process, call('ScheduleWakeup', { stop: true }))
    f.tracker.observe('session', process, result({ scheduledFor: 0, stopped: true, cancelledWakeups: 0 }))
    expect(f.value()).toMatchObject({ presence: 'inactive', source: null, known: false })
  })

  it('does not let a wakeup extend a cron lifetime or survive the last cron deletion', () => {
    const f = fixture(); create(f)
    f.tracker.observe('session', process, call('ScheduleWakeup', { delaySeconds: 60 }))
    f.tracker.observe('session', process, result({ scheduledFor: at + config.recurringMaxAgeMs * 2 }))
    expect(f.value().validUntil).toBe(at + config.recurringMaxAgeMs)
    f.tracker.observe('session', process, call('CronDelete', { id: 'job' }))
    f.tracker.observe('session', process, result({}))
    expect(f.value().presence).toBe('inactive')
  })

  it('does not retain a cron label from replaying a stopped historical wakeup', () => {
    const f = fixture()
    const adopted = { ...process, identity: 'adopted' }
    f.tracker.replay('session', adopted, true)
    f.tracker.observe('session', adopted, call('ScheduleWakeup', { delaySeconds: 60 }), true, 0)
    f.tracker.observe('session', adopted, result({ scheduledFor: at - 60_000 }), true, 100)
    f.tracker.observe('session', adopted, call('ScheduleWakeup', { stop: true }), true, 200)
    f.tracker.observe('session', adopted, result({ scheduledFor: 0, stopped: true, cancelledWakeups: 0 }), true, 300)
    f.tracker.replay('session', adopted, false)
    expect(f.tracker.state('session', { ...adopted, alive: false })).toMatchObject({ known: false, source: null, stale: true })
  })

  it('does not publish unchanged state for ordinary stream lines', () => {
    const f = fixture(); create(f)
    const count = f.values.length
    for (let i = 0; i < 1000; i++) {
      f.tracker.observe('session', process, JSON.stringify({ type: 'stream_event', delta: 'text' }))
      f.tracker.state('session', process)
    }
    expect(f.values).toHaveLength(count)
  })

  it('publishes a replay only after it reaches the live cursor', () => {
    const f = fixture()
    const adopted = { ...process, startedAt: at - 1000, startOffset: 100 }
    f.tracker.replay('session', adopted, true)
    f.tracker.observe('session', adopted, call('CronCreate'), true, 100)
    f.tracker.observe('session', adopted, result({ id: 'job', recurring: true }), true, 200)
    expect(f.value().presence).toBe('unknown')
    f.tracker.replay('session', adopted, false)
    expect(f.value().presence).toBe('active')
  })

  it('recovers after an interrupted replay without publishing a partial inventory', () => {
    const f = fixture()
    f.tracker.replay('session', process, true)
    create(f)
    f.tracker.replay('session', process, false, true)
    expect(f.value()).toMatchObject({ presence: 'unknown', known: true })
    create(f, 'later')
    expect(f.value().presence).toBe('active')
  })

  it('invalidates corrupt relevant live output and ignores replies from before the gap', () => {
    const f = fixture(); create(f)
    f.tracker.observe('session', process, call('CronList', {}, 'old-list'))
    f.tracker.observe('session', process, '{"type":"user","tool_use_result":"CronDelete"')
    expect(f.value()).toMatchObject({ presence: 'unknown', known: true })
    f.tracker.observe('session', process, result({ jobs: [] }, 'old-list'))
    expect(f.value().presence).toBe('unknown')
    create(f, 'later')
    expect(f.value().presence).toBe('active')
    f.tracker.observe('session', process, call('CronDelete', { id: 'later' }))
    f.tracker.observe('session', process, result({}))
    expect(f.value().presence).toBe('unknown')
    f.tracker.observe('session', process, call('CronList'))
    f.tracker.observe('session', process, result({ jobs: [] }))
    expect(f.value().presence).toBe('inactive')
  })

  it('does not let a cached disabled flag erase a confirmed create', () => {
    const f = fixture()
    f.tracker.configure('session', process, { ...config, enabled: false })
    create(f)
    expect(f.value()).toMatchObject({ presence: 'active', known: true })
  })

  it('retains uncertainty after a confirmed create when configuration is unavailable', () => {
    const f = fixture()
    f.tracker.configure('session', process, null)
    create(f)
    expect(f.value()).toMatchObject({ presence: 'unknown', known: true })
  })

  it('does not let a delayed list erase a newer creation', () => {
    const f = fixture()
    f.tracker.observe('session', process, call('CronList', {}, 'list'))
    create(f)
    f.tracker.observe('session', process, result({ jobs: [] }, 'list'))
    expect(f.value()).toMatchObject({ presence: 'active', known: true })
  })

  it('does not let a delayed list revive a deleted job', () => {
    const f = fixture(); create(f)
    f.tracker.observe('session', process, call('CronList', {}, 'list'))
    f.tracker.observe('session', process, call('CronDelete', { id: 'job' }, 'delete'))
    f.tracker.observe('session', process, result({}, 'delete'))
    f.tracker.observe('session', process, result({ jobs: [{ id: 'job', recurring: true, durable: false }] }, 'list'))
    expect(f.value().presence).toBe('inactive')
  })

  it('ignores an older list that arrives after a newer list', () => {
    const f = fixture()
    f.tracker.observe('session', process, call('CronList', {}, 'old'))
    f.tracker.observe('session', process, call('CronList', {}, 'new'))
    f.tracker.observe('session', process, result({ jobs: [] }, 'new'))
    f.tracker.observe('session', process, result({ jobs: [{ id: 'job' }] }, 'old'))
    expect(f.value().presence).toBe('inactive')
  })

  it('accepts a newer list after an earlier list completed', () => {
    const f = fixture()
    f.tracker.observe('session', process, call('CronList', {}, 'old'))
    f.tracker.observe('session', process, call('CronList', {}, 'new'))
    f.tracker.observe('session', process, result({ jobs: [{ id: 'job' }] }, 'old'))
    f.tracker.observe('session', process, result({ jobs: [] }, 'new'))
    expect(f.value().presence).toBe('inactive')
  })

  it('preserves evidence on rename only for the same process and clears the old key', () => {
    const f = fixture(); create(f)
    expect(f.tracker.rename('session', 'renamed', process)).toBe(true)
    expect(f.tracker.list()).toEqual([expect.objectContaining({ sessionId: 'renamed', presence: 'active' })])
    expect(f.values.findLast((v) => v.sessionId === 'session')).toMatchObject({ presence: 'inactive', known: false })
    expect(f.tracker.rename('renamed', 'different', { ...process, identity: 'other' })).toBe(false)
    expect(f.tracker.list()).toEqual([expect.objectContaining({ sessionId: 'different', presence: 'unknown', known: true })])
  })

  it('discards a partial replay on rename', () => {
    const f = fixture()
    f.tracker.replay('session', process, true)
    create(f)
    expect(f.tracker.rename('session', 'renamed', process)).toBe(false)
    expect(f.tracker.list()).toEqual([expect.objectContaining({ sessionId: 'renamed', presence: 'unknown', known: true })])
  })

  it('does not grant an unlimited lifetime to a directory-shared job', () => {
    const f = fixture()
    f.tracker.observe('session', process, call('CronCreate'))
    f.tracker.observe('session', process, result({ id: 'shared', recurring: true, durable: true }))
    expect(f.value()).toMatchObject({ presence: 'unknown', known: true })
  })

  // What an ADOPTED session has instead of a spawn offset: the OS process start
  // time. Every cron tool line carries a CLI stamp, so a line written after the
  // live process began is that process's own work no matter where it sits in the
  // stream — which is what brings a badge back after a daemon restart.
  describe('attribution by process start time', () => {
    const started = at - 2 * 3_600_000
    // startOffset is set as well, and deliberately past every offset used below:
    // under the byte rule each line would be history, so a live verdict can only
    // come from the time rule.
    const adopted: CronMetadataProcess = { ...process, identity: 'adopted', startedAt: started, startOffset: 10_000, attributeByTime: true }
    const replay = (f: ReturnType<typeof fixture>, lines: Array<[string, number]>) => {
      f.tracker.configure('session', adopted, config)
      f.tracker.replay('session', adopted, true)
      for (const [line, offset] of lines) f.tracker.observe('session', adopted, line, true, offset)
      f.tracker.replay('session', adopted, false)
      return f.value()
    }

    it('reports a job the live process created before the daemon adopted it', () => {
      const madeAt = started + 60_000
      const value = replay(fixture(), [
        [call('CronCreate', { cron: '*/10 * * * *', prompt: 'Watch' }, 'made', madeAt), 0],
        [result({ id: 'a0584826', humanSchedule: 'Every 10 minutes', recurring: true, durable: false }, 'made', false, madeAt), 120],
      ])
      expect(value).toMatchObject({ presence: 'active', known: true, source: 'cron' })
      expect(value.jobs).toEqual([{
        id: 'a0584826', cron: '*/10 * * * *', schedule: 'Every 10 minutes', prompt: 'Watch', promptTruncated: false,
        recurring: true, durable: false, createdAt: madeAt, nextRunAt: null, expiresAt: madeAt + config.recurringMaxAgeMs,
      }])
    })

    it('leaves a create from before the live process started as history', () => {
      const madeAt = started - 60_000
      const value = replay(fixture(), [
        [call('CronCreate', { cron: '*/10 * * * *', prompt: 'Older' }, 'old', madeAt), 0],
        [result({ id: 'old-job', recurring: true, durable: false }, 'old', false, madeAt), 120],
      ])
      expect(value).toMatchObject({ presence: 'unknown', known: true, jobs: [] })
    })

    it('leaves an unstamped create as history rather than guessing its process', () => {
      const value = replay(fixture(), [
        [call('CronCreate', { cron: '*/10 * * * *', prompt: 'Bare' }, 'bare'), 0],
        [result({ id: 'bare-job', recurring: true, durable: false }, 'bare'), 120],
      ])
      expect(value).toMatchObject({ presence: 'unknown', known: true, jobs: [] })
    })

    it('honours a delete the same replay carries', () => {
      const madeAt = started + 60_000
      const value = replay(fixture(), [
        [call('CronCreate', { cron: '*/10 * * * *', prompt: 'Watch' }, 'made', madeAt), 0],
        [result({ id: 'gone', recurring: true, durable: false }, 'made', false, madeAt), 120],
        [call('CronDelete', { id: 'gone' }, 'drop', madeAt + 1000), 240],
        [result({ ok: true }, 'drop', false, madeAt + 1000), 360],
      ])
      expect(value).toMatchObject({ presence: 'unknown', jobs: [] })
    })

    it('ages a recovered job out by the CLI expiry rule', () => {
      const f = fixture()
      const madeAt = started + 60_000
      expect(replay(f, [
        [call('CronCreate', { cron: '*/10 * * * *', prompt: 'Watch' }, 'made', madeAt), 0],
        [result({ id: 'aging', recurring: true, durable: false }, 'made', false, madeAt), 120],
      ]).presence).toBe('active')
      f.advance(config.recurringMaxAgeMs)
      f.tracker.refresh()
      expect(f.value()).toMatchObject({ presence: 'unknown', jobs: [] })
    })

    it('accepts a live list as the complete inventory', () => {
      const madeAt = started + 60_000
      const value = replay(fixture(), [
        [call('CronCreate', { cron: '*/10 * * * *', prompt: 'Watch' }, 'made', madeAt), 0],
        [result({ id: 'listed', recurring: true, durable: false }, 'made', false, madeAt), 120],
        [call('CronList', {}, 'list', madeAt + 1000), 240],
        [result({ jobs: [] }, 'list', false, madeAt + 1000), 360],
      ])
      expect(value).toMatchObject({ presence: 'inactive', source: null, jobs: [] })
    })
  })

  it('old-generation replay remains unknown even when a create exists', () => {
    const f = fixture()
    const resumed = { ...process, startedAt: at + 1000, startOffset: 300 }
    f.tracker.replay('session', resumed, true)
    f.tracker.observe('session', resumed, call('CronCreate'), true, 100)
    f.tracker.observe('session', resumed, result({ id: 'job', recurring: true }), true, 200)
    f.tracker.replay('session', resumed, false)
    expect(f.value()).toMatchObject({ presence: 'unknown', known: true })
  })

  it('reads only complete byte ranges and preserves multibyte content', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-metadata-reader-'))
    const file = path.join(directory, 'stream.jsonl')
    try {
      const first = JSON.stringify({ type: 'user', text: String.fromCodePoint(0x6d4b, 0x8bd5) }) + '\n'
      const second = JSON.stringify({ type: 'user', text: 'next' }) + '\n'
      await fs.writeFile(file, first + second + '{"partial":')
      const seen: string[] = []
      await readCronMetadataStream(file, Buffer.byteLength(first), Buffer.byteLength(first + second), AbortSignal.timeout(1000), (line) => seen.push(line))
      expect(seen).toEqual([second.trim()])
      await expect(readCronMetadataStream(file, 1, Buffer.byteLength(first), AbortSignal.timeout(1000), () => {})).rejects.toThrow('line boundary')
      await expect(readCronMetadataStream(file, 0, Buffer.byteLength(first + second) + 2, AbortSignal.timeout(1000), () => {})).rejects.toThrow('inside a line')
      await expect(readCronMetadataStream(file, 0, 10000, AbortSignal.timeout(1000), () => {})).rejects.toThrow('truncated')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects corrupt streams, replacement files, and aborted reads', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-metadata-reader-'))
    const file = path.join(directory, 'stream.jsonl')
    try {
      for (const content of ['not json\n', '[]\n']) {
        await fs.writeFile(file, content)
        await expect(readCronMetadataStream(file, 0, Buffer.byteLength(content), AbortSignal.timeout(1000), () => {})).rejects.toThrow()
      }
      const content = '{"type":"user"}\n'
      await fs.writeFile(file, content)
      await fs.writeFile(path.join(directory, 'replacement.jsonl'), content)
      await expect(readCronMetadataStream(file, 0, Buffer.byteLength(content), AbortSignal.timeout(1000), () => {
        renameSync(path.join(directory, 'replacement.jsonl'), file)
      })).rejects.toThrow('changed')
      const controller = new AbortController()
      controller.abort()
      await expect(readCronMetadataStream(file, 0, content.length, controller.signal, () => {})).rejects.toThrow()
      const midRead = new AbortController()
      await expect(readCronMetadataStream(file, 0, content.length, midRead.signal, () => midRead.abort())).rejects.toThrow()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('fails oversized lines rather than rebuilding an unbounded buffer', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-metadata-reader-'))
    const file = path.join(directory, 'stream.jsonl')
    try {
      const handle = await fs.open(file, 'w')
      try {
        const chunk = Buffer.alloc(1024 * 1024, 32)
        for (let i = 0; i < 33; i++) await handle.write(chunk)
      } finally { await handle.close() }
      await expect(readCronMetadataStream(file, 0, 33 * 1024 * 1024, AbortSignal.timeout(5000), () => {})).rejects.toThrow('tailer limit')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('reads a new process from its exact append offset after a torn prior line', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-metadata-reader-'))
    const file = path.join(directory, 'stream.jsonl')
    try {
      const torn = '{"type":"old'
      const content = call('CronCreate') + '\n' + result({ id: 'job', recurring: true }) + '\n'
      await fs.writeFile(file, torn + content)
      const stat = await fs.stat(file)
      const expectedEpoch = `${stat.dev}:${stat.ino}:${Math.floor(stat.birthtimeMs)}`
      const f = fixture()
      const adopted = { ...process, startedAt: at, startOffset: Buffer.byteLength(torn) }
      f.tracker.replay('session', adopted, true)
      await readCronMetadataStream(file, adopted.startOffset, Buffer.byteLength(torn + content), AbortSignal.timeout(1000),
        (line, offset) => f.tracker.observe('session', adopted, line, true, offset), { processBoundary: true, expectedEpoch })
      f.tracker.replay('session', adopted, false)
      expect(f.value().presence).toBe('active')
      await expect(readCronMetadataStream(file, 0, 0, AbortSignal.timeout(1000), () => {}, { expectedEpoch: 'wrong' })).rejects.toThrow('changed')
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })

  it('invalidates an inventory gap and accepts later confirmed work without retaining oversized lines', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-metadata-reader-'))
    const file = path.join(directory, 'stream.jsonl')
    try {
      const handle = await fs.open(file, 'w')
      try {
        const chunk = Buffer.alloc(1024 * 1024, 32)
        for (let i = 0; i < 33; i++) await handle.write(chunk)
        await handle.write('\ncorrupt\n' + call('CronCreate') + '\n' + result({ id: 'later', recurring: true }) + '\n')
      } finally { await handle.close() }
      const f = fixture(); create(f)
      const adopted = { ...process, startOffset: 0, startedAt: at }
      let gaps = 0
      f.tracker.replay('session', adopted, true)
      await readCronMetadataStream(file, 0, (await fs.stat(file)).size, AbortSignal.timeout(5000),
        (line, offset) => f.tracker.observe('session', adopted, line, true, offset), {
          onGap: () => { gaps++; f.tracker.replay('session', adopted, true, true) },
        })
      f.tracker.replay('session', adopted, false)
      expect(gaps).toBe(2)
      expect(f.value().presence).toBe('active')
      f.tracker.observe('session', adopted, call('CronDelete', { id: 'later' }))
      f.tracker.observe('session', adopted, result({}))
      expect(f.value().presence).toBe('unknown')
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })

  it('survives source daemon function injection', () => {
    const injected = new Function(`return (${createCronMetadataTracker.toString()})`)() as typeof createCronMetadataTracker
    const tracker = injected({ epoch: 'injected', clock: () => at, changed: () => {} })
    tracker.configure('session', process, config)
    tracker.observe('session', process, call('CronCreate'))
    tracker.observe('session', process, result({ id: 'job', recurring: true }))
    expect(tracker.list()[0].presence).toBe('active')
  })
})
