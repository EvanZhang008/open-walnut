/**
 * Every close of a tab by the extension goes through here (ratchet:
 * tests/core/browser-control/extension-tab-close.test.ts). chrome.tabs.remove runs the page's
 * beforeunload first and never ends while its "Leave site?" is up (Chromium waits for the tab to
 * go), so nothing here waits on it longer than CLOSE_MS (2026-11-17: an agent's close hung 30 s,
 * and a tidy pass that waited on one would have held every later open behind it). Only an agent's
 * own leave (agent-leave.ts) waits on its tab's close, while the debugger watches for that dialog.
 *
 * `skipLeave`: the tab closes without running its beforeunload at all (Target.closeTarget through
 * the debugger, which closes it even while a dialog Walnut never saw holds the page), for a close
 * whose loss was decided: an agent's close with discard. `orForce`: the plain close first, and only
 * a tab that did not go in CLOSE_MS that way (Walnut's tidy of a tab no agent holds), so the
 * debugger's bar does not show for every tidied tab. Both need the person's real-input switch;
 * without it the close is only asked for.
 */
import { ext } from './ext'
import { more } from './agent-api'
import { run } from './agent-debugger'
import { realInputOn } from './trusted-switch'

export const CLOSE_MS = 3000

const gone = (tabId: number) => ext.tabs.get(tabId).then(() => false, () => true)

/** Resolves true once the tab is gone, false after `ms`. */
export async function whenGone(tabId: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  for (;;) {
    if (await gone(tabId)) return true
    if (Date.now() > end) return false
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** Closes the tab through the debugger with no beforeunload; false when it could not. */
async function closeTarget(tabId: number): Promise<boolean> {
  const dbg = more.debugger
  if (!dbg?.getTargets || !(await realInputOn().catch(() => false))) return false
  const target = (await dbg.getTargets().catch(() => [])).find((t) => t.tabId === tabId)
  if (!target) return false
  // The session ends with the tab ("Detached while handling command"): that is the close.
  await run(tabId, '', (send) => send('Target.closeTarget', { targetId: target.id }).catch(() => undefined), { askPage: false, taint: false }).catch(() => undefined)
  return whenGone(tabId, CLOSE_MS)
}

/** Closes the tab; true when it is gone. Never waits on a "Leave site?" longer than `ms`. */
export async function closeTab(tabId: number, o: { skipLeave?: boolean; orForce?: boolean; ms?: number } = {}): Promise<boolean> {
  if (o.skipLeave && await closeTarget(tabId)) return true
  const asked = Promise.resolve(ext.tabs.remove(tabId)).then(() => true, () => gone(tabId))
  const timer = new Promise<boolean>((r) => setTimeout(() => r(false), o.ms ?? CLOSE_MS))
  if (await Promise.race([asked, timer]) || await gone(tabId)) return true
  return o.orForce ? closeTarget(tabId) : false
}
