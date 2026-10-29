/**
 * One card on the Apps page, the same for a built-in app, an installed plugin and one you
 * can get: icon, name, one line, and a footer with its one status and where it comes from.
 * The whole card opens the detail page. Its other controls are Open (something with an
 * App) and, on a built-in app that can leave the sidebar, that one switch; never an
 * inline form.
 *
 * The card's main button is stretched over the card (`.apps-card-main::after`), and Open
 * and the switch sit above it, so there is no button inside a button.
 */
import type { ReactNode } from 'react'
import type { CardTone } from './plugin-store-model'

export interface StoreCardProps {
  testId: string
  icon: ReactNode
  name: string
  /** Drawn after the name, like the Sidebar's badge. */
  badge?: ReactNode
  line: string
  /** A second, quieter line: the parts a plugin includes. */
  note?: string
  status: { text: string; tone: CardTone }
  /** Drawn in place of the status dot (a lock for what cannot change). */
  statusGlyph?: ReactNode
  /** A control of its own in the footer, before Open (the sidebar switch of a built-in). */
  control?: ReactNode
  /** Where it comes from (`Built in`, `Local folder`, ...), right of the status. */
  kind?: string
  onSelect: () => void
  /** Opens its App directly. */
  open?: { label: string; onClick: () => void; testId: string }
  dim?: boolean
  data?: Record<`data-${string}`, string | boolean | undefined>
}

export function StoreCard({ testId, icon, name, badge, line, note, status, statusGlyph, control, kind, onSelect, open, dim, data }: StoreCardProps) {
  return (
    <div className={`apps-card${dim ? ' apps-card-dim' : ''}`} data-testid={testId} data-card-tone={status.tone} {...data}>
      <div className="apps-card-top">
        <span className="apps-card-icon">{icon}</span>
        <div className="apps-card-text">
          <button type="button" className="apps-card-main" onClick={onSelect} data-testid={`${testId}-details`}>
            <span className="apps-card-name">{name}</span>
          </button>
          {badge}
          <div className="apps-card-line">{line}</div>
          {note && <div className="apps-card-note">{note}</div>}
        </div>
      </div>
      <div className="apps-card-foot">
        <span className={`apps-card-status apps-card-status--${status.tone}`} data-testid={`${testId}-status`}>
          {statusGlyph ?? <i aria-hidden="true" />}{status.text}
        </span>
        {(control || open) ? (
          <span className="apps-card-actions">
            {control}
            {open && (
              <button
                type="button"
                className="apps-card-open"
                onClick={open.onClick}
                data-testid={open.testId}
                aria-label={`${open.label} ${name}`}
              >
                {open.label}
              </button>
            )}
          </span>
        ) : kind ? <span className="apps-card-kind">{kind}</span> : null}
      </div>
    </div>
  )
}
