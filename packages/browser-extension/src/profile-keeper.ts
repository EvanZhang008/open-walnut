/**
 * Chrome on a Mac stops every extension of a profile when the profile's last window closes (the
 * app keeps running, the profile is put away): no poll, no alarm, nothing wakes it until a window
 * of that profile opens again. 2026-11-21, seen in the user's Chrome: the agent window was the
 * profile's only window, its tabs were closed one by one, and agents lost the browser for 1 h 46
 * min until the person opened Chrome himself. Reacting to the close is too late: by the time
 * windows.onRemoved would run, the extension is already stopped (tried in Chrome for Testing).
 *
 * So while agents are on and the profile is down to one normal window, Walnut keeps one more: a
 * minimized window in the Dock holding its own page (KEEPER_PAGE), made unfocused, so closing that
 * last window never stops the extension. It goes again as soon as the profile has two windows of
 * its own, and when agents are turned off.
 *
 *   - A keeper is a window holding nothing but Walnut's keeper page, told by the page's own tab
 *     (runtime.getContexts: without the tabs permission a tab's address is hidden, so the page is
 *     never recognised by its URL). One the person opens and uses (another tab in it) is theirs
 *     from then on and is never closed.
 *   - The person closing the keeper is their choice: it is not made again until another window
 *     opens (or the browser starts again).
 *   - Only on a Mac, and only in Chrome (and Chromium browsers): elsewhere closing the last window
 *     quits the browser, which a hidden window would wrongly keep running; Firefox keeps its
 *     extensions.
 */
import type { Win } from './ext'

export const KEEPER_PAGE = 'keep-window.html'

interface Event<F> { addListener(f: F): void }
export interface KeeperApi {
  windows: {
    getAll(o: { populate: true; windowTypes: string[] }): Promise<Win[]>
    create(o: { url: string; type: string; focused: boolean; state: string }): Promise<Win>
    update?(id: number, o: { state: string }): Promise<Win>
    remove(id: number): Promise<void>
    onCreated?: Event<(w: Win) => void>
    onRemoved: Event<(id: number) => void>
  }
  runtime: {
    getURL(path: string): string
    getPlatformInfo(): Promise<unknown>
    /** The extension's own pages open now (Chrome 116+): no permission needed. */
    getContexts?(o: { contextTypes: string[]; documentUrls: string[] }): Promise<Array<{ tabId?: number; windowId?: number }>>
    onStartup?: Event<() => void>
  }
  storage: {
    session: { get(k: string): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void> }
    onChanged: Event<(c: Record<string, unknown>, area: string) => void>
  }
}

/** The keeper windows this extension made and has not closed itself (storage.session: kept while the background sleeps). */
/** A keeper is being made now (its own windows.onCreated is no new window of anyone's). */
let making = false

type Store = Pick<KeeperApi, 'storage'>
async function known(api: Store): Promise<number[]> {
  const v = (await api.storage.session.get('keeperWindows')).keeperWindows
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []
}
async function setKnown(api: Store, ids: number[]): Promise<void> { await api.storage.session.set({ keeperWindows: [...new Set(ids)] }) }

/** The tabs showing the keeper page now (a reload forgets keeperWindows; the page itself is still there). */
export async function keeperTabs(api: Pick<KeeperApi, 'runtime'>): Promise<Set<number>> {
  const page = api.runtime.getURL(KEEPER_PAGE)
  const found = await Promise.resolve(api.runtime.getContexts?.({ contextTypes: ['TAB'], documentUrls: [page] })).catch(() => undefined) ?? []
  return new Set(found.map((c) => c.tabId).filter((id): id is number => typeof id === 'number' && id >= 0))
}

/**
 * A window holding nothing but the keeper page: one this extension made (its page may not have
 * loaded yet), or one showing the page.
 */
export function isKeeper(w: Win, keeperTabIds: Set<number>, made: number[] = []): boolean {
  const tabs = w.tabs ?? []
  if (tabs.length !== 1) return false
  return (w.id !== undefined && made.includes(w.id)) || (tabs[0].id !== undefined && keeperTabIds.has(tabs[0].id))
}

