/**
 * Segmented control (2 to 6 options on one axis). role=radiogroup with
 * role=radio segments; each segment wraps a hidden native radio, so a click on
 * the segment (and Playwright `.check()`) goes through the browser's own label
 * activation in Chromium and WebKit alike. Arrow keys move and select.
 */
import { useId, useRef, type KeyboardEvent } from 'react'
import '@/styles/settings-controls.css'

export interface SegmentedOption<V extends string> {
  value: V
  label: string
  testId?: string
  title?: string
  /** Extra class on the segment, e.g. a stable hook that older test helpers select on. */
  className?: string
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
  disabled,
  name,
}: SegmentedControlProps<V>) {
  const autoName = useId()
  const groupName = name ?? `seg-${autoName}`
  const rootRef = useRef<HTMLDivElement>(null)
  const selectedIndex = options.findIndex((o) => o.value === value)

  const select = (index: number) => {
    const opt = options[index]
    if (!opt || disabled) return
    if (opt.value !== value) onChange(opt.value)
    const seg = rootRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[index]
    seg?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, index: number) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      select(index)
      return
    }
    const next = segmentIndexForKey(e.key, index, options.length)
    if (next === null) return
    e.preventDefault()
    select(next)
  }

  return (
    <div
      ref={rootRef}
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled ? true : undefined}
      className="settings-segmented"
    >
      {options.map((opt, i) => {
        const selected = opt.value === value
        const focusable = selected || (selectedIndex === -1 && i === 0)
        return (
          <label
            key={opt.value}
            role="radio"
            aria-checked={selected}
            aria-disabled={disabled ? true : undefined}
            tabIndex={disabled ? -1 : focusable ? 0 : -1}
            data-testid={opt.testId}
            title={opt.title}
            className={`settings-segment${selected ? ' is-selected' : ''}${opt.className ? ` ${opt.className}` : ''}`}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <input
              type="radio"
              name={groupName}
              value={opt.value}
              checked={selected}
              disabled={disabled}
              tabIndex={-1}
              aria-hidden="true"
              className="settings-segment-input"
              onChange={() => onChange(opt.value)}
            />
            <span className="settings-segment-label">{opt.label}</span>
          </label>
        )
      })}
    </div>
  )
}
