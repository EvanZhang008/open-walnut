/**
 * An agent's page actions in its tab (agent.ts sends them here): the top frame and every frame
 * in it, same origin or not (each frame's own site is checked, here and in the frame), a ref
 * like f3:e12 going to frame 3; a wait for an address; and the tabs an agent's tab opens, which
 * are the same agent's.
 */
import { ext, type Tab } from './ext'
import { more, type NewTab } from './agent-api'
import { siteKey } from '../../../src/core/vault/url-match'
import { walnutAddress } from './walnut-address'
import { pageCheck } from './page-reach'
import { popupRecord } from './agent-tab-kind'
import {
  ACTING_MS, AgentError, WALNUT_PAGE, acting, agentTabs, allowed, checkPage, frameOp, loaded, mark, originOf, personsTab, settled, sleep, where,
  walnutCheck, type AgentTab, type WireCommand,
} from './agent-shared'

export const PAGE_OPS = new Set(['snapshot', 'text', 'click', 'type', 'select', 'press', 'scroll', 'wait', 'find', 'form_values', 'fill_form', 'hover', 'upload'])
/** After these the page may load something new: wait for it before answering. */
const MAY_NAVIGATE = new Set(['click', 'press', 'type', 'select', 'fill_form', 'upload'])
/** These read the whole tab: its frames are read as well. */
const WHOLE_TAB = new Set(['snapshot', 'text', 'find', 'form_values'])
const MAX_FRAMES = 8

export interface Frame { frameId: number; href: string }

/** A frame's own answer: its address and size, and how many frames it shows itself (web pages a person could see). */
type FrameSeen = { frameId: number; href?: string; w?: number; h?: number; kids?: number }

/** One look at every frame of the tab, or null when the browser could not look (a frame between two documents). */
async function lookAtFrames(tabId: number): Promise<FrameSeen[] | null> {
  if (!more.scripting) return []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const found = await Promise.race([
      // A plain function in the default (isolated) world: it reads only the frame's address, its
      // size and how many frames it holds that a person could see.
      more.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => ({
          href: location.href, w: innerWidth, h: innerHeight,
          kids: Array.from(document.querySelectorAll('iframe, frame')).filter((el) => {
            const r = el.getBoundingClientRect()
            const src = (el as HTMLIFrameElement).src || ''
            return r.width >= 2 && r.height >= 2 && /^https?:/i.test(src) && !(el as HTMLIFrameElement).srcdoc
          }).length,
        }),
      }).then((rs) => rs.map((r) => ({ frameId: r.frameId, ...(r.result as Omit<FrameSeen, 'frameId'> | undefined) })), () => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 3000) }),
    ])
    return found
  } finally {
    clearTimeout(timer)
  }
}

const visibleFrames = (all: FrameSeen[]): Frame[] => all
  .filter((f) => f.frameId !== 0 && /^https?:/i.test(f.href ?? '') && (f.w ?? 0) >= 2 && (f.h ?? 0) >= 2)
  .sort((a, b) => a.frameId - b.frameId)
  .slice(0, MAX_FRAMES)
  .map((f) => ({ frameId: f.frameId, href: f.href! }))

/** How long a read waits for the frames a page shows to be reachable (right after a load they attach a moment later). */
const FRAMES_SETTLE_MS = 1200

/**
 * The tab's frames other than the top one that a person could see: web pages, not tiny or hidden.
 * Right after a navigation a frame the page shows may not be reachable yet (review R1-15: a
 * snapshot after navigate listed none): while the frames reached show more frames than were
 * reached, it looks again, for at most FRAMES_SETTLE_MS.
 */
export async function framesOf(tabId: number): Promise<Frame[]> {
  const until = Date.now() + FRAMES_SETTLE_MS
  let last: Frame[] = []
  for (;;) {
    const all = await lookAtFrames(tabId)
    if (all) {
      last = visibleFrames(all)
      const shown = all.reduce((n, f) => n + (f.kids ?? 0), 0)
      if (last.length >= Math.min(shown, MAX_FRAMES)) return last
    }
    if (Date.now() >= until) return last
    await sleep(150)
  }
}

/** Why a frame is left out, or nothing when an agent may use it. */
async function frameBar(allow: WireCommand['allow'], f: Frame): Promise<string | undefined> {
  if (await walnutCheck.isWalnutPage(f.href) || walnutAddress(allow.walnut, f.href)) return 'Walnut\'s own page'
  if (!allowed(allow, f.href)) return `${siteKey(f.href)?.domain ?? 'that site'} is not allowed for agents`
  return undefined
}

