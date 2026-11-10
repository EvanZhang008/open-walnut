/**
 * What each op does, over the runtime. Every mutating action runs inside the runtime's
 * `serial` queue and ends with one `step`, so the quiet hold, the notices and the
 * `state` event are all settled before the op answers.
 *
 * Refusals are thrown as plain sentences; the host turns a throw into
 * `{ ok: false, message }` for every caller (a session, the App, a notice button).
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import { BREAK_RANGE, clampMinutes, FOCUS_RANGE } from './config'
import { clockTime, MINUTE_MS as MIN } from './clock'
import { runProcess } from './exec'
import { startFocus, stopFocus, skipBreak, advanceFocus, startRest, extendPhase, normalizeGoal, setGoal, EXTEND_DEFAULT_MINUTES, EXTEND_RANGE } from './focus'
import { isStarKey, setStarred } from './starred'
import { listMusic, resolveMusicFolder, type MusicFs, type MusicListing } from './music'
import { spotifyUriOf, spotifyWebUrl, type SpotifyView } from './spotify'
import { KEY_BREAK_OVER, KEY_FOCUS_DONE } from './notices'
import { buildPublicState, type RhythmPublicState } from './public-state'
import type { RhythmRuntime } from './runtime'

export interface ActionResult {
  message: string
  state: RhythmPublicState
  /** The block started, but Spotify did not play: why, for the Start form to show. */
  spotifyError?: string
}

const MAX_FOCUS_MINUTES = 180

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function finish(runtime: RhythmRuntime, message: string): Promise<ActionResult> {
  await runtime.step()
  return { message, state: buildPublicState(runtime, runtime.now()) }
}

/** Settle the cycle up to now first, so an action never acts on a phase that already ended. */
async function settle(runtime: RhythmRuntime): Promise<void> {
  const advanced = advanceFocus(runtime.focus, runtime.now(), runtime.durations())
  if (advanced.events.length > 0) await runtime.step()
}

/** The ONLY way a run starts: an op the person (or an agent they asked) called. */
export async function focusStart(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  if (args.mode !== undefined && args.mode !== 'focus' && args.mode !== 'rest') throw new Error('mode is "focus" or "rest".')
  if (args.mode === 'rest') return focusRest(runtime, args)
  const spotifyUri = args.spotify === undefined || args.spotify === null || args.spotify === '' ? null : spotifyUriOf(args.spotify)
  if (args.spotify !== undefined && args.spotify !== null && args.spotify !== '' && !spotifyUri) {
    throw new Error('That is not a Spotify link. Paste a playlist link from Spotify (Share, Copy link).')
  }
  const started = await startBlock(runtime, args, spotifyUri)
  // A preview playing gives way to the block (a refused Start leaves it playing out).
  const previewed = cancelSpotifyPreview(runtime)
  if (!spotifyUri) {
    if (previewed) await runtime.spotify.pause()
    return started
  }
  const played = await playForBlock(runtime, spotifyUri)
  return {
    message: played.ok ? `${started.message} Spotify is playing ${played.name} on this Mac.` : `${started.message} ${played.error}`,
    state: buildPublicState(runtime, runtime.now()),
    ...(played.ok ? {} : { spotifyError: played.error }),
  }
}

/**
 * Play `uri` for the block running now. Runs after the block is on: Spotify can take a
 * few seconds to open, and the block must not wait for it.
 */
async function playForBlock(runtime: RhythmRuntime, uri: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const startedAt = runtime.focus.startedAt
  const played = await runtime.spotify.play(uri)
  await runtime.serial(async () => {
    const same = runtime.focus.phase === 'focus' && runtime.focus.startedAt === startedAt && runtime.focus.spotifyUri === uri
    // Stopped, ended or switched while Spotify was opening: that pause ran before this play landed.
    if (!same && played.ok) {
      const now = runtime.focus.phase === 'focus' ? runtime.focus.spotifyUri : undefined
      if (now && now !== uri) await runtime.spotify.play(now)
      else if (!now) await runtime.spotify.pause()
    }
    // A playlist that never played is not the block's to pause at its end.
    if (same && !played.ok) {
      const { spotifyUri: _unplayed, ...rest } = runtime.focus
      runtime.focus = rest
      runtime.markDirty()
      await runtime.step()
    }
  })
  if (!played.ok) return played
  return { ok: true, name: await playlistName(runtime, uri) }
}

