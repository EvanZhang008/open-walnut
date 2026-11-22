/**
 * The server's one media hold (media-hold.ts), wired to the config, the event bus and the
 * Mac's player.
 *
 * Real control of the music needs a Mac and the user's own server: an isolated server
 * (the test runner, an ephemeral copy, a data home in a temp or task directory) runs on
 * the same Mac as the user's and must never pause or play their music. Such a server
 * still keeps its holds and tells its windows, and with WALNUT_MEDIA_HOLD_FAKE=1 it
 * drives a pretend player instead (fakeMediaController), so a browser test can watch the
 * whole flow without a sound.
 */
import { getConfig } from '../config-manager.js'
import { bus, EventNames } from '../event-bus.js'
import { isolatedHere } from './voice-here.js'
import { MediaHold, mediaHoldFile } from './media-hold.js'
import { mediaRemoteController, type MediaController, type NowPlaying, type PausedPlayer } from './media-control.js'

/** The setting: on unless the person turned it off. */
export function pauseMediaEnabled(config: { stt?: { pause_media?: boolean } }): boolean {
  return config.stt?.pause_media !== false
}

/** A pretend player that "plays" until paused, and records every call. No process, no sound. */
export function fakeMediaController(start: NowPlaying = { playing: true, bundle: 'test.fake.player', pid: 4242, name: 'Fake Player' }) {
  const state: NowPlaying = { ...start }
  const calls: string[] = []
  const controller: MediaController = {
    async read() { calls.push('read'); return { ...state } },
    async pauseNowPlaying() {
      calls.push('pause')
      if (!state.playing) return { paused: null }
      state.playing = false
      return { paused: { bundle: state.bundle, pid: state.pid, name: state.name } }
    },
    async resume(player: PausedPlayer) {
      calls.push('resume')
      if (state.playing) return { resumed: false, reason: 'playing' }
      if (player.bundle !== state.bundle || player.pid !== state.pid) return { resumed: false, reason: 'other-app' }
      state.playing = true
      return { resumed: true }
    },
  }
  return { controller, state, calls }
}

let fake: ReturnType<typeof fakeMediaController> | null = null
let real: MediaController | null = null
let instance: MediaHold | null = null
let controllerForTest: MediaController | null | undefined

function controllerHere(): MediaController | null {
  if (controllerForTest !== undefined) return controllerForTest
  if (isolatedHere() !== null) {
    if (process.env.WALNUT_MEDIA_HOLD_FAKE !== '1') return null
    fake ??= fakeMediaController()
    return fake.controller
  }
  return process.platform === 'darwin' ? (real ??= mediaRemoteController()) : null
}

export function mediaHold(): MediaHold {
  instance ??= new MediaHold({
    controller: controllerHere,
    enabled: async () => pauseMediaEnabled(await getConfig()),
    emit: (active) => bus.emit(EventNames.STT_MEDIA_HOLD, { active }, ['web-ui'], { source: 'stt' }),
    // An isolated server keeps nothing across restarts: its data home is a copy.
    file: isolatedHere() === null ? mediaHoldFile() : null,
  })
  return instance
}

/** The pretend player's calls and state (an isolated server with WALNUT_MEDIA_HOLD_FAKE=1), else null. */
export function fakeMediaPlayerHere(): { calls: string[]; state: NowPlaying } | null {
  return isolatedHere() !== null && fake ? { calls: [...fake.calls], state: { ...fake.state } } : null
}

/** Tests: use this controller (null: none), or undefined to choose as the server does; drops the instance. */
export function _setMediaControllerForTest(controller: MediaController | null | undefined): void {
  controllerForTest = controller
  instance?.dispose()
  instance = null
  fake = null
}

// ── Voice input in progress ──
//
// Background voice work (Voice Accuracy's comparison runner) waits while the
// person dictates, so it never queues in front of their own hearing. Dictation
// is live while a microphone holds (above: every voice input on this machine
// takes a media hold, tests/core/stt-media-hold-ratchet.test.ts), while a voice
// request is being answered (a long final, a phone's take: server.ts counts
// them), and for a short while after either.

let voiceRequests = 0
let lastVoiceAt = 0

/** server.ts: a voice request (dictation, a draft, a transcribe) began. Returns its end, to call once. */
export function voiceRequestStarted(at = Date.now()): () => void {
  voiceRequests++
  lastVoiceAt = Math.max(lastVoiceAt, at)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    voiceRequests = Math.max(0, voiceRequests - 1)
    lastVoiceAt = Math.max(lastVoiceAt, Date.now())
  }
}

/** When the last voice request began or ended (ms). */
export function lastVoiceActivityAt(): number {
  return lastVoiceAt
}

/** The person is dictating now, or was within `quietMs`. */
export function voiceInputLive(quietMs: number, now = Date.now()): boolean {
  if (voiceRequests > 0 || now - lastVoiceAt < quietMs) return true
  if (instance?.listening()) {
    lastVoiceAt = now
    return true
  }
  return false
}

/** Tests: nobody is dictating. */
export function _resetVoiceActivityForTest(): void {
  voiceRequests = 0
  lastVoiceAt = 0
}
