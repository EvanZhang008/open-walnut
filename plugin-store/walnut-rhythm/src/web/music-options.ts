/** The choices the music list offers, and the key that names one. PURE: no React, so tests load it. */
import type { MusicTracksResult, StartChoice } from './music'

export interface MusicOption {
  choice: StartChoice
  title: string
  meta: string
}

export function choiceKey(choice: StartChoice): string {
  return choice.kind === 'none' ? 'none' : choice.kind === 'track' ? `track:${choice.id}` : `spotify:${choice.uri}`
}

/** Every choice the list offers, in order. PURE. */
export function musicOptions(listing: MusicTracksResult | null): MusicOption[] {
  const spotify = listing?.spotify
  return [
    { choice: { kind: 'none' }, title: 'No music', meta: 'Silent' },
    ...(listing?.tracks ?? []).map((track) => ({ choice: { kind: 'track', id: track.id } as StartChoice, title: track.title, meta: 'Plays on this device' })),
    ...(spotify?.available ? spotify.playlists.map((one) => ({ choice: { kind: 'spotify', uri: one.uri } as StartChoice, title: one.name, meta: 'Spotify, plays on your Mac' })) : []),
  ]
}
