/**
 * The running block's music: what plays now, in plain words, a Pause / Resume button,
 * and the same list as the Start form to switch it (No music included) without stopping
 * the block. A folder track starts (and pauses, and resumes) here inside the click; a
 * Spotify playlist plays on the Mac (`focus_music`, `focus_music_pause`), and leaving
 * Spotify pauses it there.
 */
import { useRef, useState } from 'react'
import type { MusicPlayer, StartChoice } from './music'
import { choiceKey, MusicPicker } from './music-picker'
import { currentMusic, musicPaused, nowPlayingLine } from './now-playing-model'
import { useMusic } from './music-card'
import { useMusicList } from './start-form'
import type { OpOutcome, RhythmPublicState, RhythmStore } from './store'

/**
 * Switch the block's music. Call it from the click itself (a track plays only then).
 * The pick is also what the next Start plays here.
 */
export function switchMusic(input: { store: RhythmStore; music: MusicPlayer; choice: StartChoice }): Promise<OpOutcome<{ message: string; spotifyError?: string }>> {
  const { store, music, choice } = input
  // focus_music below ends a Spotify preview on the server itself.
  music.stopPreview(undefined, true)
  music.setStartChoice(choice)
  if (choice.kind === 'track') music.play({ trackId: choice.id })
  else if (music.get().playing || music.get().starting || music.get().paused) music.stop()
  // Always told, so a Spotify the block plays (or one still starting) pauses for a track or for nothing.
  return store.call('focus_music', { spotify: choice.kind === 'spotify' ? choice.uri : '' })
}

export function NowPlaying({ store, music, state, compact }: { store: RhythmStore; music: MusicPlayer; state: RhythmPublicState; compact?: boolean }) {
  const view = useMusic(music)
  useMusicList(music)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)
  const current = currentMusic(view, state)
  const paused = musicPaused(current, view, state)
  const [pausing, setPausing] = useState(false)
  const togglePause = () => {
    setError(null)
    if (current.kind === 'track') {
      // Inside the click: a browser plays sound only then.
      if (paused) music.resume(); else music.pause()
      return
    }
    if (current.kind !== 'spotify' || pausing) return
    setPausing(true)
    void store.call<{ spotifyError?: string }>('focus_music_pause', { paused: !paused }).then((outcome) => {
      setPausing(false)
      const failure = outcome.ok ? outcome.result.spotifyError : outcome.message
      if (failure) setError(failure)
    })
  }
  const pick = (choice: StartChoice) => {
    // The music already playing keeps its place; picked while paused, it plays on.
    if (choiceKey(choice) === choiceKey(current)) { music.stopPreview(); if (paused) togglePause(); return }
    setError(null)
    const number = ++latest.current
    void switchMusic({ store, music, choice }).then((outcome) => {
      if (number !== latest.current) return
      const failure = outcome.ok ? outcome.result.spotifyError : outcome.message
      if (failure) setError(failure)
    })
  }
  return (
    <div className={`rhythm-now-playing${compact ? ' rhythm-now-compact' : ''}`} data-testid="rhythm-now-playing">
      <div className="rhythm-now-head">
        <p className="rhythm-start-plays" data-testid="rhythm-now-playing-line">{nowPlayingLine(current, view.listing, view.tiedToFocus, paused)}</p>
        {current.kind !== 'none' && (
          <button
            type="button"
            className="rhythm-button rhythm-pause"
            aria-pressed={paused}
            aria-busy={pausing || undefined}
            disabled={pausing}
            data-testid="rhythm-now-pause"
            onClick={togglePause}
          >
            {pausing ? (paused ? 'Resuming…' : 'Pausing…') : paused ? 'Resume' : 'Pause'}
          </button>
        )}
      </div>
      <span className="rhythm-start-label" id="rhythm-now-music-label">Switch the music</span>
      <MusicPicker music={music} store={store} value={current} onPick={pick} testId="rhythm-now-music" />
      {error && <p className="rhythm-error" role="status" data-testid="rhythm-now-playing-error">{error}</p>}
    </div>
  )
}
