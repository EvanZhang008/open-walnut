/**
 * The extension's background: the only part that talks to Walnut and holds the tokens.
 * Content scripts, the in-page menu and the save bar ask it by message; it answers each from
 * the sender's own tab and frame, never from what a message claims about where it came from,
 * and each kind of message only from the page that may send it (senderKind).
 *
 * Secrets: a fill fetches the item and sends its username and password only to frames on the
 * top page's origin that said they hold a login form (or to the one frame whose menu was
 * picked), with that origin, which the frame checks again; it keeps nothing. The summaries
 * (titles, usernames, sites) are cached for 5 s while unlocked (bg-vault.ts).
 *
 * Its parts: bg-vault.ts (summaries, per-tab state), bg-menu.ts (the in-page menu), bg-save.ts
 * (the save bar), bg-fill.ts (fills), bg-clipboard.ts (copy and clear), bg-autolock.ts,
 * bg-badge.ts (the toolbar count).
 */
import { ext, type Sender } from './ext'
import { ApiError, DEFAULT_SERVER, api, call, cleanServerUrl, connection, disconnect, pair, vaultSession } from './walnut-api'
import { displayHost, matchItem } from '../../../src/core/vault/url-match'
import { generate, DEFAULT_PASSWORD, type GeneratorOptions } from '../../../src/core/vault/generator'
import { cursorUp, frameHelloBox } from './agent-cursor'
import { adoptTab, agentMessage, agentOn, initAgent, isAgentTab, releaseAllTabs, releaseTab, relayState, tabOwnerOf } from './agent'
import { initSelfUpdate } from './self-update'
import { injectOpenTabs, reachPage, toPage } from './page-reach'
import { CODE_PAGE_MS, PENDING_MS, activeTab, fail, forget, insecureFor, isWalnutPage, liveState, matchesFor, originOf, pendingAlive, siteOf, state, stores, summaries, tiersOf, view, walletItems, type Reply } from './bg-vault'
import { domainOf } from './login-pick'
import { afterLoginFill, credsOf, fillFrames, fillWalletFrame, openUnlock } from './bg-fill'
import { handleMenu } from './bg-menu'
import { GENERATED_MS, barNonceFor, handleSave, showSaveBar } from './bg-save'
import { clearLater, initClipboard } from './bg-clipboard'
import { initAutoLock, lockIfIdle, touch } from './bg-autolock'
import { clearBadges, initBadge, setBadge } from './bg-badge'
import { walletValues } from './bg-wallet'
import { itemDetail, secretField } from './popup-item-data'
import { getSettings, pageFillOn } from './settings'
import { BROWSER_KEY_MESSAGE, handBrowserKey, handPanelBrowserKey, initHandBrowserKey } from './hand-browser-key'
import { migrateRealInput } from './trusted-switch'

const { pendingSave, pendingPrev, seenUsername, connecting, menus, frames, generated, lastLogin } = stores

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
  await pendingSave.sweep((p) => !pendingAlive(p, now))
  await pendingPrev.sweep((p) => !pendingAlive(p, now))
  await seenUsername.sweep((u) => now - u.at > PENDING_MS)
  await generated.sweep((g) => now - g.at > GENERATED_MS)
  await lastLogin.sweep((l) => now - l.at > CODE_PAGE_MS)
}

const windowOf = (msg: Record<string, unknown>) => (typeof msg.windowId === 'number' && Number.isInteger(msg.windowId) ? msg.windowId : undefined)

async function startConnect(serverUrl: string): Promise<Reply> {
  const origin = cleanServerUrl(serverUrl || DEFAULT_SERVER)
  const tab = await ext.tabs.create({ url: `${origin}/connect-extension`, active: true })
  if (tab.id !== undefined) await connecting.set(tab.id, origin)
  return { ok: true }
}

/**
 * Walnut's Passwords goes to the tab already showing it (review R1-13d: Open vault opened a second
 * one), the person's own window first; any other page of Walnut opens in a new tab.
 */
