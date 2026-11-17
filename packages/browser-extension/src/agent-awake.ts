/**
 * A page in Walnut's agent window keeps running while an agent works in it, with the window still
 * behind the person's.
 *
 * 2026-11-17, the user's Chrome: with the agent window covered (where it always stays now), Chrome
 * counts its pages as hidden: a video the page makes from a picked file never loads (readyState
 * stays 0) and requestAnimationFrame never runs, so a site's video upload sat at "Uploading" for
 * good, and its Post button's checks never finished (no post was made). Measured in Chromium: a
 * hidden tab's blob video stays at readyState 0; with the debugger's
 * Emulation.setFocusEmulationEnabled the same tab counts as on screen and in focus
 * (visibilityState "visible"), the video loads and frames run. It changes nothing on screen: no
 * window is shown, raised or focused, no tab switched (Playwright sets it on every page it drives
 * for this reason).
 *
 * So any step of an agent's in its own tab of the agent window, on a page Chrome counts as hidden,
 * holds the tab's debugger session with focus emulation on for AWAKE_MS, and each later step there
 * keeps it that long again (an upload or a submit is still being processed while the agent waits
 * and looks). Chrome's debugging bar shows while it lasts, as it does after a real-input step. It
 * ends like any lingering hold (cdp.ts linger): the agent lets the tab go, the person takes it
 * over, cancels Chrome's debugging bar or turns real input off. Never in a tab of the person's, and
 * never while the page is on screen anyway (no debugging bar for nothing).
 */
import { more } from './agent-api'
import { ext } from './ext'
import { acquireDebugger, barCancelled, emulateFocus, endLinger, endMark, focusEmulated, lingerAfter, releaseDebugger, stepHolder } from './cdp'
import { lingersIn } from './agent-debugger'
import { agentWindowId, type WireCommand } from './agent-shared'
import { reachPage } from './page-reach'
import { cancelKnown } from './agent-live'
import { trustedReady } from './agent-trusted'

/** How long the page stays awake after an agent's last step in its tab. */
export const AWAKE_MS = 3 * 60_000
/** Steps that never wake a page: closing it. Every other step in a tab may need the page running. */
export const NO_WAKE_ACTS = new Set(['close'])

/** Whether the tab's page is held awake now (its page reads visible then, so this is not asked of the page). */
export const isAwake = (tabId: number): boolean => focusEmulated(tabId)
/** How long the page may take to say whether it is hidden: a frozen page or an open dialog never holds the step. */
const LOOK_MS = 1500

/**
 * Before an agent's step in a tab: wake its page when Chrome counts it as hidden, or keep it awake
 * when it is already. True when the tab is held awake after this.
 */
export async function wakeForStep(c: WireCommand): Promise<boolean> {
  const tabId = c.args.tab
  if (typeof tabId !== 'number') return false
  if (NO_WAKE_ACTS.has(c.action)) return false
  const keep = isAwake(tabId)
  const dbg = more.debugger
  if (!dbg || !(await trustedReady())) return false
  await cancelKnown()
  if (barCancelled(tabId)) return false
  // Only an agent's own tab, not the person's, not while they drive it, in Walnut's own agent window
  // (a tab that left it, dragged out or given back, lets go of its hold now).
  const tab = await ext.tabs.get(tabId).catch(() => null)
  if (!(await lingersIn(tabId)()) || !tab || tab.windowId === undefined || tab.windowId !== await agentWindowId()) {
    if (keep) await endLinger(dbg, tabId)
    return false
  }
  // On screen already: nothing to wake (and no debugging bar for it).
  if (!keep) {
    const look = await reachPage(tabId, false, { deadlineMs: LOOK_MS }).catch(() => null)
    if (!look?.ok || !look.hidden) return false
  }
  const by = stepHolder()
  const mark = endMark(tabId)
  try { await acquireDebugger(dbg, tabId, by) } catch { return false }
  try {
    // A session another holder attached has none yet; one the browser refused keeps nothing attached for it.
    if (keep || await emulateFocus(tabId)) await lingerAfter(dbg, tabId, lingersIn(tabId), mark, AWAKE_MS)
  } finally {
    await releaseDebugger(dbg, tabId, by)
  }
  return isAwake(tabId)
}
