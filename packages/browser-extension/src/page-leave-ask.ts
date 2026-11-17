/**
 * Whether a page would ask "Leave site?" (its beforeunload), asked of the page itself before an
 * agent leaves it, so Chrome never shows that dialog for an agent: Chrome brings the window of a
 * tab whose beforeunload asks to the front (and out of the Dock when minimized) and gives it the
 * focus, over whatever the person was doing (measured 2026-11-17 in Chromium: close and navigate
 * both did; an alert or a confirm in a window behind did not; the user's report was the agent
 * window popping up over and over with "Leave site?" while an agent posted on a forum).
 *
 * `ask`: runs the page's own beforeunload handlers once on an event of Walnut's, as Chrome would
 * (it asks only after a person's or a trusted input's activation), and reads whether one asked.
 * `quiet`: for a leave the agent chose (discard: true), the page's handlers cannot ask for the next
 * 20 s, so it goes without asking.
 * Both run in every frame of the tab, in the page's own world (its handlers live there). The ask
 * runs the page's handlers once more than Chrome would (one added with once: true is used up by
 * it); that is the price of never showing the dialog.
 */
import { more } from './agent-api'

export interface LeaveAsk { asks: boolean; frame?: string }

/** Runs in the page's world: self-contained, no closures. */
function inPage(mode: 'ask' | 'quiet', until: number): LeaveAsk {
  const w = window as unknown as { onbeforeunload: unknown } & Window
  // Came after Walnut stopped waiting (a busy page): the leave went on without it, so nothing here.
  if (Date.now() > until) return { asks: false }
  if (mode === 'quiet') {
    // The page's handlers still run, but what would make Chrome ask does nothing for this leave:
    // cancelling the event, setting its returnValue, and an onbeforeunload's return. (A capturing
    // listener that stops the others does not: measured in Chromium, the dialog still showed.)
    // All of it comes back after 20 s: a leave that never unloaded the page (a same-page address,
    // a download) leaves the page's guard as it was.
    const P = (window as unknown as { BeforeUnloadEvent?: { prototype: object } }).BeforeUnloadEvent?.prototype
    const h = w.onbeforeunload
    if (P) {
      const had = { rv: Object.getOwnPropertyDescriptor(P, 'returnValue'), pd: Object.getOwnPropertyDescriptor(P, 'preventDefault') }
      Object.defineProperty(P, 'returnValue', { configurable: true, get: () => '', set: () => undefined })
      Object.defineProperty(P, 'preventDefault', { configurable: true, writable: true, value: () => undefined })
      setTimeout(() => {
        if (had.rv) Object.defineProperty(P, 'returnValue', had.rv); else delete (P as Record<string, unknown>).returnValue
        if (had.pd) Object.defineProperty(P, 'preventDefault', had.pd); else delete (P as Record<string, unknown>).preventDefault
      }, 20_000)
    }
    w.onbeforeunload = null
    setTimeout(() => { if (w.onbeforeunload === null) w.onbeforeunload = h }, 20_000)
    return { asks: false }
  }
  // Chrome asks only on a page a person (or trusted input) has touched.
  if ((navigator as unknown as { userActivation?: { hasBeenActive?: boolean } }).userActivation?.hasBeenActive === false) return { asks: false }
  const e = new Event('beforeunload', { cancelable: true })
  // Chrome asks once a handler sets returnValue (to anything, '' too), cancels the event, or
  // (an onbeforeunload) returns a value.
  let set = false
  Object.defineProperty(e, 'returnValue', { configurable: true, get: () => '', set: () => { set = true } })
  const h = w.onbeforeunload
  let returned: unknown
  if (typeof h === 'function') w.onbeforeunload = function (this: unknown, ev: Event) { returned = (h as (ev: Event) => unknown).call(this, ev); return returned }
  try { w.dispatchEvent(e) } catch { /* a handler that throws asks nothing */ } finally { if (typeof h === 'function') w.onbeforeunload = h }
  return { asks: e.defaultPrevented || set || (returned !== undefined && returned !== null), frame: location.href }
}

/** How long the page gets to answer: a page held by a dialog no debugger saw does not, and the leave goes on as before. */
const ASK_MS = 2000

async function inFrames(tabId: number, mode: 'ask' | 'quiet'): Promise<LeaveAsk[] | null> {
  const s = more.scripting
  if (!s) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      s.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: inPage, args: [mode, Date.now() + ASK_MS] as [typeof mode, number] })
        .then((rs) => rs.map((r) => r.result as LeaveAsk | undefined).filter((r): r is LeaveAsk => !!r), () => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ASK_MS) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The frame whose page would ask "Leave site?" now, or null when none would (or the page did not answer). */
export async function leaveAsks(tabId: number): Promise<LeaveAsk | null> {
  return (await inFrames(tabId, 'ask'))?.find((r) => r.asks) ?? null
}

/** The next leave of this tab goes without the page's "Leave site?". */
export async function quietLeave(tabId: number): Promise<void> {
  await inFrames(tabId, 'quiet')
}

export const _inPageForTesting = inPage
