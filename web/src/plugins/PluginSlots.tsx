/**
 * Where plugins draw inside a host surface (`walnut.ui.slot`, packages/plugin-api web.ts).
 *
 * A surface places ONE <PluginSlots target=… props=…/> where its slot belongs; every
 * active plugin's contribution for that target renders there, in order, each inside
 * its own PluginBoundary, so a plugin that throws costs its own value and nothing of the
 * panel around it. With no contribution it renders nothing at all: no wrapper, no gap.
 *
 * Every target is a labelled fact (the task's metadata, the top of the session menu), so a
 * surface wraps each slot in <PluginSlotFact>, which prints the slot's title in the
 * surface's own label style and hides the whole fact while the plugin renders nothing.
 */
import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
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

interface PluginSlotsProps<T extends PluginSlotTarget> {
  target: T
  props: Omit<PluginSlotPropsByTarget[T], 'navigate'>
  /** Wrap each rendered slot. Default: rendered as is. */
  wrap?: (entry: SlotEntry, node: ReactNode) => ReactNode
  /** A wrapper element around all of them, rendered only when there is at least one. */
  className?: string
  /**
   * Runs before a slot navigates. A surface that floats over the page (the task detail
   * modal, the session menu) closes itself here; otherwise it would stay on top of the
   * page the slot opened.
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

interface PluginSlotFactProps {
  entry: SlotEntry
  children: ReactNode
  className?: string
  labelClassName?: string
  valueClassName?: string
  /** Text before the label, for a fact inside a run of text (" · "). */
  separator?: string
}

/**
 * One slot as a labelled fact: the slot's title, then the plugin's value. The fact is
 * hidden while the value is empty (the plugin rendered null: no data, not loaded yet, a
 * replica without the store), so a label never stands alone.
 */
export function PluginSlotFact({ entry, children, className, labelClassName, valueClassName, separator }: PluginSlotFactProps) {
  const valueRef = useRef<HTMLSpanElement>(null)
  const [empty, setEmpty] = useState(true)
  useLayoutEffect(() => {
    const el = valueRef.current
    if (!el) return
    const check = () => setEmpty(el.childNodes.length === 0)
    check()
    const observer = new MutationObserver(check)
    observer.observe(el, { childList: true })
    return () => observer.disconnect()
  }, [])
  return (
    <span
      className={className}
      data-slot={entry.key}
      // An inline style, not the `hidden` attribute: a surface's display rule would beat that.
      style={empty ? { display: 'none' } : undefined}
    >
      {/* No label while empty: a hidden fact must not even count as a label. */}
      {!empty && <>{separator}<span className={labelClassName}>{entry.value.title}</span>{' '}</>}
      <span ref={valueRef} className={valueClassName}>{children}</span>
    </span>
  )
}
