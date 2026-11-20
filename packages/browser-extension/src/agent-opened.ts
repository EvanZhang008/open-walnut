/**
 * The tabs an agent's tab opens, which are the same agent's: a link to a new tab (openLink), a
 * window its page asks for (pageOpen: agent-popups.ts replaced the page's window.open), and a tab
 * or window the browser still opens from it (watchOpened: an opener named, or found by openerOf).
 * The step that opened one names it in its answer (openedSince).
 *
 * A window a page asks for opens as a background tab of the agent window (chrome.tabs.create with
 * active false never shows a window; a page's own window.open would: agent-popups.ts), only for an
 * agent's own tab of the agent window while one of its steps runs or just ran (`opening`, agent.ts
 * beforeStep), with that step's grant, and at most OPENS_MAX in OPENS_MS: the ask comes through the
 * page's own world, so a page could send it at any time, as it could call window.open (the relay
 * also asks for the page's user activation, as the browser does). What becomes of the tab goes back
 * to the page's stand-in: its address only while it is on the page's own site (the browser lets a
 * page read no other), and its close.
 */
import { ext, type Sender, type Tab } from './ext'
import { more, type NewTab } from './agent-api'
import { popupRecord } from './agent-tab-kind'
import { AGENTS_TAB, minimizeAgentPopup, openCalls, popupsAsTabs } from './agent-popups'
import { muteAgentTab } from './agent-media'
import { noteAgentMade } from './agent-tidy'
import { frontInWindow } from './agent-window'
import { noteAgentTabMaking } from './agent-window-own'
import { pageCheck } from './page-reach'
import { closeTab } from './tab-close'
import {
  ACTING_MS, AgentError, acting, agentTabs, agentWindowId, agentsOwnHere, checkPage, loaded, mark, nearPerson, opening, originOf, personsTab, sleep, stepAllow,
  type AgentTab, type WireCommand,
} from './agent-shared'

/** New tabs an agent tab opened lately, for the answer of the action that opened them. */
const opened: Array<{ tab: number; opener: number; at: number }> = []
/** A tab the extension opened for a page's window.open (below): the step's answer names it. */
function noteOpened(tab: number, opener: number): void {
  opened.push({ tab, opener, at: Date.now() })
  if (opened.length > 50) opened.shift()
}
/** Links this extension is opening for an agent itself (opener tab → address), set up there. */
const linking = new Map<number, string>()

async function adoptOpened(tabId: number, rec: AgentTab, url?: string, openerId?: number): Promise<void> {
  await agentTabs.set(tabId, popupRecord(rec, url))
  // Opened from an agent's own tab: tidied with the agent's tabs; one from the person's tab is theirs.
  if (!personsTab(rec)) await noteAgentMade(tabId)
  // A popup window an agent's own tab of the agent window opened goes to the Dock at once
  // (agent-popups.ts); one opened near the person (their window, their tab) stays as it opened.
  if (!nearPerson(rec) && openerId !== undefined && (await ext.tabs.get(openerId).catch(() => null))?.windowId === await agentWindowId()) await minimizeAgentPopup(tabId)
  await muteAgentTab(tabId)
  await loaded(tabId)
  // What loaded may be Walnut itself: never an agent's.
  if ((await pageCheck(tabId))?.walnut) { await agentTabs.delete(tabId); await closeTab(tabId); return }
  await mark(tabId, true, rec.who)
}

/**
 * New tabs with no opener the browser names (a page's window.open into a new popup window: Chrome
 * sets openerTabId only within one window), each with the check of which agent tab opened it.
 */
const unnamed: Array<{ tab: number; at: number; check: Promise<number | undefined> }> = []
/** Each tab's window.open count when its step began (agent.ts beforeStep), to tell whether the step opened one. */
export const openCallsBefore = new Map<number, number>()
/** New tabs whose opener the browser named, while their adoption is under way. */
const named: Array<{ tab: number; opener: number; at: number; check: Promise<number | undefined> }> = []

/**
 * A new window's tab is an agent tab's when one was being acted in just then, and the new page has
 * an opener and came from that tab's origin (its referrer). Read in the extension's own world.
 */
