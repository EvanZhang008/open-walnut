/**
 * The console's view of whether the Mac answers (docs/plan/walnut-replica-servers-impl.md,
 * WP7). The store and its rules are api/leader-presence.ts; this file wires
 * them to the socket and to every fetch, and gives React a hook.
 *
 *   installLeaderPresence()  once, at boot: the `replica:presence` event, the
 *                            /ws close codes, and the headers of every
 *                            same-origin fetch (the raw ones too)
 *   useLeaderPresence()      the state, re-rendered on a change
 *   useAwayLine()            the quiet line's words, its age ticking each 30 s
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { wsClient } from '@/api/ws'
import { log } from '@/utils/log'
import {
  awayLineText, getLeaderPresence, getPresenceOrder, noteResponseHeaders, notePresenceEvent, noteWsClose, subscribeLeaderPresence,
  isMacSessionAway, type LeaderPresenceState,
} from '@/api/leader-presence'

const AGE_TICK_MS = 30_000

let installed = false

function sameOrigin(input: RequestInfo | URL): boolean {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return new URL(raw, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

export function installLeaderPresence(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  wsClient.onEvent('replica:presence', (data) => notePresenceEvent(data))
  wsClient.onClose((code) => noteWsClose(code))
  if (typeof window.fetch === 'function') {
    const original = window.fetch.bind(window)
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => original(input, init).then((res) => {
      if (sameOrigin(input)) noteResponseHeaders(res.headers)
      return res
    })
  }
  let lastAnswers = getLeaderPresence().answers
  subscribeLeaderPresence(() => {
    const p = getLeaderPresence()
    if (p.answers === lastAnswers) return
    lastAnswers = p.answers
    const o = getPresenceOrder()
    log.info('replica', p.answers ? 'the Mac answers again' : 'the Mac is away', {
      host: p.host ?? undefined, hostKey: p.hostKey ?? undefined, why: p.why ?? undefined, asOf: p.asOf ?? undefined, source: p.source,
      seq: o.seq ?? undefined, boot: o.boot ?? undefined,
    })
  })
}

export function useLeaderPresence(): LeaderPresenceState {
  return useSyncExternalStore(subscribeLeaderPresence, getLeaderPresence, getLeaderPresence)
}

/** The quiet line's words while the Mac is away (null while it answers); the age stays current. */
export function useAwayLine(): { line: string; prompts: string } | null {
  const p = useLeaderPresence()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (p.answers) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    return () => clearInterval(t)
  }, [p.answers, p.asOf])
  return awayLineText(p, now)
}

/** Whether this session's controls need the Mac right now (it is away, the session is not on this host). */
export function useMacSessionAway(session: { host?: string | null } | null | undefined): boolean {
  return isMacSessionAway(useLeaderPresence(), session)
}