async function openWalnutTab(url: string): Promise<void> {
  const want = new URL(url)
  if (want.pathname === '/passwords') {
    const all = await ext.tabs.query({}).catch(() => [])
    const onIt = all.filter((t) => { try { const u = new URL(t.url ?? ''); return u.origin === want.origin && u.pathname === '/passwords' } catch { return false } })
    const [mine] = await ext.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
    const t = onIt.find((x) => x.windowId === mine?.windowId) ?? onIt[0]
    if (t?.id !== undefined) {
      // An item to show: that tab goes to it; the list itself stays as the person left it.
      await ext.tabs.update(t.id, { active: true, ...(want.search && t.url !== url ? { url } : {}) })
      if (t.windowId !== undefined) await ext.windows.update?.(t.windowId, { focused: true }).catch(() => undefined)
      return
    }
  }
  await ext.tabs.create({ url })
}

/** Lock this browser's unlock (the auto-lock; the popup's Lock with `everywhere`, every window of Walnut too): the badges go with it. */
async function lockNow(opts: { everywhere?: boolean } = {}): Promise<void> {
  await api.lock(opts)
  forget()
  await clearBadges()
}

/** The count of logins for a tab's page on its toolbar icon (none while locked or on Walnut's pages). */
async function badgeFor(tabId: number, url: string | undefined): Promise<void> {
  if (!url || !/^https?:/.test(url) || !(await vaultSession()) || await isWalnutPage(url)) { await setBadge(tabId, 0); return }
  await setBadge(tabId, await matchesFor(url).then((m) => m.length, () => 0))
}

// ── who may send what ──

type SenderKind = 'popup' | 'menu' | 'savebar' | 'content' | 'sidepanel'

