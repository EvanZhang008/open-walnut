/**
 * A focus block turns macOS Do Not Disturb on for exactly its length, and Rhythm only
 * ever turns off the Do Not Disturb it turned on itself. Every path a block can end by
 * (on time, Stop, a restart of Walnut in the middle, ending while Walnut was down), the
 * person's own Focus, and every way it can fail. macOS is the harness's fake Focus
 * store; no real `shortcuts` runs and no ~/Library file is read.
 */
import { describe, expect, it } from 'vitest'
import * as actions from '../../../plugin-store/walnut-rhythm/src/server/actions'
import { DND_MODE_ID, findStarted, untilInput } from '../../../plugin-store/walnut-rhythm/src/server/macos-dnd'
import { parseLiveAssertions } from '../../../plugin-store/walnut-rhythm/src/server/macos-focus'
import { buildShortcutPlistXml, ensureShortcuts, LEGACY_SHORTCUT_ON, SHORTCUT_OFF, SHORTCUT_ON } from '../../../plugin-store/walnut-rhythm/src/server/macos-shortcuts'
import { buildPublicState } from '../../../plugin-store/walnut-rhythm/src/server/public-state'
import { dndRowView, dndSetupText } from '../../../plugin-store/walnut-rhythm/src/web/dnd-model'
import { makeHarness, MIN } from './harness'

const NINE = new Date(2026, 10, 1, 9, 0).getTime()

async function boot(config: Record<string, unknown> = { macos_focus_shortcuts: true }, start = NINE) {
  const h = makeHarness({ start, darwin: true, config })
  const runtime = h.build()
  await runtime.load()
  await runtime.kick()
  return { h, runtime }
}

const runsOf = (h: ReturnType<typeof makeHarness>) => h.runs.filter((run) => run.command === 'shortcuts' && run.args[0] === 'run').map((run) => run.args[1])
const dndLive = (h: ReturnType<typeof makeHarness>) => h.mac.live.filter((one) => one.modeId === DND_MODE_ID && (one.endsAt === undefined || one.endsAt > h.clock.t))

describe('a block turns Do Not Disturb on until it ends', () => {
  it('on at Start, with the block\'s end as macOS\'s own end time', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 40 })
    await runtime.dnd.settled()
    expect(runsOf(h)).toEqual([SHORTCUT_ON])
    expect(h.mac.input).toBe(untilInput(NINE + 40 * MIN))
    expect(h.mac.input).toBe('2026-11-01 09:40:00')
    expect(runtime.dnd.record).toMatchObject({ status: 'on', block: NINE, until: NINE + 40 * MIN, assertionId: 'dnd-1' })
    expect(dndLive(h)[0]!.endsAt).toBe(NINE + 40 * MIN)
    expect(buildPublicState(runtime, h.clock.t).dnd).toMatchObject({ available: true, record: { status: 'on' } })
  })

  it('ending on time: macOS ended it itself, Rhythm runs nothing more', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    await h.tick(runtime, 25 * MIN + 1)
    await runtime.dnd.settled()
    expect(dndLive(h)).toEqual([])
    expect(runsOf(h)).toEqual([SHORTCUT_ON])
    expect(runtime.dnd.record).toMatchObject({ status: 'off' })
  })

  it('Stop ends it at once', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    h.clock.t += 7 * MIN
    await actions.focusStop(runtime)
    await runtime.dnd.settled()
    expect(runsOf(h)).toEqual([SHORTCUT_ON, SHORTCUT_OFF])
    expect(dndLive(h)).toEqual([])
    expect(runtime.dnd.record).toMatchObject({ status: 'off' })
  })

  it('Stop while macOS is still turning it on: on, then off, nothing left on', async () => {
    const { h, runtime } = await boot()
    void actions.focusStart(runtime, { minutes: 25 })
    await actions.focusStop(runtime)
    await runtime.dnd.settled()
    await runtime.dnd.settled()
    expect(dndLive(h)).toEqual([])
    expect(runtime.dnd.record?.status === 'off' || runtime.dnd.record === null).toBe(true)
  })

  it('the setting off: Start leaves macOS alone; the block\'s own pick wins either way', async () => {
    const off = await boot({ macos_focus_shortcuts: false })
    await actions.focusStart(off.runtime, {})
    await off.runtime.dnd.settled()
    expect(runsOf(off.h)).toEqual([])
    await actions.focusStop(off.runtime)
    await actions.focusStart(off.runtime, { dnd: true })
    await off.runtime.dnd.settled()
    expect(runsOf(off.h)).toEqual([SHORTCUT_ON])

    const on = await boot()
    await actions.focusStart(on.runtime, { dnd: false })
    await on.runtime.dnd.settled()
    expect(runsOf(on.h)).toEqual([])
  })

  it('the popover switch turns it off and on again for this block only', async () => {
    const { h, runtime } = await boot({ macos_focus_shortcuts: false })
    await expect(actions.focusDnd(runtime, { on: true })).rejects.toThrow(/No focus block is running/)
    await actions.focusStart(runtime, { minutes: 30 })
    const on = await actions.focusDnd(runtime, { on: true })
    expect(on.message).toMatch(/^Do Not Disturb is on until/)
    expect(dndLive(h)).toHaveLength(1)
    const off = await actions.focusDnd(runtime, { on: false })
    expect(off.message).toBe('Do Not Disturb is off.')
    expect(dndLive(h)).toEqual([])
    await actions.focusDnd(runtime, { on: true })
    expect(runtime.dnd.record).toMatchObject({ status: 'on', assertionId: 'dnd-2' })
  })
})

