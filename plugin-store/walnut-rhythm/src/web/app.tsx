/**
 * The Rhythm page: an instrument strip (off or running, the run's times, quiet), the
 * focus block, today's scorecard, the focus music, the macOS rows, and the plugin's own settings, all on one
 * page in Settings. This page IS the plugin, so its settings live here rather than in a
 * second card under Settings → Plugins (manifest `settingsIn: 'app'`).
 *
 * All state comes from the shared store (live through the `state` event), and every
 * button is one op call whose answer is shown on the status line: a refusal is a
 * sentence the person can act on, never a silent no-op.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { FocusCard } from './focus-card'
import { clockText, focusPhaseText, minutesText, runSpanText } from './format'
import { MacCard } from './mac-card'
import { MusicCard } from './music-card'
import type { MusicPlayer } from './music'
import type { RhythmPublicState, RhythmStore } from './store'

const TIME_TIMELINE_PATH = '/apps/walnut-time~main/timeline'
const SETTINGS_PATH = '/settings#plugin-store'
const MINUTE_MS = 60_000

export interface RhythmAppProps extends AppProps {
  walnut: WalnutWebApi
  store: RhythmStore
  music: MusicPlayer
}

function useRhythm(store: RhythmStore): RhythmPublicState | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

function quietText(state: RhythmPublicState): string {
  const { quiet } = state
  if (!quiet.active || quiet.holds.length === 0) return 'Not quiet'
  return quiet.holds
    .map((hold) => {
      const label = hold.source === 'user' ? (hold.reason ? `You (${hold.reason})` : 'You') : hold.reason ?? hold.source
      return hold.until ? `${label} until ${clockText(hold.until)}` : label
    })
    .join(' · ')
}

/** Runs one op and shows its answer; resolves whether it succeeded. */
type RhythmAppRun = (localOp: string, args?: Record<string, unknown>) => Promise<boolean>

