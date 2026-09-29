/**
 * Rhythm's ring in the rail (src/server/status-item.ts) on a real timeline: every state
 * the design names, reached through the runtime and its ops rather than hand-built
 * state, so the mapping is checked against what Rhythm actually does.
 *
 *   counting → due (Start break / Snooze) → the break counts down → the count starts at its end
 *   Stand up now while counting starts the same break; End break starts the count at once
 *   snoozed, deferred on an agent turn, Walnut quiet, quiet hours, away
 *   focus → block done → break → idle
 */
import { describe, expect, it } from 'vitest'
import type { WalnutTask } from '../../../packages/plugin-api/src/shared.js'
import * as actions from '../../../plugin-store/walnut-rhythm/src/server/actions'
import { buildPublicState } from '../../../plugin-store/walnut-rhythm/src/server/public-state'
import type { RhythmRuntime } from '../../../plugin-store/walnut-rhythm/src/server/runtime'
import { rhythmStatusItem } from '../../../plugin-store/walnut-rhythm/src/server/status-item'
import { makeHarness, MIN, sitThrough } from './harness'

/** 09:00 local, outside the default 22:00-08:00 quiet hours. */
const NINE = new Date(2026, 8, 25, 9, 0).getTime()

async function boot(config: Record<string, unknown> = {}) {
  const h = makeHarness({ start: NINE, config, tasks: [task('task-7', 'Spec review')] })
  const runtime = h.build()
  await runtime.load()
  await runtime.kick()
  return { h, runtime }
}

function task(id: string, title: string): WalnutTask {
  return {
    id, title, phase: 'IN_PROGRESS', priority: 'none', description: '', summary: '', source: 'local',
    createdAt: new Date(NINE).toISOString(), updatedAt: new Date(NINE).toISOString(),
  } as WalnutTask
}

function ring(runtime: RhythmRuntime) {
  return rhythmStatusItem(buildPublicState(runtime, runtime.now()))
}

const labels = (item: ReturnType<typeof rhythmStatusItem>) => (item?.actions ?? []).map((a) => a.label)

