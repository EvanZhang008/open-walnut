/**
 * The person's choices once a run is live (2026-11-01, the user: rest early, extend, and
 * start with Focus or with Rest, "this is the user's choice"): Rest now during a block,
 * Rest from off, Extend a block or a break, Focus now during a break. Quiet and Mac Do
 * Not Disturb follow whichever phase is live, and a longer block moves macOS's own end
 * time. macOS is the harness's fake Focus store.
 */
import { describe, expect, it } from 'vitest'
import * as actions from '../../../plugin-store/walnut-rhythm/src/server/actions'
import { NO_END } from '../../../plugin-store/walnut-rhythm/src/server/dnd-words'
import { DND_MODE_ID } from '../../../plugin-store/walnut-rhythm/src/server/macos-dnd'
import { SHORTCUT_OFF, SHORTCUT_ON } from '../../../plugin-store/walnut-rhythm/src/server/macos-shortcuts'
import { buildPublicState } from '../../../plugin-store/walnut-rhythm/src/server/public-state'
import { rhythmStatusItem } from '../../../plugin-store/walnut-rhythm/src/server/status-item'
import { dndRowView, dndSetupText } from '../../../plugin-store/walnut-rhythm/src/web/dnd-model'
import { makeHarness, MIN } from './harness'

const NINE = new Date(2026, 10, 1, 9, 0).getTime()

async function boot(config: Record<string, unknown> = { macos_focus_shortcuts: true }) {
  const h = makeHarness({ start: NINE, darwin: true, config })
  const runtime = h.build()
  await runtime.load()
  await runtime.kick()
  return { h, runtime }
}

const runsOf = (h: ReturnType<typeof makeHarness>) => h.runs.filter((run) => run.command === 'shortcuts' && run.args[0] === 'run').map((run) => run.args[1])
const dndLive = (h: ReturnType<typeof makeHarness>) => h.mac.live.filter((one) => one.modeId === DND_MODE_ID && (one.endsAt === undefined || one.endsAt > h.clock.t))
const ourHold = (h: ReturnType<typeof makeHarness>) => h.calls.filter((call) => call.type === 'quiet.set' || call.type === 'quiet.clear').pop()

describe('Rest now during a block', () => {
  it('the block ends here, its break starts, and quiet and Do Not Disturb go with the block', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 40, breakMinutes: 8 })
    await runtime.dnd.settled()
    expect(dndLive(h)).toHaveLength(1)
    h.clock.t += 12 * MIN
    const rested = await actions.focusRest(runtime, {})
    await runtime.dnd.settled()
    expect(rested.message).toBe('Block ended early. Rest for 8 min, until 09:20.')
    expect(runtime.focus).toMatchObject({ phase: 'break', breakKind: 'short', startedAt: NINE + 12 * MIN, endsAt: NINE + 20 * MIN })
    expect(ourHold(h)).toEqual({ type: 'quiet.clear' })
    expect(runsOf(h)).toEqual([SHORTCUT_ON, SHORTCUT_OFF])
    expect(dndLive(h)).toEqual([])
    // Logged for the time it ran, not counted toward the long break, and no "block done" notice.
    expect(runtime.day.focusBlocks).toEqual([{ at: NINE + 12 * MIN, minutes: 12 }])
    expect(runtime.focus.completedInCycle).toBe(0)
    expect(h.notices('focus-done')).toHaveLength(0)
    // The break ends with the one question, as after any break.
    await h.tick(runtime, 8 * MIN + 1)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.notices('break-over')).toHaveLength(1)
  })

  it('takes a length, and the start op takes mode rest the same way', async () => {
    const { runtime } = await boot({ macos_focus_shortcuts: false })
    await actions.focusStart(runtime, { minutes: 25 })
    await actions.focusStart(runtime, { mode: 'rest', minutes: 3 })
    expect(runtime.focus).toMatchObject({ phase: 'break', endsAt: NINE + 3 * MIN })
    await expect(actions.focusStart(runtime, { mode: 'nap' })).rejects.toThrow(/mode is "focus" or "rest"/)
  })
})