async function playlistName(runtime: RhythmRuntime, uri: string): Promise<string> {
  return (await runtime.spotify.playlists()).find((one) => one.uri === uri)?.name ?? 'the playlist'
}

/** Switch the running block's music: a Spotify playlist on the Mac, or none (a track plays in the browser). */
export async function focusMusic(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  const given = args.spotify !== undefined && args.spotify !== null && args.spotify !== ''
  const uri = given ? spotifyUriOf(args.spotify) : null
  if (given && !uri) throw new Error('That is not a Spotify link. Paste a playlist link from Spotify (Share, Copy link).')
  const { had, wasPaused } = await runtime.serial(async () => {
    await settle(runtime)
    // Never a way to start a block: only Start does that.
    if (runtime.focus.phase !== 'focus') throw new Error('No focus block is running. Pick the music in the Start form instead.')
    const before = runtime.focus.spotifyUri
    // A pick plays: the pause ends with it.
    const { spotifyUri: _old, musicPaused: _paused, ...rest } = runtime.focus
    const wasPaused = runtime.focus.musicPaused === true
    runtime.focus = uri ? { ...rest, spotifyUri: uri } : rest
    runtime.markDirty()
    await runtime.step()
    return { had: before, wasPaused }
  })
  const previewed = cancelSpotifyPreview(runtime)
  // Picking the playlist that already plays keeps its place (a preview played over it, though, it comes back).
  if (uri && uri === had && wasPaused && !previewed) {
    const resumed = await runtime.spotify.resume(uri)
    if (!resumed.ok) await markPausedAgain(runtime, uri)
    return {
      message: resumed.ok ? `Spotify is playing ${await playlistName(runtime, uri)} again on this Mac.` : resumed.error,
      state: buildPublicState(runtime, runtime.now()),
      ...(resumed.ok ? {} : { spotifyError: resumed.error }),
    }
  }
  if (uri && uri === had && !previewed) {
    return { message: `Spotify is playing ${await playlistName(runtime, uri)} on this Mac until the block ends.`, state: buildPublicState(runtime, runtime.now()) }
  }
  if (!uri) {
    if (had || previewed) await runtime.spotify.pause()
    return { message: had ? 'Spotify paused. The block runs on.' : 'No Spotify music was playing for this block.', state: buildPublicState(runtime, runtime.now()) }
  }
  const played = await playForBlock(runtime, uri)
  return {
    message: played.ok ? `Spotify is playing ${played.name} on this Mac until the block ends.` : played.error,
    state: buildPublicState(runtime, runtime.now()),
    ...(played.ok ? {} : { spotifyError: played.error }),
  }
}

/**
 * Pause or go on with the block's Spotify music on the Mac, without stopping the block.
 * A folder track plays in the browser that started it, which pauses it there itself.
 */
export async function focusMusicPause(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  if (typeof args.paused !== 'boolean') throw new Error('Say paused: true or paused: false.')
  const paused = args.paused
  const { uri, name, sent } = await runtime.serial(async () => {
    await settle(runtime)
    if (runtime.focus.phase !== 'focus') throw new Error('No focus block is running, so no block music plays.')
    const playing = runtime.focus.spotifyUri
    if (!playing) throw new Error('The block plays no Spotify music. A folder track pauses in the window that plays it.')
    const { musicPaused: _was, ...rest } = runtime.focus
    runtime.focus = paused ? { ...rest, musicPaused: true } : rest
    runtime.markDirty()
    await runtime.step()
    cancelSpotifyPreview(runtime)
    // Queued on Spotify inside the queue, so a switch, a Stop or the block's end asked
    // after this lands after it too. Awaited outside: Spotify can take seconds.
    const sent: Promise<{ ok: true } | { ok: false; error: string }> = paused
      ? runtime.spotify.pause().then(() => ({ ok: true as const }))
      : runtime.spotify.resume(playing)
    return { uri: playing, name: await playlistName(runtime, playing), sent }
  })
  const played = await sent
  if (paused) return { message: `Paused ${name}. The block runs on.`, state: buildPublicState(runtime, runtime.now()) }
  // Still quiet on the Mac: say so rather than claim it plays.
  if (!played.ok) await markPausedAgain(runtime, uri)
  return {
    message: played.ok ? `${name} is playing again in Spotify on this Mac.` : played.error,
    state: buildPublicState(runtime, runtime.now()),
    ...(played.ok ? {} : { spotifyError: played.error }),
  }
}