function senderKind(sender: Sender): SenderKind | null {
  const url = String(sender.url ?? '')
  const own = ext.runtime.getURL('')
  if (url.startsWith(own)) {
    const page = url.slice(own.length).split(/[?#]/)[0]
    // popup-ask.html is the toolbar popup on Ask: the side panel's own page in its popup form.
    return page === 'popup.html' ? 'popup' : page === 'menu.html' ? 'menu' : page === 'savebar.html' ? 'savebar' : page === 'sidepanel.html' || page === 'popup-ask.html' ? 'sidepanel' : null
  }
  return sender.tab?.id !== undefined && /^https?:/.test(url) ? 'content' : null
}

/**
 * Which page may send what. The side panel draws the key popover (key-pop.ts) over Walnut's frame,
 * so it unlocks, lists this site's logins and fills them as the popup does.
 */
const ALLOWED: Record<string, SenderKind | SenderKind[]> = {
  state: ['popup', 'sidepanel'], 'vault-watch': ['popup', 'sidepanel'], 'start-connect': 'popup', 'pair-code': 'popup', disconnect: 'popup', 'vault-status': ['popup', 'sidepanel'],
  unlock: ['popup', 'sidepanel'], lock: 'popup', 'site-items': ['popup', 'sidepanel'], search: 'popup', 'copy-secret': 'popup', 'fill-tab': ['popup', 'sidepanel'],
  generate: 'popup', 'open-walnut': ['popup', 'sidepanel'], 'totp-code': 'popup', copied: ['popup', 'sidepanel'], 'wallet-items': 'popup', 'item-detail': 'popup',
  'site-count': 'sidepanel', 'unlock-for': 'sidepanel',
  'page-init': 'content', 'frame-ready': 'content', 'open-menu': 'content', 'menu-focus': 'content', 'seen-login': 'content', 'seen-username': 'content',
  'connect-hello': 'content', 'connect-code': 'content',
  'menu-data': 'menu', 'menu-codes': 'menu', 'menu-fill': 'menu', 'menu-generate': 'menu', 'menu-regenerate': 'menu', 'menu-copied': 'menu',
  'menu-unlock': 'menu', 'menu-connect': 'menu', 'menu-close': 'menu', 'menu-size': 'menu',
  'savebar-data': 'savebar', 'savebar-action': 'savebar', 'savebar-size': 'savebar',
  // The side panel's first page has the relay switch too (ExtRelay.tsx).
  'agent-get': ['popup', 'sidepanel'], 'agent-on': ['popup', 'sidepanel'], 'agent-off': ['popup', 'sidepanel'], 'agent-stop': 'content', 'agent-handback': 'content',
  // A frame's step: its point for the agent's cursor in the top document (agent-cursor.ts).
  'agent-cursor-up': 'content',
  'agent-frame-hello-box': 'content',
  'relay-state': 'sidepanel', 'relay-stop-all': 'sidepanel',
  'page-selection': 'content',
  'panel-state': 'sidepanel', 'panel-page': 'sidepanel', 'panel-adopt': 'sidepanel', 'panel-release': 'sidepanel', 'panel-pending': 'sidepanel', 'panel-hand': 'sidepanel',
  [BROWSER_KEY_MESSAGE]: 'content',
  // The panel's own Walnut frame shares the extension's unlock (hand-browser-key.ts handPanelBrowserKey).
  'panel-browser-key': 'sidepanel',
}

/**
 * Something left for the panel of one window (a selection the context menu asked about, the
 * popup's question) is taken by one panel only: two takes run one after the other, so the second
 * finds it gone (R1-16: two panels of one window both read the popup's question, and it made two asks).
 */
let taking: Promise<unknown> = Promise.resolve()
function takeOnce<T>(key: 'panelAsk' | 'panelHand', windowId: unknown): Promise<T | undefined> {
  const run = async (): Promise<T | undefined> => {
    const v = (await ext.storage.session.get(key))[key] as ({ windowId?: number; at?: number } & T) | undefined
    if (!v || v.windowId !== windowId || Date.now() - (v.at ?? 0) > 60_000) return undefined
    await ext.storage.session.remove(key)
    return v
  }
  const p = taking.then(run, run)
  taking = p.catch(() => undefined)
  return p
}
/** What a person does with Walnut (not a page loading by itself): it keeps the auto-lock away. */
const USE = new Set(['unlock', 'site-items', 'search', 'item-detail', 'copy-secret', 'fill-tab', 'totp-code', 'wallet-items', 'open-menu', 'menu-fill', 'menu-generate', 'savebar-action'])

// ── the message router ──

async function handle(msg: { type: string; [k: string]: unknown }, sender: Sender): Promise<Reply> {
  const kind = senderKind(sender)
  const may = ALLOWED[msg.type]
  if (!kind || !(Array.isArray(may) ? may.includes(kind) : may === kind)) return { ok: false, error: `Not for this page: ${msg.type}` }
  // The chosen time passed with no use: locked before anything is answered.
  await lockIfIdle(lockNow).catch(() => false)
  if (USE.has(msg.type)) void touch()
  if (msg.type === BROWSER_KEY_MESSAGE) return handBrowserKey(msg, sender)
  if (msg.type === 'panel-browser-key') return handPanelBrowserKey(msg)
  if (kind === 'menu' || msg.type === 'open-menu' || msg.type === 'menu-focus') return handleMenu(msg, sender)
  if (kind === 'savebar' || msg.type === 'seen-login' || msg.type === 'seen-username') return handleSave(msg, sender)
  const tabId = sender.tab?.id
  switch (msg.type) {
    // popup
    case 'agent-get': case 'agent-on': case 'agent-off': case 'agent-stop': case 'agent-handback': return agentMessage(msg.type, sender)
    // A step in a frame: the agent's cursor is drawn in the top document at the frame's place (agent-cursor.ts).
    case 'agent-cursor-up': return cursorUp(msg, sender)
    // The document holding a frame says where that frame starts (agent-cursor.ts helloOrigin).
    case 'agent-frame-hello-box': return frameHelloBox(msg, sender)
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
      // `askPanel`: it opens as Walnut's own Ask (browser-v1.ts); unknown while Walnut does not answer.
      const r = await call<{ askPanel?: unknown }>('GET', '/browser/panel', undefined, { noSession: true, quiet: true, timeoutMs: 8000 })
        .then((b) => ({ has: true, ask: typeof b.askPanel === 'number' && b.askPanel >= 2 }), (err) => ({ has: !(err instanceof ApiError && err.status === 404), ask: err instanceof ApiError && err.status === 404 ? false : undefined }))
      return { ok: true, connected: true, serverUrl: conn.serverUrl, panel: r.has, ...(r.ask !== undefined ? { askPanel: r.ask } : {}) }
    }
    case 'site-count': {
      // The key button's count of this site's logins: only while this browser holds an unlock, and
      // never a use (the auto-lock waits for the person, not for the panel looking).
      if (!(await vaultSession())) return { ok: true, count: null }
      const tab = await activeTab(windowOf(msg))
      const page = tab?.url ?? ''
      // No site here (a Walnut page, a new tab): none of its logins, so the drawer says so (R1-13b).
      if (!/^https?:/.test(page) || await isWalnutPage(page)) return { ok: true, count: 0, site: '' }
      return { ok: true, count: (await tiersOf(page)).first.length, site: displayHost(page) }
    }
    case 'unlock-for': {
      // How long an unlock lasts, for the key popover's one line (Walnut's setting, when it is followed).
      const s = await getSettings()
      if (s.autoLock !== 'walnut') return { ok: true, autoLock: s.autoLock }
      const st = await api.status().catch(() => null) as { unlockFor?: string } | null
      return { ok: true, autoLock: s.autoLock, ...(st?.unlockFor ? { unlockFor: st.unlockFor } : {}) }
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
      // The panel's first word: the tab's address and title, before the page itself is asked
      // (a page that does not answer held the panel on "Connecting" for the page's whole timeout).
      if (msg.quick === true) return { ...base, page: { url: tab.url, title: tab.title ?? '' } }
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
    case 'relay-state': return { ok: true, ...(await relayState()) }
    case 'relay-stop-all': {
      await releaseAllTabs()
      return { ok: true }
    }
    case 'panel-pending': {
      // A selection the context menu asked about, for the panel of that window (taken once).
      const a = await takeOnce<{ text?: string }>('panelAsk', msg.windowId)
      return a ? { ok: true, text: a.text ?? '' } : { ok: true }
    }
    case 'panel-hand': {
      // The popup's question (or ask to show) for the side panel of that window (taken once).
      const hand = await takeOnce<{ ask?: unknown; open?: unknown; view?: unknown }>('panelHand', msg.windowId)
      return hand ? { ok: true, hand: { ask: hand.ask, open: hand.open, view: hand.view } } : { ok: true }
    }
    case 'state': {
      // The popup opening is when to find out the person removed this extension in Settings
      // (a refusal forgets the connection, so the popup asks to connect again).
      if (await connection()) await api.checkConnection().catch(() => undefined)
      return { ok: true, ...(await liveState()) }
    }
    // An open popup or side panel follows the vault: Walnut locked it, or the person unlocked it in another window.
    case 'vault-watch': return { ok: true, ...(await liveState()) }
    case 'start-connect': return startConnect(String(msg.serverUrl ?? ''))
    case 'pair-code': {
      const conn = await pair(String(msg.serverUrl || DEFAULT_SERVER), String(msg.code ?? ''))
      forget()
      return { ok: true, serverUrl: conn.serverUrl, device: conn.device }
    }
    case 'disconnect': await disconnect(); forget(); await clearBadges(); return { ok: true }
    case 'vault-status': return { ok: true, status: await api.status() }
    case 'unlock': {
      await api.unlock(String(msg.password ?? ''), typeof msg.secretKey === 'string' && msg.secretKey ? msg.secretKey : undefined)
      forget()
      await touch(true)
      return { ok: true }
    }
    case 'lock': await lockNow({ everywhere: true }); return { ok: true }
    case 'site-items': {
      const tab = await activeTab(windowOf(msg))
      const page = tab?.url ?? ''
      const site = /^https?:/.test(page) && !(await isWalnutPage(page)) ? page : ''
      const { first: items, others } = site ? await tiersOf(site) : { first: [], others: [] }
      // A plain http page whose logins are saved for https: the popup says why none is offered.
      const insecure = site && !items.length ? await insecureFor(site) : 0
      return { ok: true, site: site ? displayHost(site) : '', items, ...(others.length ? { others, othersDomain: domainOf(site) } : {}), insecure }
    }
    case 'wallet-items': return { ok: true, cards: await walletItems('card'), identities: await walletItems('identity') }
    case 'search': {
      const q = String(msg.q ?? '').trim().toLowerCase()
      const all = await summaries()
      const hits = all.filter((i) => !q || [i.title, i.username ?? '', ...(i.urls ?? []).map(displayHost)].some((t) => t.toLowerCase().includes(q)))
      return { ok: true, items: hits.slice(0, 50).map((i) => ({ ...view(i), type: i.type })) }
    }
    case 'totp-code': return { ok: true, ...(await api.totp(String(msg.id))) }
    case 'copy-secret': {
      // The popup copies it itself (it has the person's click); the value goes nowhere else.
      const id = String(msg.id)
      const field = String(msg.field)
      if (field === 'totp') return { ok: true, value: (await api.totp(id)).code }
      const item = await api.item(id)
      const value = secretField(item, field)
      if (!value) return { ok: false, error: `This item has no ${field === 'code' ? 'security code' : field === 'number' ? 'card number' : field.startsWith('field:') ? 'such field' : field}.` }
      void api.used(id)
      return { ok: true, value }
    }
    case 'copied': {
      // The popup put a secret on the clipboard: it is cleared in 30 s if it is still there.
      if (typeof msg.value === 'string' && msg.value) await clearLater(msg.value.slice(0, 4000))
      return { ok: true }
    }
    case 'fill-tab': {
      const tab = await activeTab(windowOf(msg))
      if (tab?.id === undefined || !tab.url) return { ok: false, error: 'No page to fill.' }
      const item = await api.item(String(msg.id))
      if (item.type === 'card' || item.type === 'identity') {
        const filled = await fillWalletFrame(tab.id, 0, walletValues(item) as Record<string, string>, item.type, tab.url)
        if (filled) void api.used(item.id)
        return filled ? { ok: true } : { ok: false, error: item.type === 'card' ? 'No card form found on this page.' : 'No address form found on this page.' }
      }
      if (!matchItem(item.urls, tab.url)) return { ok: false, code: 'other_site', error: `"${item.title}" is saved for another site; Walnut fills a login only on its own site.` }
      const filled = await fillFrames(tab.id, undefined, credsOf(item), 'login', tab.url)
      if (!filled) return { ok: false, error: 'No login form found on this page.' }
      return { ok: true, ...(await afterLoginFill(tab.id, undefined, item, tab.url)) }
    }
    // generate() holds the sizes to its own limits.
    case 'generate': return { ok: true, value: generate((msg.options as GeneratorOptions | undefined) ?? DEFAULT_PASSWORD) }
    // The popup's detail view of one item: what it holds, its secrets only named (popup-item-data.ts).
    case 'item-detail': return { ok: true, item: itemDetail(await api.item(String(msg.id))) }
    case 'open-walnut': {
      const conn = await connection()
      // An item opens in Walnut's Passwords; `settings` is the Browser extension pane.
      // `path`: a page of Walnut the side panel's Ask names (Open Walnut, a task).
      const where = msg.to === 'settings' ? '/settings#browser'
        : typeof msg.path === 'string' && /^\/(?!\/)[\w\-./?=&%#]{0,300}$/.test(msg.path) ? msg.path
        : typeof msg.item === 'string' && /^[\w-]{1,80}$/.test(msg.item) ? `/passwords?item=${encodeURIComponent(msg.item)}` : '/passwords'
      await openWalnutTab(`${conn?.serverUrl ?? DEFAULT_SERVER}${where}`)
      return { ok: true }
    }

    // content script
    case 'page-init': {
      const page = String(sender.url ?? '')
      if (await isWalnutPage(page)) return { ok: true, off: true }
      const st = await state()
      let count = 0
      /** Logins saved for other parts of this site (tier 2): the menu lists them apart; never counted or offered first. */
      let others = 0
      let codes = 0
      let cards = 0
      let identities = 0
      if (st.unlocked) {
        try {
          const t = await tiersOf(page)
          const m = t.first
          count = m.length
          others = t.others.length
          codes = m.filter((i) => i.hasTotp).length
          const all = await summaries()
          cards = all.filter((i) => i.type === 'card').length
          identities = all.filter((i) => i.type === 'identity').length
        } catch { /* locked meanwhile */ }
      }
      let barNonce: string | undefined
      let offerCode = false
      // "Fill and save on web pages" (Settings): off, the page draws no icon, menu or bar of its own.
      const pageFill = await pageFillOn()
      if (tabId !== undefined && sender.frameId === 0) {
        if (msg.top) {
          // A new top page: frames of another origin can no longer be filled. The rest stay (a
          // frame of this page may have registered first); a stale one refuses a fill itself.
          const o = originOf(page)
          const all = (await frames.get(tabId)) ?? {}
          for (const [id, f] of Object.entries(all)) if (f.origin !== o) delete all[id]
          await frames.set(tabId, all)
          void setBadge(tabId, count)
        }
        if (pageFill) barNonce = await barNonceFor(tabId, page)
      }
      // The code page after a sign in Walnut filled or saw: its menu offers that login's code.
      if (tabId !== undefined && codes > 0 && pageFill) {
        const last = await lastLogin.get(tabId)
        offerCode = !!last && last.hasTotp && Date.now() - last.at < CODE_PAGE_MS && siteOf(last.url) === siteOf(page)
      }
      // An agent's tab wears its frame and Stop button (top frame only).
      const agent = sender.frameId === 0 ? await isAgentTab(tabId) : undefined
      return { ok: true, pageFill, connected: st.connected, unlocked: st.unlocked, count, ...(others ? { others } : {}), codes, cards, identities, ...(offerCode ? { offerCode } : {}), ...(barNonce ? { barNonce } : {}), ...(agent ? { agent: { who: agent.who, ...(typeof agent.driving === 'number' ? { driving: true } : {}) } } : {}) }
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
      // The person's choice on the connect page (on by default there): agents may use this
      // browser. Asked only here, at a connect: an install already connected keeps its own (R1-7).
      if (typeof msg.agents === 'boolean') await agentMessage(msg.agents ? 'agent-on' : 'agent-off', sender)
      return { ok: true, device: conn.device, agents: typeof msg.agents === 'boolean' ? msg.agents : undefined }
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
  for (const s of [menus, pendingSave, pendingPrev, seenUsername, connecting, frames, generated, lastLogin]) void s.delete(tabId)
})

// The toolbar count follows the tab the person is on.
ext.tabs.onActivated.addListener((info) => { void ext.tabs.get(info.tabId).then((t) => badgeFor(info.tabId, t.url), () => undefined) })
ext.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.url || change.status === 'complete') void badgeFor(tabId, tab.url) })

// After an unlock, the save bar waiting on it in the tab the person is on can save now; a lock clears the counts.
ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && 'vaultSession' in changes) {
    forget()
    if (changes.vaultSession.newValue) {
      void activeTab().then((t) => { if (t?.id !== undefined) { void showSaveBar(t.id); void badgeFor(t.id, t.url) } })
    } else void clearBadges()
  }
})

