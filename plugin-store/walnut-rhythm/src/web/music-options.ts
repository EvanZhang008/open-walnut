/** The choices the music list offers, and the key that names one. PURE: no React, so tests load it. */
import type { MusicTracksResult, StartChoice } from './music'

export interface MusicOption {
  choice: StartChoice
  title: string
  meta: string
  /** Starred by the person: it sits on top. */
  starred: boolean
}

export function choiceKey(choice: StartChoice): string {
  return choice.kind === 'none' ? 'none' : choice.kind === 'track' ? `track:${choice.id}` : `spotify:${choice.uri}`
}

/**
 * Every choice the list offers, in order. PURE. No music first, then the starred sounds
 * (in the list's own order), then the rest.
 */
export function musicOptions(listing: MusicTracksResult | null, starred: readonly string[] = []): MusicOption[] {
  const spotify = listing?.spotify
  const stars = new Set(starred)
  const sounds: MusicOption[] = [
    ...(listing?.tracks ?? []).map((track) => ({ choice: { kind: 'track', id: track.id } as StartChoice, title: track.title, meta: 'Plays on this device', starred: false })),
    ...(spotify?.available ? spotify.playlists.map((one) => ({ choice: { kind: 'spotify', uri: one.uri } as StartChoice, title: one.name, meta: 'Spotify, plays on your Mac', starred: false })) : []),
  ].map((option) => ({ ...option, starred: stars.has(choiceKey(option.choice)) }))
  return [
    { choice: { kind: 'none' }, title: 'No music', meta: 'Silent', starred: false },
    ...sounds.filter((one) => one.starred),
    ...sounds.filter((one) => !one.starred),
  ]
}

/** The server's stars with the clicks still on their way laid over them. PURE. */
export function starredNow(server: readonly string[], pending: ReadonlyMap<string, boolean>): string[] {
  const out = server.filter((key) => pending.get(key) !== false)
  for (const [key, on] of pending) if (on && !out.includes(key)) out.push(key)
  return out
}
