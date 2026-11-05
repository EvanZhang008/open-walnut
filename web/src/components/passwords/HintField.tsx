/**
 * The master password hint (src/core/vault/hint.ts): the optional field beside a new master
 * password, and the "Show hint" link on the unlock screen. The rule runs here before anything
 * is sent; the server checks again.
 */
import { useState } from 'react'
import { HINT_MAX, hintProblem } from '../../../../src/core/vault/hint'

export const HINT_HELP = 'Anyone who opens the unlock screen can read it. Write something that reminds you, never the password or a part of it.'

/** The hint's problem with this password, or '' (the form's submit waits for ''). */
export function hintError(hint: string, password: string): string {
  return hintProblem(hint, password) ?? ''
}

export function HintInput({ id, value, onChange, password }: { id: string; value: string; onChange: (v: string) => void; password: string }) {
  const problem = hintError(value, password)
  return (
    <>
      <label className="pw-field-label" htmlFor={id}>Hint (optional)</label>
      <input data-no-draft="secret" id={id} className="pw-input" autoComplete="off" spellCheck={false} maxLength={HINT_MAX} value={value}
        onChange={(e) => onChange(e.target.value)} data-testid={id} aria-describedby={`${id}-help`} />
      {problem
        ? <div className="pw-hint pw-hint-bad" role="alert" data-testid={`${id}-error`}>{problem}</div>
        : <div className="pw-hint" id={`${id}-help`}>{HINT_HELP}</div>}
    </>
  )
}

/** "Show hint" under the unlock screen's password field; `open` shows it at once (after a wrong password). */
export function ShowHint({ hint, open }: { hint?: string; open: boolean }) {
  const [asked, setAsked] = useState(false)
  if (!hint) return null
  if (open || asked) return <p className="pw-hint-shown" data-testid="pw-hint-shown"><span>Hint:</span> {hint}</p>
  return <button type="button" className="pw-link-btn pw-hint-link" onClick={() => setAsked(true)} data-testid="pw-show-hint">Show hint</button>
}
