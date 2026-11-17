/**
 * How a leave of a page (agent-leave.ts) ends: started (the tab starts loading or changes address),
 * or, once its "Leave site?" was answered Leave (agent-dialog-act.ts), the tab gone or the next
 * page loaded. Apart from agent-leave.ts so the dialog's answer can use it without the leave's own
 * imports.
 */
import { ext } from './ext'
import { loaded, where } from './agent-shared'
import type { LeaveKind } from './agent-dialog'
import { whenGone } from './tab-close'

/** How long a leave waits for the browser to start it (or the page's "Leave site?" to open). */
const START_MS = 10_000

/**
 * Resolves true once the tab starts loading or changes address, false after `ms`. Made before the
 * step that starts it, so the start is never missed.
 */
export function whenStarted(tabId: number, ms = START_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const on = (id: number, change: { status?: string; url?: string }) => { if (id === tabId && (change.status === 'loading' || change.url)) finish(true) }
    const t = setTimeout(() => finish(false), ms)
    function finish(v: boolean) { clearTimeout(t); ext.tabs.onUpdated.removeListener(on); resolve(v) }
    ext.tabs.onUpdated.addListener(on)
  })
}

/** Where a leave ends once its "Leave site?" was answered Leave: the tab gone, or the next page loaded. */
export async function afterLeave(tabId: number, kind: LeaveKind): Promise<Record<string, unknown>> {
  if (kind === 'close') {
    if (await whenGone(tabId)) return { tab: tabId, closed: true }
    return { closed: false, note: 'The tab did not close: close it again.', ...(await where(tabId)) }
  }
  await whenStarted(tabId, 3000)
  await loaded(tabId)
  return { left: true, ...(await where(tabId)) }
}

