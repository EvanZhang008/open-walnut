/**
 * A screenshot of an agent's tab: what is on screen, or (`full`) the whole page, scrolled through
 * and drawn into one image, at most FULL_MAX_PX tall. A password the page shows as text is drawn
 * as dots while it is taken, in every frame; the page's scroll is put back after.
 */
import { ext, type Tab } from './ext'
import { siteKey } from '../../../src/core/vault/url-match'
import { toPage } from './page-reach'
import { framesOf } from './agent-page'
import { AgentError, WALNUT_PAGE, agentWindowId, checkPage, frameOp, mark, personsTab, reached, sleep, where, type AgentTab, type WireCommand } from './agent-shared'

export const FULL_MAX_PX = 12_000
/** The browser takes at most two captures a second. */
const CAPTURE_GAP_MS = 550
/** A full page stops here, under the command's own limit. */
const FULL_BUDGET_MS = 25_000

async function maskAll(tabId: number, on: boolean): Promise<boolean> {
  const top = await toPage<{ ok?: boolean }>(tabId, { type: 'agent-mask', on }, 5000)
  for (const f of await framesOf(tabId)) await toPage(tabId, { type: 'agent-mask', on }, 3000, f.frameId)
  return top?.ok === true
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function full(c: WireCommand, tabId: number, tab: Tab): Promise<{ image: string; height: number; pageHeight: number; cut: boolean }> {
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
      slices.push({ y: at.y, img: await ext.tabs.captureVisibleTab(tab.windowId!, { format: 'jpeg', quality: 80 }) })
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
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
  return { image: `data:image/jpeg;base64,${base64(await blob.arrayBuffer())}`, height: drawn, pageHeight: m.total, cut: cut || drawn < height }
}

export async function screenshot(c: WireCommand, tabId: number, tab: Tab, rec: AgentTab): Promise<Record<string, unknown>> {
  // Only the agent window is brought forward for a capture: the person's window stays as they left it.
  // A tab outside the agent window (the person's, or one it opened there) is captured only while on screen.
  if (!tab.active && (personsTab(rec) || tab.windowId !== await agentWindowId())) throw new AgentError('That tab is not on screen in the person\'s window: use snapshot, or ask them to show it.', 'tab_hidden')
  await checkPage(c.allow, tab.url ?? '')
  const before = await reached(tabId)
  if (before.walnut) throw new AgentError(WALNUT_PAGE, 'walnut_page')
  await checkPage(c.allow, before.href)
  // Only a tab on screen in its window can be captured: bring it up there, in the agent window.
  await ext.tabs.update(tabId, { active: true })
  // A password the page shows as text (its "show" button) is drawn as dots for the capture.
  let out: Record<string, unknown>
  try {
    if (!(await maskAll(tabId, true))) throw new AgentError('The page is not ready: wait and try again.', 'page_not_ready')
    await sleep(250)
    if (c.args.full === true) {
      // The frame and its Stop pill would be drawn once per screen: off while the agent's own tab
      // is scrolled through (a tab of the person's keeps them, they may be looking).
      const unmark = !personsTab(rec)
      if (unmark) await mark(tabId, false)
      const f = await full(c, tabId, tab).finally(() => unmark ? mark(tabId, true, rec.who) : undefined)
      out = { image: f.image, full: true, height: f.height, pageHeight: f.pageHeight, ...(f.cut ? { cut: true, note: `Cut at ${f.height} of ${f.pageHeight} px of the page.` } : {}) }
    } else {
      out = { image: await ext.tabs.captureVisibleTab(tab.windowId!, { format: 'jpeg', quality: 70 }) }
    }
  } finally {
    await maskAll(tabId, false)
  }
  // What was on screen must still be that tab on that page (not a window the page opened).
  const [shown] = await ext.tabs.query({ active: true, windowId: tab.windowId })
  if (shown?.id !== tabId || siteKey(shown.url ?? '')?.domain !== siteKey(before.href)?.domain) {
    throw new AgentError('The page changed while the screenshot was taken: try again.', 'page_changed')
  }
  return { ...(await where(tabId)), ...out }
}
