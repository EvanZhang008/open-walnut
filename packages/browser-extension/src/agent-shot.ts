/**
 * A screenshot of an agent's tab: what is on screen, or (`full`) the whole page, scrolled through
 * and drawn into one image, at most FULL_MAX_PX tall. A password the page shows as text is drawn
 * as dots while it is taken, in every frame; the page's scroll is put back after. `annotate`
 * numbers the elements on screen (page-annotate.ts; `click {label}` clicks one), and `zoom`
 * crops a region at the picture's full resolution (agent-picture.ts).
 */
import { ext, type Tab } from './ext'
import { siteKey } from '../../../src/core/vault/url-match'
import { toPage } from './page-reach'
import { framesOf } from './agent-page'
import { WindowCovered, capture, withCapture } from './capture-gate'
import { endShot, liveHeld, liveShot, liveState } from './agent-live'
import { frontDriven } from './agent-takeover'
import { base64, cropPicture, drawLabels } from './agent-picture'
import type { LabelBox } from './input-math'
import { AgentError, WALNUT_PAGE, agentWindowId, checkPage, frameOp, mark, personsTab, reached, sleep, where, type AgentTab, type WireCommand } from './agent-shared'

export const FULL_MAX_PX = 12_000
/** The browser takes at most two captures a second. */
const CAPTURE_GAP_MS = 550
/** A full page stops here, under the command's own limit. */
const FULL_BUDGET_MS = 25_000

type Shoot = (o: { format: 'jpeg' | 'png'; quality?: number }) => Promise<string>

/**
 * The window's picture; a covered window's through the debugger only while the Browser view's
 * stream holds it for this tab (agent-live.ts liveHeld: someone watches the card, and live pictures
 * are on; it draws the page off screen, no window moves). Nobody watching: the covered error as it
 * was, with no attach and no debugging bar for a picture nobody asked to see live (review 2026-11-09).
 */
export function shooter(tabId: number, windowId: number, liveOk: boolean): Shoot {
  return async (o) => {
    try {
      return await capture(windowId, o)
    } catch (err) {
      // Only an agent's own tab in Walnut's agent window: never the debugger on a tab of the person's.
      if (!(err instanceof WindowCovered) || !liveOk || !liveHeld(tabId) || await liveState(tabId) !== 'on') throw err
      return liveShot(tabId, o)
    }
  }
}

async function maskAll(tabId: number, on: boolean): Promise<boolean> {
  const top = await toPage<{ ok?: boolean }>(tabId, { type: 'agent-mask', on }, 5000)
  for (const f of await framesOf(tabId)) await toPage(tabId, { type: 'agent-mask', on }, 3000, f.frameId)
  return top?.ok === true
}

/** `format: 'png'` (the CLI asks for it for a .png file), else JPEG. */
const pngOf = (c: WireCommand) => c.args.format === 'png'

async function full(c: WireCommand, tabId: number, shoot: Shoot): Promise<{ image: string; height: number; pageHeight: number; cut: boolean }> {
  const m = await frameOp(tabId, 0, 'capture', { step: 'start' }, c.allow, 5000) as { x: number; y: number; w: number; h: number; total: number }
  const height = Math.min(m.total, FULL_MAX_PX)
  const slices: Array<{ y: number; img: string }> = []
  const start = Date.now()
  let last = 0
  let cut = m.total > FULL_MAX_PX
  try {
    for (let y = 0; y < height;) {
      const at = await frameOp(tabId, 0, 'capture', { step: 'at', y, hideFixed: slices.length > 0 }, c.allow, 5000) as { y: number }
      await sleep(Math.max(slices.length ? 150 : 300, last + CAPTURE_GAP_MS - Date.now()))
      last = Date.now()
      slices.push({ y: at.y, img: await shoot({ format: 'jpeg', quality: 80 }) })
      // The page would not scroll further: this was its bottom.
      if (at.y < y - 1 || at.y + m.h >= height) break
      y = at.y + m.h
      if (Date.now() - start > FULL_BUDGET_MS) { cut = true; break }
    }
  } finally {
    await frameOp(tabId, 0, 'capture', { step: 'end', x: m.x, y: m.y }, c.allow, 5000).catch(() => undefined)
  }
  if (!slices.length || m.w < 1 || m.h < 1) throw new AgentError('The page has nothing to capture.', 'page_not_ready')
  const drawn = Math.min(height, Math.max(...slices.map((s) => s.y + m.h)))
  // Drawn at CSS pixels (one per pixel of the page), whatever the screen's density.
  const canvas = new OffscreenCanvas(m.w, drawn)
  const ctx = canvas.getContext('2d')!
  for (const s of slices) {
    const bmp = await createImageBitmap(await (await fetch(s.img)).blob())
    ctx.drawImage(bmp, 0, s.y, m.w, m.h)
    bmp.close()
  }
  const type = pngOf(c) ? 'image/png' : 'image/jpeg'
  const blob = await canvas.convertToBlob(pngOf(c) ? { type } : { type, quality: 0.7 })
  return { image: `data:${type};base64,${base64(await blob.arrayBuffer())}`, height: drawn, pageHeight: m.total, cut: cut || drawn < height }
}

