/**
 * ControlGroup: the controls that only mean something while a master switch is on (an Inbox Triage
 * rule under the Inbox Triage switch). While the master is off the whole group is disabled (a
 * native disabled fieldset, so every input and button inside is, from the keyboard too) and drawn
 * as off: an on switch or a ticked box inside is grey, not accent blue, so nothing looks active that
 * is not. A line under the master says why (`reason`).
 *
 * The master names the group with aria-controls (`masterProps(id)`), so a check can find each
 * pair on the page: tests/e2e/browser/choice-controls-dependent.spec.ts.
 *
 * 2026-11-21 Settings review on the user's data: the Inbox Triage switch was off while its rule
 * switches were still bright blue; a Sessions switch was off with live-looking boxes under it.
 */
import type { ReactNode } from 'react'
import '@/styles/choice-controls.css'

export interface ControlGroupProps {
  /** id the master switch names in aria-controls. */
  id: string
  /** The master is off: disable and grey the group. */
  off: boolean
  /** One short line on why the group is off, e.g. "Turn on Inbox Triage to use its rules." */
  reason?: ReactNode
  className?: string
  children: ReactNode
  'data-testid'?: string
}

export function ControlGroup({ id, off, reason, className, children, 'data-testid': testId }: ControlGroupProps) {
  return (
    <fieldset
      id={id}
      disabled={off}
      data-off={off ? 'true' : undefined}
      data-testid={testId}
      className={`wn-group${className ? ` ${className}` : ''}`}
    >
      {off && reason ? <p className="wn-group-reason">{reason}</p> : null}
      {children}
    </fieldset>
  )
}

/**
 * Props for the master switch of one or more ControlGroups. A master whose controls sit in several
 * boxes of a pane (Inbox Triage: its schedule rows, Sources, Actions) names every group; the first
 * one carries the reason line.
 */
export const masterProps = (...groupIds: string[]) => ({ 'aria-controls': groupIds.join(' ') })
