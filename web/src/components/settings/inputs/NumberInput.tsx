/**
 * 120px number field with an optional unit (`minutes`, `ms`, `%`) 8px to its
 * right. Extra input props (from useCommitField, aria-*) pass through.
 */
import type { ChangeEvent, InputHTMLAttributes, KeyboardEvent } from 'react'
import type { CommitFieldInputProps } from './useCommitField'
import '@/styles/settings-controls.css'

interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'step'> {
  id?: string
  value?: number | string | undefined
  onChange?: (v: number | undefined) => void
  /** useCommitField().inputProps: when given it owns value and the commit events. */
  field?: CommitFieldInputProps
  /** Unit text right of the field. `suffix` is the old name. */
  unit?: string
  suffix?: string
  placeholder?: string
  min?: number
  max?: number
  step?: number
  /** Commit points for callers that persist on commit rather than per keystroke. */
  onBlur?: () => void
  onEnter?: () => void
}

export function NumberInput({
  id,
  value,
  onChange,
  unit,
  suffix,
  placeholder,
  min,
  max,
  step,
  onBlur,
  onEnter,
  onKeyDown,
  className,
  field,
  ...rest
}: NumberInputProps) {
  const unitText = unit ?? suffix
  const events = field
    ? field
    : {
        value: value ?? '',
        onChange: (e: ChangeEvent<HTMLInputElement>) => {
          const v = e.target.value
          onChange?.(v === '' ? undefined : Number(v))
        },
        onBlur,
        onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
          onKeyDown?.(e)
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault()
            onEnter()
          }
        },
      }
  return (
    <span className="number-input-wrapper settings-input-with-unit">
      <input
        {...rest}
        id={id}
        type="number"
        inputMode="decimal"
        {...events}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        className={`number-input settings-input settings-input--number${className ? ` ${className}` : ''}`}
      />
      {/* Rendered only with a unit: the field plus unit ends on the content edge (N03). */}
      {unitText && <span className="number-input-suffix settings-input-unit">{unitText}</span>}
    </span>
  )
}