async function openerOf(t: NewTab): Promise<number | undefined> {
  const now = Date.now()
  const until = (id: number) => Math.max(acting.get(id) ?? 0, opening.get(id) ?? 0)
  const live = [...new Set([...acting.keys(), ...opening.keys()])].filter((id) => until(id) >= now).sort((a, b) => until(b) - until(a))
  const candidates: Array<{ id: number; rec: AgentTab; url: string }> = []
  for (const id of live) {
    const rec = await agentTabs.get(id)
    const tab = rec ? await ext.tabs.get(id).catch(() => null) : null
    if (rec && tab?.url) candidates.push({ id, rec, url: tab.url })
  }
  if (!candidates.length || t.id === undefined || !more.scripting) return undefined
  // Read as soon as the page has its referrer (a popup is about:blank first), not once it loaded:
  // a popup window of an agent's is minimized as soon as it is known (agent-popups.ts).
  let info: { referrer?: string; opener?: boolean } | undefined
  for (const until = Date.now() + 10_000; Date.now() < until; await sleep(200)) {
    // The browser may name the opener a moment after the tab's creation (a page's window.open into
    // a tab): then it is that tab's, for certain.
    const named = (await ext.tabs.get(t.id).catch(() => null) as NewTab | null)?.openerTabId
    const byName = named !== undefined ? candidates.find((c) => c.id === named) : undefined
    if (byName) {
      opened.push({ tab: t.id, opener: byName.id, at: Date.now() })
      if (opened.length > 50) opened.shift()
      await adoptOpened(t.id, byName.rec, t.pendingUrl || t.url, byName.id)
      return byName.id
    }
    const [r] = await more.scripting.executeScript({ target: { tabId: t.id }, func: () => ({ referrer: document.referrer, opener: !!window.opener }) }).catch(() => [])
    info = r?.result as typeof info
    if (info?.referrer) break
  }
  // A sign-in page that cuts its opener (Cross-Origin-Opener-Policy) still names the page it came
  // from in its referrer; a window with neither came from no page.
  if (!info?.referrer) return undefined
  const from = originOf(info.referrer)
  const hit = candidates.find((c) => originOf(c.url) === from)
  if (!hit) return undefined
  // The person has a page of that site open too: it may be theirs, so it stays theirs.
  const others = await ext.tabs.query({}).catch(() => [] as Tab[])
  for (const o of others) {
    if (o.id === undefined || o.id === t.id || !o.url || originOf(o.url) !== from) continue
    const r = await agentTabs.get(o.id)
    if (!r || nearPerson(r)) return undefined
  }
  opened.push({ tab: t.id, opener: hit.id, at: Date.now() })
  if (opened.length > 50) opened.shift()
  await adoptOpened(t.id, hit.rec, t.pendingUrl || t.url, hit.id)
  return hit.id
}

/** A tab or window an agent tab opened is the same agent's (the person's own tab only while an agent acts in it). */
export function watchOpened(): void {
  watchPageOpened()
  more.tabs.onCreated.addListener((t: NewTab) => {
    const opener = t.openerTabId
    if (t.id === undefined) return
    if (opener === undefined) {
      unnamed.push({ tab: t.id, at: Date.now(), check: openerOf(t).catch(() => undefined) })
      if (unnamed.length > 20) unnamed.shift()
      return
    }
    const id = t.id
    // One this extension opens itself is set up there (its create may answer after this event).
    // (A page's window.open names no address yet when its tab is made: that is never one of these.)
    const linked = linking.get(opener)
    if (linked !== undefined && linked === (t.pendingUrl || t.url)) return
    // Known at once, so the answer of the step that opened it waits for this tab's adoption.
    const at = Date.now()
    const check = agentTabs.get(opener).then(async (rec) => {
      if (!rec || (personsTab(rec) && (acting.get(opener) ?? 0) < Date.now())) return undefined
      // Not the person's while it is adopted (agent-window-own.ts gives a window up for theirs).
      if (!nearPerson(rec)) noteAgentTabMaking(id)
      opened.push({ tab: id, opener, at })
      if (opened.length > 50) opened.shift()
      await adoptOpened(id, rec, t.pendingUrl || t.url, opener)
      return opener
    }).catch(() => undefined)
    named.push({ tab: id, opener, at, check })
    if (named.length > 20) named.shift()
  })
}

/**
 * A link to a new tab, or a window the page asked for (pageOpen, below), opened here as the
 * agent's own: the browser would block a page's new tab from a link, and would show the window for a
 * page's own window.open (agent-popups.ts). `onMade` hears the tab as soon as it exists.
 */
