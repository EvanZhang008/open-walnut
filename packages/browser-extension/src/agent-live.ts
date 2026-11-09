/**
 * Live pictures of an agent's tab while other windows cover Walnut's agent window (2026-11-09,
 * the user approved "route 2"). On macOS Chrome stops drawing a window that is covered entirely,
 * and captureVisibleTab then fails (capture-gate.ts WindowCovered). The debugger's
 * Page.captureScreenshot asks the page itself to draw (Chromium: WebContents::
 * IncrementCapturerCount with stay_hidden), so it gives a picture of a covered or minimized tab
 * without showing its window: it never raises, focuses or switches anything.
 *
 * Its cost is Chrome's global "started debugging this browser" bar while the debugger is
 * attached, so it is attached only while it is needed:
 *   - only with the debugger permission and the person's live pictures switch on
 *     (trusted-switch.ts livePicturesOn);
 *   - for the Browser view: only while its stream for the tab runs (the card is watched) and the
 *     window is covered. It lets go when the stream ends, the tab goes, or a capture works again
 *     (the window shows: back to captureVisibleTab, no bar);
 *   - for an agent's screenshot of a covered window: for that screenshot only.
 * The session is the tab's one shared session (cdp.ts acquireDebugger): a recording, a dialog or a
 * real-input step meanwhile uses the same attach, and nobody's let-go detaches it from under
 * another. It sends Page.captureScreenshot alone: no input, no script, nothing in the page changes.
 */
import { more } from './agent-api'
import { ext, isFirefox } from './ext'
import { acquireDebugger, releaseDebugger } from './cdp'
import { dialogOf } from './agent-dialog'
import { LIVE_PICTURES_KEY, debuggerGranted, livePicturesOn } from './trusted-switch'

/** What a covered frame says of live pictures (the card's words, browser-view-model.ts). */
export type LiveState = 'on' | 'off' | 'no_permission' | 'cancelled' | 'unavailable' | 'failed'

/** Between two live pictures at least (about three a second: more than captureVisibleTab's two). */
export const LIVE_GAP_MS = 300
/** While covered, how often captureVisibleTab is tried again to see whether the window shows. */
export const PROBE_MS = 3000
/**
 * The longest one picture may take. A page that hangs (a renderer stuck, a dialog that opened
 * meanwhile) may never answer, and the picture holds the one capture gate (capture-gate.ts):
 * without a limit every screenshot after it would wait forever (review 2026-11-09).
 */
export const SHOT_MS = 5000
/**
 * After a live picture failed, no live picture of that tab for this long: each try attaches and
 * detaches the debugger, and its bar would flash on every window once a second (review 2026-11-09).
 */
export const FAIL_BACKOFF_MS = 30_000
/** After the person cancelled Chrome's debugging bar, no live picture of any tab for this long. */
export const CANCEL_COOL_MS = 10 * 60_000

/** Tabs whose stream holds the debugger for pictures now, and when the window was last tried. */
const streaming = new Map<number, { probedAt: number }>()
/** Tabs where the person cancelled Chrome's debugging bar: no live pictures there again. */
const cancelled = new Set<number>()
let cancelledAt = 0
/** When a live picture of each tab last failed. */
const failedAt = new Map<number, number>()
let lastAt = 0
let listening = false
let probeMs = PROBE_MS
let shotMs = SHOT_MS

function listen(): void {
  if (listening) return
  listening = true
  more.debugger?.onDetach?.addListener((source, reason) => {
    const tabId = source?.tabId
    if (typeof tabId !== 'number') return
    // The session is gone (cdp.ts forgets it too); the person's Cancel is a no for this tab, and
    // for every tab a while.
    streaming.delete(tabId)
    if (reason === 'canceled_by_user') { cancelled.add(tabId); cancelledAt = Date.now() }
  })
  // The person turned live pictures off: every stream lets the debugger go now, not at its next frame.
  ext.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || changes[LIVE_PICTURES_KEY]?.newValue !== false) return
    for (const tabId of [...streaming.keys()]) void endLive(tabId)
  })
  ext.tabs.onRemoved?.addListener((tabId) => { cancelled.delete(tabId); failedAt.delete(tabId); streaming.delete(tabId) })
}

/** Whether live pictures may be taken of the tab now, or why not. */
export async function liveState(tabId: number, now = Date.now()): Promise<LiveState> {
  if (isFirefox || !more.debugger) return 'unavailable'
  listen()
  if (cancelled.has(tabId) || now - cancelledAt < CANCEL_COOL_MS) return 'cancelled'
  if (!(await livePicturesOn())) return await debuggerGranted() ? 'off' : 'no_permission'
  // A dialog holds the page's script, and a picture of it may never come.
  if (dialogOf(tabId)) return 'failed'
  if (now - (failedAt.get(tabId) ?? -Infinity) < FAIL_BACKOFF_MS) return 'failed'
  return 'on'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function take(tabId: number, by: string, o: { format: 'jpeg' | 'png'; quality?: number }): Promise<string> {
  listen()
  try {
    const send = await acquireDebugger(more.debugger!, tabId, by)
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
    failedAt.set(tabId, Date.now())
    throw err
  }
}

/** The stream's picture of a covered tab; the debugger stays attached for the next one, until endLive. */
export async function livePicture(tabId: number, quality: number): Promise<string> {
  const s = streaming.get(tabId)
  if (!s) streaming.set(tabId, { probedAt: Date.now() })
  try {
    return await take(tabId, 'picture', { format: 'jpeg', quality })
  } catch (err) {
    // No picture this way (DevTools holds the tab, the page went): nothing kept attached for it.
    await endLive(tabId)
    throw err
  }
}

/**
 * Whether the stream should take its next picture of the tab straight through the debugger: it
 * holds the debugger for this tab (the window was covered), and it is not time yet to try the
 * window again.
 */
export function liveNow(tabId: number, now = Date.now()): boolean {
  const s = streaming.get(tabId)
  if (!s) return false
  if (now - s.probedAt < probeMs) return true
  s.probedAt = now
  return false
}

/** Whether the stream holds the debugger for the tab now. */
export const liveHeld = (tabId: number): boolean => streaming.has(tabId)

/** The stream lets go: it ended, nobody watches, the tab went, or the window shows again. */
export async function endLive(tabId: number): Promise<void> {
  if (!streaming.delete(tabId)) return
  await releaseDebugger(more.debugger, tabId, 'picture')
}

/**
 * An agent's screenshot of a covered tab: a picture through the debugger, held for the rest of
 * that screenshot (a full page takes several) and let go by endShot right after it.
 */
export const liveShot = (tabId: number, o: { format: 'jpeg' | 'png'; quality?: number }): Promise<string> => take(tabId, 'shot', o)

/** The screenshot is done: its hold goes (detached unless the stream or another holder needs it). */
export const endShot = (tabId: number): Promise<void> => releaseDebugger(more.debugger, tabId, 'shot')

export function _resetLiveForTesting(probe = PROBE_MS, shot = SHOT_MS): void {
  shotMs = shot
  streaming.clear()
  cancelled.clear()
  cancelledAt = 0
  failedAt.clear()
  lastAt = 0
  probeMs = probe
}
