/**
 * Rhythm's choice controls, drawn by the host's own looks (Walnut's standard.md, "Choice
 * controls"): a plugin cannot import the host's components, so it renders the host's markup
 * and the host's stylesheet draws it. `Segments` is the shared segmented control (`wn-seg`:
 * a grey track, the pick a white thumb). A picked track or task is the host's Picked row: the
 * row carries `wn-pick-row` and `aria-checked`, and the host colours its name (no check mark, no
 * fill). Rhythm gives them placement only.
 */
import type { KeyboardEvent } from 'react'

export interface SegmentOption<V extends string | number> {
  value: V
  label: string
  testId?: string
}

/** One of a few short values (the minutes presets, how the folder plays). Arrows move and pick. */
export function Segments<V extends string | number>({ value, options, onChange, labelledBy, label }: {
  value: V | null
  options: ReadonlyArray<SegmentOption<V>>
  onChange(next: V): void
  labelledBy?: string
  label?: string
}) {
  const picked = options.findIndex((one) => one.value === value)
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = options.length
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % n
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + n) % n
        : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : null
    if (next === null) return
    event.preventDefault()
    onChange(options[next].value)
    const group = event.currentTarget.parentElement
    group?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }
  return (
    <div className="wn-seg wn-seg-sm rhythm-segments" role="radiogroup" aria-labelledby={labelledBy} aria-label={label}>
      {options.map((one, i) => (
        <button
          key={String(one.value)}
          type="button"
          role="radio"
          aria-checked={one.value === value}
          tabIndex={i === picked || (picked === -1 && i === 0) ? 0 : -1}
          className="wn-seg-item"
          data-testid={one.testId}
          onClick={() => onChange(one.value)}
          onKeyDown={(event) => onKey(event, i)}
        >
          {one.label}
        </button>
      ))}
    </div>
  )
}
