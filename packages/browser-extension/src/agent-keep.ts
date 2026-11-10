/**
 * The agent's state outlives an extension reload (2026-11-10, seen in the user's Chrome: after a
 * self-update the agent window was no longer known, so the next open made a second one with the
 * old one left open; the agent's own tab there read as the person's, the sign-in hint asked the
 * person to hand it over, and nothing ever tidied it). Chrome clears storage.session on a reload
 * and keeps every window, tab and group with the same ids, so the keys session-keys.ts marks
 * `kept` are mirrored into storage.local (KEPT) and put back after a reload, before anything reads
 * them: the first poll then reports the same holdings, with the same grants, as before the reload,
 * and the hub sees no change.
 *
 *   - Put back only on proof of a reload: self-update.ts stamps the mirror right before it reloads
 *     (keepForReload), or Chrome says the extension was updated (runtime.onInstalled, `update`) and
 *     no browser start follows within EVENT_WAIT_MS. A browser start (runtime.onStartup) gives every
 *     window, tab and group a new id, and session restore may hand out the very same small ids
 *     again, so a kept id is never trusted then: the mirror is dropped (agent-groups-person.ts finds
 *     its own groups again by their titles), and what a stamp already put back goes again.
 *   - On disk only what is needed to check an id: a tab's window and its page's origin, never an
 *     address (a holding's address list stays in storage.session and comes back as the tab's now).
 *   - Each id only while it still names the same thing: the window still there; a tab still there,
 *     in the window it was in, and for a holding on the same site (a tab the person handed over
 *     with Act in tab: on the very site they handed over). Anything else is dropped, as before.
 *   - A holding of the person's tab (Act in tab, `take`) is a permission they gave for that tab: it
 *     comes back only while that same tab is in the same window on the same site. A reload is not
 *     the person taking the tab back; a different page in it, or a browser start, is a new start.
 *   - Nothing here focuses a window or changes a tab: it reads ids and writes storage.
 */
import { ext } from './ext'
import { AGENT_PAGE } from './agent-groups'
import { siteKey } from '../../../src/core/vault/url-match'
import { KEPT_KEYS, type KeptKey } from './session-keys'

export const KEPT = 'agentKept'
/** The mark in storage.session that it was not cleared (a wake of the background, not a reload). */
export const ALIVE = 'agentAlive'
/** A stamp from self-update.ts counts this long (the reload follows it at once). */
export const RELOAD_FRESH_MS = 60_000
/** With no stamp, how long a cleared start waits for Chrome to say why (onInstalled or onStartup). */
export const EVENT_WAIT_MS = 2000
/** A change is mirrored this soon after it (one write for a burst), and a steady stream of changes at least this often. */
export const MIRROR_MS = 250
export const MIRROR_MAX_MS = 2000

type T = { id?: number; windowId?: number; url?: string; pendingUrl?: string }
type Area = { get(k: string | string[]): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void>; remove?(k: string | string[]): Promise<void> }
/** The calls it needs, loosely typed (tests pass a fake). */
export interface KeepApi {
  storage: { session: Area; local: Area; onChanged?: { addListener(f: (c: Record<string, unknown>, area: string) => void): void } }
  tabs: { get(id: number): Promise<T>; onAttached?: { addListener(f: (tabId: number) => void): void } }
  windows: { get(id: number): Promise<{ id?: number; type?: string }> }
  tabGroups?: { get(id: number): Promise<{ id: number; windowId: number }> }
  runtime: {
    getURL(p: string): string
    onInstalled?: { addListener(f: (d: { reason?: string }) => void): void }
    onStartup?: { addListener(f: () => void): void }
  }
}

/**
 * The mirror: the kept keys as they were, and where each tab they name was then. Only origins of
 * pages go to disk (storage.local): a holding's address list stays in storage.session, and comes
 * back as the tab's address now.
 */
export interface Kept { at: number; reloading?: number; values: Partial<Record<KeptKey, unknown>>; tabs: Record<string, { windowId?: number; origin?: string }> }

type Map_ = Record<string, unknown>
const asMap = (v: unknown): Map_ => (v && typeof v === 'object' && !Array.isArray(v) ? v as Map_ : {})
const originOf = (u: unknown) => { try { return new URL(String(u ?? '')).origin } catch { return '' } }
const urlOf = (t: T) => t.url || t.pendingUrl || ''

/** Every tab id the kept keys name. */
function tabIdsOf(values: Kept['values']): number[] {
  const ids = new Set<number>()
  for (const k of ['agentTabs', 'agentMade', 'agentTampered'] as const) for (const id of Object.keys(asMap(values[k]))) ids.add(Number(id))
  if (typeof values.agentPage === 'number') ids.add(values.agentPage)
  return [...ids].filter(Number.isInteger)
}

