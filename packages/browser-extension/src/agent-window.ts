/**
 * The Walnut agent window, where an agent's own tabs open: a normal window of its own, behind the
 * person's (never focused, never minimized), so the person can always look at what an agent does
 * there and their own window and focus stay as they left them (2026-11-07: an old relay's agent
 * window was always minimized, and the person never saw a session sign in to his bank again).
 * A second tab opens in the same window, active there, which raises nothing.
 *
 * The one rule for focus and the front tab lives here: an agent's step changes the front tab only
 * through `frontInWindow`, and only in Walnut's own agent window (agent-window-own.ts: never a
 * window the person uses) while the person is not in it; it never focuses a window. Only the
 * person's own click focuses one, through `revealForPerson`. Pinned by
 * tests/core/browser-control/extension-agent-window.test.ts (a scan of every call).
 *
 * Which window a tab is in goes into every answer (`where` in agent-shared.ts), so an agent can
 * tell the person in its first line where to look.
 */
import type { ExtApi, Tab } from './ext'
import { keptReady } from './agent-keep'
import { AGENT_PAGE, AGENT_WINDOW, makeAgentWindow, noteAgentTabMaking, ownAgentWindow, screenSharing, setScreenSharing, type OwnApi } from './agent-window-own'

export { AGENT_WINDOW }

type Api = Pick<ExtApi, 'windows' | 'tabs' | 'storage'> & { runtime?: { getURL(path: string): string } }
const own = (api: unknown) => api as OwnApi

/**
 * A tab at `url` in the agent window, made first when there is none. It opens blank and is muted
 * before the page loads, so nothing it plays makes a sound (2026-10-29: pages an agent opened
 * played video with sound during the person's meeting); `before` runs on the blank tab, before
 * the page loads (an agent's recording starts there, agent-net.ts).
 */
export async function openInAgentWindow(api: Api, url: string, before?: (tabId: number) => Promise<void>): Promise<Tab> {
  // After an extension reload the window comes back first (agent-keep.ts): never a second one.
  await keptReady()
  // Only a window that is still Walnut's alone: one the person works in is given up first.
  const id = await ownAgentWindow(own(api))
  let tab: Tab | undefined
  if (id !== undefined) tab = await newAgentTab(api, id)
  if (!tab) {
    // The window's first tab is its own page (AGENT_PAGE: what this window is, in front while
    // every task's group is folded); the agent's page opens beside it.
    const made = await makeAgentWindow(own(api))
    tab = api.runtime?.getURL(AGENT_PAGE) && made.id !== undefined
      ? await newAgentTab(api, made.id)
      : made.first ?? (await api.tabs.query({ active: true, windowId: made.id }))[0] ?? {}
  }
  if (tab.id === undefined) return tab
  await api.tabs.update(tab.id, { muted: true })
  if (before) await before(tab.id)
  return api.tabs.update(tab.id, { url })
}

/**
 * A new blank tab in the agent window, made in the background and only then put in front of that
 * window, never while the person is in it. `tabs.create` with `active: true` focuses its window in
 * Chrome (2026-11-09: the agent window came up over the person's work at its first tab), while
 * `tabs.update` with `active` changes only which tab the window shows.
 */
export async function newAgentTab(api: Api, windowId: number): Promise<Tab> {
  const tab = await api.tabs.create({ url: 'about:blank', windowId, active: false })
  // An agent's from now on, before storage says so (agent-window-own.ts).
  noteAgentTabMaking(tab.id)
  if (tab.id !== undefined) await frontInWindow(api, windowId, tab.id)
  return tab
}

/**
 * `tabId` in front of its window for an agent's step: the only call that does so. Only in
 * Walnut's own agent window (never one the person uses: agent-window-own.ts), only while the
 * person is not in it, and never focusing it. True when the tab is in front now.
 */
export async function frontInWindow(api: Pick<ExtApi, 'windows' | 'tabs' | 'storage'>, windowId: number | undefined, tabId: number): Promise<boolean> {
  if (windowId === undefined || windowId !== await ownAgentWindow(own(api))) return false
  const w = await api.windows.get(windowId).catch(() => null) as { focused?: boolean } | null
  if (!w || w.focused) return false
  const t = await api.tabs.get(tabId).catch(() => null)
  if (!t || t.windowId !== windowId) return false
  return api.tabs.update(tabId, { active: true }).then(() => true, () => false)
}

/** Why a window may come forward: each is the person's own click, never an agent's step. */
export type PersonReveal = 'takeover' | 'grant-open' | 'walnut-tab' | 'reveal'

