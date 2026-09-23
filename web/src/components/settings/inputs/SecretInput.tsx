/**
 * Secret field, 240px. When the caller says a secret is already stored
 * (`saved`), it shows one status line `Saved in secrets, never synced.` with
 * `Replace` / `Remove` instead of a masked string. Without `saved` it is the
 * old password input, so existing callers keep working unchanged.
 */
import { useEffect, useRef, useState } from 'react'
import { SettingsButton } from './SettingsButton'
import { InlineConfirmButton } from './InlineConfirmButton'
import '@/styles/settings-controls.css'

interface SecretInputProps {
  id?: string
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
  placeholder?: string
  disabled?: boolean
  /** A secret is stored server-side (the value itself is never sent back). */
  saved?: boolean
  /** Called when the user confirms Remove. Without it, no Remove button. */
  onRemove?: () => void | Promise<unknown>
  'aria-label'?: string
  'data-testid'?: string
}

export function SecretInput({
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  disabled,
  saved,
  onRemove,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: SecretInputProps) {
  const [visible, setVisible] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (replacing) inputRef.current?.focus()
  }, [replacing])
  // Once the new secret is stored, go back to the status line.
  useEffect(() => {
    if (!saved) setReplacing(false)
  }, [saved])

  if (saved && !replacing && !value) {
    return (
      <span className="settings-secret-saved" data-testid={testId ? `${testId}-saved` : undefined}>
        <span className="settings-secret-saved-text">Saved in secrets, never synced.</span>
        <SettingsButton variant="text" onClick={() => setReplacing(true)} disabled={disabled}>
          Replace
        </SettingsButton>
        {onRemove && <InlineConfirmButton onConfirm={onRemove} disabled={disabled} />}
      </span>
    )
  }

  return (
    <span className="secret-input-wrapper settings-secret">
      <input
        ref={inputRef}
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          onBlur?.()
          if (saved && !inputRef.current?.value) setReplacing(false)
        }}
        placeholder={placeholder}
        className="secret-input settings-input settings-input--short settings-input--mono"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
      />
      {/* Inside the field, and only when there is something to reveal (F33): the
          field keeps the same width and right edge as every other input. */}
      {value && (
        <SettingsButton
          variant="text"
          className="secret-toggle"
          reserve={['Show', 'Hide']}
          onClick={() => setVisible(!visible)}
          aria-pressed={visible}
          disabled={disabled}
        >
          {visible ? 'Hide' : 'Show'}
        </SettingsButton>
      )}
    </span>
  )
}
