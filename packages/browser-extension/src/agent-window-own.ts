/**
 * Which window is Walnut's agent window, asked in one place: the window the extension made for
 * agents, only while the person does not use it. 2026-11-17, seen in the user's Chrome: the agent
 * window had become his main window (26 of his own tabs in it: new tabs, links from other apps,
 * mail and calendar), and every agent step there put an agent's tab or this window's own page
 * (agent-window.html) in front of his window while Chrome was not the front app, so his own window
 * kept "jumping" to Walnut's page and the agents' pages, during a screen share too. Each switch was
 * guarded by "the person is not in that window" (windows.get().focused), which is false whenever
 * he is in another app, so nothing stopped it.
 *
 *   - A window holding one tab of the person's is theirs: a web page no agent made, holds, or
 *     opened from one of its tabs (agentTabs, agentMade, the opener). A blank or New Tab page is no
 *     sign yet (Chrome makes one when a folded group would hold the front tab); once it shows a
 *     page it is. Neither is a tab an agent's open is making right now (not in storage yet), nor
 *     one that was an agent's and was given back where it is (Stop, agents off).
 *   - Then the window is given up for good (`releaseAgentWindow`): Walnut forgets it, closes its
 *     own page there, and moves the agents' tabs out into a new agent window made behind the
 *     person's (never the tab they are looking at). The person's tabs are never touched.
 *   - Every reader of the agent window goes through `ownAgentWindow` (agent-shared.ts
 *     agentWindowId, agent-window.ts, agent-groups.ts): a tab switch, a fold, a tidy, a picture
 *     or a trusted input is then never in a window of the person's.
 *
 * A leaf module (types only), so agent-groups.ts and agent-keep.ts can read it without a cycle.
 * tests/core/browser-control/extension-agent-window-own.test.ts.
 */
import type { ExtApi, Tab } from './ext'

/** The agent window's own first tab (agent-groups.ts folds the groups behind it). */
export const AGENT_PAGE = 'agent-window.html'

/** How the window is made: unfocused, a normal size, never minimized (agent-window.ts). */
export const AGENT_WINDOW = { focused: false, width: 1280, height: 900, type: 'normal' } as const

type OwnTab = Tab & { openerTabId?: number; pendingUrl?: string; groupId?: number }
export interface OwnApi {
  storage: { session: { get(k: string | string[]): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void>; remove(k: string | string[]): Promise<void> } }
  tabs: Pick<ExtApi['tabs'], 'get' | 'remove'> & {
    /** Absent in a browser without it (and in some test fakes): no tab can be told the person's then. */
    query?(q: { windowId?: number; active?: boolean }): Promise<OwnTab[]>
    move?(tabIds: number | number[], o: { windowId?: number; index: number }): Promise<unknown>
  }
  tabGroups?: { move?(groupId: number, o: { windowId?: number; index: number }): Promise<unknown> }
  windows: Pick<ExtApi['windows'], 'get' | 'create' | 'update'>
  runtime?: { getURL(path: string): string }
}

const asMap = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** A web page (or a file): what a person opens. Blank, New Tab and the browser's own pages are not. */
export function isPage(url: string | undefined): boolean {
  return /^(https?|file):/i.test(url ?? '')
}

/**
 * Tabs being made for an agent right now: an open makes a blank tab, then loads its page, and only
 * after that is the tab an agent's in storage (agentTabs, agentMade). Meanwhile it already shows
 * the address it loads, and a reader then would take it for the person's (seen in the extension's
 * own Chromium spec: an agent's open gave its window up). Kept MAKING_MS at most, in memory.
 */
const making = new Map<number, number>()
export const MAKING_MS = 120_000
export function noteAgentTabMaking(tabId: number | undefined, now = Date.now()): void {
  if (tabId === undefined) return
  making.set(tabId, now)
  for (const [id, at] of making) if (now - at > MAKING_MS) making.delete(id)
}

/**
 * Tabs that were an agent's while this background ran: one given back in place (the person's Stop,
 * agents off) is no sign the person took the window for their own work. Memory only.
 */
const once = new Set<number>()
const ONCE_MAX = 2000

