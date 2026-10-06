import { useEffect, useSyncExternalStore } from 'react'
import type { PluginLogger, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { TimeHttpError, type SessionTime, type TaskTime, type TimeApi } from './api'

/**
 * One cache for every place that shows a task's or a session's time: the task detail
 * slot, the session header chip, and the App's task page. Keyed `task:<id>` and
 * `session:<id>`, so three panels on one task cost one request, and a late answer for
 * one task can never land on another.
 *
 * When it asks again:
 *  - on first use, and on any use once the answer is STALE_MS old;
 *  - every POLL_MS while something on screen reads it and the page is visible (your
 *    own time is banked every 30 s, and no event says so);
 *  - RESULT_SETTLE_MS after a turn of that session ends (`session:result`): agent
 *    time is banked from that very result, a moment after the event;
 *  - while the answer is partial (`historyComplete` false while the server reads old
 *    days, or `degraded` when it hit its deadline), a few more times.
 *
 * It stops asking for a key the server can never answer here (a cloud replica's 501,
 * a 400): that answer is final, and polling it would only add noise.
 */

const STALE_MS = 30_000
const POLL_MS = 60_000
const RESULT_SETTLE_MS = 2_500
const HISTORY_RETRY_MS = 5_000
const HISTORY_RETRIES = 6

export interface TimeEntry<T> {
  data?: T
  error?: string
  /** The server cannot answer this here (replica 501, bad id 400). Render nothing. */
  unavailable?: boolean
}

type Key = string
type Data = TaskTime | SessionTime

interface Slot {
  view: TimeEntry<Data>
  fetchedAt: number
  inflight: boolean
  /** A forced ask arrived while one was in flight: ask once more when it lands. */
  again: boolean
  seq: number
  historyRetries: number
}

const EMPTY: TimeEntry<never> = {}

export interface TaskTimeStore {
  useTask(taskId: string | null): TimeEntry<TaskTime>
  useSession(sessionId: string | null): TimeEntry<SessionTime>
  /** Ask again now, whatever the age of the answer. */
  refreshTask(taskId: string): void
}

export function createTaskTimeStore(walnut: WalnutWebApi, api: TimeApi, log: PluginLogger): TaskTimeStore {
  const slots = new Map<Key, Slot>()
  const listeners = new Map<Key, Set<() => void>>()
  const settleTimers = new Map<Key, ReturnType<typeof setTimeout>>()

  const slotOf = (key: Key): Slot => {
    let slot = slots.get(key)
    if (!slot) {
      slot = { view: EMPTY, fetchedAt: 0, inflight: false, again: false, seq: 0, historyRetries: 0 }
      slots.set(key, slot)
    }
    return slot
  }

  const publish = (key: Key) => {
    for (const listener of listeners.get(key) ?? []) listener()
  }

  const load = (key: Key, force = false) => {
    if (walnut.signal.aborted) return
    const slot = slotOf(key)
    if (slot.view.unavailable) return
    if (slot.inflight) {
      // The answer in flight may predate what this ask is for (a turn that just ended).
      if (force) slot.again = true
      return
    }
    if (!force && Date.now() - slot.fetchedAt < STALE_MS) return
    slot.inflight = true
    const seq = ++slot.seq
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    const request: Promise<Data> = kind === 'task' ? api.taskTime(id) : api.sessionTime(id)
    request
      .then((data) => {
        if (seq !== slot.seq) return
        slot.view = { data }
        slot.fetchedAt = Date.now()
        // A partial answer (old days still being read, or cut by the server's deadline)
        // is asked again soon; a whole one resets the allowance for the next partial.
        if (data.historyComplete && !data.degraded) slot.historyRetries = 0
        else if (slot.historyRetries < HISTORY_RETRIES && schedule(key, HISTORY_RETRY_MS)) slot.historyRetries += 1
      })
      .catch((err: unknown) => {
        if (seq !== slot.seq) return
        const status = err instanceof TimeHttpError ? err.status : 0
        // 400 / 404 / 501 will say the same thing next time. Anything else (a timeout,
        // the server restarting) keeps the last good answer and tries again later.
        const final = status === 400 || status === 404 || status === 501
        slot.view = final ? { unavailable: true } : { ...slot.view, error: err instanceof Error ? err.message : String(err) }
        slot.fetchedAt = Date.now()
        if (!final) log.warn('task time fetch failed', { key, error: slot.view.error })
      })
      .finally(() => {
        if (seq !== slot.seq) return
        slot.inflight = false
        publish(key)
        if (slot.again) {
          slot.again = false
          load(key, true)
        }
      })
  }

  /** Ask again after `ms`; false when an ask is already scheduled (this one joins it). */
  const schedule = (key: Key, ms: number): boolean => {
    if (settleTimers.has(key)) return false
    settleTimers.set(key, setTimeout(() => {
      settleTimers.delete(key)
      load(key, true)
    }, ms))
    return true
  }

  const watched = () => [...listeners].filter(([, set]) => set.size > 0).map(([key]) => key)

  const poll = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    for (const key of watched()) load(key, true)
  }, POLL_MS)

  const onVisible = () => {
    if (document.visibilityState !== 'visible') return
    for (const key of watched()) load(key)
  }
  document.addEventListener('visibilitychange', onVisible)

  // A turn ended: its agent time is about to be banked. Re-read that session, its
  // task, and any task on screen whose answer lists the session.
  const offResult = walnut.events.on('session:result', (event) => {
    const data = (event.data ?? {}) as { sessionId?: unknown; taskId?: unknown }
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
    const taskId = typeof data.taskId === 'string' ? data.taskId : ''
    if (!sessionId && !taskId) return
    for (const key of watched()) {
      const answer = slots.get(key)?.view.data
      const hit = key === `session:${sessionId}` || key === `task:${taskId}`
        || (!!sessionId && !!answer && 'sessions' in answer && answer.sessions.some((s) => s.sessionId === sessionId))
      if (hit) schedule(key, RESULT_SETTLE_MS)
    }
  })

  walnut.signal.addEventListener('abort', () => {
    clearInterval(poll)
    document.removeEventListener('visibilitychange', onVisible)
    for (const timer of settleTimers.values()) clearTimeout(timer)
    settleTimers.clear()
    void offResult.dispose()
  }, { once: true })

  // One subscribe function per key: useSyncExternalStore resubscribes whenever it changes.
  const subscribers = new Map<Key, (listener: () => void) => () => void>()
  const subscribe = (key: Key) => {
    let fn = subscribers.get(key)
    if (!fn) {
      fn = (listener: () => void) => {
        let set = listeners.get(key)
        if (!set) {
          set = new Set()
          listeners.set(key, set)
        }
        set.add(listener)
        return () => { set!.delete(listener) }
      }
      subscribers.set(key, fn)
    }
    return fn
  }

  function useEntry<T extends Data>(key: Key | null): TimeEntry<T> {
    const view = useSyncExternalStore(
      key ? subscribe(key) : noopSubscribe,
      () => (key ? slots.get(key)?.view ?? EMPTY : EMPTY),
    )
    useEffect(() => { if (key) load(key) }, [key])
    return view as TimeEntry<T>
  }

  return {
    useTask: (taskId) => useEntry<TaskTime>(taskId ? `task:${taskId}` : null),
    useSession: (sessionId) => useEntry<SessionTime>(sessionId ? `session:${sessionId}` : null),
    refreshTask: (taskId) => load(`task:${taskId}`, true),
  }
}

const noopSubscribe = () => () => {}