/** The keeper windows now, for any reader that looks for the person's window (grant-open.ts). */
export async function keeperWindowIds(api: Pick<KeeperApi, 'runtime' | 'windows' | 'storage'>): Promise<Set<number>> {
  const [ids, made, wins] = await Promise.all([keeperTabs(api), known(api), api.windows.getAll({ populate: true, windowTypes: ['normal'] }).catch(() => [] as Win[])])
  return new Set(wins.filter((w) => w.id !== undefined && isKeeper(w, ids, made)).map((w) => w.id!))
}

/** What one pass does: make a keeper, drop the keepers, or nothing. */
export type KeeperStep = 'made' | 'dropped' | 'none'

/** One pass: the keeper the profile needs now (rule in the header). `wanted`: agents are on. */
export async function keepProfile(api: KeeperApi, wanted: boolean): Promise<KeeperStep> {
  const [ids, made] = await Promise.all([keeperTabs(api), known(api)])
  const wins = await api.windows.getAll({ populate: true, windowTypes: ['normal'] })
  const keepers = wins.filter((w) => isKeeper(w, ids, made))
  const others = wins.length - keepers.length
  // Never two: a second one made by a race goes at once.
  const drop = !wanted || others >= 2 ? keepers : keepers.slice(1)
  const keep = keepers.filter((w) => !drop.includes(w)).map((w) => w.id!).filter((id) => id !== undefined)
  // Forgotten first, so its close is not taken for the person's (noteWindowGone).
  await setKnown(api, keep)
  for (const w of drop) if (w.id !== undefined) await api.windows.remove(w.id).catch(() => undefined)
  if (drop.length && (!wanted || others >= 2)) return 'dropped'
  if (!wanted || keepers.length || others >= 2) return 'none'
  if ((await api.storage.session.get('keeperDeclined')).keeperDeclined === true) return 'none'
  making = true
  try {
    const w = await api.windows.create({ url: api.runtime.getURL(KEEPER_PAGE), type: 'normal', focused: false, state: 'minimized' })
    if (w.id !== undefined) await setKnown(api, [...keep, w.id])
    // Chrome on a Mac makes it a normal window all the same (seen in Chrome for Testing 2026-11-21): to the Dock.
    if (w.id !== undefined && w.state !== 'minimized') await api.windows.update?.(w.id, { state: 'minimized' }).catch(() => undefined)
  } finally { making = false }
  return 'made'
}

/** A window closed: a keeper this extension still knew was closed by the person, who said no until another window opens. */
export async function noteWindowGone(api: KeeperApi, id: number): Promise<void> {
  const made = await known(api)
  if (!made.includes(id)) return
  await setKnown(api, made.filter((x) => x !== id))
  await api.storage.session.set({ keeperDeclined: true })
}

/** Runs the keeper on every change that matters, one pass at a time. */
export function initProfileKeeper(api: KeeperApi, agentsOn: () => Promise<boolean>, isChrome: boolean): void {
  // Without getContexts (Chrome before 116) a keeper could not be told apart after a reload: none is made.
  if (!isChrome || !api.runtime.getContexts) return
  let mac: Promise<boolean> | null = null
  const onMac = () => (mac ??= Promise.resolve(api.runtime.getPlatformInfo()).then((p) => (p as { os?: string })?.os === 'mac', () => false))
  let chain: Promise<unknown> = Promise.resolve()
  let queued = false
  const pass = (): void => {
    if (queued) return
    queued = true
    chain = chain.then(async () => {
      queued = false
      if (await onMac()) await keepProfile(api, await agentsOn())
    }).catch(() => undefined)
  }
  api.windows.onCreated?.addListener(() => {
    // A window opened (the person's, an agent's): a keeper the person closed may be needed again.
    if (!making) void api.storage.session.set({ keeperDeclined: false }).catch(() => undefined)
    pass()
  })
  // One after the other with the passes, so a pass never reads a keeper list a close is changing.
  api.windows.onRemoved.addListener((id) => { chain = chain.then(() => noteWindowGone(api, id)).catch(() => undefined); pass() })
  api.storage.onChanged.addListener((c, area) => { if (area === 'local' && 'agentControl' in c) pass() })
  api.runtime.onStartup?.addListener(pass)
  pass()
}
