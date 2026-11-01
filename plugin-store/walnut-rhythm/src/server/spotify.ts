/**
 * Spotify as a focus music source, on the Mac only: Start plays a playlist in the
 * person's own Spotify app, and the block's end (or Stop) pauses it again.
 *
 * Rhythm never downloads or streams Spotify audio itself. It drives the installed app
 * through its supported AppleScript commands (`play track "<spotify uri>"`, `pause`,
 * `player state`), so playback, sign-in and the person's account stay Spotify's. The
 * URI is checked against a strict pattern before it goes into a script, so a pasted
 * link can never carry anything else into `osascript`.
 *
 * The playlists the person picked live in `spotify.json` in the plugin's storage;
 * Deep Focus is there until they remove it.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { StorageService } from '@open-walnut/plugin-api/server'
import type { Runner } from './exec'

export interface SpotifyPlaylist {
  uri: string
  name: string
}

export interface SpotifyView {
  /** On a Mac with Spotify installed. */
  available: boolean
  /** Why it is not, in words for the person; absent when available. */
  reason?: string
  playlists: SpotifyPlaylist[]
}

export const DEFAULT_PLAYLISTS: SpotifyPlaylist[] = [
  { uri: 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ', name: 'Deep Focus' },
]
export const MAX_PLAYLISTS = 20
const FILE = 'spotify.json'
const URI = /^spotify:(playlist|album|artist|show|track):[A-Za-z0-9]{8,40}$/
const LINK = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?\/)?(playlist|album|artist|show|track)\/([A-Za-z0-9]{8,40})(?:[/?#].*)?$/
const SCRIPT_TIMEOUT_MS = 15_000
const PLAY_CHECKS = 4
const PLAY_CHECK_MS = 1_000

/** A pasted Spotify link or URI → the URI, or null when it is neither. */
export function spotifyUriOf(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (URI.test(raw)) return raw
  const link = LINK.exec(raw)
  return link ? `spotify:${link[1]}:${link[2]}` : null
}

export function spotifyWebUrl(uri: string): string {
  const [, kind, id] = uri.split(':')
  return `https://open.spotify.com/${kind}/${id}`
}

function scriptError(error: string | undefined): string {
  const text = error ?? 'unknown error'
  if (/-1743|not authori[sz]ed/i.test(text)) {
    return 'macOS has not allowed Walnut to control Spotify. Allow it in System Settings, Privacy & Security, Automation, then start again.'
  }
  if (/-1728|-600|can.t get application|isn.t running/i.test(text)) return 'Spotify did not open. Open it once on this Mac, then start again.'
  return `Spotify did not answer: ${text}`
}

export interface SpotifyDeps {
  enabled: boolean
  run: Runner
  storage: Pick<StorageService, 'readJson' | 'writeJson'>
  /** Where Spotify.app may be installed; checked in order. */
  appPaths?: string[]
  exists?: (file: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
}

export class SpotifyControl {
  private readonly deps: SpotifyDeps
  // Every play and pause lands in the order it was asked for: a preview's play still opening
  // Spotify never lands after the pick or the stop that came after it.
  private queue: Promise<unknown> = Promise.resolve()
  private readonly appPaths: string[]
  private readonly exists: (file: string) => Promise<boolean>
  private readonly sleep: (ms: number) => Promise<void>

  constructor(deps: SpotifyDeps) {
    this.deps = deps
    this.appPaths = deps.appPaths ?? ['/Applications/Spotify.app', path.join(os.homedir(), 'Applications', 'Spotify.app')]
    this.exists = deps.exists ?? (async (file) => fsp.stat(file).then(() => true, () => false))
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async playlists(): Promise<SpotifyPlaylist[]> {
    const stored = await this.deps.storage.readJson<{ playlists?: unknown }>(FILE, {})
    if (!Array.isArray(stored.playlists)) return DEFAULT_PLAYLISTS.map((one) => ({ ...one }))
    return stored.playlists
      .filter((one): one is SpotifyPlaylist => !!one && typeof (one as SpotifyPlaylist).uri === 'string' && URI.test((one as SpotifyPlaylist).uri))
      .map((one) => ({ uri: one.uri, name: typeof one.name === 'string' && one.name.trim() ? one.name.trim().slice(0, 80) : 'Spotify playlist' }))
      .slice(0, MAX_PLAYLISTS)
  }

  async view(): Promise<SpotifyView> {
    const playlists = await this.playlists()
    if (!this.deps.enabled) return { available: false, reason: 'Spotify plays on a Mac only.', playlists }
    for (const app of this.appPaths) if (await this.exists(app)) return { available: true, playlists }
    return { available: false, reason: 'Spotify is not installed on this Mac. Install it and sign in to play a playlist with a block.', playlists }
  }

  /** Add (or rename) one; the newest comes right after the ones already there. */
  async add(uri: string, name: string): Promise<SpotifyPlaylist[]> {
    const list = (await this.playlists()).filter((one) => one.uri !== uri)
    if (list.length >= MAX_PLAYLISTS) throw new Error(`Rhythm keeps at most ${MAX_PLAYLISTS} Spotify playlists. Remove one first.`)
    const next = [...list, { uri, name: name.trim().slice(0, 80) || 'Spotify playlist' }]
    await this.deps.storage.writeJson(FILE, { playlists: next })
    return next
  }

  async remove(uri: string): Promise<SpotifyPlaylist[]> {
    const next = (await this.playlists()).filter((one) => one.uri !== uri)
    await this.deps.storage.writeJson(FILE, { playlists: next })
    return next
  }

  private inOrder<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Play `uri` and wait until Spotify says it plays. Opens Spotify when it is closed. */
  play(uri: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.inOrder(() => this.playNow(uri))
  }

  private async playNow(uri: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!URI.test(uri)) return { ok: false, error: 'That is not a Spotify playlist link.' }
    const view = await this.view()
    if (!view.available) return { ok: false, error: view.reason ?? 'Spotify is not available.' }
    const played = await this.osascript(`tell application "Spotify" to play track "${uri}"`)
    if (!played.ok) return { ok: false, error: scriptError(played.error) }
    for (let check = 0; check < PLAY_CHECKS; check++) {
      const state = await this.osascript('tell application "Spotify" to player state as string')
      if (state.ok && state.stdout.trim() === 'playing') return { ok: true }
      await this.sleep(PLAY_CHECK_MS)
    }
    return { ok: false, error: 'Spotify did not start playing. Open Spotify, make sure you are signed in, then start again.' }
  }

  /** Pause, but never open Spotify just to pause it. */
  pause(): Promise<void> {
    if (!this.deps.enabled) return Promise.resolve()
    return this.inOrder(async () => { await this.osascript('if application "Spotify" is running then tell application "Spotify" to pause') })
  }

  private osascript(script: string) {
    return this.deps.run('osascript', ['-e', script], { timeoutMs: SCRIPT_TIMEOUT_MS })
  }
}
