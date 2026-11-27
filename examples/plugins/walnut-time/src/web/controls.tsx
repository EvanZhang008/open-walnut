import type { CheckboxViewProps, SegmentedViewProps, TabsViewProps, WalnutWebApi } from '@open-walnut/plugin-api/web'

/**
 * The console's own choice controls, through `walnut.ui.views` (standard.md, "Choice controls"):
 * the Time page's tabs, its range, kind, view and device pickers and its two checkboxes are the
 * components every other page draws, so they look and work the same (a round track, round tabs,
 * arrow keys, the sliding thumb). 2026-11-27 UI audit: the page drew square-cornered copies of its
 * own beside the Calendar's round ones.
 *
 * `activate` hands the host's views over once (`setHostControls`). A host older than these views
 * has none of them: there each pick falls back to a row of the host's plain keys (`btn btn-sm`)
 * with the family's on state (`aria-pressed`), never a look of this plugin's own.
 */
type Views = WalnutWebApi['ui']['views']
let host: Pick<Views, 'Segmented' | 'Tabs' | 'Checkbox'> = {}

export function setHostControls(views: Views): void {
  host = { Segmented: views.Segmented, Tabs: views.Tabs, Checkbox: views.Checkbox }
}

type Pick1<V extends string> = { value: V | null; options: SegmentedViewProps<V>['options']; onChange(value: V): void; label: string; className?: string; testId?: string }

/** A host without the view: one plain key per value, the picked one pressed. */
function KeyRow<V extends string>({ value, options, onChange, label, className, testId }: Pick1<V>) {
  return (
    <div role="group" aria-label={label} className={`wt-key-row${className ? ` ${className}` : ''}`} data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="btn btn-sm"
          aria-pressed={o.value === value}
          aria-label={o.ariaLabel}
          title={o.title}
          disabled={o.disabled}
          data-testid={o.testId}
          onClick={() => { if (o.value !== value) onChange(o.value) }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Segmented<V extends string>(props: SegmentedViewProps<V>) {
  const View = host.Segmented
  if (View) return <View {...(props as unknown as SegmentedViewProps)} />
  return <KeyRow value={props.value} options={props.options} onChange={props.onChange} label={props['aria-label']} className={props.className} testId={props['data-testid']} />
}

export function Tabs<V extends string>(props: TabsViewProps<V>) {
  const View = host.Tabs
  if (View) return <View {...(props as unknown as TabsViewProps)} />
  return <KeyRow value={props.value} options={props.items} onChange={props.onChange} label={props['aria-label']} className={props.className} testId={props['data-testid']} />
}

export function Checkbox(props: CheckboxViewProps) {
  const View = host.Checkbox
  if (View) return <View {...props} />
  return (
    <label className={props.className} title={props.title}>
      <input
        type="checkbox"
        data-choice-exempt="the fallback for a host older than walnut.ui.views.Checkbox"
        data-testid={props['data-testid']}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
    </label>
  )
}
