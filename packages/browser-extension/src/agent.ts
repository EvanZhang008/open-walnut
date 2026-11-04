/**
 * Walnut agents in this browser (the server side is core/browser-control/hub.ts). Off until
 * the person turns it on in the popup. Then the background asks Walnut for work (a long poll
 * with its device token), runs each command, and posts the result.
 *
 * What an agent can reach: only tabs it opened, in one Walnut agent window of their own (the
 * person's tabs are never listed or touched), only on sites the person allowed (each command
 * carries the list, checked here against the tab's real address), never Walnut's own pages or
 * the browser's. Each agent tab wears a frame and a Stop button; Stop gives the tab back.
 */
import { ext, isFirefox, type Sender, type Tab } from './ext'
import { ApiError, call, connection } from './walnut-api'
import { siteKey } from '../../../src/core/vault/url-match'
import { tabStore } from './tab-store'
import { walnutAddress } from './walnut-address'

interface WireCommand { id: string; action: string; args: Record<string, unknown>; allow: { any: boolean; sites: string[]; walnut?: string[] } }

class AgentError extends Error {
  constructor(message: string, readonly code: string, readonly extra: Record<string, unknown> = {}) { super(message) }
}

/** The agent tabs and who opened each (a task's owner key) and its name for the frame. */
const agentTabs = tabStore<{ owner: string; who?: string; history?: string[] }>('agentTabs')
const HISTORY_MAX = 30
const PAGE_OPS = new Set(['snapshot', 'text', 'click', 'type', 'select', 'press', 'scroll', 'wait'])
/** After these the page may load something new: wait for it before answering. */
const MAY_NAVIGATE = new Set(['click', 'press', 'type', 'select'])

let isWalnutPage: (url: string) => Promise<boolean> = async () => false

export async function agentOn(): Promise<boolean> {
  return (await ext.storage.local.get('agentControl')).agentControl === true
}

