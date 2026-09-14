/**
 * The row's feedback slot: one sentence after an action (`Updated to a1b2c3d · reloaded
 * Acme Tracker`, `Could not update: ...`) with an optional Details disclosure holding the
 * raw git or npm text. Renders nothing when idle, so a row at rest has no fourth line.
 *
 * A success is marked as one: a small check icon in the row's own foreground, and the full
 * list of reloaded plugins as the sentence's title when the line abbreviates it to
 * `and 1 more` (N3-16). A failure is the one place red appears on the row.
 *
 * The Details toggle is drawn in a cell that also holds its widest label (`Hide details`),
 * so the control does not move or wrap when it is pressed (N3-6). The <pre> is always a
 * full-width block below the sentence.
 *
 * The feedback never times out on its own: a line that collapses while the user reads it
 * moves the next row's Update under the pointer. The owner replaces it on the next action.
 */
import { useEffect, useState } from 'react'
import type { Feedback } from './plugin-update-view'
import { PluginUpdateIcon } from './plugin-update-icons'
import '@/styles/plugin-updates.css'

export interface PluginUpdateFeedbackProps {
  rowId: string
  feedback?: Feedback | null
}

export function PluginUpdateFeedback({ rowId, feedback }: PluginUpdateFeedbackProps) {
  const [open, setOpen] = useState(false)
  // A new sentence folds the previous Details back up.
  useEffect(() => { setOpen(false) }, [feedback?.text, feedback?.detail])

  if (!feedback) return null
  const isError = feedback.kind === 'error'
  const cls = isError ? 'plugin-update-feedback plugin-update-feedback--error' : 'plugin-update-feedback plugin-update-feedback--ok'
  const detailId = `plugin-update-detail-${rowId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  return (
    <div className={cls} role="status" data-testid={`plugin-update-feedback-${rowId}`}>
      {!isError ? <PluginUpdateIcon name="check" size={14} className="plugin-update-feedback-icon" /> : null}
      <span className="plugin-update-feedback-text" title={feedback.title}>{feedback.text}</span>
      {feedback.detail ? (
        <button
          type="button"
          className="plugin-update-feedback-toggle"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="plugin-update-label" data-wide="Hide details"><span>{open ? 'Hide details' : 'Details'}</span></span>
        </button>
      ) : null}
      {feedback.detail && open ? (
        <pre id={detailId} className="plugin-update-detail">{feedback.detail}</pre>
      ) : null}
    </div>
  )
}
