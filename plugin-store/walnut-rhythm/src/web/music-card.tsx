/**
 * Focus music: one Play / Stop button, the volume, how the folder plays (one track on
 * repeat, in order, shuffled), the tracks, and the folder they come from. The sound
 * itself lives in the console-wide player (music.ts), so leaving this page never stops it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { MusicOrder, MusicPlayer, MusicView, SpotifyView } from './music'
import type { RhythmPublicState, RhythmStore } from './store'

const ORDERS: Array<[MusicOrder, string]> = [
  ['one', 'Repeat one'],
  ['in_order', 'In order'],
  ['shuffle', 'Shuffle'],
]

export function useMusic(player: MusicPlayer): MusicView {
  return useSyncExternalStore(player.subscribe, player.get, player.get)
}

function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function nowText(music: MusicView, title: string | undefined, state: RhythmPublicState): string {
  if (music.starting) return `Starting ${title ?? 'the music'}…`
  if (!music.playing) return 'Stopped'
  if (music.tiedToFocus) return state.focus.phase === 'focus' ? `Playing ${title}, stops when the block ends` : `Playing ${title}`
  return `Playing ${title}`
}

/** The Spotify playlists Start can play in the Mac's Spotify app: add one by its link, remove one. */
function SpotifyPlaylists({ player, store, spotify }: { player: MusicPlayer; store: RhythmStore; spotify: SpotifyView }) {
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const call = (op: string, args: Record<string, unknown>, after?: () => void) => {
    setBusy(true)
    setMessage(null)
    void store.call<{ message: string; spotify: SpotifyView }>(op, args).then((outcome) => {
      setBusy(false)
      if (!outcome.ok) { setMessage({ text: outcome.message, error: true }); return }
      player.setSpotify(outcome.result.spotify)
      setMessage({ text: outcome.result.message, error: false })
      after?.()
    })
  }
  return (
    <div className="rhythm-spotify" data-testid="rhythm-spotify">
      <div className="rhythm-block-head">
        <h3 className="rhythm-subhead">Spotify playlists</h3>
        <span className="rhythm-muted">{spotify.available ? 'Play in the Spotify app on this Mac' : spotify.reason}</span>
      </div>
      <div className="rhythm-picker" data-testid="rhythm-spotify-list">
        {spotify.playlists.map((one) => (
          <div key={one.uri} className="rhythm-option rhythm-option-row">
            <span className="rhythm-option-title">{one.name}</span>
            <button type="button" className="rhythm-link-button" disabled={busy} data-testid={`rhythm-spotify-remove-${one.uri}`} onClick={() => call('spotify_playlist_remove', { uri: one.uri })}>Remove</button>
          </div>
        ))}
        {spotify.playlists.length === 0 && <p className="rhythm-muted rhythm-pad">No playlists. Paste a playlist link below.</p>}
      </div>
      <form
        className="rhythm-spotify-add"
        onSubmit={(event) => { event.preventDefault(); if (link.trim()) call('spotify_playlist_add', { link }, () => setLink('')) }}
      >
        <input
          type="text"
          value={link}
          placeholder="https://open.spotify.com/playlist/…"
          aria-label="Spotify playlist link"
          data-testid="rhythm-spotify-link"
          onChange={(event) => setLink(event.currentTarget.value)}
        />
        <button type="submit" className="rhythm-button" disabled={busy || !link.trim()} data-testid="rhythm-spotify-add">Add</button>
      </form>
      {message && <p className={message.error ? 'rhythm-error' : 'rhythm-status'} role="status" data-testid="rhythm-spotify-message">{message.text}</p>}
    </div>
  )
}

