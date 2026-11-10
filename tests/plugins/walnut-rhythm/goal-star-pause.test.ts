/**
 * Three things the person asked for in the running block (2026-11-10): a goal for the
 * block, starred sounds on top of the music list, and pausing the block's music without
 * stopping the block. Each on a fake host and a fake clock; no real process runs and no
 * sound plays.
 */
import { describe, expect, it } from 'vitest'
import type { RunResult, Runner } from '../../../plugin-store/walnut-rhythm/src/server/exec'
import * as actions from '../../../plugin-store/walnut-rhythm/src/server/actions'
import { focusOnBoot, GOAL_MAX, normalizeGoal } from '../../../plugin-store/walnut-rhythm/src/server/focus'
import { nextBlockArgs } from '../../../plugin-store/walnut-rhythm/src/server/notices'
import { rhythmStatusItem } from '../../../plugin-store/walnut-rhythm/src/server/status-item'
import { isStarKey, MAX_STARRED, parseStarred, setStarred } from '../../../plugin-store/walnut-rhythm/src/server/starred'
import { musicOptions, starredNow } from '../../../plugin-store/walnut-rhythm/src/web/music-options'
import type { MusicTracksResult } from '../../../plugin-store/walnut-rhythm/src/web/music'
import { currentMusic, musicPaused, nowPlayingLine } from '../../../plugin-store/walnut-rhythm/src/web/now-playing-model'
import { makeHarness, MIN } from './harness'

const NINE = new Date(2026, 8, 25, 9, 0).getTime()
const DEEP = 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ'
const LOFI = 'spotify:playlist:0vvXsWCC9xrXsKd4FyS8kM'
/** A play command (not a `player state` read). */
const PLAYS = / to play( track "|$)/
const PAUSE = 'if application "Spotify" is running then tell application "Spotify" to pause'

async function boot(options: Partial<Parameters<typeof makeHarness>[0]> = {}) {
  const h = makeHarness({ start: NINE, ...options })
  const runtime = h.build()
  await runtime.load()
  await runtime.kick()
  return { h, runtime }
}

/** A fake Mac whose Spotify keeps a player state, so pause and resume can be told apart. */
function fakeSpotify() {
  const scripts: string[] = []
  let player: 'stopped' | 'playing' | 'paused' = 'stopped'
  const runner: Runner = async (command, args): Promise<RunResult> => {
    if (command !== 'osascript') return { ok: true, code: 0, stdout: '', stderr: '' }
    const script = String(args[1])
    scripts.push(script)
    if (script.includes('player state')) return { ok: true, code: 0, stdout: `${player}\n`, stderr: '' }
    if (script.endsWith(' to pause')) player = player === 'playing' ? 'paused' : player
    else if (script.includes(' to play')) player = 'playing'
    return { ok: true, code: 0, stdout: '', stderr: '' }
  }
  return { scripts, runner, setPlayer: (next: typeof player) => { player = next } }
}

describe('the block\'s goal', () => {
  it('is one trimmed line of at most GOAL_MAX characters', () => {
    expect(normalizeGoal('  finish   the\n draft ')).toBe('finish the draft')
    expect(normalizeGoal('   ')).toBeUndefined()
    expect(normalizeGoal(42)).toBeUndefined()
    expect([...normalizeGoal('\u{1F600}'.repeat(GOAL_MAX + 5))!].length).toBe(GOAL_MAX)
  })

  it('is set at Start, shown with the block, edited during it, kept for the next block, and logged', async () => {
    const { h, runtime } = await boot()
    const started = await actions.focusStart(runtime, { minutes: 25, goal: ' Write the release notes ' })
    expect(started.message).toContain('goal: Write the release notes')
    expect(started.state.focus.goal).toBe('Write the release notes')
    expect(rhythmStatusItem(started.state)!.detail).toMatch(/^Goal: Write the release notes\. Started 09:00/)

    const edited = await actions.focusGoal(runtime, { goal: 'Ship the notes' })
    expect(edited.state.focus.goal).toBe('Ship the notes')
    expect(rhythmStatusItem(edited.state)!.detail).toMatch(/^Goal: Ship the notes\./)
    const cleared = await actions.focusGoal(runtime, { goal: '' })
    expect(cleared.state.focus.goal).toBeUndefined()
    expect(rhythmStatusItem(cleared.state)!.detail).toMatch(/^Started/)
    await actions.focusGoal(runtime, { goal: 'Ship the notes' })

    // A restart keeps it.
    expect(focusOnBoot(JSON.parse(JSON.stringify(runtime.focus))).goal).toBe('Ship the notes')

    // The block ends: the day log and the notice carry it; Another block starts with it.
    await h.tick(runtime, 25 * MIN + 1)
    expect(runtime.day.focusBlocks.at(-1)).toMatchObject({ minutes: 25, goal: 'Ship the notes' })
    const done = h.calls.find((call) => call.type === 'notify' && call.notice.dedupKey === 'focus-done')
    expect(done && done.type === 'notify' ? done.notice.body : '').toContain('Goal: Ship the notes.')
    expect(nextBlockArgs(runtime.focus)).toMatchObject({ goal: 'Ship the notes' })
  })

  it('needs a running block: editing it never starts one', async () => {
    const { runtime } = await boot()
    await expect(actions.focusGoal(runtime, { goal: 'x' })).rejects.toThrow(/No focus block is running/)
    expect(runtime.focus.phase).toBe('idle')
    await actions.focusStart(runtime, { minutes: 25 })
    await expect(actions.focusGoal(runtime, { goal: 7 })).rejects.toThrow(/goal is text/)
  })

  it('is not shown once Rhythm is off', async () => {
    const { runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 25, goal: 'Draft' })
    const stopped = await actions.focusStop(runtime)
    expect(stopped.state.focus.goal).toBeUndefined()
  })
})

