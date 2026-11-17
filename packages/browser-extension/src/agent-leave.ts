/**
 * An agent leaving a page (navigate, back, close), one rule for every agent and every site:
 *   1. Work the page holds that leaving would lose (page-unsaved.ts: text typed and not sent,
 *      files chosen for an upload) stops the leave first with `unsaved_work`, naming it, unless
 *      the agent says discard: true.
 *      A page whose own beforeunload would ask "Leave site?" is asked first (page-leave-ask.ts) and
 *      stops the leave the same way, so Chrome never shows that dialog: it brings the agent's
 *      window to the front over the person's work for it. discard: true leaves without the page
 *      asking at all.
 *   2. The leave runs with the debugger watching (agent-dialog.ts runWatching), so a "Leave site?"
 *      the first ask missed (a page that asks only on a real event) comes back to the agent at
 *      once while the page stays as it is: dialog accept leaves, dialog dismiss stays; the agent's
 *      window goes back to the Dock when it was there.
 * Before 2026-11-17 a close waited on chrome.tabs.remove, which never ends while that dialog is up,
 * and the server gave up after 30 s with a 504 that said nothing about a dialog (an agent posting
 * on a forum, its video still uploading); its holding was already gone, so the tab read as the
 * person's. Walnut never answers Leave by itself and never asks the person: the agent decides
 * (2026-11-17, the user: "Only ask me for payment, that is it").
 */
import { ext } from './ext'
import { AgentError, agentTabs, agentWindowId, checkPage, frameOp, loaded, mark, ownTab, personsTab, sleep, where, type AgentTab, type WireCommand } from './agent-shared'
import { DIALOG_OPEN, LEAVE_WORDS, PAGE_HELD_WORDS, dialogOf, noteLeaving, orphanOf, releaseDialogHold, type DialogInfo, type LeaveKind } from './agent-dialog'
import { run, watched } from './agent-debugger'
import type { Unsaved } from './page-unsaved'
import { afterLeave, whenStarted } from './leave-end'
import { stopRecording } from './agent-net'
import { REAL_INPUT_SWITCH, trustedReady } from './agent-trusted'
import { barCancelled, cdpDialog } from './cdp'
import { closeTab } from './tab-close'
import { ungroupBeforeClose, type GroupApi } from './agent-groups'
import { forgetAgentMade } from './agent-tidy'
import { personTabsIn, type OwnApi } from './agent-window-own'
import { leaveAsks, quietLeave } from './page-leave-ask'

/** What the agent reads with a "Leave site?" its leave opened. */
export const LEAVE_NOTE = 'The page asks "Leave site?": it says it holds changes that are not saved (a draft, an upload still going). The page stays as it is until you answer: '
  + 'dialog dismiss stays on the page (then finish, save or send what is there, or wait for an upload to end, and leave again); dialog accept leaves and loses those changes.'

const unsavedLine = (u: Unsaved) => (u.kind === 'file' ? `${u.what} (files chosen: ${(u.files ?? []).join(', ')})` : `${u.what} (${u.chars ?? 0} characters typed)`)

/**
 * Work the page would lose: refused with what it is, unless the agent said discard. Both what
 * Walnut saw typed or chosen and the page's own word (its "Leave site?", asked of it without Chrome
 * showing the dialog). A page that does not answer is not asked.
 */
export async function checkUnsaved(c: WireCommand, tabId: number): Promise<void> {
  if (c.args.discard === true) return
  const [r, ask] = await Promise.all([
    frameOp(tabId, 0, 'unsaved', {}, c.allow, 2000).catch(() => null) as Promise<{ unsaved?: Unsaved[]; count?: number } | null>,
    leaveAsks(tabId),
  ])
  const list = r?.count && r.unsaved?.length ? r.unsaved : []
  if (!list.length && !ask) return
  const parts = list.map(unsavedLine)
  if (ask) parts.push('the page itself asks "Leave site?" (it says changes are not saved: a draft, an upload still going)')
  throw new AgentError(`The page holds work that is not sent or saved yet: ${parts.join('; ')}. ${c.action} would lose it; Walnut stayed on the page and showed no dialog. `
    + `Send or save it first (or wait for an upload to finish); to leave anyway (or when it is already sent or saved), call ${c.action} again with discard: true.`, 'unsaved_work',
  { unsaved: list, ...(ask ? { dialog: { type: 'beforeunload', message: LEAVE_WORDS, url: ask.frame ?? '', shown: false } } : {}) })
}

