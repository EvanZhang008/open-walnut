/**
 * The agent's cursor from the background's side (the page draws it: page-cursor.ts). A step in a
 * frame sends its point here (`agent-cursor-up`): the frame's offset in the page is worked out and
 * the cursor is drawn in the top document, where the person sees one cursor over the whole page.
 * The offset comes from the frames' own documents (`agent-frame-box`, runtime.getFrameId), no new
 * permission: the top document first (its frames, and frames in those of its own site), then any
 * frame of the tab that holds the target frame, whose own offset is found the same way.
 */
import type { Sender } from './ext'
import { agentTabs } from './agent-shared'
import { framesOf } from './agent-page'
import { toPage } from './page-reach'

/** The whole search ends by then: the frame draws the cursor itself after its own wait (page-cursor.ts UP_MS). */
const SEARCH_MS = 2200
const ASK_MS = 800
const MAX_DEPTH = 3
/** A frame whose place could not be found is not looked for again this long: it draws the cursor itself at once. */
const MISS_MS = 30_000
const missed = new Map<string, number>()

type Box = { x: number; y: number }

export function _resetCursorRelayForTesting(): void { missed.clear() }

/** Where frame `frameId` starts in the top document's viewport, or null when it cannot be worked out by `deadline`. */
export async function frameOrigin(tabId: number, frameId: number, deadline = Date.now() + SEARCH_MS, depth = 0): Promise<Box | null> {
  const left = () => Math.min(ASK_MS, deadline - Date.now())
  if (left() < 50) return null
  const top = await toPage<{ box?: Box | null }>(tabId, { type: 'agent-frame-box', frameId }, left(), 0)
  if (top?.box) return top.box
  if (depth >= MAX_DEPTH) return null
  // Inside a frame of another site: the frame that holds it says where, and its own place is found the same way.
  for (const f of await framesOf(tabId)) {
    if (f.frameId === frameId || left() < 50) continue
    const r = await toPage<{ box?: Box | null }>(tabId, { type: 'agent-frame-box', frameId }, left(), f.frameId)
    if (!r?.box) continue
    const up = await frameOrigin(tabId, f.frameId, deadline, depth + 1)
    return up ? { x: up.x + r.box.x, y: up.y + r.box.y } : null
  }
  return null
}

/** `agent-cursor-up {x, y, kind}` from a frame of an agent's tab: drawn in the top document when its place is known. */
export async function cursorUp(msg: Record<string, unknown>, sender: Sender): Promise<{ ok: true; placed: boolean }> {
  const tabId = sender.tab?.id
  const frameId = sender.frameId
  const x = Number(msg.x), y = Number(msg.y)
  if (tabId === undefined || !frameId || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: true, placed: false }
  // Only an agent's tab: a page the person has to themselves never shows Walnut's cursor.
  const held = await agentTabs.get(tabId)
  if (!held) return { ok: true, placed: false }
  const key = `${tabId}:${frameId}`
  if ((missed.get(key) ?? 0) > Date.now()) return { ok: true, placed: false }
  const o = await frameOrigin(tabId, frameId)
  if (!o) { missed.set(key, Date.now() + MISS_MS); if (missed.size > 200) missed.delete(missed.keys().next().value!); return { ok: true, placed: false } }
  // Let go while its place was looked for: no cursor is drawn after the release took it away.
  if ((await agentTabs.get(tabId))?.grant !== held.grant) return { ok: true, placed: true }
  const kind = msg.kind === 'click' || msg.kind === 'drag' ? msg.kind : 'move'
  const r = await toPage<{ placed?: boolean }>(tabId, { type: 'agent-cursor', x: o.x + x, y: o.y + y, kind }, 1500, 0)
  return { ok: true, placed: r?.placed === true }
}
