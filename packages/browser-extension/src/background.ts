/**
 * The extension's background: the only part that talks to Walnut and holds the tokens.
 * Content scripts, the in-page menu and the save bar ask it by message; it answers each from
 * the sender's own tab and frame, never from what a message claims about where it came from,
 * and each kind of message only from the page that may send it (senderKind).
 *
 * Secrets: a fill fetches the item and sends its username and password only to frames on the
 * top page's origin that said they hold a login form (or to the one frame whose menu was
 * picked), with that origin, which the frame checks again; it keeps nothing. The summaries
 * (titles, usernames, sites) are cached for 5 s while unlocked, so a Lock elsewhere shows soon.
 */
import { ext, type Sender, type Tab } from './ext'
import { ApiError, DEFAULT_SERVER, api, call, cleanServerUrl, connection, disconnect, pair, vaultSession } from './walnut-api'
import { displayHost, matchItem, siteKey } from '../../../src/core/vault/url-match'
import { generate, DEFAULT_PASSWORD, type GeneratorOptions } from '../../../src/core/vault/generator'
import type { VaultItem, VaultItemSummary } from '../../../src/core/vault/types'
import type { FormKind } from './form-detect'
import { tabStore } from './tab-store'
import { adoptTab, agentMessage, agentOn, initAgent, isAgentTab, releaseTab, tabOwnerOf } from './agent'
import { initSelfUpdate } from './self-update'
import { injectOpenTabs, reachPage, sleep, toPage } from './page-reach'

type Reply = Record<string, unknown> & { ok: boolean }
const fail = (err: unknown): Reply => err instanceof ApiError
  ? { ok: false, error: err.message, code: err.code, ...(err.waitMs ? { waitMs: err.waitMs } : {}) }
  : { ok: false, error: err instanceof Error ? err.message : String(err) }

// ── summaries ──

let cache: { at: number; items: VaultItemSummary[] } | null = null
async function summaries(): Promise<VaultItemSummary[]> {
  if (cache && Date.now() - cache.at < 5_000) return cache.items
  const items = (await api.items()).filter((i) => !i.trashedAt)
  cache = { at: Date.now(), items }
  return items
}
const forget = () => { cache = null }

export interface MenuItem { id: string; title: string; username?: string; site?: string; hasTotp: boolean; exact: boolean }

function view(i: VaultItemSummary, page?: string): MenuItem {
  return {
    id: i.id, title: i.title, ...(i.username ? { username: i.username } : {}),
    ...(i.urls?.[0] ? { site: displayHost(i.urls[0]) } : {}), hasTotp: i.hasTotp,
    exact: !!page && matchItem(i.urls, page) === 'exact_host',
  }
}

/** Logins saved for a page, the same host first, then most recently used. */
async function matchesFor(page: string): Promise<MenuItem[]> {
  const all = (await summaries()).filter((i) => i.type === 'login' && matchItem(i.urls, page))
  return all
    .map((i) => ({ i, v: view(i, page) }))
    .sort((a, b) => Number(b.v.exact) - Number(a.v.exact) || (b.i.usedAt ?? '').localeCompare(a.i.usedAt ?? '') || a.i.title.localeCompare(b.i.title))
    .map((x) => x.v)
}

async function state(): Promise<{ connected: boolean; unlocked: boolean; serverUrl?: string; device?: string }> {
  const conn = await connection()
  if (!conn) return { connected: false, unlocked: false }
  return { connected: true, unlocked: !!(await vaultSession()), serverUrl: conn.serverUrl, device: conn.device }
}

const originOf = (url: string): string => { try { return new URL(url).origin } catch { return '' } }
const nonce = (): string => crypto.getRandomValues(new Uint32Array(4)).join('-')

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
/** The same server under another loopback name (127.0.0.1 for localhost, and so on). */
function sameServer(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.protocol === y.protocol && x.port === y.port && LOOPBACK.has(x.hostname) && LOOPBACK.has(y.hostname)
  } catch { return false }
}

/**
 * Walnut's own pages (its lock screen, Settings): the extension stays out of them. Every page of
 * Walnut also says so itself (content.ts reads its marker), which covers the addresses this list
 * does not know (its tunnel, Tailscale).
 */
async function isWalnutPage(url: string): Promise<boolean> {
  const conn = await connection()
  const o = originOf(url)
  return !!o && (sameServer(o, conn?.serverUrl ?? '') || sameServer(o, DEFAULT_SERVER))
}