/** The tab ids Walnut's agents hold or made, and the agent page's address. */
async function agentsOwn(api: OwnApi): Promise<Own> {
  // One key a call: the same as one call with all three, and what every fake in the tests answers.
  const [t, m, p] = await Promise.all([api.storage.session.get('agentTabs'), api.storage.session.get('agentMade'), api.storage.session.get('agentPage')])
  const s = { agentTabs: t?.agentTabs, agentMade: m?.agentMade, agentPage: p?.agentPage }
  const ids = new Set<number>()
  const persons = new Set<number>()
  for (const [k, rec] of Object.entries(asMap(s.agentTabs))) {
    const id = Number(k)
    if (!Number.isInteger(id)) continue
    // A tab the person handed over or an agent took is still the person's own tab.
    const r = asMap(rec)
    if (r.handed || r.taken) persons.add(id)
    else ids.add(id)
  }
  for (const k of Object.keys(asMap(s.agentMade))) if (Number.isInteger(Number(k)) && !persons.has(Number(k))) ids.add(Number(k))
  const now = Date.now()
  for (const [id, at] of making) if (now - at <= MAKING_MS && !persons.has(id)) ids.add(id)
  for (const id of ids) { once.delete(id); once.add(id) }
  while (once.size > ONCE_MAX) once.delete(once.values().next().value as number)
  return { ids, once: new Set(once), persons, page: typeof s.agentPage === 'number' ? s.agentPage : undefined, pageUrl: api.runtime?.getURL(AGENT_PAGE) }
}

/** The tabs that are Walnut's: what agents hold or made, and the agent page. */
export interface Own { ids: Set<number>; persons: Set<number>; page?: number; pageUrl?: string; once?: Set<number>; openers?: Map<number, number> }

/** Whether one tab in the agent window is the person's (rule in the header). */
export function isPersonsTab(t: OwnTab, own: Own): boolean {
  if (t.id !== undefined && own.persons.has(t.id)) return true
  if (t.id === undefined || own.ids.has(t.id) || own.once?.has(t.id) || t.id === own.page) return false
  const url = t.url || t.pendingUrl || ''
  if (own.pageUrl && url.startsWith(own.pageUrl)) return false
  // Opened by an agent's tab, or by a tab one opened (a sign-in's pop-ups), not yet adopted.
  for (let o = t.openerTabId, n = 0; o !== undefined && n < 10; o = own.openers?.get(o), n++) if (own.ids.has(o) || own.once?.has(o)) return false
  return isPage(url)
}

/** Every tab of one window. */
async function tabsIn(api: OwnApi, windowId: number): Promise<OwnTab[]> {
  const all = await api.tabs.query?.({ windowId }).catch(() => [] as OwnTab[]) ?? []
  return all.filter((t) => t.windowId === windowId)
}

/** The person's tabs in a window (none: the window is still Walnut's alone). */
export async function personTabsIn(api: OwnApi, windowId: number): Promise<OwnTab[]> {
  const own = await agentsOwn(api)
  const tabs = await tabsIn(api, windowId)
  const openers = new Map<number, number>()
  for (const t of tabs) if (t.id !== undefined && t.openerTabId !== undefined) openers.set(t.id, t.openerTabId)
  return tabs.filter((t) => isPersonsTab(t, { ...own, openers }))
}

/** One release at a time: two readers seeing the person's tab at once give the window up once. */
let releasing: Promise<unknown> = Promise.resolve()

/**
 * The agent window's id, or none: none when there is none, it is gone, or it became the person's
 * (then it is given up first). Readers await agent-keep.ts keptReady before this (agent-shared.ts).
 */
export async function ownAgentWindow(api: OwnApi): Promise<number | undefined> {
  await releasing
  const { agentWindow: id } = await api.storage.session.get('agentWindow')
  if (typeof id !== 'number') return undefined
  // (A caller typed without windows, agent-groups.ts GroupApi, cannot check it is still there.)
  const w = api.windows?.get ? await api.windows.get(id).catch(() => null) : {}
  if (!w) return undefined
  const theirs = await personTabsIn(api, id)
  if (!theirs.length) return id
  const run = releasing.then(() => releaseAgentWindow(api, id))
  releasing = run.catch(() => undefined)
  await run
  // The release may have made the new agent window (for the agents' tabs it moved): that one.
  const after = (await api.storage.session.get('agentWindow')).agentWindow
  return typeof after === 'number' && after !== id ? after : undefined
}

