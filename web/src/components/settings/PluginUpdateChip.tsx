/**
 * The update chip: an OUTLINE pill next to the version ("is it current?"), deliberately
 * unlike the solid `.badge` run-state pill ("is it running?"). One component for linked,
 * git and npm rows and for the Sources group, so a slug's two chips always agree.
 * All wording and state mapping is in plugin-update-view.ts; this file only renders.
 */
import { type MouseEvent, useCallback } from 'react'
import type { UpdateState } from './plugin-update-types'
import { type BusyKind, chipView, plainText } from './plugin-update-view'
import { PluginUpdateIcon } from './plugin-update-icons'
import '@/styles/plugin-updates.css'

export interface PluginUpdateChipProps {
  rowId: string
  /** Undefined = the first GET has not answered yet (blank placeholder, aria-busy). */
  state: UpdateState | undefined
  checkedAt: string | null
  busy?: BusyKind | null
  /** Replica mode: a static span carrying `staticTitle`, never a button. */
  isStatic?: boolean
  staticTitle?: string
  transient?: boolean
  toRef?: string
  /** Reference clock for the relative time in the tooltip; the header re-renders every 30 s. */
  now?: number
  /** The browser is offline: the words stay, the stale marking is added (C49). */
  offline?: boolean
  /** On a Sources card whose Update lives on the Installed row (N3-11). */
  updateElsewhere?: boolean
  onCheck?: () => void
}

export function PluginUpdateChip(props: PluginUpdateChipProps) {
  const { rowId, state, checkedAt, busy, isStatic, staticTitle, transient, toRef, now, offline, updateElsewhere, onCheck } = props
  const view = chipView(state, {
    checkedAt,
    now,
    busy: busy ?? null,
    transient,
    toRef,
    offline,
    updateElsewhere,
    ...(isStatic ? { staticNote: staticTitle ?? '' } : {}),
  })
  const className = ['plugin-update-chip', ...view.modifiers.map((m) => `plugin-update-chip${m}`)].join(' ')
  const label = plainText(view.label)
  const title = plainText(view.title)
  const ariaLabel = view.kind === 'pending'
    ? 'Checking for updates'
    : title ? `${label} (${title})` : label

  const onClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    if (view.busy || !view.clickable) return
    onCheck?.()
  }, [view.busy, view.clickable, onCheck])

  const body = (
    <>
      {view.icon ? <PluginUpdateIcon name={view.icon} /> : null}
      {label ? <span className="plugin-update-chip-label">{label}</span> : null}
      {view.stale ? (
        // Inside the pill, after the words: a corner badge notched the outline and read as a
        // rendering glitch at 9 px (N13).
        <PluginUpdateIcon name="cloud-off" size={12} className="plugin-update-chip-stale-mark" />
      ) : null}
    </>
  )

  if (isStatic || (!view.clickable && !view.busy && view.kind !== 'pending')) {
    return (
      <span
        className={className}
        data-testid={`update-chip-${rowId}`}
        data-update-kind={view.kind}
        data-static="true"
        title={title || undefined}
        aria-label={ariaLabel}
      >
        {body}
      </span>
    )
  }

  return (
    <button
      type="button"
      className={className}
      data-testid={`update-chip-${rowId}`}
      data-update-kind={view.kind}
      title={title || undefined}
      aria-label={ariaLabel}
      aria-busy={view.busy || undefined}
      onClick={onClick}
    >
      {body}
    </button>
  )
}