/** A resume that did not play: the block's music reads paused again, if it is still the same. */
async function markPausedAgain(runtime: RhythmRuntime, uri: string): Promise<void> {
  await runtime.serial(async () => {
    if (runtime.focus.phase === 'focus' && runtime.focus.spotifyUri === uri) {
      runtime.focus = { ...runtime.focus, musicPaused: true }
      runtime.markDirty()
      await runtime.step()
    }
  })
}

/** Set (or, with an empty goal, clear) the goal of the block running now. */
export async function focusGoal(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  if (args.goal !== undefined && args.goal !== null && typeof args.goal !== 'string') throw new Error('goal is text; empty clears it.')
  const goal = normalizeGoal(args.goal)
  return runtime.serial(async () => {
    await settle(runtime)
    runtime.focus = setGoal(runtime.focus, goal)
    runtime.markDirty()
    return finish(runtime, goal ? `Goal for this block: ${goal}` : 'The block has no goal now.')
  })
}

/** Star a sound (it sits on top of every music list, on every device) or unstar it. */
export async function musicStar(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  if (!isStarKey(args.key)) throw new Error('Name the music by its key: "track:<file name>" or "spotify:<Spotify URI>", as music_tracks lists them.')
  if (typeof args.on !== 'boolean') throw new Error('Say on: true to star it or on: false to unstar it.')
  const key = args.key
  const on = args.on
  return runtime.serial(async () => {
    runtime.starred = setStarred(runtime.starred, key, on)
    runtime.markDirty()
    return finish(runtime, on ? 'Starred. It sits at the top of the music list.' : 'Unstarred.')
  })
}

export const SPOTIFY_PREVIEW_MS = 15_000

/** End a Spotify preview's timer. True when one was playing. */
function cancelSpotifyPreview(runtime: RhythmRuntime): boolean {
  const preview = runtime.spotifyPreview
  if (preview.timer) clearTimeout(preview.timer)
  preview.timer = undefined
  preview.token += 1
  const was = preview.active
  preview.active = false
  return was
}

/** After a preview: the block's own playlist comes back, else Spotify goes quiet again. */
async function afterPreview(runtime: RhythmRuntime): Promise<void> {
  // A block whose music the person paused stays quiet; Resume starts its playlist again.
  if (runtime.focus.phase === 'focus' && runtime.focus.spotifyUri && !runtime.focus.musicPaused) await runtime.spotify.play(runtime.focus.spotifyUri)
  else await runtime.spotify.pause()
}

/** A few seconds of a playlist in the Mac's Spotify, so the person hears it before picking it. */
export async function spotifyPreview(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  if (args.stop === true) {
    const was = cancelSpotifyPreview(runtime)
    if (was) await afterPreview(runtime)
    return { message: was ? 'Preview stopped.' : 'No preview was playing.', state: buildPublicState(runtime, runtime.now()) }
  }
  const uri = spotifyUriOf(args.uri)
  if (!uri) throw new Error('That is not a Spotify link. Paste a playlist link from Spotify (Share, Copy link).')
  cancelSpotifyPreview(runtime)
  const preview = runtime.spotifyPreview
  const token = preview.token
  // Active from the moment it is asked for: a stop, a pick or a Start while Spotify is still
  // opening sees it and sends its own pause or play, which lands after this play (in order).
  preview.active = true
  const played = await runtime.spotify.play(uri)
  const state = buildPublicState(runtime, runtime.now())
  if (preview.token !== token) return { message: 'Preview replaced.', state }
  if (!played.ok) {
    preview.active = false
    return { message: played.error, state, spotifyError: played.error }
  }
  preview.timer = setTimeout(() => {
    if (preview.token !== token) return
    cancelSpotifyPreview(runtime)
    void afterPreview(runtime)
  }, SPOTIFY_PREVIEW_MS)
  preview.timer.unref?.()
  return { message: `Previewing ${await playlistName(runtime, uri)} in Spotify on this Mac for ${SPOTIFY_PREVIEW_MS / 1000} seconds.`, state }
}

