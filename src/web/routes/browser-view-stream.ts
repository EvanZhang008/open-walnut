/**
 * The Browser view's picture stream (browser-view-v1.ts mounts it; the extension's side is
 * packages/browser-extension/src/agent-view.ts). 2026-11-08, the user: "very laggy like it doesn't
 * show in real time, it takes so long to screenshot, and very bad". Before, every picture was one
 * command on the extension's long poll and one small JPEG made in its background: none came back on
 * a busy Mac in two days (319 asks, 0 pictures, 5.3 s each on average).
 *
 * Now, while a viewer watches a tab:
 *   - the first viewer's request sends the browser one `view_watch`; from then on the browser posts
 *     each picture itself (POST /browser/view/push) as soon as it may take one (two a second), at
 *     the screen's own pixels, and the answer to each post says whether anyone still watches;
 *   - a viewer asks with the number of the picture it has (`after`) and is answered when there is a
 *     newer one, or after FRAME_WAIT_MS with `unchanged` (a short hold, then it asks again), so a
 *     picture reaches the page as soon as it reaches Walnut;
 *   - a watch nobody renews ends by itself (the browser stops within WATCH_MS), and a stream that
 *     stopped posting while watched is started again.
 * Only for the holding the viewer asked about: a tab another task took, or held again after a Stop,
 * starts a stream of its own (the earlier holding's pictures are never shown).
 */
import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { onHoldingEnded } from '../../core/browser-control/hub.js'

type Hub = typeof import('../../core/browser-control/hub.js')

/** A viewer asked within this: the browser goes on posting. */
export const WATCH_FRESH_MS = 4000
/** No picture posted this long while watched: the browser is asked to watch again. */
export const STREAM_STALE_MS = 2500
/** A viewer's request waits this long for a newer picture. */
/**
 * Short on purpose: a held request keeps one of the page's few connections (six per host on
 * HTTP/1.1, and the client's own admission queue), so the card asks again soon instead.
 */
export const FRAME_WAIT_MS = 450
/** The longest picture taken (a data: URL); larger is dropped. */
const IMAGE_MAX_CHARS = 12 * 1024 * 1024
/** A stream nobody watched for this long is forgotten with its picture. */
const FORGET_MS = 60_000

interface Live {
  /**
   * Which stream this is: a viewer's `after` counts only within it, so a restart or a new holding
   * (both start again at seq 0) never answers `unchanged` to a viewer holding an old picture.
   */
  epoch: string
  gen: number | undefined
  /** Bumps when what a viewer sees changes (a new picture, or the tab's words). */
  seq: number
  frame?: Record<string, unknown>
  /** The words the last post carried, to tell a change. */
  sig: string
  watchedAt: number
  pushAt: number
  /** Since when the posts carry no picture (the tab behind, the screen held...): the card says how long. */
  noPictureSince?: number
  watchSentAt: number
  waiters: Set<() => void>
}

const lives = new Map<string, Live>()
const keyOf = (device: string, tab: number) => `${device}:${tab}`
const BOOT = crypto.randomUUID().slice(0, 8)
let epochs = 0

function sweep(now: number): void {
  for (const [k, l] of lives) if (now - l.watchedAt > FORGET_MS && !l.waiters.size) lives.delete(k)
}

function bump(l: Live): void {
  l.seq++
  for (const fn of l.waiters) fn()
  l.waiters.clear()
}

/** The words of a post, what a viewer reads beside the picture. */
function meta(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['url', 'title', 'window', 'windowState', 'why'] as const) if (typeof b[k] === 'string') out[k] = (b[k] as string).slice(0, k === 'url' ? 4000 : 300)
  for (const k of ['shown', 'handed', 'taken', 'driving'] as const) if (b[k] === true) out[k] = true
  return out
}

/**
 * A viewer's frame request for a browser that streams. `stillHeld` is the route's own check of the
 * holding; `watch` sends the browser its `view_watch`.
 */
