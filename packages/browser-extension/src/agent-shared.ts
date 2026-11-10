/**
 * What the agent modules share (agent.ts runs the commands; agent-page.ts, agent-shot.ts,
 * agent-downloads.ts and agent-trusted.ts do their parts): the agent tabs and who holds each,
 * the checks every page goes through, and reaching a frame's script.
 */
import { groupAgentTab, noteGroupUse, type GroupApi } from './agent-groups'
import { groupPersonTab, restorePersonTab } from './agent-groups-person'
import { ext, type Tab } from './ext'
import { siteKey } from '../../../src/core/vault/url-match'
import { tabStore } from './tab-store'
import { walnutAddress } from './walnut-address'
import { injectContent, pageCheck, reachPage, toPage, type ReachError } from './page-reach'
import { windowOf } from './agent-window'
import { more } from './agent-api'
import { endLinger } from './cdp'

export interface WireCommand { id: string; action: string; args: Record<string, unknown>; allow: { any: boolean; sites: string[]; walnut?: string[] } }

export class AgentError extends Error {
  constructor(message: string, readonly code: string, readonly extra: Record<string, unknown> = {}) { super(message) }
}

/**
 * The agent tabs and who opened each (a task's owner key) and its name for the frame. `handed`:
 * the person handed this tab over from the side panel, and its site (allowed in this tab alone).
 * `taken`: the person's own tab an agent took (`take`). `popup`: a tab an agent tab opened;
 * `fromPerson`: opened from one of the person's tabs (its page can reach theirs through `opener`).
 * `viaHanded`: opened from a tab the person handed over (agent-tab-kind.ts), which agents may use as that tab.
 */
export interface AgentTab {
  owner: string; who?: string; history?: string[]; handed?: string; taken?: boolean; popup?: boolean; fromPerson?: boolean; viaHanded?: boolean; grant?: string
  /** The person took the tab over from the Browser view (agent-takeover.ts): since when; agents wait. */
  driving?: number
  /** The holding (its grant) whose hand-over put this tab into its task's group of the person's window: once per holding. */
  grouped?: string
}
const rawAgentTabs = tabStore<AgentTab>('agentTabs')
/** One holding of a tab, named: every new hold of it gets its own, so work started for one holding can tell when it ended. */
export const newGrant = (): string => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
/**
 * `grant` names the holding (review 2026-11-07): a set is always a new holding (a fresh grant
 * unless the caller made one for it); `update` keeps the holding; `setIf` / `deleteIf` act only
 * on the holding they name, so a pending open, a late Stop or a frame never acts on the next one.
 */
export const agentTabs = {
  ...rawAgentTabs,
  set: (tabId: number, v: AgentTab) => rawAgentTabs.set(tabId, { ...v, grant: v.grant ?? newGrant() }),
  /** Every release ends a holding by deleting it: the tab is let go as it is (letGo). */
  delete: async (tabId: number) => { await rawAgentTabs.delete(tabId); await letGo(tabId) },
  deleteIf: async (tabId: number, ok: (cur: AgentTab) => boolean) => {
    const done = await rawAgentTabs.deleteIf(tabId, ok)
    if (done) await letGo(tabId)
    return done
  },
}

/**
 * The agent no longer holds the tab (Stop on the page or in the Browser view, the side panel's
 * release and Stop all, Done (the task's tidy-up), close, agents turned off, the tab closed): the
 * agent's cursor leaves every frame of it (page-cursor.ts), and a tab of the person's window leaves
 * its task's group for where it was (agent-groups-person.ts). The cursor's message is not waited
 * for: a page that does not answer never holds a release up.
 */
async function letGo(tabId: number): Promise<void> {
  void Promise.resolve().then(() => ext.tabs.sendMessage(tabId, { type: 'agent-cursor', off: true })).catch(() => undefined)
  // The agent is done with the tab: its steps' lingering debugger hold goes now (cdp.ts linger).
  void endLinger(more.debugger, tabId).catch(() => undefined)
  await restorePersonTab(ext as unknown as GroupApi, tabId).catch(() => undefined)
}

/**
 * Agents switched off this many times: work that started before a switch-off does not hand a tab
 * to an agent after it.
 */
let offCount = 0
export const agentsOffCount = () => offCount
export const noteAgentsOff = () => { offCount++ }

/** The person's own tab (handed or taken): given back on close, never closed, never moved. */
export const personsTab = (rec: AgentTab | undefined) => !!(rec?.handed || rec?.taken)
/** The person's tab, or one it opened: never the page's own JavaScript (evaluate) there. */
export const nearPerson = (rec: AgentTab | undefined) => personsTab(rec) || !!rec?.fromPerson

/** The agent window, where an agent's own tabs open. */
export async function agentWindowId(): Promise<number | undefined> {
  const { agentWindow } = await ext.storage.session.get('agentWindow')
  return typeof agentWindow === 'number' ? agentWindow : undefined
}

/**
 * The sites (origins) an owner signed in on with fill_login: no page JavaScript (evaluate) runs
 * there for that owner, since it could read the password Walnut just put in. Memory only, as
 * the agent tabs are.
 */
