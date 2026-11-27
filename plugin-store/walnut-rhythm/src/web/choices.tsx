/**
 * Rhythm's choice controls are Walnut's own (Walnut's standard.md, "Choice controls"):
 * `Segments` is the shared segmented control through `walnut.ui.views.Segmented`
 * (host-controls.tsx), a round track with the pick a lifted thumb, arrow keys moving the pick. A
 * picked track or task is the host's Picked row: the row carries `wn-pick-row` and
 * `aria-checked`, and the host colours its name (no check mark, no fill). Rhythm gives them
 * placement only.
 */
import { Segmented } from './host-controls'

export interface SegmentOption<V extends string | number> {
  value: V
  label: string
  testId?: string
}

/** One of a few short values (the minutes presets, how the folder plays). Arrows move and pick. */
export function Segments<V extends string | number>({ value, options, onChange, label }: {
  value: V | null
  options: ReadonlyArray<SegmentOption<V>>
  onChange(next: V): void
  label: string
}) {
  // The shared control takes string values: a number preset goes through its text and back.
  const byKey = new Map(options.map((one) => [String(one.value), one.value]))
  return (
    <Segmented
      size="sm"
      className="rhythm-segments"
      aria-label={label}
      value={value === null ? null : String(value)}
      options={options.map((one) => ({ value: String(one.value), label: one.label, testId: one.testId }))}
      onChange={(key) => { const next = byKey.get(key); if (next !== undefined) onChange(next) }}
    />
  )
}
