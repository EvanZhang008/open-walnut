/**
 * Mac Do Not Disturb in the popover: the Start form's switch for the next block, and the
 * running block's row (where it stands, and Turn on / Turn off for this block only).
 */
import { useState } from 'react'
import { dndRowView } from './dnd-model'
import type { RhythmPublicState, RhythmStore } from './store'
import { Checkbox } from './host-controls'

/** The Start form's switch. Shown only on the Mac that hosts Walnut. */
export function DndStartToggle({ state, value, onChange }: { state: RhythmPublicState; value: boolean; onChange(next: boolean): void }) {
  if (!state.dnd.available) return null
  return (
    <span className="rhythm-dnd-toggle" data-testid="rhythm-start-dnd">
      <Checkbox checked={value} onChange={onChange} data-testid="rhythm-start-dnd-input" label="Turn on Mac Do Not Disturb until it ends" />
    </span>
  )
}

export function DndBlockRow({ store, state }: { store: RhythmStore; state: RhythmPublicState }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = dndRowView(state)
  if (!view) return null
  const act = (on: boolean) => {
    setPending(true)
    setError(null)
    void store.call('focus_dnd', { on }).then((outcome) => {
      setPending(false)
      if (!outcome.ok) setError(outcome.message)
    })
  }
  const busy = pending || view.busy
  return (
    <div className="rhythm-dnd-row" data-testid="rhythm-dnd-row" data-status={state.dnd.record?.status ?? 'none'}>
      <p className={view.tone === 'error' ? 'rhythm-error' : 'rhythm-status'} role="status" data-testid="rhythm-dnd-line">{view.text}</p>
      {view.action && (
        <button type="button" className="btn btn-sm" disabled={busy} aria-busy={busy || undefined} data-testid={`rhythm-dnd-${view.action}`} onClick={() => act(view.action === 'on')}>
          {view.action === 'on' ? 'Turn on Do Not Disturb' : 'Turn off Do Not Disturb'}
        </button>
      )}
      {error && <p className="rhythm-error" role="status">{error}</p>}
    </div>
  )
}
