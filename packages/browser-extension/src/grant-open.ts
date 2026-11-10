/**
 * `view_grant {tab, person}`: "Show it live" in a task's Browser view, for a copy of the extension
 * that lacks the debugger permission (it is required in the manifest, so this is rare:
 * trusted-switch.ts). Chrome asks for a permission only inside a click on one of the extension's
 * own pages, so this opens that page (grant.html, grant.ts), whose one button asks for the debugger
 * and turns live pictures on (agent-live.ts). Nothing is granted here: the grant takes the person's
 * two clicks there.
 *
 *   - From the person's own click in Walnut (`person`): the page opens in their last-focused
 *     window, in front, and that window comes forward, as Take over does: they asked for it now.
 *   - From an agent (the route lets one ask, as every person's action): the page opens in their
 *     window in the background, never in front and never focusing anything; it waits there.
 *   - Never in Walnut's agent window. A page already open is reused (brought up for the person).
 *   - The permission held already: nothing opens (live pictures turned off is the person's own
 *     choice in Settings, which this page never undoes).
 *   - The person closed the page without allowing: an agent's ask opens it again only
 *     GRANT_COOL_MS after that (review 2026-11-09: an agent could put it back in their window each
 *     time they closed it). The person's own click is never held back.
 */
import { ext, type Tab } from './ext'
import { more } from './agent-api'
import { agentWindowId } from './agent-shared'
import { debuggerGranted, livePicturesOn } from './trusted-switch'

export const GRANT_PAGE = 'grant.html'
/** After the person closed the page without allowing, an agent's ask opens no new one for this long. */
export const GRANT_COOL_MS = 10 * 60_000
/** storage.local: the grant page opened last (its tab while open) and when the person closed one unallowed. */
export const GRANT_STATE_KEY = 'grantPage'
type GrantState = { tab?: number; openedAt?: number; closedAt?: number }

const readState = async (): Promise<GrantState> => ((await ext.storage.local.get(GRANT_STATE_KEY).catch(() => ({} as Record<string, unknown>)))[GRANT_STATE_KEY] ?? {}) as GrantState
const writeState = (v: GrantState) => ext.storage.local.set({ [GRANT_STATE_KEY]: v }).catch(() => undefined)

let watching = false
/** The person closing the grant page without allowing starts the agents' cooldown (registered at the background's start, so a close wakes it). */
export function watchGrantClose(): void {
  if (watching) return
  watching = true
  ext.tabs.onRemoved.addListener((tabId) => { void noteClosed(tabId) })
}

async function noteClosed(tabId: number): Promise<void> {
  const g = await readState()
  if (g.tab !== tabId) return
  await writeState(await debuggerGranted() ? {} : { ...g, tab: undefined, closedAt: Date.now() })
}

/** When the person last closed the page without allowing; no page is open now, so one still noted open was closed unseen (counted from now). */
async function closedAt(): Promise<number | undefined> {
  const g = await readState()
  if (g.tab !== undefined) {
    const at = Date.now()
    await writeState({ ...g, tab: undefined, closedAt: at })
    return at
  }
  return g.closedAt
}

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
  if (await debuggerGranted()) {
    return await livePicturesOn() ? { opened: false, already: true }
      : { opened: false, already: true, off: true, note: 'The person turned live pictures off in the Walnut extension\'s Settings: only they can turn them on again there.' }
  }
  const url = ext.runtime.getURL(GRANT_PAGE)
  const agent = await agentWindowId()
  const open = (await ext.tabs.query({ url }).catch(() => [] as Tab[])).find((t) => t.windowId !== agent)
  if (open?.id !== undefined) {
    if (person) await bringUp(open)
    return { opened: true, reused: true, shown: person }
  }
  if (!person) {
    const closed = await closedAt()
    const left = closed === undefined ? 0 : closed + GRANT_COOL_MS - Date.now()
    if (left > 0) {
      return {
        opened: false, why: 'closed_recently', retry_after_ms: left,
        note: 'The person closed the page that turns live pictures on without allowing it. Do not ask again now; they can press Show it live in the Browser view themselves.',
      }
    }
  }
  const windowId = await personsWindow()
  if (windowId === undefined) return { opened: false, why: 'no_window' }
  const tab = await ext.tabs.create({ url, windowId, active: person })
  if (tab.id !== undefined) await writeState({ tab: tab.id, openedAt: Date.now() })
  if (person) await bringUp(tab)
  return { opened: true, shown: person }
}

export function _resetGrantOpenForTesting(): void { watching = false }

/** The person's click: the page in front of their window, and that window forward. */
async function bringUp(tab: Tab): Promise<void> {
  if (tab.id !== undefined) await ext.tabs.update(tab.id, { active: true }).catch(() => undefined)
  if (tab.windowId !== undefined) await ext.windows.update?.(tab.windowId, { focused: true }).catch(() => undefined)
}