export function MusicCard({ player, store, state, onOpenFolder, busy }: { player: MusicPlayer; store: RhythmStore; state: RhythmPublicState; onOpenFolder(): void; busy: boolean }) {
  const music = useMusic(player)
  useEffect(() => { void player.refresh() }, [player])
  const listing = music.listing
  const tracks = listing?.tracks ?? []
  const current = tracks.find((track) => track.id === music.trackId) ?? tracks[0]
  const on = music.playing || music.starting

  return (
    <section className="rhythm-block rhythm-music" data-testid="rhythm-music-card" data-playing={on ? 'true' : 'false'}>
      <div className="rhythm-block-head">
        <h2>Focus music</h2>
        <span className="rhythm-muted">Pick what Start plays in the focus block above</span>
      </div>
      <div className="rhythm-group"><div className="rhythm-body">
        <div className="rhythm-music-now">
          <button
            type="button"
            className={`rhythm-music-play${on ? ' rhythm-music-on' : ''}`}
            aria-pressed={on}
            aria-label={on ? 'Stop the focus music' : `Play ${current?.title ?? 'the focus music'}`}
            disabled={!on && tracks.length === 0}
            data-testid="rhythm-music-toggle"
            onClick={() => player.toggle()}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              {on ? <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" /> : <path d="M5 3.2v9.6L13 8z" fill="currentColor" />}
            </svg>
            <span>{on ? 'Stop' : 'Play'}</span>
          </button>
          <div className="rhythm-music-copy">
            <span className="rhythm-music-title" data-testid="rhythm-music-title">{current?.title ?? 'No music yet'}</span>
            <span className="rhythm-muted" data-testid="rhythm-music-state">{nowText(music, current?.title, state)}</span>
          </div>
          <label className="rhythm-music-volume">
            <span className="rhythm-muted">Volume</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(music.volume * 100)}
              aria-label="Focus music volume"
              data-testid="rhythm-music-volume"
              onChange={(event) => player.setVolume(Number(event.currentTarget.value) / 100)}
            />
          </label>
        </div>
        {music.error && <p className="rhythm-error" role="status" data-testid="rhythm-music-error">{music.error}</p>}

        <div className="rhythm-segments" role="radiogroup" aria-label="How the folder plays">
          {ORDERS.map(([order, label]) => (
            <button
              key={order}
              type="button"
              role="radio"
              aria-checked={music.order === order}
              className={`rhythm-segment${music.order === order ? ' rhythm-segment-on' : ''}`}
              data-testid={`rhythm-music-order-${order}`}
              onClick={() => player.setOrder(order)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="rhythm-picker" role="radiogroup" aria-label="Focus music track" data-testid="rhythm-music-tracks">
          {tracks.map((track) => (
            <button
              key={track.id}
              type="button"
              role="radio"
              aria-checked={track.id === current?.id}
              className={`rhythm-option${track.id === current?.id ? ' rhythm-option-on' : ''}`}
              data-testid={`rhythm-music-track-${track.id}`}
              title={track.file}
              onClick={() => player.select(track.id)}
            >
              <span className="rhythm-option-title">{track.title}</span>
              <span className="rhythm-option-meta">{track.id} · {sizeText(track.bytes)}</span>
            </button>
          ))}
          {music.loading && !listing && <p className="rhythm-muted rhythm-pad">Loading music…</p>}
          {listing && tracks.length === 0 && !listing.error && (
            <p className="rhythm-muted rhythm-pad" data-testid="rhythm-music-empty">
              {listing.exists || listing.isDefault
                ? 'No music in this folder yet. Add m4a, mp3 or wav files, then Refresh.'
                : 'This folder does not exist on the Mac. Make it, or fix Focus music folder in Settings below.'}
            </p>
          )}
          {(music.loadError || listing?.error) && (
            <p className="rhythm-error rhythm-pad" data-testid="rhythm-music-load-error">{listing?.error ?? music.loadError}</p>
          )}
        </div>
        {listing && listing.skipped.length > 0 && (
          <p className="rhythm-muted" data-testid="rhythm-music-skipped">Not listed: {listing.skipped.join(', ')}. Use m4a, mp3 or wav (Safari and the phone play only those), and no ".." in the name.</p>
        )}

        {listing?.spotify && <SpotifyPlaylists player={player} store={store} spotify={listing.spotify} />}

        <div className="rhythm-music-folder">
          <span className="rhythm-muted rhythm-music-path" data-testid="rhythm-music-folder" title={listing?.folder}>{listing ? listing.folder : ''}</span>
          <div className="rhythm-actions">
            <button type="button" className="rhythm-button" disabled={busy || !listing || Boolean(listing.error && !listing.exists)} data-testid="rhythm-music-open-folder" onClick={onOpenFolder}>Open folder</button>
            <button type="button" className="rhythm-button" disabled={music.loading} data-testid="rhythm-music-refresh" onClick={() => { void player.refresh() }}>Refresh</button>
          </div>
        </div>
      </div></div>
    </section>
  )
}