/** `zoom {x, y, width, height}`: the region, CSS pixels of the viewport. */
function zoomRegion(a: Record<string, unknown>): { x: number; y: number; width: number; height: number } {
  const [x, y, width, height] = [a.x, a.y, a.width, a.height].map(Number)
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) throw new AgentError('zoom takes the region: x, y, width and height in CSS pixels of the page on screen.', 'bad_request')
  return { x, y, width: Math.min(width, 4000), height: Math.min(height, 4000) }
}

/** The picture of what is on screen, then numbered (annotate) or cropped (zoom). */
async function onScreen(c: WireCommand, tabId: number, shoot: Shoot): Promise<Record<string, unknown>> {
  const png = pngOf(c)
  if (c.action === 'zoom') {
    const region = zoomRegion(c.args)
    const m = await frameOp(tabId, 0, 'capture', { step: 'start' }, c.allow, 5000) as { w: number; h: number }
    // The whole picture as PNG: the crop keeps every pixel of it.
    const shot = await shoot({ format: 'png' })
    const z = await cropPicture(shot, region, m.w, png)
    if (!z) throw new AgentError(`Nothing of that region is on screen (the page shows ${m.w}x${m.h} CSS pixels).`, 'bad_request')
    return { image: z.image, zoom: region, pixels: { width: z.width, height: z.height }, scale: z.scale }
  }
  if (c.args.annotate === true) {
    const ann = await frameOp(tabId, 0, 'annotate', {}, c.allow, 8000) as { boxes: LabelBox[]; vw: number; more?: number }
    const shot = await shoot(png ? { format: 'png' } : { format: 'jpeg', quality: 85 })
    const image = await drawLabels(shot, ann.boxes, ann.vw, png)
    return {
      image, annotated: true, labels: ann.boxes.map((b) => ({ label: b.label, ref: b.ref, role: b.role, name: b.name })),
      ...(ann.more ? { note: `${ann.more} more element(s) on screen are not numbered: zoom in, or use snapshot.` } : {}),
    }
  }
  return { image: await shoot(png ? { format: 'png' } : { format: 'jpeg', quality: 70 }) }
}

export async function screenshot(c: WireCommand, tabId: number, tab: Tab, rec: AgentTab): Promise<Record<string, unknown>> {
  if (c.args.full === true && (c.action === 'zoom' || c.args.annotate === true)) throw new AgentError('annotate and zoom work on what is on screen, not with full: scroll to the part first.', 'bad_request')
  // Only the agent window is brought forward for a capture: the person's window stays as they left it.
  // A tab outside the agent window (the person's, or one it opened there) is captured only while on screen.
  if (!tab.active && (personsTab(rec) || tab.windowId !== await agentWindowId())) throw new AgentError('That tab is not on screen in the person\'s window: use snapshot, or ask them to show it.', 'tab_hidden')
  await checkPage(c.allow, tab.url ?? '')
  const before = await reached(tabId)
  if (before.walnut) throw new AgentError(WALNUT_PAGE, 'walnut_page')
  await checkPage(c.allow, before.href)
  // One capture at a time (capture-gate.ts): the live Browser view's frames wait while this tab is brought up and taken.
  const out = await withCapture(async () => {
    // Only a tab on screen in its window can be captured: bring it up there, in the agent window,
    // unless the person took over the tab in front (it would be pulled away from under them).
    if (!(await ext.tabs.get(tabId).catch(() => tab)).active && await frontDriven(tab.windowId)) {
      throw new AgentError('The person took over another tab in the agent window and is using it: use snapshot for this tab, or wait until they hand it back.', 'person_driving')
    }
    // The person is in the agent window looking at another tab: never switched under their eyes.
    if (!(await ext.tabs.get(tabId).catch(() => tab)).active && (await ext.windows.get(tab.windowId!).catch(() => null) as { focused?: boolean } | null)?.focused) {
      throw new AgentError('The person is looking at another tab in the agent window: use snapshot for this tab, or try again in a moment.', 'person_looking')
    }
    await ext.tabs.update(tabId, { active: true })
    // A password the page shows as text (its "show" button) is drawn as dots for the capture.
    let out: Record<string, unknown>
    const shoot = shooter(tabId, tab.windowId!, !personsTab(rec) && tab.windowId === await agentWindowId())
    try {
      if (!(await maskAll(tabId, true))) throw new AgentError('The page is not ready: wait and try again.', 'page_not_ready')
      await sleep(250)
      if (c.args.full === true) {
        // The frame and its Stop pill would be drawn once per screen: off while the agent's own tab
        // is scrolled through (a tab of the person's keeps them, they may be looking).
        const unmark = !personsTab(rec)
        if (unmark) await mark(tabId, false)
        const f = await full(c, tabId, shoot).finally(() => unmark ? mark(tabId, true, rec.who) : undefined)
        out = { image: f.image, full: true, height: f.height, pageHeight: f.pageHeight, ...(f.cut ? { cut: true, note: `Cut at ${f.height} of ${f.pageHeight} px of the page.` } : {}) }
      } else {
        out = await onScreen(c, tabId, shoot)
      }
    } finally {
      await endShot(tabId)
      await maskAll(tabId, false)
    }
    // What was on screen must still be that tab on that page (not a window the page opened).
    const [shown] = await ext.tabs.query({ active: true, windowId: tab.windowId })
    if (shown?.id !== tabId || siteKey(shown.url ?? '')?.domain !== siteKey(before.href)?.domain) {
      throw new AgentError('The page changed while the screenshot was taken: try again.', 'page_changed')
    }
    return out
  })
  return { ...(await where(tabId)), ...out }
}
