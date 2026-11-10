/** What the running block plays, in words. PURE: no React, so tests load it. */
import type { MusicTracksResult, MusicView, StartChoice } from './music'
import type { RhythmPublicState } from './store'

/** What plays for the block now, as a choice. PURE. A track counts only while it plays (or is paused) here. */
export function currentMusic(view: Pick<MusicView, 'playing' | 'starting' | 'trackId'> & { paused?: boolean }, state: Pick<RhythmPublicState, 'focus'>): StartChoice {
  if ((view.playing || view.starting || view.paused) && view.trackId) return { kind: 'track', id: view.trackId }
  if (state.focus.spotifyUri) return { kind: 'spotify', uri: state.focus.spotifyUri }
  return { kind: 'none' }
}

/** Whether the block's music is paused now. PURE. A track pauses here; a playlist on the Mac. */
export function musicPaused(choice: StartChoice, view: { paused?: boolean }, state: Pick<RhythmPublicState, 'focus'>): boolean {
  if (choice.kind === 'track') return view.paused === true
  if (choice.kind === 'spotify') return state.focus.musicPaused === true
  return false
}

/** "Playing Brown Noise on this device until the block ends." PURE. */
export function nowPlayingLine(choice: StartChoice, listing: MusicTracksResult | null, tiedToFocus: boolean, paused = false): string {
  if (choice.kind === 'none') return 'No music is playing.'
  if (choice.kind === 'track') {
    const title = listing?.tracks.find((track) => track.id === choice.id)?.title ?? 'the focus music'
    if (paused) return `${title} is paused. The block runs on.`
    return `Playing ${title} on this device${tiedToFocus ? ' until the block ends' : ''}.`
  }
  const name = listing?.spotify.playlists.find((one) => one.uri === choice.uri)?.name ?? 'A Spotify playlist'
  if (paused) return `${name} is paused in Spotify on your Mac. The block runs on.`
  return `${name} is playing in Spotify on your Mac until the block ends.`
}
