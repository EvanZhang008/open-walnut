/**
 * The page side of voice input's media hold (src/core/stt/media-hold.ts): while a
 * microphone of this page is open, the server keeps the music of this machine paused.
 *
 * acquireMediaHold() asks for the hold at once (the music stops while the mic still
 * opens, so it is not in the first words), renews it every RENEW_MS, and gives it back on
 * release() or when the page goes away (sendBeacon, which survives the unload). A server
 * that says the setting is off, or that this is another device, gets no renewals. A
 * release that never arrives costs only the server's TTL: the music comes back then.
 */
import { log } from '@/utils/log'

const ENDPOINT = '/api/stt/media-hold'
/** Matches MEDIA_HOLD_RENEW_MS on the server (its TTL is six times longer). */
const RENEW_MS = 15_000

export interface MediaHoldHandle {
  release(): void
}

interface HoldAnswer { enabled?: boolean; otherDevice?: boolean }

function newId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `web-${random}`.slice(0, 80)
}

function send(id: string, action: 'hold' | 'release', source: string): Promise<HoldAnswer | null> {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action, source }),
    keepalive: action === 'release',
  }).then((res) => (res.ok ? res.json() as Promise<HoldAnswer> : null), () => null)
}

/** Hold the music off for one voice input. release() is safe to call more than once. */
export function acquireMediaHold(source: string): MediaHoldHandle {
  const id = newId()
  let released = false
  let timer: ReturnType<typeof setInterval> | undefined
  const stopRenewing = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const onHide = () => {
    if (released) return
    released = true
    stopRenewing()
    window.removeEventListener('pagehide', onHide)
    const body = new Blob([JSON.stringify({ id, action: 'release', source })], { type: 'text/plain' })
    if (!navigator.sendBeacon?.(ENDPOINT, body)) void send(id, 'release', source)
  }
  const renew = () => {
    if (released) return
    void send(id, 'hold', source).then((answer) => {
      // Off, or another device: nothing to keep alive.
      if (answer && (answer.enabled === false || answer.otherDevice)) stopRenewing()
    })
  }
  // The release goes out only after the hold's answer: sent at once, it could overtake
  // the hold on another connection and leave the music off for a whole TTL.
  const started = send(id, 'hold', source)
  void started.then((answer) => {
    if (released) return
    if (answer && (answer.enabled === false || answer.otherDevice)) return
    timer = setInterval(renew, RENEW_MS)
  })
  window.addEventListener('pagehide', onHide)
  return {
    release() {
      if (released) return
      released = true
      stopRenewing()
      window.removeEventListener('pagehide', onHide)
      void started.then(() => send(id, 'release', source)).then((answer) => {
        if (!answer) log.warn('stt', 'media hold release did not reach the server; the music comes back when the hold times out')
      })
    },
  }
}
