import type {
  CheckboxViewProps, ChipViewProps, RadioViewProps, SegmentedViewProps, SwitchViewProps, TabsViewProps, WalnutWebApi,
} from '@open-walnut/plugin-api/web'

/**
 * Walnut's own choice controls for this plugin's page, through `walnut.ui.views` (Walnut's
 * standard.md, "Choice controls"): tabs, a segmented control, a checkbox, a radio, a switch and a
 * chip are the components every page of the console draws, so they look and work the same (round,
 * the keys and ARIA of each kind). A class passed as `className` only places them.
 *
 * `activate` hands the host's views over once (`setHostControls`). A host older than these views
 * has none of them: there each control falls back to the host's plain keys (`btn btn-sm` with
 * `aria-pressed`) or the native input, never a look of the plugin's own.
 *
 * The same file in every plugin this repository ships (a plugin is built on its own and cannot
 * import another's code): `tests/web/plugin-host-controls.test.ts` keeps the copies identical.
 */
type Views = WalnutWebApi['ui']['views']
type Controls = Pick<Views, 'Segmented' | 'Tabs' | 'Checkbox' | 'Radio' | 'Switch' | 'Chip'>
let host: Controls = {}

export function setHostControls(views: Views): void {
  host = { Segmented: views.Segmented, Tabs: views.Tabs, Checkbox: views.Checkbox, Radio: views.Radio, Switch: views.Switch, Chip: views.Chip }
}

interface KeyRowProps<V extends string> {
  value: V | null
  options: SegmentedViewProps<V>['options']
  onChange(value: V): void
  label: string
  className?: string
  testId?: string
}

/** A host without the view: one plain key per value, the picked one pressed. */
function KeyRow<V extends string>({ value, options, onChange, label, className, testId }: KeyRowProps<V>) {
  return (
    <div role="group" aria-label={label} className={className} style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }} data-testid={testId}>
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

export function Chip(props: ChipViewProps) {
  const View = host.Chip
  if (View) return <View {...props} />
  return (
    <button type="button" className={`btn btn-sm${props.className ? ` ${props.className}` : ''}`} aria-pressed={props.pressed} title={props.title} disabled={props.disabled} data-testid={props['data-testid']} onClick={() => props.onClick()}>
      {props.children}{props.count !== undefined && <> {props.count}</>}
    </button>
  )
}

/** The native box a host without the views draws: checkbox, radio, or a checkbox for a switch. */
function NativeBox({ type, id, checked, onChange, label, name, disabled, title, ariaLabel, indeterminate, className, testId }: {
  type: 'checkbox' | 'radio'
  id?: string
  checked: boolean
  onChange(checked: boolean): void
  label?: CheckboxViewProps['label']
  name?: string
  disabled?: boolean
  title?: string
  ariaLabel?: string
  indeterminate?: boolean
  className?: string
  testId?: string
}) {
  const box = (
    <input
      type={type}
      id={id}
      className={label ? undefined : className}
      name={name}
      data-choice-exempt="the fallback for a host older than the choice views of walnut.ui.views"
      data-testid={testId}
      checked={checked}
      disabled={disabled}
      aria-label={label ? undefined : ariaLabel}
      title={label ? undefined : title}
      ref={(el) => { if (el) el.indeterminate = !!indeterminate }}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
  if (!label) return box
  return <label className={className} title={title}>{box} {label}</label>
}

export function Checkbox(props: CheckboxViewProps) {
  const View = host.Checkbox
  if (View) return <View {...props} />
  return <NativeBox type="checkbox" id={props.id} checked={props.checked} onChange={props.onChange} label={props.label} disabled={props.disabled} title={props.title} ariaLabel={props['aria-label']} indeterminate={props.indeterminate} className={props.className} testId={props['data-testid']} />
}

export function Radio(props: RadioViewProps) {
  const View = host.Radio
  if (View) return <View {...props} />
  return <NativeBox type="radio" name={props.name} checked={props.checked} onChange={() => props.onChange()} label={props.label} disabled={props.disabled} title={props.title} className={props.className} testId={props['data-testid']} />
}

export function Switch(props: SwitchViewProps) {
  const View = host.Switch
  if (View) return <View {...props} />
  // As the host's switch: a busy one stays enabled and says it is busy.
  return <NativeBox type="checkbox" checked={props.checked} onChange={props.onChange} disabled={props.disabled} title={props.title} ariaLabel={props['aria-label']} className={props.className} testId={props['data-testid']} />
}
