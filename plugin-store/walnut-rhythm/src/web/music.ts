/**
 * The focus music player: ONE audio element for the whole console, made when the plugin
 * activates, so the music keeps playing while the person moves between screens.
 *
 * Playback belongs to the device that clicked. A focus block started elsewhere (an agent,
 * the phone) never starts sound here: two windows would play over each other, and a
 * browser refuses sound nobody clicked for anyway. Music started with a block, or while
 * one runs, is tied to it and stops when the block ends or is stopped; music started
 * while idle plays until it is stopped.
 *
 * Tracks are the person's own files on the Mac (`music_tracks`), streamed through
 * Walnut's raw file route, which answers byte ranges, so an 8 hour file starts at once.
 * Track, order and volume are this device's choice, kept in localStorage, and so is what
 * Start plays (`startChoice`): a track here, a Spotify playlist on the Mac, or nothing.
 */
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'
import type { MusicTracksResult } from '../server/actions'
import type { MusicListing, MusicTrack } from '../server/music'
import type { SpotifyPlaylist, SpotifyView } from '../server/spotify'
import type { RhythmStore } from './store'

export type { MusicListing, MusicTrack, MusicTracksResult, SpotifyPlaylist, SpotifyView }
export type MusicOrder = 'one' | 'in_order' | 'shuffle'

/** What Start plays on this device: a folder track here, a Spotify playlist in the Mac's Spotify, or nothing. */
export type StartChoice = { kind: 'none' } | { kind: 'track'; id: string } | { kind: 'spotify'; uri: string }

function choiceOf(raw: unknown): StartChoice | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (value.kind === 'none') return { kind: 'none' }
  if (value.kind === 'track' && typeof value.id === 'string' && value.id) return { kind: 'track', id: value.id }
  if (value.kind === 'spotify' && typeof value.uri === 'string' && value.uri.startsWith('spotify:')) return { kind: 'spotify', uri: value.uri }
  return undefined
}

/**
 * What Start plays now. PURE. The device's own pick when it still exists; else, the first
 * time, the setting (`music_with_focus`) decides between the current track and nothing.
 * A track that left the folder falls back to the current one, a playlist that is gone (or
 * a Mac without Spotify) to nothing: never a choice the Start button cannot keep.
 */
export function resolveStartChoice(input: {
  stored: StartChoice | undefined
  listing: MusicTracksResult | null
  trackId: string | null
  withFocus: boolean
}): StartChoice {
  const tracks = input.listing?.tracks ?? []
  const current = tracks.find((track) => track.id === input.trackId) ?? tracks[0]
  const stored = input.stored
  if (stored?.kind === 'none') return stored
  if (stored?.kind === 'track') {
    if (!input.listing || tracks.some((track) => track.id === stored.id)) return stored
    return current ? { kind: 'track', id: current.id } : { kind: 'none' }
  }
  if (stored?.kind === 'spotify') {
    const spotify = input.listing?.spotify
    if (!input.listing) return stored
    return spotify?.available && spotify.playlists.some((one) => one.uri === stored.uri) ? stored : { kind: 'none' }
  }
  return input.withFocus && current ? { kind: 'track', id: current.id } : { kind: 'none' }
}

export interface MusicView {
  listing: MusicTracksResult | null
  loading: boolean
  loadError: string | null
  /** The track playing, or the one Play would start. */
  trackId: string | null
  playing: boolean
  /** Asked to play, waiting for the first sound. */
  starting: boolean
  order: MusicOrder
  /** 0 to 1. */
  volume: number
  /** Stops when the focus block ends. */
  tiedToFocus: boolean
  error: string | null
  /** This device's own pick for Start; resolve it with `resolveStartChoice`. Absent until one is made. */
  startChoice?: StartChoice
}

export interface MusicPlayer {
  get(): MusicView
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  /** Play when stopped, stop when playing. Call it from the click itself. */
  toggle(): void
  /**
   * `withFocus`: a Start button's click; the block it starts owns the music. Answers this
   * play's number, so a caller undoing it later (a refused Start) never stops a newer one.
   */
  play(options?: { trackId?: string; withFocus?: boolean }): number
  /** With `onlyPlay`, stops only when that play is still the current one. */
  stop(onlyPlay?: number): void
  select(trackId: string): void
  setOrder(order: MusicOrder): void
  setVolume(volume: number): void
  /** What Start plays on this device from now on. */
  setStartChoice(choice: StartChoice): void
  /** The Spotify list changed (a playlist added or removed). */
  setSpotify(spotify: SpotifyView): void
}

const PREFS_KEY = 'walnut-rhythm:music'
const DEFAULT_VOLUME = 0.6

