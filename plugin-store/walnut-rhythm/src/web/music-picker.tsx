/**
 * The music list the Start form and the running block share: No music, the folder's
 * tracks (they play on this device) and the Spotify playlists (they play on the Mac).
 * Each choice has a Preview button, so the person hears a few seconds before picking it;
 * another preview or the list closing ends it, and `onPick` ends it as its op needs.
 *
 * Each sound has a star. Starred ones sit right under No music, in every list on every
 * device: the stars live on the server (`music_star`) and come back in the state event.
 * A click shows the new star at once and the server's answer settles it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MusicPlayer, StartChoice } from './music'
import { useMusic } from './music-card'
import { choiceKey, musicOptions, starredNow } from './music-options'
import type { RhythmStore } from './store'

export { choiceKey, musicOptions, starredNow }

function StarIcon({ on }: { on: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"
        fill={on ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function MusicPicker({ music, store, value, onPick, testId }: {
  music: MusicPlayer
  store: RhythmStore
  value: StartChoice
  onPick(choice: StartChoice): void
  testId: string
}) {
  const view = useMusic(music)
  const state = useSyncExternalStore(store.subscribe, store.get, store.get)
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [starError, setStarError] = useState<string | null>(null)
  const starred = starredNow(state?.starred ?? [], pending)
  const star = (key: string, on: boolean) => {
    setStarError(null)
    setPending((now) => new Map(now).set(key, on))
    void store.call('music_star', { key, on }).then((outcome) => {
      // The answer carries the state with the stars, so the server's list is current now.
      setPending((now) => {
        if (now.get(key) !== on) return now
        const next = new Map(now)
        next.delete(key)
        return next
      })
      if (!outcome.ok) setStarError(outcome.message)
    })
  }
  // This list's own previews: another list closing never ends them, and this one closing does.
  const owner = useRef({}).current
  useEffect(() => () => music.stopPreview(owner), [music, owner])
  const listing = view.listing
  const spotify = listing?.spotify
  const previewing = view.previewing ? choiceKey(view.previewing) : null

  return (
    <div className="rhythm-picker" role="radiogroup" aria-labelledby={`${testId}-label`} data-testid={testId}>
      {musicOptions(listing, starred).map((option) => {
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
                className={`rhythm-star${option.starred ? ' rhythm-star-on' : ''}`}
                aria-pressed={option.starred}
                aria-label={option.starred ? `Unstar ${option.title}` : `Star ${option.title} to keep it on top`}
                title={option.starred ? 'Starred: on top of the list. Click to unstar.' : 'Star to keep it on top of the list'}
                data-testid={`${testId}-star-${key}`}
                onClick={() => star(key, !option.starred)}
              >
                <StarIcon on={option.starred} />
              </button>
            )}
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
      {starError && <p className="rhythm-error rhythm-pad" role="status" data-testid={`${testId}-star-error`}>{starError}</p>}
      {view.error && <p className="rhythm-error rhythm-pad" role="status" data-testid={`${testId}-error`}>{view.error}</p>}
      {spotify && !spotify.available && spotify.reason && <p className="rhythm-muted rhythm-pad" data-testid={`${testId}-spotify-off`}>{spotify.reason}</p>}
    </div>
  )
}