// ── per-tab state (storage.session: it outlives the service worker, and content scripts cannot read it) ──

/** The in-page menu that is open, and the frame that opened it; `nonce` is in its page's URL. */
interface MenuOwner { tabId: number; frameId: number; url: string; role: string; kind: FormKind; nonce: string }

/** A login seen being sent, offered for save or update. The page never holds it. */
interface Pending {
  url: string
  username?: string
  password: string
  kind: 'save' | 'update'
  itemId?: string
  title?: string
  at: number
  /** Compared with the saved logins (needs the vault open); a login seen while locked is not yet. */
  checked: boolean
  /** The save bar's page carries it in its URL; its messages must too. */
  nonce: string
}
const PENDING_MS = 3 * 60_000
/** A pending login shows on another site's page only right after it was sent (a sign-in that lands elsewhere). */
const ELSEWHERE_MS = 20_000

const pendingSave = tabStore<Pending>('pendingSave')
const seenUsername = tabStore<{ url: string; username: string; at: number }>('seenUsername')
const connecting = tabStore<string>('connecting')
const menus = tabStore<MenuOwner>('menus')
/** Frames that may be filled: on the top page's origin, holding a login form. */
const frames = tabStore<Record<string, { origin: string; at: number }>>('frames')
/** The strong password the menu last made on a tab: a sign-up sent with it is saved without typing. */
const generated = tabStore<{ password: string; url: string; at: number }>('generated')

/** The strong password the menu made waits this long for its sign-up to be sent. */
const GENERATED_MS = 10 * 60_000

/**
 * A typed or generated password is kept only as long as it can still be offered: expired ones
 * are removed on every read and by a sweep that runs with the messages pages send anyway (a
 * page load, a click), at most every 15 s.
 */
let sweptAt = 0
async function sweep(): Promise<void> {
  if (Date.now() - sweptAt < 15_000) return
  sweptAt = Date.now()
  const now = Date.now()
  await pendingSave.sweep((p) => now - p.at > PENDING_MS)
  await seenUsername.sweep((u) => now - u.at > PENDING_MS)
  await generated.sweep((g) => now - g.at > GENERATED_MS)
}

async function neverSites(): Promise<string[]> {
  const { neverSave } = await ext.storage.local.get('neverSave')
  return Array.isArray(neverSave) ? neverSave as string[] : []
}

function siteOf(url: string): string {
  return siteKey(url)?.domain ?? new URL(url).hostname
}

/** A login sent on a page: offer to save it, or to update a saved one whose password differs. */
async function seenLogin(tabId: number, url: string, username: string | undefined, password: string, keep?: { at: number; nonce: string }): Promise<Pending | null> {
  if (!(await connection())) return null
  if ((await neverSites()).includes(siteOf(url))) return null
  const step = await seenUsername.get(tabId)
  if (step && Date.now() - step.at > PENDING_MS) await seenUsername.sweep((x) => Date.now() - x.at > PENDING_MS)
  if (!username && step && Date.now() - step.at < PENDING_MS && siteOf(step.url) === siteOf(url)) username = step.username
  let p: Pending = { url, ...(username ? { username } : {}), password, kind: 'save', title: displayHost(url), at: keep?.at ?? Date.now(), checked: false, nonce: keep?.nonce ?? nonce() }
  if (await vaultSession()) {
    try {
      const matches = (await summaries()).filter((i) => i.type === 'login' && matchItem(i.urls, url))
      p.checked = true
      const same = matches.filter((i) => (i.username ?? '') === (username ?? ''))
      const candidate = same[0] ?? (!username && matches.length === 1 ? matches[0] : undefined)
      if (candidate) {
        const item = await api.item(candidate.id)
        if (item.password === password) return null // nothing new
        p = { ...p, kind: 'update', itemId: item.id, title: item.title }
      }
    } catch (err) {
      if (!(err instanceof ApiError && (err.code === 'vault_session_needed' || err.code === 'vault_locked'))) throw err
      p = { ...p, kind: 'save', checked: false }
    }
  }
  await pendingSave.set(tabId, p)
  return p
}

async function showSaveBar(tabId: number): Promise<void> {
  const p = await pendingSave.get(tabId)
  if (!p) return
  await ext.tabs.sendMessage(tabId, { type: 'show-savebar', nonce: p.nonce }, { frameId: 0 }).catch(() => undefined)
}

