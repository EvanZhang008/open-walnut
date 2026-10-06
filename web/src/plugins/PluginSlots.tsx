/**
 * Where plugins draw inside a host surface (`walnut.ui.slot`, packages/plugin-api web.ts).
 *
 * A surface places ONE <PluginSlots target=… props=…/> where its slot belongs; every
 * active plugin's contribution for that target renders there, in order, each inside
 * its own PluginBoundary, so a plugin that throws costs its own chip and nothing of the
 * panel around it. With no contribution it renders nothing at all: no wrapper, no gap.
 *
 * `wrap` lets a surface put each slot inside its own element. The session header uses it
 * to give every slot a `data-header-id`, which is what lets the tool row's width fit
 * measure it and move it into the "..." menu like a built-in chip.
 */
import { Fragment, useCallback, useMemo, type ComponentType, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { PluginBoundary } from '@/components/common/PluginBoundary'
import { isPopoutPath } from '@/popout/openPopout'
import { usePluginUi } from './hooks'
import '@/styles/plugin-slots.css'
import type {
  PluginSlotContribution, PluginSlotPropsByTarget, PluginSlotTarget, RegisteredUiContribution,
} from './types'

export type SlotEntry = RegisteredUiContribution<PluginSlotContribution>

const DEFAULT_ORDER = 500

/** The id a slot carries in the session header's tool row (`data-header-id`). */
export const slotHeaderId = (entry: SlotEntry) => `slot:${entry.key}`

interface PluginSlotsProps<T extends PluginSlotTarget> {
  target: T
  props: Omit<PluginSlotPropsByTarget[T], 'navigate'>
  /** Wrap each rendered slot. Default: rendered as is. */
  wrap?: (entry: SlotEntry, node: ReactNode) => ReactNode
  /** A wrapper element around all of them, rendered only when there is at least one. */
  className?: string
  /**
   * Runs before a slot navigates. A surface that floats over the page (the task detail
   * modal) closes itself here; otherwise it would stay on top of the page the slot opened.
   */
  onNavigate?: () => void
}

export function PluginSlots<T extends PluginSlotTarget>({ target, props, wrap, className, onNavigate }: PluginSlotsProps<T>) {
  const ui = usePluginUi()
  const routerNavigate = useNavigate()
  const navigate = useCallback((path: string) => {
    // A pop-out tab is one task or one session on its own; leaving it would lose it.
    // Open the destination in a tab of its own instead.
    if (isPopoutPath(window.location.pathname)) {
      window.open(path, '_blank')
      return
    }
    onNavigate?.()
    routerNavigate(path)
  }, [routerNavigate, onNavigate])
  const entries = useMemo(
    () => ui.slots
      .filter((entry) => entry.value.target === target)
      .sort((a, b) => ((a.value.order ?? DEFAULT_ORDER) - (b.value.order ?? DEFAULT_ORDER)) || a.key.localeCompare(b.key)),
    [ui.slots, target],
  )
  if (entries.length === 0) return null
  const nodes = entries.map((entry) => {
    // The registry holds every target's slots in one list; this one's target was filtered above.
    const Component = entry.value.component as unknown as ComponentType<Record<string, unknown>>
    const node = (
      <PluginBoundary
        key={entry.key}
        pluginId={entry.pluginId}
        pluginName={entry.pluginName}
        resetKey={entry.generation}
        compact
        // A broken slot disappears; the boundary's own log line names the plugin.
        fallback={null}
      >
        <Component {...props} navigate={navigate} />
      </PluginBoundary>
    )
    return wrap ? <Fragment key={entry.key}>{wrap(entry, node)}</Fragment> : node
  })
  return className ? <div className={className}>{nodes}</div> : <>{nodes}</>
}