describe('starred sounds', () => {
  const listing = {
    folder: '/music',
    tracks: [
      { id: '01 Brown Noise.m4a', title: 'Brown Noise', file: '/music/01 Brown Noise.m4a' },
      { id: '02 Pink Noise.m4a', title: 'Pink Noise', file: '/music/02 Pink Noise.m4a' },
      { id: '03 Piano.m4a', title: 'Piano Impromptu', file: '/music/03 Piano.m4a' },
    ],
    withFocus: true,
    spotify: { available: true, playlists: [{ uri: DEEP, name: 'Deep Focus' }] },
  } as unknown as MusicTracksResult

  it('sit right under No music, in the list\'s own order; the rest follow', () => {
    expect(musicOptions(listing).map((one) => one.title)).toEqual(['No music', 'Brown Noise', 'Pink Noise', 'Piano Impromptu', 'Deep Focus'])
    const ordered = musicOptions(listing, [`spotify:${DEEP}`, 'track:03 Piano.m4a', 'track:gone.m4a'])
    expect(ordered.map((one) => one.title)).toEqual(['No music', 'Piano Impromptu', 'Deep Focus', 'Brown Noise', 'Pink Noise'])
    expect(ordered.map((one) => one.starred)).toEqual([false, true, true, false, false])
  })

  it('a click shows at once, over the server\'s list, until the answer comes', () => {
    expect(starredNow(['track:a'], new Map([['track:b', true]]))).toEqual(['track:a', 'track:b'])
    expect(starredNow(['track:a', 'track:b'], new Map([['track:a', false]]))).toEqual(['track:b'])
  })

  it('accept only list keys, keep at most MAX_STARRED, and drop repeats', () => {
    expect(isStarKey('track:01 Brown Noise.m4a')).toBe(true)
    expect(isStarKey(`spotify:${DEEP}`)).toBe(true)
    expect(isStarKey('spotify:spotify:playlist:x"; do shell script "')).toBe(false)
    expect(isStarKey('none')).toBe(false)
    expect(isStarKey('track:a\nb')).toBe(false)
    expect(parseStarred(['track:a', 'track:a', 5, 'nope'])).toEqual(['track:a'])
    let list: string[] = []
    for (let i = 0; i < MAX_STARRED + 3; i++) list = setStarred(list, `track:${i}`, true)
    expect(list).toHaveLength(MAX_STARRED)
    expect(list[0]).toBe('track:3')
    expect(setStarred(list, 'track:10', false)).not.toContain('track:10')
  })

  it('are kept on the server: every device reads them from the state, and a restart keeps them', async () => {
    const { h, runtime } = await boot()
    const starred = await actions.musicStar(runtime, { key: 'track:03 Piano.m4a', on: true })
    expect(starred.state.starred).toEqual(['track:03 Piano.m4a'])
    await actions.musicStar(runtime, { key: `spotify:${DEEP}`, on: true })
    await expect(actions.musicStar(runtime, { key: 'bad', on: true })).rejects.toThrow(/Name the music by its key/)
    await expect(actions.musicStar(runtime, { key: 'track:x' })).rejects.toThrow(/on: true/)

    const again = h.build()
    await again.load()
    expect(again.starred).toEqual(['track:03 Piano.m4a', `spotify:${DEEP}`])
    const off = await actions.musicStar(again, { key: 'track:03 Piano.m4a', on: false })
    expect(off.state.starred).toEqual([`spotify:${DEEP}`])
  })
})