/**
 * Send a login to fill: to `frameId` alone (the menu's frame), else to the tab's frames that
 * registered a login form on the top page's origin, top frame first. The tab is read again
 * right before, and every frame checks `origin` against its own.
 */
async function fillFrames(tabId: number, frameId: number | undefined, creds: { username?: string; password?: string; totp?: string }, mode: 'login' | 'totp', expected: string): Promise<boolean> {
  const tab = await ext.tabs.get(tabId).catch(() => undefined)
  const origin = originOf(tab?.url ?? '')
  if (!origin || origin !== originOf(expected)) return false
  const msg = { type: 'fill', mode, origin, ...creds }
  // A tab older than the extension has no page script yet (and so no frames known): put it in first.
  if (frameId === undefined && !Object.keys((await frames.get(tabId)) ?? {}).length) {
    // Its frames register as the script starts and finds the login fields: wait for them a little.
    if ((await reachPage(tabId, false)).ok) {
      for (let i = 0; i < 10 && !Object.keys((await frames.get(tabId)) ?? {}).length; i++) await sleep(200)
    }
  }
  const targets = frameId !== undefined
    ? [frameId]
    : Object.entries((await frames.get(tabId)) ?? {}).filter(([, f]) => f.origin === origin).map(([id]) => Number(id)).sort((a, b) => a - b)
  for (const id of targets) {
    const r = await ext.tabs.sendMessage(tabId, msg, { frameId: id }).catch(() => null)
    if (r?.filled) return true
  }
  return false
}

/** The menu or save bar is still on screen as Walnut drew it (content.ts tampered()); else it is closed. */
async function stillShown(tabId: number, frameId: number, which: 'menu' | 'bar'): Promise<boolean> {
  const r = await ext.tabs.sendMessage(tabId, { type: 'check-shown', which }, { frameId }).catch(() => null)
  return r?.ok === true
}
const COVERED = { ok: false, error: 'Something on the page covers Walnut, so it did nothing.' }

function credsOf(item: VaultItem): { username?: string; password?: string } {
  return { ...(item.username ? { username: item.username } : {}), ...(item.password ? { password: item.password } : {}) }
}

async function activeTab(): Promise<Tab | undefined> {
  return (await ext.tabs.query({ active: true, lastFocusedWindow: true }))[0]
}

/** Open the popup to unlock; where the browser refuses (no user gesture left), a small window. */
async function openUnlock(): Promise<void> {
  try {
    if (ext.action.openPopup) { await ext.action.openPopup(); return }
  } catch { /* falls through */ }
  await ext.windows.create({ url: ext.runtime.getURL('popup.html?window=1'), type: 'popup', width: 380, height: 560, focused: true })
}

async function startConnect(serverUrl: string): Promise<Reply> {
  const origin = cleanServerUrl(serverUrl || DEFAULT_SERVER)
  const tab = await ext.tabs.create({ url: `${origin}/connect-extension`, active: true })
  if (tab.id !== undefined) await connecting.set(tab.id, origin)
  return { ok: true }
}

// ── who may send what ──

type SenderKind = 'popup' | 'menu' | 'savebar' | 'content' | 'sidepanel'

