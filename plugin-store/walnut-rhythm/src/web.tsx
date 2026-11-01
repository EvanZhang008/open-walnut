/**
 * Rhythm's web entry: one App and its CSS.
 *
 * The live countdown is NOT drawn here: the server publishes a status item and the host
 * draws it as a ring in the rail on every screen. The App entry carries no badge, since
 * a pinned App would repeat the ring's minutes right next to it. The focus music player
 * is made here rather than in the App, so leaving the App never stops the music.
 *
 * While Rhythm is off, the ring's popover shows the Start form (lengths and music) in
 * place of its one Start button, through the `status-item.panel` slot. A host older than
 * that slot refuses it, and the popover keeps the plain Start button.
 */
import { useState, useSyncExternalStore } from 'react'
import type { AppProps, StatusItemPanelSlotProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { STATUS_ITEM_ID } from './server/status-item'
import { RhythmApp } from './web/app'
import { createMusicPlayer } from './web/music'
import { StartForm } from './web/start-form'
import { createRhythmStore } from './web/store'
import { RHYTHM_CSS } from './web/styles'

/** The documented default weight for a plugin App (core screens use 10 to 1000). */
const APP_ORDER = 500

export async function activate(walnut: WalnutWebApi) {
  const store = createRhythmStore(walnut)
  // Console-wide, so the music keeps playing on every screen; the plugin's signal ends it.
  const music = createMusicPlayer(walnut, store)

  function RhythmIcon({ size = 18 }: { size?: number }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="13" r="7.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 9.2V13l2.6 1.7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9.6 3.4h4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }

  function RhythmAppRoot(props: AppProps) {
    return <RhythmApp {...props} walnut={walnut} store={store} music={music} />
  }

  const app = walnut.ui.app({
    id: 'main',
    title: 'Rhythm',
    icon: RhythmIcon,
    component: RhythmAppRoot,
    badge: null,
    order: APP_ORDER,
    fullBleed: true,
  })
  walnut.ui.injectCss(RHYTHM_CSS)

  function StartPanel({ itemId, close }: StatusItemPanelSlotProps) {
    const state = useSyncExternalStore(store.subscribe, store.get, store.get)
    // The block started but Spotify did not play: said here until read, then the item's buttons return.
    const [spotifyError, setSpotifyError] = useState<string | null>(null)
    if (itemId !== STATUS_ITEM_ID || !state || state.replica) return null
    if (spotifyError) {
      return (
        <div className="rhythm-start-result" data-testid="rhythm-start-spotify-error">
          <p className="rhythm-error" role="status">The block is running. {spotifyError}</p>
          <button type="button" className="rhythm-button" onClick={() => setSpotifyError(null)}>OK</button>
        </div>
      )
    }
    // Only while off: a running block or break keeps its own Stop / End break buttons.
    if (state.focus.phase !== 'idle') return null
    return (
      <StartForm
        store={store}
        music={music}
        state={state}
        compact
        onStarted={(result) => { if (result.spotifyError) setSpotifyError(result.spotifyError); else close() }}
      />
    )
  }
  try {
    walnut.ui.slot?.({ id: 'start', target: 'status-item.panel', title: 'Start a focus block', component: StartPanel })
  } catch (error) {
    walnut.log.info('This Walnut has no status item panels; the ring keeps its Start button', { error: String(error) })
  }

  void store.refresh()
  walnut.log.info('Rhythm web activated', { appPath: app.path })
}
