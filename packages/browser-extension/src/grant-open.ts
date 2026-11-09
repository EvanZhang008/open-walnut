/**
 * `view_grant {tab, person}`: "Show it live" on a covered Browser view in Walnut. Chrome asks for
 * an optional permission only inside a click on one of the extension's own pages, so this opens
 * that page (grant.html, grant.ts), whose one button asks for the debugger and turns live pictures
 * on (agent-live.ts). Nothing is granted here: the grant takes the person's two clicks there.
 *
 *   - From the person's own click in Walnut (`person`): the page opens in their last-focused
 *     window, in front, and that window comes forward, as Take over does: they asked for it now.
 *   - From an agent (the route lets one ask, as every person's action): the page opens in their
 *     window in the background, never in front and never focusing anything; it waits there.
 *   - Never in Walnut's agent window. A page already open is reused (brought up for the person).
 *   - The permission held already and live pictures on: nothing opens.
 */
import { ext, type Tab } from './ext'
import { more } from './agent-api'
import { agentWindowId } from './agent-shared'
import { livePicturesOn } from './trusted-switch'

export const GRANT_PAGE = 'grant.html'

/** A window the page may open in: a normal, not private one that is not the agent's. */
async function usable(windowId: number | undefined, agent: number | undefined): Promise<boolean> {
  if (windowId === undefined || windowId === agent) return false
  const w = await more.windows.get(windowId).catch(() => null)
  return !!w && (w.type === undefined || w.type === 'normal') && w.incognito !== true
}

/** The person's window: the last focused one, else any other normal window that is not the agent's. */
async function personsWindow(): Promise<number | undefined> {
  const agent = await agentWindowId()
  const [last] = await ext.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [] as Tab[])
  if (await usable(last?.windowId, agent)) return last!.windowId
  for (const t of await ext.tabs.query({ active: true }).catch(() => [] as Tab[])) if (await usable(t.windowId, agent)) return t.windowId
  return undefined
}

export async function openGrant(c: { args: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const person = c.args.person === true
  if (await livePicturesOn()) return { opened: false, already: true }
  const url = ext.runtime.getURL(GRANT_PAGE)
  const agent = await agentWindowId()
  const open = (await ext.tabs.query({ url }).catch(() => [] as Tab[])).find((t) => t.windowId !== agent)
  if (open?.id !== undefined) {
    if (person) await bringUp(open)
    return { opened: true, reused: true, shown: person }
  }
  const windowId = await personsWindow()
  if (windowId === undefined) return { opened: false, why: 'no_window' }
  const tab = await ext.tabs.create({ url, windowId, active: person })
  if (person) await bringUp(tab)
  return { opened: true, shown: person }
}

/** The person's click: the page in front of their window, and that window forward. */
async function bringUp(tab: Tab): Promise<void> {
  if (tab.id !== undefined) await ext.tabs.update(tab.id, { active: true }).catch(() => undefined)
  if (tab.windowId !== undefined) await ext.windows.update?.(tab.windowId, { focused: true }).catch(() => undefined)
}
