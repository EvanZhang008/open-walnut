/**
 * The Walnut agent window, where an agent's own tabs open: a normal window of its own, behind the
 * person's (never focused, never minimized), so the person can always look at what an agent does
 * there and their own window and focus stay as they left them (2026-11-07: an old relay's agent
 * window was always minimized, and the person never saw a session sign in to his bank again).
 * A second tab opens in the same window, active there, which raises nothing.
 *
 * Which window a tab is in goes into every answer (`where` in agent-shared.ts), so an agent can
 * tell the person in its first line where to look.
 */
import type { ExtApi, Tab } from './ext'
import { AGENT_PAGE } from './agent-groups'

/** How the window is made: pinned by tests/core/browser-control/extension-agent-window.test.ts. */
export const AGENT_WINDOW = { focused: false, width: 1280, height: 900, type: 'normal' } as const

type Api = Pick<ExtApi, 'windows' | 'tabs' | 'storage'> & { runtime?: { getURL(path: string): string } }

/**
 * A tab at `url` in the agent window, made first when there is none. It opens blank and is muted
 * before the page loads, so nothing it plays makes a sound (2026-10-29: pages an agent opened
 * played video with sound during the person's meeting); `before` runs on the blank tab, before
 * the page loads (an agent's recording starts there, agent-net.ts).
 */
export async function openInAgentWindow(api: Api, url: string, before?: (tabId: number) => Promise<void>): Promise<Tab> {
  const { agentWindow: id } = await api.storage.session.get('agentWindow')
  let tab: Tab | undefined
  if (typeof id === 'number') {
    const w = await api.windows.get(id).catch(() => null)
    if (w) tab = await newAgentTab(api, id)
  }
  if (!tab) {
    // The window's first tab is its own page (agent-groups.ts AGENT_PAGE: what this window is, in
    // front while every task's group is folded); the agent's page opens beside it.
    const own = api.runtime?.getURL(AGENT_PAGE)
    const w = await api.windows.create({ url: own ?? 'about:blank', ...AGENT_WINDOW })
    await api.storage.session.set({ agentWindow: w.id, ...(own && w.tabs?.[0]?.id !== undefined ? { agentPage: w.tabs[0].id } : {}) })
    tab = own && w.id !== undefined
      ? await newAgentTab(api, w.id)
      : w.tabs?.[0] ?? (await api.tabs.query({ active: true, windowId: w.id }))[0] ?? {}
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
  if (tab.id !== undefined) await frontInWindow(api, windowId, tab.id)
  return tab
}

/** `tabId` in front of its window, unless the person is in that window (their tab stays theirs). */
export async function frontInWindow(api: Pick<ExtApi, 'windows' | 'tabs'>, windowId: number | undefined, tabId: number): Promise<void> {
  const w = windowId === undefined ? null : await api.windows.get(windowId).catch(() => null) as { focused?: boolean } | null
  if (!w || w.focused) return
  await api.tabs.update(tabId, { active: true }).catch(() => undefined)
}

/** The sizes a resize takes, in CSS pixels. */
export const RESIZE_LIMITS = { minW: 320, maxW: 3840, minH: 240, maxH: 2400 } as const

/**
 * `resize`: the agent window to a size, or (viewport) so the page itself gets that size. Only the
 * agent window, never one of the person's; only its size: never focus, never minimize. A
 * maximized or full-screen agent window becomes a normal one first (a size means nothing there).
 */
export async function resizeAgentWindow(api: Api, tabId: number, want: { width: number; height: number; viewport?: boolean }): Promise<{ width?: number; height?: number; viewport: { width?: number; height?: number } }> {
  const { agentWindow } = await api.storage.session.get('agentWindow')
  const tab = await api.tabs.get(tabId)
  if (typeof agentWindow !== 'number' || tab.windowId !== agentWindow) {
    throw Object.assign(new Error('resize changes Walnut\'s agent window only; this tab is in the person\'s own window, whose size is theirs.'), { code: 'person_window' })
  }
  const clamp = (n: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, n)))
  const L = RESIZE_LIMITS
  const before = await api.windows.get(agentWindow) as { width?: number; height?: number; state?: string }
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
  const { agentWindow } = await api.storage.session.get('agentWindow')
  const w = await api.windows.get(windowId).catch(() => null) as { state?: string } | null
  return { window: agentWindow === windowId ? 'agent' : 'person', ...(typeof w?.state === 'string' ? { windowState: w.state } : {}) }
}