/** Fill the login for a tab: the one there is, else its menu (in the frame asked, the top page by default). */
async function fillFromBrowser(t: { id?: number; url?: string } | undefined, frameId?: number): Promise<void> {
  if (t?.id === undefined || !t.url || !/^https?:/.test(t.url) || await isWalnutPage(t.url)) return
  // The chosen idle time passed with no use: locked first, as for every message (handle), so the
  // shortcut or the context menu never fills from a session the auto-lock should have ended.
  await lockIfIdle(lockNow).catch(() => false)
  if (!(await connection()) || !(await vaultSession())) { await openUnlock(); return }
  void touch()
  const matches = await matchesFor(t.url)
  if (matches.length === 1) {
    const item = await api.item(matches[0].id)
    if (await fillFrames(t.id, frameId, credsOf(item), 'login', t.url)) await afterLoginFill(t.id, frameId, item, t.url)
  } else {
    await ext.tabs.sendMessage(t.id, { type: 'open-menu-here', ...(frameId ? { here: true } : {}) }, { frameId: frameId ?? 0 }).catch(() => undefined)
  }
}

ext.commands?.onCommand.addListener((name, tab) => {
  if (name !== 'fill-login') return
  // The top page opens its menu; a frame never does from here.
  void (async () => fillFromBrowser(tab ?? await activeTab()))().catch(() => undefined)
})

