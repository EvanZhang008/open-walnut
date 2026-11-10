/**
 * A tab the person handed over (Act in tab) sits in its task's group of their window while the
 * agent holds it, and goes back where it was when the agent lets it go (2026-11-09, the user, on a
 * tab he handed over with Act in tab: "why is it not in a chrome group tab called Walnut-taskname").
 *
 *   - One group per task per window, named as the agent window's (`walnut-<task name>`), made the
 *     first time a tab of the task is held there. The agent window keeps its own rules
 *     (agent-groups.ts); these groups are never folded: the person's window is theirs to fold.
 *   - Before the tab joins, where it was is kept: its index, its group (id, and the group's title,
 *     colour and folding, since a group whose only tab it was is gone once the tab leaves it), and
 *     the task's group it joined (id and title).
 *   - When the agent lets it go (Done, Stop, the side panel's release, the task's tidy-up, agents
 *     turned off: every release deletes the tab's holding, agent-shared.ts letGo), it leaves the
 *     task's group and goes back: into its old group if that still exists in the window, a group
 *     made again with the old title and colour if it was that group's only tab, else ungrouped;
 *     and back to its old index while the window still has one. A tab the person moved out of the
 *     task's group meanwhile stays where they put it.
 *   - The places are kept in storage.local (review 2026-11-09): Chrome clears storage.session on
 *     an extension reload (self-update.ts reloads for every new build) and a browser restart, while
 *     it keeps (and restores) the tab groups. A reload's holdings come back while they still name
 *     the same tab (agent-keep.ts, before this runs); a restart's never do. On every start of the
 *     background (restoreLeftPersonTabs) a kept place whose holding is gone is put back: the same
 *     tab still in our group (a reload), or, after a restart, which gives tabs and groups new ids,
 *     a tab in a restored group of ours, found by the title and colour we gave it. Never a group
 *     we did not make, never in the agent window.
 *   - Nothing here changes the active tab, the focused window, or a group's folding when it holds
 *     the window's front tab: tabs.group, ungroup and move do none of those. A pinned tab is never
 *     grouped (Chrome would unpin it).
 */
import { AGENT_PAGE, GROUP_COLOR, groupTitle, inGroupChain, type GroupApi } from './agent-groups'

const GROUPS = 'agentPersonGroups'
export const BEFORE = 'agentGroupBefore'

/** Where a held tab was before it joined its task's group, and the group it joined (`ours`, `oursTitle`). */
export interface Before {
  windowId: number; index: number; groupId: number; title?: string; color?: string; collapsed?: boolean; alone?: boolean
  ours: number; oursTitle?: string; url?: string
}

/** The places are kept across a reload and a restart (storage.local); a browser without it keeps them for the session. */
const placeStore = (api: GroupApi) => api.storage.local ?? api.storage.session
const readPlaces = async (api: GroupApi): Promise<Record<string, Before>> => ((await placeStore(api).get(BEFORE))[BEFORE] ?? {}) as Record<string, Before>
const writePlaces = (api: GroupApi, v: Record<string, Before>) => placeStore(api).set({ [BEFORE]: v })
const readGroups = async (api: GroupApi): Promise<Record<string, number>> => ((await api.storage.session.get(GROUPS))[GROUPS] ?? {}) as Record<string, number>
const groupKey = (owner: string, windowId: number) => `${owner}\u0000${windowId}`

/** Waited before a refused restore is tried once more (Chrome refuses tab edits while the person drags a tab). */
export const RESTORE_RETRY_MS = 500

/**
 * The tab joins its task's group of its own window (made, and named, the first time). `held` says
 * whether the holding that asked is still on: a release that came while this waited its turn (the
 * page's frame is drawn first, which may take seconds) leaves the tab where it is.
 */