export async function openLink(allow: WireCommand['allow'], tabId: number, tab: Tab, rec: AgentTab, href: string, onMade?: (id: number) => void): Promise<{ tab: number; url: string } | undefined> {
  await checkPage(allow, href)
  // In the agent window it comes to the front; in the person's window it stays behind their tab.
  linking.set(tabId, href)
  const t = await more.tabs.create({ url: href, windowId: tab.windowId, active: false, openerTabId: tabId }).finally(() => linking.delete(tabId))
  if (t.id === undefined) return undefined
  noteAgentTabMaking(t.id)
  onMade?.(t.id)
  if (!personsTab(rec)) await frontInWindow(ext, tab.windowId, t.id)
  await adoptOpened(t.id, rec, href, tabId)
  return (await agentTabs.get(t.id)) ? { tab: t.id, url: href } : undefined
}

/**
 * A tab or window the step opened from this tab since `started` (a window the page opened with no
 * opener named: waited for briefly, to learn whether it was this tab's). Real input uses it too
 * (agent-trusted.ts), as the browser opens a page's own new tab or window from a trusted click.
 */
export async function openedSince(tabId: number, started: number): Promise<{ tab: number; url?: string } | { refused: string; url: string } | undefined> {
  // The page called window.open during the step (agent-popups.ts counts it): its tab can come a
  // moment after the step's input, so it is waited for briefly.
  if (!opened.some((o) => o.opener === tabId && o.at >= started) && (await openCalls(tabId) ?? 0) > (openCallsBefore.get(tabId) ?? 0)) {
    for (const until = Date.now() + 3000; Date.now() < until && !opened.some((o) => o.opener === tabId && o.at >= started) && !((refused.get(tabId)?.at ?? 0) >= started) && !named.some((n) => n.opener === tabId && n.at >= started) && !unnamed.some((u) => u.at >= started); ) await sleep(100)
  }
  if (!opened.some((o) => o.opener === tabId && o.at >= started)) {
    const checks = [...named.filter((n) => n.opener === tabId && n.at >= started), ...unnamed.filter((u) => u.at >= started)].map((u) => u.check)
    if (checks.length) await Promise.race([Promise.all(checks), sleep(8000)])
  }
  const o = opened.find((x) => x.opener === tabId && x.at >= started)
  if (o) return { tab: o.tab, url: (await ext.tabs.get(o.tab).catch(() => ({} as Tab))).url }
  // The page asked for a window Walnut did not open (a site not allowed, too many): the step says why.
  const no = refused.get(tabId)
  return no && no.at >= started ? { refused: no.why, url: no.url } : undefined
}


/** A step's answer: the tab it opened (`opened`), or the window its page asked for that was not opened (`open_refused`, and why). */
export function openedField(o: Awaited<ReturnType<typeof openedSince>>): Record<string, unknown> {
  return !o ? {} : 'refused' in o ? { open_refused: o } : { opened: o }
}

// ── windows an agent's page asks for ──

export const OPENS_MAX = 8
export const OPENS_MS = 10_000

type Kid = { opener: number; frameId: number; id: string; origin: string; tab?: number; making?: Promise<unknown>; closing?: boolean }
/** A form the page sends to a new window (a POST, or a GET in another encoding): sent again from a page of the same site in the new tab. */
type Form = { method: 'post' | 'get'; enctype: string; fields: Array<[string, string]>; charset: string }
const asForm = (v: unknown): Form | undefined => {
  const f = v as Partial<Form> | undefined
  // The page sends no more than 500 fields (a larger form stays the browser's: agent-popups-page.ts resendable).
  return f && (f.method === 'post' || f.method === 'get') && Array.isArray(f.fields) && f.fields.length <= 500 ? {
    method: f.method, enctype: String(f.enctype ?? ''),
    fields: f.fields.filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string'),
    charset: typeof f.charset === 'string' && /^[\w.:-]{1,40}$/.test(f.charset) ? f.charset : 'UTF-8',
  } : undefined
}
/** Each stand-in the pages hold, by opener tab, frame and the page's own id. */
const kids = new Map<string, Kid>()
/** The stand-in of each tab opened for one. */
const ofTab = new Map<number, Kid>()
/** When each opener's last windows were opened (OPENS_MAX). */
const opens = new Map<number, number[]>()
/** A window a page asked for that was not opened, and why (the step's answer says it). */
const refused = new Map<number, { url: string; why: string; at: number }>()
const KIDS_MAX = 200

const kidKey = (opener: number, frameId: number, id: string) => `${opener}:${frameId}:${id}`
function forget(k: Kid): void {
  kids.delete(kidKey(k.opener, k.frameId, k.id))
  if (k.tab !== undefined && ofTab.get(k.tab) === k) ofTab.delete(k.tab)
}
const tell = (k: Kid, st: { url?: string; cross?: boolean; closed?: boolean }) =>
  void Promise.resolve().then(() => ext.tabs.sendMessage(k.opener, { type: 'agent-page-open-state', id: k.id, ...st }, { frameId: k.frameId })).catch(() => undefined)