describe('Rest from off', () => {
  it('a rest of its own: no quiet, no Do Not Disturb, and it asks about a block when it ends', async () => {
    const { h, runtime } = await boot()
    const rested = await actions.focusRest(runtime, { minutes: 10 })
    await runtime.dnd.settled()
    expect(rested.message).toBe('Rest started: 10 min, until 09:10. Then Rhythm asks about the next block.')
    expect(runtime.focus).toMatchObject({ phase: 'break', runStartedAt: NINE, endsAt: NINE + 10 * MIN })
    expect(h.calls.filter((call) => call.type === 'quiet.set')).toHaveLength(0)
    expect(runsOf(h)).toEqual([])
    expect(runtime.day.focusBlocks).toEqual([])
    await h.tick(runtime, 10 * MIN + 1)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.notices('break-over')).toHaveLength(1)
  })

  it('the ring names it a break with no block before it', async () => {
    const { runtime } = await boot({ macos_focus_shortcuts: false })
    await actions.focusRest(runtime, { minutes: 10 })
    const ring = rhythmStatusItem(buildPublicState(runtime, runtime.now()))!
    expect(ring).toMatchObject({ title: 'Break · {remaining} left', detail: 'Break ends 09:10, then Rhythm asks before the next block.' })
    expect(ring.actions?.map((action) => action.label)).toEqual(['Focus now', '+5 min break', 'End break'])
  })

  it('is refused during a break, where +5 min break is the way to rest longer', async () => {
    const { runtime } = await boot({ macos_focus_shortcuts: false })
    await actions.focusRest(runtime, {})
    await expect(actions.focusRest(runtime, {})).rejects.toThrow(/already running/)
  })
})

describe('Extend', () => {
  it('a block runs longer: quiet holds to the new end, and macOS\'s own end time moves with it', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    h.clock.t += 20 * MIN
    const more = await actions.focusExtend(runtime, { minutes: 10 })
    await runtime.dnd.settled()
    expect(more.message).toBe('The block runs 10 min more, until 09:35.')
    expect(runtime.focus).toMatchObject({ phase: 'focus', endsAt: NINE + 35 * MIN, minutes: 25 })
    expect(runsOf(h)).toEqual([SHORTCUT_ON, SHORTCUT_ON])
    expect(h.mac.input).toBe('2026-11-01 09:35:00')
    expect(runtime.dnd.record).toMatchObject({ status: 'on', until: NINE + 35 * MIN, assertionId: 'dnd-2' })
    // Past the first end, Do Not Disturb is still on; at the new end the block completes as one 35 min block.
    await h.tick(runtime, 6 * MIN)
    expect(dndLive(h).map((one) => one.id)).toEqual(['dnd-2'])
    expect(runtime.quietState.active).toBe(true)
    expect(ourHold(h)).toMatchObject({ type: 'quiet.set', input: { reason: expect.stringContaining('Focus block') } })
    await h.tick(runtime, 10 * MIN)
    await runtime.dnd.settled()
    expect(runtime.focus.phase).toBe('break')
    expect(dndLive(h)).toEqual([])
    expect(runtime.day.focusBlocks).toEqual([expect.objectContaining({ minutes: 35 })])
    expect(runtime.quietState.active).toBe(false)
  })

  it('without Do Not Disturb, the quiet hold\'s own end moves to the block\'s new end', async () => {
    const { h, runtime } = await boot({ macos_focus_shortcuts: false })
    await actions.focusStart(runtime, { minutes: 25 })
    await actions.focusExtend(runtime, { minutes: 10 })
    expect(ourHold(h)).toEqual({ type: 'quiet.set', input: { reason: 'Focus block', until: NINE + 35 * MIN } })
  })

  it('macOS keeps its first end time: said once, never retried every step', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    h.mac.silentOn = true
    await actions.focusExtend(runtime, { minutes: 5 })
    await runtime.dnd.settled()
    expect(runtime.dnd.record).toMatchObject({ status: 'on', until: NINE + 25 * MIN, error: expect.stringMatching(/still ends at .*first end/) })
    await h.tick(runtime, MIN)
    await h.tick(runtime, MIN)
    await runtime.dnd.settled()
    expect(runsOf(h)).toEqual([SHORTCUT_ON, SHORTCUT_ON])
    expect(dndRowView(buildPublicState(runtime, h.clock.t))).toMatchObject({ tone: 'warn', action: 'off' })
  })

  it('a break runs longer; Extend while off is refused and starts nothing', async () => {
    const { runtime } = await boot({ macos_focus_shortcuts: false })
    await expect(actions.focusExtend(runtime, {})).rejects.toThrow(/Nothing is running/)
    expect(runtime.focus.phase).toBe('idle')
    await actions.focusRest(runtime, { minutes: 5 })
    const more = await actions.focusExtend(runtime, {})
    expect(more.message).toBe('The break runs 5 min more, until 09:10.')
    expect(runtime.focus).toMatchObject({ phase: 'break', endsAt: NINE + 10 * MIN })
  })
})

