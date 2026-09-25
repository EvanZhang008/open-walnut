/**
 * The Rhythm App: sitting streak and next reminder, the focus block, today's
 * scorecard, the macOS card, and links to Time and to Settings.
 *
 * All state comes from the shared store (live through the `state` event), and every
 * button is one op call whose answer is shown on the status line: a refusal is a
 * sentence the person can act on, never a silent no-op.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { FocusCard } from './focus-card'
import { clockText, minutesText, nextReminderText } from './format'
import { MacCard } from './mac-card'
import type { RhythmPublicState, RhythmStore } from './store'

const TIME_TIMELINE_PATH = '/apps/walnut-time~main/timeline'
const SETTINGS_PATH = '/settings#plugin-store'

export interface RhythmAppProps extends AppProps {
  walnut: WalnutWebApi
  store: RhythmStore
}

function useRhythm(store: RhythmStore): RhythmPublicState | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

function quietText(state: RhythmPublicState): string {
  const { quiet } = state
  if (!quiet.available) return 'This Walnut has no quiet mode yet.'
  if (!quiet.active || quiet.holds.length === 0) return 'Walnut is not quiet.'
  return quiet.holds
    .map((hold) => {
      const label = hold.source === 'user' ? (hold.reason ? `You (${hold.reason})` : 'You') : hold.reason ?? hold.source
      return hold.until ? `${label} until ${clockText(hold.until)}` : label
    })
    .join(' · ')
}

function HeaderCard({ state, run, busy }: { state: RhythmPublicState; run: RhythmAppRun; busy: boolean }) {
  const { sitting, reminder } = state
  const neverSeen = sitting.signals.walnut === null && sitting.signals.mac === null && sitting.lastActiveAt === null
  return (
    <section className="rhythm-card rhythm-header-card" data-testid="rhythm-header-card">
      <div className="rhythm-stats">
        <div className="rhythm-stat">
          <span className="rhythm-stat-label">Sitting</span>
          <span className="rhythm-stat-value" data-testid="rhythm-streak">{sitting.present ? minutesText(sitting.sittingMs) : 'Away'}</span>
        </div>
        <div className="rhythm-stat">
          <span className="rhythm-stat-label">Next stand-up reminder</span>
          <span className="rhythm-stat-value rhythm-stat-text" data-testid="rhythm-next" data-phase={reminder.phase}>{nextReminderText(state)}</span>
        </div>
        <div className="rhythm-stat">
          <span className="rhythm-stat-label">Quiet</span>
          <span className="rhythm-stat-value rhythm-stat-text" data-testid="rhythm-quiet">{quietText(state)}</span>
        </div>
      </div>
      {neverSeen && (
        <p className="rhythm-muted" data-testid="rhythm-no-signal">
          No keyboard time seen yet. Rhythm counts time you spend in Walnut, and time in any Mac app when Time's app tracking is on.
        </p>
      )}
      {!state.reminder.quietHours.valid && (
        <p className="rhythm-error">Quiet hours "{state.reminder.quietHours.value}" is not HH:MM-HH:MM, so it is off.</p>
      )}
      <div className="rhythm-actions">
        <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-break-done" onClick={() => run('break_done')}>I stood up</button>
        <button type="button" className="rhythm-button" disabled={busy || !sitting.present} data-testid="rhythm-break-snooze" onClick={() => run('break_snooze')}>
          Snooze {state.config.snoozeMinutes} min
        </button>
      </div>
    </section>
  )
}

function ScoreCard({ state }: { state: RhythmPublicState }) {
  const { today } = state
  const items: Array<[string, string, string]> = [
    ['focus-minutes', 'Focus', minutesText(today.focusMinutes * 60_000)],
    ['blocks', 'Blocks', String(today.focusBlocks.length)],
    ['breaks', 'Breaks taken / reminders', `${today.breaksTaken} / ${today.remindersFired}`],
    ['longest', 'Longest sitting', minutesText(today.longestStreakMs)],
  ]
  return (
    <section className="rhythm-card" data-testid="rhythm-score-card">
      <header className="rhythm-card-head"><h2>Today</h2></header>
      <div className="rhythm-stats">
        {items.map(([key, label, value]) => (
          <div key={key} className="rhythm-stat">
            <span className="rhythm-stat-label">{label}</span>
            <span className="rhythm-stat-value" data-testid={`rhythm-score-${key}`}>{value}</span>
          </div>
        ))}
      </div>
      {today.remindersSnoozed > 0 && <p className="rhythm-muted">Snoozed {today.remindersSnoozed === 1 ? 'once' : `${today.remindersSnoozed} times`} today.</p>}
    </section>
  )
}

type RhythmAppRun = (localOp: string, args?: Record<string, unknown>) => void

export function RhythmApp({ walnut, store, navigate }: RhythmAppProps) {
  const state = useRhythm(store)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

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

  if (!state) {
    const error = store.loadError()
    return (
      <div className="rhythm-root" data-testid="rhythm-app">
        <h1>Rhythm</h1>
        {error
          ? <p className="rhythm-error" data-testid="rhythm-load-error">{error} <button type="button" className="rhythm-link-button" onClick={refresh}>Try again</button></p>
          : <p className="rhythm-muted">Loading…</p>}
      </div>
    )
  }

  return (
    <div className="rhythm-root" data-testid="rhythm-app">
      <header className="rhythm-page-head">
        <div>
          <h1>Rhythm</h1>
          <p className="rhythm-muted">A stand-up reminder that counts only time at the keyboard, focus blocks tied to a task, and quiet while you focus.</p>
        </div>
      </header>
      {message && (
        <p className={message.ok ? 'rhythm-note' : 'rhythm-error'} role="status" data-testid="rhythm-message">{message.text}</p>
      )}
      <HeaderCard state={state} run={run} busy={busy} />
      <div className="rhythm-grid">
        <FocusCard walnut={walnut} store={store} state={state} run={run} busy={busy} />
        <ScoreCard state={state} />
        <MacCard state={state} run={run} refresh={refresh} busy={busy} />
      </div>
      <footer className="rhythm-links">
        <a href={TIME_TIMELINE_PATH} data-testid="rhythm-link-timeline" onClick={(event) => { event.preventDefault(); navigate(TIME_TIMELINE_PATH) }}>
          See the day in Time
        </a>
        <a href={SETTINGS_PATH} data-testid="rhythm-link-settings" onClick={(event) => { event.preventDefault(); navigate(SETTINGS_PATH) }}>
          Rhythm settings
        </a>
      </footer>
    </div>
  )
}
