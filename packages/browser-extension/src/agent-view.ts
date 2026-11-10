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
 *   - where captureVisibleTab cannot give the tab's real picture (the window covered or minimized,
 *     Chrome hidden, the tab behind another tab of the agent window), the picture comes through
 *     Chrome's debugger instead (agent-live.ts): drawn in place, with nothing switched, raised or
 *     focused, and the session stays attached while the tab is watched. Only an agent's own tab in
 *     Walnut's agent window, never a tab of the person's;
 *   - a tab of the person's (handed over or taken) is pictured only while it is on screen in their
 *     window: it is never brought up there, since that would change what they see;
 *   - without the debugger (Firefox, live pictures turned off, the bar cancelled), an agent tab
 *     behind another tab in the agent window is brought up there only while the tab on screen has
 *     no command running (an agent's real input or page step goes on undisturbed) and is not
 *     watched itself, and the picture counts only if that tab is still the one on screen after;
 *   - no page script, no mask: nothing in the page changes for a frame.
 * The frame goes to the person's Walnut alone (the route refuses agents): an agent takes a
 * screenshot, which draws a shown password as dots.
 */
import { ext } from './ext'
import { AgentError, agentTabs, agentWindowId, personsTab, walnutCheck, where, type AgentTab, type WireCommand } from './agent-shared'
import { walnutAddress } from './walnut-address'
import { WindowCovered, capture, tryCapture } from './capture-gate'
import { endLive, liveHeld, livePicture, liveState, type LiveState } from './agent-live'
import { frontDriven } from './agent-takeover'
import { noteGroupUse, type GroupApi } from './agent-groups'

/** The picture's width at most, in pixels: a frame stays small (tens of KB). */
export const FRAME_MAX_W = 960

/**
 * When each tab was last pictured: a tab behind another one in the agent window is brought up
 * only when the tab in front is not being watched itself (two tasks watched at once would else
 * flip the agent window between their tabs every frame).
 */
const framedAt = new Map<number, number>()
const WATCHED_MS = 4000
/** Owners whose tabs a view pictured lately: their group stays open meanwhile (agent-groups.ts). */
const ownerFramedAt = new Map<string, number>()
export const watchedOwner = (owner: string, now = Date.now()) => now - (ownerFramedAt.get(owner) ?? 0) < WATCHED_MS

/**
 * When an agent's command last ran in each tab (agent.ts notes it). The tab the agent works in is
 * put back in front after a picture of another tab, and that switch is made at most every
 * BEHIND_EVERY_MS, so the agent's page is not hidden and shown over and over (review 2026-11-08:
 * once per frame, the page's own visibility events fired four times a second). A tab no agent
 * works in stays behind the one pictured: one switch, none back.
 */
const workedAt = new Map<number, number>()
export const WORKED_MS = 10_000
export const BEHIND_EVERY_MS = 2000
const switchedAt = new Map<number, number>()
export function noteWorked(tabId: number, now = Date.now()): void {
  workedAt.set(tabId, now)
  if (workedAt.size > 100) for (const [id, at] of workedAt) if (now - at > WORKED_MS) workedAt.delete(id)
}
const worked = (id: number | undefined, now = Date.now()) => id !== undefined && now - (workedAt.get(id) ?? 0) < WORKED_MS

/** A window the person is in: no tab of it is switched for a picture or a command. */
async function windowFocused(windowId: number | undefined): Promise<boolean> {
  if (windowId === undefined) return false
  const w = await ext.windows.get(windowId).catch(() => null) as { focused?: boolean } | null
  return w?.focused === true
}

/**
 * Bring the tab a command that needs the screen (a click, a key, an upload) acts in to the front
 * of the agent window first: a folded group leaves the agent window's own page in front. Never in
 * the person's window, a window they are in, or over a tab they took over.
 */
export async function bringUpForCommand(tabId: number): Promise<void> {
  const tab = await ext.tabs.get(tabId).catch(() => null)
  if (!tab || tab.active || tab.windowId === undefined) return
  if (tab.windowId !== await agentWindowId() || personsTab(await agentTabs.get(tabId))) return
  if (await windowFocused(tab.windowId) || await frontDriven(tab.windowId)) return
  await ext.tabs.update(tabId, { active: true }).catch(() => undefined)
}

/** Why a frame has no picture this time. */
export type NoFrame = 'behind' | 'busy' | 'minimized' | 'covered' | 'no_permission' | 'not_web' | 'walnut_page' | 'changed' | 'failed' | 'discarded'

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

/** Why the tab's last covered frame had no picture through the debugger (agent-live.ts), for its frame's `live`. */
const coveredLive = new Map<number, LiveState>()

/** What a frame with no picture says of the debugger's pictures: why they could not serve ('on' after a try: it failed). */
async function liveWord(tabId: number, tried: boolean): Promise<LiveState | undefined> {
  const st = await liveState(tabId)
  return st === 'on' ? (tried ? 'failed' : undefined) : st
}

/**
 * The picture of what the window shows (captureVisibleTab). A stream (`full`) of a covered window
 * takes it through the debugger instead, while live pictures may be taken (`live`, agent-live.ts).
 * A single frame (`view_frame`, an older Walnut) never attaches the debugger.
 */
async function pictureOf(tabId: number, win: number, full: boolean, live: LiveState): Promise<string | 'failed' | 'covered'> {
  const quality = full ? STREAM_QUALITY : 60
  try {
    const image = await capture(win, { format: 'jpeg', quality })
    coveredLive.delete(tabId)
    return image
  } catch (err) {
    if (!(err instanceof WindowCovered)) return 'failed'
  }
  if (!full || live !== 'on') { coveredLive.set(tabId, live); return 'covered' }
  try {
    const image = await livePicture(tabId, quality)
    coveredLive.delete(tabId)
    return image
  } catch {
    coveredLive.set(tabId, (await liveWord(tabId, true)) ?? 'failed')
    return 'covered'
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
  const holder: AgentTab = rec
  const tab = await ext.tabs.get(tabId).catch(() => null)
  if (!tab || tab.windowId === undefined) { await agentTabs.delete(tabId); throw new AgentError('That tab was closed.', 'not_your_tab') }
  const win: number = tab.windowId
  const at = await where(tabId)
  const whose = (r: AgentTab = rec) => ({ ...(r.handed ? { handed: true } : r.taken ? { taken: true } : {}), ...(typeof r.driving === 'number' ? { driving: true } : {}) })
  const none = (why: NoFrame) => ({ ...at, shown: false, why, ...whose() })
  const url = tab.url ?? ''
  // The same holding of the tab as when the frame began (Stop and a new hand-over make another).
  const sameHolding = (now: typeof rec | undefined) => now?.owner === rec.owner && (now?.grant ?? '') === (rec.grant ?? '')
  if (!/^https?:\/\//i.test(url)) return none('not_web')
  if (await walnutCheck.isWalnutPage(url) || walnutAddress(c.allow.walnut, url)) return none('walnut_page')
  if (!(await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false))) return none('no_permission')
  // Chrome put the tab to sleep to save memory: attaching the debugger would load it again.
  if (tab.discarded === true) return none('discarded')
  const inAgentWindow = tab.windowId === await agentWindowId()
  // Pictures through the debugger: only an agent's own tab in Walnut's agent window.
  const liveOk = inAgentWindow && !personsTab(rec)
  const live: LiveState = liveOk ? await liveState(tabId) : 'unavailable'
  // The person turned live pictures off, cancelled the bar, a dialog opened: the stream lets go now.
  if (live !== 'on' && liveHeld(tabId)) await endLive(tabId)
  const minimized = at.windowState === 'minimized'
  // captureVisibleTab cannot picture it (minimized, behind another tab), or the stream holds the
  // debugger already: the picture through it, in place. Nothing is switched for it.
  let triedLive = false
  if (full && live === 'on' && (minimized || !tab.active || liveHeld(tabId))) {
    triedLive = true
    const got = await liveFrame()
    if (got === null) throw new AgentError('That tab was closed or given back.', 'not_your_tab')
    if (typeof got === 'object') return finish(got.image)
    if (got === 'changed') return none('changed')
  }
  // After a failed try, why the debugger gave none (it is not tried again in this frame).
  const capLive: LiveState = triedLive ? (await liveWord(tabId, true)) ?? 'failed' : live
  // What a frame with no picture says of the debugger's pictures (absent for a tab they never serve).
  const why = async () => (liveOk ? { live: triedLive ? capLive : await liveWord(tabId, false) } : {})
  if (minimized) return { ...none('minimized'), ...(await why()) }
  if (!tab.active) {
    if (personsTab(rec) || !inAgentWindow) return none('behind')
    // No picture through the debugger now (none here, turned off, DevTools on the tab, a dialog,
    // the bar cancelled): the window's own picture, bringing the tab up as before, only while
    // nobody is in that window and its front tab has no command running.
    // The person is in the agent window: their view of it is never switched for a picture.
    if (await windowFocused(tab.windowId)) return { ...none('behind'), ...(await why()) }
    const [front] = await ext.tabs.query({ active: true, windowId: tab.windowId })
    if (front?.id !== undefined && busy(front.id)) return none('busy')
    // The person took the front tab over: never pull it away for a picture.
    if (await frontDriven(tab.windowId)) return { ...none('behind'), ...(await why()) }
    if (front?.id !== undefined && Date.now() - (framedAt.get(front.id) ?? 0) < WATCHED_MS) return { ...none('behind'), ...(await why()) }
    // The agent works in the front tab: a picture of this one now and then, the last one kept meanwhile.
    if (worked(front?.id) && Date.now() - (switchedAt.get(tabId) ?? 0) < BEHIND_EVERY_MS) return none('busy')
  }
  ownerFramedAt.set(rec.owner, Date.now())
  // Whether this frame brought ours up (its group opened: folded again once nobody looks).
  let switched = false
  const shot = await tryCapture(async () => {
    const now = await ext.tabs.get(tabId).catch(() => null)
    if (!now) return null
    // The page or window moved while this frame waited for the gate.
    if ((now.url ?? '') !== url || now.windowId !== tab.windowId) return 'changed' as const
    // The tab the agent works in, put back in front after the picture, inside this turn of the gate.
    let back: number | undefined
    if (!now.active) {
      if (personsTab(rec) || !inAgentWindow || await frontDriven(tab.windowId) || await windowFocused(tab.windowId)) return 'behind' as const
      const [front] = await ext.tabs.query({ active: true, windowId: tab.windowId })
      // Its command took the screen while this frame waited for the gate.
      if (front?.id !== undefined && busy(front.id)) return 'busy' as const
      if (worked(front?.id)) back = front?.id
      await ext.tabs.update(tabId, { active: true })
      switched = true
      switchedAt.set(tabId, Date.now())
      if (switchedAt.size > 50) for (const [id, at] of switchedAt) if (Date.now() - at > WORKED_MS) switchedAt.delete(id)
    }
    try {
      return await pictureNow()
    } finally {
      // Only while ours is still in front and nobody came in meanwhile (a Take over, the person's
      // own click into the window): their tab is never switched away.
      if (back !== undefined && back !== tabId) {
        const [shownNow] = await ext.tabs.query({ active: true, windowId: tab.windowId }).catch(() => [])
        if (shownNow?.id === tabId && !(await frontDriven(tab.windowId)) && !(await windowFocused(tab.windowId))) {
          await ext.tabs.update(back, { active: true }).catch(() => undefined)
        }
      }
    }
  })
  if (switched) noteGroupUse(ext as unknown as GroupApi, rec.owner)
  if (shot === undefined || shot === 'busy') return none('busy')
  if (shot === null) throw new AgentError('That tab was closed or given back.', 'not_your_tab')
  // A covered window says whether live pictures could show it (the card offers to turn them on).
  if (shot === 'covered') return { ...none('covered'), live: coveredLive.get(tabId) ?? 'unavailable' }
  if (shot === 'behind') return { ...none('behind'), ...(await why()) }
  if (shot === 'failed' || shot === 'changed') return none(shot)
  return finish(shot)

  async function pictureNow(): Promise<string | 'failed' | 'changed' | 'covered' | null> {
    let image: string
    const got = await pictureOf(tabId, win, full, capLive)
    if (typeof got !== 'string') return got
    image = got
    // What was on screen must be this tab still (a page's popup, another agent's tab brought up meanwhile).
    const [shown] = await ext.tabs.query({ active: true, windowId: win })
    if (shown?.id !== tabId) return 'changed' as const
    // Still this owner's tab, on the same page in the same window, after the capture: else the
    // picture may show a page the task does not hold (Stop, a give-back, a move to a Walnut page;
    // review 2026-11-07).
    const owner = await agentTabs.get(tabId)
    if (!sameHolding(owner)) return null
    const after = await ext.tabs.get(tabId).catch(() => null)
    if (!after) return null
    if ((after.url ?? '') !== url || after.windowId !== win) return 'changed' as const
    framedAt.set(tabId, Date.now())
    if (framedAt.size > 50) for (const [id, at] of framedAt) if (Date.now() - at > WATCHED_MS) framedAt.delete(id)
    return image
  }

  /** The picture through the debugger (agent-live.ts), in place; then the same checks as a capture's. */
  async function liveFrame(): Promise<{ image: string } | 'failed' | 'changed' | null> {
    ownerFramedAt.set(holder.owner, Date.now())
    let image: string
    try { image = await livePicture(tabId, STREAM_QUALITY) } catch { return 'failed' }
    if (!sameHolding(await agentTabs.get(tabId))) return null
    const after = await ext.tabs.get(tabId).catch(() => null)
    if (!after) return null
    if ((after.url ?? '') !== url || after.windowId !== win) return 'changed'
    framedAt.set(tabId, Date.now())
    coveredLive.delete(tabId)
    return { image }
  }

  async function finish(shot: string): Promise<Record<string, unknown>> {
  const image = full ? shot : await shrink(shot)
  // The last look, after the picture was made small: still this holding, on the same page.
  const last = await ext.tabs.get(tabId).catch(() => null)
  if (!sameHolding(await agentTabs.get(tabId)) || !last) throw new AgentError('That tab was closed or given back.', 'not_your_tab')
  if ((last.url ?? '') !== url || last.windowId !== win) return none('changed')
  // Whether the person has the tab now (Take over), as of the picture.
  const nowRec = await agentTabs.get(tabId)
  return { ...(await where(tabId)), shown: true, image, at: new Date().toISOString(), ...whose(nowRec ?? rec) }
  }
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
/** Frames without a picture after which the stream holds no debugger for the tab (agent-live.ts). */
const LETS_GO = new Set<string>(['minimized', 'behind', 'not_web', 'walnut_page', 'no_permission', 'discarded'])
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
      // No picture of this tab can come now for a reason no capture changes (minimized or behind
      // with no picture through the debugger either, not a web page): the debugger goes meanwhile.
      if (frame.shown !== true && typeof frame.why === 'string' && LETS_GO.has(frame.why)) await endLive(tabId)
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
    // Nobody watches: live pictures let the debugger go (its bar goes with it), unless a new stream took over.
    if (!streams.has(tabId)) await endLive(tabId)
  }
}

export function _resetViewForTesting(): void {
  coveredLive.clear()
  framedAt.clear()
  ownerFramedAt.clear()
  workedAt.clear()
  switchedAt.clear()
}
