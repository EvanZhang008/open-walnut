/**
 * A window an agent's page opens stays out of the person's way (2026-11-19, the user's Chrome: an
 * agent clicked "Sign in with GitHub" on a site through `evaluate`; the site's window.open made a
 * popup window, Chrome put it in front of him and gave it the focus, and Walnut listed it as his,
 * so the agent could not close it).
 *
 * Chrome shows and activates the opener's window for EVERY new window or tab a page makes itself
 * (chrome/browser/ui/browser_web_contents_delegate: AddNewContents passes kShowWindow, then
 * browser_navigator's ScopedBrowserShower calls Show(); with noopener too, and a link's or a
 * form's target=_blank; only Chrome's own background actor is let off). A tab instead of a popup
 * window (`popup=0`, the first fix) still brought the agent window in front of him (2026-11-20, the
 * same sign-in: the session file shows active_window on the agent window at that second). So no
 * page of an agent's opens a new tab or window itself:
 *
 *   - Before each step in an agent's own tab of the agent window, every way the page has to open
 *     one (agent-popups-page.ts WAYS: window.open in this window and its same-site frames,
 *     document.open, a link, a form) is replaced (MAIN world, Proxies, so they still read as
 *     native): it asks the extension, through a relay in the extension's own world, to open the
 *     address as a background tab of the agent window (agent-opened.ts: chrome.tabs.create with
 *     active false never shows a window), the agent's like any it opened. window.open hands the
 *     page a stand-in for the new window: `closed` turns true when that tab closes, `location` is
 *     its address while it is on the page's own site (another site's throws, as a real window's
 *     does), `close()` closes it, and a later open with the same name or a `location` set loads
 *     the same tab. What a stand-in cannot do: be the new page's `window.opener` (a sign-in that
 *     reports back through it finishes in the tab, its cookies set; the agent reloads the page
 *     that opened it).
 *   - While the tab is an agent's (`live`, until a take-over or a release: popupsLive 0). Then
 *     the page's own ways are the browser's again, as before.
 *   - Each page an agent's tab loads is patched as it starts loading (agent-opened.ts
 *     watchPageOpened), so a page that keeps a copy of window.open from its first moment mostly
 *     keeps the wrapped one. A popup window that still comes (the copy taken before the patch
 *     arrived) and is an agent's own (agent-opened.ts adoptOpened) is minimized at once.
 */
import { more } from './agent-api'
import { ext } from './ext'
import { inBridge, inPage } from './agent-popups-page'

/** The page asks the extension for its windows while the tab is an agent's: until a take-over or the agent lets it go (agent-shared.ts letGo). */
export const AGENTS_TAB = Number.MAX_SAFE_INTEGER

/** How long the page gets: a page held by a dialog or a busy script never holds the step. */
const PATCH_MS = 1500

/** The tab's pages (every frame) ask the extension for their new windows from now until they load again. True when the top page took it. */
export async function popupsAsTabs(tabId: number, until: number): Promise<boolean> {
  const s = more.scripting
  if (!s) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const both = async () => {
      // The relay first: a page's window.open never asks before it can be heard.
      const relay = await s.executeScript({ target: { tabId, allFrames: true }, func: inBridge }).then((rs) => rs.some((r) => r.frameId === 0 && r.result === true), () => false)
      if (!relay) return false
      return s.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: inPage, args: [until] as [number] }).then((rs) => rs.some((r) => r.frameId === 0 && r.result === true), () => false)
    }
    return await Promise.race([
      both(),
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
  // Every frame's (a frame the step reached counts its own).
  const rs = await s.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: () => (window as unknown as Record<symbol, unknown>)[Symbol.for('walnut.popups-opened')] }).catch(() => [])
  const ns = rs.map((r) => r.result).filter((n): n is number => typeof n === 'number')
  return ns.length ? ns.reduce((a, b) => a + b, 0) : undefined
}

/**
 * Until when the tab's pages ask the extension for their windows (0: from now on their own open
 * again: the person took the tab over, it was given back). Pages not patched are left alone.
 */
export async function popupsLive(tabId: number, until: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const told = more.scripting?.executeScript({
    target: { tabId, allFrames: true }, world: 'MAIN', args: [until] as [number],
    func: (u: number) => { const w = window as unknown as Record<symbol, unknown>; if (w[Symbol.for('walnut.popups-as-tabs')]) w[Symbol.for('walnut.popups-live')] = u },
  }).catch(() => undefined)
  // A page held by a dialog or a busy script never holds a take-over.
  await Promise.race([told, new Promise((r) => { timer = setTimeout(r, PATCH_MS) })]).finally(() => clearTimeout(timer))
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