describe('Focus now during a break', () => {
  it('the next block starts at once, with quiet and Do Not Disturb again', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    await h.tick(runtime, 25 * MIN + 1)
    await runtime.dnd.settled()
    expect(runtime.focus.phase).toBe('break')
    expect(dndLive(h)).toEqual([])
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    expect(runtime.focus).toMatchObject({ phase: 'focus', completedInCycle: 1 })
    expect(ourHold(h)).toMatchObject({ type: 'quiet.set', input: { reason: 'Focus block' } })
    expect(dndLive(h)).toHaveLength(1)
  })
})

describe('an older copy of the shortcut', () => {
  it('Do Not Disturb with no end time: still Rhythm\'s to turn off, and the App says how to replace it', async () => {
    const { h, runtime } = await boot()
    h.mac.ignoreInput = true
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    expect(runtime.dnd.record).toMatchObject({ status: 'on', noEnd: true, error: NO_END })
    const state = buildPublicState(runtime, h.clock.t)
    expect(dndSetupText(state)).toEqual({ text: NO_END, tone: 'warn', step: null })
    await h.tick(runtime, 25 * MIN + 1)
    await runtime.dnd.settled()
    expect(dndLive(h)).toEqual([])
    expect(runsOf(h)).toEqual([SHORTCUT_ON, SHORTCUT_OFF])
    expect(runtime.dnd.record?.shortcut).toBe(SHORTCUT_ON)
    // Deleted in Shortcuts: the App's next step is Add shortcuts.
    h.mac.shortcuts = [SHORTCUT_OFF]
    await actions.status(runtime, { refresh: true })
    expect(dndSetupText(buildPublicState(runtime, h.clock.t)).step).toBe('add')
  })
})

describe('a record an older Rhythm wrote', () => {
  it('a block that ran the old no-end shortcut does not warn about today\'s shortcut', async () => {
    const { h, runtime } = await boot()
    await h.fake.api.storage.writeJson('state.json', {
      version: 1, focus: runtime.focus,
      dnd: { block: NINE - 60 * MIN, until: NINE - MIN, status: 'off', at: NINE - MIN, assertionId: 'old', ranAt: NINE - 60 * MIN, noEnd: true, error: NO_END },
    })
    const again = h.build()
    await again.load()
    await again.kick()
    expect(again.dnd.record).toMatchObject({ noEnd: true })
    expect(again.dnd.record?.shortcut).toBeUndefined()
    expect(dndSetupText(buildPublicState(again, h.clock.t)).text).not.toBe(NO_END)
  })
})

