/**
 * Rhythm runtime: the pure decisions applied to a fake host on a fake clock. Real
 * timelines, minute by minute: sitting, walking away, agent turns, snoozes, focus
 * blocks, quiet mode, a macOS Focus, and restarts.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WalnutTask } from '../../../packages/plugin-api/src/shared.js'
import * as actions from '../../../plugin-store/walnut-rhythm/src/server/actions'
import type { MacosFocusRead } from '../../../plugin-store/walnut-rhythm/src/server/macos-focus'
import { banked, makeHarness, MIN, sitThrough } from './harness'
import { spansFromBanked } from '../../../plugin-store/walnut-rhythm/src/server/presence'

/** 09:00 local, well outside the default 22:00-08:00 quiet hours. */
const NINE = new Date(2026, 8, 25, 9, 0).getTime()

function task(id: string, title: string): WalnutTask {
  return {
    id, title, phase: 'IN_PROGRESS', priority: 'none', description: '', summary: '', source: 'local',
    createdAt: new Date(NINE).toISOString(), updatedAt: new Date(NINE).toISOString(),
  } as WalnutTask
}

async function boot(options: Partial<Parameters<typeof makeHarness>[0]> = {}) {
  const h = makeHarness({ start: NINE, ...options })
  const runtime = h.build()
  await runtime.load()
  await runtime.kick()
  return { h, runtime }
}

