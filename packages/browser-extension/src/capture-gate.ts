/**
 * One capture of a window at a time, for the agent's screenshots (agent-shot.ts) and the live
 * Browser view's frames (agent-view.ts). The browser takes at most two captureVisibleTab calls a
 * second for the whole extension, and a capture shows whichever tab is on screen in the window:
 * a frame taken while an agent's screenshot brings its own tab up would show the wrong tab, or
 * use up the screenshot's quota. So a screenshot holds the gate for its whole take, and a frame
 * only takes it when it is free (a frame skipped is the next one's, a second later).
 */
import { ext } from './ext'
import { AgentError } from './agent-shared'

/**
 * Chrome stops drawing a window that other windows cover entirely (macOS occlusion), and
 * captureVisibleTab only copies what was drawn: it then fails with "image readback failed"
 * (Chromium's WebContentsCaptureClient, an empty surface). The live view and screenshots say so
 * instead of "try again", since no retry helps until part of the window is on screen.
 */
export const COVERED = "Chrome draws nothing in Walnut's agent window while other windows cover all of it, so no picture can be taken now. It comes as soon as any part of that window is on screen; snapshot and text still read the page."

/** A capture failure because the window draws nothing (covered, or never drawn yet). */
export class WindowCovered extends AgentError {
  constructor() { super(COVERED, 'window_covered') }
}

/** The browser's own limit, two captures a second, with a margin. */
export const CAPTURE_GAP_MS = 550

let held: Promise<unknown> | null = null
let last = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One capture of the window, counted against the gap. */
export async function capture(windowId: number, o: { format: 'jpeg' | 'png'; quality?: number }): Promise<string> {
  const wait = last + CAPTURE_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  last = Date.now()
  try {
    return await ext.tabs.captureVisibleTab(windowId, o)
  } catch (err) {
    if (/readback failed/i.test(String((err as Error)?.message ?? err))) throw new WindowCovered()
    throw err
  } finally {
    last = Date.now()
  }
}

/** An agent's screenshot: waits for the gate (a frame holds it a moment at most), then holds it for `work`. */
export async function withCapture<T>(work: () => Promise<T>): Promise<T> {
  while (held) await held.catch(() => undefined)
  const mine = work()
  held = mine
  try { return await mine } finally { if (held === mine) held = null }
}

/** A frame of the live view: only when no capture is under way, else nothing (`undefined`). */
export async function tryCapture<T>(work: () => Promise<T>): Promise<T | undefined> {
  if (held) return undefined
  const mine = work()
  held = mine
  try { return await mine } finally { if (held === mine) held = null }
}

/** Whether a capture holds the gate now. */
export const captureBusy = (): boolean => held !== null