export function groupPersonTab(api: GroupApi, tabId: number, owner: string, who: string | undefined, held: () => Promise<boolean> = async () => true): Promise<void> {
  return inGroupChain(async () => {
    if (!api.tabs.group || !api.tabGroups || !(await held())) return
    const tab = await api.tabs.get(tabId).catch(() => null)
    // A pinned tab stays pinned: Chrome would unpin it to group it.
    if (!tab || tab.windowId === undefined || tab.pinned) return
    // The agent window has its own groups (agent-groups.ts groupAgentTab).
    if (tab.windowId === (await api.storage.session.get('agentWindow')).agentWindow) return
    const groups = await readGroups(api)
    const key = groupKey(owner, tab.windowId)
    const title = groupTitle(who)
    let gid: number | undefined = groups[key]
    if (gid !== undefined) {
      const g = await api.tabGroups.get(gid).catch(() => null)
      if (!g || g.windowId !== tab.windowId) gid = undefined
    }
    if (gid !== undefined && tab.groupId === gid) return
    const befores = await readPlaces(api)
    // The person's own place, kept from the first grouping of this holding (a tab handed on to
    // another conversation moves to that task's group and still goes back to where it was at first).
    let before = befores[String(tabId)]
    if (!before) {
      const old = typeof tab.groupId === 'number' && tab.groupId >= 0 ? tab.groupId : -1
      const g = old >= 0 ? await api.tabGroups.get(old).catch(() => null) : null
      const mates = old >= 0 && api.tabs.query ? (await api.tabs.query({ windowId: tab.windowId }).catch(() => [])).filter((t) => t.groupId === old).length : 0
      before = {
        windowId: tab.windowId, index: typeof tab.index === 'number' ? tab.index : -1, groupId: old,
        ...(g?.title ? { title: g.title } : {}), ...(g?.color ? { color: g.color } : {}), ...(g?.collapsed ? { collapsed: true } : {}),
        ...(old >= 0 && mates <= 1 ? { alone: true } : {}), ours: -1,
      }
    }
    const made = gid === undefined
    gid = await api.tabs.group(made ? { tabIds: [tabId], createProperties: { windowId: tab.windowId } } : { tabIds: [tabId], groupId: gid })
    // Where it was is kept as soon as it moved, so a failure after this still lets it go back.
    await api.storage.session.set({ [GROUPS]: { ...groups, [key]: gid } })
    await writePlaces(api, { ...(await readPlaces(api)), [String(tabId)]: { ...before, ours: gid, oursTitle: title, ...(tab.url ? { url: tab.url } : {}) } })
    // Named once; never folded here (the person's window).
    if (made) await api.tabGroups.update(gid, { title, color: GROUP_COLOR }).catch(() => undefined)
    // Let go while it was grouped: back at once.
    if (!(await held())) await restoreNow(api, tabId, false)
  }, undefined)
}

/** The agent let the tab go: out of its task's group, and back where it was. */
export function restorePersonTab(api: GroupApi, tabId: number, retry = true): Promise<void> {
  return inGroupChain(() => restoreNow(api, tabId, retry), undefined)
}

const forgetPlace = async (api: GroupApi, tabId: number) => {
  const now = await readPlaces(api)
  if (!(String(tabId) in now)) return
  delete now[String(tabId)]
  await writePlaces(api, now)
}

async function restoreNow(api: GroupApi, tabId: number, retry: boolean): Promise<void> {
  const b = (await readPlaces(api))[String(tabId)]
  if (!b) return
  const tab = await api.tabs.get(tabId).catch(() => null)
  // Closed, or the person moved it out of the task's group: it stays where they put it.
  if (!tab || tab.groupId !== b.ours) { await forgetPlace(api, tabId); return }
  try {
    await api.tabs.ungroup?.(tabId)
  } catch {
    // Refused for now (the person drags a tab): kept, and tried once more.
    if (retry) setTimeout(() => { void restorePersonTab(api, tabId, false) }, RESTORE_RETRY_MS)
    else await forgetPlace(api, tabId)
    return
  }
  await forgetPlace(api, tabId)
  // Moved to another window with the group: only out of the group.
  if (tab.windowId !== b.windowId) return
  await putBack(api, tabId, b, b.windowId, false)
}

/**
 * The tab, out of our group now, back at its old index and into its old group (that group, still
 * there in the window, else one of its title, else made again when the tab was its only tab).
 * `renumbered`: after a browser restart every id is new, so the old group is found by its title.
 */
async function putBack(api: GroupApi, tabId: number, b: Before, windowId: number, renumbered: boolean): Promise<void> {
  if (b.index >= 0 && api.tabs.move && api.tabs.query) {
    const count = (await api.tabs.query({ windowId }).catch(() => [])).length
    if (b.index < count) await api.tabs.move(tabId, { index: b.index }).catch(() => undefined)
  }
  if (b.groupId < 0 || !api.tabs.group || !api.tabGroups) {
    // It had no group: one it landed inside by its move is not its own.
    const now = await api.tabs.get(tabId).catch(() => null)
    if (typeof now?.groupId === 'number' && now.groupId >= 0) await api.tabs.ungroup?.(tabId).catch(() => undefined)
    return
  }
  const sameGroup = (g: { title?: string; color?: string; windowId: number } | null) => !!g && g.windowId === windowId && (!b.title || g.title === b.title) && (!b.color || !g.color || g.color === b.color)
  if (!renumbered) {
    const g = await api.tabGroups.get(b.groupId).catch(() => null)
    if (g && g.windowId === windowId) { await api.tabs.group({ tabIds: [tabId], groupId: b.groupId }); return }
  } else if (b.title && api.tabs.query) {
    for (const gid of new Set((await api.tabs.query({ windowId }).catch(() => [])).map((t) => t.groupId).filter((x): x is number => typeof x === 'number' && x >= 0))) {
      if (sameGroup(await api.tabGroups.get(gid).catch(() => null))) { await api.tabs.group({ tabIds: [tabId], groupId: gid }); return }
    }
  }
  // Its old group went when it left (it was its only tab): made again as it was.
  if (!b.alone) return
  const again = await api.tabs.group({ tabIds: [tabId], createProperties: { windowId } })
  // Folded again only when the tab is not the window's front one (Chrome would switch tabs to fold it).
  const front = (await api.tabs.get(tabId).catch(() => null))?.active === true
  await api.tabGroups.update(again, { ...(b.title ? { title: b.title } : {}), ...(b.color ? { color: b.color } : {}), ...(b.collapsed && !front ? { collapsed: true } : {}) })
}