describe('the stand-up reminder on a real timeline', () => {
  it('fires once after an hour at the keyboard, dismissing any old copy first, then once per further hour', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 59 * MIN)
    expect(h.notices('stand-up')).toHaveLength(0)
    await sitThrough(h, runtime, NINE + 59 * MIN, NINE + 61 * MIN)
    const fired = h.notices('stand-up')
    expect(fired).toHaveLength(1)
    expect(fired[0]!.notice).toMatchObject({
      kind: 'reminder',
      title: 'Stand up: 1h 00m at the keyboard',
      body: 'Start break counts down 10 min in the sidebar. Walk, stretch, look away from the screen.',
      actions: [{ label: 'Start break', op: 'break_start' }, { label: 'Snooze 10 min', op: 'break_snooze', args: { minutes: 10 } }],
    })
    // Dismiss-before-refire: the call right before the notify dismissed the same key.
    const index = h.calls.indexOf(fired[0]!)
    expect(h.calls[index - 1]).toEqual({ type: 'dismiss', key: 'stand-up' })

    for (let i = 0; i < 6; i++) await h.tick(runtime, 30_000)
    await sitThrough(h, runtime, NINE + 64 * MIN, NINE + 110 * MIN)
    expect(h.notices('stand-up')).toHaveLength(1)
    await sitThrough(h, runtime, NINE + 110 * MIN, NINE + 121 * MIN)
    expect(h.notices('stand-up')).toHaveLength(2)
    expect(runtime.day.remindersFired).toBe(2)
  })

  it('two 40-minute stints with a 6-minute walk between them never trigger it', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 40 * MIN)
    await h.tick(runtime, 6 * MIN)
    await sitThrough(h, runtime, NINE + 46 * MIN, NINE + 86 * MIN)
    expect(h.notices('stand-up')).toHaveLength(0)
    expect(runtime.day.longestStreakMs).toBe(40 * MIN)
  })

  it('walking away while a reminder waits counts as a break and withdraws the reminder', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 61 * MIN)
    expect(h.feed.has('stand-up')).toBe(true)
    await h.tick(runtime, 5 * MIN)
    expect(h.feed.has('stand-up')).toBe(false)
    expect(runtime.day).toMatchObject({ movedWithoutClick: 1, breaksTaken: 1, remindersFired: 1 })
  })

  it('break_done (a stand-up logged with no timer) starts the count over; Snooze brings it back after the snooze', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 61 * MIN)
    const done = await actions.breakDone(runtime)
    expect(done.message).toMatch(/starts over/)
    expect(runtime.day).toMatchObject({ remindersDone: 1, breaksTaken: 1 })
    expect(h.feed.has('stand-up')).toBe(false)
    await sitThrough(h, runtime, NINE + 61 * MIN, NINE + 120 * MIN)
    expect(h.notices('stand-up')).toHaveLength(1)
    await sitThrough(h, runtime, NINE + 120 * MIN, NINE + 122 * MIN)
    expect(h.notices('stand-up')).toHaveLength(2)

    await actions.breakSnooze(runtime, { minutes: 10 })
    expect(runtime.day.remindersSnoozed).toBe(1)
    await sitThrough(h, runtime, NINE + 122 * MIN, NINE + 131 * MIN)
    expect(h.notices('stand-up')).toHaveLength(2)
    await sitThrough(h, runtime, NINE + 131 * MIN, NINE + 133 * MIN)
    expect(h.notices('stand-up')).toHaveLength(3)
  })

  it('waits for an agent turn to finish, and fires at that natural pause', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 58 * MIN)
    // A message sent at minute 58: the agent is still answering when the reminder is due.
    runtime.turn({ sessionId: 'session-a', turnIndex: 1, timestamp: '', traceId: '' })
    await sitThrough(h, runtime, NINE + 58 * MIN, NINE + 62 * MIN)
    expect(h.notices('stand-up')).toHaveLength(0)
    expect(runtime.evaluate(h.clock.t).view.phase).toBe('deferred')
    runtime.turn({ sessionId: 'session-a', result: 'ok', turnIndex: 1, timestamp: '', traceId: '' })
    await runtime.kick()
    expect(h.notices('stand-up')).toHaveLength(1)
  })

  it('never waits past the cap for a turn that does not end', async () => {
    const { h, runtime } = await boot({ config: { defer_for_natural_pause_minutes: 3 } })
    await sitThrough(h, runtime, NINE, NINE + 58 * MIN)
    runtime.turn({ sessionId: 'session-b', turnIndex: 1 })
    await sitThrough(h, runtime, NINE + 58 * MIN, NINE + 62 * MIN)
    expect(h.notices('stand-up')).toHaveLength(0)
    await sitThrough(h, runtime, NINE + 62 * MIN, NINE + 64 * MIN)
    expect(h.notices('stand-up')).toHaveLength(1)
  })

  it('a turn with no end event for an hour is no longer waited on (an interrupted turn)', async () => {
    const { h, runtime } = await boot()
    runtime.turn({ sessionId: 'session-stuck', turnIndex: 1 })
    await sitThrough(h, runtime, NINE, NINE + 61 * MIN)
    expect(runtime.turnsInFlight(h.clock.t)).toBe(0)
    expect(h.notices('stand-up')).toHaveLength(1)
  })

  it('quiet hours across midnight hold the reminder until the morning', async () => {
    // 23:00 to 00:10: due at midnight, held because 22:00-08:00 crosses it.
    const late = new Date(2026, 8, 25, 23, 0).getTime()
    const night = await boot({ start: late })
    await sitThrough(night.h, night.runtime, late, late + 70 * MIN)
    expect(night.h.notices('stand-up')).toHaveLength(0)
    expect(night.runtime.evaluate(night.h.clock.t).view).toMatchObject({ phase: 'paused', pausedBy: 'quiet_hours' })

    // 06:50 onward: due at 07:50, held, then released the minute quiet hours end.
    const early = new Date(2026, 8, 26, 6, 50).getTime()
    const morning = await boot({ start: early })
    await sitThrough(morning.h, morning.runtime, early, early + 69 * MIN)
    expect(morning.h.notices('stand-up')).toHaveLength(0)
    await sitThrough(morning.h, morning.runtime, early + 69 * MIN, early + 70 * MIN)
    expect(morning.h.notices('stand-up')).toHaveLength(1)
    expect(new Date(morning.h.clock.t).getHours()).toBe(8)
  })

  it('Walnut quiet mode holds it too, and it fires once quiet ends', async () => {
    const { h, runtime } = await boot()
    h.setUserQuiet({ source: 'user', since: NINE, reason: 'Meeting' })
    await sitThrough(h, runtime, NINE, NINE + 65 * MIN)
    expect(h.notices('stand-up')).toHaveLength(0)
    h.setUserQuiet(null)
    await sitThrough(h, runtime, NINE + 65 * MIN, NINE + 66 * MIN)
    expect(h.notices('stand-up')).toHaveLength(1)
  })
})

