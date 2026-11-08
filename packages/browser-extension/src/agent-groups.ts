/**
 * Each task's own tabs in Walnut's agent window sit in one Chrome tab group named after the task,
 * `walnut-<task name>` (2026-11-08, the user: "in the chrome it should show walnut-xxx-task-name in
 * a chrome group"), so the person sees at a glance which task works in which tabs. Only tabs an
 * agent opened in the agent window: a tab of the person's (handed over or taken) is never moved or
 * grouped. A browser without tab groups (Firefox before 139, or the permission not granted) groups
 * nothing and everything else works as before.
 */
import type { Tab } from './ext'

/** The calls grouping needs, loosely typed (Chrome's tabs.group and tabGroups). */
export interface GroupApi {
  tabs: {
    get(tabId: number): Promise<Tab & { groupId?: number }>
    group?(o: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }): Promise<number>
  }
  tabGroups?: {
    get(groupId: number): Promise<{ id: number; title?: string; windowId: number }>
    update(groupId: number, o: { title?: string; color?: string; collapsed?: boolean }): Promise<unknown>
  }
  storage: { session: { get(k: string): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void> } }
}

/** A group's title stays short enough to read on its chip. */
export const GROUP_TITLE_MAX = 32
/** Chrome's group colours are a fixed few: orange is the nearest to the agent frame's brown. */
export const GROUP_COLOR = 'orange'

/** `walnut-<task name>`: words joined by dashes, Latin letters lower case, cut to GROUP_TITLE_MAX at a word's end. */
export function groupTitle(who: string | undefined): string {
  const name = (who ?? '').normalize('NFC').trim().toLowerCase()
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s_/\\|:;,.]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '')
  const chars = [...`walnut-${name || 'agent'}`]
  if (chars.length <= GROUP_TITLE_MAX) return chars.join('')
  let cut = chars.slice(0, GROUP_TITLE_MAX).join('')
  // Cut at a word's end when that keeps most of the name, never inside a word.
  const dash = cut.lastIndexOf('-')
  if (chars[GROUP_TITLE_MAX] !== '-' && dash >= 'walnut-'.length + 8) cut = cut.slice(0, dash)
  return cut.replace(/-$/, '')
}

const KEY = 'agentGroups'
/** One grouping at a time, so two opens of one task at once make one group, not two. */
let chain: Promise<unknown> = Promise.resolve()

/**
 * Put an agent's tab into its task's group in the agent window, made (and named) the first time.
 * Best effort: a refusal leaves the tab where it is.
 */
export function groupAgentTab(api: GroupApi, tabId: number, owner: string, who: string | undefined, agentWindow: number | undefined): Promise<void> {
  const run = chain.then(async () => {
    if (!api.tabs.group || !api.tabGroups || agentWindow === undefined) return
    const tab = await api.tabs.get(tabId).catch(() => null)
    if (!tab || tab.windowId !== agentWindow) return
    const groups = ((await api.storage.session.get(KEY))[KEY] ?? {}) as Record<string, number>
    const title = groupTitle(who)
    let gid: number | undefined = groups[owner]
    if (gid !== undefined) {
      const g = await api.tabGroups.get(gid).catch(() => null)
      if (!g || g.windowId !== agentWindow) gid = undefined
    }
    if (gid !== undefined && tab.groupId === gid) return
    gid = await api.tabs.group(gid !== undefined ? { tabIds: [tabId], groupId: gid } : { tabIds: [tabId], createProperties: { windowId: agentWindow } })
    await api.tabGroups.update(gid, { title, color: GROUP_COLOR, collapsed: false })
    await api.storage.session.set({ [KEY]: { ...groups, [owner]: gid } })
  }).catch(() => undefined)
  chain = run
  return run
}
