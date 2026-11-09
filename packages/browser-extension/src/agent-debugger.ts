/**
 * The debugger acting in an agent's tab for one step (agent-trusted.ts, agent-drag.ts,
 * agent-dialog-act.ts): `run` for a step that opens no dialog, `watched` for one that may
 * (a click, a key, typing, a drag: agent-dialog.ts).
 */
import { more } from './agent-api'
import { CdpError, withDebugger, type Send } from './cdp'
import { AgentError, noteTampered } from './agent-shared'
import { runWatching, type DialogInfo } from './agent-dialog'

/**
 * The debugger acts in the tab. Marked first (agent-shared.ts noteTampered): whatever it does to
 * this document, fill_login stays off it until it loads again. A dialog holds the page's script,
 * so the page is not asked which document it is then.
 */
export async function run<T>(tabId: number, owner: string, work: (send: Send) => Promise<T>, opts: { askPage?: boolean } = {}): Promise<T> {
  await noteTampered(tabId, owner, opts.askPage !== false)
  try {
    return await withDebugger(more.debugger!, tabId, work)
  } catch (err) {
    if (err instanceof CdpError) throw new AgentError(err.message, err.code)
    throw err
  }
}

/** A step that may open a dialog (agent-dialog.ts): its dialog, if one opened, else nothing. */
export async function watched(tabId: number, owner: string, work: (send: Send) => Promise<unknown>): Promise<DialogInfo | undefined> {
  await noteTampered(tabId, owner)
  try {
    const r = await runWatching(tabId, work)
    return 'dialog' in r ? r.dialog : undefined
  } catch (err) {
    if (err instanceof CdpError) throw new AgentError(err.message, err.code)
    throw err
  }
}

