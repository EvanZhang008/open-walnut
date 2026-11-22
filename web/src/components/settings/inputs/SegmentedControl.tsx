/**
 * Segmented control (2 to 6 options on one axis). role=radiogroup with
 * role=radio segments; each segment wraps a hidden native radio, so a click on
 * the segment (and Playwright `.check()`) goes through the browser's own label
 * activation in Chromium and WebKit alike. Arrow keys move and select.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useControlGroupOff } from '@/components/controls/ControlGroup'
import '@/styles/choice-controls.css'

export interface SegmentedOption<V extends string> {
  value: V
  /** Text, or an icon (then give `ariaLabel` and `icon`). */
  label: ReactNode
  /** Accessible name when the label is not text. */
  ariaLabel?: string
  /** An icon-only segment: square padding. */
  icon?: boolean
  testId?: string
  title?: string
  /** Extra class on the segment, e.g. a stable hook that older test helpers select on. */
  className?: string
  /** This one segment can't be picked now (aria-disabled, so its title still explains why on hover). */
  disabled?: boolean
  /** Extra `data-*` attributes on the segment: stable hooks for specs and the view's own code. */
  data?: { [key: `data-${string}`]: string | undefined }
  /** id of the element that says more about this segment (e.g. why it is disabled). */
  describedBy?: string
}

export interface SegmentedControlProps<V extends string> {
  id?: string
  value: V
  options: ReadonlyArray<SegmentedOption<V>>
  onChange: (v: V) => void
  'aria-label': string
  disabled?: boolean
  /** Native radio group name (defaults to a generated one). */
  name?: string
  /** Extra classes on the group (placement only: margin, flex; never a look). */
  className?: string
  /** Stretch to the container's width, each segment the same width. */
  fill?: boolean
  /** `sm`: segments padded 0 8 px, for a menu row or a popover (as ToggleSwitch's `sm`). */
  size?: 'md' | 'sm'
  /** Only Left/Right/Home/End move the pick: Up and Down are left to a menu that moves between its rows. */
  horizontalKeys?: boolean
  /** A pick of the segment already shown as picked calls onChange too: for a control whose shown
   *  pick can differ from the saved value (a fallback, a retired value drawn as its successor). */
  reselect?: boolean
  'data-testid'?: string
  /** Tooltip on the whole group (e.g. why it is disabled). */
  title?: string
  /** Wrap the segments onto more lines where they do not fit, instead of scrolling sideways. */
  wrap?: boolean
}

/** Index reached by an arrow key from `from`, wrapping around. */
export function segmentIndexForKey(key: string, from: number, count: number): number | null {
  if (count <= 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return (from + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (from - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function SegmentedControl<V extends string>({
  id,
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
  disabled: ownDisabled,
  name,
  className,
  fill,
  size,
  horizontalKeys,
  reselect,
  'data-testid': testId,
  title,
  wrap,
}: SegmentedControlProps<V>) {
  // Inside a ControlGroup that is off (a disabled fieldset) the segments are disabled too: the
  // fieldset reaches the hidden radios, not the labels that take the focus.
  const groupOff = useControlGroupOff()
  const disabled = !!ownDisabled || groupOff
  const autoName = useId()
  const groupName = name ?? `seg-${autoName}`
  const rootRef = useRef<HTMLDivElement>(null)
  const selectedIndex = options.findIndex((o) => o.value === value)

  // From the keyboard the segment that takes the focus shows its ring (data-keyed): WebKit draws no
  // :focus-visible for a script's focus after a mouse press (2026-11-05 review: arrow keys moved
  // the pick with no ring to see).
  const select = (index: number, byKey = false) => {
    const opt = options[index]
    // Inside a disabled ControlGroup (a disabled fieldset) the keys pick nothing either.
    if (!opt || disabled || rootRef.current?.closest('fieldset:disabled')) return
    if ((opt.value !== value || reselect) && !opt.disabled) onChange(opt.value)
    const seg = rootRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[index]
    if (byKey && seg) {
      seg.setAttribute('data-keyed', 'true')
      const clear = () => { seg.removeAttribute('data-keyed'); seg.removeEventListener('blur', clear) }
      seg.addEventListener('blur', clear)
    }
    seg?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, index: number) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      select(index, true)
      return
    }
    if (horizontalKeys && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return
    const next = segmentIndexForKey(e.key, index, options.length)
    if (next === null) return
    e.preventDefault()
    select(next, true)
  }

  return (
    <div
      ref={rootRef}
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled ? true : undefined}
      data-testid={testId}
      title={title}
      className={`wn-seg settings-segmented${fill ? ' wn-seg-fill' : ''}${size === 'sm' ? ' wn-seg-sm' : ''}${wrap ? ' wn-seg-wrap' : ''}${className ? ` ${className}` : ''}`}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value
        const focusable = selected || (selectedIndex === -1 && i === 0)
        return (
          <label
            key={opt.value}
            role="radio"
            aria-checked={selected}
            aria-disabled={disabled || opt.disabled ? true : undefined}
            tabIndex={disabled ? -1 : focusable ? 0 : -1}
            {...opt.data}
            data-testid={opt.testId}
            title={opt.title}
            aria-label={opt.ariaLabel}
            aria-describedby={opt.describedBy}
            className={`wn-seg-item settings-segment${opt.icon ? ' wn-seg-icon' : ''}${selected ? ' is-selected' : ''}${opt.className ? ` ${opt.className}` : ''}`}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <input
              type="radio"
              name={groupName}
              value={opt.value}
              checked={selected}
              disabled={disabled || opt.disabled}
              tabIndex={-1}
              aria-hidden="true"
              className="wn-seg-input"
              onChange={() => onChange(opt.value)}
              // A checked radio fires no change event on a click: `reselect` hears the click.
              onClick={reselect && selected ? () => onChange(opt.value) : undefined}
              // A click on the segment focuses this hidden radio (label activation): the focus goes
              // to the segment itself, which carries the ring and the arrow keys (2026-11-05 review).
              onFocus={(e) => (e.currentTarget.parentElement as HTMLElement | null)?.focus({ preventScroll: true })}
            />
            <span className="settings-segment-label">{opt.label}</span>
          </label>
        )
      })}
    </div>
  )
}
