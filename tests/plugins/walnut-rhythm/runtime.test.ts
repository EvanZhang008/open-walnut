/**
 * Rhythm runtime: the pure decisions applied to a fake host on a fake clock. Real
 * timelines, minute by minute: a run the person starts (block, break, the one question
 * after it), quiet mode, a macOS Focus, and restarts.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WalnutTask } from '../../../packages/plugin-api/src/shared.js'
import * as actions from '../../../plugin-store/walnut-rhythm/src/server/actions'
import type { MacosFocusRead } from '../../../plugin-store/walnut-rhythm/src/server/macos-focus'
import { buildPublicState } from '../../../plugin-store/walnut-rhythm/src/server/public-state'
import { makeHarness, MIN } from './harness'

/** 09:00 local. */
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

describe('a run the person starts', () => {
  it('block → break by itself → off, with one notice for each and quiet only during the block', async () => {
    const { h, runtime } = await boot({ tasks: [task('task-7', 'Draft the plan')] })
    const appendLog = vi.spyOn(h.fake.api.tasks, 'appendLog')
    const started = await actions.focusStart(runtime, { taskId: 'task-7' })
    expect(started.state.focus).toMatchObject({ phase: 'focus', taskId: 'task-7', title: 'Draft the plan', minutes: 25, runStartedAt: NINE, endsAt: NINE + 25 * MIN })
    expect(h.calls).toContainEqual({ type: 'quiet.set', input: { reason: 'Focus block', until: NINE + 25 * MIN } })
    await expect(actions.focusStart(runtime, {})).rejects.toThrow(/already running/)

    await h.tick(runtime, 25 * MIN + 1)
    expect(appendLog).toHaveBeenCalledWith('task-7', 'Focus block: 25 min')
    // The break started by itself, at the block's end.
    expect(runtime.focus).toMatchObject({ phase: 'break', breakKind: 'short', startedAt: NINE + 25 * MIN, endsAt: NINE + 30 * MIN, runStartedAt: NINE })
    // Quiet is released before the block-done notice, or Walnut would never show it.
    const cleared = h.calls.findIndex((call) => call.type === 'quiet.clear')
    expect(cleared).toBeGreaterThan(-1)
    expect(cleared).toBeLessThan(h.calls.findIndex((call) => call.type === 'notify' && call.notice.dedupKey === 'focus-done'))
    const done = h.notices('focus-done')
    expect(done).toHaveLength(1)
    expect(done[0]!.notice).toMatchObject({
      title: 'Focus block done, 5 min break',
      body: '25 min on Draft the plan. Stand up and move; the break ends at 09:30.',
      taskId: 'task-7',
      actions: [
        { label: 'End break', op: 'break_skip' },
        { label: 'Another block', op: 'focus_start', args: { taskId: 'task-7', minutes: 25 } },
      ],
    })
    expect(runtime.day).toMatchObject({ focusMinutes: 25, focusBlocks: [{ minutes: 25, taskId: 'task-7' }], focusBreaks: 1 })

    await h.tick(runtime, 5 * MIN)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.feed.has('focus-done')).toBe(false)
    const over = h.notices('break-over')
    expect(over).toHaveLength(1)
    expect(over[0]!.notice.title).toBe('Break over. Start the next block?')
    expect(over[0]!.notice.actions).toEqual([
      { label: 'Start next block', op: 'focus_start', args: { taskId: 'task-7', minutes: 25 } },
      { label: 'Not now', op: 'focus_stop' },
    ])
    expect(buildPublicState(runtime, h.clock.t).focus).toMatchObject({
      phase: 'idle', runStartedAt: null, endsAt: null, lastRun: { startedAt: NINE, endedAt: NINE + 30 * MIN },
    })

    // Not now: still off, the question is gone, nothing else is asked.
    const notNow = await actions.focusStop(runtime)
    expect(notNow.message).toBe('Rhythm is off. It starts when you press Start.')
    expect(h.feed.has('break-over')).toBe(false)
    expect(runtime.day.stoppedBlocks).toBe(0)
  })

  it('Start next block from the question starts the next run on the same task', async () => {
    const { h, runtime } = await boot({ tasks: [task('task-7', 'Draft the plan')] })
    await actions.focusStart(runtime, { taskId: 'task-7', minutes: 10 })
    await h.tick(runtime, 15 * MIN + 1)
    const next = h.notices('break-over')[0]!.notice.actions![0]!
    const again = await actions.focusStart(runtime, next.args ?? {})
    expect(again.state.focus).toMatchObject({ phase: 'focus', taskId: 'task-7', minutes: 10, runStartedAt: h.clock.t })
    expect(h.feed.has('break-over')).toBe(false)
  })

  it('End break turns Rhythm off at once and asks nothing', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, {})
    await h.tick(runtime, 25 * MIN + 1)
    await h.tick(runtime, 2 * MIN)
    const ended = await actions.breakSkip(runtime)
    expect(ended.message).toBe('Break ended. Rhythm is off until you start the next block.')
    expect(runtime.focus.phase).toBe('idle')
    expect(h.feed.size).toBe(0)
    await h.tick(runtime, 30 * MIN)
    expect(h.notices('break-over')).toHaveLength(0)
    expect(ended.state.focus.lastRun).toEqual({ startedAt: NINE, endedAt: NINE + 27 * MIN + 1 })
  })

  it('the fourth block earns the long break, which starts by itself', async () => {
    const { h, runtime } = await boot({ config: { focus_minutes: 10 } })
    for (let block = 0; block < 4; block++) {
      await actions.focusStart(runtime, {})
      await h.tick(runtime, 10 * MIN + 1)
      if (block < 3) {
        expect(runtime.focus).toMatchObject({ phase: 'break', breakKind: 'short' })
        await actions.breakSkip(runtime)
      }
    }
    expect(runtime.focus).toMatchObject({ phase: 'break', breakKind: 'long', completedInCycle: 0 })
    expect(runtime.focus.endsAt - runtime.focus.startedAt).toBe(15 * MIN)
    expect(h.notices('focus-done').at(-1)!.notice.title).toBe('Focus block done, 15 min long break')
  })

  it('an unknown task is refused before anything starts', async () => {
    const { h, runtime } = await boot()
    await expect(actions.focusStart(runtime, { taskId: 'nope' })).rejects.toThrow(/was not found/)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.calls.filter((call) => call.type === 'quiet.set')).toHaveLength(0)
  })

  it('stop ends the block, clears quiet, counts a stopped block and records the run', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 30 })
    await h.tick(runtime, 12 * MIN)
    const stopped = await actions.focusStop(runtime)
    expect(stopped.message).toBe('Focus block stopped after 12 min. Rhythm is off.')
    expect(h.ourHold()).toBeNull()
    expect(runtime.day).toMatchObject({ stoppedBlocks: 1, focusMinutes: 0 })
    expect(stopped.state.focus).toMatchObject({ phase: 'idle', lastRun: { startedAt: NINE, endedAt: NINE + 12 * MIN } })
    expect(h.notices()).toHaveLength(0)
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
    // The hold dropped the block's part BEFORE the block-done notice went out.
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

  it('a macOS Focus starts nothing, and the drive shortcuts follow the block', async () => {
    const { h, runtime } = await boot({
      darwin: true,
      config: { macos_focus_shortcuts: true },
      macosFocus: () => ({ ok: true, focus: { active: true, name: 'Work' } }),
    })
    await h.tick(runtime, 65 * MIN)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.notices()).toHaveLength(0)

    await actions.focusStart(runtime, {})
    await h.tick(runtime, 25 * MIN + 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shortcutRuns = h.runs.filter((run) => run.command === 'shortcuts' && run.args[0] === 'run').map((run) => run.args[1])
    expect(shortcutRuns).toEqual(['Walnut Focus On', 'Walnut Focus Off'])
  })

  it('the Do Not Disturb that a block turned on never silences the block\'s own notice', async () => {
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
  it('a running focus block survives a restart and still ends on time', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 20 })
    await runtime.persist()
    h.clock.t = NINE + 5 * MIN
    const again = h.build()
    await again.load()
    expect(again.focus).toMatchObject({ phase: 'focus', endsAt: NINE + 20 * MIN, runStartedAt: NINE })
    await h.tick(again, 15 * MIN)
    expect(h.notices('focus-done')).toHaveLength(1)
    expect(again.focus.phase).toBe('break')
  })

  it('an older version\'s state: its stand-up streak is dropped, its notices withdrawn, a waiting break becomes a running one', async () => {
    const h = makeHarness({ start: NINE + 27 * MIN })
    await h.fake.api.storage.writeJson('state.json', {
      version: 1,
      presence: { streakStartedAt: NINE - 60 * MIN, lastActiveAt: NINE + 26 * MIN },
      reminder: { streakKey: NINE - 60 * MIN, nextDueAt: null, snoozedUntil: null, deferStartedAt: null, outstanding: true, firedAt: NINE },
      focus: { phase: 'break_due', minutes: 25, startedAt: NINE + 25 * MIN, endsAt: NINE + 55 * MIN, completedInCycle: 1, breakKind: 'short', lastEndedAt: NINE + 25 * MIN },
    })
    const runtime = h.build()
    await runtime.load()
    await runtime.kick()
    expect(h.calls).toContainEqual({ type: 'dismiss', key: 'stand-up' })
    expect(h.calls).toContainEqual({ type: 'dismiss', key: 'focus-done' })
    expect(runtime.focus).toMatchObject({ phase: 'break', startedAt: NINE + 25 * MIN, endsAt: NINE + 30 * MIN, runStartedAt: NINE })
    const stored = await h.fake.api.storage.readJson<Record<string, unknown>>('state.json', {})
    expect(Object.keys(stored).sort()).toEqual(['focus', 'version'])
    await h.tick(runtime, 3 * MIN + 1)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.notices('break-over')).toHaveLength(1)
  })

  it('the day log is written to days/<date>.json', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 10 })
    await h.tick(runtime, 10 * MIN + 1)
    const files = await h.fake.api.storage.list('days/')
    expect(files).toEqual(['days/2026-09-25.json'])
    expect(await h.fake.api.storage.readJson('days/2026-09-25.json', null)).toMatchObject({ focusMinutes: 10, focusBreaks: 1 })
  })
})