/** The frame a command names: the prefix of its ref (f3:e12), or of its form fields' refs. */
function frameOfCommand(a: Record<string, unknown>): number {
  const refs = [a.ref, ...(Array.isArray(a.fields) ? (a.fields as Array<{ ref?: unknown }>).map((f) => f?.ref) : [])].filter((r): r is string => typeof r === 'string')
  const ids = new Set(refs.map((r) => Number(/^f(\d+):/.exec(r)?.[1] ?? 0)))
  if (ids.size > 1) throw new AgentError('Those fields are in different frames: fill each frame on its own.', 'mixed_frames')
  return [...ids][0] ?? 0
}

/** The whole tab read: the top frame's answer, then each frame's under its own heading. */
async function wholeTab(c: WireCommand, tabId: number, top: Record<string, unknown>): Promise<Record<string, unknown>> {
  const frames = await framesOf(tabId)
  if (!frames.length) return top
  const out = { ...top }
  const notes: string[] = []
  for (const f of frames) {
    const bar = await frameBar(c.allow, f)
    const head = `Frame f${f.frameId} (${f.href.slice(0, 160)})`
    if (bar) { notes.push(`${head}: left out, ${bar}.`); continue }
    const args = { ...c.args, ...(c.action === 'snapshot' ? { max: 100 } : c.action === 'text' ? { max: 5000 } : {}) }
    const r = await frameOp(tabId, f.frameId, c.action, args, c.allow, 6000).catch((err: unknown) => {
      notes.push(`${head}: could not be read (${err instanceof Error ? err.message : String(err)}).`)
      return null
    })
    if (!r) continue
    if (c.action === 'snapshot') notes.push(`${head}:\n${String(r.snapshot ?? '').split('\n').filter((l) => !/^(Page|URL): /.test(l)).join('\n').trim()}`)
    else if (c.action === 'text') notes.push(`${head}:\n${String(r.text ?? '')}`)
    else if (c.action === 'find') {
      out.matches = [...(out.matches as unknown[] ?? []), ...((r.matches as Array<Record<string, unknown>> | undefined) ?? []).map((m) => ({ ...m, frame: `f${f.frameId}` }))]
      out.count = Number(out.count ?? 0) + Number(r.count ?? 0)
    } else if (c.action === 'form_values') {
      out.fields = [...(out.fields as unknown[] ?? []), ...((r.fields as Array<Record<string, unknown>> | undefined) ?? []).map((x) => ({ ...x, frame: `f${f.frameId}` }))]
      out.count = Number(out.count ?? 0) + Number(r.count ?? 0)
    }
  }
  if (c.action === 'snapshot' && notes.length) out.snapshot = `${String(out.snapshot ?? '')}\n\n${notes.join('\n\n')}`
  else if (c.action === 'text' && notes.length) out.text = `${String(out.text ?? '')}\n\n${notes.join('\n\n')}`
  else if (notes.length) out.frames = notes
  return out
}

/** `wait {url}`: a substring of the address, or /a regex/ with its flags. Waited for here: a load replaces the page's script. */
async function waitUrl(tabId: number, pattern: string, ms: unknown): Promise<Record<string, unknown>> {
  const m = /^\/(.+)\/([dgimsuy]*)$/.exec(pattern)
  let test: (u: string) => boolean
  try {
    const re = m ? new RegExp(m[1], m[2].replace('g', '')) : null
    test = re ? (u) => re.test(u) : (u) => u.includes(pattern)
  } catch { throw new AgentError(`Not a pattern: ${pattern}.`, 'bad_request') }
  const limit = typeof ms === 'number' && ms >= 0 ? Math.min(30_000, ms) : 30_000
  const until = Date.now() + limit
  for (;;) {
    const t = await ext.tabs.get(tabId).catch(() => null)
    if (!t) throw new AgentError('That tab was closed.', 'not_your_tab')
    if (test(t.url ?? '')) { await loaded(tabId, 10_000); return { waited: `at ${t.url}` } }
    if (Date.now() >= until) break
    await sleep(250)
  }
  throw new AgentError(`The address did not match ${pattern} within ${Math.round(limit / 1000)} s.`, 'wait_timeout')
}