initAgent({ isWalnutPage })
initSelfUpdate()
initClipboard()
initBadge()
initAutoLock(lockNow)
initHandBrowserKey()

// ── the side panel and the context menu ──

/** Opens the panel; called straight from the person's click, before anything is awaited. */
function openPanel(windowId: number | undefined): void {
  if (ext.sidePanel && windowId !== undefined) void ext.sidePanel.open({ windowId }).catch(() => undefined)
  else void ext.sidebarAction?.open().catch(() => undefined)
}

function makeMenus(): void {
  if (!ext.contextMenus) return
  const done = () => void (globalThis as { chrome?: { runtime?: { lastError?: unknown } } }).chrome?.runtime?.lastError
  void Promise.resolve(ext.contextMenus.removeAll()).then(() => {
    ext.contextMenus!.create({ id: 'walnut-fill', title: 'Fill with Walnut', contexts: ['editable'] }, done)
    ext.contextMenus!.create({ id: 'walnut-ask-selection', title: 'Quick question about "%s"', contexts: ['selection'] }, done)
    ext.contextMenus!.create({ id: 'walnut-ask-page', title: 'Quick question about this page', contexts: ['page'] }, done)
  }).catch(() => undefined)
}
makeMenus()

ext.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'walnut-fill') {
    // The login for the page (the one, or the list in the frame the person right-clicked in).
    if (!(tab?.id !== undefined && tab.url)) return
    if (info.frameId === undefined || info.frameId === 0 || originOf(info.frameUrl ?? '') === originOf(tab.url)) void fillFromBrowser(tab, info.frameId || undefined).catch(() => undefined)
    return
  }
  if (info.menuItemId !== 'walnut-ask-selection' && info.menuItemId !== 'walnut-ask-page') return
  openPanel(tab?.windowId)
  const text = info.menuItemId === 'walnut-ask-selection' ? (info.selectionText ?? '').slice(0, 4000) : ''
  if (text && tab?.windowId !== undefined) void ext.storage.session.set({ panelAsk: { windowId: tab.windowId, text, at: Date.now() } })
})

// Once, at the first start of a build that keeps real input apart from the debugger permission:
// a person who had real input on (the permission held) keeps it (trusted-switch.ts).
void migrateRealInput().catch(() => undefined)

ext.runtime.onInstalled.addListener(() => {
  // Content scripts never read the vault session (Chrome's default; Firefox keeps session storage from them too).
  void ext.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined)
  // The browser puts the page script only into pages loaded from now on: the tabs already open get it now.
  void injectOpenTabs()
})