describe('the stand-up ring', () => {
  it('is hidden before anyone sits down', async () => {
    const { runtime } = await boot()
    expect(ring(runtime)).toBeNull()
  })

  it('fills toward the reminder, turns orange when it fires, and Start break counts the break down', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 12 * MIN)
    const counting = ring(runtime)!
    expect(counting).toMatchObject({
      title: 'Stand up in {remaining}',
      detail: '12 min at the keyboard.',
      tone: 'neutral',
      timer: { startedAt: NINE, endsAt: NINE + 60 * MIN, mode: 'fill' },
      app: 'main',
    })
    expect(labels(counting)).toEqual(['Stand up now', 'Start focus block'])

    await sitThrough(h, runtime, NINE + 12 * MIN, NINE + 61 * MIN)
    const due = ring(runtime)!
    expect(due).toMatchObject({ title: 'Time to stand up', tone: 'warning', glyph: 'stand' })
    expect(due.detail).toMatch(/at the keyboard\. Start break counts down 10 min\.$/)
    expect(due.timer).toBeUndefined()
    expect(due.actions).toEqual([
      { label: 'Start break', op: 'break_start', primary: true },
      { label: 'Snooze 10 min', op: 'break_snooze', args: { minutes: 10 } },
    ])
    // Still orange on the next ticks: the scheduler already counts toward the NEXT
    // reminder, but nobody has answered this one.
    await h.tick(runtime, 30_000)
    expect(ring(runtime)).toMatchObject({ tone: 'warning' })

    // The button does what it says: a timer the person stands up for, not a new round.
    await actions.breakStart(runtime)
    const started = runtime.now()
    const rest = ring(runtime)!
    expect(rest).toMatchObject({
      title: 'Break · {remaining} left',
      tone: 'success',
      detail: 'Walk, stretch, look away from the screen. The sitting count starts when it ends.',
      timer: { startedAt: started, endsAt: started + 10 * MIN, mode: 'drain' },
    })
    expect(rest.actions).toEqual([{ label: 'End break', op: 'break_skip' }])
    expect(h.feed.has('stand-up')).toBe(false)
    expect(runtime.day.remindersDone).toBe(1)

    // They walk away; the break runs out: a "Break over" notice with no buttons.
    await h.tick(runtime, 10 * MIN)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.feed.get('break-over')).toMatchObject({ title: 'Break over', body: 'Welcome back. The sitting count starts again now.' })
    expect(h.feed.get('break-over')!.actions).toBeUndefined()
    expect(ring(runtime)).toBeNull()

    // Back at the keyboard: a fresh count from their return, a full interval out.
    const back = runtime.now()
    await sitThrough(h, runtime, back, back + 3 * MIN)
    const again = ring(runtime)!
    expect(again).toMatchObject({ title: 'Stand up in {remaining}', tone: 'neutral', timer: { mode: 'fill' } })
    expect(again.timer!.startedAt).toBeGreaterThanOrEqual(started + 10 * MIN)
    expect(again.timer!.endsAt - again.timer!.startedAt).toBe(60 * MIN)
  })

  it('Stand up now starts the same break; End break starts the count at once', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 20 * MIN)
    expect(ring(runtime)!.actions![0]).toEqual({ label: 'Stand up now', op: 'break_start', primary: true })

    await actions.breakStart(runtime)
    expect(ring(runtime)).toMatchObject({ title: 'Break · {remaining} left', timer: { endsAt: NINE + 30 * MIN } })
    expect(runtime.day.breaksTaken).toBe(1)

    // Typing through the break does not end it; End break does.
    await sitThrough(h, runtime, NINE + 20 * MIN, NINE + 23 * MIN)
    expect(ring(runtime)).toMatchObject({ tone: 'success' })
    await actions.breakSkip(runtime)
    expect(ring(runtime)).toMatchObject({
      title: 'Stand up in {remaining}',
      timer: { startedAt: NINE + 23 * MIN, endsAt: NINE + 83 * MIN, mode: 'fill' },
    })
    expect(h.feed.has('break-over')).toBe(false)
  })

  it('a break that runs out while they keep typing starts the count at its end', async () => {
    const { h, runtime } = await boot({ stand_break_minutes: 4 })
    await sitThrough(h, runtime, NINE, NINE + 20 * MIN)
    await actions.breakStart(runtime)
    await sitThrough(h, runtime, NINE + 20 * MIN, NINE + 26 * MIN)
    expect(h.feed.has('break-over')).toBe(true)
    expect(ring(runtime)).toMatchObject({
      title: 'Stand up in {remaining}',
      detail: '2 min at the keyboard.',
      timer: { startedAt: NINE + 24 * MIN, endsAt: NINE + 84 * MIN },
    })
  })

  it('snoozed: drains the snooze, with Snooze again', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 61 * MIN)
    await actions.breakSnooze(runtime, {})
    const snoozed = ring(runtime)!
    expect(snoozed).toMatchObject({
      title: 'Reminder in {remaining}', tone: 'neutral',
      timer: { startedAt: runtime.now(), endsAt: runtime.now() + 10 * MIN, mode: 'drain' },
    })
    expect(labels(snoozed)).toEqual(['Stand up now', 'Snooze 10 more'])
  })

  it('waits on a running agent turn with its own words', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 55 * MIN)
    runtime.turn({ sessionId: 's-1' })
    await sitThrough(h, runtime, NINE + 55 * MIN, NINE + 61 * MIN)
    expect(ring(runtime)).toMatchObject({ title: 'Stand up after this turn', glyph: 'stand', tone: 'neutral' })
  })

  it('paused while someone else holds Walnut quiet', async () => {
    const { h, runtime } = await boot()
    h.setUserQuiet({ source: 'user', since: NINE })
    await sitThrough(h, runtime, NINE, NINE + 61 * MIN)
    expect(ring(runtime)).toMatchObject({ title: 'Stand-up reminder paused', glyph: 'pause' })
    expect(labels(ring(runtime))).toEqual(['Stand up now'])
  })

  it('stays dark inside quiet hours', async () => {
    const { h, runtime } = await boot({ quiet_hours: '08:00-10:00' })
    await sitThrough(h, runtime, NINE, NINE + 20 * MIN)
    expect(ring(runtime)).toBeNull()
  })

  it('goes away when the person does', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 20 * MIN)
    expect(ring(runtime)).not.toBeNull()
    await h.tick(runtime, 6 * MIN)
    expect(ring(runtime)).toBeNull()
  })
})

