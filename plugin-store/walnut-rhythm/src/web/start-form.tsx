/**
 * The Start form: how long the block and its break run, what music Start plays, the
 * Start button, and Rest (a break of the Break length, with nothing else). One component for the sidebar popover (the `status-item.panel` slot) and
 * the App's focus card, so both say the same thing and remember the same pick.
 *
 * It says plainly what Start will play before the click ("Start plays Brown Noise on this
 * device"). The lengths are remembered as the settings (`remember: true`); the music is
 * this device's own pick (music.ts). A folder track starts inside the click, because a
 * browser (Safari and the Mac app above all) plays sound only then; a Spotify playlist
 * plays in the Spotify app on the Mac, started by the server.
 */
import { useEffect, useState } from 'react'
import type { MusicPlayer, MusicTracksResult, StartChoice } from './music'
import { resolveStartChoice } from './music'
import { useMusic } from './music-card'
import { choiceKey, MusicPicker } from './music-picker'
import { CYCLE_RESET_MS } from '../server/focus'
import { DndStartToggle } from './dnd-row'
import { GoalInput } from './goal'
import type { OpOutcome, RhythmPublicState, RhythmStore } from './store'

export { choiceKey }

/** Load the music list once; a failed load waits for the App's Refresh rather than retrying in a loop. */
export function useMusicList(music: MusicPlayer): void {
  const view = useMusic(music)
  useEffect(() => { if (!view.listing && !view.loading && !view.loadError) void music.refresh() }, [music, view.listing, view.loading, view.loadError])
}

export const FOCUS_PRESETS = [15, 25, 45, 60]
export const BREAK_PRESETS = [5, 10, 15]
export const FOCUS_LIMITS = { min: 5, max: 180 }
export const BREAK_LIMITS = { min: 1, max: 60 }

/** A typed minutes value, or null when it is not a whole number in range. PURE. */
export function parseMinutes(text: string, limits: { min: number; max: number }): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,3}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= limits.min && value <= limits.max ? value : null
}

/** "Start plays Brown Noise on this device." PURE. */
export function musicLine(choice: StartChoice, listing: MusicTracksResult | null): string {
  if (choice.kind === 'none') return 'Start plays no music.'
  if (choice.kind === 'track') {
    const title = listing?.tracks.find((track) => track.id === choice.id)?.title ?? 'the focus music'
    return `Start plays ${title} on this device, until the block ends.`
  }
  const name = listing?.spotify.playlists.find((one) => one.uri === choice.uri)?.name ?? 'the playlist'
  return `Start plays ${name} in Spotify on your Mac, until the block ends.`
}

/** The block after this Start earns the long break when it closes the cycle. PURE. */
export function thenText(state: Pick<RhythmPublicState, 'focus' | 'config' | 'now'>, breakMinutes: number | null): string {
  const { focus, config } = state
  const cycleKept = focus.lastRun !== null && state.now - focus.lastRun.endedAt <= CYCLE_RESET_MS
  const completed = cycleKept ? focus.completedInCycle : 0
  if (config.longBreakEvery > 0 && (completed + 1) % config.longBreakEvery === 0) {
    return `then the ${config.longBreakMinutes} min long break (block ${config.longBreakEvery} of ${config.longBreakEvery})`
  }
  return `then a ${breakMinutes ?? '?'} min break`
}

/**
 * Start a block with this device's music. Call it from the click itself. A refused
 * Start stops the music this click began, and only that play.
 */
export function startWithMusic(input: {
  store: RhythmStore
  music: MusicPlayer
  choice: StartChoice
  minutes: number
  breakMinutes: number
  taskId?: string | null
  /** What the block is for, in the person's words; empty = none. */
  goal?: string
  /** Mac Do Not Disturb for this block; absent = the setting. */
  dnd?: boolean
}): Promise<OpOutcome<{ message: string; spotifyError?: string }>> {
  const { store, music, choice } = input
  // focus_start ends a Spotify preview on the server itself.
  music.stopPreview(undefined, true)
  let played: number | undefined
  if (choice.kind === 'track') played = music.play({ trackId: choice.id, withFocus: true })
  // Spotify plays on the Mac: a track still playing here would play over it.
  else if (choice.kind === 'spotify') music.stop()
  // A track left paused here is not this block's music.
  else if (music.get().paused) music.stop()
  const args: Record<string, unknown> = {
    minutes: input.minutes,
    breakMinutes: input.breakMinutes,
    remember: true,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}),
    ...(choice.kind === 'spotify' ? { spotify: choice.uri } : {}),
    ...(typeof input.dnd === 'boolean' ? { dnd: input.dnd } : {}),
  }
  return store.call<{ message: string; spotifyError?: string }>('focus_start', args).then((outcome) => {
    if (!outcome.ok && played !== undefined) music.stop(played)
    return outcome
  })
}

