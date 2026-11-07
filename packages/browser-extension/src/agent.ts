/**
 * Walnut agents in this browser (the server side is core/browser-control/hub.ts). Off until
 * the person turns it on in the popup. Then the background asks Walnut for work (a long poll
 * with its device token), runs each command, and posts the result.
 *
 * What an agent can reach: tabs it opened, in one Walnut agent window of their own, and the tabs
 * those open; a tab of the person's only when they handed it over (the side panel) or the agent
 * took it with `take` (never the one they are on); only on sites the person allowed (each command
 * carries the list, checked here against the tab's and each frame's real address), never Walnut's
 * own pages or the browser's. Each agent tab wears a frame and a Stop button; Stop gives the tab
 * back. `tabs {all}` lists the person's tabs by title and address only, never what is in them.
 * Page actions are in agent-page.ts, screenshots in agent-shot.ts, downloads in
 * agent-downloads.ts, and real input (off by default) in agent-trusted.ts.
 */
import { ext, isFirefox, type Sender } from './ext'
import { more } from './agent-api'
import { ApiError, call, connection } from './walnut-api'
import { siteKey } from '../../../src/core/vault/url-match'
import { pageCheck, reachPage } from './page-reach'
import {
  AgentError, WALNUT_PAGE, agentTabs, agentsOffCount, allowFor, checkPage, forgetTampered, loaded, mark, newGrant, noteAgentsOff, noteFilled, ownTab, personsTab, reached, sleep, tabLoading, tamperedNow, walnutCheck, where,
  type AgentTab, type WireCommand,
} from './agent-shared'
import { PAGE_OPS, pageOp, watchOpened } from './agent-page'
import { screenshot } from './agent-shot'
import { downloadsAction, watchDownloads } from './agent-downloads'
import { DEBUGGER_OPS, TRUSTED_OPS, trustedAct, trustedReady } from './agent-trusted'
import { fillFrames } from './bg-fill'
import { inHandedReach } from './agent-tab-kind'
import { openInAgentWindow, resizeAgentWindow, windowOf } from './agent-window'
import { viewFrame } from './agent-view'
import { NET_OPS, netAct, startRecording, stopRecording } from './agent-net'
import { watchMedia } from './agent-media'

export { setTrustedInput, trustedInputState } from './trusted-switch'

const HISTORY_MAX = 30

export async function agentOn(): Promise<boolean> {
  return (await ext.storage.local.get('agentControl')).agentControl === true
}


/** Tabs the person handed over: agents act in those even with the browser-wide switch off. */
async function handedTabs(): Promise<number[]> {
  const out: number[] = []
  for (const id of await agentTabs.keys()) if (inHandedReach(await agentTabs.get(id))) out.push(id)
  return out
}

/** Walnut asks for work: the switch is on, or the person let an ask act in one of their tabs. */
async function agentReach(): Promise<boolean> {
  return await agentOn() || (await handedTabs()).length > 0
}

const TAB_ONLY = 'The person let Walnut act only in the tab they handed over from the side panel; agents are off elsewhere in this browser '
  + '(the extension popup, Settings, "Let Walnut agents use this browser" turns them on).'

/**
 * With the switch off, a command may only act in a handed tab (or list this owner's tabs): no
 * new tab, no taking another, no list of the person's tabs.
 */
async function tabOnlyCheck(c: WireCommand): Promise<void> {
  if (await agentOn()) return
  const a = c.args
  if (c.action === 'tabs' && a.all !== true) return
  if (c.action === 'downloads') return
  const rec = typeof a.tab === 'number' ? await agentTabs.get(a.tab) : undefined
  if (c.action !== 'open' && c.action !== 'take' && c.action !== 'tabs' && inHandedReach(rec)) return
  const tabs = await handedTabs()
  if (!tabs.length) throw new AgentError('The person turned agents off in this browser.', 'browser_off')
  throw new AgentError(TAB_ONLY, 'agents_tab_only', { tabs })
}