function startBlock(runtime: RhythmRuntime, args: Record<string, unknown>, spotifyUri: string | null): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const taskId = str(args.taskId)
    const goal = normalizeGoal(args.goal)
    let title: string | undefined
    if (taskId) {
      const task = await runtime.walnut.tasks.get(taskId)
      if (!task) throw new Error(`Task ${taskId} was not found.`)
      title = task.title
    }
    const minutes = clampMinutes(args.minutes, runtime.config.focusMinutes, 1, MAX_FOCUS_MINUTES)
    // 0 = no pick: the break follows the settings as they are when it starts.
    const breakMinutes = args.breakMinutes === undefined || args.breakMinutes === null
      ? 0
      : clampMinutes(args.breakMinutes, runtime.config.breakMinutes, BREAK_RANGE.min, BREAK_RANGE.max)
    const now = runtime.now()
    runtime.focus = startFocus(runtime.focus, { now, minutes, breakMinutes, ...(spotifyUri ? { spotifyUri } : {}), ...(taskId ? { taskId } : {}), ...(title ? { title } : {}), ...(goal ? { goal } : {}) })
    runtime.markDirty()
    // A Start form's pick is the next block's default: the settings themselves, so every
    // surface, the Settings form and an agent's plain "start a block" read the same numbers.
    if (args.remember === true) await rememberLengths(runtime, minutes, breakMinutes || runtime.config.breakMinutes)
    await runtime.dismiss(KEY_FOCUS_DONE)
    await runtime.dismiss(KEY_BREAK_OVER)
    // The person's pick for this block, else the setting. Never awaited: macOS takes seconds,
    // and the popover shows how it went from the state event.
    const dnd = typeof args.dnd === 'boolean' ? args.dnd : runtime.config.macosFocusShortcuts
    if (dnd && runtime.dnd.available) void runtime.dnd.turnOn({ startedAt: runtime.focus.startedAt, endsAt: runtime.focus.endsAt })
    const d = runtime.durations()
    const long = d.longBreakEvery > 0 && (runtime.focus.completedInCycle + 1) % d.longBreakEvery === 0
    const then = long ? `then the ${d.longBreakMinutes} min long break` : `then a ${breakMinutes || d.breakMinutes} min break`
    return finish(runtime, `Focus block started: ${minutes} min${title ? ` on ${title}` : ''}${goal ? `, goal: ${goal}` : ''}, ${then}.`)
  })
}

async function rememberLengths(runtime: RhythmRuntime, focusMinutes: number, breakMinutes: number): Promise<void> {
  const patch: Record<string, unknown> = {}
  if (focusMinutes >= FOCUS_RANGE.min && focusMinutes !== runtime.config.focusMinutes) patch.focus_minutes = focusMinutes
  if (breakMinutes !== runtime.config.breakMinutes) patch.break_minutes = breakMinutes
  if (Object.keys(patch).length === 0) return
  try {
    await runtime.walnut.config.patch(patch)
    // Applied now, not when the change event comes back, so the answer already shows it.
    runtime.applyConfig({ ...runtime.rawConfig(), ...patch })
  } catch (error) {
    runtime.walnut.log.warn('Rhythm could not remember the block lengths', { error: String(error) })
  }
}

/**
 * Rest now: during a block, the block ends here and its break starts at once; while off,
 * a rest of its own. Quiet and Do Not Disturb follow the block, so both go off with it.
 */
