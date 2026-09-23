/**
 * Optimistic value for a switch / checkbox / segmented control.
 *
 * set(v) shows v at once and writes it. Writes are sequenced: only the LAST
 * set() decides the outcome (a stale response is ignored). A failure reverts to
 * the server value and leaves `error` = `Couldn't save: <msg>` until the next
 * set() or a later success (never on a timer: a timed collapse makes the rows
 * below jump under the pointer). Feeds the pane's Saved / Not saved indicator.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { saveErrorMessage, useRowFailure, useSettingsSaved } from '../settings-pane-context'

export interface OptimisticState<T> {
  /** The value shown instead of the server value, while a write is open or just landed. */
  override: { value: T; seq: number; inFlight: boolean } | null
  error: string | null
  seq: number
}

export type OptimisticEvent<T> =
  | { type: 'set'; value: T }
  | { type: 'resolved'; seq: number; serverEquals: boolean }
  | { type: 'rejected'; seq: number; message: string }
  | { type: 'server-changed' }

export function couldntSave(message: string): string {
  return `Couldn't save: ${message}`
}

export function optimisticReducer<T>(state: OptimisticState<T>, event: OptimisticEvent<T>): OptimisticState<T> {
  switch (event.type) {
    case 'set': {
      const seq = state.seq + 1
      return { override: { value: event.value, seq, inFlight: true }, error: null, seq }
    }
    case 'resolved':
      if (event.seq !== state.seq || !state.override) return state
      // Keep showing the saved value until the server read catches up, so the
      // control never flickers back to the old value in between.
      return event.serverEquals
        ? { ...state, override: null, error: null }
        : { ...state, override: { ...state.override, inFlight: false }, error: null }
    case 'rejected':
      if (event.seq !== state.seq) return state
      return { ...state, override: null, error: couldntSave(event.message) }
    case 'server-changed':
      if (!state.override || state.override.inFlight) return state
      return { ...state, override: null }
  }
}

export function initialOptimisticState<T>(): OptimisticState<T> {
  return { override: null, error: null, seq: 0 }
}

export function useOptimisticSetting<T>(
  serverValue: T,
  save: (value: T) => Promise<unknown>,
  opts: { rowKey?: string } = {},
) {
  const [state, dispatch] = useReducer(
    optimisticReducer as (s: OptimisticState<T>, e: OptimisticEvent<T>) => OptimisticState<T>,
    undefined,
    initialOptimisticState<T>,
  )
  const { notifySaved, notifySaveFailed } = useSettingsSaved()
  const [rowFailure, clearRowFailure] = useRowFailure(opts.rowKey)
  const saveRef = useRef(save)
  saveRef.current = save
  const serverRef = useRef(serverValue)
  serverRef.current = serverValue
  const seqRef = useRef(0)
  const rowKey = opts.rowKey

  useEffect(() => {
    dispatch({ type: 'server-changed' })
  }, [serverValue])

  const set = useCallback(
    (value: T) => {
      const seq = ++seqRef.current
      dispatch({ type: 'set', value })
      clearRowFailure()
      saveRef.current(value).then(
        () => {
          if (seq !== seqRef.current) return
          dispatch({ type: 'resolved', seq, serverEquals: Object.is(serverRef.current, value) })
          notifySaved()
        },
        (err: unknown) => {
          if (seq !== seqRef.current) return
          const message = saveErrorMessage(err)
          dispatch({ type: 'rejected', seq, message })
          notifySaveFailed(message, rowKey)
        },
      )
    },
    [clearRowFailure, notifySaved, notifySaveFailed, rowKey],
  )

  const value = state.override ? state.override.value : serverValue
  const busy = state.override?.inFlight ?? false
  const error = state.error ?? (rowFailure !== null && !state.override ? couldntSave(rowFailure) : null)
  return { value, set, busy, error }
}
