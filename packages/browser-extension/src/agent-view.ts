/**
 * The live Browser view in a Walnut task (web: components/sessions/SessionBrowserCard.tsx;
 * server: GET /api/v1/browser/view/frame): pictures of an agent's tab, only while the person has
 * the view open.
 *
 * A stream (`view_watch`, 2026-11-08, the user: "very laggy like it doesn't show in real time, it
 * takes so long to screenshot, and very bad"): while a viewer watches, this background takes the
 * next picture as soon as the browser allows one (two a second) and posts it to Walnut itself
 * (POST /browser/view/push), at the screen's own pixels, never shrunk; a picture the same as the
 * last is posted without its bytes. Walnut's answer to each post says whether anyone still
 * watches, so one command starts it and nothing waits on the long poll per picture. The older
 * one-picture command (`view_frame`, a small JPEG) stays for a Walnut that knows no stream.
 *
 * It must never get in the agent's way or the person's:
 *   - the picture is captureVisibleTab of the tab's window, the screenshot path, which works on a
 *     window behind others and takes no focus; one capture at a time (capture-gate.ts), and a
 *     frame is skipped, not waited for, while an agent's screenshot holds the gate;
 *   - a tab of the person's (handed over or taken) is pictured only while it is on screen in their
 *     window: it is never brought up there, since that would change what they see;
 *   - an agent tab behind another tab in the agent window is brought up there only while the tab
 *     on screen has no command running (an agent's real input or page step goes on undisturbed)
 *     and is not watched itself, and the picture counts only if that tab is still the one on
 *     screen after the capture;
 *   - no debugger, no page script, no mask: nothing in the page changes for a frame.
 * The frame goes to the person's Walnut alone (the route refuses agents): an agent takes a
 * screenshot, which draws a shown password as dots.
 */
import { ext } from './ext'
import { AgentError, agentTabs, agentWindowId, personsTab, walnutCheck, where, type AgentTab, type WireCommand } from './agent-shared'
import { walnutAddress } from './walnut-address'
import { capture, tryCapture } from './capture-gate'
import { frontDriven } from './agent-takeover'

/** The picture's width at most, in pixels: a frame stays small (tens of KB). */
export const FRAME_MAX_W = 960

/**
 * When each tab was last pictured: a tab behind another one in the agent window is brought up
 * only when the tab in front is not being watched itself (two tasks watched at once would else
 * flip the agent window between their tabs every frame).
 */
const framedAt = new Map<number, number>()
const WATCHED_MS = 4000

/** Why a frame has no picture this time. */
export type NoFrame = 'behind' | 'busy' | 'minimized' | 'no_permission' | 'not_web' | 'walnut_page' | 'changed' | 'failed'

async function shrink(dataUrl: string): Promise<string> {
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const full = await createImageBitmap(blob)
    if (full.width <= FRAME_MAX_W) { full.close(); return dataUrl }
    const h = Math.round(full.height * FRAME_MAX_W / full.width)
    const canvas = new OffscreenCanvas(FRAME_MAX_W, h)
    canvas.getContext('2d')!.drawImage(full, 0, 0, FRAME_MAX_W, h)
    full.close()
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 })
    const bytes = new Uint8Array(await out.arrayBuffer())
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `data:image/jpeg;base64,${btoa(s)}`
  } catch {
    // No canvas here (an older browser): the capture as it came.
    return dataUrl
  }
}

/** `view_frame {tab}`: the tab as it is now, small, or why there is no picture (and still its title, address and window). */
export function viewFrame(c: WireCommand, busy: (tabId: number) => boolean): Promise<Record<string, unknown>> {
  return frameOf(c, busy, false)
}

/** The JPEG quality of a streamed picture: sharp text at the screen's own pixels. */
export const STREAM_QUALITY = 82

