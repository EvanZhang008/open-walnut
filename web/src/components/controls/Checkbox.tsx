/**
 * Checkbox and Radio: the native input, drawn the one Walnut way (`.wn-check`, 16 px, accent when
 * on; standard.md, "Choice controls"). The native input stays, so it is focusable, Space toggles it,
 * a form reads it and specs can `.check()` it. With a `label` the box and its words are one
 * clickable row (`.wn-check-row`, 8 px apart), with an optional line of detail under the words.
 *
 * A switch, not a checkbox, for a setting that takes effect at once (ToggleSwitch); a checkbox for
 * picking items of a list or a choice a form applies on Save.
 */
import { useEffect, useRef, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'
import { useLeanCallback } from '@/hooks/useLeanCallback'
import '@/styles/choice-controls.css'

type NativeProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'>

export interface CheckboxProps extends NativeProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** The dash state of a "some of them" box. */
  indeterminate?: boolean
  /** Words after the box; the box and the words are then one clickable row. */
  label?: ReactNode
  /** A muted line under the label. */
  detail?: ReactNode
  /** Classes on the row (with a label) or the box (placement only). */
  rowClassName?: string
  /** The native input (to focus it), passed straight through (a prop in React 19). */
  ref?: Ref<HTMLInputElement>
}

export interface RadioProps extends NativeProps {
  checked: boolean
  /** Called when this radio is picked. */
  onChange: () => void
  /** The native input (to focus it), passed straight through (a prop in React 19). */
  ref?: Ref<HTMLInputElement>
  label?: ReactNode
  detail?: ReactNode
  rowClassName?: string
}

function Row({ label, detail, rowClassName, disabled, title, children }: { label?: ReactNode; detail?: ReactNode; rowClassName?: string; disabled?: boolean; title?: string; children: ReactNode }) {
  if (label === undefined || label === null || label === false) return <>{children}</>
  return (
    <label className={`wn-check-row${rowClassName ? ` ${rowClassName}` : ''}`} aria-disabled={disabled ? true : undefined} title={title}>
      {children}
      {detail ? (
        <span className="wn-check-text">
          <span className="wn-check-label">{label}</span>
          <span className="wn-check-detail">{detail}</span>
        </span>
      ) : (
        <span className="wn-check-label">{label}</span>
      )}
    </label>
  )
}

export function Checkbox({ checked, onChange, indeterminate, label, detail, rowClassName, className, disabled, title, ref: outerRef, ...rest }: CheckboxProps) {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate }, [indeterminate])
  // Our own ref (the dash state) and the caller's, on the one input.
  const setRef = useLeanCallback((el: HTMLInputElement | null) => {
    ref.current = el
    if (typeof outerRef === 'function') outerRef(el)
    else if (outerRef) outerRef.current = el
  }, [outerRef])
  return (
    <Row label={label} detail={detail} rowClassName={rowClassName} disabled={disabled} title={title}>
      <input
        ref={setRef}
        type="checkbox"
        // WebKit only tabs to checkboxes with an explicit tabindex (N20).
        tabIndex={disabled ? undefined : 0}
        title={label ? undefined : title}
        {...rest}
        disabled={disabled}
        checked={checked}
        aria-checked={indeterminate ? 'mixed' : undefined}
        className={`wn-check${className ? ` ${className}` : ''}`}
        onChange={(e) => onChange(e.target.checked)}
      />
    </Row>
  )
}

export function Radio({ checked, onChange, label, detail, rowClassName, className, disabled, title, ...rest }: RadioProps) {
  return (
    <Row label={label} detail={detail} rowClassName={rowClassName} disabled={disabled} title={title}>
      <input
        type="radio"
        tabIndex={disabled ? undefined : 0}
        title={label ? undefined : title}
        {...rest}
        disabled={disabled}
        checked={checked}
        className={`wn-check${className ? ` ${className}` : ''}`}
        onChange={() => onChange()}
      />
    </Row>
  )
}