describe('focus blocks', () => {
  it('a block quiets Walnut, logs to its task, and ends with a stand-up prompt; the break then runs', async () => {
    const { h, runtime } = await boot({ tasks: [task('task-7', 'Draft the plan')] })
    const appendLog = vi.spyOn(h.fake.api.tasks, 'appendLog')
    const started = await actions.focusStart(runtime, { taskId: 'task-7' })
    expect(started.state.focus).toMatchObject({ phase: 'focus', taskId: 'task-7', title: 'Draft the plan', minutes: 25 })
    expect(h.calls).toContainEqual({ type: 'quiet.set', input: { reason: 'Focus block', until: NINE + 25 * MIN } })
    await expect(actions.focusStart(runtime, {})).rejects.toThrow(/already running/)

    await sitThrough(h, runtime, NINE, NINE + 25 * MIN)
    await h.tick(runtime, 1)
    expect(appendLog).toHaveBeenCalledWith('task-7', 'Focus block: 25 min')
    // Quiet is released before the block-done reminder, or Walnut would never show it.
    const cleared = h.calls.findIndex((call) => call.type === 'quiet.clear')
    expect(cleared).toBeGreaterThan(-1)
    expect(cleared).toBeLessThan(h.calls.findIndex((call) => call.type === 'notify' && call.notice.dedupKey === 'focus-done'))
    const done = h.notices('focus-done')
    expect(done).toHaveLength(1)
    expect(done[0]!.notice).toMatchObject({
      title: 'Focus block done, stand up',
      taskId: 'task-7',
      actions: [
        { label: 'Start break', op: 'break_start' },
        { label: 'Skip break', op: 'break_skip' },
        { label: 'Another block', op: 'focus_start', args: { taskId: 'task-7', minutes: 25 } },
      ],
    })
    expect(runtime.day).toMatchObject({ focusMinutes: 25, focusBlocks: [{ minutes: 25, taskId: 'task-7' }] })

    await actions.breakStart(runtime)
    expect(h.feed.has('focus-done')).toBe(false)
    expect(runtime.focus).toMatchObject({ phase: 'break', breakKind: 'short' })
    await h.tick(runtime, 5 * MIN)
    const over = h.notices('break-over')
    expect(over).toHaveLength(1)
    // The block's break keeps its own prompt: the next block, or done for today.
    expect(over[0]!.notice.title).toBe('Break over')
    expect(over[0]!.notice.actions).toEqual([
      { label: 'Start next block', op: 'focus_start', args: { taskId: 'task-7', minutes: 25 } },
      { label: 'Done for today', op: 'focus_stop' },
    ])
    expect(runtime.day).toMatchObject({ focusBreaks: 1, breaksTaken: 1 })
  })

  it('the stand-up reminder stays out of a block, and does not double up with its prompt', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 50 * MIN)
    await actions.focusStart(runtime, {})
    await sitThrough(h, runtime, NINE + 50 * MIN, NINE + 75 * MIN)
    await h.tick(runtime, 1)
    expect(h.notices('focus-done')).toHaveLength(1)
    expect(h.notices('stand-up')).toHaveLength(0)
    await actions.breakSkip(runtime)
    await sitThrough(h, runtime, NINE + 75 * MIN, NINE + 100 * MIN)
    expect(h.notices('stand-up')).toHaveLength(0)
  })

  it('the fourth block earns the long break', async () => {
    const { h, runtime } = await boot({ config: { focus_minutes: 10 } })
    for (let block = 0; block < 4; block++) {
      await actions.focusStart(runtime, {})
      await h.tick(runtime, 10 * MIN + 1)
      if (block < 3) {
        expect(runtime.focus.breakKind).toBe('short')
        await actions.breakSkip(runtime)
      }
    }
    expect(runtime.focus).toMatchObject({ phase: 'break_due', breakKind: 'long', completedInCycle: 0 })
    await actions.breakStart(runtime)
    expect(runtime.focus.endsAt - h.clock.t).toBe(15 * MIN)
  })

  it('an unknown task is refused before anything starts', async () => {
    const { h, runtime } = await boot()
    await expect(actions.focusStart(runtime, { taskId: 'nope' })).rejects.toThrow(/was not found/)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.calls.filter((call) => call.type === 'quiet.set')).toHaveLength(0)
  })

  it('stop ends the block, clears quiet and counts a stopped block', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 30 })
    await h.tick(runtime, 12 * MIN)
    const stopped = await actions.focusStop(runtime)
    expect(stopped.message).toBe('Focus block stopped after 12 min.')
    expect(h.ourHold()).toBeNull()
    expect(runtime.day).toMatchObject({ stoppedBlocks: 1, focusMinutes: 0 })
  })
})