/** One picture of the tab (`full`: at the screen's pixels, for the stream), or why there is none. */
async function frameOf(c: WireCommand, busy: (tabId: number) => boolean, full: boolean): Promise<Record<string, unknown>> {
  const tabId = typeof c.args.tab === 'number' ? c.args.tab : NaN
  const rec = await agentTabs.get(tabId)
  if (!rec) throw new AgentError('That tab is no agent\'s now (closed, or given back with Stop).', 'not_your_tab')
  const tab = await ext.tabs.get(tabId).catch(() => null)
  if (!tab || tab.windowId === undefined) { await agentTabs.delete(tabId); throw new AgentError('That tab was closed.', 'not_your_tab') }
  const at = await where(tabId)
  const whose = (r: AgentTab = rec) => ({ ...(r.handed ? { handed: true } : r.taken ? { taken: true } : {}), ...(typeof r.driving === 'number' ? { driving: true } : {}) })
  const none = (why: NoFrame) => ({ ...at, shown: false, why, ...whose() })
  const url = tab.url ?? ''
  // The same holding of the tab as when the frame began (Stop and a new hand-over make another).
  const sameHolding = (now: typeof rec | undefined) => now?.owner === rec.owner && (now?.grant ?? '') === (rec.grant ?? '')
  if (!/^https?:\/\//i.test(url)) return none('not_web')
  if (await walnutCheck.isWalnutPage(url) || walnutAddress(c.allow.walnut, url)) return none('walnut_page')
  if (!(await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false))) return none('no_permission')
  if (at.windowState === 'minimized') return none('minimized')
  const inAgentWindow = tab.windowId === await agentWindowId()
  if (!tab.active) {
    if (personsTab(rec) || !inAgentWindow) return none('behind')
    const [front] = await ext.tabs.query({ active: true, windowId: tab.windowId })
    if (front?.id !== undefined && busy(front.id)) return none('busy')
    // The person took the front tab over: never pull it away for a picture.
    if (await frontDriven(tab.windowId)) return none('behind')
    if (front?.id !== undefined && Date.now() - (framedAt.get(front.id) ?? 0) < WATCHED_MS) return none('behind')
  }
  const shot = await tryCapture(async () => {
    const now = await ext.tabs.get(tabId).catch(() => null)
    if (!now) return null
    // The page or window moved while this frame waited for the gate.
    if ((now.url ?? '') !== url || now.windowId !== tab.windowId) return 'changed' as const
    if (!now.active) {
      if (personsTab(rec) || !inAgentWindow || await frontDriven(tab.windowId)) return 'behind' as const
      await ext.tabs.update(tabId, { active: true })
    }
    let image: string
    try { image = await capture(tab.windowId!, { format: 'jpeg', quality: full ? STREAM_QUALITY : 60 }) } catch { return 'failed' as const }
    // What was on screen must be this tab still (a page's popup, another agent's tab brought up meanwhile).
    const [shown] = await ext.tabs.query({ active: true, windowId: tab.windowId })
    if (shown?.id !== tabId) return 'changed' as const
    // Still this owner's tab, on the same page in the same window, after the capture: else the
    // picture may show a page the task does not hold (Stop, a give-back, a move to a Walnut page;
    // review 2026-11-07).
    const owner = await agentTabs.get(tabId)
    if (!sameHolding(owner)) return null
    const after = await ext.tabs.get(tabId).catch(() => null)
    if (!after) return null
    if ((after.url ?? '') !== url || after.windowId !== tab.windowId) return 'changed' as const
    framedAt.set(tabId, Date.now())
    if (framedAt.size > 50) for (const [id, at] of framedAt) if (Date.now() - at > WATCHED_MS) framedAt.delete(id)
    return image
  })
  if (shot === undefined) return none('busy')
  if (shot === null) throw new AgentError('That tab was closed or given back.', 'not_your_tab')
  if (shot === 'behind' || shot === 'failed' || shot === 'changed') return none(shot)
  const image = full ? shot : await shrink(shot)
  // The last look, after the picture was made small: still this holding, on the same page.
  const last = await ext.tabs.get(tabId).catch(() => null)
  if (!sameHolding(await agentTabs.get(tabId)) || !last) throw new AgentError('That tab was closed or given back.', 'not_your_tab')
  if ((last.url ?? '') !== url || last.windowId !== tab.windowId) return none('changed')
  // Whether the person has the tab now (Take over), as of the picture.
  const nowRec = await agentTabs.get(tabId)
  return { ...(await where(tabId)), shown: true, image, at: new Date().toISOString(), ...whose(nowRec ?? rec) }
}

