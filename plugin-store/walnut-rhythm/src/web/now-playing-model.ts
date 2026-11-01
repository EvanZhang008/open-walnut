/** What the running block plays, in words. PURE: no React, so tests load it. */
import type { MusicTracksResult, MusicView, StartChoice } from './music'
import type { RhythmPublicState } from './store'

/** What plays for the block now, as a choice. PURE. A track counts only while it plays here. */
export function currentMusic(view: Pick<MusicView, 'playing' | 'starting' | 'trackId'>, state: Pick<RhythmPublicState, 'focus'>): StartChoice {
  if ((view.playing || view.starting) && view.trackId) return { kind: 'track', id: view.trackId }
  if (state.focus.spotifyUri) return { kind: 'spotify', uri: state.focus.spotifyUri }
  return { kind: 'none' }
}

/** "Playing Brown Noise on this device until the block ends." PURE. */
export function nowPlayingLine(choice: StartChoice, listing: MusicTracksResult | null, tiedToFocus: boolean): string {
  if (choice.kind === 'none') return 'No music is playing.'
  if (choice.kind === 'track') {
    const title = listing?.tracks.find((track) => track.id === choice.id)?.title ?? 'the focus music'
    return `Playing ${title} on this device${tiedToFocus ? ' until the block ends' : ''}.`
  }
  const name = listing?.spotify.playlists.find((one) => one.uri === choice.uri)?.name ?? 'A Spotify playlist'
  return `${name} is playing in Spotify on your Mac until the block ends.`
}