describe('the person\'s own Focus is never touched', () => {
  it('a Focus already on: left as it is, and nothing runs at the end', async () => {
    const { h, runtime } = await boot()
    h.mac.live.push({ id: 'theirs', modeId: 'com.apple.focus.work', startedAt: NINE - 5 * MIN, endsAt: NINE + 45 * MIN })
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    expect(runtime.dnd.record).toMatchObject({ status: 'left-alone', focusName: 'Work' })
    await actions.focusStop(runtime)
    await runtime.dnd.settled()
    expect(runsOf(h)).toEqual([])
    expect(h.mac.live.map((one) => one.id)).toEqual(['theirs'])
  })

  it('the person turned Rhythm\'s off and their own Do Not Disturb on: Stop leaves theirs', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    h.mac.live = [{ id: 'their-own-dnd', modeId: DND_MODE_ID, startedAt: NINE + 3 * MIN }]
    h.clock.t += 5 * MIN
    await actions.focusStop(runtime)
    await runtime.dnd.settled()
    expect(runsOf(h)).toEqual([SHORTCUT_ON])
    expect(h.mac.live.map((one) => one.id)).toEqual(['their-own-dnd'])
  })
})

describe('restarts', () => {
  it('Walnut restarts mid-block: the new run still knows which Do Not Disturb is Rhythm\'s', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    await runtime.persist()
    h.clock.t += 10 * MIN
    const again = h.build()
    await again.load()
    await again.kick()
    expect(again.dnd.record).toMatchObject({ status: 'on', assertionId: 'dnd-1' })
    await actions.focusStop(again)
    await again.dnd.settled()
    expect(dndLive(h)).toEqual([])
  })

  it('the block ended while Walnut was down: macOS already ended it, and the boot runs nothing', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    await runtime.persist()
    h.clock.t += 3 * 60 * MIN
    const again = h.build()
    await again.load()
    await again.kick()
    await again.dnd.settled()
    expect(dndLive(h)).toEqual([])
    expect(runsOf(h)).toEqual([SHORTCUT_ON])
    expect(again.dnd.record).toMatchObject({ status: 'off' })
  })

  it('Walnut stopped while the shortcut ran: the next boot finds what it turned on', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25, dnd: false })
    // As if the process died right after `shortcuts run` started macOS's Do Not Disturb.
    h.mac.live.push({ id: 'dnd-mid', modeId: DND_MODE_ID, startedAt: NINE + 1000, endsAt: NINE + 25 * MIN })
    await h.fake.api.storage.writeJson('state.json', { version: 1, focus: runtime.focus, dnd: { block: NINE, until: NINE + 25 * MIN, status: 'turning-on', ranAt: NINE, at: NINE } })
    const again = h.build()
    await again.load()
    await again.kick()
    await again.dnd.settled()
    expect(again.dnd.record).toMatchObject({ status: 'on', assertionId: 'dnd-mid' })
  })
})

