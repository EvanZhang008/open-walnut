/**
 * The two working parts of a Task providers card (TaskProvidersSection.tsx):
 *
 *   - HardRulesEditor: the provider's hard rules as chips. Enter (or leaving the field) adds what is
 *     typed, a pasted list adds one chip per line, the cross removes one. A line the server cannot
 *     use (not a valid pattern, or one that could be slow) is marked on its chip.
 *   - GrowingTextarea: a field exactly as tall as its text (no resize corner, no empty band),
 *     measured again when the text or the field's width changes.
 *   - TryVerdict: one line under the test field that says whether the title passes, why, and what
 *     is still to ask, led by a dot in the verdict's colour.
 */
import { useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type TextareaHTMLAttributes } from 'react'
import { CloseGlyph } from '../settings-glyphs'
import type { ProviderRules, RulesTest } from '@/api/private-tasks'

/** Lines as the stored list: trimmed, no empty lines, no repeats. */
export function wordsFromText(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split('\n')) {
    const w = line.trim()
    if (!w || seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out
}

const isPattern = (w: string) => w.length > 2 && w.startsWith('/') && w.lastIndexOf('/') > 0

export function HardRulesEditor({ id, words, invalid, busy, onChange }: {
  id: string
  words: string[]
  invalid: readonly string[]
  busy?: boolean
  onChange: (words: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const add = (text: string) => {
    const next = wordsFromText([...words, ...text.split('\n')].join('\n'))
    setDraft('')
    if (next.length !== words.length) onChange(next)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (draft.trim()) add(draft)
  }
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (!text.includes('\n')) return
    e.preventDefault()
    add(`${draft}${text}`)
  }
  const bad = new Set(invalid)
  const unused = words.filter((w) => bad.has(w))
  return (
    <div className="tp-rules-field">
      <div className="tp-rules" data-busy={busy ? 'true' : undefined} onClick={(e) => {
        if (e.target === e.currentTarget) (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()
      }}>
        {words.length > 0 && (
          <ul className="tp-rule-list" aria-label="Hard rules">
            {words.map((w) => (
              <li
                key={w}
                className="tp-rule"
                data-testid={`${id}-rule`}
                data-invalid={bad.has(w) ? 'true' : undefined}
                title={bad.has(w) ? 'Not used: not a valid pattern, or one that could be slow' : undefined}
              >
                <span className={isPattern(w) ? 'tp-rule-text tp-rule-text--pattern' : 'tp-rule-text'}>{w}</span>
                <button
                  type="button"
                  className="tp-rule-remove"
                  aria-label={`Remove ${w}`}
                  onClick={() => onChange(words.filter((x) => x !== w))}
                >
                  <CloseGlyph size={10} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          id={id}
          data-testid={id}
          data-no-draft="autosave"
          type="text"
          className="tp-rule-input"
          placeholder={words.length ? 'Add another' : 'Add a word, a phrase or a /pattern/'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => { if (draft.trim()) add(draft) }}
        />
      </div>
      {unused.length > 0 && (
        <p className="tp-rules-unused" data-testid={`${id}-unused`}>
          Not used: {unused.join(', ')}. {unused.length === 1 ? 'It is' : 'They are'} not a valid pattern, or one that could be slow
        </p>
      )}
    </div>
  )
}

/** A provider's rules in one line: what is checked now. */
export function summaryOf(p: Pick<ProviderRules, 'check_default'>, on: boolean, words: number, ai: boolean): string {
  if (!on) return p.check_default ? 'Not checked: every task syncs' : 'Not checked: only you read it, so every task syncs'
  const rules = [words ? `${words} hard ${words === 1 ? 'rule' : 'rules'}` : '', ai ? 'the AI rule' : ''].filter(Boolean)
  return rules.length ? `Checks every task against ${rules.join(' and ')}` : 'Checks every task, no rules yet'
}

export type AiAnswer = RulesTest['ai'] | 'asking' | null

/** What the verdict line says, and its tone. */
export function verdictOf(input: {
  sample: string
  hardMatch: string | null | undefined
  ai: boolean
  answer: AiAnswer
}): { tone: 'idle' | 'pass' | 'fail' | 'pending'; text: string } {
  const { sample, hardMatch, ai, answer } = input
  if (!sample.trim()) return { tone: 'idle', text: 'Type a task title to see whether it may sync' }
  if (hardMatch) return { tone: 'fail', text: `Fails the hard rule "${hardMatch}"` }
  if (!ai) return { tone: 'pass', text: 'Passes the hard rules' }
  if (answer === 'asking') return { tone: 'pending', text: 'Passes the hard rules, asking the AI' }
  if (answer && 'error' in answer) return { tone: 'pending', text: `Passes the hard rules. The AI did not answer: ${answer.error}` }
  if (answer && 'pass' in answer) {
    return answer.pass
      ? { tone: 'pass', text: `Passes both rules. AI: ${answer.reason}` }
      : { tone: 'fail', text: `Fails the AI rule: ${answer.reason}` }
  }
  return { tone: 'pending', text: 'Passes the hard rules. Ask AI to check the AI rule' }
}

export function TryVerdict({ id, tone, text }: { id: string; tone: string; text: string }) {
  return (
    <p className="tp-verdict" data-testid={id} data-tone={tone} aria-live="polite">
      <span className="tp-verdict-dot" aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}

/** A textarea as tall as its text: the height follows every change and every width change. */
export function GrowingTextarea({ value, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`
    }
    fit()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [value])
  // The value is its caller's: the caller's own data-draft-key or data-no-draft (in rest) wins.
  return <textarea ref={ref} value={value} rows={1} data-no-draft="mirror" {...rest} />
}
