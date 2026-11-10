/**
 * The agent's cursor from the background's side (the page draws it: page-cursor.ts). A step in a
 * frame sends its point here (`agent-cursor-up`): the frame's offset in the page is worked out and
 * the cursor is drawn in the top document, where the person sees one cursor over the whole page.
 * The offset comes from the frames' own documents, no new permission. Where the browser gives a
 * content script runtime.getFrameId (Firefox), the top document names its frame elements' ids
 * (`agent-frame-box`): the top document first (its frames, and frames in those of its own site), then
 * any frame of the tab that holds the target frame. Chrome does not (2026-11-09: undefined in Chrome
 * 145; the land gate's e2e found every frame's cursor drawn inside the frame), so then the frame says
 * hello to its parent window (`agent-frame-hello`, page-cursor.ts listenHello), and the parent's
 * script answers where that frame element starts (`agent-frame-hello-box`), up to the top document.
 */
import type { Sender } from './ext'
import { agentTabs } from './agent-shared'
import { framesOf } from './agent-page'
import { toPage } from './page-reach'
import { ext } from './ext'

/**
 * The whole search ends by then, and the drawing in the top document within DRAW_MS after it, both
 * inside the frame's own wait (page-cursor.ts UP_MS, 6 s): past that the frame draws the cursor
 * itself. 2026-11-09, the land gate on a loaded runner: an 800 ms ask of the top document ran out,
 * the miss was remembered for 30 s, and every later step drew the cursor inside the frame.
 */
export const SEARCH_MS = 3500
const ASK_MS = 1500
const DRAW_MS = 2000
const MAX_DEPTH = 3
/**
 * A frame the documents answered "not here" for is not looked for again this long: it draws the
 * cursor itself at once. A search that ran out of time is no answer and is tried again next step.
 */
const MISS_MS = 30_000
const missed = new Map<string, number>()

type Box = { x: number; y: number }

export function _resetCursorRelayForTesting(): void { missed.clear(); hellos.clear() }

/** Where frame `frameId` starts in the top document's viewport, or null when it cannot be worked out by `deadline`. */
/**
 * `seen.unanswered`: a document did not answer in time, or time ran out before every one was asked,
 * so a null is no "not here" (cursorUp remembers only those). A frame with no script to answer (an
 * ad, about:blank: the send fails at once) is a "not here".
 */
export async function frameOrigin(tabId: number, frameId: number, deadline = Date.now() + SEARCH_MS, depth = 0, seen: { unanswered: boolean } = { unanswered: false }): Promise<Box | null> {
  const left = () => Math.min(ASK_MS, deadline - Date.now())
  const ask = async (inFrame: number): Promise<{ box?: Box | null } | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), left()) })
    const asked = Promise.resolve(ext.tabs.sendMessage(tabId, { type: 'agent-frame-box', frameId }, { frameId: inFrame }))
      .then((r) => (r ?? null) as { box?: Box | null } | null, () => null)
    const r = await Promise.race([asked, late]).finally(() => clearTimeout(timer))
    if (r === 'late') { seen.unanswered = true; return null }
    return r
  }
  if (left() < 50) { seen.unanswered = true; return null }
  const top = await ask(0)
  if (top?.box) return top.box
  if (depth >= MAX_DEPTH) return null
  // Inside a frame of another site: the frame that holds it says where, and its own place is found the same way.
  for (const f of await framesOf(tabId)) {
    if (f.frameId === frameId) continue
    if (left() < 50) { seen.unanswered = true; break }
    const r = await ask(f.frameId)
    if (!r?.box) continue
    const up = await frameOrigin(tabId, f.frameId, deadline, depth + 1, seen)
    return up ? { x: up.x + r.box.x, y: up.y + r.box.y } : null
  }
  return null
}

/** Hellos on their way to the parent's answer, by token. */
const hellos = new Map<string, (r: { tab: number; parent: number; box: Box }) => void>()

/**
 * Where frame `frameId` starts in the top document, found by its hellos up the frame tree (the
 * parent's own place found the same way). Null when no document says (`seen.unanswered` when one
 * did not answer in time).
 */
export async function helloOrigin(tabId: number, frameId: number, deadline: number, depth = 0, seen: { unanswered: boolean } = { unanswered: false }): Promise<Box | null> {
  const left = () => Math.min(ASK_MS, deadline - Date.now())
  if (left() < 50) { seen.unanswered = true; return null }
  const token = crypto.randomUUID()
  const answered = new Promise<{ tab: number; parent: number; box: Box }>((resolve) => hellos.set(token, resolve))
  try {
    const sent = await toPage<{ ok?: boolean }>(tabId, { type: 'agent-frame-hello', token }, left(), frameId)
    // No script there to say hello, or the top document itself: no place from here.
    if (!sent?.ok) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), Math.max(0, left())) })
    const r = await Promise.race([answered, late]).finally(() => clearTimeout(timer))
    if (r === 'late') { seen.unanswered = true; return null }
    if (r.tab !== tabId) return null
    if (r.parent === 0) return r.box
    if (depth >= MAX_DEPTH) return null
    const up = await helloOrigin(tabId, r.parent, deadline, depth + 1, seen)
    return up ? { x: up.x + r.box.x, y: up.y + r.box.y } : null
  } finally {
    hellos.delete(token)
  }
}

/** `agent-frame-hello-box {token, box}` from the document holding a frame that said hello: where it starts there. */
export function frameHelloBox(msg: Record<string, unknown>, sender: Sender): { ok: true } {
  const done = hellos.get(String(msg.token ?? ''))
  const box = msg.box as { x?: unknown; y?: unknown } | undefined
  const x = Number(box?.x), y = Number(box?.y)
  if (done && sender.tab?.id !== undefined && typeof sender.frameId === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
    hellos.delete(String(msg.token))
    done({ tab: sender.tab.id, parent: sender.frameId, box: { x, y } })
  }
  return { ok: true }
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
  const seen = { unanswered: false }
  const deadline = Date.now() + SEARCH_MS
  const o = await frameOrigin(tabId, frameId, deadline, 0, seen) ?? await helloOrigin(tabId, frameId, deadline, 0, seen)
  if (!o) {
    if (!seen.unanswered) { missed.set(key, Date.now() + MISS_MS); if (missed.size > 200) missed.delete(missed.keys().next().value!) }
    return { ok: true, placed: false }
  }
  // Let go while its place was looked for: no cursor is drawn after the release took it away.
  if ((await agentTabs.get(tabId))?.grant !== held.grant) return { ok: true, placed: true }
  const kind = msg.kind === 'click' || msg.kind === 'drag' ? msg.kind : 'move'
  const r = await toPage<{ placed?: boolean }>(tabId, { type: 'agent-cursor', x: o.x + x, y: o.y + y, kind }, DRAW_MS, 0)
  return { ok: true, placed: r?.placed === true }
}