function senderKind(sender: Sender): SenderKind | null {
  const url = String(sender.url ?? '')
  const own = ext.runtime.getURL('')
  if (url.startsWith(own)) {
    const page = url.slice(own.length).split(/[?#]/)[0]
    return page === 'popup.html' ? 'popup' : page === 'menu.html' ? 'menu' : page === 'savebar.html' ? 'savebar' : page === 'sidepanel.html' ? 'sidepanel' : null
  }
  return sender.tab?.id !== undefined && /^https?:/.test(url) ? 'content' : null
}

const ALLOWED: Record<string, SenderKind> = {
  state: 'popup', 'start-connect': 'popup', 'pair-code': 'popup', disconnect: 'popup', 'vault-status': 'popup',
  unlock: 'popup', lock: 'popup', 'site-items': 'popup', search: 'popup', 'copy-secret': 'popup', 'fill-tab': 'popup',
  generate: 'popup', 'open-walnut': 'popup',
  'page-init': 'content', 'frame-ready': 'content', 'open-menu': 'content', 'seen-login': 'content', 'seen-username': 'content',
  'connect-hello': 'content', 'connect-code': 'content',
  'menu-data': 'menu', 'menu-fill': 'menu', 'menu-generate': 'menu', 'menu-unlock': 'menu', 'menu-connect': 'menu', 'menu-close': 'menu', 'menu-size': 'menu',
  'savebar-data': 'savebar', 'savebar-action': 'savebar', 'savebar-size': 'savebar',
  'agent-get': 'popup', 'agent-on': 'popup', 'agent-off': 'popup', 'agent-stop': 'content',
  'page-selection': 'content',
  'panel-state': 'sidepanel', 'panel-page': 'sidepanel', 'panel-adopt': 'sidepanel', 'panel-release': 'sidepanel', 'panel-pending': 'sidepanel',
}

/** The open menu of the sender's tab, when the message carries its nonce. */
async function menuOf(tabId: number | undefined, msg: Record<string, unknown>): Promise<MenuOwner | undefined> {
  const owner = tabId !== undefined ? await menus.get(tabId) : undefined
  return owner && typeof msg.nonce === 'string' && msg.nonce === owner.nonce ? owner : undefined
}

async function pendingOf(tabId: number | undefined, msg: Record<string, unknown>): Promise<Pending | undefined> {
  const p = tabId !== undefined ? await pendingSave.get(tabId) : undefined
  if (p && Date.now() - p.at > PENDING_MS) { await pendingSave.sweep((x) => Date.now() - x.at > PENDING_MS); return undefined }
  return p && typeof msg.nonce === 'string' && msg.nonce === p.nonce ? p : undefined
}

// ── the message router ──

async function handle(msg: { type: string; [k: string]: unknown }, sender: Sender): Promise<Reply> {
  const kind = senderKind(sender)
  if (!kind || ALLOWED[msg.type] !== kind) return { ok: false, error: `Not for this page: ${msg.type}` }
  const tabId = sender.tab?.id
  switch (msg.type) {
    // popup
    case 'agent-get': case 'agent-on': case 'agent-off': case 'agent-stop': return agentMessage(msg.type, sender)
    // the side panel
    case 'page-selection': {
      // Told to an open panel (an extension page); none open, nobody hears it.
      if (tabId !== undefined) void ext.runtime.sendMessage({ type: 'panel-selection', tabId }).catch(() => undefined)
      return { ok: true }
    }
    case 'panel-state': {
      const conn = await connection()
      if (!conn) return { ok: true, connected: false }
      // An older Walnut has no side panel: the panel says to update it rather than show an error page.
      const has = await call('GET', '/browser/panel', undefined, { noSession: true, quiet: true, timeoutMs: 8000 }).then(() => true, (err) => !(err instanceof ApiError && err.status === 404))
      return { ok: true, connected: true, serverUrl: conn.serverUrl, panel: has }
    }
    case 'panel-page': {
      // The page the person is on: its address, title and selection; its text only when a question
      // is asked with it (`withText`), so the pages they only look at stay in the browser.
      const id = typeof msg.tabId === 'number' ? msg.tabId : undefined
      const tab = id !== undefined ? await ext.tabs.get(id).catch(() => null) : null
      const agents = await agentOn()
      const owner = await tabOwnerOf(id)
      const base = { ok: true, agents, ...(owner ? { owner } : {}) }
      if (!tab || !tab.url || !/^https?:/.test(tab.url) || await isWalnutPage(tab.url)) return { ...base, page: null }
      // A tab open since before the extension started gets its page script now (page-reach.ts).
      await reachPage(id!, false, { quick: true })
      const r = await toPage<{ ok?: boolean; walnut?: boolean; url?: string; title?: string; selection?: string; text?: string }>(id!, { type: 'page-context', withText: msg.withText === true }, 8000)
      // A page still loading (no content script yet) is named by its tab alone.
      if (!r?.ok) return { ...base, page: { url: tab.url, title: tab.title ?? '' } }
      if (r.walnut) return { ...base, page: null }
      return { ...base, page: { url: r.url ?? tab.url, title: r.title ?? tab.title ?? '', selection: r.selection ?? '', ...(msg.withText === true ? { text: r.text ?? '' } : {}) } }
    }
    case 'panel-adopt': {
      if (typeof msg.tabId !== 'number' || typeof msg.task !== 'string' || !msg.task) return { ok: false, error: 'No tab or task.' }
      return adoptTab(msg.tabId, msg.task, typeof msg.who === 'string' ? msg.who.slice(0, 80) : undefined)
    }
    case 'panel-release': {
      if (typeof msg.tabId === 'number') await releaseTab(msg.tabId)
      return { ok: true }
    }
    case 'panel-pending': {
      // A selection the context menu asked about, for the panel of that window (taken once).
      const { panelAsk } = await ext.storage.session.get('panelAsk')
      const a = panelAsk as { windowId?: number; text?: string; at?: number } | undefined
      if (!a || a.windowId !== msg.windowId || Date.now() - (a.at ?? 0) > 60_000) return { ok: true }
      await ext.storage.session.remove('panelAsk')
      return { ok: true, text: a.text ?? '' }
    }
    case 'state': {
      // The popup opening is when to find out the person removed this extension in Settings
      // (a refusal forgets the connection, so the popup asks to connect again).
      if (await connection()) await api.checkConnection().catch(() => undefined)
      return { ok: true, ...(await state()) }
    }
    case 'start-connect': return startConnect(String(msg.serverUrl ?? ''))
    case 'pair-code': {
      const conn = await pair(String(msg.serverUrl || DEFAULT_SERVER), String(msg.code ?? ''))
      forget()
      return { ok: true, serverUrl: conn.serverUrl, device: conn.device }
    }
    case 'disconnect': await disconnect(); forget(); return { ok: true }
    case 'vault-status': {
      return { ok: true, status: await api.status() }
    }
    case 'unlock': {
      await api.unlock(String(msg.password ?? ''), typeof msg.secretKey === 'string' && msg.secretKey ? msg.secretKey : undefined)
      forget()
      return { ok: true }
    }
    case 'lock': await api.lock(); forget(); return { ok: true }
    case 'site-items': {
      const tab = await activeTab()
      const page = tab?.url ?? ''
      const site = /^https?:/.test(page) && !(await isWalnutPage(page)) ? page : ''
      return { ok: true, site: site ? displayHost(site) : '', items: site ? await matchesFor(site) : [] }
    }
    case 'search': {
      const q = String(msg.q ?? '').trim().toLowerCase()
      const all = await summaries()
      const hits = all.filter((i) => !q || [i.title, i.username ?? '', ...(i.urls ?? []).map(displayHost)].some((t) => t.toLowerCase().includes(q)))
      return { ok: true, items: hits.slice(0, 50).map((i) => ({ ...view(i), type: i.type })) }
    }
    case 'copy-secret': {
      // The popup copies it itself (it has the person's click); the value goes nowhere else.
      const id = String(msg.id)
      const field = String(msg.field)
      if (field === 'totp') return { ok: true, value: (await api.totp(id)).code }
      const item = await api.item(id)
      const value = field === 'username' ? item.username : field === 'password' ? item.password : undefined
      if (!value) return { ok: false, error: `This item has no ${field}.` }
      void api.used(id)
      return { ok: true, value }
    }
    case 'fill-tab': {
      const tab = await activeTab()
      if (tab?.id === undefined || !tab.url) return { ok: false, error: 'No page to fill.' }
      const item = await api.item(String(msg.id))
      if (!matchItem(item.urls, tab.url)) return { ok: false, code: 'other_site', error: `"${item.title}" is saved for another site; Walnut fills a login only on its own site.` }
      const filled = await fillFrames(tab.id, undefined, credsOf(item), 'login', tab.url)
      if (filled) void api.used(item.id)
      return filled ? { ok: true } : { ok: false, error: 'No login form found on this page.' }
    }
    // generate() holds the sizes to its own limits.
    case 'generate': return { ok: true, value: generate((msg.options as GeneratorOptions | undefined) ?? DEFAULT_PASSWORD) }
    case 'open-walnut': {
      const conn = await connection()
      await ext.tabs.create({ url: `${conn?.serverUrl ?? DEFAULT_SERVER}/passwords` })
      return { ok: true }
    }

    // content script
    case 'page-init': {
      const page = String(sender.url ?? '')
      if (await isWalnutPage(page)) return { ok: true, off: true }
      const st = await state()
      let count = 0
      if (st.unlocked) {
        try { count = (await matchesFor(page)).length } catch { /* locked meanwhile */ }
      }
      // The top page of a tab with a login waiting gets the save bar's nonce, to show it.
      let barNonce: string | undefined
      if (tabId !== undefined && sender.frameId === 0) {
        if (msg.top) {
          // A new top page: frames of another origin can no longer be filled. The rest stay (a
          // frame of this page may have registered first); a stale one refuses a fill itself.
          const o = originOf(page)
          const all = (await frames.get(tabId)) ?? {}
          for (const [id, f] of Object.entries(all)) if (f.origin !== o) delete all[id]
          await frames.set(tabId, all)
        }
        const p = await pendingSave.get(tabId)
        if (p && Date.now() - p.at < PENDING_MS && (siteOf(p.url) === siteOf(page) || Date.now() - p.at < ELSEWHERE_MS)) barNonce = p.nonce
      }
      // An agent's tab wears its frame and Stop button (top frame only).
      const agent = sender.frameId === 0 ? await isAgentTab(tabId) : undefined
      return { ok: true, connected: st.connected, unlocked: st.unlocked, count, ...(barNonce ? { barNonce } : {}), ...(agent ? { agent: { who: agent.who } } : {}) }
    }
    case 'frame-ready': {
      if (tabId === undefined || sender.frameId === undefined) return { ok: false }
      const top = sender.frameId === 0 ? String(sender.url ?? '') : (await ext.tabs.get(tabId).catch(() => undefined))?.url ?? ''
      const origin = originOf(String(sender.url ?? ''))
      if (!origin || origin !== originOf(top) || await isWalnutPage(origin)) return { ok: false }
      const all = (await frames.get(tabId)) ?? {}
      if (msg.hasLogin) all[String(sender.frameId)] = { origin, at: Date.now() }
      else delete all[String(sender.frameId)]
      await frames.set(tabId, all)
      return { ok: true }
    }
    case 'open-menu': {
      if (tabId === undefined || sender.frameId === undefined) return { ok: false }
      const n = nonce()
      await menus.set(tabId, { tabId, frameId: sender.frameId, url: String(sender.url ?? ''), role: String(msg.role), kind: msg.kind as FormKind, nonce: n })
      return { ok: true, nonce: n }
    }
    case 'seen-login': {
      if (tabId === undefined || typeof msg.password !== 'string' || !msg.password) return { ok: false }
      const url = String(sender.url ?? '')
      if (await isWalnutPage(url)) return { ok: false }
      // Only what the person typed, or the strong password Walnut just made here, is offered:
      // a page that fills a field itself and sends the form offers nothing.
      const made = await generated.get(tabId)
      const ours = !!made && Date.now() - made.at < GENERATED_MS && made.password === msg.password && siteOf(made.url) === siteOf(url)
      if (msg.typed !== true && !ours) return { ok: true, offered: false }
      const p = await seenLogin(tabId, url, typeof msg.username === 'string' && msg.username ? msg.username : undefined, msg.password)
      if (ours) await generated.delete(tabId)
      // A page that sends without leaving (a single-page app) gets the bar now; one that leaves gets it on the next page.
      if (p) setTimeout(() => void showSaveBar(tabId), 600)
      return { ok: true, offered: !!p }
    }
    case 'seen-username': {
      if (tabId !== undefined && typeof msg.username === 'string' && msg.username) await seenUsername.set(tabId, { url: String(sender.url ?? ''), username: msg.username, at: Date.now() })
      return { ok: true }
    }
    case 'connect-hello': {
      // Only the tab this extension opened on that Walnut, or the Walnut it is connected to, hears back.
      const origin = String(sender.origin ?? originOf(String(sender.url ?? 'about:blank')))
      const conn = await connection()
      const known = (tabId !== undefined && await connecting.get(tabId) === origin) || conn?.serverUrl === origin
      return known ? { ok: true, connected: conn?.serverUrl === origin, version: ext.runtime.getManifest().version } : { ok: false, silent: true }
    }
    case 'connect-code': {
      const origin = String(sender.origin ?? originOf(String(sender.url ?? 'about:blank')))
      // Silent to any other page: an answer would tell a site this extension is installed.
      if (tabId === undefined || sender.frameId !== 0 || await connecting.get(tabId) !== origin) return { ok: false, silent: true }
      const conn = await pair(origin, String(msg.code ?? ''))
      await connecting.delete(tabId)
      forget()
      return { ok: true, device: conn.device }
    }

    // the in-page menu
    case 'menu-data': {
      const owner = await menuOf(tabId, msg)
      if (!owner) return { ok: false }
      const st = await state()
      if (!st.connected) return { ok: true, state: 'not-connected', role: owner.role, kind: owner.kind }
      if (!st.unlocked) return { ok: true, state: 'locked', role: owner.role, kind: owner.kind }
      const items = await matchesFor(owner.url)
      return { ok: true, state: 'unlocked', role: owner.role, kind: owner.kind, site: displayHost(owner.url), items: owner.role === 'totp' ? items.filter((i) => i.hasTotp) : items }
    }
    case 'menu-fill': {
      const owner = await menuOf(tabId, msg)
      if (!owner) return { ok: false }
      if (!(await stillShown(owner.tabId, owner.frameId, 'menu'))) return COVERED
      const item = await api.item(String(msg.id))
      if (!matchItem(item.urls, owner.url)) return { ok: false, error: 'That login is for another site.' }
      const filled = owner.role === 'totp'
        ? await fillFrames(owner.tabId, owner.frameId, { totp: (await api.totp(item.id)).code }, 'totp', owner.url)
        : await fillFrames(owner.tabId, owner.frameId, credsOf(item), 'login', owner.url)
      if (filled) void api.used(item.id)
      await menus.delete(owner.tabId)
      await ext.tabs.sendMessage(owner.tabId, { type: 'close-menu' }, { frameId: owner.frameId }).catch(() => undefined)
      return { ok: filled }
    }
    case 'menu-generate': {
      const owner = await menuOf(tabId, msg)
      if (!owner) return { ok: false }
      if (!(await stillShown(owner.tabId, owner.frameId, 'menu'))) return COVERED
      const value = generate(DEFAULT_PASSWORD)
      // Kept until the sign-up is sent: it is saved then, typed or not.
      await generated.set(owner.tabId, { password: value, url: owner.url, at: Date.now() })
      await ext.tabs.sendMessage(owner.tabId, { type: 'fill-new-password', password: value, origin: originOf(owner.url) }, { frameId: owner.frameId }).catch(() => undefined)
      await menus.delete(owner.tabId)
      await ext.tabs.sendMessage(owner.tabId, { type: 'close-menu' }, { frameId: owner.frameId }).catch(() => undefined)
      return { ok: true }
    }
    case 'menu-unlock': if (!(await menuOf(tabId, msg))) return { ok: false }; await openUnlock(); return { ok: true }
    // The popup asks for Walnut's address (it may not be this machine's default).
    case 'menu-connect': if (!(await menuOf(tabId, msg))) return { ok: false }; await openUnlock(); return { ok: true }
    case 'menu-close': case 'menu-size': {
      const owner = await menuOf(tabId, msg)
      if (owner) await ext.tabs.sendMessage(owner.tabId, msg.type === 'menu-close' ? { type: 'close-menu' } : { type: 'menu-size', height: msg.height }, { frameId: owner.frameId }).catch(() => undefined)
      return { ok: true }
    }

    // the save bar
    case 'savebar-data': {
      let p = await pendingOf(tabId, msg)
      if (tabId === undefined || !p || Date.now() - p.at > PENDING_MS) return { ok: false }
      const st = await state()
      if (st.unlocked && !p.checked) {
        // Seen while locked: now that it is open, is it new, a changed password, or one already saved?
        const again = await seenLogin(tabId, p.url, p.username, p.password, { at: p.at, nonce: p.nonce })
        if (!again) { await pendingSave.delete(tabId); return { ok: false } }
        p = again
      }
      return { ok: true, kind: st.unlocked ? p.kind : 'locked', site: displayHost(p.url), username: p.username ?? '', title: p.title ?? '' }
    }
    case 'savebar-action': {
      if (tabId === undefined) return { ok: false }
      const action = String(msg.action)
      const hide = () => ext.tabs.sendMessage(tabId, { type: 'hide-savebar' }, { frameId: 0 }).catch(() => undefined)
      const p = await pendingOf(tabId, msg)
      if (action === 'close') { await hide(); return { ok: true } }
      if (!p) { await hide(); return { ok: false } }
      if (action === 'unlock') { await openUnlock(); return { ok: true } }
      // "Not now" needs no check: it only drops the login.
      if (action !== 'later' && !(await stillShown(tabId, 0, 'bar'))) return COVERED
      await pendingSave.delete(tabId)
      if (action === 'never') {
        const list = await neverSites()
        await ext.storage.local.set({ neverSave: [...new Set([...list, siteOf(p.url)])] })
      } else if (action === 'save') {
        await api.create({ type: 'login', title: String(msg.title || p.title || displayHost(p.url)).slice(0, 200), ...(p.username ? { username: p.username } : {}), password: p.password, urls: [originOf(p.url)] })
        forget()
      } else if (action === 'update' && p.itemId) {
        const item = await api.item(p.itemId)
        const { id: _i, createdAt: _c, updatedAt, passwordHistory: _h, usedAt: _u, trashedAt: _t, ...rest } = item
        await api.update(item.id, { ...rest, password: p.password }, updatedAt)
        forget()
      }
      // A save or an update shows its confirmation, then closes itself; the rest close now.
      if (action !== 'save' && action !== 'update') await hide()
      return { ok: true }
    }
    case 'savebar-size': {
      if (tabId !== undefined && await pendingOf(tabId, msg)) await ext.tabs.sendMessage(tabId, { type: 'savebar-size', height: msg.height }, { frameId: 0 }).catch(() => undefined)
      return { ok: true }
    }
  }
  return { ok: false, error: `Unknown message ${msg.type}` }
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return
  // Only this extension's own pages and content scripts.
  if (sender.id !== ext.runtime.id) return
  void sweep().catch(() => undefined)
  handle(msg, sender).then(sendResponse, (err) => sendResponse(fail(err)))
  return true
})

ext.tabs.onRemoved.addListener((tabId) => {
  for (const s of [menus, pendingSave, seenUsername, connecting, frames, generated]) void s.delete(tabId)
})

// After an unlock, the save bar waiting on it in the tab the person is on can save now.
ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && 'vaultSession' in changes) {
    forget()
    if (changes.vaultSession.newValue) void activeTab().then((t) => { if (t?.id !== undefined) void showSaveBar(t.id) })
  }
})