export function focusRest(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const before = runtime.focus
    const minutes = clampMinutes(args.minutes, before.breakMinutes || runtime.config.breakMinutes, BREAK_RANGE.min, BREAK_RANGE.max)
    const now = runtime.now()
    runtime.focus = startRest(before, { now, minutes })
    runtime.markDirty()
    if (before.phase === 'focus') {
      const ran = Math.floor((now - before.startedAt) / MIN)
      if (ran >= 1) {
        runtime.recordDay({ type: 'block', entry: { at: now, minutes: ran, ...(before.taskId ? { taskId: before.taskId } : {}), ...(before.title ? { title: before.title } : {}), ...(before.goal ? { goal: before.goal } : {}) } })
        if (before.taskId) {
          await runtime.walnut.tasks.appendLog(before.taskId, `Focus block: ${ran} min (rested early)${before.goal ? `. Goal: ${before.goal}` : ''}`).catch((error: unknown) => {
            runtime.walnut.log.warn('Could not log the focus block on its task', { taskId: before.taskId, error: String(error) })
          })
        }
      }
      runtime.recordDay({ type: 'focus-break' })
      if (before.spotifyUri) void runtime.spotify.pause()
    }
    await runtime.dismiss(KEY_FOCUS_DONE)
    await runtime.dismiss(KEY_BREAK_OVER)
    const ends = clockTime(runtime.focus.endsAt)
    return finish(runtime, before.phase === 'focus'
      ? `Block ended early. Rest for ${minutes} min, until ${ends}.`
      : `Rest started: ${minutes} min, until ${ends}. Then Rhythm asks about the next block.`)
  })
}

/** More time on the block or the break running now. Do Not Disturb follows a longer block. */
export function focusExtend(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const minutes = clampMinutes(args.minutes, EXTEND_DEFAULT_MINUTES, EXTEND_RANGE.min, EXTEND_RANGE.max)
    runtime.focus = extendPhase(runtime.focus, { now: runtime.now(), minutes })
    runtime.markDirty()
    const what = runtime.focus.phase === 'focus' ? 'The block' : 'The break'
    return finish(runtime, `${what} runs ${minutes} min more, until ${clockTime(runtime.focus.endsAt)}.`)
  })
}

export function focusStop(runtime: RhythmRuntime): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const was = runtime.focus.phase
    const stopped = stopFocus(runtime.focus, runtime.now())
    runtime.focus = stopped.state
    runtime.markDirty()
    if (stopped.stoppedMinutes !== null) runtime.recordDay({ type: 'stopped' })
    if (was === 'focus' && runtime.focus.spotifyUri) void runtime.spotify.pause()
    // Rhythm's own Do Not Disturb goes off in the step below (the block is no longer running).
    await runtime.dismiss(KEY_FOCUS_DONE)
    await runtime.dismiss(KEY_BREAK_OVER)
    const message = was === 'idle'
      ? 'Rhythm is off. It starts when you press Start.'
      : was === 'focus' ? `Focus block stopped after ${stopped.stoppedMinutes ?? 0} min. Rhythm is off.` : 'Stopped. Rhythm is off.'
    return finish(runtime, message)
  })
}

/** Turn macOS Do Not Disturb on or off for the block running now (the popover's switch). */
export async function focusDnd(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  if (typeof args.on !== 'boolean') throw new Error('Say on: true or on: false.')
  if (!runtime.dnd.available) throw new Error('Do Not Disturb is turned on by the Mac that hosts your primary Walnut.')
  const block = await runtime.serial(async () => {
    await settle(runtime)
    // Never a way to start a block: only Start does that. Off needs no block: it only ends Rhythm's own.
    const running = runtime.runningBlock()
    if (!running && args.on) throw new Error('No focus block is running. Do Not Disturb follows a block; start one first.')
    return running
  })
  if (args.on && block) await runtime.dnd.turnOn(block)
  else await runtime.dnd.turnOff()
  const state = await runtime.serial(async () => { await runtime.step(); return buildPublicState(runtime, runtime.now()) })
  return { message: dndMessage(state.dnd.record), state }
}