export async function isAgentTab(tabId: number | undefined): Promise<{ owner: string; who?: string } | undefined> {
  return tabId === undefined ? undefined : agentTabs.get(tabId)
}

const ownerArg = (a: Record<string, unknown>): string => {
  if (typeof a.owner !== 'string' || !a.owner) throw new AgentError('No owner for the tab.', 'bad_request')
  return a.owner
}

/** Every tab of the browser's normal and popup windows, the person's too: where it is and who acts in it, never what is in it. */
async function allTabs(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  // Popup windows too: a page's window.open makes one.
  const found = [...await more.tabs.query({ windowType: 'normal' }).catch(() => []), ...await more.tabs.query({ windowType: 'popup' }).catch(() => [])]
  for (const t of found) {
    // A private window's tabs are never listed, nor taken.
    if (t.id === undefined || t.incognito) continue
    const rec = await agentTabs.get(t.id)
    out.push({ id: t.id, title: t.title, url: t.url, active: t.active === true, windowId: t.windowId, ...(rec ? { owner: rec.owner } : {}) })
  }
  return out.slice(0, 500)
}

/**
 * `take {tab}`: one of the person's tabs becomes the agent's, with the frame and Stop, as a tab
 * they handed over does. Never the tab they are on now, Walnut's or the browser's own pages.
 */