/** Wait until the Do Not Disturb chain is empty, steps it queued while running included. */
async function drain(runtime: Awaited<ReturnType<typeof boot>>['runtime']): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await runtime.dnd.settled()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('macOS takes its time (each shortcut run is a real wait)', () => {
  it('turning off fails: said, kept, tried again a few times, and the Mac is never reported quiet-free', async () => {
    const { h, runtime } = await boot()
    h.mac.delayMs = 20
    await actions.focusStart(runtime, { minutes: 25 })
    await drain(runtime)
    h.mac.failOff = true
    await actions.focusStop(runtime)
    await drain(runtime)
    expect(runtime.dnd.record).toMatchObject({ status: 'failed', stillOn: true, offTries: 1, error: expect.stringMatching(/may still be on/) })
    expect(dndLive(h)).toHaveLength(1)
    // Shown while Rhythm is off, with a way to try again.
    expect(dndRowView(buildPublicState(runtime, h.clock.t))).toMatchObject({ tone: 'error', action: 'off' })
    // Each step tries once more, up to the limit, and then only says so.
    for (let i = 0; i < 4; i++) { await h.tick(runtime, 30_000); await drain(runtime) }
    expect(runtime.dnd.record).toMatchObject({ status: 'failed', stillOn: true, offTries: 3 })
    expect(runsOf(h).filter((name) => name === SHORTCUT_OFF)).toHaveLength(3)
    // The person's Turn off works with no block running.
    h.mac.failOff = false
    const off = await actions.focusDnd(runtime, { on: false })
    expect(off.message).toBe('Do Not Disturb is off.')
    expect(dndLive(h)).toEqual([])
    expect(runtime.dnd.record).toMatchObject({ status: 'off' })
    expect(runtime.dnd.record?.stillOn).toBeUndefined()
  })

  it('Rest now while macOS is still turning on, then Focus now: the first block\'s Do Not Disturb goes, the new block gets its own', async () => {
    const { h, runtime } = await boot()
    h.mac.delayMs = 30
    await actions.focusStart(runtime, { minutes: 25 })
    await actions.focusRest(runtime, {})
    h.clock.t += 1000
    await actions.focusStart(runtime, { minutes: 25 })
    await drain(runtime)
    const block = runtime.focus.startedAt
    expect(runtime.dnd.record).toMatchObject({ status: 'on', block })
    expect(dndLive(h).map((one) => one.id)).toEqual([runtime.dnd.record!.assertionId])
    await actions.focusStop(runtime)
    await drain(runtime)
    expect(dndLive(h)).toEqual([])
  })

  it('Extend while macOS is still turning on: macOS ends it at the new end', async () => {
    const { h, runtime } = await boot()
    h.mac.delayMs = 20
    void actions.focusStart(runtime, { minutes: 25 })
    await actions.focusExtend(runtime, { minutes: 10 })
    await drain(runtime)
    expect(runtime.dnd.record).toMatchObject({ status: 'on', until: NINE + 35 * MIN })
    // One run when the Extend landed before the shortcut ran, a second (the move) when it landed during it.
    expect(runsOf(h).length).toBeLessThanOrEqual(2)
    expect(runsOf(h).every((name) => name === SHORTCUT_ON)).toBe(true)
    expect(h.mac.input).toBe('2026-11-01 09:35:00')
    expect(dndLive(h).find((one) => one.id === runtime.dnd.record!.assertionId)?.endsAt).toBe(NINE + 35 * MIN)
  })

  it('a copy that sets no end time is not moved by Extend; Rhythm turns it off at the end', async () => {
    const { h, runtime } = await boot()
    h.mac.ignoreInput = true
    await actions.focusStart(runtime, { minutes: 25 })
    await drain(runtime)
    await actions.focusExtend(runtime, { minutes: 10 })
    await drain(runtime)
    expect(runsOf(h)).toEqual([SHORTCUT_ON])
    await h.tick(runtime, 35 * MIN + 1)
    await drain(runtime)
    expect(dndLive(h)).toEqual([])
    expect(runsOf(h)).toEqual([SHORTCUT_ON, SHORTCUT_OFF])
  })

  it('a restart in the middle of turning off, the block still running: the off finishes', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25 })
    await drain(runtime)
    const record = runtime.dnd.record!
    await h.fake.api.storage.writeJson('state.json', { version: 1, focus: runtime.focus, dnd: { ...record, status: 'turning-off' } })
    const again = h.build()
    await again.load()
    await again.kick()
    await drain(again)
    expect(again.dnd.record).toMatchObject({ status: 'off' })
    expect(dndLive(h)).toEqual([])
  })

  it('an assertion past its end that macOS has not cleared yet is not a Focus that is on', async () => {
    const { h, runtime } = await boot()
    h.mac.stale = [{ id: 'old', modeId: 'com.apple.focus.work', startedAt: NINE - 60 * MIN, endsAt: NINE - MIN }]
    await actions.focusStart(runtime, { minutes: 25 })
    await drain(runtime)
    expect(runtime.dnd.record).toMatchObject({ status: 'on' })
  })
})
