/**
 * A window an agent's page opens stays out of the person's way (2026-11-19, the user's Chrome: an
 * agent clicked "Sign in with GitHub" on a site through `evaluate`; the site's window.open made a
 * popup window, Chrome put it in front of him and gave it the focus, and Walnut listed it as his,
 * so the agent could not close it).
 *
 * Two parts:
 *   - Before each step in an agent's own tab of a normal window (the agent window), the page's
 *     window.open is made to open a tab instead of a popup window (`popup=0`, its noopener and
 *     noreferrer kept): Chrome adds that tab to the agent window behind the person's, with
 *     `window.opener` set as before, so a sign-in popup works the same. Not in a tab of the
 *     person's (a tab there would open in their window), nor in a popup window (Chrome would put
 *     the tab in the person's last window).
 *   - A popup window that still came (a page that opened it before any step, a tab in a popup
 *     window) and is an agent's own (agent-page.ts adoptOpened) is minimized at once: no
 *     minimized window is drawn, and nothing of the person's is touched.
 */
import { more } from './agent-api'
import { ext } from './ext'

/**
 * Runs in the page's world: self-contained, no closures. A Proxy over the page's own open, so the
 * page still sees a native function (a site's bot check compares window.open's source).
 */
function inPage(): boolean {
  const w = window as unknown as Window & Record<symbol, unknown>
  const mark = Symbol.for('walnut.popups-as-tabs')
  const count = Symbol.for('walnut.popups-opened')
  if (w[mark]) return true
  Object.defineProperty(w, count, { value: 0, writable: true })
  const kept = (f: string) => f.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s === 'noopener' || s === 'noreferrer')
  w.open = new Proxy(w.open, {
    apply(target, _self, args: unknown[]) {
      const [url, name, features] = args
      ;(w as unknown as Record<symbol, number>)[count]++
      // No features asks for a tab already; any feature (a size, `popup`) would make a popup window.
      if (features === undefined || features === null || String(features).trim() === '') return Reflect.apply(target, w, args.slice(0, 2))
      return Reflect.apply(target, w, [url, name, ['popup=0', ...kept(String(features))].join(',')])
    },
  })
  Object.defineProperty(w, mark, { value: true })
  return true
}

/** How long the page gets: a page held by a dialog or a busy script never holds the step. */
const PATCH_MS = 1500

/** The tab's pages (every frame) open their windows as tabs from now until they load again. True when the top page took it. */
export async function popupsAsTabs(tabId: number): Promise<boolean> {
  const s = more.scripting
  if (!s) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      s.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: inPage }).then((rs) => rs.some((r) => r.frameId === 0 && r.result === true), () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PATCH_MS) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** How many times the tab's top page called window.open since it took the patch (undefined: no patch there). */
export async function openCalls(tabId: number): Promise<number | undefined> {
  const s = more.scripting
  if (!s) return undefined
  const [r] = await s.executeScript({ target: { tabId }, world: 'MAIN', func: () => (window as unknown as Record<symbol, unknown>)[Symbol.for('walnut.popups-opened')] }).catch(() => [])
  return typeof r?.result === 'number' ? r.result : undefined
}

/** Whether the tab sits in a popup window (its own window.open must stay a popup: a tab would go to the person's window). */
export async function inPopupWindow(tabId: number): Promise<boolean> {
  const t = await ext.tabs.get(tabId).catch(() => null)
  if (!t || t.windowId === undefined) return false
  const w = await ext.windows.get(t.windowId).catch(() => null)
  return w?.type === 'popup'
}

/** An agent's own tab that came in a popup window: the window is minimized, never shown again by Walnut. True when it was. */
export async function minimizeAgentPopup(tabId: number): Promise<boolean> {
  const t = await ext.tabs.get(tabId).catch(() => null)
  if (!t || t.windowId === undefined || !(await inPopupWindow(tabId))) return false
  return !!(await ext.windows.update?.(t.windowId, { state: 'minimized' }).catch(() => null))
}

export const _inPageForTesting = inPage
