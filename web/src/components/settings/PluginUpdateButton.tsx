/**
 * The one update verb on a row. Three looks (spec 6.3): primary when there is something
 * to take (`Update`, or `Restore` on a missing source), disabled-with-a-reason when the
 * checkout blocks it, and nothing at all when the chip already answered.
 *
 * Why the disabled state is wrapped: a disabled <button> shows no title on hover in
 * WebKit and no browser shows a title on keyboard focus, so the reason lives on a
 * focusable span (title + aria-describedby). While the span has focus or was clicked the
 * reason is ALSO shown as a small portalled tip under the button (`.plugin-update-reason`),
 * placed by useMenuPlacement: an overlay, so the row never grows and shrinks under the
 * pointer the way a line in the feedback slot did (N3-14). Overlay rules
 * (web/src/AGENTS.md): portalled to <body>, root stops pointerdown propagation.
 *
 * When the row renders NO button (`mode.render === false`) it still renders `UpdateSlot`, an
 * invisible, inert twin of the button, so the actions cluster keeps the width it has while
 * Update is shown: the row's controls do not shift when an update finishes (C15, N2-1)
 * and no fixed floor has to guess the widest row. Every label is drawn in a cell that also
 * holds the invisible widest label (`Updating…`), so the button is one width through
 * Update / Updating… / Restore and never slides under the pointer mid-action (N3-5).
 */
import { type MouseEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement'
import { plainText, updateDisabledTitle, type UpdateButtonMode } from './plugin-update-view'
import '@/styles/plugin-updates.css'

export interface PluginUpdateButtonProps {
  rowId: string
  mode: UpdateButtonMode
  onClick: () => void
}

export const reasonIdFor = (rowId: string): string => `plugin-update-reason-${rowId.replace(/[^a-zA-Z0-9_-]/g, '_')}`

/** The widest label the button can carry; every state reserves its width. */
const WIDEST_LABEL = 'Updating...'

/** The label in a one-cell grid with the invisible widest label, so width never changes. */
export function UpdateLabel({ label }: { label: string }) {
  return (
    <span className="plugin-update-label" data-wide={WIDEST_LABEL}>
      <span>{plainText(label)}</span>
    </span>
  )
}

/** The space an Update button would take, reserved while none is rendered. */
export function UpdateSlot({ rowId }: { rowId: string }) {
  return (
    <span className="plugin-update-slot" aria-hidden="true" data-testid={`plugin-update-slot-${rowId}`}>
      <span className="btn btn-secondary btn-sm plugin-update-button"><UpdateLabel label="Update" /></span>
    </span>
  )
}

export function PluginUpdateButton({ rowId, mode, onClick }: PluginUpdateButtonProps) {
  // The reason tip is open while the disabled wrapper has focus or was clicked.
  const [tipOpen, setTipOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const showTip = mode.render && 'disabled' in mode && mode.reason !== null && tipOpen
  const placement = useMenuPlacement(showTip, wrapRef, tipRef, {
    align: 'right',
    preferSide: 'down',
    minHeight: 24,
    gap: 4,
    onAnchorLost: () => setTipOpen(false),
  })

  if (!mode.render) return <UpdateSlot rowId={rowId} />
  const testId = `plugin-update-${rowId}`

  if ('primary' in mode) {
    return (
      <button
        type="button"
        className="btn btn-primary btn-sm plugin-update-button"
        data-testid={testId}
        title={mode.title ? plainText(mode.title) : undefined}
        onClick={(e: MouseEvent<HTMLButtonElement>) => { e.preventDefault(); onClick() }}
      >
        <UpdateLabel label={mode.label} />
      </button>
    )
  }

  if (mode.reason === null) {
    return (
      <button type="button" className="btn btn-secondary btn-sm plugin-update-button" data-testid={testId} disabled aria-busy="true">
        <UpdateLabel label={mode.label} />
      </button>
    )
  }

  const id = reasonIdFor(rowId)
  const reason = plainText(mode.reason)
  const hoverTitle = updateDisabledTitle(mode.reason)
  return (
    <span
      ref={wrapRef}
      className="plugin-update-disabled"
      tabIndex={0}
      title={hoverTitle}
      aria-describedby={id}
      data-testid={`plugin-update-wrap-${rowId}`}
      onFocus={() => setTipOpen(true)}
      onBlur={() => setTipOpen(false)}
      onClick={() => setTipOpen(true)}
    >
      <button
        type="button"
        className="btn btn-secondary btn-sm plugin-update-button"
        data-testid={testId}
        disabled
        title={hoverTitle}
        style={{ pointerEvents: 'none' }}
      >
        <UpdateLabel label={mode.label} />
      </button>
      {showTip && typeof document !== 'undefined'
        ? createPortal(
            <span
              ref={tipRef}
              id={id}
              className="plugin-update-reason"
              role="status"
              data-testid={`plugin-update-reason-${rowId}`}
              style={menuPlacementStyle(placement)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {reason}
            </span>,
            document.body,
          )
        : null}
    </span>
  )
}