/** What the page may know of its window's address: one on its own site, else only that it is elsewhere. */
const seen = (k: Kid, url: string) => (originOf(url) === k.origin ? { url } : { cross: true })
function noteRefused(opener: number, url: string, e: unknown): void {
  refused.set(opener, { url, why: e instanceof AgentError ? e.code : e instanceof Error ? e.message : String(e), at: Date.now() })
}

/** `native`: not the agent's to open (the tab is not an agent's now, no step lately, a sandboxed page): the page's own way runs. */
export type PageOpenReply = { ok: boolean; closed?: boolean; native?: boolean; tab?: number; error?: string }

/**
 * A page's ask: `open` a window (an address, or none yet), `form` send a POST form to a new one,
 * `nav` load another address there, `close` it. Each stand-in's asks run one after another in the order the page made them (a page that opens
 * a blank window and sets its address at once, or opens and closes it): the stand-in is known, and
 * its turn taken, before anything is awaited.
 */
export function pageOpen(msg: Record<string, unknown>, sender: Sender): Promise<PageOpenReply> {
  const opener = sender.tab?.id
  const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : ''
  if (opener === undefined || !id) return Promise.resolve({ ok: false, closed: true })
  const frameId = sender.frameId ?? 0
  const op = msg.op
  if (op !== 'open' && op !== 'form' && op !== 'nav' && op !== 'close') return Promise.resolve({ ok: false, error: 'unknown op' })
  let k = kids.get(kidKey(opener, frameId, id))
  if (!k) {
    // An address or a close for a window this background does not know (it closed, or the background restarted): nothing, as the browser does.
    if (op !== 'open' && op !== 'form') return Promise.resolve({ ok: true, closed: true })
    // The page's real origin (Chrome's, not its address): a sandboxed page's is opaque, and a form
    // sent again from its site would carry that site's Origin and cookies, a window it may not have.
    const origin = sender.origin ?? originOf(String(sender.url ?? ''))
    // A form needs the browser's own word on it (a browser that gives no sender.origin: the page's own way).
    if (!/^https?:\/\//i.test(origin) || (op === 'form' && !sender.origin)) return Promise.resolve({ ok: false, native: true })
    k = { opener, frameId, id, origin }
    kids.set(kidKey(opener, frameId, id), k)
    if (kids.size > KIDS_MAX) forget(kids.values().next().value as Kid)
  }
  const kid = k
  if (op === 'close') kid.closing = true
  const url = typeof msg.url === 'string' ? msg.url : ''
  const form = op === 'form' ? asForm(msg.form) : undefined
  if (op === 'form' && !form) return Promise.resolve({ ok: false, closed: true })
  const run = (kid.making ?? Promise.resolve()).then(() => op === 'close' ? closeKid(kid) : ask(kid, url, form))
  kid.making = run.catch(() => undefined)
  return run
}

/** The page closed its window: its tab closes, only while it is still the agent's (not given back, not taken over). */
async function closeKid(k: Kid): Promise<PageOpenReply> {
  const rec = k.tab !== undefined ? await agentTabs.get(k.tab) : undefined
  if (k.tab !== undefined && rec && !nearPerson(rec) && rec.driving === undefined) await closeTab(k.tab).catch(() => false)
  if (k.tab === undefined) forget(k)
  return { ok: true, closed: true }
}

async function ask(k: Kid, url: string, form?: Form): Promise<PageOpenReply> {
  if (k.closing) return { ok: false, closed: true }
  const here = await agentsOwnHere(k.opener)
  const allow = stepAllow.get(k.opener)
  // Only an agent's own tab, not while the person drives it, during or just after an agent's step.
  // Else the page's own way (a click of the person's, the tab let go meanwhile): never one swallowed.
  if (!here || here.rec.driving !== undefined || !allow || (opening.get(k.opener) ?? 0) < Date.now()) {
    if (k.tab !== undefined) return { ok: false }
    forget(k)
    return { ok: false, native: true }
  }
  // A blank window first (a page that sets its address once it knows it): no tab until then.
  if (!url || url === 'about:blank') return { ok: true }
  return load(k, url, allow, here, form)
}

async function load(k: Kid, url: string, allow: WireCommand['allow'], here: { rec: AgentTab; tab: Tab }, form?: Form): Promise<PageOpenReply> {
  if (k.closing) return { ok: false, closed: true }
  // Every address is checked, the first and any later one (a site not allowed, Walnut itself).
  try { await checkPage(allow, url) } catch (e) { noteRefused(k.opener, url, e); return { ok: false, closed: k.tab === undefined } }
  if (k.tab !== undefined) {
    const rec = await agentTabs.get(k.tab)
    const t = await ext.tabs.get(k.tab).catch(() => null)
    if (!rec || nearPerson(rec) || !t) return { ok: false, closed: true }
    return (await ext.tabs.update(k.tab, { url }).then(() => true, () => false)) ? { ok: true } : { ok: false, closed: true }
  }
  const now = Date.now()
  const recent = (opens.get(k.opener) ?? []).filter((t) => now - t < OPENS_MS)
  if (recent.length >= OPENS_MAX) { noteRefused(k.opener, url, new AgentError('too many windows', 'too_many_windows')); return { ok: false, closed: true, error: 'too many windows' } }
  opens.set(k.opener, [...recent, now])
  // A form (a POST, or a GET in another encoding): the new tab loads a page of the opener's own site
  // first (the form is sent from there, its Origin the same as the page's would be), then the form is sent in it.
  const first = form ? `${k.origin}/robots.txt` : url
  if (form && !/^https?:/i.test(k.origin)) return { ok: false, closed: true }
  const made = await openLink(allow, k.opener, here.tab, here.rec, first, (t) => { k.tab = t; ofTab.set(t, k); noteOpened(t, k.opener) }).catch((e) => { noteRefused(k.opener, url, e); return undefined })
  if (!made) return { ok: false, closed: true }
  // The page closed its window while the tab was being made.
  if (k.closing) { await closeTab(made.tab).catch(() => false); return { ok: false, closed: true } }
  if (form) {
    const sent = await more.scripting?.executeScript({ target: { tabId: made.tab }, func: sendFormHere, args: [url, form.method, form.enctype, form.fields, form.charset, k.origin] as [string, string, string, Array<[string, string]>, string, string] }).then((rs) => rs.some((r) => r.result === true), () => false)
    // Not sent (the site's page would not load or went to another site, a script refused): no tab left behind, and the step says so.
    if (!sent) { await closeTab(made.tab).catch(() => false); noteRefused(k.opener, url, new AgentError('the form could not be sent', 'form_not_sent')); return { ok: false, closed: true } }
  }
  return { ok: true, tab: made.tab }
}

/** Runs in the new tab (the extension's world): sends the page's form from there, only from the page's own origin. Self-contained. */
function sendFormHere(action: string, method: string, enctype: string, fields: Array<[string, string]>, charset: string, origin: string): boolean {
  if (location.origin !== origin) return false
  const f = document.createElement('form')
  f.method = method === 'get' ? 'get' : 'post'
  f.action = action
  f.acceptCharset = charset
  if (/^(multipart\/form-data|text\/plain)$/i.test(enctype)) f.enctype = enctype
  for (const [name, value] of fields) {
    const i = document.createElement('input')
    i.type = 'hidden'; i.name = name; i.value = value
    f.append(i)
  }
  ;(document.body ?? document.documentElement).append(f)
  HTMLFormElement.prototype.submit.call(f)
  return true
}

/** The tab of a page's stand-in closed or went elsewhere: the page hears it. An opener closing forgets its windows. */
function watchPageOpened(): void {
  ext.tabs.onRemoved.addListener((tabId: number) => {
    const k = ofTab.get(tabId)
    if (k) { forget(k); tell(k, { closed: true }) }
    opens.delete(tabId); refused.delete(tabId); stepAllow.delete(tabId)
    for (const x of [...kids.values()]) if (x.opener === tabId) forget(x)
  })
  ext.tabs.onUpdated.addListener((tabId: number, change: { url?: string; status?: string }) => {
    // Each page an agent's own tab loads takes the patch as it starts (a copy of window.open it
    // keeps from its first moment is then mostly the wrapped one), not only at the next step.
    if (change.status === 'loading') void agentsOwnHere(tabId).then((here) => here ? popupsAsTabs(tabId, AGENTS_TAB) : false).catch(() => false)
    const k = ofTab.get(tabId)
    if (k && change.url) tell(k, seen(k, change.url))
    // The opener's page went to another site: its windows are not that site's to hear of.
    if (change.url) for (const x of [...kids.values()]) if (x.opener === tabId && x.frameId === 0 && x.origin !== originOf(change.url)) forget(x)
  })
}

export function _resetPageOpenForTesting(): void { kids.clear(); ofTab.clear(); opens.clear(); refused.clear() }