/** Where the next track starts once one ends. PURE. `random` is in [0, 1). */
export function nextTrackIndex(order: MusicOrder, current: number, count: number, random: number): number {
  if (count <= 0) return -1
  if (order === 'one' || count === 1) return Math.max(0, Math.min(current, count - 1))
  if (order === 'in_order') return (current + 1) % count
  // Shuffle never repeats the track that just ended.
  const pick = Math.floor(random * (count - 1))
  return pick >= current ? pick + 1 : pick
}

/** The raw route's path shape, one encoded segment per path part (spaces, `#`, `?` survive). */
export function trackUrl(file: string): string {
  const segments = file.split('/').filter((segment, index) => index > 0 || segment.length > 0)
  return `/api/file-raw/local/${segments.map(encodeURIComponent).join('/')}`
}

function readPrefs(): { trackId?: string; order?: MusicOrder; volume?: number; startChoice?: StartChoice } {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    return {
      ...(typeof parsed.trackId === 'string' ? { trackId: parsed.trackId } : {}),
      ...(parsed.order === 'one' || parsed.order === 'in_order' || parsed.order === 'shuffle' ? { order: parsed.order } : {}),
      ...(typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1 ? { volume: parsed.volume } : {}),
      ...(choiceOf(parsed.startChoice) ? { startChoice: choiceOf(parsed.startChoice) } : {}),
    }
  } catch {
    return {}
  }
}

function mediaErrorText(audio: HTMLAudioElement): string {
  switch (audio.error?.code) {
    case 2: return 'the network dropped while loading it'
    case 3: return 'it could not be decoded'
    case 4: return 'the file is missing or in a format this browser cannot play'
    default: return 'it could not be played'
  }
}

