/**
 * Pictures of an agent's tab through Chrome's debugger, whenever captureVisibleTab cannot give
 * that tab's real picture (2026-11-09, the user: "why still no picture", "we need make it fully
 * capable using debug"):
 *   - other windows cover all of Walnut's agent window, or Chrome itself is hidden: on macOS Chrome
 *     stops drawing an occluded window, and captureVisibleTab fails (capture-gate.ts WindowCovered);
 *   - the agent window is minimized;
 *   - the tab is not the front tab of its window (captureVisibleTab copies only the front one).
 * The debugger's Page.captureScreenshot asks the page itself to draw (Chromium: WebContents::
 * IncrementCapturerCount with stay_hidden), so it gives the picture in place: it never raises,
 * focuses or switches anything, and no tab of the agent window is brought up for it.
 *
 * Who uses it:
 *   - the Browser view's stream (agent-view.ts): while someone watches the tab, from the first frame
 *     captureVisibleTab cannot serve. The session then stays attached for the rest of the watch
 *     (no attach and detach per frame, so Chrome's bar stays put), and goes when nobody watches,
 *     the tab goes, or the person turns live pictures off;
 *   - an agent's screenshot (agent-shot.ts), whether or not anyone watches: the agent sees its tab
 *     however the window lies. Its hold lingers a while after (cdp.ts linger), as a step's does.
 * Only an agent's own tab in Walnut's agent window, never a tab of the person's (agent-view.ts and
 * agent-shot.ts pass `liveOk`). Only with the debugger permission and the person's live pictures
 * switch on (trusted-switch.ts livePicturesOn, on by default), and never for a while after the
 * person cancelled Chrome's debugging bar (cdp.ts barCancelled).
 *
 * The session is the tab's one shared session (cdp.ts acquireDebugger): a recording, a dialog or a
 * real-input step meanwhile uses the same attach, and nobody's let-go detaches it from under
 * another. It sends Page.captureScreenshot alone: no input, no script, nothing in the page changes.
 *
 * What it still cannot picture (each with its own line in web/src/components/sessions/
 * browser-view-model.ts): a page with an alert, confirm or prompt open (its script is held, it
 * draws nothing new: `dialog`), a tab DevTools holds (`devtools`), a tab Chrome discarded to save
 * memory (agent-view.ts `discarded`: attaching would reload it), and pages that are not web pages
 * (`not_web`: chrome:// and the like refuse extensions).
 */
import { more } from './agent-api'
import { ext, isFirefox } from './ext'
import { keptReady } from './agent-keep'
import { CANCEL_COOL_MS, CdpError, acquireDebugger, barCancelled, endAllLingers, endLinger, endMark, holdersOf, keepCancel, lingerAfter, releaseDebugger, type LingerIf } from './cdp'
import { dialogOf, orphanOf } from './agent-dialog'
import { LIVE_PICTURES_KEY, REAL_INPUT_KEY, debuggerGranted, livePicturesOn } from './trusted-switch'

export { CANCEL_COOL_MS }

/** Whether pictures through the debugger may be taken of a tab now, or why not (the card's words, browser-view-model.ts). */
export type LiveState = 'on' | 'off' | 'no_permission' | 'cancelled' | 'unavailable' | 'failed' | 'dialog' | 'devtools'

/** Between two pictures through the debugger at least: about four a second (captureVisibleTab gives two). */
export const LIVE_GAP_MS = 250
/**
 * The longest one picture may take. A page that hangs (a renderer stuck, a dialog that opened
 * meanwhile) may never answer, and a caller may hold the capture gate (capture-gate.ts): without a
 * limit every screenshot after it would wait forever (review 2026-11-09).
 */
export const SHOT_MS = 5000
/**
 * After a picture through the debugger failed, none of that tab for this long: each try attaches
 * and may detach the debugger, and its bar would flash on every window (review 2026-11-09).
 */
export const FAIL_BACKOFF_MS = 30_000

/**
 * Tabs whose stream holds the debugger for pictures now, and the holder name of this start
 * (cdp.ts): each start its own, so an endLive that came while the attach was still on its way is
 * seen when it lands (review 2026-11-09: the attach landed after the release and held the debugger,
 * and Chrome's bar, until the tab closed).
 */
const streaming = new Map<number, { by: string }>()
let starts = 0
/** When a picture of each tab last failed, and why. */
const failedAt = new Map<number, { at: number; why: 'failed' | 'devtools' }>()
let lastAt = 0
let listening = false
let shotMs = SHOT_MS
/** Where the person's last Cancel on the debugging bar is kept across a restart of the background. */
export const CANCELLED_AT_KEY = 'debuggerCancelledAt'
let hydrated: Promise<void> | undefined

/**
 * The person's Cancel on the debugging bar, read back after a restart of the background (an MV3
 * service worker sleeps after 30 s idle; without this, the next picture or default step attached
 * again at once and the bar came straight back). Every caller that would attach by itself awaits it.
 */
export function cancelKnown(): Promise<void> {
  listen()
  hydrated ??= (async () => {
    try {
      await keptReady()
      const got = await ext.storage.session.get(CANCELLED_AT_KEY)
      keepCancel((at) => { void ext.storage.session.set({ [CANCELLED_AT_KEY]: at }).catch(() => undefined) }, got?.[CANCELLED_AT_KEY])
    } catch { keepCancel(() => undefined) }
  })()
  return hydrated
}