/** The agent's window, when it is in the Dock: a "Leave site?" Chrome shows brings it out, and it goes back. */
async function dockedWindow(tabId: number): Promise<number | undefined> {
  const t = await ext.tabs.get(tabId).catch(() => null)
  if (t?.windowId === undefined || t.windowId !== await agentWindowId()) return undefined
  const w = await ext.windows.get(t.windowId).catch(() => null) as { state?: string } | null
  return w?.state === 'minimized' ? t.windowId : undefined
}

/** Answers the dialog open on the tab (accept: Leave on a "Leave site?"), and the debugger held for it lets go. */
async function answer(tabId: number, rec: AgentTab, accept: boolean): Promise<void> {
  await run(tabId, rec.owner, (send) => cdpDialog(send, accept), { askPage: false, taint: false })
  await releaseDialogHold(tabId)
}

export type LeaveResult = { left: true; answered?: DialogInfo } | { dialog: DialogInfo }


const NOT_WATCHED = 'The page did not let go in 10 s: it is most likely asking "Leave site?" (it holds changes not saved), and Walnut sees that dialog only with real input on. '
  + `${REAL_INPUT_SWITCH} Meanwhile close {discard: true} cannot close it either.`

/** How long a watched leave waits for the debugger's Page domain (it waits on a dialog no debugger saw) before taking the page as held. */
const ENABLE_MS = 3000
/** How long a leave without the debugger's watch waits for the page to let go. */
const UNWATCHED_MS = 10_000

/**
 * The leave `go` (it ends when the leave is under way or done), by the rule above. `watch`: the
 * debugger may watch (real input on); without it the leave runs as before and a "Leave site?" is
 * not seen.
 */
export async function leave(c: WireCommand, tabId: number, rec: AgentTab, kind: LeaveKind, go: () => Promise<unknown>, watch: boolean): Promise<LeaveResult> {
  const discard = c.args.discard === true
  const closeNow = async () => kind === 'close' && discard && await closeTab(tabId, { skipLeave: true })
  const open = dialogOf(tabId)
  if (open) {
    if (!discard) {
      // An earlier leave's "Leave site?" is still up: this leave waits on the same answer.
      if (open.type === 'beforeunload') return { dialog: noteLeaving(tabId, kind) ?? open }
      throw new AgentError(DIALOG_OPEN, 'dialog_open', { dialog: open })
    }
    // discard: Leave on a "Leave site?", Cancel on anything else, then the leave asked now.
    try {
      await answer(tabId, rec, open.type === 'beforeunload')
    } catch (err) {
      if (await closeNow()) return { left: true, answered: open }
      throw err
    }
    if (open.type === 'beforeunload' && open.leaving === 'close') {
      const out = await afterLeave(tabId, 'close')
      if (out.closed === true) return { left: true, answered: open }
    }
  } else if (orphanOf(tabId)) {
    // A dialog Walnut can no longer answer holds the page: only a close without its beforeunload gets past it.
    if (await closeNow()) return { left: true }
    throw new AgentError(PAGE_HELD_WORDS, 'page_held', { dialog: orphanOf(tabId) })
  }
  // A close the agent chose to lose the page's work for: gone without its "Leave site?" at all.
  if (watch && await closeNow()) return { left: true }
  await checkUnsaved(c, tabId)
  // The agent chose to lose what the page holds: it leaves without the page asking.
  if (discard) await quietLeave(tabId)
  const unwatched = async (): Promise<LeaveResult> => {
    const done = await Promise.race([go().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), UNWATCHED_MS))])
    if (!done) throw new AgentError(NOT_WATCHED, 'leave_not_seen')
    return { left: true }
  }
  if (!watch) return unwatched()
  let d: DialogInfo | undefined
  const docked = await dockedWindow(tabId)
  try {
    d = await watched(tabId, rec.owner, go, undefined, { taint: false, enableMs: ENABLE_MS })
  } catch (err) {
    // The debugger would not attach (DevTools holds the tab): the leave goes on unwatched.
    if (err instanceof AgentError && err.code === 'debugger_busy') return unwatched()
    // A dialog no debugger saw holds the page (Page.enable waits on it), or it hangs.
    if (err instanceof AgentError && err.code === 'page_held' && await closeNow()) return { left: true }
    throw err
  }
  if (!d) return { left: true }
  if (docked !== undefined) await ext.windows.update?.(docked, { state: 'minimized' }).catch(() => undefined)
  if (d.type === 'beforeunload' && discard) {
    await answer(tabId, rec, true)
    // The leave goes on: done once the tab is gone or the next page loaded.
    await afterLeave(tabId, kind)
    return { left: true, answered: d }
  }
  return { dialog: noteLeaving(tabId, kind) ?? d }
}

