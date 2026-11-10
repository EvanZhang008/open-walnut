/**
 * Whether the debugger's real input reached the page (agent-trusted.ts, agent-drag.ts).
 *
 * 2026-11-10, in the person's own Chrome: with Walnut's agent window covered by their other
 * windows (the usual case), the page is not drawn (`document.visibilityState` is hidden) and
 * Chrome drops input sent through the debugger while answering it "ok". A default click on a link
 * said `trusted: true` and the page received no pointer, mouse or click event. So every step that
 * sends real input is checked: a hidden page goes to the page's events before the debugger is
 * used (or, asked for real input by name, is refused with how to fix it), and after the debugger
 * acted, a page that armed the delivery probe (page-probe.ts) and saw none of the step's events
 * means the input was dropped. Nothing here ever shows, raises or focuses a window.
 */
import { frameOp, sleep, type WireCommand } from './agent-shared'

/** Why a default step took the page's events (the answer's `why`). */
export const HIDDEN_WHY = 'the agent window is covered; Chrome drops real input there, so page events were used'
export const DROPPED_WHY = 'the page did not receive the real input (Chrome drops it while the agent window is covered or minimized), so page events were used'

/** The refusal of a step that asked for real input by name on a page Chrome does not draw. */
export function hiddenWords(action: string): string {
  if (action === 'drag') return 'Chrome drops real input while Walnut\'s agent window is covered or minimized, and a drag needs real input: have the person show the window (uncover it), then drag again.'
  return 'Chrome drops real input while Walnut\'s agent window is covered or minimized. Drop --trusted (trusted: false) to use page events, or have the person show the window.'
}

/** The refusal of a step whose real input the page never received. */
export function droppedWords(action: string): string {
  const fix = action === 'drag' ? 'have the person show the window (uncover it), then drag again' : 'call it again without --trusted (page events), or have the person show the window'
  return `The page did not receive the real input (Chrome drops it while Walnut's agent window is covered or minimized), so the ${action} did nothing: ${fix}.`
}

/** A one-time id for one step's probe. */
export const probeId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 24)

/** The page's events come in order with its answer; this is only slack for one more look. */
const GRACE_MS = 250

/**
 * False only when the page armed the probe and saw none of the step's events. No answer, or
 * another document (the step loaded a page, which only input does), proves nothing was dropped.
 */
export async function delivered(tabId: number, probe: string, allow: WireCommand['allow']): Promise<boolean> {
  const read = (done: boolean) => frameOp(tabId, 0, 'probe_read', { probe, ...(done ? { done: true } : {}) }, allow, 2000).catch(() => null)
  let r = await read(false)
  if (r && r.armed === true && r.seen === 0) {
    await sleep(GRACE_MS)
    r = await read(true)
  } else void read(true)
  return !(r && r.armed === true && r.seen === 0)
}
