/**
 * `browser request_sign_in`: an agent that meets a sign-in page (or a page that refuses it, such as
 * Google's "This browser or app may not be secure") asks the person to sign in themselves, in place
 * (2026-11-08, the user, on another agent's browser: "let our browser task learn from this"). The
 * task's Browser view shows the ask on its card with Take over; the person takes the tab, signs in
 * with their own hands, and presses Done (Hand back), and the agent's waiting call answers `done`.
 * The sign-in stays in the person's own browser profile, so later runs of the task are signed in.
 *
 * One ask per tab at a time, in memory (a restart forgets it: the agent's next call makes a new
 * one). The agent holds its call up to `wait_ms` at a time and calls again with the ask's id, as
 * for an approval; the shell command waits by itself.
 */
import crypto from 'node:crypto'
import { onHoldingEnded } from './hub.js'

export type SignInEnd = 'done' | 'stopped' | 'gone'

export interface SignInAsk {
  id: string
  owner: string
  device: string
  tab: number
  /** The site to sign in to, as the agent named it or the tab's address gave it. */
  site?: string
  /** One line from the agent: what to sign in to, why. */
  note?: string
  at: number
  end?: { why: SignInEnd; at: number }
}

/** An ask is kept this long at most, answered or not. */
export const ASK_MS = 60 * 60_000
/** An answered ask stays readable this long, for the agent's next call. */
const ENDED_KEEP_MS = 10 * 60_000

const asks = new Map<string, SignInAsk>()
const waiters = new Map<string, Set<() => void>>()

function sweep(now = Date.now()): void {
  for (const [id, a] of asks) {
    if (now - a.at > ASK_MS || (a.end && now - a.end.at > ENDED_KEEP_MS)) {
      asks.delete(id)
      for (const fn of waiters.get(id) ?? []) fn()
      waiters.delete(id)
    }
  }
}

/** The open ask on the tab, if any (`owner`: only that holder's). */
export function openAsk(device: string, tab: number, owner?: string): SignInAsk | undefined {
  sweep()
  for (const a of asks.values()) if (a.device === device && a.tab === tab && !a.end && (owner === undefined || a.owner === owner)) return a
  return undefined
}

/** A new ask on the tab (an open one there is the same ask, its words updated). */
export function askSignIn(o: { owner: string; device: string; tab: number; site?: string; note?: string }): SignInAsk {
  const had = openAsk(o.device, o.tab)
  if (had && had.owner === o.owner) {
    if (o.note) had.note = o.note
    if (o.site) had.site = o.site
    return had
  }
  // Another owner's ask on a tab that changed hands is over.
  if (had) endSignIn(o.device, o.tab, 'gone')
  const a: SignInAsk = { id: `si-${crypto.randomUUID()}`, owner: o.owner, device: o.device, tab: o.tab, at: Date.now(), ...(o.site ? { site: o.site } : {}), ...(o.note ? { note: o.note } : {}) }
  asks.set(a.id, a)
  return a
}

export function getAsk(id: string): SignInAsk | undefined {
  sweep()
  return asks.get(id)
}

/** The person handed the tab back (done), stopped the agent there, or the tab went: the ask ends. */
export function endSignIn(device: string, tab: number, why: SignInEnd, owner?: string): SignInAsk | undefined {
  const a = openAsk(device, tab, owner)
  if (!a) return undefined
  a.end = { why, at: Date.now() }
  for (const fn of waiters.get(a.id) ?? []) fn()
  waiters.delete(a.id)
  return a
}

/** Wait up to `ms` for the ask to end; the ask as it is then. */
export async function waitSignIn(id: string, ms: number): Promise<SignInAsk | undefined> {
  const a = getAsk(id)
  if (!a || a.end || ms <= 0) return a
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); resolve() }
    const t = setTimeout(() => {
      const set = waiters.get(id)
      set?.delete(done)
      if (set && !set.size) waiters.delete(id)
      resolve()
    }, ms)
    t.unref?.()
    let set = waiters.get(id)
    if (!set) { set = new Set(); waiters.set(id, set) }
    set.add(done)
  })
  return getAsk(id)
}

// The tab's holding ended (closed, Stop on the page, given to another task): its ask is over.
onHoldingEnded((device, tab) => { endSignIn(device, tab, 'gone') })

export function _resetSignInAsksForTesting(): void {
  asks.clear()
  waiters.clear()
}