function listen(): void {
  if (listening) return
  listening = true
  // The session is gone (cdp.ts forgets it, and remembers a Cancel on the bar).
  more.debugger?.onDetach?.addListener((source) => { if (typeof source?.tabId === 'number') streaming.delete(source.tabId) })
  // The person turned live pictures off: every stream lets the debugger go now, not at its next frame.
  ext.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes[LIVE_PICTURES_KEY]?.newValue === false) {
      for (const tabId of [...streaming.keys()]) void endLive(tabId)
      for (const tabId of [...shotTabs]) { shotTabs.delete(tabId); void endLinger(more.debugger, tabId) }
    }
    // Real input turned off: no step's session lingers on any tab.
    if (changes[REAL_INPUT_KEY]?.newValue === false) void endAllLingers(more.debugger)
  })
  ext.tabs.onRemoved?.addListener((tabId) => { failedAt.delete(tabId); streaming.delete(tabId); shotTabs.delete(tabId) })
}

/** Whether pictures through the debugger may be taken of the tab now, or why not. */
export async function liveState(tabId: number, now = Date.now()): Promise<LiveState> {
  if (isFirefox || !more.debugger) return 'unavailable'
  await cancelKnown()
  if (barCancelled(tabId, now)) return 'cancelled'
  if (!(await livePicturesOn())) return await debuggerGranted() ? 'off' : 'no_permission'
  // A dialog holds the page's script, and a picture of it may never come.
  if (dialogOf(tabId) || orphanOf(tabId)) return 'dialog'
  const f = failedAt.get(tabId)
  if (f && now - f.at < FAIL_BACKOFF_MS) return f.why
  return 'on'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function take(tabId: number, by: string, o: { format: 'jpeg' | 'png'; quality?: number }, still: () => boolean = () => true): Promise<string> {
  listen()
  try {
    const send = await acquireDebugger(more.debugger!, tabId, by)
    // Ended while the browser attached: let go of this hold now, and no picture.
    if (!still()) {
      await releaseDebugger(more.debugger, tabId, by)
      throw new Superseded()
    }
    const wait = lastAt + LIVE_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Chrome took too long to draw the page.')), shotMs) })
    const shot = send('Page.captureScreenshot', {
      format: o.format, ...(o.format === 'jpeg' && o.quality !== undefined ? { quality: o.quality } : {}),
      optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false,
    }) as Promise<{ data?: string }>
    shot.catch(() => undefined)
    const r = await Promise.race([shot, late]).finally(() => clearTimeout(timer))
    if (typeof r?.data !== 'string' || !r.data) throw new Error('Chrome gave no picture.')
    failedAt.delete(tabId)
    return `data:image/${o.format};base64,${r.data}`
  } catch (err) {
    // Ended meanwhile (the attach landed late, or the stream let go while the picture was drawn): no failure of the page.
    if (!(err instanceof Superseded) && still()) failedAt.set(tabId, { at: Date.now(), why: err instanceof CdpError && err.code === 'debugger_busy' ? 'devtools' : 'failed' })
    throw err
  }
}

/** The pictures ended while their attach was on its way (not a failure of the page). */
class Superseded extends Error { constructor() { super('Live pictures of this tab ended meanwhile.') } }

/** The stream's picture of the tab; the debugger stays attached for the next one, until endLive. */
export async function livePicture(tabId: number, quality: number): Promise<string> {
  let s = streaming.get(tabId)
  if (!s) { s = { by: `picture:${++starts}` }; streaming.set(tabId, s) }
  const mine = s
  try {
    return await take(tabId, mine.by, { format: 'jpeg', quality }, () => streaming.get(tabId) === mine)
  } catch (err) {
    // No picture this way (DevTools holds the tab, the page went): nothing kept attached for it.
    if (streaming.get(tabId) === mine) await endLive(tabId)
    throw err
  }
}

/** Whether the stream holds the debugger for the tab now (its next pictures come through it). */
export const liveHeld = (tabId: number): boolean => streaming.has(tabId)

/** The stream lets go: nobody watches, the tab went, the picture failed, or live pictures went off. */
export async function endLive(tabId: number): Promise<void> {
  const s = streaming.get(tabId)
  if (!s) return
  streaming.delete(tabId)
  // A hold still attaching is let go when it lands (livePicture's `still`); a landed one, now.
  await releaseDebugger(more.debugger, tabId, s.by)
}

/**
 * An agent's screenshot of its tab through the debugger (agent-shot.ts asks when captureVisibleTab
 * cannot serve: covered, minimized, a tab behind another), held for the rest of that screenshot (a
 * full page takes several) and let go by endShot.
 */
export const liveShot = (tabId: number, o: { format: 'jpeg' | 'png'; quality?: number }): Promise<string> => take(tabId, 'shot', o)

/**
 * The screenshot is done: its hold goes, lingering a while as an agent's step does (cdp.ts
 * lingerAfter: only when it went through, `when` says so, and nobody let the tab go since `mark`).
 */
export async function endShot(tabId: number, when: LingerIf = false, mark = endMark(tabId)): Promise<void> {
  if (!holdersOf(tabId).includes('shot')) return
  shotTabs.add(tabId)
  if (more.debugger) await lingerAfter(more.debugger, tabId, when, mark)
  await releaseDebugger(more.debugger, tabId, 'shot')
}
/** Tabs whose lingering hold came from a screenshot: live pictures turned off ends those too. */
const shotTabs = new Set<number>()

export function _resetLiveForTesting(shot = SHOT_MS): void {
  shotMs = shot
  streaming.clear()
  failedAt.clear()
  lastAt = 0
  hydrated = undefined
  // A fresh background: its listeners are set up again by the first use (tests drop the old ones).
  listening = false
  shotTabs.clear()
}