/**
 * Whether a leave of this tab runs with the debugger watching: as the default real input decides
 * (agent-trusted.ts trustedByDefault), never in a tab of the person's or while the person's Cancel
 * on Chrome's debugging bar is fresh.
 */
async function watchable(rec: AgentTab): Promise<boolean> {
  return !personsTab(rec) && !barCancelled() && await trustedReady()
}

/** A leave a "Leave site?" holds up answers with it: the tab stays the agent's and as it was. */
const held = (r: { dialog: DialogInfo }, tabId: number, extra: Record<string, unknown> = {}) => ({ tab: tabId, ...extra, dialog: r.dialog, note: LEAVE_NOTE })

/** `navigate {tab, url, discard?}`. */
export async function navigateAct(c: WireCommand): Promise<Record<string, unknown>> {
  const { tabId, tab, rec } = await ownTab(c.args)
  const url = String(c.args.url ?? '')
  await checkPage(c.allow, url)
  await checkPage(c.allow, tab.url ?? '')
  const r = await leave(c, tabId, rec, 'navigate', async () => {
    const started = whenStarted(tabId)
    await ext.tabs.update(tabId, { url })
    // A "Leave site?" opens before the load starts: the step ends with it (runWatching), never before it.
    await started
    await loaded(tabId)
  }, await watchable(rec))
  if ('dialog' in r) return { ...held(r, tabId), ...(await where(tabId)) }
  await sleep(100)
  await loaded(tabId)
  return { ...(await where(tabId)), ...(r.answered ? { left_anyway: r.answered } : {}) }
}

/** `back {tab, discard?}`. */
export async function backAct(c: WireCommand): Promise<Record<string, unknown>> {
  const { tabId, tab, rec } = await ownTab(c.args)
  const r = await leave(c, tabId, rec, 'back', async () => {
    const started = whenStarted(tabId)
    // goBack answers at once; the step ends only once the load started (or the page's "Leave site?" opened).
    const went = await ext.tabs.goBack(tabId).then(() => true, () => false)
    if (went) await started
    else {
      // Chrome skips, on Back, a page that moved on without a person's gesture (an agent's
      // click is not one): go to the address before this one in the tab's own list.
      const list = (await agentTabs.get(tabId))?.history ?? []
      const i = list.lastIndexOf(tab.url ?? '')
      const prev = i > 0 ? list[i - 1] : undefined
      if (!prev) throw new AgentError('There is no page to go back to.', 'no_history')
      await checkPage(c.allow, prev)
      await agentTabs.update(tabId, (x) => ({ ...x, history: list.slice(0, i) }))
      const again = whenStarted(tabId)
      await ext.tabs.update(tabId, { url: prev })
      await again
    }
    await loaded(tabId)
  }, await watchable(rec))
  if ('dialog' in r) return { ...held(r, tabId), ...(await where(tabId)) }
  await sleep(100)
  await loaded(tabId)
  return { ...(await where(tabId)), ...(r.answered ? { left_anyway: r.answered } : {}) }
}