async function snapshot(api: KeepApi): Promise<Kept> {
  const values = await api.storage.session.get([...KEPT_KEYS]) as Kept['values']
  const tabs: Kept['tabs'] = {}
  for (const id of tabIdsOf(values)) {
    const t = await api.tabs.get(id).catch(() => null)
    if (t) tabs[String(id)] = { windowId: t.windowId, origin: originOf(urlOf(t)) }
  }
  // Addresses (a sign-in code, a reset link in a query) never go to disk.
  const holdings: Map_ = {}
  for (const [k, rec] of Object.entries(asMap(values.agentTabs))) { const { history: _h, ...rest } = asMap(rec); holdings[k] = rest }
  return { at: Date.now(), values: { ...values, ...(values.agentTabs ? { agentTabs: holdings } : {}) }, tabs }
}

/**
 * The kept keys as they may come back now: each id checked against what Chrome has (module
 * header). Pure of writes, so a test can read the rules alone.
 */
export async function validKept(api: KeepApi, kept: Kept): Promise<Partial<Record<KeptKey, unknown>>> {
  const v = kept.values
  const out: Partial<Record<KeptKey, unknown>> = {}
  /** The tab, still there and in the window it was in. */
  const tabNow = async (id: number): Promise<T | null> => {
    const f = kept.tabs[String(id)]
    const t = f ? await api.tabs.get(id).catch(() => null) : null
    return t && t.windowId === f!.windowId ? t : null
  }
  let win: number | undefined
  if (typeof v.agentWindow === 'number') {
    const w = await api.windows.get(v.agentWindow).catch(() => null)
    if (w && (w.type === undefined || w.type === 'normal')) win = out.agentWindow = v.agentWindow
  }
  if (win !== undefined && typeof v.agentPage === 'number') {
    const t = await tabNow(v.agentPage)
    if (t && t.windowId === win && urlOf(t).startsWith(api.runtime.getURL(AGENT_PAGE))) out.agentPage = v.agentPage
  }
  const holdings: Map_ = {}
  for (const [k, rec] of Object.entries(asMap(v.agentTabs))) {
    const r = asMap(rec) as { owner?: unknown; handed?: unknown }
    const t = typeof r.owner === 'string' ? await tabNow(Number(k)) : null
    if (!t) continue
    const now = urlOf(t)
    if (!originOf(now) || originOf(now) !== kept.tabs[k]?.origin) continue
    // The person's Act in tab allowed one site, in this tab alone: only while it is still on it.
    if (typeof r.handed === 'string' && siteKey(now)?.domain !== r.handed) continue
    holdings[k] = { ...r, history: [now] }
  }
  if (Object.keys(holdings).length) out.agentTabs = holdings
  for (const key of ['agentMade', 'agentTampered'] as const) {
    const m: Map_ = {}
    for (const [k, x] of Object.entries(asMap(v[key]))) if (await tabNow(Number(k))) m[k] = x
    if (Object.keys(m).length) out[key] = m
  }
  const groupIn = async (gid: unknown, windowId: number | undefined) => {
    if (typeof gid !== 'number' || windowId === undefined || !api.tabGroups) return false
    return (await api.tabGroups.get(gid).catch(() => null))?.windowId === windowId
  }
  const groups: Map_ = {}
  for (const [owner, gid] of Object.entries(asMap(v.agentGroups))) if (await groupIn(gid, win)) groups[owner] = gid
  if (Object.keys(groups).length) out.agentGroups = groups
  const person: Map_ = {}
  // owner\0windowId → the group of that window (agent-groups-person.ts groupKey).
  for (const [key, gid] of Object.entries(asMap(v.agentPersonGroups))) if (await groupIn(gid, Number(key.slice(key.lastIndexOf('\u0000') + 1)))) person[key] = gid
  if (Object.keys(person).length) out.agentPersonGroups = person
  // No window, tab or group ids in these: as they were.
  for (const key of ['agentFilled', 'agentDownloads', 'debuggerCancelledAt'] as const) if (v[key] !== undefined) out[key] = v[key]
  return out
}

/** Put the valid kept keys back, never over what storage.session has now (a newer write wins): what was written. */
async function restore(api: KeepApi, kept: Kept): Promise<Record<string, unknown>> {
  const back = await validKept(api, kept)
  const now = await api.storage.session.get(Object.keys(back)) as Record<string, unknown>
  const write: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(back)) {
    const cur = now[k]
    if (cur === undefined) write[k] = x
    else if (asMap(cur) === cur && asMap(x) === x) write[k] = { ...(x as Map_), ...(cur as Map_) }
  }
  if (Object.keys(write).length) await api.storage.session.set(write)
  return write
}

