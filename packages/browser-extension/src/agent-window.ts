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

/** How the window is made: pinned by tests/core/browser-control/extension-agent-window.test.ts. */
export const AGENT_WINDOW = { focused: false, width: 1280, height: 900, type: 'normal' } as const

type Api = Pick<ExtApi, 'windows' | 'tabs' | 'storage'>

/** A tab at `url` in the agent window, made first when there is none. */
export async function openInAgentWindow(api: Api, url: string): Promise<Tab> {
  const { agentWindow: id } = await api.storage.session.get('agentWindow')
  if (typeof id === 'number') {
    const w = await api.windows.get(id).catch(() => null)
    if (w) return api.tabs.create({ url, windowId: id, active: true })
  }
  const w = await api.windows.create({ url, ...AGENT_WINDOW })
  await api.storage.session.set({ agentWindow: w.id })
  return w.tabs?.[0] ?? (await api.tabs.query({ active: true, windowId: w.id }))[0] ?? {}
}

export type WindowKind = 'agent' | 'person'

/** Which window a tab is in: Walnut's agent window or one of the person's, and that window's state (minimized, normal...). */
export async function windowOf(api: Pick<ExtApi, 'windows' | 'storage'>, windowId: number | undefined): Promise<{ window?: WindowKind; windowState?: string }> {
  if (windowId === undefined) return {}
  const { agentWindow } = await api.storage.session.get('agentWindow')
  const w = await api.windows.get(windowId).catch(() => null) as { state?: string } | null
  return { window: agentWindow === windowId ? 'agent' : 'person', ...(typeof w?.state === 'string' ? { windowState: w.state } : {}) }
}