describe('when it cannot, it says so plainly', () => {
  it('the shortcuts are not added: no run, and the words say the one-time step', async () => {
    const { h, runtime } = await boot()
    h.mac.shortcuts = [LEGACY_SHORTCUT_ON]
    await actions.focusStart(runtime, {})
    await runtime.dnd.settled()
    expect(runsOf(h)).toEqual([])
    expect(runtime.dnd.record).toMatchObject({ status: 'failed', error: expect.stringMatching(/not added yet.*Add shortcuts/) })
    const state = buildPublicState(runtime, h.clock.t)
    expect(state.macos.shortcuts.legacy).toBe(true)
    expect(dndRowView(state)).toMatchObject({ tone: 'error', action: null })
    expect(dndSetupText(state)).toMatchObject({ step: 'add', tone: 'warn' })
  })

  it('macOS keeps the Focus state private: nothing is turned on blind', async () => {
    const { h, runtime } = await boot()
    h.mac.denied = true
    await actions.focusStart(runtime, {})
    await runtime.dnd.settled()
    expect(runsOf(h)).toEqual([])
    expect(runtime.dnd.record).toMatchObject({ status: 'failed', error: expect.stringMatching(/Full Disk Access/) })
  })

  it('the shortcut fails, or runs and macOS starts nothing', async () => {
    const a = await boot()
    a.h.mac.failOn = true
    await actions.focusStart(a.runtime, {})
    await a.runtime.dnd.settled()
    expect(a.runtime.dnd.record).toMatchObject({ status: 'failed', error: 'The shortcut did not run: The shortcut could not be found' })
    expect(dndRowView(buildPublicState(a.runtime, a.h.clock.t))).toMatchObject({ text: expect.stringMatching(/^Mac Do Not Disturb did not turn on\./), action: 'on' })

    const b = await boot()
    b.h.mac.silentOn = true
    await actions.focusStart(b.runtime, {})
    await b.runtime.dnd.settled()
    expect(b.runtime.dnd.record).toMatchObject({ status: 'failed', error: 'The shortcut ran, but macOS did not turn Do Not Disturb on.' })
  })

  it('turning off fails: said, with when macOS ends it by itself', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25 })
    await runtime.dnd.settled()
    h.mac.failOff = true
    await actions.focusStop(runtime)
    await runtime.dnd.settled()
    expect(runtime.dnd.record).toMatchObject({ status: 'failed', error: expect.stringMatching(/may still be on.*by itself/) })
  })
})

describe('the setting', () => {
  it('the App switch keeps it in the settings', async () => {
    const { h, runtime } = await boot({ macos_focus_shortcuts: false })
    const on = await actions.dndSetting(runtime, { on: true })
    expect(on.state.config.macosFocusShortcuts).toBe(true)
    expect(await h.fake.api.config.get()).toMatchObject({ macos_focus_shortcuts: true })
    const off = await actions.dndSetting(runtime, { on: false })
    expect(off.message).toMatch(/^Off\./)
  })
})

describe('parsing macOS and the shortcut', () => {
  it('reads every live assertion with its end time, in epoch ms', () => {
    const live = parseLiveAssertions({
      data: [{
        storeAssertionRecords: [{
          assertionUUID: 'F7E7',
          assertionStartDateTimestamp: 815257175.798883,
          assertionDetails: {
            assertionDetailsModeIdentifier: 'com.apple.donotdisturb.mode.default',
            assertionDetailsLifetime: { assertionDetailsDateIntervalLifetimeEndDateTimestamp: 815259874.795902, assertionDetailsLifetimeType: 'date-interval' },
          },
        }, { assertionUUID: 'U', assertionStartDateTimestamp: 1, assertionDetails: {} }],
      }],
    })
    expect(live).toEqual([
      { id: 'U', startedAt: 978_307_201_000 },
      { id: 'F7E7', modeId: DND_MODE_ID, startedAt: 1_793_564_375_799, endsAt: 1_793_567_074_796 },
    ])
    expect(findStarted(live, 1_793_564_378_000)?.id).toBe('F7E7')
    expect(findStarted(live, 1_793_564_390_000)).toBeUndefined()
  })

  it('the on shortcut is Do Not Disturb until the date in its input (the shape verified on macOS 26); off is one Set Focus off', () => {
    const on = buildShortcutPlistXml(SHORTCUT_ON)
    expect(on).toMatch(/<key>AssertionType<\/key>\s*<string>Time<\/string>/)
    // The time is a text token holding the input; a bare attachment is dropped by macOS on import.
    expect(on).toMatch(/<key>Time<\/key>\s*<dict>\s*<key>Value<\/key>\s*<dict>\s*<key>string<\/key>\s*<string>\uFFFC<\/string>/)
    expect(on).toContain('<string>ExtensionInput</string>')
    expect(on).toContain('<string>WFTextTokenString</string>')
    const off = buildShortcutPlistXml(SHORTCUT_OFF)
    expect(off).toMatch(/<key>Enabled<\/key>\s*<integer>0<\/integer>/)
    expect(off).not.toContain('ExtensionInput')
  })

  it('an older "Walnut Focus On" does not count as installed, and is named for removal', async () => {
    const run = async () => ({ ok: true, code: 0, stdout: `${LEGACY_SHORTCUT_ON}\n${SHORTCUT_OFF}\n`, stderr: '' })
    expect(await ensureShortcuts(run)).toEqual({ checked: true, installed: { on: false, off: true }, missing: [SHORTCUT_ON], legacy: true })
  })
})