/** Ends the agent's holding of a tab it lets go without closing it. */
async function release(tabId: number): Promise<void> {
  await agentTabs.delete(tabId)
  await stopRecording(tabId)
  await mark(tabId, false)
  await forgetAgentMade(tabId)
}

/** `close {tab, discard?}` (Walnut's tidy-up of a finished task sends `tidy` and its `owner`). */
export async function closeAct(c: WireCommand): Promise<Record<string, unknown>> {
  const a = c.args
  const { tabId, tab, rec } = await ownTab(a)
  if (a.tidy === true) {
    // Walnut's tidy-up of a finished task (browser-tab-tidy.ts): only that task's holding, and
    // never under the person's eyes or in their own window (there it is only let go).
    if (typeof a.owner === 'string' && rec.owner !== a.owner) throw new AgentError('That tab is another task\'s now.', 'not_your_tab')
    const w = await ext.windows.get(tab.windowId!).catch(() => null) as { focused?: boolean } | null
    if (tab.active && w?.focused) return { tab: tabId, closed: false, kept: 'person_looking' }
    if (tab.windowId !== await agentWindowId() && !personsTab(rec)) { await release(tabId); return { tab: tabId, closed: false, released: true } }
  }
  // An agent's tab left in front of a window of the person's (agent-window-own.ts gave that
  // window up with it there): closing it would change what their window shows, so it is only let go.
  // A window with no tab of theirs (a popup the agent's page opened) is the agent's: it closes.
  if (tab.active && !personsTab(rec) && tab.windowId !== undefined && tab.windowId !== await agentWindowId()
    && (await personTabsIn(ext as unknown as OwnApi, tab.windowId)).length > 0) {
    await release(tabId)
    return { tab: tabId, closed: false, released: true, kept: 'person_window_front' }
  }
  // The person's own tab is given back, never closed.
  if (personsTab(rec)) { await agentTabs.delete(tabId); await stopRecording(tabId); await mark(tabId, false); return { tab: tabId, closed: false, released: true } }
  let r: LeaveResult
  try {
    r = await leave(c, tabId, rec, 'close', async () => {
      await ungroupBeforeClose(ext as unknown as GroupApi, tabId)
      // Ends only once the tab is gone: a "Leave site?" holds it, and the watch answers with that.
      await ext.tabs.remove(tabId)
    }, await watchable(rec))
  } catch (err) {
    // Walnut's tidy-up never loses work and never leaves a tab stuck: the tab is only let go (it stays open).
    if (a.tidy === true && err instanceof AgentError && ['unsaved_work', 'dialog_open', 'page_held', 'leave_not_seen'].includes(err.code)) { await release(tabId); return { tab: tabId, closed: false, released: true, kept: 'unsaved_work' } }
    throw err
  }
  if ('dialog' in r) {
    if (a.tidy === true) {
      // The tidy-up stays on the page (Cancel) and lets the tab go: nothing typed is lost.
      await answerAndRelease(tabId, rec)
      return { tab: tabId, closed: false, released: true, kept: 'unsaved_work' }
    }
    // Still the agent's, back in its task's group (it left the group to close).
    await mark(tabId, true, rec.who)
    return held(r, tabId, { closed: false })
  }
  await agentTabs.delete(tabId)
  await stopRecording(tabId)
  return { tab: tabId, closed: true, ...(r.answered ? { left_anyway: r.answered } : {}) }
}

async function answerAndRelease(tabId: number, rec: AgentTab): Promise<void> {
  await answer(tabId, rec, false).catch(() => undefined)
  await release(tabId)
}