const filled = tabStore<string[]>('agentFilled')
const ownerKey = (owner: string) => [...owner].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
export const originOf = (u: string | undefined) => { try { return new URL(u ?? '').origin } catch { return '' } }
export async function noteFilled(owner: string, url: string): Promise<void> {
  const o = originOf(url)
  if (!o) return
  const k = ownerKey(owner)
  const had = (await filled.get(k)) ?? []
  if (!had.includes(o)) await filled.set(k, [...had, o].slice(-50))
}
/** Every site an owner signed in on with fill_login (origins). */
export async function filledOrigins(owner: string): Promise<string[]> {
  return (await filled.get(ownerKey(owner))) ?? []
}
export async function filledHere(owner: string, url: string): Promise<boolean> {
  return ((await filled.get(ownerKey(owner))) ?? []).includes(originOf(url))
}

/**
 * Tabs whose document an agent's own script (evaluate) or real input (the debugger) touched: the
 * document's id then (content.ts DOC_ID). fill_login refuses such a page until it loads again
 * (a navigation or a reload is a new document, so a new id), since a script left in it could
 * read the password Walnut puts in. Memory only, as the agent tabs are.
 */
const tamperedTabs = tabStore<{ owner: string; doc: string; at: number }>('agentTampered')
/** Marked when the page did not say which document it is: holds until the tab loads again. */
const UNKNOWN_DOC = '*'
export async function noteTampered(tabId: number, owner: string, askPage = true): Promise<void> {
  const page = askPage ? await pageCheck(tabId, 3000) : null
  await tamperedTabs.set(tabId, { owner, doc: page?.doc ?? UNKNOWN_DOC, at: Date.now() })
}
/** The document now loaded in the tab is the one an agent touched (any owner's: what its script left stays in the page). */
export async function tamperedNow(tabId: number, doc: string | undefined): Promise<boolean> {
  const t = await tamperedTabs.get(tabId)
  if (!t) return false
  if (t.doc !== UNKNOWN_DOC && doc && t.doc !== doc) { await tamperedTabs.delete(tabId); return false }
  return true
}
/** A load of the tab ends a mark made with no document id (one with an id ends by the id). */
export async function tabLoading(tabId: number): Promise<void> {
  const t = await tamperedTabs.get(tabId)
  if (t?.doc === UNKNOWN_DOC) await tamperedTabs.delete(tabId)
}
export const forgetTampered = (tabId: number) => tamperedTabs.delete(tabId)

/** Until when each tab counts as acted in (a new tab or a download then is the agent's). */
export const acting = new Map<number, number>()
export const ACTING_MS = 15_000

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const walnutCheck = { isWalnutPage: async (_url: string): Promise<boolean> => false }

export function allowed(allow: WireCommand['allow'], url: string): boolean {
  const site = siteKey(url)?.domain
  if (!site) return false
  return allow.any || allow.sites.includes(site)
}

/** What a tab may use: the allowed sites, and the site of a tab the person handed over. */
export function allowFor(allow: WireCommand['allow'], rec: AgentTab | undefined): WireCommand['allow'] {
  return rec?.handed && !allow.sites.includes(rec.handed) ? { ...allow, sites: [...allow.sites, rec.handed] } : allow
}

export const WALNUT_PAGE = 'Agents never use Walnut\'s own pages in the browser.'

/** The page may be an agent's: a web page, not Walnut, on an allowed site. */
export async function checkPage(allow: WireCommand['allow'], url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new AgentError('Agents use web pages only (http or https).', 'not_a_web_page')
  if (await walnutCheck.isWalnutPage(url) || walnutAddress(allow.walnut, url)) throw new AgentError(WALNUT_PAGE, 'walnut_page')
  if (!allowed(allow, url)) throw new AgentError('That site is not allowed for agents yet.', 'site_not_allowed', { url, site: siteKey(url)?.domain })
}

/** Resolves when the tab has finished loading (or after `ms`). */
export function loaded(tabId: number, ms = 30_000): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (done) return; done = true; ext.tabs.onUpdated.removeListener(on); clearTimeout(t); resolve() }
    const on = (id: number, change: { status?: string }) => { if (id === tabId && change.status === 'complete') finish() }
    const t = setTimeout(finish, ms)
    ext.tabs.onUpdated.addListener(on)
    void ext.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') setTimeout(() => void ext.tabs.get(tabId).then((t2) => { if (t2.status === 'complete') finish() }).catch(finish), 150) }).catch(finish)
  })
}

/** A page action may start a navigation: wait a moment for one, and for it to load. */
export function settled(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    let loading = false
    const on = (id: number, change: { status?: string }) => { if (id === tabId && change.status === 'loading') loading = true }
    ext.tabs.onUpdated.addListener(on)
    setTimeout(() => {
      ext.tabs.onUpdated.removeListener(on)
      if (loading) void loaded(tabId, 15_000).then(resolve)
      else resolve()
    }, 700)
  })
}