describe('pausing the block\'s music', () => {
  it('a folder track pauses here and keeps its place; the line says so', () => {
    const view = { playing: false, starting: false, paused: true, trackId: '01 Brown Noise.m4a' }
    const state = { focus: { phase: 'focus' } } as never
    const choice = currentMusic(view, state)
    expect(choice).toEqual({ kind: 'track', id: '01 Brown Noise.m4a' })
    expect(musicPaused(choice, view, state)).toBe(true)
    const listing = { tracks: [{ id: '01 Brown Noise.m4a', title: 'Brown Noise' }], spotify: { playlists: [] } } as unknown as MusicTracksResult
    expect(nowPlayingLine(choice, listing, true, true)).toBe('Brown Noise is paused. The block runs on.')
  })

  it('a Spotify playlist pauses on the Mac and plays on from where it was, while the block runs on', async () => {
    const mac = fakeSpotify()
    const { h, runtime } = await boot({ darwin: true, runner: mac.runner })
    await actions.focusStart(runtime, { minutes: 25, spotify: DEEP })

    const paused = await actions.focusMusicPause(runtime, { paused: true })
    expect(paused.message).toBe('Paused Deep Focus. The block runs on.')
    expect(paused.state.focus).toMatchObject({ phase: 'focus', spotifyUri: DEEP, musicPaused: true })
    expect(mac.scripts.at(-1)).toBe(PAUSE)
    expect(nowPlayingLine({ kind: 'spotify', uri: DEEP }, { tracks: [], spotify: { playlists: [{ uri: DEEP, name: 'Deep Focus' }] } } as never, true, true))
      .toBe('Deep Focus is paused in Spotify on your Mac. The block runs on.')

    const resumed = await actions.focusMusicPause(runtime, { paused: false })
    expect(resumed.message).toBe('Deep Focus is playing again in Spotify on this Mac.')
    expect(resumed.state.focus.musicPaused).toBeUndefined()
    // Plays on where it paused: a plain `play`, not the playlist from its start.
    expect(mac.scripts.filter((one) => one === 'tell application "Spotify" to play')).toHaveLength(1)
    expect(mac.scripts.filter((one) => one.includes('play track'))).toHaveLength(1)

    // Spotify was quit meanwhile: resuming starts the playlist again.
    await actions.focusMusicPause(runtime, { paused: true })
    mac.setPlayer('stopped')
    await actions.focusMusicPause(runtime, { paused: false })
    expect(mac.scripts.filter((one) => one.includes('play track'))).toHaveLength(2)

    // A pause is the block's: its break has none, and the next block starts unpaused.
    await actions.focusMusicPause(runtime, { paused: true })
    await h.tick(runtime, 25 * MIN + 1)
    expect(runtime.focus.phase).toBe('break')
    expect(runtime.focus.musicPaused).toBeUndefined()
  })

  it('picking the paused playlist again plays it on; picking another clears the pause', async () => {
    const mac = fakeSpotify()
    const { runtime } = await boot({ darwin: true, runner: mac.runner })
    await actions.focusStart(runtime, { minutes: 25, spotify: DEEP })
    await actions.focusMusicPause(runtime, { paused: true })
    const same = await actions.focusMusic(runtime, { spotify: DEEP })
    expect(same.message).toBe('Spotify is playing Deep Focus again on this Mac.')
    expect(same.state.focus.musicPaused).toBeUndefined()
    expect(mac.scripts.at(-2)).toBe('tell application "Spotify" to play')

    await actions.focusMusicPause(runtime, { paused: true })
    const other = await actions.focusMusic(runtime, { spotify: LOFI })
    expect(other.state.focus).toMatchObject({ spotifyUri: LOFI })
    expect(other.state.focus.musicPaused).toBeUndefined()
  })

  it('a preview over a paused block leaves it quiet, and Resume then starts the block\'s own playlist, not the preview\'s', async () => {
    const mac = fakeSpotify()
    const { runtime } = await boot({ darwin: true, runner: mac.runner })
    await actions.focusStart(runtime, { minutes: 25, spotify: DEEP })
    await actions.focusMusicPause(runtime, { paused: true })
    await actions.spotifyPreview(runtime, { uri: LOFI })
    await actions.spotifyPreview(runtime, { stop: true })
    expect(mac.scripts.at(-1)).toBe(PAUSE)
    expect(mac.scripts.filter((one) => one === `tell application "Spotify" to play track "${DEEP}"`)).toHaveLength(1)
    expect(runtime.focus.musicPaused).toBe(true)
    await actions.focusMusicPause(runtime, { paused: false })
    expect(mac.scripts.filter((one) => one === `tell application "Spotify" to play track "${DEEP}"`)).toHaveLength(2)
    expect(mac.scripts).not.toContain('tell application "Spotify" to play')
  })

  it('Resume when Spotify already plays the block\'s playlist (play pressed in Spotify) does not start it over', async () => {
    const mac = fakeSpotify()
    const { runtime } = await boot({ darwin: true, runner: mac.runner })
    await actions.focusStart(runtime, { minutes: 25, spotify: DEEP })
    await actions.focusMusicPause(runtime, { paused: true })
    mac.setPlayer('playing')
    const count = mac.scripts.filter((one) => PLAYS.test(one)).length
    const resumed = await actions.focusMusicPause(runtime, { paused: false })
    expect(resumed.state.focus.musicPaused).toBeUndefined()
    expect(mac.scripts.filter((one) => PLAYS.test(one)).length).toBe(count)
  })

  it('a resume that does not play reads paused again, on both paths', async () => {
    const mac = fakeSpotify()
    let refuse = false
    const runner: Runner = async (command, args) => {
      if (refuse && PLAYS.test(String(args[1]))) return { ok: false, code: 1, stdout: '', stderr: '', error: 'Not authorized to send Apple events to Spotify. (-1743)' }
      return mac.runner(command, args, { timeoutMs: 0 })
    }
    const { runtime } = await boot({ darwin: true, runner })
    await actions.focusStart(runtime, { minutes: 25, spotify: DEEP })
    await actions.focusMusicPause(runtime, { paused: true })
    refuse = true
    const viaButton = await actions.focusMusicPause(runtime, { paused: false })
    expect(viaButton.spotifyError).toBeTruthy()
    expect(viaButton.state.focus.musicPaused).toBe(true)
    const viaPick = await actions.focusMusic(runtime, { spotify: DEEP })
    expect(viaPick.spotifyError).toBeTruthy()
    expect(viaPick.state.focus.musicPaused).toBe(true)
  })

  it('never starts a block, and says so when the block plays no Spotify', async () => {
    const { runtime } = await boot({ darwin: true })
    await expect(actions.focusMusicPause(runtime, { paused: true })).rejects.toThrow(/No focus block is running/)
    expect(runtime.focus.phase).toBe('idle')
    await actions.focusStart(runtime, { minutes: 25 })
    await expect(actions.focusMusicPause(runtime, { paused: true })).rejects.toThrow(/plays no Spotify/)
    await expect(actions.focusMusicPause(runtime, {})).rejects.toThrow(/paused: true/)
  })
})