export async function isAgentTab(tabId: number | undefined): Promise<{ owner: string; who?: string } | undefined> {
  return tabId === undefined ? undefined : agentTabs.get(tabId)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function allowed(allow: WireCommand['allow'], url: string): boolean {
  const site = siteKey(url)?.domain
  if (!site) return false
  return allow.any || allow.sites.includes(site)
}

/** The page may be an agent's: a web page, not Walnut, on an allowed site. */
async function checkPage(allow: WireCommand['allow'], url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new AgentError('Agents use web pages only (http or https).', 'not_a_web_page')
  if (await isWalnutPage(url) || walnutAddress(allow.walnut, url)) throw new AgentError('Agents never use Walnut\'s own pages in the browser.', 'walnut_page')
  if (!allowed(allow, url)) throw new AgentError('That site is not allowed for agents yet.', 'site_not_allowed', { url, site: siteKey(url)?.domain })
}

/** Resolves when the tab has finished loading (or after `ms`). */
function loaded(tabId: number, ms = 30_000): Promise<void> {
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
function settled(tabId: number): Promise<void> {
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

async function agentWindow(url: string): Promise<Tab> {
  const { agentWindow: id } = await ext.storage.session.get('agentWindow')
  if (typeof id === 'number') {
    const w = await ext.windows.get(id).catch(() => null)
    if (w) return ext.tabs.create({ url, windowId: id, active: true })
  }
  // A window of its own, behind the person's: agents never take their tabs or their focus.
  const w = await ext.windows.create({ url, focused: false, width: 1280, height: 900, type: 'normal' })
  await ext.storage.session.set({ agentWindow: w.id })
  return w.tabs?.[0] ?? (await ext.tabs.query({ active: true, windowId: w.id }))[0] ?? {}
}

/** The page's own word on what it is (its content script reads the document now loaded). */
async function pageCheck(tabId: number): Promise<{ walnut: boolean; href: string } | null> {
  const r = await ext.tabs.sendMessage(tabId, { type: 'agent-check' }, { frameId: 0 }).catch(() => null) as { ok?: boolean; walnut?: boolean; href?: string } | null
  return r?.ok ? { walnut: r.walnut === true, href: String(r.href ?? '') } : null
}

async function mark(tabId: number, on: boolean, who?: string): Promise<void> {
  await ext.tabs.sendMessage(tabId, { type: 'agent-mark', on, ...(who ? { who } : {}) }, { frameId: 0 }).catch(() => undefined)
}

async function ownTab(args: Record<string, unknown>): Promise<{ tabId: number; tab: Tab }> {
  const tabId = typeof args.tab === 'number' ? args.tab : NaN
  if (!(await agentTabs.get(tabId))) throw new AgentError('That tab is not one an agent opened (or the person took it back with Stop).', 'not_your_tab')
  const tab = await ext.tabs.get(tabId).catch(() => null)
  if (!tab) { await agentTabs.delete(tabId); throw new AgentError('That tab was closed.', 'not_your_tab') }
  return { tabId, tab }
}

const where = async (tabId: number) => { const t = await ext.tabs.get(tabId).catch(() => ({} as Tab)); return { tab: tabId, url: t.url, title: t.title } }

async function act(c: WireCommand): Promise<unknown> {
  const a = c.args
  switch (c.action) {
    case 'tabs': {
      const out: Array<{ id: number; url?: string; title?: string; owner: string }> = []
      for (const id of await agentTabs.keys()) {
        const t = await ext.tabs.get(id).catch(() => null)
        const o = await agentTabs.get(id)
        if (!t || !o) { await agentTabs.delete(id); continue }
        out.push({ id, url: t.url, title: t.title, owner: o.owner })
      }
      return { tabs: out }
    }
    case 'open': {
      const url = String(a.url ?? '')
      await checkPage(c.allow, url)
      if (typeof a.owner !== 'string' || !a.owner) throw new AgentError('No owner for the tab.', 'bad_request')
      const t = await agentWindow(url)
      if (t.id === undefined) throw new AgentError('The browser did not open the tab.', 'open_failed')
      const who = typeof a.who === 'string' ? a.who : undefined
      await agentTabs.set(t.id, { owner: a.owner, ...(who ? { who } : {}), history: [url] })
      await loaded(t.id)
      // What loaded may be Walnut itself under another address (its tunnel, a host's own server).
      if ((await pageCheck(t.id))?.walnut) {
        await agentTabs.delete(t.id)
        await ext.tabs.remove(t.id).catch(() => undefined)
        throw new AgentError('Agents never use Walnut\'s own pages in the browser.', 'walnut_page')
      }
      await mark(t.id, true, who)
      return where(t.id)
    }
    case 'navigate': {
      const { tabId, tab } = await ownTab(a)
      const url = String(a.url ?? '')
      await checkPage(c.allow, url)
      await checkPage(c.allow, tab.url ?? '')
      await ext.tabs.update(tabId, { url })
      await sleep(100)
      await loaded(tabId)
      return where(tabId)
    }
    case 'back': {
      const { tabId, tab } = await ownTab(a)
      const went = await ext.tabs.goBack(tabId).then(() => true, () => false)
      if (!went) {
        // Chrome skips, on Back, a page that moved on without a person's gesture (an agent's
        // click is not one): go to the address before this one in the tab's own list.
        const rec = await agentTabs.get(tabId)
        const list = rec?.history ?? []
        const i = list.lastIndexOf(tab.url ?? '')
        const prev = i > 0 ? list[i - 1] : undefined
        if (!prev) throw new AgentError('There is no page to go back to.', 'no_history')
        await checkPage(c.allow, prev)
        await agentTabs.update(tabId, (r) => ({ ...r, history: list.slice(0, i) }))
        await ext.tabs.update(tabId, { url: prev })
      }
      await sleep(100)
      await loaded(tabId)
      return where(tabId)
    }
    case 'close': {
      const { tabId } = await ownTab(a)
      await agentTabs.delete(tabId)
      await ext.tabs.remove(tabId).catch(() => undefined)
      return { tab: tabId, closed: true }
    }
    case 'screenshot': {
      const { tabId, tab } = await ownTab(a)
      await checkPage(c.allow, tab.url ?? '')
      const before = await pageCheck(tabId)
      if (!before) throw new AgentError('The page is not ready (still loading, or a page the extension cannot reach): wait and try again.', 'page_not_ready')
      if (before.walnut) throw new AgentError('Agents never use Walnut\'s own pages in the browser.', 'walnut_page')
      await checkPage(c.allow, before.href)
      // Only a tab on screen in its window can be captured: bring it up there, in the agent window.
      await ext.tabs.update(tabId, { active: true })
      // A password the page shows as text (its "show" button) is drawn as dots for the capture.
      const mask = await ext.tabs.sendMessage(tabId, { type: 'agent-mask', on: true }, { frameId: 0 }).catch(() => null) as { ok?: boolean } | null
      if (!mask?.ok) throw new AgentError('The page is not ready: wait and try again.', 'page_not_ready')
      await sleep(250)
      let image: string
      try {
        image = await ext.tabs.captureVisibleTab(tab.windowId!, { format: 'jpeg', quality: 70 })
      } finally {
        await ext.tabs.sendMessage(tabId, { type: 'agent-mask', on: false }, { frameId: 0 }).catch(() => undefined)
      }
      // What was on screen must still be that tab on that page (not a window the page opened).
      const [shown] = await ext.tabs.query({ active: true, windowId: tab.windowId })
      if (shown?.id !== tabId || siteKey(shown.url ?? '')?.domain !== siteKey(before.href)?.domain) {
        throw new AgentError('The page changed while the screenshot was taken: try again.', 'page_changed')
      }
      return { ...(await where(tabId)), image }
    }
  }
  if (PAGE_OPS.has(c.action)) {
    const { tabId, tab } = await ownTab(a)
    await checkPage(c.allow, tab.url ?? '')
    const r = await ext.tabs.sendMessage(tabId, { type: 'agent', op: c.action, args: a, allow: c.allow }, { frameId: 0 }).catch(() => null) as { ok: boolean; result?: Record<string, unknown>; error?: { message: string; code: string; extra?: Record<string, unknown> } } | null
    if (!r) throw new AgentError('The page is not ready (still loading, or a page the extension cannot reach): wait and try again.', 'page_not_ready')
    if (!r.ok) throw new AgentError(r.error?.message ?? 'The page could not do that.', r.error?.code ?? 'page_error', r.error?.extra ?? {})
    if (MAY_NAVIGATE.has(c.action)) await settled(tabId)
    return { ...r.result, ...(await where(tabId)) }
  }
  throw new AgentError(`Unknown action ${c.action}.`, 'bad_action')
}

async function run(c: WireCommand): Promise<void> {
  let body: Record<string, unknown>
  try {
    // The person may have turned agents off since this poll left.
    if (!(await agentOn())) throw new AgentError('The person turned agents off in this browser.', 'browser_off')
    body = { id: c.id, ok: true, result: await act(c) }
  } catch (err) {
    body = { id: c.id, ok: false, error: { message: err instanceof Error ? err.message : String(err), code: err instanceof AgentError ? err.code : 'browser_error', ...(err instanceof AgentError ? { extra: err.extra } : {}) } }
  }
  await call('POST', '/browser/result', body, { noSession: true, timeoutMs: 20_000 }).catch(() => undefined)
}

async function report(): Promise<Array<{ id: number; owner: string }>> {
  const out: Array<{ id: number; owner: string }> = []
  for (const id of await agentTabs.keys()) {
    const o = await agentTabs.get(id)
    if (o && await ext.tabs.get(id).catch(() => null)) out.push({ id, owner: o.owner })
    else await agentTabs.delete(id)
  }
  return out
}

let running = false

/** Ask Walnut for work while agents are on and the extension is connected. */
export async function agentLoop(): Promise<void> {
  if (running) return
  running = true
  // An extension call every 20 s keeps the background alive between polls.
  const keep = setInterval(() => { void ext.runtime.getPlatformInfo().catch(() => undefined) }, 20_000)
  let backoff = 1000
  try {
    while (await agentOn() && await connection()) {
      try {
        const caps = (await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false)) ? ['screenshot'] : []
        const r = await call<{ commands: WireCommand[] }>('POST', '/browser/poll', {
          browser: isFirefox ? 'firefox' : 'chrome', version: ext.runtime.getManifest().version, caps, tabs: await report(), waitMs: 25_000,
        }, { noSession: true, timeoutMs: 40_000 })
        backoff = 1000
        for (const c of r.commands ?? []) void run(c)
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'not_connected' || err.code === 'token_refused' || err.code === 'not_paired' || err.code === 'not_extension')) break
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  } finally {
    clearInterval(keep)
    running = false
  }
}

/** The person turned agents off: Walnut hears it, and every agent tab is theirs again. */
export async function agentOff(): Promise<void> {
  await call('POST', '/browser/off', {}, { noSession: true, timeoutMs: 8000 }).catch(() => undefined)
  for (const id of await agentTabs.keys()) { await mark(id, false); await agentTabs.delete(id) }
}

/** Messages about agents: the popup's switch and a tab's Stop. */
export async function agentMessage(type: string, sender: Sender): Promise<Record<string, unknown> & { ok: boolean }> {
  switch (type) {
    case 'agent-get': {
      const on = await agentOn()
      const tabs = (await agentTabs.keys()).length
      return { ok: true, on, tabs, screenshots: await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false) }
    }
    case 'agent-on': {
      await ext.storage.local.set({ agentControl: true })
      void agentLoop()
      return { ok: true }
    }
    case 'agent-off': {
      await ext.storage.local.set({ agentControl: false })
      await agentOff()
      return { ok: true }
    }
    case 'agent-stop': {
      const id = sender.tab?.id
      if (id !== undefined) await agentTabs.delete(id)
      return { ok: true }
    }
  }
  return { ok: false, error: `Unknown message ${type}` }
}

export function initAgent(deps: { isWalnutPage: (url: string) => Promise<boolean> }): void {
  isWalnutPage = deps.isWalnutPage
  ext.tabs.onRemoved.addListener((tabId) => { void agentTabs.delete(tabId) })
  // Each agent tab's own list of addresses, for Back when the browser skips one.
  ext.tabs.onUpdated.addListener((tabId, change: { url?: string }) => {
    const url = change.url
    if (!url) return
    void agentTabs.update(tabId, (rec) => {
      const list = rec.history ?? []
      return list[list.length - 1] === url ? rec : { ...rec, history: [...list, url].slice(-HISTORY_MAX) }
    })
  })
  ext.windows.onRemoved?.addListener((windowId) => {
    void ext.storage.session.get('agentWindow').then((s) => { if (s.agentWindow === windowId) void ext.storage.session.remove('agentWindow') })
  })
  // The background may have been stopped: an alarm, a browser start or the switch brings the loop back.
  void Promise.resolve(ext.alarms.create('walnut-agent', { periodInMinutes: 1 })).catch(() => undefined)
  ext.alarms.onAlarm.addListener((a) => { if (a.name === 'walnut-agent') void agentLoop() })
  ext.runtime.onStartup?.addListener(() => { void agentLoop() })
  void agentLoop()
}
