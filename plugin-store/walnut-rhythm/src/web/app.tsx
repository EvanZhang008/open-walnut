/**
 * The Rhythm page: an instrument strip (sitting time, next reminder, quiet), the focus
 * block, today's scorecard, the macOS rows, and the plugin's own settings, all on one
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
import { clockText, minutesText, nextReminderText } from './format'
import { MacCard } from './mac-card'
import type { RhythmPublicState, RhythmStore } from './store'

const TIME_TIMELINE_PATH = '/apps/walnut-time~main/timeline'
const SETTINGS_PATH = '/settings#plugin-store'
const MINUTE_MS = 60_000

export interface RhythmAppProps extends AppProps {
  walnut: WalnutWebApi
  store: RhythmStore
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

type RhythmAppRun = (localOp: string, args?: Record<string, unknown>) => void

/** Sitting time, next reminder and quiet as three dials over one meter of time at the keyboard. */
function NowBlock({ state, run, busy }: { state: RhythmPublicState; run: RhythmAppRun; busy: boolean }) {
  const { sitting, reminder, config } = state
  const neverSeen = sitting.signals.walnut === null && sitting.signals.mac === null && sitting.lastActiveAt === null
  const intervalMs = Math.max(1, config.reminderEveryMinutes) * MINUTE_MS
  const fraction = sitting.present ? Math.min(1, sitting.sittingMs / intervalMs) : 0
  return (
    <section className="rhythm-block" data-testid="rhythm-header-card">
      <div className="rhythm-block-head"><h2>Now</h2></div>
      <div className="rhythm-group">
        <div className="rhythm-now" data-phase={reminder.phase} data-present={sitting.present ? 'true' : 'false'}>
          <div className="rhythm-dials">
            <div className="rhythm-dial">
              <span className="rhythm-dial-label">Sitting</span>
              <span className="rhythm-dial-value" data-testid="rhythm-streak">{sitting.present ? minutesText(sitting.sittingMs) : 'Away'}</span>
            </div>
            <div className="rhythm-dial">
              <span className="rhythm-dial-label">Next stand-up</span>
              <span className="rhythm-dial-text" data-testid="rhythm-next" data-phase={reminder.phase}>{nextReminderText(state)}</span>
            </div>
            <div className="rhythm-dial">
              <span className="rhythm-dial-label">Quiet</span>
              <span className="rhythm-dial-text" data-testid="rhythm-quiet">{quietText(state)}</span>
            </div>
          </div>
          <div>
            <div className="rhythm-meter" role="progressbar" aria-label="Time at the keyboard toward the next stand-up" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
              <span className="rhythm-meter-fill" data-testid="rhythm-meter-fill" style={{ width: `${fraction * 100}%` }} />
            </div>
            <div className="rhythm-meter-note">
              <span>{sitting.present ? 'At the keyboard' : 'Away from the keyboard'}</span>
              <span>Stand up at {config.reminderEveryMinutes} min</span>
            </div>
          </div>
          {neverSeen && (
            <p className="rhythm-muted" data-testid="rhythm-no-signal">
              No keyboard time seen yet. Rhythm counts time you spend in Walnut, and time in any Mac app when Time's app tracking is on.
            </p>
          )}
          {!reminder.quietHours.valid && (
            <p className="rhythm-error">Quiet hours "{reminder.quietHours.value}" is not HH:MM-HH:MM, so it is off.</p>
          )}
          <div className="rhythm-actions">
            {/* Starts the stand-up break timer (the ring counts it down); a running block or break owns the next break. */}
            <button type="button" className="rhythm-button" disabled={busy || state.focus.phase !== 'idle'} data-testid="rhythm-stand-now" onClick={() => run('break_start')}>
              Stand up now ({config.standBreakMinutes} min)
            </button>
            <button type="button" className="rhythm-button" disabled={busy || !sitting.present} data-testid="rhythm-break-snooze" onClick={() => run('break_snooze')}>
              Snooze {config.snoozeMinutes} min
            </button>
          </div>
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
    ['breaks', 'Breaks / reminders', `${today.breaksTaken} / ${today.remindersFired}`],
    ['longest', 'Longest sitting', minutesText(today.longestStreakMs)],
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
        {today.remindersSnoozed > 0 && (
          <p className="rhythm-muted rhythm-stat-note">Snoozed {today.remindersSnoozed === 1 ? 'once' : `${today.remindersSnoozed} times`} today.</p>
        )}
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
        <span className="rhythm-muted">Reminder, focus and quiet, saved for this Mac.</span>
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

export function RhythmApp({ walnut, store, navigate }: RhythmAppProps) {
  const state = useRhythm(store)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  // Set when Install opened the Add dialogs; the state event that reports both shortcuts
  // present then replaces "click Add in each" with the done line, with no click here.
  const awaitingInstall = useRef(false)
  useEffect(() => { void store.refresh({ refreshShortcuts: true }) }, [store])
  const run = useCallback<RhythmAppRun>((localOp, args = {}) => {
    setBusy(true)
    void store.call<{ message?: string }>(localOp, args).then((outcome) => {
      setBusy(false)
      if (outcome.ok) setMessage({ ok: true, text: outcome.result?.message ?? 'Done.' })
      else setMessage({ ok: false, text: outcome.message })
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
    setMessage({ ok: true, text: 'Both shortcuts are in Shortcuts now. Focus blocks can drive Do Not Disturb.' })
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
        <p className="rhythm-lede">A stand-up reminder that counts only time at the keyboard, focus blocks tied to a task, and quiet while you focus.</p>
        {message && (
          <p className={message.ok ? 'rhythm-status' : 'rhythm-error'} role="status" data-testid="rhythm-message" style={{ marginTop: 8 }}>{message.text}</p>
        )}
      </header>
      <NowBlock state={state} run={run} busy={busy} />
      <div className="rhythm-two">
        <FocusCard walnut={walnut} store={store} state={state} run={run} busy={busy} />
        <ScoreCard state={state} />
      </div>
      <MacCard state={state} onInstall={install} onOpenPrivacy={() => run('macos_privacy_open')} refresh={refresh} busy={busy} />
      <SettingsBlock walnut={walnut} navigate={navigate} />
      <footer className="rhythm-links">
        <a href={TIME_TIMELINE_PATH} data-testid="rhythm-link-timeline" onClick={(event) => { event.preventDefault(); navigate(TIME_TIMELINE_PATH) }}>
          See the day in Time
        </a>
      </footer>
    </div>
  )
}
