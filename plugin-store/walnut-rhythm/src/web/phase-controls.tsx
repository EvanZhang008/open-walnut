/**
 * The person's choices while a run is live, the same in the ring's popover and the App:
 *
 *   focus block   Rest now · +5 min · Stop block
 *   break         Focus now · +5 min break · End break
 *
 * Focus now starts the next block as this run's was set (task, lengths) with this
 * device's music pick, inside the click, so a folder track may start playing.
 */
import { useState } from 'react'
import { EXTEND_DEFAULT_MINUTES } from '../server/focus'
import { resolveStartChoice, type MusicPlayer } from './music'
import { useMusic } from './music-card'
import { startWithMusic, useMusicList } from './start-form'
import type { OpOutcome, RhythmPublicState, RhythmStore } from './store'

type Act = (op: string, run: () => Promise<OpOutcome<unknown>>) => void

function useAct(onDone?: (op: string) => void): { pending: string | null; error: string | null; act: Act } {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act: Act = (op, run) => {
    if (pending) return
    setPending(op)
    setError(null)
    void run().then((outcome) => {
      setPending(null)
      if (outcome.ok) onDone?.(op)
      else setError(outcome.message)
    })
  }
  return { pending, error, act }
}

function Button({ op, label, busyLabel, pending, primary, onClick }: {
  op: string
  label: string
  busyLabel: string
  pending: string | null
  primary?: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      className={`rhythm-button${primary ? ' rhythm-primary' : ''}`}
      disabled={pending !== null}
      aria-busy={pending === op || undefined}
      data-testid={`rhythm-${op}`}
      onClick={onClick}
    >
      {pending === op ? busyLabel : label}
    </button>
  )
}

/** While a block runs. `onDone` hears which button finished (the popover closes on Stop and Rest now). */
export function FocusActions({ store, onDone }: { store: RhythmStore; onDone?(op: string): void }) {
  const { pending, error, act } = useAct(onDone)
  return (
    <>
      {error && <p className="rhythm-error" role="status" data-testid="rhythm-phase-error">{error}</p>}
      <div className="rhythm-panel-actions" data-testid="rhythm-focus-actions">
        <Button op="rest-now" label="Rest now" busyLabel="Resting…" pending={pending} onClick={() => act('rest-now', () => store.call('focus_rest'))} />
        <Button op="extend" label={`+${EXTEND_DEFAULT_MINUTES} min`} busyLabel="Adding…" pending={pending} onClick={() => act('extend', () => store.call('focus_extend', { minutes: EXTEND_DEFAULT_MINUTES }))} />
        <Button op="panel-stop" label="Stop block" busyLabel="Stopping…" pending={pending} onClick={() => act('panel-stop', () => store.call('focus_stop'))} />
      </div>
    </>
  )
}

/** While a break runs. */
export function BreakActions({ store, music, state, onDone }: { store: RhythmStore; music: MusicPlayer; state: RhythmPublicState; onDone?(op: string): void }) {
  const { pending, error, act } = useAct(onDone)
  const view = useMusic(music)
  useMusicList(music)
  const { focus, config } = state
  const focusNow = () => act('focus-now', () => startWithMusic({
    store,
    music,
    choice: resolveStartChoice({ stored: view.startChoice, listing: view.listing, trackId: view.trackId, withFocus: config.musicWithFocus }),
    minutes: focus.minutes || config.focusMinutes,
    breakMinutes: focus.breakMinutes || config.breakMinutes,
    taskId: focus.taskId ?? null,
    ...(focus.goal ? { goal: focus.goal } : {}),
  }))
  return (
    <>
      {error && <p className="rhythm-error" role="status" data-testid="rhythm-phase-error">{error}</p>}
      <div className="rhythm-panel-actions" data-testid="rhythm-break-actions">
        <Button op="focus-now" label="Focus now" busyLabel="Starting…" pending={pending} primary onClick={focusNow} />
        <Button op="more-break" label={`+${EXTEND_DEFAULT_MINUTES} min break`} busyLabel="Adding…" pending={pending} onClick={() => act('more-break', () => store.call('focus_extend', { minutes: EXTEND_DEFAULT_MINUTES }))} />
        <Button op="break-skip" label="End break" busyLabel="Ending…" pending={pending} onClick={() => act('break-skip', () => store.call('break_skip'))} />
      </div>
    </>
  )
}
