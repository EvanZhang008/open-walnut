/**
 * The music list the Start form and the running block share: No music, the folder's
 * tracks (they play on this device) and the Spotify playlists (they play on the Mac).
 * Each choice has a Preview button, so the person hears a few seconds before picking it;
 * another preview or the list closing ends it, and `onPick` ends it as its op needs.
 */
import { useEffect, useRef } from 'react'
import type { MusicPlayer, StartChoice } from './music'
import { useMusic } from './music-card'
import { choiceKey, musicOptions } from './music-options'

export { choiceKey, musicOptions }

export function MusicPicker({ music, value, onPick, testId }: {
  music: MusicPlayer
  value: StartChoice
  onPick(choice: StartChoice): void
  testId: string
}) {
  const view = useMusic(music)
  // This list's own previews: another list closing never ends them, and this one closing does.
  const owner = useRef({}).current
  useEffect(() => () => music.stopPreview(owner), [music, owner])
  const listing = view.listing
  const spotify = listing?.spotify
  const previewing = view.previewing ? choiceKey(view.previewing) : null

  return (
    <div className="rhythm-picker" role="radiogroup" aria-labelledby={`${testId}-label`} data-testid={testId}>
      {musicOptions(listing).map((option) => {
        const key = choiceKey(option.choice)
        const on = key === choiceKey(value)
        const choice = option.choice
        const playingPreview = previewing === key
        return (
          <div key={key} className={`rhythm-pick-row${on ? ' rhythm-pick-row-on' : ''}`}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              className={`rhythm-option${on ? ' rhythm-option-on' : ''}`}
              data-testid={`${testId}-${key}`}
              onClick={() => onPick(choice)}
            >
              <span className="rhythm-option-title">{option.title}</span>
              <span className="rhythm-option-meta">{option.meta}</span>
            </button>
            {choice.kind !== 'none' && (
              <button
                type="button"
                className={`rhythm-preview${playingPreview ? ' rhythm-preview-on' : ''}`}
                aria-pressed={playingPreview}
                aria-label={playingPreview ? `Stop the preview of ${option.title}` : `Preview ${option.title}${choice.kind === 'spotify' ? ' in Spotify on your Mac' : ''}`}
                title={choice.kind === 'spotify' ? 'Plays 15 seconds in Spotify on your Mac' : 'Plays 10 seconds here'}
                data-testid={`${testId}-preview-${key}`}
                onClick={() => { if (playingPreview) music.stopPreview(); else music.preview(choice, owner) }}
              >
                {playingPreview ? 'Stop' : choice.kind === 'spotify' ? 'Preview in Spotify' : 'Preview'}
              </button>
            )}
          </div>
        )
      })}
      {view.loading && !listing && <p className="rhythm-muted rhythm-pad">Loading music…</p>}
      {view.loadError && !listing && <p className="rhythm-error rhythm-pad">{view.loadError}</p>}
      {listing && listing.tracks.length === 0 && (
        <p className="rhythm-muted rhythm-pad">No files in the focus music folder yet. Add m4a, mp3 or wav files to it in the Rhythm App.</p>
      )}
      {view.error && <p className="rhythm-error rhythm-pad" role="status" data-testid={`${testId}-error`}>{view.error}</p>}
      {spotify && !spotify.available && spotify.reason && <p className="rhythm-muted rhythm-pad" data-testid={`${testId}-spotify-off`}>{spotify.reason}</p>}
    </div>
  )
}