describe('quiet mode and the macOS Focus mirror', () => {
  it('keeps one hold that is the union of a focus block and a macOS Focus', async () => {
    let focus: MacosFocusRead = { ok: true, focus: { active: true, modeId: 'x', name: 'Deep Work' } }
    const { h, runtime } = await boot({ darwin: true, macosFocus: () => focus })
    expect(h.ourHold()).toMatchObject({ reason: 'macOS Focus: Deep Work' })
    expect(h.ourHold()?.until).toBeUndefined()

    await actions.focusStart(runtime, {})
    expect(h.ourHold()).toMatchObject({ reason: 'Focus block, macOS Focus: Deep Work' })
    expect(h.ourHold()?.until).toBeUndefined()

    await h.tick(runtime, 25 * MIN + 1)
    expect(h.ourHold()).toMatchObject({ reason: 'macOS Focus: Deep Work' })
    // The hold dropped the block's part BEFORE the block-done reminder went out.
    const union = h.calls.findIndex((call) => call.type === 'quiet.set' && call.input.reason === 'Focus block, macOS Focus: Deep Work')
    const narrowed = h.calls.findIndex((call, i) => i > union && call.type === 'quiet.set' && call.input.reason === 'macOS Focus: Deep Work')
    const announced = h.calls.findIndex((call) => call.type === 'notify' && call.notice.dedupKey === 'focus-done')
    expect(union).toBeGreaterThan(-1)
    expect(narrowed).toBeGreaterThan(-1)
    expect(narrowed).toBeLessThan(announced)

    focus = { ok: true, focus: { active: false } }
    await h.tick(runtime, 30_000)
    expect(h.ourHold()).toBeNull()
    // Nothing is re-sent while nothing changes.
    const quietCalls = h.calls.filter((call) => call.type.startsWith('quiet')).length
    await h.tick(runtime, 30_000)
    expect(h.calls.filter((call) => call.type.startsWith('quiet')).length).toBe(quietCalls)
  })

  it('a refused Focus read is reported once and backs off; mirror off never reads', async () => {
    let reads = 0
    const { h, runtime } = await boot({ darwin: true, macosFocus: () => { reads++; return { ok: false, reason: 'permission', message: 'denied' } } })
    expect(runtime.macos.mirror).toMatchObject({ phase: 'unavailable', error: 'denied' })
    await h.tick(runtime, 60_000)
    expect(reads).toBe(1)
    await h.tick(runtime, 10 * MIN)
    expect(reads).toBe(2)
    runtime.applyConfig({ mirror_macos_focus: false })
    await h.tick(runtime, 11 * MIN)
    expect(reads).toBe(2)
    expect(runtime.macos.mirror.phase).toBe('off')
  })

  it('a macOS Focus holds the stand-up reminder, and the drive shortcuts follow the block', async () => {
    const { h, runtime } = await boot({
      darwin: true,
      config: { macos_focus_shortcuts: true },
      macosFocus: () => ({ ok: true, focus: { active: true, name: 'Work' } }),
    })
    await sitThrough(h, runtime, NINE, NINE + 65 * MIN)
    expect(h.notices('stand-up')).toHaveLength(0)
    expect(runtime.evaluate(h.clock.t).view.pausedBy).toBe('quiet')

    await actions.focusStart(runtime, {})
    await h.tick(runtime, 25 * MIN + 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shortcutRuns = h.runs.filter((run) => run.command === 'shortcuts' && run.args[0] === 'run').map((run) => run.args[1])
    expect(shortcutRuns).toEqual(['Walnut Focus On', 'Walnut Focus Off'])
  })

  it('the Do Not Disturb that a block turned on never silences the block\'s own prompt', async () => {
    // The mirror keeps reading "on": the real file lags the shortcut by seconds and the
    // poll by up to 25s. That hold used to outlive the block and swallow its toast.
    let macosSaysOn = false
    const { h, runtime } = await boot({
      darwin: true,
      config: { macos_focus_shortcuts: true },
      macosFocus: () => (macosSaysOn ? { ok: true, focus: { active: true, name: 'Do Not Disturb' } } : { ok: true, focus: { active: false } }),
    })
    await actions.focusStart(runtime, {})
    macosSaysOn = true
    await h.tick(runtime, 30_000)
    expect(h.ourHold()).toMatchObject({ reason: 'Focus block, macOS Focus: Do Not Disturb' })

    await h.tick(runtime, 25 * MIN)
    // The block ended: its prompt went out AFTER the hold was released, not under it.
    const prompt = h.calls.findIndex((call) => call.type === 'notify' && call.notice.dedupKey === 'focus-done')
    const released = h.calls.findIndex((call) => call.type === 'quiet.clear')
    expect(prompt).toBeGreaterThan(-1)
    expect(released).toBeGreaterThan(-1)
    expect(released).toBeLessThan(prompt)
    expect(h.ourHold()).toBeNull()

    // macOS really did stay on (the shortcut failed, say): after the grace the mirror wins again.
    await h.tick(runtime, 2 * MIN)
    expect(h.ourHold()).toMatchObject({ reason: 'macOS Focus: Do Not Disturb' })
  })
})

describe('restarts', () => {
  it('a quick restart keeps the streak; a restart after the away threshold starts it over', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 40 * MIN)
    await runtime.persist()

    h.clock.t = NINE + 42 * MIN
    const quick = h.build()
    await quick.load()
    await quick.attention(spansFromBanked(banked(NINE + 42 * MIN, MIN), NINE + 43 * MIN), 'walnut')
    expect(quick.presence.streakStartedAt).toBe(NINE)

    await sitThrough(h, quick, NINE + 43 * MIN, NINE + 61 * MIN)
    expect(h.notices('stand-up')).toHaveLength(1)
    await quick.persist()

    h.clock.t = NINE + 75 * MIN
    const slow = h.build()
    await slow.load()
    expect(slow.presence.streakStartedAt).toBe(0)
    await slow.attention(spansFromBanked(banked(NINE + 75 * MIN, MIN), NINE + 76 * MIN), 'walnut')
    expect(slow.presence.streakStartedAt).toBe(NINE + 75 * MIN)
  })

  it('a restart after the away threshold withdraws a stand-up reminder that was still waiting', async () => {
    const { h, runtime } = await boot()
    await sitThrough(h, runtime, NINE, NINE + 61 * MIN)
    expect(h.feed.has('stand-up')).toBe(true)
    h.clock.t = NINE + 75 * MIN
    const again = h.build()
    await again.load()
    expect(h.feed.has('stand-up')).toBe(false)
    expect(again.reminder.outstanding).toBe(false)
  })

  it('a running focus block survives a restart and still ends on time', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 20 })
    await runtime.persist()
    h.clock.t = NINE + 5 * MIN
    const again = h.build()
    await again.load()
    expect(again.focus).toMatchObject({ phase: 'focus', endsAt: NINE + 20 * MIN })
    await h.tick(again, 15 * MIN)
    expect(h.notices('focus-done')).toHaveLength(1)
  })

  it('the day log is written to days/<date>.json', async () => {
    const { h, runtime } = await boot()
    await actions.breakDone(runtime)
    const files = await h.fake.api.storage.list('days/')
    expect(files).toEqual(['days/2026-09-25.json'])
    expect(await h.fake.api.storage.readJson('days/2026-09-25.json', null)).toMatchObject({ breaksTaken: 1 })
  })
})
