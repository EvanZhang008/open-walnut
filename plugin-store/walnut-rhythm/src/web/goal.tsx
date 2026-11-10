/**
 * The block's goal: what the person means to get done in it, in their own words.
 *
 * Set in the Start form (`GoalInput`), and set, changed or cleared while the block runs
 * (`GoalRow`, op `focus_goal`). The ring's popover already names the goal in its header
 * (the status item's detail), so there the row is only its Edit button (`compact`); the
 * App shows the goal itself above it.
 */
import { useEffect, useRef, useState } from 'react'
import { GOAL_MAX } from '../server/focus'
import type { RhythmStore } from './store'

/**
 * An Enter that confirms an input method's candidate (Chinese, Japanese), not the field.
 * Safari ends the composition before that keydown, so it reads isComposing false and
 * keyCode 229.
 */
function composing(event: { nativeEvent: KeyboardEvent; keyCode: number }): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

export const GOAL_PLACEHOLDER = 'What will you get done? (optional)'

/** The Start form's goal field. Only the Start button starts a block, so Enter does nothing here. */
export function GoalInput({ value, onChange, testId }: {
  value: string
  onChange(next: string): void
  testId: string
}) {
  return (
    <label className="rhythm-start-row rhythm-goal-field">
      <span className="rhythm-start-label">Goal</span>
      <input
        type="text"
        className="rhythm-goal-input"
        value={value}
        maxLength={GOAL_MAX}
        placeholder={GOAL_PLACEHOLDER}
        aria-label="Goal for this block"
        data-testid={testId}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  )
}

/** The running block's goal, with a way to set, change or clear it. */
export function GoalRow({ store, goal, compact }: { store: RhythmStore; goal: string | undefined; compact?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(goal ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => { if (editing) input.current?.focus() }, [editing])
  // Another device (or an agent) changed it while this one was not editing: show theirs.
  useEffect(() => { if (!editing) setText(goal ?? '') }, [goal, editing])

  const save = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    void store.call('focus_goal', { goal: text }).then((outcome) => {
      setBusy(false)
      if (outcome.ok) setEditing(false)
      else setError(outcome.message)
    })
  }
  const cancel = () => { setEditing(false); setError(null); setText(goal ?? '') }

  if (editing) {
    return (
      <div className="rhythm-goal rhythm-goal-editing" data-testid="rhythm-goal-row">
        <input
          ref={input}
          type="text"
          className="rhythm-goal-input"
          value={text}
          maxLength={GOAL_MAX}
          placeholder={GOAL_PLACEHOLDER}
          aria-label="Goal for this block"
          data-testid="rhythm-goal-input"
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (composing(event)) return
            if (event.key === 'Enter') { event.preventDefault(); save() }
            // Escape leaves the edit, not the popover around it.
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
          }}
        />
        <div className="rhythm-goal-buttons">
          <button type="button" className="rhythm-button rhythm-primary" disabled={busy} aria-busy={busy || undefined} data-testid="rhythm-goal-save" onClick={save}>
            {busy ? 'Saving…' : 'Save goal'}
          </button>
          <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-goal-cancel" onClick={cancel}>Cancel</button>
        </div>
        {error && <p className="rhythm-error" role="status" data-testid="rhythm-goal-error">{error}</p>}
      </div>
    )
  }
  return (
    <div className="rhythm-goal" data-testid="rhythm-goal-row">
      {!compact && goal && <p className="rhythm-goal-text" data-testid="rhythm-goal-text"><span className="rhythm-goal-label">Goal</span> {goal}</p>}
      <button type="button" className="rhythm-link-button" data-testid="rhythm-goal-edit" onClick={() => setEditing(true)}>
        {goal ? 'Edit goal' : 'Set a goal for this block'}
      </button>
    </div>
  )
}