export function createMusicPlayer(walnut: WalnutWebApi, store: RhythmStore): MusicPlayer {
  const prefs = readPrefs()
  let view: MusicView = {
    listing: null,
    loading: false,
    loadError: null,
    trackId: prefs.trackId ?? null,
    playing: false,
    starting: false,
    order: prefs.order ?? 'one',
    volume: prefs.volume ?? DEFAULT_VOLUME,
    tiedToFocus: false,
    error: null,
    ...(prefs.startChoice ? { startChoice: prefs.startChoice } : {}),
  }
  // 'pending': a Start click asked for the block; the next state that shows it running confirms the tie.
  let tie: 'none' | 'pending' | 'focus' = 'none'
  let folderSetting: string | null = null
  let refreshing: Promise<void> | null = null
  let playNumber = 0
  // Set right before a pause this player makes itself, so the pause listener can tell it from one the system made.
  let ownPause = false
  const listeners = new Set<() => void>()
  const audio = new Audio()
  audio.preload = 'none'
  audio.volume = view.volume

  const publish = (patch: Partial<MusicView>) => {
    view = { ...view, ...patch, tiedToFocus: tie !== 'none' }
    for (const listener of [...listeners]) listener()
  }
  const savePrefs = () => {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ trackId: view.trackId, order: view.order, volume: view.volume, ...(view.startChoice ? { startChoice: view.startChoice } : {}) }))
    } catch {
      // Private mode or a full quota: the choice lasts for this window only.
    }
  }
  const tracks = (): MusicTrack[] => view.listing?.tracks ?? []
  const currentIndex = () => Math.max(0, tracks().findIndex((track) => track.id === view.trackId))
  const applyLoop = () => { audio.loop = view.order === 'one' || tracks().length === 1 }

  const setMediaSession = (track: MusicTrack | null) => {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
    if (!session) return
    try {
      session.metadata = track && typeof MediaMetadata === 'function' ? new MediaMetadata({ title: track.title, artist: 'Rhythm focus music' }) : null
      session.playbackState = track ? 'playing' : 'none'
    } catch {
      // Media Session is a nicety; a browser without part of it still plays.
    }
  }

  const startTrack = (track: MusicTrack) => {
    playNumber += 1
    const url = trackUrl(track.file)
    // An element that failed (a missing file, a dropped connection) loads again from scratch.
    if (audio.error || !audio.src.endsWith(url)) {
      if (!audio.paused) ownPause = true
      audio.src = url
    }
    applyLoop()
    audio.volume = view.volume
    publish({ trackId: track.id, starting: true, error: null })
    savePrefs()
    // Called inside the click: Safari and the Mac app only allow sound a person asked for.
    audio.play().then(() => {
      publish({ playing: true, starting: false })
      setMediaSession(track)
    }, (failure: unknown) => {
      const name = (failure as { name?: string }).name
      if (name === 'AbortError') return // a Stop or another track replaced this play
      tie = 'none'
      publish({
        playing: false,
        starting: false,
        error: name === 'NotAllowedError'
          ? 'This window blocked the sound. Click Play to start it.'
          : `Could not play ${track.title}: ${failure instanceof Error ? failure.message : String(failure)}`,
      })
    })
  }

  const stop = (onlyPlay?: number) => {
    if (onlyPlay !== undefined && onlyPlay !== playNumber) return
    playNumber += 1
    tie = 'none'
    if (!audio.paused) ownPause = true
    audio.pause()
    publish({ playing: false, starting: false })
    setMediaSession(null)
  }

  const play = (options: { trackId?: string; withFocus?: boolean } = {}) => {
    const list = tracks()
    const wanted = options.trackId ?? view.trackId
    const track = list.find((one) => one.id === wanted) ?? list[0]
    const phase = store.get()?.focus.phase
    if (options.withFocus) tie = 'pending'
    else if (phase === 'focus') tie = 'focus'
    // Switching tracks while a Start is still being answered keeps the tie it asked for.
    else if (tie !== 'pending') tie = 'none'
    if (!track) {
      tie = 'none'
      publish({ error: view.listing ? 'There is no music in the folder yet. Add an m4a, mp3 or wav file, then Refresh.' : 'The music list has not loaded yet.' })
      if (!view.listing) void refresh()
      return playNumber
    }
    startTrack(track)
    return playNumber
  }

  async function load(): Promise<void> {
    publish({ loading: true })
    const outcome = await store.call<MusicTracksResult>('music_tracks')
    if (!outcome.ok) {
      publish({ loading: false, loadError: outcome.message })
      return
    }
    const listing = outcome.result
    const keep = listing.tracks.some((track) => track.id === view.trackId)
    publish({ listing, loading: false, loadError: null, trackId: keep ? view.trackId : listing.tracks[0]?.id ?? null })
    applyLoop()
  }

  function refresh(): Promise<void> {
    refreshing ??= load().finally(() => { refreshing = null })
    return refreshing
  }

  audio.addEventListener('ended', () => {
    const list = tracks()
    const next = nextTrackIndex(view.order, currentIndex(), list.length, Math.random())
    if (next < 0) { stop(); return }
    startTrack(list[next]!)
  })
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return
    const title = tracks().find((track) => track.id === view.trackId)?.title ?? 'the track'
    tie = 'none'
    publish({ playing: false, starting: false, error: `Could not play ${title}: ${mediaErrorText(audio)}.` })
    setMediaSession(null)
  })

  // A pause the system made (headphones out, another app taking the sound) is a stop, so the button says Play again.
  audio.addEventListener('pause', () => {
    if (ownPause) { ownPause = false; return }
    if (audio.ended || (!view.playing && !view.starting)) return
    tie = 'none'
    publish({ playing: false, starting: false })
    setMediaSession(null)
  })
  audio.addEventListener('playing', () => { ownPause = false })

  // Media keys and Control Center call these instead of pausing the element behind our back.
  const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
  const mediaActions = (on: boolean) => {
    try {
      session?.setActionHandler('play', on ? () => { play() } : null)
      session?.setActionHandler('pause', on ? () => stop() : null)
      session?.setActionHandler('stop', on ? () => stop() : null)
    } catch {
      // An action this browser does not know.
    }
  }
  mediaActions(true)

  // The block owns music started with it: when it ends, stops or turns into its break, so does the music.
  const offStore = store.subscribe(() => {
    const state = store.get()
    if (!state) return
    if (tie === 'pending' && state.focus.phase === 'focus') tie = 'focus'
    else if (tie === 'focus' && state.focus.phase !== 'focus') stop()
    // A new folder in the settings is a new list.
    const setting = state.config.musicFolder ?? ''
    if (folderSetting === null) folderSetting = setting
    else if (setting !== folderSetting) {
      folderSetting = setting
      void refresh()
    }
  })

  walnut.signal.addEventListener('abort', () => {
    offStore()
    mediaActions(false)
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    setMediaSession(null)
  }, { once: true })

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh,
    toggle() { if (view.playing || view.starting) stop(); else play() },
    play,
    stop,
    select(trackId) {
      // Picking a track while Start plays a track makes it the one Start plays too.
      if (view.startChoice?.kind === 'track') { publish({ startChoice: { kind: 'track', id: trackId } }); savePrefs() }
      if (view.playing || view.starting) play({ trackId })
      else { publish({ trackId, error: null }); savePrefs() }
    },
    setStartChoice(choice) {
      publish({ startChoice: choice, ...(choice.kind === 'track' ? { trackId: choice.id } : {}), error: null })
      savePrefs()
    },
    setSpotify(spotify) {
      if (view.listing) publish({ listing: { ...view.listing, spotify } })
    },
    setOrder(order) {
      publish({ order })
      applyLoop()
      savePrefs()
    },
    setVolume(volume) {
      const clamped = Math.min(1, Math.max(0, volume))
      audio.volume = clamped
      publish({ volume: clamped })
      savePrefs()
    },
  }
}
