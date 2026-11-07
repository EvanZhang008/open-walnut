/**
 * The live Browser view in a Walnut task (web: components/sessions/SessionBrowserCard.tsx;
 * server: GET /api/v1/browser/view/frame): one small picture of an agent's tab, asked for only
 * while the person has the view open, about once a second or two.
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
import { AgentError, agentTabs, agentWindowId, personsTab, walnutCheck, where, type WireCommand } from './agent-shared'
import { walnutAddress } from './walnut-address'
import { capture, tryCapture } from './capture-gate'

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

/** `view_frame {tab}`: the tab as it is now, or why there is no picture (and still its title, address and window). */
export async function viewFrame(c: WireCommand, busy: (tabId: number) => boolean): Promise<Record<string, unknown>> {
  const tabId = typeof c.args.tab === 'number' ? c.args.tab : NaN
  const rec = await agentTabs.get(tabId)
  if (!rec) throw new AgentError('That tab is no agent\'s now (closed, or given back with Stop).', 'not_your_tab')
  const tab = await ext.tabs.get(tabId).catch(() => null)
  if (!tab || tab.windowId === undefined) { await agentTabs.delete(tabId); throw new AgentError('That tab was closed.', 'not_your_tab') }
  const at = await where(tabId)
  const none = (why: NoFrame) => ({ ...at, shown: false, why, ...(rec.handed ? { handed: true } : rec.taken ? { taken: true } : {}) })
  const url = tab.url ?? ''
  if (!/^https?:\/\//i.test(url)) return none('not_web')
  if (await walnutCheck.isWalnutPage(url) || walnutAddress(c.allow.walnut, url)) return none('walnut_page')
  if (!(await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false))) return none('no_permission')
  if (at.windowState === 'minimized') return none('minimized')
  const inAgentWindow = tab.windowId === await agentWindowId()
  if (!tab.active) {
    if (personsTab(rec) || !inAgentWindow) return none('behind')
    const [front] = await ext.tabs.query({ active: true, windowId: tab.windowId })
    if (front?.id !== undefined && busy(front.id)) return none('busy')
    if (front?.id !== undefined && Date.now() - (framedAt.get(front.id) ?? 0) < WATCHED_MS) return none('behind')
  }
  const shot = await tryCapture(async () => {
    const now = await ext.tabs.get(tabId).catch(() => null)
    if (!now) return null
    if (!now.active) {
      if (personsTab(rec) || !inAgentWindow) return 'behind' as const
      await ext.tabs.update(tabId, { active: true })
    }
    let image: string
    try { image = await capture(tab.windowId!, { format: 'jpeg', quality: 60 }) } catch { return 'failed' as const }
    // What was on screen must be this tab still (a page's popup, another agent's tab brought up meanwhile).
    const [shown] = await ext.tabs.query({ active: true, windowId: tab.windowId })
    if (shown?.id !== tabId) return 'changed' as const
    framedAt.set(tabId, Date.now())
    if (framedAt.size > 50) for (const [id, at] of framedAt) if (Date.now() - at > WATCHED_MS) framedAt.delete(id)
    return image
  })
  if (shot === undefined) return none('busy')
  if (shot === null) throw new AgentError('That tab was closed.', 'not_your_tab')
  if (shot === 'behind' || shot === 'failed' || shot === 'changed') return none(shot)
  return { ...(await where(tabId)), shown: true, image: await shrink(shot), at: new Date().toISOString(), ...(rec.handed ? { handed: true } : rec.taken ? { taken: true } : {}) }
}