/**
 * `wait {text}` / `{textGone}`: the top frame and every frame an agent may read (the frames a
 * snapshot shows), asked a few times a second; a frame that loads meanwhile is asked too.
 */
async function waitText(c: WireCommand, tabId: number): Promise<Record<string, unknown>> {
  const want = typeof c.args.text === 'string' && c.args.text ? c.args.text : undefined
  const gone = !want && typeof c.args.textGone === 'string' && c.args.textGone ? c.args.textGone : undefined
  const text = (want ?? gone)!
  const until = Date.now() + 30_000
  let frames: Frame[] = []
  let framesAt = 0
  for (;;) {
    if (Date.now() - framesAt > 2000) {
      const all = await framesOf(tabId)
      const ok: Frame[] = []
      for (const f of all) if (!(await frameBar(c.allow, f))) ok.push(f)
      frames = ok
      framesAt = Date.now()
    }
    const seen: string[] = []
    for (const id of [0, ...frames.map((f) => f.frameId)]) {
      const r = await frameOp(tabId, id, 'has_text', { text }, c.allow, 3000).catch(() => (id === 0 ? null : { has: false }))
      if (r === null) continue
      if (r.has) seen.push(id ? `frame f${id}` : 'the page')
    }
    if (want && seen.length) return { waited: `"${want}" is on ${seen[0] === 'the page' ? 'the page' : `the page, in ${seen[0]}`}` }
    if (gone && !seen.length) return { waited: `"${gone}" is gone from the page${frames.length ? ' and its frames' : ''}` }
    if (Date.now() >= until) break
    await sleep(300)
  }
  throw new AgentError(want ? `"${want}" did not show within 30 s (the page and its frames were looked at).` : `"${gone}" was still on the page after 30 s.`, 'wait_timeout')
}

/** The page held a step for the person's yes (page-ops.ts held). */
export function outwardHeld(hold: unknown): AgentError {
  const h = (hold ?? {}) as { what?: string; why?: string }
  return new AgentError(`That would ${h.what ?? 'act'} (${h.why ?? 'it acts in the person\'s name'}): it waits for the person's yes.`, 'outward_needs_ok', { hold })
}

// ── tabs an agent's tab opens ──

/** New tabs an agent tab opened lately, for the answer of the action that opened them. */
const opened: Array<{ tab: number; opener: number; at: number }> = []
/** Links this extension is opening for an agent itself (opener tab → address), set up there. */
const linking = new Map<number, string>()

async function adoptOpened(tabId: number, rec: AgentTab, url?: string): Promise<void> {
  await agentTabs.set(tabId, popupRecord(rec, url))
  await loaded(tabId)
  // What loaded may be Walnut itself: never an agent's.
  if ((await pageCheck(tabId))?.walnut) { await agentTabs.delete(tabId); await ext.tabs.remove(tabId).catch(() => undefined); return }
  await mark(tabId, true, rec.who)
}

/**
 * New tabs with no opener the browser names (a page's window.open into a new popup window: Chrome
 * sets openerTabId only within one window), each with the check of which agent tab opened it.
 */
const unnamed: Array<{ tab: number; at: number; check: Promise<number | undefined> }> = []

/**
 * A new window's tab is an agent tab's when one was being acted in just then, and the new page has
 * an opener and came from that tab's origin (its referrer). Read in the extension's own world.
 */
async function openerOf(t: NewTab): Promise<number | undefined> {
  const now = Date.now()
  const live = [...acting.entries()].filter(([, until]) => until >= now).sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const candidates: Array<{ id: number; rec: AgentTab; url: string }> = []
  for (const id of live) {
    const rec = await agentTabs.get(id)
    const tab = rec ? await ext.tabs.get(id).catch(() => null) : null
    if (rec && tab?.url) candidates.push({ id, rec, url: tab.url })
  }
  if (!candidates.length || t.id === undefined || !more.scripting) return undefined
  await loaded(t.id, 10_000)
  const [r] = await more.scripting.executeScript({ target: { tabId: t.id }, func: () => ({ referrer: document.referrer, opener: !!window.opener }) }).catch(() => [])
  const info = r?.result as { referrer?: string; opener?: boolean } | undefined
  if (!info?.opener || !info.referrer) return undefined
  const from = originOf(info.referrer)
  const hit = candidates.find((c) => originOf(c.url) === from)
  if (!hit) return undefined
  opened.push({ tab: t.id, opener: hit.id, at: Date.now() })
  if (opened.length > 50) opened.shift()
  await adoptOpened(t.id, hit.rec, t.pendingUrl || t.url)
  return hit.id
}

