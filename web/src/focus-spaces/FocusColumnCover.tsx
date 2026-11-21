/**
 * A chat column whose task is outside the focus is covered, never closed or moved: the person
 * sees no reply streaming there while they focus, and the columns stand where they were when
 * they leave. "Show it" lifts the cover for this column until the focus changes.
 */
import { useState } from 'react'
import type { ActiveFocus } from './focus-store'

export function FocusColumnCover({ active, title }: { active: ActiveFocus; title?: string }) {
  const [shownFor, setShownFor] = useState<number | null>(null)
  if (shownFor === active.since) return null
  return (
    <div className="focus-column-cover" data-testid="focus-column-cover">
      <div className="focus-column-cover-title">{title ? `${title} is outside ${active.name}` : `Outside ${active.name}`}</div>
      <div>It waits here, quietly, until you leave the focus.</div>
      <button type="button" className="btn btn-sm" onClick={() => setShownFor(active.since)}>Show it</button>
    </div>
  )
}
