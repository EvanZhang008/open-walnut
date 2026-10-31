/**
 * Rhythm's ring in the rail (src/server/status-item.ts) on a real timeline: every state
 * it can show, reached through the runtime and its ops rather than hand-built state.
 *
 *   off (one Start, no countdown) → focus (blue, drains) → break (green, drains) → off with the last run
 */
import { describe, expect, it } from 'vitest'
import type { WalnutTask } from '../../../packages/plugin-api/src/shared.js'
import * as actions from '../../../plugin-store/walnut-rhythm/src/server/actions'
import { buildPublicState } from '../../../plugin-store/walnut-rhythm/src/server/public-state'
import type { RhythmRuntime } from '../../../plugin-store/walnut-rhythm/src/server/runtime'
import { rhythmStatusItem } from '../../../plugin-store/walnut-rhythm/src/server/status-item'
import { makeHarness, MIN } from './harness'

/** 09:00 local. */
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

describe('the ring', () => {
  it('off: says so, one Start, no countdown', async () => {
    const { runtime } = await boot()
    expect(ring(runtime)).toEqual({
      title: 'Rhythm is off',
      detail: 'Nothing runs or counts until you start a block.',
      tone: 'neutral',
      glyph: 'pause',
      actions: [{ label: 'Start focus block (25 min)', op: 'focus_start', primary: true }],
      app: 'main',
    })
  })

  it('a run: blue with its start and end, green through the break, then off naming the last run', async () => {
    const { h, runtime } = await boot()
    h.clock.t = NINE + 5 * MIN
    await actions.focusStart(runtime, { taskId: 'task-7', minutes: 25 })
    const focus = ring(runtime)!
    expect(focus).toMatchObject({
      title: 'Focus · {remaining} left',
      detail: 'Spec review. Started 09:05, ends 09:30. Walnut is quiet until it ends.',
      tone: 'accent',
      timer: { startedAt: NINE + 5 * MIN, endsAt: NINE + 30 * MIN, mode: 'drain' },
    })
    expect(focus.actions).toEqual([{ label: 'Stop block', op: 'focus_stop' }])

    await h.tick(runtime, 25 * MIN + 1)
    const rest = ring(runtime)!
    expect(rest).toMatchObject({
      title: 'Break · {remaining} left',
      detail: 'Block 09:05 to 09:30. Break ends 09:35, then Rhythm asks before the next block.',
      tone: 'success',
      timer: { startedAt: NINE + 30 * MIN, endsAt: NINE + 35 * MIN, mode: 'drain' },
    })
    expect(rest.actions).toEqual([{ label: 'End break', op: 'break_skip' }])

    await h.tick(runtime, 5 * MIN)
    expect(ring(runtime)).toMatchObject({
      title: 'Rhythm is off',
      detail: 'Last run 09:05 to 09:35. Nothing runs until you start a block.',
      glyph: 'pause',
      actions: [{ label: 'Start focus block (25 min)', op: 'focus_start', primary: true }],
    })
    expect(ring(runtime)!.timer).toBeUndefined()
  })

  it('names the long break, and says nothing about quiet when a block does not quiet Walnut', async () => {
    const { h, runtime } = await boot({ focus_quiets_walnut: false, long_break_every: 1 })
    await actions.focusStart(runtime, {})
    expect(ring(runtime)).toMatchObject({ detail: 'Started 09:00, ends 09:25.' })
    await h.tick(runtime, 25 * MIN + 1)
    expect(ring(runtime)).toMatchObject({ title: 'Long break · {remaining} left' })
  })

  it('every state it can publish passes the host limits', async () => {
    const { h, runtime } = await boot()
    const seen: Array<ReturnType<typeof rhythmStatusItem>> = []
    const take = () => seen.push(ring(runtime))
    take()
    await actions.focusStart(runtime, { taskId: 'task-7', minutes: 180 }); take()
    await h.tick(runtime, 180 * MIN + 1); take()
    await actions.breakSkip(runtime); take()
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