/** A tab or window an agent tab opened is the same agent's (the person's own tab only while an agent acts in it). */
export function watchOpened(): void {
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
    if (linking.get(opener) === (t.pendingUrl || t.url)) return
    void agentTabs.get(opener).then((rec) => {
      if (!rec || (personsTab(rec) && (acting.get(opener) ?? 0) < Date.now())) return
      opened.push({ tab: id, opener, at: Date.now() })
      if (opened.length > 50) opened.shift()
      return adoptOpened(id, rec, t.pendingUrl || t.url)
    })
  })
}

/** A link to a new tab, opened here as the agent's own (the browser would block a page's new tab from it). */
async function openLink(c: WireCommand, tabId: number, tab: Tab, rec: AgentTab, href: string): Promise<{ tab: number; url: string } | undefined> {
  await checkPage(c.allow, href)
  // In the agent window it comes to the front; in the person's window it stays behind their tab.
  linking.set(tabId, href)
  const t = await more.tabs.create({ url: href, windowId: tab.windowId, active: !personsTab(rec), openerTabId: tabId }).finally(() => linking.delete(tabId))
  if (t.id === undefined) return undefined
  await adoptOpened(t.id, rec, href)
  return (await agentTabs.get(t.id)) ? { tab: t.id, url: href } : undefined
}

export async function pageOp(c: WireCommand, tabId: number, tab: Tab, rec: AgentTab): Promise<Record<string, unknown>> {
  const a = c.args
  if (c.action === 'wait' && typeof a.url === 'string' && a.url) return { ...(await waitUrl(tabId, a.url, a.ms)), ...(await where(tabId)) }
  // Text in the whole tab, frames too (a ref names no frame for a wait).
  if (c.action === 'wait' && ((typeof a.text === 'string' && a.text) || (typeof a.textGone === 'string' && a.textGone))) return { ...(await waitText(c, tabId)), ...(await where(tabId)) }
  const frameId = frameOfCommand(a)
  if (frameId) {
    const f = (await framesOf(tabId)).find((x) => x.frameId === frameId)
    if (!f) throw new AgentError(`Frame f${frameId} is not on the page now: snapshot again.`, 'stale_ref')
    const bar = await frameBar(c.allow, f)
    if (bar === 'Walnut\'s own page') throw new AgentError(WALNUT_PAGE, 'walnut_page')
    if (bar) await checkPage(c.allow, f.href)
  }
  // Within the server's own limit for the command (hub.ts, 30 s; `wait` 40 s), reaching the page
  // included: an answer after it would be an action the agent was already told failed.
  const ms = c.action === 'wait' ? 31_000 : 20_000
  const started = Date.now()
  acting.set(tabId, Date.now() + ms + ACTING_MS)
  try {
    let r = await frameOp(tabId, frameId, c.action, a, c.allow, ms)
    // A step that buys, sends or deletes: nothing was done, the person is asked (routes/browser-v1.ts).
    if (r.hold) throw outwardHeld(r.hold)
    if (frameId === 0 && WHOLE_TAB.has(c.action)) r = await wholeTab(c, tabId, r)
    let link: { tab: number; url: string } | undefined
    if (typeof r.newTab === 'string') { link = await openLink(c, tabId, tab, rec, r.newTab); delete r.newTab }
    if (MAY_NAVIGATE.has(c.action)) await settled(tabId)
    // A window the page opened with no opener named: wait (briefly) to learn whether it was this tab's.
    if (!link && !opened.some((o) => o.opener === tabId && o.at >= started)) {
      const checks = unnamed.filter((u) => u.at >= started).map((u) => u.check)
      if (checks.length) await Promise.race([Promise.all(checks), sleep(8000)])
    }
    const popup = link ?? opened.find((o) => o.opener === tabId && o.at >= started)
    return { ...r, ...(await where(tabId)), ...(popup ? { opened: { tab: popup.tab, url: 'url' in popup ? popup.url : (await ext.tabs.get(popup.tab).catch(() => ({} as Tab))).url } } : {}) }
  } finally {
    acting.set(tabId, Date.now() + ACTING_MS)
  }
}