const state = {
  ready: Promise.resolve() as Promise<void>,
  mirroring: false,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  installed: false,
  started: false,
  /** What a restore wrote, while a browser start may still say those ids were the run before's. */
  restored: undefined as Record<string, unknown> | undefined,
  firstChangeAt: 0,
  wake: undefined as ((trust: boolean) => void) | undefined,
  startedAt: 0,
}

/** Resolves once the kept state is back (or known to be gone): every reader of the agent's state awaits it. */
export const keptReady = (): Promise<void> => state.ready

async function writeMirror(api: KeepApi, extra: Partial<Kept> = {}): Promise<void> {
  await api.storage.local.set({ [KEPT]: { ...(await snapshot(api)), ...extra } })
}

function mirrorSoon(api: KeepApi): void {
  if (!state.mirroring) return
  const now = Date.now()
  if (!state.timer) state.firstChangeAt = now
  clearTimeout(state.timer)
  const wait = Math.max(0, Math.min(MIRROR_MS, state.firstChangeAt + MIRROR_MAX_MS - now))
  state.timer = setTimeout(() => { state.timer = undefined; void writeMirror(api).catch(() => undefined) }, wait)
}

/**
 * Why storage.session was cleared, when no stamp says. Chrome's `update` alone is not enough: a
 * browser start may bring it too (a folder updated while the browser was closed), with onStartup
 * in either order, so the whole EVENT_WAIT_MS from the start is waited, and an onStartup in it wins.
 */
function waitForWhy(): Promise<boolean> {
  if (state.started) return Promise.resolve(false)
  return new Promise((resolve) => {
    const t = setTimeout(() => { state.wake = undefined; resolve(state.installed && !state.started) }, Math.max(0, state.startedAt + EVENT_WAIT_MS - Date.now()))
    state.wake = () => { clearTimeout(t); state.wake = undefined; resolve(false) }
  })
}

async function decide(api: KeepApi): Promise<void> {
  if ((await api.storage.session.get(ALIVE))[ALIVE] !== undefined) return
  await api.storage.session.set({ [ALIVE]: Date.now() })
  const kept = (await api.storage.local.get(KEPT))[KEPT] as Kept | undefined
  if (!kept?.values) return
  // Read once: a stamp counts for this start only (the mirror is written again once ready).
  await api.storage.local.remove?.(KEPT)
  const stamped = typeof kept.reloading === 'number' && Date.now() - kept.reloading < RELOAD_FRESH_MS && Date.now() >= kept.reloading
  const trust = stamped || await waitForWhy()
  if (!trust || state.started) return
  state.restored = {}
  state.restored = await restore(api, kept)
  if (state.started) await dropRestored(api)
}

/**
 * A browser start after all (a crash right after a stamp): the ids put back were the run before's.
 * Only a key still as the restore wrote it goes; one written since is the new run's.
 */
async function dropRestored(api: KeepApi): Promise<void> {
  const back = state.restored
  state.restored = undefined
  if (!back) return
  const now = await api.storage.session.get(Object.keys(back)).catch(() => ({} as Record<string, unknown>))
  const same = Object.keys(back).filter((k) => JSON.stringify(now[k]) === JSON.stringify(back[k]))
  if (same.length) await api.storage.session.remove?.(same).catch(() => undefined)
}

/**
 * At the background's start, before anything reads the agent's state (initAgent). The listeners
 * are added at once, so the event that woke the background reaches them.
 */
export function startKeep(api: KeepApi = ext as unknown as KeepApi): Promise<void> {
  state.startedAt = Date.now()
  api.runtime.onInstalled?.addListener((d) => { if (d?.reason === 'update') state.installed = true })
  api.runtime.onStartup?.addListener(() => {
    state.started = true
    state.wake?.(false)
    if (state.restored) void dropRestored(api)
  })
  api.storage.onChanged?.addListener((changes, area) => { if (area === 'session' && KEPT_KEYS.some((k) => k in changes)) mirrorSoon(api) })
  // A tab the person dragged to another window: where it is now.
  api.tabs.onAttached?.addListener(() => mirrorSoon(api))
  state.ready = decide(api).catch(() => undefined).then(() => { state.mirroring = true; mirrorSoon(api) })
  return state.ready
}

/** Right before self-update.ts reloads the extension: the mirror as it is now, stamped. */
export async function keepForReload(api: KeepApi = ext as unknown as KeepApi): Promise<void> {
  await state.ready
  clearTimeout(state.timer)
  await writeMirror(api, { reloading: Date.now() })
}

export function _resetKeepForTesting(): void {
  clearTimeout(state.timer)
  Object.assign(state, { ready: Promise.resolve(), mirroring: false, timer: undefined, installed: false, started: false, restored: undefined, firstChangeAt: 0, wake: undefined, startedAt: 0 })
}