/** The "Mac Do Not Disturb during focus blocks" setting, from the App's switch. */
export async function dndSetting(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  if (typeof args.on !== 'boolean') throw new Error('Say on: true or on: false.')
  const on = args.on
  await runtime.walnut.config.patch({ macos_focus_shortcuts: on })
  return runtime.serial(async () => {
    // Applied now, not when the change event comes back, so the answer already shows it.
    runtime.applyConfig({ ...runtime.rawConfig(), macos_focus_shortcuts: on })
    if (on) await runtime.macos.checkShortcuts(runtime.now(), true)
    const missing = runtime.macos.shortcuts.missing.length > 0
    return finish(runtime, on
      ? missing ? 'On. One time: click Add shortcuts (if the Shortcuts app asks, click Add Shortcut for each).' : 'On. Each focus block turns Mac Do Not Disturb on until it ends.'
      : 'Off. Focus blocks leave Mac Do Not Disturb alone.')
  })
}

/** One sentence for where Do Not Disturb stands. PURE. */
export function dndMessage(record: RhythmPublicState['dnd']['record']): string {
  if (!record) return 'Do Not Disturb is off.'
  switch (record.status) {
    case 'on': return `Do Not Disturb is on until ${new Date(record.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, then macOS turns it off.`
    case 'left-alone': return `${record.focusName ?? 'A Focus'} is already on, so Rhythm left it as it is.`
    case 'failed': return record.stillOn ? record.error ?? 'Do Not Disturb may still be on.' : `Do Not Disturb did not turn on. ${record.error ?? ''}`.trim()
    case 'turning-on': return 'Turning Do Not Disturb on…'
    case 'turning-off': return 'Turning Do Not Disturb off…'
    default: return 'Do Not Disturb is off.'
  }
}

export function breakSkip(runtime: RhythmRuntime): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const was = runtime.focus.phase
    const now = runtime.now()
    runtime.focus = skipBreak(runtime.focus, now)
    runtime.markDirty()
    await runtime.dismiss(KEY_FOCUS_DONE)
    await runtime.dismiss(KEY_BREAK_OVER)
    return finish(runtime, was === 'break_due' || was === 'break' ? 'Break ended. Rhythm is off until you start the next block.' : 'No break was running.')
  })
}