export async function streamFrame(req: Request, res: Response, o: {
  device: string; tab: number; gen: number | undefined; browser: string
  stillHeld: () => boolean
  watch: () => Promise<unknown>
  notHeld: () => Error
}): Promise<Record<string, unknown>> {
  const now = Date.now()
  sweep(now)
  const k = keyOf(o.device, o.tab)
  let l = lives.get(k)
  if (!l || l.gen !== o.gen) {
    if (l) bump(l)
    l = { epoch: `${BOOT}-${++epochs}`, gen: o.gen, seq: 0, sig: '', watchedAt: now, pushAt: 0, watchSentAt: 0, waiters: new Set() }
    lives.set(k, l)
  }
  const live = l
  live.watchedAt = now
  if (now - live.pushAt > STREAM_STALE_MS && now - live.watchSentAt > STREAM_STALE_MS) {
    live.watchSentAt = now
    // Its answer only says it started: the pictures come by post.
    void o.watch().catch(() => { live.watchSentAt = 0 })
  }
  const after = req.query.epoch === live.epoch ? Number(req.query.after) : NaN
  if (!(Number.isFinite(after) && live.seq > after) && !(live.frame && !Number.isFinite(after))) {
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(t); res.off('close', done); live.waiters.delete(done); resolve() }
      const t = setTimeout(done, FRAME_WAIT_MS)
      t.unref?.()
      res.on('close', done)
      live.waiters.add(done)
    })
  }
  live.watchedAt = Date.now()
  if (!o.stillHeld() || lives.get(k) !== live) throw o.notHeld()
  const base = { tab: o.tab, device: o.device, browser: o.browser, seq: live.seq, epoch: live.epoch, stream: true }
  const since = live.noPictureSince ? { noPictureSince: new Date(live.noPictureSince).toISOString() } : {}
  if (!live.frame) return { ...base, shown: false, why: 'starting' }
  if (Number.isFinite(after) && live.seq <= after) return { ...base, ...since, unchanged: true, at: live.frame.at }
  return { ...live.frame, ...base, ...since }
}

/** The browser's post of a picture (POST /browser/view/push): kept for the viewers; the answer says whether to go on. */
export function streamPush(h: Hub, device: string, b: Record<string, unknown>): { more: boolean; ms?: number; again?: boolean } {
  const tab = typeof b.tab === 'number' && Number.isInteger(b.tab) && b.tab >= 0 ? b.tab : undefined
  if (tab === undefined || !h.tabOwner(device, tab)) return { more: false }
  const k = keyOf(device, tab)
  const live = lives.get(k)
  // Nobody asked for this holding's pictures.
  if (!live || live.gen !== h.tabGen(device, tab)) return { more: false }
  const now = Date.now()
  sweep(now)
  live.pushAt = now
  if (b.gone === true) {
    live.frame = { shown: false, why: 'gone', at: new Date(now).toISOString() }
    bump(live)
    return { more: false }
  }
  const m = meta(b)
  const at = typeof b.at === 'string' ? b.at.slice(0, 40) : new Date(now).toISOString()
  const fresh = typeof b.image === 'string' && b.image.startsWith('data:image/') && b.image.length <= IMAGE_MAX_CHARS ? b.image : undefined
  const before = live.frame?.image
  const image = fresh ?? (b.same === true && m.shown ? before : undefined)
  if (fresh || (b.same === true && m.shown)) live.noPictureSince = undefined
  else live.noPictureSince ??= now
  const sig = JSON.stringify(m)
  const changed = sig !== live.sig || (image !== undefined && image !== before)
  live.sig = sig
  live.frame = { ...m, at, ...(image ? { image } : {}) }
  h.noteTab(device, tab, { url: m.url as string | undefined, title: m.title as string | undefined, window: m.window as 'agent' | 'person' | undefined, windowState: m.windowState as string | undefined, driving: m.driving === true })
  if (changed) bump(live)
  // A picture said to be the same as one Walnut no longer has (it restarted): the next one comes whole.
  const again = b.same === true && !before
  const more = now - live.watchedAt < WATCH_FRESH_MS
  // Nobody watches any more: the picture (up to 12 MB) is not kept; the next viewer starts afresh.
  if (!more) { live.frame = undefined; live.sig = '' }
  return { more, ms: 5000, ...(again ? { again: true } : {}) }
}

/** The tab's stream ends now (Stop): its viewers hear at once. */
export function endStream(device: string, tab: number): void {
  const l = lives.get(keyOf(device, tab))
  if (!l) return
  lives.delete(keyOf(device, tab))
  bump(l)
}

// The tab's holding ended: its stream with it.
onHoldingEnded((device, tab) => { endStream(device, tab) })

export function _resetBrowserStreamsForTesting(): void {
  for (const l of lives.values()) bump(l)
  lives.clear()
}
