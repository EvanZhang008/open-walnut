/**
 * The running block's music, as the popover and the App say it: what plays now (a track
 * only while it sounds here, else the block's Spotify playlist, else nothing), the line
 * that says so, and the choices the list offers.
 */
import { describe, expect, it } from 'vitest'
import { musicOptions } from '../../../plugin-store/walnut-rhythm/src/web/music-options'
import { currentMusic, nowPlayingLine } from '../../../plugin-store/walnut-rhythm/src/web/now-playing-model'
import type { MusicTracksResult } from '../../../plugin-store/walnut-rhythm/src/web/music'

const DEEP = 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ'
const listing = (available = true): MusicTracksResult => ({
  folder: '/music',
  tracks: [{ id: '01 Brown Noise.m4a', title: 'Brown Noise', file: '/music/01 Brown Noise.m4a' }],
  withFocus: true,
  spotify: { available, playlists: [{ uri: DEEP, name: 'Deep Focus' }], ...(available ? {} : { reason: 'Spotify plays on a Mac only.' }) },
} as unknown as MusicTracksResult)
const focus = (spotifyUri?: string) => ({ focus: { phase: 'focus', ...(spotifyUri ? { spotifyUri } : {}) } }) as never

describe('the running block\'s music', () => {
  it('a track counts only while it plays here; else the block\'s playlist; else nothing', () => {
    expect(currentMusic({ playing: true, starting: false, trackId: '01 Brown Noise.m4a' }, focus(DEEP))).toEqual({ kind: 'track', id: '01 Brown Noise.m4a' })
    expect(currentMusic({ playing: false, starting: true, trackId: '01 Brown Noise.m4a' }, focus())).toEqual({ kind: 'track', id: '01 Brown Noise.m4a' })
    expect(currentMusic({ playing: false, starting: false, trackId: '01 Brown Noise.m4a' }, focus(DEEP))).toEqual({ kind: 'spotify', uri: DEEP })
    expect(currentMusic({ playing: false, starting: false, trackId: '01 Brown Noise.m4a' }, focus())).toEqual({ kind: 'none' })
  })

  it('says plainly what plays and where', () => {
    expect(nowPlayingLine({ kind: 'track', id: '01 Brown Noise.m4a' }, listing(), true)).toBe('Playing Brown Noise on this device until the block ends.')
    expect(nowPlayingLine({ kind: 'track', id: '01 Brown Noise.m4a' }, listing(), false)).toBe('Playing Brown Noise on this device.')
    expect(nowPlayingLine({ kind: 'spotify', uri: DEEP }, listing(), true)).toBe('Deep Focus is playing in Spotify on your Mac until the block ends.')
    expect(nowPlayingLine({ kind: 'none' }, listing(), true)).toBe('No music is playing.')
  })

  it('offers No music, the tracks, and the playlists only where Spotify is', () => {
    expect(musicOptions(listing()).map((one) => one.title)).toEqual(['No music', 'Brown Noise', 'Deep Focus'])
    expect(musicOptions(listing(false)).map((one) => one.title)).toEqual(['No music', 'Brown Noise'])
    expect(musicOptions(null).map((one) => one.title)).toEqual(['No music'])
  })
})
