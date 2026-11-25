/**
 * Tabs: switch between the panels of one view (standard.md, "Choice controls"). One look: an
 * underline under the selected tab, 32 px, 13 px. role=tablist / role=tab with aria-selected; the
 * Left and Right arrows, Home and End move between tabs and select (automatic activation), and only
 * the selected tab is in the Tab order.
 *
 * `Tabs` takes a list of items; `TabList` + `Tab` are for a strip whose tabs carry more (a close
 * button, a drag handle): the look and the keys are the same. `TabList tiles` draws its tabs as
 * large square cards (an icon, a title, a line), for a choice between two kinds of the same
 * thing at the top of a form (the new task draft's Start task / Quick chat); the keys stay.
 */
import { useCallback, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { useSelectionSlide } from '@/utils/selection-slide'
import { segmentIndexForKey } from '../settings/inputs/SegmentedControl'
import '@/styles/choice-controls.css'

export interface TabItem<V extends string> {
  value: V
  label: ReactNode
  /** A number after the label (muted). */
  count?: ReactNode
  /** Accessible name when the label is not text. */
  ariaLabel?: string
  title?: string
  testId?: string
  disabled?: boolean
  /** Extra class on the tab: a stable hook for specs, never a look. */
  className?: string
}

export interface TabsProps<V extends string> {
  value: V
  items: ReadonlyArray<TabItem<V>>
  onChange: (v: V) => void
  'aria-label': string
  /** Classes on the list (placement only). */
  className?: string
  /** No line under the whole strip (it sits on a header that has its own). */
  flush?: boolean
  'data-testid'?: string
  /** id of the panel each tab controls: (value) => id. */
  panelId?: (v: V) => string
}

/** Move the focus to the tab the key names and select it. A strip is a row: Left and Right move
 *  along it, Up and Down are left to the page (they move a tab only in an aria-orientation=vertical list). */
function onListKey(e: KeyboardEvent<HTMLElement>) {
  const vertical = e.currentTarget.getAttribute('aria-orientation') === 'vertical'
  if (vertical ? e.key === 'ArrowLeft' || e.key === 'ArrowRight' : e.key === 'ArrowUp' || e.key === 'ArrowDown') return
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')]
  const at = tabs.indexOf(document.activeElement as HTMLElement)
  if (at < 0) return
  const next = segmentIndexForKey(e.key, at, tabs.length)
  if (next === null) return
  e.preventDefault()
  tabs[next].focus()
  tabs[next].click()
}

/** `wrap`: wider than a phone, the tabs wrap into a grid of columns instead of scrolling sideways
 *  (tabs with a detail line under the label read in one or two lines that way); a phone keeps
 *  the one scrolling row. */
export function TabList({ className, flush, tiles, wrap, children, onKeyDown, ref, ...rest }: HTMLAttributes<HTMLDivElement> & { flush?: boolean; tiles?: boolean; wrap?: boolean; 'aria-label'?: string; ref?: Ref<HTMLDivElement> }) {
  // The picked tab's capsule slides to the new pick (utils/selection-slide.ts). Tiles keep their
  // edge, and a strip that wraps onto rows jumps.
  const own = useRef<HTMLDivElement | null>(null)
  useSelectionSlide(own, ':scope > [role="tab"][aria-selected="true"]', !tiles && !wrap)
  const setRef = useCallback((el: HTMLDivElement | null) => {
    own.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) (ref as { current: HTMLDivElement | null }).current = el
  }, [ref])
  return (
    <div
      role="tablist"
      ref={setRef}
      {...rest}
      className={`wn-tabs${flush || tiles ? ' wn-tabs-flush' : ''}${tiles ? ' wn-tabs-tiles' : ''}${wrap ? ' wn-tabs-wrap' : ''}${className ? ` ${className}` : ''}`}
      onKeyDown={(e) => { onKeyDown?.(e); if (!e.defaultPrevented) onListKey(e) }}
    >
      {children}
    </div>
  )
}

export interface TabProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role'> {
  selected: boolean
  count?: ReactNode
  /** After the label and count, e.g. a close button (keep it out of the tab's own click). */
  trailing?: ReactNode
  /** A short muted line under the label (what the tab is for); the tab grows to two lines. */
  detail?: ReactNode
  /** The tab's button (scroll it into view), passed straight through (a prop in React 19). */
  ref?: Ref<HTMLButtonElement>
}

export function Tab({ selected, count, trailing, detail, className, children, ...rest }: TabProps) {
  // A space before the count keeps it its own word in the tab's text ("Changes 12"); the
  // inline-flex row draws none of it.
  const countEl = count !== undefined && count !== null && count !== false && <>{' '}<span className="wn-tab-count">{count}</span></>
  const tall = detail !== undefined && detail !== null && detail !== false
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      {...rest}
      className={`wn-tab${tall ? ' wn-tab-tall' : ''}${selected ? ' is-selected' : ''}${className ? ` ${className}` : ''}`}
    >
      {tall ? (
        <span className="wn-tab-text">
          <span className="wn-tab-line">{children}{countEl}</span>
          <span className="wn-tab-detail">{detail}</span>
        </span>
      ) : (
        <>{children}{countEl}</>
      )}
      {trailing && <span className="wn-tab-trailing">{trailing}</span>}
    </button>
  )
}

export function Tabs<V extends string>({ value, items, onChange, 'aria-label': ariaLabel, className, flush, 'data-testid': testId, panelId }: TabsProps<V>) {
  const anySelected = items.some((it) => it.value === value)
  return (
    <TabList aria-label={ariaLabel} className={className} flush={flush} data-testid={testId}>
      {items.map((it, i) => (
        <Tab
          key={it.value}
          selected={it.value === value}
          // With nothing selected the first tab takes the Tab key.
          tabIndex={it.value === value || (!anySelected && i === 0) ? 0 : -1}
          count={it.count}
          title={it.title}
          aria-label={it.ariaLabel}
          aria-controls={panelId?.(it.value)}
          data-testid={it.testId}
          data-value={it.value}
          disabled={it.disabled}
          className={it.className}
          onClick={() => { if (it.value !== value) onChange(it.value) }}
        >
          {it.label}
        </Tab>
      ))}
    </TabList>
  )
}