/**
 * Whether this machine's screen is shared now (the server's poll answer, screen-share.ts on the
 * server): the agent window is then kept minimized (agent-window.ts noteScreenShare).
 */
let sharing = false
export const screenSharing = (): boolean => sharing
export function setScreenSharing(shared: boolean): void { sharing = shared }

/**
 * A new agent window, behind the person's: its own page first. The id, and that page's tab.
 * While the screen is shared it is made minimized (a minimized window is in no share; Chrome
 * takes no size with that state).
 */
export async function makeAgentWindow(api: OwnApi): Promise<{ id?: number; first?: Tab }> {
  const own = api.runtime?.getURL(AGENT_PAGE)
  const w = sharing
    ? await api.windows.create({ url: own ?? 'about:blank', type: 'normal', focused: false, state: 'minimized' })
    : await api.windows.create({ url: own ?? 'about:blank', ...AGENT_WINDOW })
  const first = w.tabs?.[0]
  await api.storage.session.set({ agentWindow: w.id, ...(own && first?.id !== undefined ? { agentPage: first.id } : {}) })
  // A share began while it was being made: to the Dock as well.
  if (sharing && w.id !== undefined && w.state !== 'minimized') await api.windows.update?.(w.id, { state: 'minimized' }).catch(() => undefined)
  return { id: w.id, first }
}

/**
 * Give the window up: it is the person's now (header). Their tabs stay as they are; Walnut's page
 * there closes; the agents' tabs move to a new agent window. The window's front tab is never
 * touched, whether or not the person is in Chrome now (closing or moving it would change what
 * their window shows): an agent's tab there stays, theirs to close; Walnut's page there stays.
 */
export async function releaseAgentWindow(api: OwnApi, windowId: number): Promise<{ moved: number[]; closed: number[] }> {
  const { agentWindow } = await api.storage.session.get('agentWindow')
  if (agentWindow !== windowId) return { moved: [], closed: [] }
  const own = await agentsOwn(api)
  await api.storage.session.remove(['agentWindow', 'agentPage'])
  const tabs = await tabsIn(api, windowId)
  const closed: number[] = []
  const agents: OwnTab[] = []
  for (const t of tabs) {
    if (t.id === undefined || t.active) continue
    const url = t.url || t.pendingUrl || ''
    if (t.id === own.page || (own.pageUrl && url.startsWith(own.pageUrl))) closed.push(t.id)
    else if (own.ids.has(t.id)) agents.push(t)
  }
  for (const id of closed) await api.tabs.remove(id).catch(() => undefined)
  if (!agents.length || !api.tabs.move) return { moved: [], closed }
  const made = await makeAgentWindow(api)
  if (made.id === undefined) return { moved: [], closed }
  // A task's whole group goes as one (it keeps its name and fold); any other tab on its own, so
  // one that closed meanwhile never holds the others back.
  const moved: number[] = []
  const ids = new Set(agents.map((t) => t.id!))
  const groups = new Set(agents.map((t) => t.groupId).filter((g): g is number => typeof g === 'number' && g >= 0))
  for (const g of groups) {
    const members = tabs.filter((t) => t.groupId === g)
    if (!api.tabGroups?.move || !members.every((t) => t.id !== undefined && ids.has(t.id))) continue
    if (await api.tabGroups.move(g, { windowId: made.id, index: -1 }).then(() => true, () => false)) for (const t of members) { moved.push(t.id!); ids.delete(t.id!) }
  }
  for (const id of ids) if (await api.tabs.move(id, { windowId: made.id, index: -1 }).then(() => true, () => false)) moved.push(id)
  return { moved, closed }
}

export function _resetOwnForTesting(): void { releasing = Promise.resolve(); making.clear(); once.clear() }