async function take(c: WireCommand): Promise<Record<string, unknown>> {
  const a = c.args
  const owner = ownerArg(a)
  const tabId = typeof a.tab === 'number' ? a.tab : NaN
  const tab = await more.tabs.get(tabId).catch(() => null)
  const win = tab?.windowId !== undefined ? await more.windows.get(tab.windowId).catch(() => null) : null
  if (!tab || tab.incognito || !win || (win.type !== 'normal' && win.type !== 'popup')) throw new AgentError('No such tab (tabs with all lists them).', 'no_such_tab')
  const had = await agentTabs.get(tabId)
  if (had?.owner === owner) return { ...(await where(tabId)), taken: true }
  if (had) throw new AgentError('Another Walnut task is acting in that tab.', 'not_your_tab')
  if (!/^https?:\/\//i.test(tab.url ?? '')) throw new AgentError('That is a browser page: agents use web pages only (http or https).', 'not_a_web_page')
  const personHere = async () => {
    const [here] = await ext.tabs.query({ active: true, lastFocusedWindow: true })
    if (here?.id === tabId) throw new AgentError('The person is on that tab right now: ask them, or have them hand it over from Walnut\'s side panel.', 'person_is_here')
  }
  await personHere()
  await checkPage(c.allow, tab.url ?? '')
  const page = await reached(tabId)
  if (page.walnut) throw new AgentError(WALNUT_PAGE, 'walnut_page')
  await checkPage(c.allow, page.href)
  // Reaching the page can take a few seconds: the person may have come to it meanwhile.
  await personHere()
  if (await agentTabs.get(tabId)) throw new AgentError('Another Walnut task is acting in that tab.', 'not_your_tab')
  const who = typeof a.who === 'string' ? a.who : undefined
  await agentTabs.set(tabId, { owner, ...(who ? { who } : {}), history: [page.href], taken: true })
  await mark(tabId, true, who)
  return { ...(await where(tabId)), taken: true }
}

async function act(cmd: WireCommand): Promise<unknown> {
  const a = cmd.args
  // A tab the person handed over may use its own site as well.
  const c = typeof a.tab === 'number' ? { ...cmd, allow: allowFor(cmd.allow, await agentTabs.get(a.tab)) } : cmd
  switch (c.action) {
    case 'tabs': {
      if (a.all === true) return { tabs: await allTabs(), all: true }
      const out: Array<{ id: number; url?: string; title?: string; owner: string }> = []
      for (const id of await agentTabs.keys()) {
        const t = await ext.tabs.get(id).catch(() => null)
        const o = await agentTabs.get(id)
        if (!t || !o) { await agentTabs.delete(id); continue }
        out.push({ id, url: t.url, title: t.title, owner: o.owner })
      }
      return { tabs: out }
    }
    case 'take': return take(c)
    case 'downloads': return downloadsAction(ownerArg(a), a)
    case 'open': {
      const url = String(a.url ?? '')
      await checkPage(c.allow, url)
      const owner = ownerArg(a)
      const who = typeof a.who === 'string' ? a.who : undefined
      // record: the tab records its requests and console from before its page loads (agent-net.ts).
      // One holding from the blank tab on: if the person takes it back (Stop, the side panel) or
      // turns agents off while it opens, the open ends there and never hands the tab back to the
      // agent (review 2026-11-07: a pending open with record wrote its owner again after a Stop).
      let recordOut: Record<string, unknown> = {}
      const grant = newGrant()
      const offAt = agentsOffCount()
      let held = false
      const taken = () => new AgentError('The person took that tab back (or turned agents off) while it opened: it is theirs now.', 'not_your_tab')
      const t = await openInAgentWindow(ext, url, a.record === true ? async (id) => {
        const rec = { owner, ...(who ? { who } : {}), history: [url], grant }
        await agentTabs.set(id, rec)
        held = true
        recordOut = await startRecording(id, rec).then(() => ({ recording: true }), (err: unknown) => {
          // A recording ended by the person ends the open too; any other refusal leaves a plain tab.
          if (err instanceof AgentError && (err.code === 'not_your_tab' || err.code === 'recording_cancelled')) throw taken()
          return { recording: false, record_refused: { code: err instanceof AgentError ? err.code : 'browser_error', message: err instanceof Error ? err.message : String(err) } }
        })
      } : undefined)
      if (t.id === undefined) throw new AgentError('The browser did not open the tab.', 'open_failed')
      const ours = await agentTabs.setIf(t.id, (cur) => agentsOffCount() === offAt && (held ? cur?.grant === grant : cur === undefined),
        { owner, ...(who ? { who } : {}), history: [url], grant })
      if (!ours) { await stopRecording(t.id); throw taken() }
      await sleep(100)
      await loaded(t.id)
      // What loaded may be Walnut itself under another address (its tunnel, a host's own server).
      if ((await pageCheck(t.id))?.walnut) {
        await agentTabs.delete(t.id)
        await ext.tabs.remove(t.id).catch(() => undefined)
        throw new AgentError(WALNUT_PAGE, 'walnut_page')
      }
      await mark(t.id, true, who)
      return { ...(await where(t.id)), ...recordOut }
    }
    case 'resize': {
      const { tabId } = await ownTab(a)
      const width = Number(a.width), height = Number(a.height)
      if (!Number.isFinite(width) || !Number.isFinite(height)) throw new AgentError('resize takes a width and a height in pixels.', 'bad_request')
      try {
        return { ...(await resizeAgentWindow(ext, tabId, { width, height, viewport: a.viewport === true })), ...(await where(tabId)) }
      } catch (err) {
        throw new AgentError(err instanceof Error ? err.message : String(err), (err as { code?: string }).code ?? 'resize_failed')
      }
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
      const { tabId, rec } = await ownTab(a)
      await agentTabs.delete(tabId)
      await stopRecording(tabId)
      // The person's own tab is given back, never closed.
      if (personsTab(rec)) { await mark(tabId, false); return { tab: tabId, closed: false, released: true } }
      await ext.tabs.remove(tabId).catch(() => undefined)
      return { tab: tabId, closed: true }
    }
    case 'screenshot': {
      const { tabId, tab, rec } = await ownTab(a)
      return screenshot(c, tabId, tab, rec)
    }
    case 'fill_login': {
      // The login Walnut's vault released for this page (fill-login.ts on the server): filled the
      // way the person's own autofill fills it, and never put in the answer.
      const { tabId, tab } = await ownTab(a)
      await checkPage(c.allow, tab.url ?? '')
      const page = await reached(tabId)
      if (page.walnut) throw new AgentError(WALNUT_PAGE, 'walnut_page')
      await checkPage(c.allow, page.href)
      // An agent's script (evaluate) or real input touched this document since it loaded: what it
      // left in the page could read the password. A new load (navigate, reload) is a clean page.
      if (await tamperedNow(tabId, page.doc)) {
        throw new AgentError('An agent ran its own script or real input in this page since it loaded, so Walnut will not fill a password into it. Reload the page first (navigate to it again), then call fill_login.', 'page_tampered')
      }
      const creds = { ...(typeof a.username === 'string' && a.username ? { username: a.username } : {}), ...(typeof a.password === 'string' ? { password: a.password } : {}) }
      const { rec } = await ownTab(a)
      // No page JavaScript runs for this owner on this site from now on (it could read the password).
      await noteFilled(rec.owner, page.href)
      const filled = await fillFrames(tabId, undefined, creds, 'login', String(a.url ?? ''))
      return { filled, ...(await where(tabId)) }
    }
  }
  if (NET_OPS.has(c.action)) {
    const { tabId, tab, rec } = await ownTab(a)
    await checkPage(c.allow, tab.url ?? '')
    return netAct(c, tabId, rec)
  }
  if (DEBUGGER_OPS.has(c.action) || (a.trusted === true && TRUSTED_OPS.has(c.action))) {
    const { tabId, tab, rec } = await ownTab(a)
    // Marks the page for fill_login as the debugger acts (agent-trusted.ts run).
    return trustedAct(c, tabId, tab, rec)
  }
  if (PAGE_OPS.has(c.action)) {
    const { tabId, tab, rec } = await ownTab(a)
    await checkPage(c.allow, tab.url ?? '')
    await reached(tabId)
    return pageOp(c, tabId, tab, rec)
  }
  throw new AgentError(`Unknown action ${c.action}.`, 'bad_action')
}

/** One command at a time per tab: two at once (a full screenshot and a click, two debugger attaches) would trip each other. */
const perTab = new Map<number, Promise<unknown>>()
function inTurn<T>(tab: unknown, work: () => Promise<T>): Promise<T> {
  if (typeof tab !== 'number') return work()
  const before = perTab.get(tab) ?? Promise.resolve()
  const mine = before.catch(() => undefined).then(work)
  const tail = mine.catch(() => undefined)
  perTab.set(tab, tail)
  void tail.then(() => { if (perTab.get(tab) === tail) perTab.delete(tab) })
  return mine
}

/**
 * The person's own commands from the Browser view in Walnut (agent-view.ts): a frame of a tab, and
 * Stop. Neither waits in a tab's turn (a frame behind an agent's 40 s wait would be no live view),
 * and neither is an agent's: the server sends them only for a person's request.
 */
async function viewAct(c: WireCommand): Promise<unknown> {
  if (c.action === 'view_frame') return viewFrame(c, (id) => perTab.has(id))
  // Stop: the tab is no agent's any more, as the Stop on the page does; it stays open.
  const tabId = typeof c.args.tab === 'number' ? c.args.tab : NaN
  const rec = await agentTabs.get(tabId)
  if (!rec) return { tab: tabId, stopped: false }
  // Only the holding the person saw: a tab another task took since stays its (Walnut names the owner).
  const want = typeof c.args.owner === 'string' ? c.args.owner : undefined
  if (!(await agentTabs.deleteIf(tabId, (cur) => !want || cur.owner === want))) return { tab: tabId, stopped: false }
  await stopRecording(tabId)
  await mark(tabId, false)
  await stopIfNoReach()
  return { tab: tabId, stopped: true, ...(personsTab(rec) ? { givenBack: true } : {}) }
}

async function run(c: WireCommand): Promise<void> {
  let body: Record<string, unknown>
  try {
    if (c.action === 'view_frame' || c.action === 'view_stop') {
      body = { id: c.id, ok: true, result: await viewAct(c) }
      await call('POST', '/browser/result', body, { noSession: true, timeoutMs: 20_000 }).catch(() => undefined)
      return
    }
    // The person may have turned agents off since this poll left (or let them in one tab only).
    await tabOnlyCheck(c)
    body = { id: c.id, ok: true, result: await inTurn(c.args.tab, () => act(c)) }
  } catch (err) {
    body = { id: c.id, ok: false, error: { message: err instanceof Error ? err.message : String(err), code: err instanceof AgentError ? err.code : 'browser_error', ...(err instanceof AgentError ? { extra: err.extra } : {}) } }
  }
  await call('POST', '/browser/result', body, { noSession: true, timeoutMs: 20_000 }).catch(() => undefined)
}

/** The agent tabs, who holds each, and where each is (a restarted Walnut shows them in the task's Browser view at once). */
async function report(): Promise<Array<{ id: number; owner: string; grant?: string; url?: string; title?: string; window?: string; windowState?: string; handed?: boolean }>> {
  const out: Array<{ id: number; owner: string; grant?: string; url?: string; title?: string; window?: string; windowState?: string; handed?: boolean }> = []
  for (const id of await agentTabs.keys()) {
    const o = await agentTabs.get(id)
    const t = o ? await ext.tabs.get(id).catch(() => null) : null
    if (o && t) out.push({ id, owner: o.owner, ...(o.grant ? { grant: o.grant } : {}), url: t.url, title: t.title, ...(await windowOf(ext, t.windowId)), ...(personsTab(o) ? { handed: true } : {}) })
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
    while (await agentReach() && await connection()) {
      try {
        const caps = [
          // Only the tabs the person handed over (the switch is off): Walnut's status says so.
          ...(await agentOn() ? [] : ['handed-tabs-only']),
          ...((await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false)) ? ['screenshot'] : []),
          ...(await trustedReady() ? ['trusted-input'] : []),
          ...(more.downloads ? ['downloads'] : []),
        ]
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
  noteAgentsOff()
  await call('POST', '/browser/off', {}, { noSession: true, timeoutMs: 8000 }).catch(() => undefined)
  for (const id of await agentTabs.keys()) { await mark(id, false); await agentTabs.delete(id); await stopRecording(id) }
}

/** Hand-overs still waiting on Walnut; a take-back meanwhile cancels one. */
const handing = new Map<number, { cancelled: boolean }>()

/**
 * The person let an ask in the side panel act in their tab (their click in the panel): the tab
 * becomes that task's agent tab, with the frame and Stop, its site allowed in this tab alone.
 * Agents may act in this tab only: the browser-wide switch is not touched (tabOnlyCheck).
 */
export async function adoptTab(tabId: number, task: string, who?: string): Promise<{ ok: boolean; error?: string }> {
  const tab = await ext.tabs.get(tabId).catch(() => null)
  const url = tab?.url ?? ''
  const site = siteKey(url)?.domain
  if (!tab || !/^https?:\/\//i.test(url) || !site) return { ok: false, error: 'Walnut acts in web pages only.' }
  // The person's tab may be older than the extension (open before an install or an update): its script is put in now.
  const page = await reachPage(tabId, false)
  if (await walnutCheck.isWalnutPage(url) || (page.ok && page.walnut)) return { ok: false, error: 'Agents never use Walnut\'s own pages.' }
  const owner = `task:${task}`
  const had = await agentTabs.get(tabId)
  // A tab the person handed over is theirs to hand to another of their conversations (New chat in
  // the panel); a tab an agent opened stays that agent's.
  if (had && had.owner !== owner && !had.handed) return { ok: false, error: 'Another Walnut task is acting in this tab. Take it back first.' }
  const flight = { cancelled: false }
  handing.set(tabId, flight)
  try {
    await call('POST', '/browser/adopt', { tab: tabId, task, url }, { noSession: true, timeoutMs: 15_000 })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (handing.get(tabId) === flight) handing.delete(tabId)
  }
  if (flight.cancelled) return { ok: false, error: 'Taken back.' }
  await agentTabs.set(tabId, { owner, ...(who ? { who } : {}), history: [url], handed: site })
  // This tab only: the browser-wide switch stays as the person set it (agent loop runs for the tab).
  void agentLoop()
  await mark(tabId, true, who)
  return { ok: true }
}

/** The person took the tab back from the side panel (as Stop on the page does). */
export async function releaseTab(tabId: number): Promise<void> {
  const flight = handing.get(tabId)
  if (flight) flight.cancelled = true
  if (!(await agentTabs.get(tabId))) return
  await agentTabs.delete(tabId)
  await stopRecording(tabId)
  await mark(tabId, false)
  await stopIfNoReach()
}

/** The last handed tab went back with the switch off: Walnut hears at once that agents are out. */
async function stopIfNoReach(): Promise<void> {
  if (!(await agentReach())) await call('POST', '/browser/off', {}, { noSession: true, timeoutMs: 8000 }).catch(() => undefined)
}

/** At most this many tabs in the side panel's relay list (the panel's own cap: ext-relay-model.ts). */
const RELAY_TABS_MAX = 40

/**
 * The browser relay as the side panel's first page shows it (ExtRelay.tsx): the agents switch, and
 * every tab an agent holds now with its page's title and address, newest first.
 */
export async function relayState(): Promise<{ on: boolean; tabs: Array<{ tab: number; owner: string; who?: string; title?: string; url?: string; handed?: boolean }> }> {
  const on = await agentOn()
  const ids = (await agentTabs.keys()).reverse().slice(0, RELAY_TABS_MAX)
  const tabs = []
  for (const id of ids) {
    const rec = await agentTabs.get(id)
    if (!rec?.owner) continue
    const tab = await ext.tabs.get(id).catch(() => null)
    if (!tab) continue
    const url = tab.url && /^https?:/.test(tab.url) ? tab.url : undefined
    tabs.push({ tab: id, owner: rec.owner, ...(rec.who ? { who: rec.who } : {}), ...(tab.title ? { title: tab.title } : {}), ...(url ? { url } : {}), ...(inHandedReach(rec) ? { handed: true } : {}) })
  }
  return { on, tabs }
}

/** Stop all from the side panel: every tab an agent holds goes back (the agents switch stays as it is). */
export async function releaseAllTabs(): Promise<void> {
  for (const id of await agentTabs.keys()) await releaseTab(id)
}

/** Who acts in a tab now (its owner key), for the side panel. */
export async function tabOwnerOf(tabId: number | undefined): Promise<string | undefined> {
  return tabId === undefined ? undefined : (await agentTabs.get(tabId))?.owner
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
      if (id !== undefined) { await agentTabs.delete(id); await stopRecording(id); await stopIfNoReach() }
      return { ok: true }
    }
  }
  return { ok: false, error: `Unknown message ${type}` }
}

export function initAgent(deps: { isWalnutPage: (url: string) => Promise<boolean> }): void {
  walnutCheck.isWalnutPage = deps.isWalnutPage
  watchOpened()
  watchDownloads()
  watchMedia()
  ext.tabs.onRemoved.addListener((tabId) => { void agentTabs.delete(tabId); void forgetTampered(tabId) })
  ext.tabs.onUpdated.addListener((tabId, change: { status?: string }) => { if (change.status === 'loading') void tabLoading(tabId) })
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

/** For tests: one command as the loop runs it, and the person's Browser view commands. */
export { act as _actForTesting, viewAct as _viewActForTesting }
