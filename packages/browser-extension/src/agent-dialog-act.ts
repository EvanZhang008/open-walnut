/**
 * `dialog`: read the alert, confirm or prompt open on an agent's tab (`read`), or answer it
 * (`accept`, with `text` for a prompt; `accept: false` is Cancel). Only a dialog the debugger saw
 * open can be answered (agent-dialog.ts says why); the answer names the dialog it answered.
 */
import { cdpDialog } from './cdp'
import { AgentError, settled, where, type AgentTab, type WireCommand } from './agent-shared'
import { dialogOf, releaseDialogHold } from './agent-dialog'
import { run } from './agent-debugger'

export const NOT_SEEN = 'Chrome hands a dialog to Walnut only when its debugger was on the tab as the dialog opened: do the step that opens it with trusted '
  + '(click, press or type: the answer then says the dialog opened, and it waits for you), or record the tab first (network), then answer it here.'

export async function dialogAct(c: WireCommand, tabId: number, rec: AgentTab): Promise<Record<string, unknown>> {
  const a = c.args
  const seen = dialogOf(tabId)
  if (a.read === true) {
    return seen
      ? { open: true, dialog: seen, ...(await where(tabId)) }
      : { open: false, note: `No dialog Walnut saw open on this tab. ${NOT_SEEN}`, ...(await where(tabId)) }
  }
  const accept = a.accept !== false
  const text = typeof a.text === 'string' ? a.text : undefined
  if (text !== undefined && seen && seen.type !== 'prompt') throw new AgentError(`The open dialog is ${seen.type === 'alert' ? 'an alert' : `a ${seen.type}`}, which takes no text: answer it without text.`, 'bad_request', { dialog: seen })
  try {
    // A dialog holds the page's script, so the page is not asked first.
    await run(tabId, rec.owner, (send) => cdpDialog(send, accept, text), { askPage: false })
  } catch (err) {
    if (err instanceof AgentError && err.code === 'no_dialog' && !seen) throw new AgentError(`No dialog Walnut can answer is open on that page. ${NOT_SEEN}`, 'no_dialog')
    throw err
  }
  await releaseDialogHold(tabId)
  await settled(tabId)
  return { dialog: accept ? 'accepted' : 'dismissed', ...(seen ? { answered: { ...seen, ...(text !== undefined ? { with: text } : {}) } } : {}), ...(await where(tabId)) }
}
