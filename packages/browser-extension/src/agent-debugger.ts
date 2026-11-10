/**
 * The debugger acting in an agent's tab for one step (agent-trusted.ts, agent-drag.ts,
 * agent-dialog-act.ts): `run` for a step that opens no dialog, `watched` for one that may
 * (a click, a key, typing, a drag: agent-dialog.ts). The session stays attached a while after each
 * step (cdp.ts linger), so Chrome's debugging bar does not flash on every step of an agent's work.
 */
import { more } from './agent-api'
import { CdpError, withDebugger, type Send } from './cdp'
import { AgentError, agentTabs, noteTampered, personsTab } from './agent-shared'
import { runWatching, type DialogInfo, type OnInterrupt } from './agent-dialog'
import { drivingSince } from './agent-takeover'
import { cancelKnown } from './agent-live'

/**
 * Whether the session may linger after a step in this tab: only an agent's own tab, never one of
 * the person's (handed over or taken), and not while the person drives it. Read once the step went
 * through, so a Stop or a take-over during the step leaves nothing attached (cdp.ts lingerAfter).
 */
export const lingersIn = (tabId: number) => async (): Promise<boolean> => {
  const rec = await agentTabs.get(tabId)
  return !!rec && !personsTab(rec) && drivingSince(rec) === undefined
}

/**
 * The debugger acts in the tab. Marked first (agent-shared.ts noteTampered): whatever it does to
 * this document, fill_login stays off it until it loads again. A dialog holds the page's script,
 * so the page is not asked which document it is then. `taint: false`: a step real input took by
 * default (agent-trusted.ts trustedByDefault), which sends only mouse and key events, as the
 * page's own events do (those never mark the page), so fill_login still works after a click.
 */
export async function run<T>(tabId: number, owner: string, work: (send: Send) => Promise<T>, opts: { askPage?: boolean; taint?: boolean } = {}): Promise<T> {
  if (opts.taint !== false) await noteTampered(tabId, owner, opts.askPage !== false)
  // The person's Cancel on the bar and the switches' listener, read back after a restart (agent-live.ts).
  await cancelKnown()
  try {
    return await withDebugger(more.debugger!, tabId, work, { linger: lingersIn(tabId) })
  } catch (err) {
    if (err instanceof CdpError) throw new AgentError(err.message, err.code)
    throw err
  }
}

/**
 * A step that may open a dialog (agent-dialog.ts): its dialog, if one opened, else nothing. A
 * dialog stops the step where it is; `onInterrupt` puts right what it left half done.
 */
export async function watched(tabId: number, owner: string, work: (send: Send) => Promise<unknown>, onInterrupt?: OnInterrupt, opts: { taint?: boolean } = {}): Promise<DialogInfo | undefined> {
  if (opts.taint !== false) await noteTampered(tabId, owner)
  await cancelKnown()
  try {
    const r = await runWatching(tabId, work, onInterrupt, { linger: lingersIn(tabId) })
    return 'dialog' in r ? r.dialog : undefined
  } catch (err) {
    if (err instanceof CdpError) throw new AgentError(err.message, err.code)
    throw err
  }
}

