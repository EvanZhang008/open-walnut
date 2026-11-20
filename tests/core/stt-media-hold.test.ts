/**
 * Voice input's media hold (src/core/stt/media-hold.ts), against a pretend player.
 *
 * Contract under test (the user, 2026-11-20: "when the voice to text, make sure the music
 * is paused, and afterward it is restarted, default on, can be turned off"):
 *   - setting on: a hold pauses what plays; its end plays again ONLY what Walnut paused.
 *   - setting off: neither a pause nor a resume reaches the player.
 *   - nothing playing: nothing is resumed afterwards.
 *   - the person played it again (or played something else) mid-dictation: left alone.
 *   - overlapping holds: the music comes back after the LAST one.
 *   - a hold that stops being renewed ends (a crashed window), and none outlives HOLD_MAX_MS.
 *   - a renew that lands after its release starts nothing.
 *   - a release while the pause is still on its way still ends with the music back.
 *   - a restart mid-dictation reads back what was paused and plays it again after one TTL;
 *     a pause read back from long ago is dropped, never played hours later.
 *   - off the Mac / on an isolated server (no controller) holds still tell the windows.
 * No real player is touched anywhere here: the controller is a stub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('stt-media-hold-test'))

import { MediaHold, HOLD_TTL_MS, HOLD_MAX_MS, RESTORE_MAX_AGE_MS } from '../../src/core/stt/media-hold.js'
import { fakeMediaController, pauseMediaEnabled } from '../../src/core/stt/media-hold-runtime.js'
import type { MediaController } from '../../src/core/stt/media-control.js'

let clock = 1_000_000
const now = () => clock
let dir: string
let holds: MediaHold[] = []

function make(opts: { enabled?: boolean; controller?: MediaController | null; file?: string | null; emit?: (a: boolean) => void } = {}) {
  const fake = fakeMediaController()
  const controller = opts.controller === undefined ? fake.controller : opts.controller
  const events: boolean[] = []
  const hold = new MediaHold({
    controller: () => controller,
    enabled: async () => opts.enabled ?? true,
    emit: opts.emit ?? ((a) => events.push(a)),
    file: opts.file ?? null,
    now,
  })
  holds.push(hold)
  return { hold, fake, events }
}

beforeEach(() => {
  clock = 1_000_000
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-hold-'))
})
afterEach(() => {
  for (const h of holds) h.dispose()
  holds = []
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the setting', () => {
  it('is on unless turned off', () => {
    expect(pauseMediaEnabled({})).toBe(true)
    expect(pauseMediaEnabled({ stt: {} })).toBe(true)
    expect(pauseMediaEnabled({ stt: { pause_media: true } })).toBe(true)
    expect(pauseMediaEnabled({ stt: { pause_media: false } })).toBe(false)
  })
})

describe('media hold', () => {
  it('on: a hold pauses what plays, and its end plays exactly that again', async () => {
    const { hold, fake, events } = make()
    const view = await hold.hold('web-aaaaaa', 'mic')
    expect(view).toMatchObject({ enabled: true, active: true, paused: ['Fake Player'] })
    expect(fake.calls).toEqual(['pause'])
    expect(fake.state.playing).toBe(false)
    const after = await hold.release('web-aaaaaa')
    expect(after).toMatchObject({ active: false, paused: [] })
    expect(fake.calls).toEqual(['pause', 'resume'])
    expect(fake.state.playing).toBe(true)
    expect(events).toEqual([true, false])
  })

  it('off: neither a pause nor a resume reaches the player', async () => {
    const { hold, fake, events } = make({ enabled: false })
    const view = await hold.hold('web-aaaaaa', 'mic')
    expect(view).toMatchObject({ enabled: false, active: false })
    await hold.release('web-aaaaaa')
    await hold.idle()
    expect(fake.calls).toEqual([])
    expect(fake.state.playing).toBe(true)
    expect(events).toEqual([])
  })

  it('nothing playing at the start: nothing is resumed afterwards', async () => {
    const { hold, fake } = make()
    fake.state.playing = false
    await hold.hold('web-aaaaaa', 'mic')
    await hold.release('web-aaaaaa')
    expect(fake.calls).toEqual(['pause'])
    expect(fake.state.playing).toBe(false)
  })

  it('the person played it again mid-dictation: the end leaves it alone', async () => {
    const { hold, fake } = make()
    await hold.hold('web-aaaaaa', 'mic')
    fake.state.playing = true // pressed play in Spotify
    clock += 5_000
    await hold.hold('web-aaaaaa', 'mic') // the renew looks
    expect(fake.calls).toEqual(['pause', 'read'])
    fake.state.playing = false // and paused it again before the end
    await hold.release('web-aaaaaa')
    expect(fake.calls).not.toContain('resume')
    expect(fake.state.playing).toBe(false)
  })

  it('another app plays at the end: the paused one is not played over it', async () => {
    const { hold, fake } = make()
    await hold.hold('web-aaaaaa', 'mic')
    Object.assign(fake.state, { bundle: 'other.app', pid: 77, name: 'Other', playing: false })
    await hold.release('web-aaaaaa')
    expect(fake.calls).toEqual(['pause', 'resume'])
    expect(fake.state).toMatchObject({ bundle: 'other.app', playing: false })
  })

  it('overlapping holds: the music comes back after the last one ends', async () => {
    const { hold, fake, events } = make()
    await hold.hold('web-aaaaaa', 'mic')
    await hold.hold('mac-bbbbbb', 'mac-dictation')
    expect(fake.calls).toEqual(['pause', 'pause'])
    await hold.release('web-aaaaaa')
    expect(fake.state.playing).toBe(false)
    await hold.release('mac-bbbbbb')
    expect(fake.state.playing).toBe(true)
    expect(events).toEqual([true, false])
  })

  it('a second voice input pauses what the person started during the first', async () => {
    const { hold, fake } = make()
    await hold.hold('web-aaaaaa', 'mic')
    fake.state.playing = true
    clock += 5_000
    await hold.hold('web-aaaaaa', 'mic') // takeover seen: no longer ours
    await hold.hold('web-cccccc', 'quickbar')
    expect(fake.state.playing).toBe(false)
    await hold.release('web-aaaaaa')
    await hold.release('web-cccccc')
    expect(fake.state.playing).toBe(true)
  })

  it('a hold nobody renews ends after its TTL, and the music comes back', async () => {
    const { hold, fake } = make()
    await hold.hold('web-aaaaaa', 'mic')
    clock += HOLD_TTL_MS - 1
    expect((await hold.status()).active).toBe(true)
    clock += 2
    expect(await hold.status()).toMatchObject({ active: false, paused: [] })
    expect(fake.state.playing).toBe(true)
  })

  it('no hold outlives HOLD_MAX_MS, however often it is renewed', async () => {
    const { hold, fake } = make()
    await hold.hold('web-aaaaaa', 'mic')
    for (let t = 0; t < HOLD_MAX_MS; t += 60_000) {
      clock += 60_000
      await hold.hold('web-aaaaaa', 'mic')
    }
    clock += HOLD_TTL_MS
    expect((await hold.status()).active).toBe(false)
    expect(fake.state.playing).toBe(true)
  })

  it('a renew that lands after its release starts nothing', async () => {
    const { hold, fake } = make()
    await hold.hold('web-aaaaaa', 'mic')
    await hold.release('web-aaaaaa')
    const late = await hold.hold('web-aaaaaa', 'mic')
    expect(late.active).toBe(false)
    expect(fake.calls).toEqual(['pause', 'resume'])
    expect(fake.state.playing).toBe(true)
  })

  it('a release that overtakes its hold starts nothing either', async () => {
    const { hold, fake } = make()
    await hold.release('mac-dddddd')
    await hold.hold('mac-dddddd', 'mac-dictation')
    expect(fake.calls).toEqual([])
    expect(fake.state.playing).toBe(true)
  })

  it('a release while the pause is still on its way ends with the music back', async () => {
    const fake = fakeMediaController()
    let letPauseLand!: () => void
    const slow: MediaController = {
      ...fake.controller,
      pauseNowPlaying: () => new Promise((resolve) => { letPauseLand = () => resolve(fake.controller.pauseNowPlaying()) }),
    }
    const { hold } = make({ controller: slow })
    const holding = hold.hold('web-aaaaaa', 'mic')
    await new Promise((r) => setTimeout(r, 0))
    const releasing = hold.release('web-aaaaaa')
    letPauseLand()
    await holding
    await releasing
    await hold.idle()
    expect(fake.calls).toEqual(['pause', 'resume'])
    expect(fake.state.playing).toBe(true)
  })

  it('a release that lands while the hold still waits for the setting: the hold never starts', async () => {
    const fake = fakeMediaController()
    const waiting: Array<(on: boolean) => void> = []
    const letEnabledAnswer = () => { for (const answer of waiting.splice(0)) answer(true) }
    const hold = new MediaHold({
      controller: () => fake.controller,
      enabled: () => new Promise<boolean>((resolve) => { waiting.push(resolve) }),
      now,
    })
    holds.push(hold)
    const holding = hold.hold('mac-eeeeee', 'mac-dictation')
    await new Promise((r) => setTimeout(r, 0))
    const releasing = hold.release('mac-eeeeee')
    letEnabledAnswer()
    expect((await holding).active).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    letEnabledAnswer()
    await releasing
    await hold.idle()
    expect(fake.calls).toEqual([])
    expect(fake.state.playing).toBe(true)
  })

  it('no controller (off the Mac, an isolated server): holds still tell the windows', async () => {
    const { hold, events } = make({ controller: null })
    const view = await hold.hold('web-aaaaaa', 'mic')
    expect(view.active).toBe(true)
    expect(view.note).toMatch(/does not control the music/)
    await hold.release('web-aaaaaa')
    expect(events).toEqual([true, false])
  })

  it('refuses an id that is not one', async () => {
    const { hold } = make()
    await expect(hold.hold('x', 'mic')).rejects.toThrow(/media hold id/)
    await expect(hold.hold('../../etc', 'mic')).rejects.toThrow(/media hold id/)
  })
})

describe('across a restart', () => {
  it('reads back what was paused; it plays again once its holds go unrenewed', async () => {
    const file = path.join(dir, 'local', 'stt-media-hold.json')
    const first = make({ file })
    await first.hold.hold('web-aaaaaa', 'mic')
    await first.hold.idle()
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).paused).toHaveLength(1)
    first.hold.dispose() // the server dies mid-dictation

    const second = make({ file, controller: first.fake.controller })
    await second.hold.restore()
    expect(await second.hold.status()).toMatchObject({ active: true, paused: ['Fake Player'] })
    clock += HOLD_TTL_MS + 1
    expect((await second.hold.status()).active).toBe(false)
    await second.hold.idle()
    expect(first.fake.state.playing).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a hold renewed after the restart keeps the music off until its own end', async () => {
    const file = path.join(dir, 'local', 'stt-media-hold.json')
    const first = make({ file })
    await first.hold.hold('web-aaaaaa', 'mic')
    await first.hold.idle()
    first.hold.dispose()
    const second = make({ file, controller: first.fake.controller })
    await second.hold.restore()
    clock += 10_000
    await second.hold.hold('web-aaaaaa', 'mic')
    expect(first.fake.calls).toEqual(['pause', 'read'])
    await second.hold.release('web-aaaaaa')
    expect(first.fake.state.playing).toBe(true)
  })

  it('a pause read back from long ago is dropped, never played', async () => {
    const file = path.join(dir, 'local', 'stt-media-hold.json')
    const first = make({ file })
    await first.hold.hold('web-aaaaaa', 'mic')
    await first.hold.idle()
    first.hold.dispose()
    clock += RESTORE_MAX_AGE_MS + 1
    const second = make({ file, controller: first.fake.controller })
    await second.hold.restore()
    expect((await second.hold.status()).active).toBe(false)
    expect(first.fake.calls).toEqual(['pause'])
    expect(first.fake.state.playing).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('nothing paused: no file is left behind', async () => {
    const file = path.join(dir, 'local', 'stt-media-hold.json')
    const { hold, fake } = make({ file })
    fake.state.playing = false
    await hold.hold('web-aaaaaa', 'mic')
    await hold.release('web-aaaaaa')
    await hold.idle()
    expect(fs.existsSync(file)).toBe(false)
  })
})
