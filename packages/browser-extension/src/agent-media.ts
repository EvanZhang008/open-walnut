/**
 * An agent's tabs stay quiet (2026-10-29: pages an agent opened played video with sound during the
 * person's meeting). Each tab an agent opens is muted before its page loads (agent-window.ts), a
 * tab its page opens is muted when it is adopted, and in every page of such a tab media that
 * starts by itself is paused: a play that comes with no click or key in the page just before
 * (the agent's own click on Play counts) is a page's autoplay. The person's own tabs, handed over
 * or taken, are left as they are: their sound is theirs.
 */
import { ext } from './ext'
import { more } from './agent-api'
import { agentTabs, personsTab } from './agent-shared'

/** How soon after a click or key a play counts as asked for. */
export const ASKED_PLAY_MS = 1500

/** Runs in the page's own frames (the isolated world: it shares the page's elements, not its script). */
export function holdAutoplay(): void {
  const w = window as unknown as { __walnutQuietMedia?: boolean }
  if (w.__walnutQuietMedia) return
  w.__walnutQuietMedia = true
  let asked = 0
  for (const t of ['pointerdown', 'mousedown', 'click', 'keydown', 'touchstart']) addEventListener(t, () => { asked = Date.now() }, true)
  const hold = (el: HTMLMediaElement) => { if (Date.now() - asked > 1500) { try { el.pause() } catch { /* gone */ } } }
  document.addEventListener('play', (e) => { if (e.target instanceof HTMLMediaElement) hold(e.target) }, true)
  const sweep = () => document.querySelectorAll('video, audio').forEach((el) => {
    const m = el as HTMLMediaElement
    m.autoplay = false
    if (!m.paused) hold(m)
  })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sweep, { once: true })
  else sweep()
}

/** The page an agent tab shows now gets the hold (each new page needs it again). */
async function quietPage(tabId: number): Promise<void> {
  const rec = await agentTabs.get(tabId)
  if (!rec || personsTab(rec) || rec.fromPerson) return
  await more.scripting?.executeScript({ target: { tabId, allFrames: true }, func: holdAutoplay, injectImmediately: true }).catch(() => undefined)
}

/** A tab an agent's page opened is the agent's: muted (its own page then gets the hold as it loads). */
export async function muteAgentTab(tabId: number): Promise<void> {
  const rec = await agentTabs.get(tabId)
  if (!rec || personsTab(rec) || rec.fromPerson) return
  await ext.tabs.update(tabId, { muted: true }).catch(() => undefined)
}

export function watchMedia(): void {
  ext.tabs.onUpdated.addListener((tabId, change: { status?: string }) => {
    // At the start of a load (as early as the browser lets a script in) and once it is done (frames added late).
    if (change.status === 'loading' || change.status === 'complete') void quietPage(tabId)
  })
}