function MinutesRow({ label, presets, limits, value, onChange, testId }: {
  label: string
  presets: number[]
  limits: { min: number; max: number }
  value: string
  onChange(next: string): void
  testId: string
}) {
  const parsed = parseMinutes(value, limits)
  return (
    <div className="rhythm-start-row">
      <span className="rhythm-start-label" id={`${testId}-label`}>{label}</span>
      <div className="rhythm-segments" role="radiogroup" aria-labelledby={`${testId}-label`}>
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={parsed === preset}
            className={`rhythm-segment${parsed === preset ? ' rhythm-segment-on' : ''}`}
            data-testid={`${testId}-${preset}`}
            onClick={() => onChange(String(preset))}
          >
            {preset}
          </button>
        ))}
      </div>
      <label className="rhythm-start-number">
        <input
          type="text"
          inputMode="numeric"
          value={value}
          aria-label={`${label} minutes`}
          aria-invalid={parsed === null}
          data-testid={`${testId}-input`}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <span className="rhythm-muted">min</span>
      </label>
    </div>
  )
}

export function StartForm({ store, music, state, taskId, compact, onStarted }: {
  store: RhythmStore
  music: MusicPlayer
  state: RhythmPublicState
  taskId?: string | null
  /** The popover: a shorter music list. */
  compact?: boolean
  /**
   * The block started. The form is usually gone by then (the state moved to focus), so a
   * Spotify that did not play is the caller's to show, outside the form.
   */
  onStarted?(result: { message: string; spotifyError?: string }): void
}) {
  const view = useMusic(music)
  const { config } = state
  const [focusText, setFocusText] = useState(() => String(config.focusMinutes))
  const [breakText, setBreakText] = useState(() => String(config.breakMinutes))
  // The goal being typed is a draft: a reload or a look elsewhere keeps it until the block starts.
  const [goal, setGoal, clearGoal] = store.useDraft('goal')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // Starts from the setting each time the form opens; a pick here is for this block only.
  const [dnd, setDnd] = useState(() => config.macosFocusShortcuts)
  useMusicList(music)

  const listing = view.listing
  const choice = resolveStartChoice({ stored: view.startChoice, listing, trackId: view.trackId, withFocus: config.musicWithFocus })
  const minutes = parseMinutes(focusText, FOCUS_LIMITS)
  const breakMinutes = parseMinutes(breakText, BREAK_LIMITS)
  const invalid = minutes === null
    ? `Focus is ${FOCUS_LIMITS.min} to ${FOCUS_LIMITS.max} minutes.`
    : breakMinutes === null ? `The break is ${BREAK_LIMITS.min} to ${BREAK_LIMITS.max} minutes.` : null

  const start = () => {
    if (minutes === null || breakMinutes === null || busy) return
    setBusy(true)
    setMessage(null)
    setFailed(false)
    void startWithMusic({ store, music, choice, minutes, breakMinutes, taskId, goal, ...(state.dnd.available ? { dnd } : {}) }).then((outcome) => {
      setBusy(false)
      if (!outcome.ok) { setFailed(true); setMessage(outcome.message); return }
      clearGoal()
      onStarted?.(outcome.result)
    })
  }

  // A rest instead of a block: the Break length, no music, no quiet, no Do Not Disturb.
  const rest = () => {
    if (breakMinutes === null || busy) return
    setBusy(true)
    setMessage(null)
    setFailed(false)
    music.stopPreview(undefined, true)
    void store.call<{ message: string }>('focus_rest', { minutes: breakMinutes }).then((outcome) => {
      setBusy(false)
      if (!outcome.ok) { setFailed(true); setMessage(outcome.message); return }
      onStarted?.(outcome.result)
    })
  }

  return (
    <div className={`rhythm-start${compact ? ' rhythm-start-compact' : ''}`} data-testid="rhythm-start-form">
      <GoalInput value={goal} onChange={setGoal} testId="rhythm-start-goal" />
      <MinutesRow label="Focus" presets={FOCUS_PRESETS} limits={FOCUS_LIMITS} value={focusText} onChange={setFocusText} testId="rhythm-start-focus" />
      <MinutesRow label="Break" presets={BREAK_PRESETS} limits={BREAK_LIMITS} value={breakText} onChange={setBreakText} testId="rhythm-start-break" />
      <div className="rhythm-start-music">
        <span className="rhythm-start-label" id="rhythm-start-music-label">Music</span>
        <MusicPicker music={music} store={store} value={choice} onPick={(next) => { music.stopPreview(); music.setStartChoice(next) }} testId="rhythm-start-music" />
      </div>
      <p className="rhythm-start-plays" data-testid="rhythm-start-plays">{musicLine(choice, listing)}</p>
      <DndStartToggle state={state} value={dnd} onChange={setDnd} />
      {invalid && <p className="rhythm-error" role="status" data-testid="rhythm-start-invalid">{invalid}</p>}
      {message && <p className={failed ? 'rhythm-error' : 'rhythm-status'} role="status" data-testid="rhythm-start-message">{message}</p>}
      <div className="rhythm-actions">
        <button
          type="button"
          className="rhythm-button rhythm-primary"
          disabled={busy || invalid !== null}
          aria-busy={busy || undefined}
          data-testid="rhythm-start-button"
          onClick={start}
        >
          {busy ? 'Starting…' : `Start ${minutes ?? '?'} min focus`}
        </button>
        <button
          type="button"
          className="rhythm-button"
          disabled={busy || breakMinutes === null}
          data-testid="rhythm-start-rest"
          onClick={rest}
        >
          {`Rest ${breakMinutes ?? '?'} min`}
        </button>
        <span className="rhythm-muted" data-testid="rhythm-start-then">{thenText(state, breakMinutes)}</span>
      </div>
    </div>
  )
}
