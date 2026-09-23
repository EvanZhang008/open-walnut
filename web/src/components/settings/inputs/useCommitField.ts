/**
 * Text / number field that saves on commit, not per keystroke.
 *
 * Commit = blur or Enter. Esc reverts to the last saved value and blurs. An
 * unchanged value sends nothing (and shows no Saved). A failed commit keeps the
 * user's text with aria-invalid + `error` until they edit again. Server updates
 * (config:changed re-reads) never overwrite the field while it is focused or
 * dirty. A dirty value is flushed on unmount (pane switch), pagehide and
 * visibilitychange -> hidden, so switching panes 200ms after typing still saves.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { saveErrorMessage, useRowFailure, useSettingsSaved } from '../settings-pane-context'
import { couldntSave } from './useOptimisticSetting'

export type CommitValue = string | number | undefined

export interface CommitFieldInputProps {
  value: string
  onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void
  onFocus: () => void
  onBlur: () => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void
  'aria-invalid': true | undefined
}

export interface CommitFieldOptions<T extends CommitValue> {
  rowKey?: string
  /** Server-enforced bound only; applied on commit. Never invent limits. */
  clamp?: (value: T) => T
  /** 'number' parses the text; default follows typeof serverValue. */
  kind?: 'text' | 'number'
  /** Multi-line editors: Enter inserts a newline instead of committing. */
  multiline?: boolean
}

export function commitText(value: CommitValue): string {
  return value === undefined || value === null ? '' : String(value)
}

/** Parse field text back to the value type ('' -> undefined for numbers). */
export function parseCommitText(text: string, kind: 'text' | 'number'): CommitValue {
  if (kind === 'text') return text
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

/**
 * What a commit should do: the (clamped) value and its text, or skip when it
 * equals the last saved text.
 */
export function planCommit<T extends CommitValue>(
  draft: string,
  baseline: string,
  kind: 'text' | 'number',
  clamp?: (v: T) => T,
): { action: 'skip'; text: string } | { action: 'commit'; value: T; text: string } {
  let value = parseCommitText(draft, kind) as T
  if (clamp) value = clamp(value)
  const text = kind === 'number' ? commitText(value) : draft
  if (text === baseline) return { action: 'skip', text }
  return { action: 'commit', value, text }
}

export function useCommitField<T extends CommitValue>(
  serverValue: T,
  commit: (value: T) => Promise<unknown>,
  opts: CommitFieldOptions<T> = {},
) {
  const kind = opts.kind ?? (typeof serverValue === 'number' ? 'number' : 'text')
  const serverText = commitText(serverValue)
  const [draft, setDraftState] = useState(serverText)
  const [error, setError] = useState<string | null>(null)
  const draftRef = useRef(serverText)
  const baselineRef = useRef(serverText)
  const focusedRef = useRef(false)
  const seqRef = useRef(0)
  const inflightRef = useRef<{ text: string; promise: Promise<void> } | null>(null)
  const commitRef = useRef(commit)
  commitRef.current = commit
  const optsRef = useRef(opts)
  optsRef.current = opts
  const { notifySaved, notifySaveFailed } = useSettingsSaved()
  const [rowFailure, clearRowFailure] = useRowFailure(opts.rowKey)

  const setDraft = useCallback((text: string) => {
    draftRef.current = text
    setDraftState(text)
  }, [])

  // Adopt server values only while the user is not editing this field.
  useEffect(() => {
    if (focusedRef.current || draftRef.current !== baselineRef.current) return
    baselineRef.current = serverText
    setDraft(serverText)
  }, [serverText, setDraft])

  const flush = useCallback((): Promise<void> => {
    const plan = planCommit<T>(draftRef.current, baselineRef.current, kind, optsRef.current.clamp)
    if (plan.text !== draftRef.current) setDraft(plan.text)
    if (plan.action === 'skip') return Promise.resolve()
    // Blur then unmount both flush the same text: one write, not two.
    const open = inflightRef.current
    if (open && open.text === plan.text) return open.promise
    const seq = ++seqRef.current
    const rowKey = optsRef.current.rowKey
    const promise = commitRef.current(plan.value).then(
      () => {
        if (seq !== seqRef.current) return
        inflightRef.current = null
        baselineRef.current = plan.text
        setError(null)
        clearRowFailure()
        notifySaved()
      },
      (err: unknown) => {
        if (seq !== seqRef.current) return
        inflightRef.current = null
        const message = saveErrorMessage(err)
        setError(couldntSave(message))
        notifySaveFailed(message, rowKey)
      },
    )
    inflightRef.current = { text: plan.text, promise }
    return promise
  }, [kind, setDraft, clearRowFailure, notifySaved, notifySaveFailed])

  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => {
    const onHide = () => void flushRef.current()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide()
    }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onVisibility)
      onHide() // pane unmount: a typed-but-uncommitted value still saves
    }
  }, [])

  const inputProps: CommitFieldInputProps = {
    value: draft,
    onChange: (e) => {
      setDraft(e.target.value)
      if (error) setError(null)
      clearRowFailure()
    },
    onFocus: () => {
      focusedRef.current = true
    },
    onBlur: () => {
      focusedRef.current = false
      void flush()
    },
    onKeyDown: (e) => {
      if (e.nativeEvent.isComposing) return
      if (e.key === 'Enter' && !optsRef.current.multiline) {
        e.preventDefault() // never double-save through the form's submit
        void flush()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDraft(baselineRef.current)
        setError(null)
        e.currentTarget.blur()
      }
    },
    'aria-invalid': error || rowFailure ? true : undefined,
  }
  const shownError = error ?? (rowFailure !== null ? couldntSave(rowFailure) : null)
  return { inputProps, error: shownError, dirty: draft !== baselineRef.current, flush }
}
