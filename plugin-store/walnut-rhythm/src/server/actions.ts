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
import { runProcess } from './exec'
import { startFocus, stopFocus, skipBreak, advanceFocus } from './focus'
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
  const spotifyUri = args.spotify === undefined || args.spotify === null || args.spotify === '' ? null : spotifyUriOf(args.spotify)
  if (args.spotify !== undefined && args.spotify !== null && args.spotify !== '' && !spotifyUri) {
    throw new Error('That is not a Spotify link. Paste a playlist link from Spotify (Share, Copy link).')
  }
  const started = await startBlock(runtime, args, spotifyUri)
  if (!spotifyUri) return started
  // After the block is on: Spotify can take a few seconds to open, and the block must not wait for it.
  const startedAt = runtime.focus.startedAt
  const played = await runtime.spotify.play(spotifyUri)
  await runtime.serial(async () => {
    const same = runtime.focus.phase === 'focus' && runtime.focus.startedAt === startedAt
    // Stopped (or ended) while Spotify was opening: its pause ran before this play landed.
    if (!same && played.ok) await runtime.spotify.pause()
    // A playlist that never played is not the block's to pause at its end.
    if (same && !played.ok) {
      const { spotifyUri: _unplayed, ...rest } = runtime.focus
      runtime.focus = rest
      runtime.markDirty()
      await runtime.step()
    }
  })
  const name = (await runtime.spotify.playlists()).find((one) => one.uri === spotifyUri)?.name ?? 'the playlist'
  return {
    message: played.ok ? `${started.message} Spotify is playing ${name} on this Mac.` : `${started.message} ${played.error}`,
    state: buildPublicState(runtime, runtime.now()),
    ...(played.ok ? {} : { spotifyError: played.error }),
  }
}

function startBlock(runtime: RhythmRuntime, args: Record<string, unknown>, spotifyUri: string | null): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const taskId = str(args.taskId)
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
    runtime.focus = startFocus(runtime.focus, { now, minutes, breakMinutes, ...(spotifyUri ? { spotifyUri } : {}), ...(taskId ? { taskId } : {}), ...(title ? { title } : {}) })
    runtime.markDirty()
    // A Start form's pick is the next block's default: the settings themselves, so every
    // surface, the Settings form and an agent's plain "start a block" read the same numbers.
    if (args.remember === true) await rememberLengths(runtime, minutes, breakMinutes || runtime.config.breakMinutes)
    await runtime.dismiss(KEY_FOCUS_DONE)
    await runtime.dismiss(KEY_BREAK_OVER)
    if (runtime.config.macosFocusShortcuts) runtime.macos.setDoNotDisturb(true, runtime.now)
    const d = runtime.durations()
    const long = d.longBreakEvery > 0 && (runtime.focus.completedInCycle + 1) % d.longBreakEvery === 0
    const then = long ? `then the ${d.longBreakMinutes} min long break` : `then a ${breakMinutes || d.breakMinutes} min break`
    return finish(runtime, `Focus block started: ${minutes} min${title ? ` on ${title}` : ''}, ${then}.`)
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

export function focusStop(runtime: RhythmRuntime): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const was = runtime.focus.phase
    const stopped = stopFocus(runtime.focus, runtime.now())
    runtime.focus = stopped.state
    runtime.markDirty()
    if (stopped.stoppedMinutes !== null) runtime.recordDay({ type: 'stopped' })
    if (was === 'focus' && runtime.focus.spotifyUri) void runtime.spotify.pause()
    if (was === 'focus' && runtime.config.macosFocusShortcuts) {
      runtime.macos.setDoNotDisturb(false, runtime.now)
      runtime.macos.assumeDoNotDisturbOff(runtime.now())
    }
    await runtime.dismiss(KEY_FOCUS_DONE)
    await runtime.dismiss(KEY_BREAK_OVER)
    const message = was === 'idle'
      ? 'Rhythm is off. It starts when you press Start.'
      : was === 'focus' ? `Focus block stopped after ${stopped.stoppedMinutes ?? 0} min. Rhythm is off.` : 'Stopped. Rhythm is off.'
    return finish(runtime, message)
  })
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
    } else if (runtime.config.macosFocusShortcuts) await runtime.macos.checkShortcuts(now)
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
      ? `Shortcuts opened ${opened} Add Shortcut ${opened === 1 ? 'dialog' : 'dialogs'}. Click Add Shortcut in each.`
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