/**
 * The person's own click brings a tab forward: in front of its window, and that window focused.
 * The only call in the extension that focuses a window for a tab (the scan in
 * extension-agent-window.test.ts lists each caller with its `why`).
 */
export async function revealForPerson(api: Pick<ExtApi, 'windows' | 'tabs'>, tab: number | Tab, _why: PersonReveal): Promise<void> {
  const tabId = typeof tab === 'number' ? tab : tab.id
  if (tabId === undefined) return
  const t = await api.tabs.update(tabId, { active: true }).catch(() => null)
  const windowId = (typeof tab === 'number' ? undefined : tab.windowId) ?? t?.windowId ?? (await api.tabs.get(tabId).catch(() => null))?.windowId
  if (windowId !== undefined) await api.windows.update?.(windowId, { focused: true }).catch(() => undefined)
}

/**
 * The server said whether this machine's screen is shared (its poll answer). When a share starts,
 * the agent window is minimized, so no page of an agent's shows in it (sharing Chrome as an app
 * shares every Chrome window on screen); one made during the share is made minimized. It is never
 * shown again by Walnut: showing a minimized window on macOS brings it to the front, so it stays
 * in the Dock until the person opens it. True when it minimized the window now.
 */
export async function noteScreenShare(api: Pick<ExtApi, 'windows' | 'tabs' | 'storage'>, shared: boolean): Promise<boolean> {
  const was = screenSharing()
  setScreenSharing(shared)
  if (!shared || was) return false
  const id = await ownAgentWindow(own(api))
  if (id === undefined) return false
  const w = await api.windows.get(id).catch(() => null)
  if (!w || w.state === 'minimized') return false
  return !!(await api.windows.update?.(id, { state: 'minimized' }).catch(() => null))
}

/** The sizes a resize takes, in CSS pixels. */
export const RESIZE_LIMITS = { minW: 320, maxW: 3840, minH: 240, maxH: 2400 } as const

/**
 * `resize`: the agent window to a size, or (viewport) so the page itself gets that size. Only the
 * agent window, never one of the person's; only its size: never focus, never minimize. A
 * maximized or full-screen agent window becomes a normal one first (a size means nothing there).
 */
export async function resizeAgentWindow(api: Api, tabId: number, want: { width: number; height: number; viewport?: boolean }): Promise<{ width?: number; height?: number; viewport: { width?: number; height?: number } }> {
  const agentWindow = await ownAgentWindow(own(api))
  const tab = await api.tabs.get(tabId)
  if (agentWindow === undefined || tab.windowId !== agentWindow) {
    throw Object.assign(new Error('resize changes Walnut\'s agent window only; this tab is in the person\'s own window, whose size is theirs.'), { code: 'person_window' })
  }
  const clamp = (n: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, n)))
  const L = RESIZE_LIMITS
  const before = await api.windows.get(agentWindow) as { width?: number; height?: number; state?: string }
  // A size given to a minimized window can bring it back on screen (macOS restores it in front):
  // the person (or a screen share) put it away, and it stays away.
  if (before.state === 'minimized') {
    throw Object.assign(new Error('The agent window is minimized (the person put it away, or a screen share hid it): it keeps its size until it is shown again.'), { code: 'minimized' })
  }
  // The window's frame and toolbars around the page: what a viewport size adds to the window's.
  const padW = want.viewport && before.width && tab.width ? before.width - tab.width : 0
  const padH = want.viewport && before.height && tab.height ? before.height - tab.height : 0
  const width = clamp(want.width + padW, L.minW, L.maxW + padW)
  const height = clamp(want.height + padH, L.minH, L.maxH + padH)
  const plain = before.state === 'maximized' || before.state === 'fullscreen' ? { state: 'normal' as const } : {}
  await api.windows.update?.(agentWindow, { ...plain, width, height })
  const after = await api.windows.get(agentWindow) as { width?: number; height?: number }
  const t = await api.tabs.get(tabId)
  return { width: after.width, height: after.height, viewport: { width: t.width, height: t.height } }
}

export type WindowKind = 'agent' | 'person'

/** Which window a tab is in: Walnut's agent window or one of the person's, and that window's state (minimized, normal...). */
export async function windowOf(api: Pick<ExtApi, 'windows' | 'storage'>, windowId: number | undefined): Promise<{ window?: WindowKind; windowState?: string }> {
  if (windowId === undefined) return {}
  const agentWindow = await ownAgentWindow(own(api))
  const w = await api.windows.get(windowId).catch(() => null) as { state?: string } | null
  return { window: agentWindow === windowId ? 'agent' : 'person', ...(typeof w?.state === 'string' ? { windowState: w.state } : {}) }
}
