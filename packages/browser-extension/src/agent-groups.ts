/**
 * Each task's own tabs in Walnut's agent window sit in one Chrome tab group named after the task,
 * `walnut-<task name>` (2026-11-08, the user: "in the chrome it should show walnut-xxx-task-name in
 * a chrome group"), so the person sees at a glance which task works in which tabs. Only tabs an
 * agent opened in the agent window. A tab the agent holds in a window of the person's (one they
 * handed over with Act in tab, or one it took) joins that task's group of that window while the
 * agent holds it, and goes back where it was after (agent-groups-person.ts). A browser without tab
 * groups (Firefox before 139, or the permission not granted) groups nothing and everything else
 * works as before.
 */
import type { Tab } from './ext'

/** The calls grouping needs, loosely typed (Chrome's tabs.group and tabGroups). */
export interface GroupApi {
  tabs: {
    get(tabId: number): Promise<Tab & { groupId?: number; index?: number; pinned?: boolean }>
    group?(o: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }): Promise<number>
    ungroup?(tabIds: number | number[]): Promise<void>
    query?(o: { active?: boolean; windowId?: number }): Promise<Array<Tab & { groupId?: number; index?: number }>>
    move?(tabId: number, o: { index: number }): Promise<unknown>
    update?(tabId: number, o: { active?: boolean; url?: string }): Promise<unknown>
    create?(o: { url: string; windowId?: number; active?: boolean; index?: number }): Promise<Tab>
  }
  tabGroups?: {
    get(groupId: number): Promise<{ id: number; title?: string; color?: string; windowId: number; collapsed?: boolean }>
    update(groupId: number, o: { title?: string; color?: string; collapsed?: boolean }): Promise<unknown>
  }
  runtime?: { getURL(path: string): string }
  windows?: { get(windowId: number): Promise<{ focused?: boolean }> }
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

/** Run `work` in the one line of group changes (agent-groups-person.ts uses it too); a failure is its own. */
export function inGroupChain<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  const run = chain.then(work).catch(() => fallback)
  chain = run
  return run
}

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
    const made = gid === undefined
    gid = await api.tabs.group(!made ? { tabIds: [tabId], groupId: gid } : { tabIds: [tabId], createProperties: { windowId: agentWindow } })
    // Named once; its folding is foldIdleGroup's (a tab joining never opens the group again).
    if (made) await api.tabGroups.update(gid, { title, color: GROUP_COLOR })
    await api.storage.session.set({ [KEY]: { ...groups, [owner]: gid } })
  }).catch(() => undefined)
  chain = run
  return run
}

// ── folding ──

/**
 * A task's group folds to its one chip once no agent used its tabs for FOLD_IDLE_MS (2026-11-08,
 * the user: the group should be "collapsed so it takes no room", and stay so while the agent
 * works). Chrome opens a folded group by itself when one of its tabs comes in front (a screenshot,
 * a picture for the Browser view), and the next quiet spell folds it again. A folded group may not
 * hold the window's front tab (Chrome would open a New Tab for it), so the agent window's own page
 * (agent-window.html, AGENT_PAGE) comes in front first.
 */
export const FOLD_IDLE_MS = 8000
export const AGENT_PAGE = 'agent-window.html'
const usedAt = new Map<string, number>()
const foldTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Whether a command of the owner's runs now (agent.ts says): a group never folds under one. */
let busyOwner: (owner: string) => boolean = () => false
export function setGroupBusy(fn: (owner: string) => boolean): void { busyOwner = fn }

/** An agent used the owner's tabs just now: its group folds FOLD_IDLE_MS after the last use. */
export function noteGroupUse(api: GroupApi, owner: string): void {
  usedAt.set(owner, Date.now())
  clearTimeout(foldTimers.get(owner))
  const t = setTimeout(() => { foldTimers.delete(owner); void foldIdleGroup(api, owner) }, FOLD_IDLE_MS)
  foldTimers.set(owner, t)
}

/** The agent window's own tab, made when missing (never grouped, never an agent's). */
export async function agentPageTab(api: GroupApi, windowId: number): Promise<number | undefined> {
  const { agentPage } = await api.storage.session.get('agentPage')
  if (typeof agentPage === 'number') {
    const t = await api.tabs.get(agentPage).catch(() => null)
    if (t && t.windowId === windowId) return agentPage
  }
  if (!api.tabs.create || !api.runtime) return undefined
  const t = await api.tabs.create({ url: api.runtime.getURL(AGENT_PAGE), windowId, active: false, index: 0 }).catch(() => null)
  if (t?.id === undefined) return undefined
  await api.storage.session.set({ agentPage: t.id })
  return t.id
}

/** Fold the owner's group when it is quiet: true when it folded now. */
export function foldIdleGroup(api: GroupApi, owner: string, now = Date.now()): Promise<boolean> {
  const run = chain.then(async () => {
    if (!api.tabGroups || !api.tabs.query || !api.tabs.update) return false
    if (now - (usedAt.get(owner) ?? 0) < FOLD_IDLE_MS || busyOwner(owner)) {
      // Still in use: try again after another quiet spell.
      if (busyOwner(owner)) noteGroupUse(api, owner)
      return false
    }
    const gid = (((await api.storage.session.get(KEY))[KEY] ?? {}) as Record<string, number>)[owner]
    if (gid === undefined) return false
    const g = await api.tabGroups.get(gid).catch(() => null)
    if (!g || g.collapsed) return false
    // Only in the agent window: a group the person dragged into a window of theirs is theirs to fold.
    if (g.windowId !== (await api.storage.session.get('agentWindow')).agentWindow) return false
    const [front] = await api.tabs.query({ active: true, windowId: g.windowId })
    // The person is in the agent window, or has its front tab (Take over): their view is never switched.
    const looking = (await api.windows?.get(g.windowId).catch(() => null))?.focused === true
    const tabs = ((await api.storage.session.get('agentTabs')).agentTabs ?? {}) as Record<string, { driving?: number }>
    if (looking || (front?.id !== undefined && typeof tabs[String(front.id)]?.driving === 'number')) {
      noteGroupUse(api, owner)
      return false
    }
    if (front?.groupId === gid) {
      const page = await agentPageTab(api, g.windowId)
      if (page === undefined) return false
      await api.tabs.update(page, { active: true })
    }
    await api.tabGroups.update(gid, { collapsed: true })
    return true
  }).catch(() => false)
  chain = run
  return run
}

/** Out of its group before it closes: Chrome keeps a closed group as a saved one, so none is left behind. */
export async function ungroupBeforeClose(api: GroupApi, tabId: number): Promise<void> {
  const t = await api.tabs.get(tabId).catch(() => null)
  if (t && typeof t.groupId === 'number' && t.groupId >= 0) await api.tabs.ungroup?.(tabId).catch(() => undefined)
}

export function _resetGroupsForTesting(): void {
  for (const t of foldTimers.values()) clearTimeout(t)
  foldTimers.clear()
  usedAt.clear()
}