/**
 * The frame and pill on an agent's tab (content.ts): `driving` while the person took it over. A tab
 * an agent opened in the agent window goes into its task's tab group as it is marked (agent-groups.ts).
 * A tab the person handed over (Act in tab: `handed`) goes into that task's group of their window
 * once per holding, at its first mark (agent-groups-person.ts), until it is let go (letGo): a later
 * mark (Take over, Hand back) never puts it back after the person dragged it out, and a tab the
 * agent took or opened from a handed one is never grouped there (review 2026-11-09).
 */
export async function mark(tabId: number, on: boolean, who?: string, mode?: 'driving'): Promise<void> {
  const rec = on ? await agentTabs.get(tabId) : undefined
  const driving = mode === 'driving' || typeof rec?.driving === 'number'
  await toPage(tabId, { type: 'agent-mark', on, ...(who ? { who } : {}), ...(driving ? { mode: 'driving' } : {}) }, 4000)
  // Grouped, then folded once the agent is quiet (a new group opens unfolded: review 2026-11-08).
  if (rec && !personsTab(rec)) void groupAgentTab(ext as unknown as GroupApi, tabId, rec.owner, rec.who, await agentWindowId()).then(() => noteGroupUse(ext as unknown as GroupApi, rec.owner))
  // A hand-over, outside the agent window (groupPersonTab leaves that one alone): the task's group
  // of the person's window, once for this holding (recorded with its grant before it is grouped).
  if (rec?.handed && rec.grant && rec.grouped !== rec.grant && await firstGrouping(tabId, rec.grant)) {
    void groupPersonTab(ext as unknown as GroupApi, tabId, rec.owner, rec.who, async () => (await agentTabs.get(tabId))?.grant === rec.grant)
  }
}

/** Records that this holding's tab is grouped now: true for the one mark that recorded it (a second at once finds it done). */
async function firstGrouping(tabId: number, grant: string): Promise<boolean> {
  let first = false
  await agentTabs.update(tabId, (cur) => {
    if (cur.grant !== grant || cur.grouped === grant) return cur
    first = true
    return { ...cur, grouped: grant }
  })
  return first
}

const UNREACHED: Record<ReachError, string> = {
  gone: 'That tab was closed: open <url> starts a new one (tabs lists yours).',
  not_web: 'Agents use web pages only (http or https).',
  no_script: 'Walnut could not reach this page (the browser keeps the extension out of it, or it stopped answering): reload the tab and try again.',
}

/** The page's script answers, put in first when the tab had none (page-reach.ts). */
export async function reached(tabId: number, wake = true): Promise<{ walnut: boolean; href: string; doc?: string; hidden?: boolean }> {
  const r = await reachPage(tabId, wake)
  if (!r.ok) throw new AgentError(UNREACHED[r.why], r.why === 'gone' ? 'not_your_tab' : 'page_not_ready')
  return r
}

export async function ownTab(args: Record<string, unknown>): Promise<{ tabId: number; tab: Tab; rec: AgentTab }> {
  const tabId = typeof args.tab === 'number' ? args.tab : NaN
  const rec = await agentTabs.get(tabId)
  if (!rec) throw new AgentError('That tab is not one an agent opened (or the person took it back with Stop): tabs lists yours, open <url> starts a new one.', 'not_your_tab')
  const tab = await ext.tabs.get(tabId).catch(() => null)
  if (!tab) { await agentTabs.delete(tabId); throw new AgentError('That tab was closed: open <url> starts a new one (tabs lists yours).', 'not_your_tab') }
  return { tabId, tab, rec }
}

/** A tab as every answer names it: its id, address and title, and which window it is in (Walnut's agent window or the person's). */
export const where = async (tabId: number) => {
  const t = await ext.tabs.get(tabId).catch(() => ({} as Tab))
  return { tab: tabId, url: t.url, title: t.title, ...(await windowOf(ext, t.windowId)) }
}

type PageReply = { ok: boolean; result?: Record<string, unknown>; error?: { message: string; code: string; extra?: Record<string, unknown> } }

/**
 * One op in one frame of the tab (0 the top). A frame whose script is missing (it loaded before
 * the extension) gets it and is asked once more.
 */
export async function frameOp(tabId: number, frameId: number, op: string, args: Record<string, unknown>, allow: WireCommand['allow'], ms = 20_000): Promise<Record<string, unknown>> {
  const msg = { type: 'agent', op, args: { ...args, frame: frameId ? `f${frameId}` : undefined }, allow }
  let r = await toPage<PageReply>(tabId, msg, ms, frameId)
  if (!r && frameId && await injectContent(tabId)) { await sleep(200); r = await toPage<PageReply>(tabId, msg, ms, frameId) }
  if (!r) throw new AgentError('The page did not answer in time (it may be busy or frozen): try again.', 'page_not_ready')
  if (!r.ok) throw new AgentError(r.error?.message ?? 'The page could not do that.', r.error?.code ?? 'page_error', r.error?.extra ?? {})
  return r.result ?? {}
}
