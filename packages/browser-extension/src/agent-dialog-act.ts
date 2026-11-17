/**
 * `dialog`: read the alert, confirm, prompt or "Leave site?" open on an agent's tab (`read`), or
 * answer it (`accept`, with `text` for a prompt; `accept: false` is Cancel, or Stay on the page).
 * Only a dialog the debugger saw open can be answered (agent-dialog.ts says why); the answer names
 * the dialog it answered, and a "Leave site?" a leave opened ends that leave (agent-leave.ts). Only
 * an accept that pays waits for the person's yes (dialog-outward.ts); one nobody answered in time
 * Walnut answered the safe way, and a look says so.
 */
import { ext } from './ext'
import { cdpDialog } from './cdp'
import { AgentError, settled, where, type AgentTab, type WireCommand } from './agent-shared'
import { dialogOf, orphanOf, PERSON_ONLY, releaseDialogHold, touchDialogHold, walnutAnsweredOf, WALNUT_ANSWERED } from './agent-dialog'
import { afterLeave } from './leave-end'
import { run } from './agent-debugger'
import { outwardHeld } from './agent-page'
import { dialogOutward } from './dialog-outward'

export const NOT_SEEN = 'Chrome hands a dialog to Walnut only when its debugger was on the tab as the dialog opened. '
  + 'If one is open now (a step right before timed out with page_not_ready), Walnut cannot answer it: do not retry the step (every step waits for the page); '
  + 'close the tab (close {discard: true}) and open the page again. Next time do a step that may open one with trusted '
  + '(click, press or type: the answer then says the dialog opened, and it waits for you), or record the tab first (network).'

export async function dialogAct(c: WireCommand, tabId: number, rec: AgentTab): Promise<Record<string, unknown>> {
  const a = c.args
  const seen = dialogOf(tabId)
  const theirs = seen ? undefined : orphanOf(tabId)
  // Looking at it is still working on it: the hold starts again.
  if (seen) touchDialogHold(tabId)
  if (a.read === true) {
    if (theirs) return { open: true, dialog: theirs, only_person: true, note: PERSON_ONLY, ...(await where(tabId)) }
    if (seen) return { open: true, dialog: seen, ...(await where(tabId)) }
    const auto = walnutAnsweredOf(tabId)
    if (auto) return { open: false, walnut_answered: auto, note: WALNUT_ANSWERED, ...(await where(tabId)) }
    return { open: false, note: `No dialog Walnut saw open on this tab. ${NOT_SEEN}`, ...(await where(tabId)) }
  }
  if (theirs) throw new AgentError(PERSON_ONLY, 'dialog_person', { dialog: theirs })
  if (!seen && walnutAnsweredOf(tabId)) throw new AgentError(`No dialog is open now. ${WALNUT_ANSWERED}`, 'no_dialog', { walnut_answered: walnutAnsweredOf(tabId) })
  const accept = a.accept !== false
  const text = typeof a.text === 'string' ? a.text : undefined
  if (text !== undefined && seen && seen.type !== 'prompt') throw new AgentError(`The open dialog is ${seen.type === 'alert' ? 'an alert' : `a ${seen.type}`}, which takes no text: answer it without text.`, 'bad_request', { dialog: seen })
  // OK on a confirm that pays is that step: it waits for the person's yes.
  if (seen) {
    const url = seen.url ?? (await ext.tabs.get(tabId).catch(() => undefined))?.url ?? ''
    const hold = dialogOutward(seen, accept, text, url)
    if (hold && a.outward_ok !== hold.sig) {
      // The person's yes may take minutes: the dialog stays answerable meanwhile.
      touchDialogHold(tabId, true)
      throw outwardHeld(hold)
    }
  }
  try {
    // A dialog holds the page's script, so the page is not asked first.
    await run(tabId, rec.owner, (send) => cdpDialog(send, accept, text), { askPage: false })
  } catch (err) {
    if (err instanceof AgentError && err.code === 'no_dialog' && !seen) throw new AgentError(`No dialog Walnut can answer is open on that page. ${NOT_SEEN}`, 'no_dialog')
    throw err
  }
  await releaseDialogHold(tabId)
  const answered = { dialog: accept ? 'accepted' : 'dismissed', ...(seen ? { answered: { ...seen, ...(text !== undefined ? { with: text } : {}) } } : {}) }
  // A "Leave site?" answered Leave: the leave it held up goes on (the tab closes, the next page loads).
  if (accept && seen?.type === 'beforeunload' && seen.leaving) return { ...answered, ...(await afterLeave(tabId, seen.leaving)) }
  if (!accept && seen?.type === 'beforeunload') return { ...answered, stayed: true, ...(await where(tabId)) }
  await settled(tabId)
  return { ...answered, ...(await where(tabId)) }
}