// ── the stream ──

/** How long a watch lasts without word from Walnut (each post's answer renews it). */
export const WATCH_MS = 5000
const WATCH_MAX_MS = 15_000
/** Between pictures when there is none to take (the tab behind another, a minimized window...). */
export const IDLE_GAP_MS = 1200
/** Between tries while an agent's own screenshot holds the capture. */
const BUSY_GAP_MS = 300

/** What Walnut answers a post: someone still watches (`more`), for how long. */
export type PushAnswer = { more?: boolean; ms?: number; again?: boolean } | null
export type Push = (body: Record<string, unknown>) => Promise<PushAnswer>

const streams = new Map<number, { until: number; grant?: string }>()
const watchMs = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(1000, Math.min(WATCH_MAX_MS, v)) : WATCH_MS)

/**
 * `view_watch {tab, ms?}`: stream the tab's pictures to Walnut while someone watches. A watch of a
 * tab already streaming only lengthens it; one stream per tab and holding.
 */
export async function viewWatch(c: WireCommand, busy: (tabId: number) => boolean, push: Push): Promise<Record<string, unknown>> {
  const tabId = typeof c.args.tab === 'number' ? c.args.tab : NaN
  const rec = await agentTabs.get(tabId)
  if (!rec) throw new AgentError('That tab is no agent\'s now (closed, or given back with Stop).', 'not_your_tab')
  const until = Date.now() + watchMs(c.args.ms)
  const s = streams.get(tabId)
  if (s && s.grant === rec.grant) { s.until = Math.max(s.until, until); return { tab: tabId, watching: true } }
  const mine = { until, grant: rec.grant }
  streams.set(tabId, mine)
  void stream(tabId, c, busy, push, mine)
  return { tab: tabId, watching: true, started: true }
}

/** Whether a stream runs for the tab now (tests). */
export const streaming = (tabId: number): boolean => streams.has(tabId)

async function stream(tabId: number, c: WireCommand, busy: (tabId: number) => boolean, push: Push, s: { until: number; grant?: string }): Promise<void> {
  let last = ''
  let seq = 0
  try {
    while (streams.get(tabId) === s && Date.now() < s.until) {
      const began = Date.now()
      let frame: Record<string, unknown>
      try {
        frame = await frameOf(c, busy, true)
      } catch (err) {
        // The tab was closed or given back: Walnut hears it, and the stream ends.
        await push({ tab: tabId, seq: ++seq, gone: true, code: err instanceof AgentError ? err.code : 'browser_error' }).catch(() => null)
        return
      }
      const image = frame.shown === true && typeof frame.image === 'string' ? frame.image : ''
      const body = image && image === last ? { ...frame, image: undefined, same: true } : frame
      if (image) last = image
      const answer = await push({ ...body, tab: tabId, seq: ++seq }).catch(() => null)
      if (!answer || answer.more !== true) return
      if (answer.again) last = ''
      s.until = Date.now() + watchMs(answer.ms)
      // The capture gate keeps two pictures a second at most; no picture to take waits longer.
      const gap = image ? 0 : frame.why === 'busy' ? BUSY_GAP_MS : IDLE_GAP_MS
      const wait = began + gap - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
  } finally {
    if (streams.get(tabId) === s) streams.delete(tabId)
  }
}