ext.commands?.onCommand.addListener((name, tab) => {
  if (name !== 'fill-login') return
  void (async () => {
    const t = tab ?? await activeTab()
    if (t?.id === undefined || !t.url || !/^https?:/.test(t.url) || await isWalnutPage(t.url)) return
    if (!(await vaultSession())) { await openUnlock(); return }
    const matches = await matchesFor(t.url)
    if (matches.length === 1) {
      const item = await api.item(matches[0].id)
      if (await fillFrames(t.id, undefined, credsOf(item), 'login', t.url)) void api.used(item.id)
    } else {
      // The top page opens its menu; a frame never does from here.
      await ext.tabs.sendMessage(t.id, { type: 'open-menu-here' }, { frameId: 0 }).catch(() => undefined)
    }
  })().catch(() => undefined)
})

initAgent({ isWalnutPage })
initSelfUpdate()

// ── the side panel: the context menu and the toolbar open it ──

/** Opens the panel; called straight from the person's click, before anything is awaited. */
function openPanel(windowId: number | undefined): void {
  if (ext.sidePanel && windowId !== undefined) void ext.sidePanel.open({ windowId }).catch(() => undefined)
  else void ext.sidebarAction?.open().catch(() => undefined)
}

function makeMenus(): void {
  if (!ext.contextMenus) return
  void Promise.resolve(ext.contextMenus.removeAll()).then(() => {
    ext.contextMenus!.create({ id: 'walnut-ask-selection', title: 'Ask Walnut about "%s"', contexts: ['selection'] }, () => void (globalThis as { chrome?: { runtime?: { lastError?: unknown } } }).chrome?.runtime?.lastError)
    ext.contextMenus!.create({ id: 'walnut-ask-page', title: 'Ask Walnut about this page', contexts: ['page'] }, () => void (globalThis as { chrome?: { runtime?: { lastError?: unknown } } }).chrome?.runtime?.lastError)
  }).catch(() => undefined)
}
makeMenus()

ext.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'walnut-ask-selection' && info.menuItemId !== 'walnut-ask-page') return
  openPanel(tab?.windowId)
  const text = info.menuItemId === 'walnut-ask-selection' ? (info.selectionText ?? '').slice(0, 4000) : ''
  if (text && tab?.windowId !== undefined) void ext.storage.session.set({ panelAsk: { windowId: tab.windowId, text, at: Date.now() } })
})

ext.runtime.onInstalled.addListener(() => {
  // Content scripts never read the vault session (Chrome's default; Firefox keeps session storage from them too).
  void ext.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined)
  // The browser puts the page script only into pages loaded from now on: the tabs already open get it now.
  void injectOpenTabs()
})