describe('the focus ring', () => {
  it('focus drains blue, block done is a green check, the break drains green', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 5 * MIN)
    await actions.focusStart(runtime, { taskId: 'task-7', minutes: 25 })
    const focus = ring(runtime)!
    expect(focus).toMatchObject({
      title: 'Focus · {remaining} left',
      detail: 'Spec review. Walnut is quiet until it ends.',
      tone: 'accent',
      timer: { startedAt: NINE + 5 * MIN, endsAt: NINE + 30 * MIN, mode: 'drain' },
    })
    expect(focus.actions).toEqual([{ label: 'Stop block', op: 'focus_stop' }])

    await sitThrough(h, runtime, NINE + 5 * MIN, NINE + 31 * MIN)
    const done = ring(runtime)!
    expect(done).toMatchObject({
      title: 'Focus block done', tone: 'success', glyph: 'check',
      detail: '25 min on Spec review. Time for a 5 min break.',
    })
    expect(done.actions).toEqual([
      { label: 'Start break', op: 'break_start', primary: true },
      { label: 'Skip break', op: 'break_skip' },
      { label: 'Another block', op: 'focus_start', args: { taskId: 'task-7', minutes: 25 } },
    ])

    await actions.breakStart(runtime)
    const rest = ring(runtime)!
    expect(rest).toMatchObject({ title: 'Break · {remaining} left', tone: 'success', timer: { mode: 'drain' } })
    expect(rest.timer!.endsAt - rest.timer!.startedAt).toBe(5 * MIN)
    expect(rest.actions).toEqual([{ label: 'End break', op: 'break_skip' }])

    await actions.breakSkip(runtime)
    expect(ring(runtime)).toMatchObject({ title: 'Stand up in {remaining}', tone: 'neutral' })
  })

  it('says nothing about quiet when a block does not quiet Walnut', async () => {
    const { h, runtime } = await boot({ focus_quiets_walnut: false })
    await sitThrough(h, runtime, NINE, NINE + MIN)
    await actions.focusStart(runtime, {})
    expect(ring(runtime)).toMatchObject({ detail: 'One thing until it ends.' })
  })

  it('every state it can publish passes the host limits', async () => {
    const { h, runtime } = await boot()
    const seen: Array<ReturnType<typeof rhythmStatusItem>> = []
    const take = () => seen.push(ring(runtime))
    await sitThrough(h, runtime, NINE, NINE + 61 * MIN); take()
    await actions.breakSnooze(runtime, {}); take()
    await actions.focusStart(runtime, { taskId: 'task-7' }); take()
    await sitThrough(h, runtime, runtime.now(), runtime.now() + 26 * MIN); take()
    await actions.breakStart(runtime); take()
    for (const item of seen) {
      expect(item).not.toBeNull()
      expect(item!.title.length).toBeLessThanOrEqual(80)
      expect((item!.detail ?? '').length).toBeLessThanOrEqual(200)
      expect(item!.actions!.length).toBeLessThanOrEqual(3)
      expect(item!.actions!.filter((a) => a.primary).length).toBeLessThanOrEqual(1)
      for (const action of item!.actions!) expect(action.label.length).toBeLessThanOrEqual(40)
    }
  })
})
