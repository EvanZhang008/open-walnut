/**
 * The Browser replay's pictures (server: src/core/browser-control/replay-store.ts; web:
 * components/sessions/SessionBrowserReplay.tsx). 2026-11-14, the user: "can we make sure the
 * browser action screenshot or video is saved for 7 days (configurable), and can be played back".
 *
 * After an agent's acting step whose command carries `allow.record` (a one-use token: only a step
 * Walnut sent, only while the person keeps replays), this background takes one picture of the
 * step's tab in the tab's own turn, right after the step's answer went back (the agent never waits
 * for it), and posts it with the token to POST /browser/view/replay.
 *
 * The picture is taken the way the live view's frames and an agent's screenshot are, and never
 * changes anything on screen:
 *   - the tab is in front of its window: captureVisibleTab (one capture at a time, capture-gate.ts);
 *   - the window is covered, minimized, or the tab is behind another: through Chrome's debugger
 *     (agent-live.ts), in place, only for an agent's own tab in Walnut's agent window and only while
 *     live pictures may be taken (the person's switch, the permission, no Cancel on the bar);
 *   - otherwise (a tab of the person's that is not on screen, the debugger unavailable) the step is
 *     recorded with no picture. Nothing is ever switched, raised or focused for it.
 * No page script runs for it. Walnut's own pages and browser pages are never pictured.
 */
import { ext } from './ext'
import { agentTabs, agentWindowId, personsTab, walnutCheck } from './agent-shared'
import { walnutAddress } from './walnut-address'
import { WindowCovered, capture, tryCapture } from './capture-gate'
import { endShot, liveState, replayShot } from './agent-live'
import { lingersIn } from './agent-debugger'
import { endMark } from './cdp'
import { shrink } from './agent-view'

/** A replay picture at most this wide: text stays readable, a step is 50 to 200 KB. */
export const REPLAY_MAX_W = 1280
export const REPLAY_QUALITY = 0.6

/** The words of a step's answer that say what it did (page-agent.ts): names on the page, never typed text. */
const SAID_KEYS = ['clicked', 'typed', 'pressed', 'selected', 'hovered', 'scrolled', 'dragged', 'uploaded'] as const

export function saidOf(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const r = result as Record<string, unknown>
  for (const k of SAID_KEYS) if (typeof r[k] === 'string' && r[k]) return (r[k] as string).slice(0, 200)
  return undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The step's tab now: its address and title, and its picture when one can be taken; null when it is no agent's. */
export async function replayPicture(tabId: number, walnut: string[] | undefined): Promise<{ url?: string; title?: string; image?: string } | null> {
  const rec = await agentTabs.get(tabId)
  if (!rec) return null
  const tab = await ext.tabs.get(tabId).catch(() => null)
  if (!tab || tab.windowId === undefined) return null
  const url = tab.url ?? ''
  if (await walnutCheck.isWalnutPage(url) || walnutAddress(walnut, url)) return null
  const base = { url, title: tab.title }
  if (!/^https?:\/\//i.test(url) || tab.discarded === true) return base
  if (!(await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false))) return base
  const liveOk = tab.windowId === await agentWindowId() && !personsTab(rec)
  const minimized = (await ext.windows.get(tab.windowId).catch(() => null) as { state?: string } | null)?.state === 'minimized'
  let shot: string | undefined
  let covered = false
  if (tab.active && !minimized) {
    // The gate is the live view's or another tab's screenshot for a moment: one more try after it.
    for (let i = 0; i < 2 && !shot && !covered; i++) {
      try {
        shot = await tryCapture(async () => {
          const now = await ext.tabs.get(tabId).catch(() => null)
          // The page or the tab in front changed meanwhile: not this step's picture.
          if (!now?.active || (now.url ?? '') !== url) return undefined
          return capture(tab.windowId!, { format: 'jpeg', quality: 75 })
        })
      } catch (err) {
        if (!(err instanceof WindowCovered)) return base
        covered = true
      }
      if (!shot && !covered && i === 0) await sleep(600)
    }
  }
  // Covered, minimized or behind another tab: through the debugger, in place (agent-live.ts).
  if (!shot && liveOk && (covered || minimized || !tab.active) && await liveState(tabId) === 'on') {
    const mark = endMark(tabId)
    let ok = false
    try {
      shot = await replayShot(tabId, { format: 'jpeg', quality: 75 })
      ok = true
    } catch { /* no picture this step */ } finally {
      await endShot(tabId, ok ? lingersIn(tabId) : false, mark)
    }
  }
  if (!shot) return base
  return { ...base, image: await shrink(shot, REPLAY_MAX_W, REPLAY_QUALITY) }
}

type Post = (body: Record<string, unknown>) => Promise<unknown>
type InTurn = <T>(tab: number, work: () => Promise<T>) => Promise<T>

/**
 * After a step's answer went back: its picture to Walnut with the step's token. Only the picture
 * is taken in the tab's turn (`inTurn`, so it shows the step's page and no next step's); the post
 * goes after, outside it, so the agent's next command never waits for the upload. Never throws.
 */
export async function replayStep(token: string, tabId: number, answer: { ok: boolean; result?: unknown; error?: { code?: string } }, walnut: string[] | undefined, post: Post, inTurn: InTurn = (_t, w) => w()): Promise<void> {
  try {
    const pic = await inTurn(tabId, () => replayPicture(tabId, walnut))
    if (!pic) return
    await post({
      token, tab: tabId, ok: answer.ok, at: new Date().toISOString(),
      ...(answer.ok ? {} : { code: answer.error?.code }),
      ...(answer.ok && saidOf(answer.result) ? { said: saidOf(answer.result) } : {}),
      ...pic,
    })
  } catch { /* the replay misses this step: the agent's work goes on */ }
}
