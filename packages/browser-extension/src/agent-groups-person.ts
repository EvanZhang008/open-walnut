/**
 * A tab the agent holds in a window of the person's sits in its task's group there, and goes back
 * where it was when the agent lets it go (2026-11-09, the user, on a tab he handed over with Act in
 * tab: "why is it not in a chrome group tab called Walnut-taskname").
 *
 *   - One group per task per window, named as the agent window's (`walnut-<task name>`), made the
 *     first time a tab of the task is held there. The agent window keeps its own rules
 *     (agent-groups.ts); these groups are never folded: the person's window is theirs to fold.
 *   - Before the tab joins, where it was is kept: its index, its group (id, and the group's title
 *     and colour, since a group whose only tab it was is gone once the tab leaves it).
 *   - When the agent lets it go (Done, Stop, the side panel's release, the task's tidy-up, agents
 *     turned off: every release deletes the tab's holding, agent-shared.ts letGo), it leaves the
 *     task's group and goes back: into its old group if that still exists in the window, a group
 *     made again with the old title and colour if it was that group's only tab, else ungrouped;
 *     and back to its old index while the window still has one. A tab the person moved out of the
 *     task's group meanwhile stays where they put it.
 *   - Nothing here changes the active tab, the focused window or a group's folding: tabs.group,
 *     ungroup and move do none of those. A pinned tab is never grouped (Chrome would unpin it).
 */
import { GROUP_COLOR, groupTitle, inGroupChain, type GroupApi } from './agent-groups'

const GROUPS = 'agentPersonGroups'
const BEFORE = 'agentGroupBefore'

/** Where a held tab was before it joined its task's group. */
export interface Before { windowId: number; index: number; groupId: number; title?: string; color?: string; alone?: boolean; ours: number }

const read = async <T>(api: GroupApi, key: string): Promise<Record<string, T>> => ((await api.storage.session.get(key))[key] ?? {}) as Record<string, T>
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
    const groups = await read<number>(api, GROUPS)
    const key = groupKey(owner, tab.windowId)
    let gid: number | undefined = groups[key]
    if (gid !== undefined) {
      const g = await api.tabGroups.get(gid).catch(() => null)
      if (!g || g.windowId !== tab.windowId) gid = undefined
    }
    if (gid !== undefined && tab.groupId === gid) return
    const befores = await read<Before>(api, BEFORE)
    // The person's own place, kept from the first grouping of this holding (a tab handed on to
    // another conversation moves to that task's group and still goes back to where it was at first).
    let before = befores[String(tabId)]
    if (!before) {
      const old = typeof tab.groupId === 'number' && tab.groupId >= 0 ? tab.groupId : -1
      const g = old >= 0 ? await api.tabGroups.get(old).catch(() => null) : null
      const mates = old >= 0 && api.tabs.query ? (await api.tabs.query({ windowId: tab.windowId }).catch(() => [])).filter((t) => t.groupId === old).length : 0
      before = { windowId: tab.windowId, index: typeof tab.index === 'number' ? tab.index : -1, groupId: old, ...(g?.title ? { title: g.title } : {}), ...(g?.color ? { color: g.color } : {}), ...(old >= 0 && mates <= 1 ? { alone: true } : {}), ours: -1 }
    }
    const made = gid === undefined
    gid = await api.tabs.group(made ? { tabIds: [tabId], createProperties: { windowId: tab.windowId } } : { tabIds: [tabId], groupId: gid })
    // Where it was is kept as soon as it moved, so a failure after this still lets it go back.
    await api.storage.session.set({ [GROUPS]: { ...groups, [key]: gid }, [BEFORE]: { ...befores, [String(tabId)]: { ...before, ours: gid } } })
    // Named once; never folded here (the person's window).
    if (made) await api.tabGroups.update(gid, { title: groupTitle(who), color: GROUP_COLOR }).catch(() => undefined)
    // Let go while it was grouped: back at once.
    if (!(await held())) await restoreNow(api, tabId, false)
  }, undefined)
}

/** The agent let the tab go: out of its task's group, and back where it was. */
export function restorePersonTab(api: GroupApi, tabId: number, retry = true): Promise<void> {
  return inGroupChain(() => restoreNow(api, tabId, retry), undefined)
}

async function restoreNow(api: GroupApi, tabId: number, retry: boolean): Promise<void> {
  const befores = await read<Before>(api, BEFORE)
  const b = befores[String(tabId)]
  if (!b) return
  const forget = async () => {
    const now = await read<Before>(api, BEFORE)
    delete now[String(tabId)]
    await api.storage.session.set({ [BEFORE]: now })
  }
  const tab = await api.tabs.get(tabId).catch(() => null)
  // Closed, or the person moved it out of the task's group: it stays where they put it.
  if (!tab || tab.groupId !== b.ours) { await forget(); return }
  try {
    await api.tabs.ungroup?.(tabId)
  } catch {
    // Refused for now (the person drags a tab): kept, and tried once more.
    if (retry) setTimeout(() => { void restorePersonTab(api, tabId, false) }, RESTORE_RETRY_MS)
    else await forget()
    return
  }
  await forget()
  // Moved to another window with the group: only out of the group.
  if (tab.windowId !== b.windowId) return
  if (b.index >= 0 && api.tabs.move && api.tabs.query) {
    const count = (await api.tabs.query({ windowId: b.windowId }).catch(() => [])).length
    if (b.index < count) await api.tabs.move(tabId, { index: b.index }).catch(() => undefined)
  }
  if (b.groupId < 0 || !api.tabs.group || !api.tabGroups) {
    // It had no group: one it landed inside by its move is not its own.
    const now = await api.tabs.get(tabId).catch(() => null)
    if (typeof now?.groupId === 'number' && now.groupId >= 0) await api.tabs.ungroup?.(tabId).catch(() => undefined)
    return
  }
  const g = await api.tabGroups.get(b.groupId).catch(() => null)
  if (g && g.windowId === b.windowId) { await api.tabs.group({ tabIds: [tabId], groupId: b.groupId }); return }
  // Its old group went when it left (it was its only tab): made again as it was.
  if (!b.alone) return
  const again = await api.tabs.group({ tabIds: [tabId], createProperties: { windowId: b.windowId } })
  await api.tabGroups.update(again, { ...(b.title ? { title: b.title } : {}), ...(b.color ? { color: b.color } : {}) })
}