export function status(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<RhythmPublicState> {
  return runtime.serial(async () => {
    const now = runtime.now()
    // `shortcuts list` runs only when someone asks (the App's Check again and its first
    // open) or when the shortcuts are actually in use; a plain status read starts nothing.
    if (args.refresh === true) {
      await runtime.macos.checkShortcuts(now, true)
      // Check again after granting Full Disk Access must not wait out the 10 minute backoff.
      await runtime.macos.pollMirror(now, runtime.config.mirrorMacosFocus, true)
      await runtime.syncHold()
    } else if (runtime.config.macosFocusShortcuts || runtime.focus.phase === 'focus') await runtime.macos.checkShortcuts(now)
    return buildPublicState(runtime, runtime.now())
  })
}

export async function privacyOpen(runtime: RhythmRuntime): Promise<{ message: string }> {
  await runtime.macos.openPrivacySettings()
  return { message: 'System Settings is open at Full Disk Access. Turn on Walnut there, then click Check again.' }
}

export async function shortcutsInstall(runtime: RhythmRuntime): Promise<{ message: string; steps: unknown[]; state: RhythmPublicState }> {
  // Deliberately outside `serial`: signing talks to Apple and can take many seconds.
  const result = await runtime.macos.install(runtime.now)
  const opened = result.steps.filter((step) => step.ok).length
  const failed = result.steps.filter((step) => !step.ok)
  const message = result.alreadyInstalled
    ? 'Both Rhythm shortcuts are already in Shortcuts.'
    : failed.length === 0
      ? `Sent ${opened} ${opened === 1 ? 'shortcut' : 'shortcuts'} to the Shortcuts app. If it asks, click Add Shortcut for each; Rhythm checks by itself.`
      : `${failed.map((step) => `${step.name}: ${step.step} failed (${step.error ?? 'unknown error'})`).join('; ')}`
  if (!result.alreadyInstalled && opened === 0) throw new Error(message)
  return { message, steps: result.steps, state: await status(runtime, {}) }
}

const nodeMusicFs: MusicFs = {
  readdir: (dir) => fsp.readdir(dir, { withFileTypes: true }),
  stat: async (file) => {
    const info = await fsp.stat(file)
    return { size: info.size, isFile: info.isFile() }
  },
}

function musicFolder(runtime: RhythmRuntime) {
  return resolveMusicFolder(runtime.config.musicFolder, runtime.walnut.storage.dataDir, os.homedir())
}

/** The tracks in the focus music folder. The default folder is made on first look, so there is a place to put files. */
export type MusicTracksResult = MusicListing & { withFocus: boolean; spotify: SpotifyView }

/** The tracks in the focus music folder, and the Spotify playlists. The default folder is made on first look, so there is a place to put files. */
export async function musicTracks(runtime: RhythmRuntime, fs: MusicFs = nodeMusicFs): Promise<MusicTracksResult> {
  const target = musicFolder(runtime)
  const withFocus = runtime.config.musicWithFocus
  const spotify = await runtime.spotify.view()
  if (target.error) return { folder: target.folder, isDefault: false, exists: false, tracks: [], skipped: [], error: target.error, withFocus, spotify }
  if (target.isDefault) await fsp.mkdir(target.folder, { recursive: true }).catch(() => undefined)
  return { ...(await listMusic(target.folder, target.isDefault, fs)), withFocus, spotify }
}

/** Keep a Spotify playlist for the Start form. Its name comes from Spotify when none is given. */
export async function spotifyPlaylistAdd(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<{ message: string; spotify: SpotifyView }> {
  const uri = spotifyUriOf(args.link)
  if (!uri) throw new Error('That is not a Spotify link. In Spotify, open the playlist, then Share, Copy link, and paste it here.')
  const name = str(args.name) ?? await spotifyName(runtime, uri)
  await runtime.spotify.add(uri, name)
  return { message: `Added ${name}. Pick it as the music for the next block.`, spotify: await runtime.spotify.view() }
}

export async function spotifyPlaylistRemove(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<{ message: string; spotify: SpotifyView }> {
  const uri = spotifyUriOf(args.uri)
  if (!uri) throw new Error('Name the playlist to remove by its Spotify link or URI.')
  await runtime.spotify.remove(uri)
  return { message: 'Removed the playlist from Rhythm. It is still in your Spotify.', spotify: await runtime.spotify.view() }
}

/** Spotify's public oEmbed answers a playlist's title without a sign-in; a failure only costs the name. */
async function spotifyName(runtime: RhythmRuntime, uri: string): Promise<string> {
  try {
    const response = await runtime.walnut.http.fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyWebUrl(uri))}`, { timeoutMs: 5_000 })
    if (response.ok) {
      const body = await response.json<{ title?: unknown }>()
      if (typeof body.title === 'string' && body.title.trim()) return body.title.trim()
    }
  } catch (error) {
    runtime.walnut.log.info('Spotify did not name the playlist', { uri, error: String(error) })
  }
  return 'Spotify playlist'
}

/** Show the focus music folder in Finder (Mac only, from the App). */
export async function musicFolderOpen(runtime: RhythmRuntime): Promise<{ message: string }> {
  if (process.platform !== 'darwin') throw new Error('Opening the folder works on a Mac only.')
  const target = musicFolder(runtime)
  if (target.error) throw new Error(target.error)
  if (target.isDefault) await fsp.mkdir(target.folder, { recursive: true })
  const result = await runProcess('open', [target.folder], { timeoutMs: 10_000 })
  if (!result.ok) throw new Error(`Finder could not open ${target.folder}: ${result.error ?? 'unknown error'}`)
  return { message: `Opened ${target.folder} in Finder. Music you add there shows up here.` }
}