/** Whether Rhythm runs, the run's start and end, and quiet, as three dials. Nothing here counts on its own. */
function NowBlock({ state }: { state: RhythmPublicState }) {
  const { focus } = state
  const on = focus.phase !== 'idle'
  return (
    <section className="rhythm-block" data-testid="rhythm-header-card">
      <div className="rhythm-block-head"><h2>Now</h2></div>
      <div className="rhythm-group">
        <div className="rhythm-now" data-phase={focus.phase}>
          <div className="rhythm-dials">
            <div className="rhythm-dial">
              <span className="rhythm-dial-label">Rhythm</span>
              <span className="rhythm-dial-value" data-testid="rhythm-on">{on ? focusPhaseText(focus.phase, focus.breakKind) : 'Off'}</span>
            </div>
            <div className="rhythm-dial">
              <span className="rhythm-dial-label">{on ? 'This run' : 'Last run'}</span>
              <span className="rhythm-dial-text" data-testid="rhythm-run">{runSpanText(focus)}</span>
            </div>
            <div className="rhythm-dial">
              <span className="rhythm-dial-label">Quiet</span>
              <span className="rhythm-dial-text" data-testid="rhythm-quiet">{quietText(state)}</span>
            </div>
          </div>
          {!on && (
            <p className="rhythm-muted" data-testid="rhythm-off-note">
              Rhythm is off. It starts only when you press Start, runs the block and its break, then asks before the next one.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function ScoreCard({ state }: { state: RhythmPublicState }) {
  const { today } = state
  const items: Array<[string, string, string]> = [
    ['focus-minutes', 'Focus', minutesText(today.focusMinutes * MINUTE_MS)],
    ['blocks', 'Blocks', String(today.focusBlocks.length)],
    ['breaks', 'Breaks', String(today.focusBreaks)],
    ['stopped', 'Stopped early', String(today.stoppedBlocks)],
  ]
  return (
    <section className="rhythm-block" data-testid="rhythm-score-card">
      <div className="rhythm-block-head"><h2>Today</h2></div>
      <div className="rhythm-group">
        <div className="rhythm-stats">
          {items.map(([key, label, value]) => (
            <div key={key} className="rhythm-stat">
              <span className="rhythm-stat-label">{label}</span>
              <span className="rhythm-stat-value" data-testid={`rhythm-score-${key}`}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/** The plugin's generated settings form, drawn by the host; an older host gets a link instead. */
function SettingsBlock({ walnut, navigate }: { walnut: WalnutWebApi; navigate: AppProps['navigate'] }) {
  const SettingsView = walnut.ui.views.PluginSettingsView
  return (
    <section className="rhythm-block rhythm-settings" data-testid="rhythm-settings-block">
      <div className="rhythm-block-head">
        <h2>Settings</h2>
        <span className="rhythm-muted">Block and break lengths, quiet and music, saved for this Mac.</span>
      </div>
      {SettingsView ? (
        <SettingsView />
      ) : (
        <div className="rhythm-group">
          <div className="rhythm-row">
            <div className="rhythm-row-copy">
              <span>Rhythm settings</span>
              <span className="rhythm-row-help">This Walnut draws plugin settings under Settings → Plugins.</span>
            </div>
            <div className="rhythm-row-actions">
              <a className="rhythm-button" href={SETTINGS_PATH} data-testid="rhythm-link-settings" onClick={(event) => { event.preventDefault(); navigate(SETTINGS_PATH) }}>Open</a>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export function RhythmApp({ walnut, store, music, navigate }: RhythmAppProps) {
  const state = useRhythm(store)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  // Set when Install opened the Add dialogs; the state event that reports both shortcuts
  // present then replaces "click Add in each" with the done line, with no click here.
  const awaitingInstall = useRef(false)
  useEffect(() => { void store.refresh({ refreshShortcuts: true }) }, [store])
  const run = useCallback<RhythmAppRun>((localOp, args = {}) => {
    setBusy(true)
    return store.call<{ message?: string }>(localOp, args).then((outcome) => {
      setBusy(false)
      if (outcome.ok) setMessage({ ok: true, text: outcome.result?.message ?? 'Done.' })
      else setMessage({ ok: false, text: outcome.message })
      return outcome.ok
    })
  }, [store])
  const refresh = useCallback(() => {
    setBusy(true)
    void store.refresh({ refreshShortcuts: true }).then(() => setBusy(false))
  }, [store])
  const install = useCallback(() => {
    awaitingInstall.current = true
    setBusy(true)
    void store.call<{ message?: string }>('macos_shortcuts_install').then((outcome) => {
      setBusy(false)
      if (!outcome.ok) {
        awaitingInstall.current = false
        setMessage({ ok: false, text: outcome.message })
        return
      }
      // The watch can see both Adds before this answer lands; its done line stays.
      if (!awaitingInstall.current) return
      setMessage({ ok: true, text: outcome.result?.message ?? 'Done.' })
    })
  }, [store])
  const shortcuts = state?.macos.shortcuts
  const missingCount = shortcuts?.missing.length ?? -1
  const listed = shortcuts?.installed !== null && shortcuts?.installed !== undefined
  useEffect(() => {
    if (!awaitingInstall.current || !listed || missingCount !== 0) return
    awaitingInstall.current = false
    setMessage({ ok: true, text: 'Both shortcuts are in Shortcuts now. Focus blocks can turn Mac Do Not Disturb on.' })
  }, [listed, missingCount])

  if (!state) {
    const error = store.loadError()
    return (
      <div className="rhythm-root" data-testid="rhythm-app">
        <header><h1>Rhythm</h1></header>
        {error
          ? <p className="rhythm-error" data-testid="rhythm-load-error">Rhythm could not load its state: {error} <button type="button" className="rhythm-link-button" onClick={refresh}>Try again</button></p>
          : <p className="rhythm-muted">Loading…</p>}
        {/* The settings have no other home (settingsIn: 'app'), so they stay reachable
            when the state does not load: often a setting is what needs fixing. */}
        <SettingsBlock walnut={walnut} navigate={navigate} />
      </div>
    )
  }
  return (
    <div className="rhythm-root" data-testid="rhythm-app">
      <header>
        <h1>Rhythm</h1>
        <p className="rhythm-lede">Focus blocks you start yourself, a break after each, and quiet while you focus. Rhythm is off until you press Start.</p>
        {message && (
          <p className={message.ok ? 'rhythm-status' : 'rhythm-error'} role="status" data-testid="rhythm-message" style={{ marginTop: 8 }}>{message.text}</p>
        )}
      </header>
      <NowBlock state={state} />
      <div className="rhythm-two">
        <FocusCard walnut={walnut} store={store} state={state} music={music} />
        <ScoreCard state={state} />
      </div>
      <MusicCard player={music} store={store} state={state} busy={busy} onOpenFolder={() => { void run('music_folder_open') }} />
      <MacCard state={state} onInstall={install} onOpenPrivacy={() => { void run('macos_privacy_open') }} onDndSetting={(on) => { void run('dnd_setting', { on }) }} refresh={refresh} busy={busy} />
      <SettingsBlock walnut={walnut} navigate={navigate} />
      <footer className="rhythm-links">
        <a href={TIME_TIMELINE_PATH} data-testid="rhythm-link-timeline" onClick={(event) => { event.preventDefault(); navigate(TIME_TIMELINE_PATH) }}>
          See the day in Time
        </a>
      </footer>
    </div>
  )
}