/** One of the groups we made in a person's window: its title is the one we gave it, in our colour. */
const ourGroup = (g: { title?: string; color?: string } | null, title: string | undefined) => !!g && !!title && g.title === title && (g.color === undefined || g.color === GROUP_COLOR)

/**
 * The background started (a wake, a browser start, an install or update, a reload): every kept
 * place whose holding is gone is put back. `held` says whether a tab is held now. A tab still in
 * our group by its id (an extension reload kept the ids) goes back as a release would; places whose
 * tab id is gone (a browser restart renumbers tabs and groups) are matched to tabs in restored
 * groups of ours by title and colour, in the person's windows only, and put back by title.
 */
export function restoreLeftPersonTabs(api: GroupApi, held: (tabId: number) => Promise<boolean>): Promise<void> {
  return inGroupChain(async () => {
    const places = await readPlaces(api)
    const ids = Object.keys(places)
    if (!ids.length || !api.tabGroups) return
    const lost: Before[] = []
    for (const id of ids) {
      const tabId = Number(id)
      const b = places[id]
      if (await held(tabId)) continue
      const tab = await api.tabs.get(tabId).catch(() => null)
      const g = tab && typeof tab.groupId === 'number' && tab.groupId >= 0 ? await api.tabGroups.get(tab.groupId).catch(() => null) : null
      if (tab && tab.groupId === b.ours && (!b.oursTitle || ourGroup(g, b.oursTitle))) {
        // A reload: the same tab, still in our group.
        await api.tabs.ungroup?.(tabId).catch(() => undefined)
        await forgetPlace(api, tabId)
        if (tab.windowId === b.windowId) await putBack(api, tabId, b, b.windowId, false).catch(() => undefined)
        continue
      }
      await forgetPlace(api, tabId)
      // Not in our group by that id: the person moved it, or a restart renumbered every tab (the
      // id may even name another tab now). A tab left in a group of ours is found by its title.
      if (b.oursTitle) lost.push(b)
    }
    if (!lost.length || !api.tabs.query) return
    const agentWindows = await agentWindowsNow(api)
    const all = (await api.tabs.query({}).catch(() => [])).filter((t) => t.id !== undefined && t.windowId !== undefined && !agentWindows.has(t.windowId))
    const titleOf = new Map<number, { title?: string; color?: string } | null>()
    const groupOf = async (gid: number) => { if (!titleOf.has(gid)) titleOf.set(gid, await api.tabGroups!.get(gid).catch(() => null)); return titleOf.get(gid)! }
    const used = new Set<number>()
    const windows = new Set(all.map((t) => t.windowId!))
    /** The windows a place of ours was found in (or still is, by its id): the only ones swept below. */
    const swept = new Set<number>()
    for (const b of lost) {
      // Its own window when that still exists (a reload keeps the ids), else any of the person's (a restart).
      const inWindow = windows.has(b.windowId) ? b.windowId : undefined
      if (inWindow !== undefined) swept.add(inWindow)
      const candidates: typeof all = []
      for (const t of all) {
        if (used.has(t.id!) || typeof t.groupId !== 'number' || t.groupId < 0) continue
        if (inWindow !== undefined && t.windowId !== inWindow) continue
        // Every tab of the agent window is muted (agent-window.ts): one that is, is never taken for the person's.
        if (t.mutedInfo?.muted === true) continue
        if (ourGroup(await groupOf(t.groupId), b.oursTitle) && !(await held(t.id!))) candidates.push(t)
      }
      const t = candidates.find((x) => b.url && x.url === b.url) ?? candidates[0]
      if (!t) continue
      used.add(t.id!)
      swept.add(t.windowId!)
      await api.tabs.ungroup?.(t.id!).catch(() => undefined)
      await putBack(api, t.id!, b, t.windowId!, t.windowId !== b.windowId).catch(() => undefined)
    }
    // Any other tab still left in a restored group of ours (a place that was not kept), in a window
    // where a place of ours was: out of it. Never a muted tab (the agent window's).
    const titles = new Set(lost.map((b) => b.oursTitle))
    for (const t of all) {
      if (used.has(t.id!) || !swept.has(t.windowId!) || t.mutedInfo?.muted === true || typeof t.groupId !== 'number' || t.groupId < 0) continue
      const g = await groupOf(t.groupId)
      if (g && [...titles].some((title) => ourGroup(g, title)) && !(await held(t.id!))) await api.tabs.ungroup?.(t.id!).catch(() => undefined)
    }
  }, undefined)
}

/** Walnut's agent window, by its id this session and by its own page (a restored one after a restart). */
async function agentWindowsNow(api: GroupApi): Promise<Set<number>> {
  const out = new Set<number>()
  const id = (await api.storage.session.get('agentWindow')).agentWindow
  if (typeof id === 'number') out.add(id)
  const page = api.runtime?.getURL(AGENT_PAGE)
  if (page && api.tabs.query) for (const t of await api.tabs.query({}).catch(() => [])) if (t.url?.startsWith(page) && t.windowId !== undefined) out.add(t.windowId)
  return out
}
