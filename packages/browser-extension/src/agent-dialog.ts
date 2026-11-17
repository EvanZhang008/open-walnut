/**
 * A page's alert, confirm, prompt or "Leave site?" (beforeunload), for an agent (`dialog`). Chrome
 * hands a dialog to the debugger only when the debugger's Page domain was on as the dialog opened
 * (Chromium's PageHandler keeps the dialog's answer only then; one that opened before an attach
 * cannot be read or answered from it). So every real-input step that may open one (a click, a key,
 * typing, a drag) and every leave of a page (navigate, back, close: agent-leave.ts) runs with Page
 * on, and when a dialog opens meanwhile the step answers at once with what it says, and the
 * debugger stays on the tab (at most HOLD_MS) until the agent answers it. A tab that records
 * (agent-net.ts) has Page on all along, so a page action there sees its dialogs too.
 *
 * The agent decides every dialog; nobody asks the person (2026-11-17, the user: "Only ask me for
 * payment, that is it": dialog-outward.ts). One nobody answered within the hold is answered by
 * Walnut the safe way (answerSafely): OK on an alert, Cancel on a confirm or prompt, Stay on a
 * "Leave site?", so the tab never stays stuck and nothing typed is lost.
 */
import { more } from './agent-api'
import { ext } from './ext'
import { CdpError, acquireDebugger, cdpDialog, dropDebugger, endMark, heldSend, holdDebugger, holdersOf, lingerAfter, releaseDebugger, stepHolder, type LingerIf, type Send } from './cdp'
import { AgentError, agentTabs, personsTab } from './agent-shared'
import { pageCheck } from './page-reach'

/** What a leave of the page (agent-leave.ts) a "Leave site?" holds up: answered, the leave goes on. */
export type LeaveKind = 'navigate' | 'back' | 'close'

export interface DialogInfo {
  type: string; message: string; default_prompt?: string; url?: string; at: number
  /** A "Leave site?" that a navigate, back or close of the agent's opened. */
  leaving?: LeaveKind
}

/** A dialog Walnut answered itself because nobody answered it in time (answerSafely). */
export interface WalnutAnswered extends DialogInfo { answer: 'accepted' | 'dismissed'; answered_at: number }

/** Chrome's own words on a "Leave site?" (the page's own text is never shown, and the debugger gets none). */
export const LEAVE_WORDS = 'Leave site? Changes you made may not be saved.'

/** How long a dialog keeps the debugger on its tab, waiting for the agent's answer (each look at it starts it again). */
export const HOLD_MS = 5 * 60_000
/** The longest a dialog keeps it, looks included: the person's yes for a payment may take a while (outward-asks.ts, 10 minutes). */
export const HOLD_MAX_MS = 11 * 60_000

const open = new Map<number, DialogInfo>()
/**
 * Dialogs still open whose debugger let go before anyone answered (its hold ran out, or it was
 * detached): Chrome never hands them to a debugger again, so only the person can answer them. Kept
 * until the dialog closes, the tab loads another page or closes.
 */
const orphaned = new Map<number, DialogInfo>()
const waiters = new Map<number, Set<(d: DialogInfo) => void>>()
/** The last dialog Walnut answered itself on each tab (answerSafely), told to the agent's next look. */
const walnutAnswered = new Map<number, WalnutAnswered>()
/** Tabs whose debugger is held only for a dialog's answer (not a recording): let go once it is answered. */
const forDialog = new Map<number, ReturnType<typeof setTimeout>>()
let listening = false

/** What the browser's debugger says about dialogs, in every tab it is on. */
export function foldDialogEvent(tabId: number, method: string, params: Record<string, unknown> | undefined): void {
  if (method === 'Page.javascriptDialogOpening') {
    const p = params ?? {}
    const type = typeof p.type === 'string' ? p.type : 'alert'
    const said = typeof p.message === 'string' ? p.message.slice(0, 4000) : ''
    const d: DialogInfo = {
      type, message: type === 'beforeunload' && !said ? LEAVE_WORDS : said,
      ...(typeof p.defaultPrompt === 'string' && p.type === 'prompt' ? { default_prompt: p.defaultPrompt.slice(0, 2000) } : {}),
      ...(typeof p.url === 'string' ? { url: p.url } : {}), at: Date.now(),
    }
    open.set(tabId, d)
    walnutAnswered.delete(tabId)
    for (const w of waiters.get(tabId) ?? []) w(d)
  } else if (method === 'Page.javascriptDialogClosed') {
    open.delete(tabId)
    orphaned.delete(tabId)
    // Answered some other way (the person's own click): a debugger held only for it lets go.
    if (forDialog.has(tabId)) void releaseDialogHold(tabId)
  }
}

function listen(): void {
  if (listening || !more.debugger?.onEvent) return
  listening = true
  more.debugger.onEvent.addListener((source, method, params) => {
    if (typeof source?.tabId === 'number') foldDialogEvent(source.tabId, method, params)
  })
  more.debugger.onDetach?.addListener((source) => {
    const tabId = source?.tabId
    if (typeof tabId !== 'number') return
    // The debugger let go (the person cancelled its bar, the tab closed): the dialog cannot be answered from it.
    orphan(tabId)
    if (forDialog.has(tabId)) { clearTimeout(forDialog.get(tabId)); forDialog.delete(tabId); dropDebugger(tabId) }
  })
  // A dialog ends with its page: a load or a closed tab.
  ext.tabs.onRemoved?.addListener((tabId) => { open.delete(tabId); orphaned.delete(tabId); walnutAnswered.delete(tabId) })
  ext.tabs.onUpdated?.addListener((tabId, change) => { if (change.status === 'loading') orphaned.delete(tabId) })
}

/** The dialog is still open but no debugger holds it any more: the person's to answer. */
function orphan(tabId: number): void {
  const d = open.get(tabId)
  open.delete(tabId)
  if (d) orphaned.set(tabId, d)
}

/** A dialog open on the tab that only the person can answer now (no debugger saw it to the end). */
export const orphanOf = (tabId: number): DialogInfo | undefined => orphaned.get(tabId)

export const PERSON_ONLY = 'A dialog is open on the page that Walnut can no longer answer (the browser\'s debugger let go of the tab before anyone answered it, and Chrome does not hand it over again). '
  + 'Nothing that needs the page works until it is answered: do not retry the step; close the tab (close {discard: true} leaves it even on a "Leave site?") and open the page again in a new one.'

/** The dialog Walnut answered itself on the tab because nobody answered it in time, if that is the last news of it. */
export const walnutAnsweredOf = (tabId: number): WalnutAnswered | undefined => walnutAnswered.get(tabId)

export const WALNUT_ANSWERED = 'Nobody answered it in time, so Walnut answered it the safe way (OK on an alert; Cancel on a confirm or prompt; Stay on a "Leave site?"): '
  + 'nothing on the page was lost or sent. Do the step again if you still want it, and answer the dialog it opens.'

/** The dialog open on the tab now, as the debugger saw it open, if any. */
export const dialogOf = (tabId: number): DialogInfo | undefined => open.get(tabId)

/** Resolves when a dialog opens on the tab; `cancel` stops listening. */
export function whenDialog(tabId: number): { promise: Promise<DialogInfo>; cancel: () => void } {
  let fn!: (d: DialogInfo) => void
  const promise = new Promise<DialogInfo>((resolve) => { fn = resolve })
  const set = waiters.get(tabId) ?? new Set()
  set.add(fn)
  waiters.set(tabId, set)
  return { promise, cancel: () => { set.delete(fn); if (!set.size) waiters.delete(tabId) } }
}

/**
 * The dialog was answered (or nobody answered in time): it is gone, and a debugger held only for it
 * lets go (a recording's stays).
 */
export async function releaseDialogHold(tabId: number): Promise<void> {
  open.delete(tabId)
  orphaned.delete(tabId)
  const t = forDialog.get(tabId)
  if (t === undefined) return
  clearTimeout(t)
  forDialog.delete(tabId)
  // Detached only when nobody else holds the session (live pictures, a step under way).
  await releaseDebugger(more.debugger, tabId, 'dialog')
}

/**
 * The debugger lets go of the tab before the dialog was answered because the agent's work there is
 * over (a recording stops: the tab was given back, Stop, agents switched off): a dialog still open
 * is left to whoever has the tab now.
 */
export async function leaveDialog(tabId: number): Promise<void> {
  orphan(tabId)
  const t = forDialog.get(tabId)
  if (t === undefined) return
  clearTimeout(t)
  forDialog.delete(tabId)
  // Detached only when nobody else holds the session (live pictures, a step under way).
  await releaseDebugger(more.debugger, tabId, 'dialog')
}

/**
 * Nobody answered in time: Walnut answers it itself, the way that loses and sends nothing (OK on an
 * alert, which has only OK; Cancel on everything else, "Leave site?" included: the page stays),
 * remembers it for the agent's next look, and the debugger lets go. A dialog in a tab of the
 * person's, or one that cannot be answered any more (its debugger went), is left as before (orphan).
 */
export async function answerSafely(tabId: number): Promise<void> {
  const d = open.get(tabId)
  const send = heldSend(tabId)
  // A tab of the person's (handed over, taken): its dialog stays theirs to answer, as before.
  const theirs = personsTab(await agentTabs.get(tabId).catch(() => undefined))
  if (d && send && !theirs) {
    const accept = d.type === 'alert'
    try {
      await cdpDialog(send, accept)
      open.delete(tabId)
      walnutAnswered.set(tabId, { ...d, answer: accept ? 'accepted' : 'dismissed', answered_at: Date.now() })
    } catch { /* gone meanwhile, or no longer answerable: left below */ }
  }
  if (open.has(tabId)) orphan(tabId)
  const t = forDialog.get(tabId)
  if (t === undefined) return
  clearTimeout(t)
  forDialog.delete(tabId)
  await releaseDebugger(more.debugger, tabId, 'dialog')
}

let holdMs = HOLD_MS

function armHold(tabId: number, ms = holdMs): void {
  clearTimeout(forDialog.get(tabId))
  const d = open.get(tabId)
  const left = d ? Math.min(ms, d.at + HOLD_MAX_MS - Date.now()) : ms
  forDialog.set(tabId, setTimeout(() => { void answerSafely(tabId) }, Math.max(0, left)))
}

/**
 * The agent is still on it: it read the dialog (the hold starts again), or its accept waits for the
 * person's yes (`untilMax`: held as long as the ask can stay open, the agent's calls meanwhile
 * reach only the server). Never past HOLD_MAX_MS from the dialog's opening.
 */
export function touchDialogHold(tabId: number, untilMax = false): void {
  if (forDialog.has(tabId)) armHold(tabId, untilMax ? HOLD_MAX_MS : holdMs)
}

/** Whether the tab's debugger is held only for a dialog's answer. */
export const heldForDialog = (tabId: number): boolean => forDialog.has(tabId)

/** A recording turns Page on from its start: its tab's dialogs are seen too (agent-net.ts). */
export const watchDialogs = (): void => listen()

export const DIALOG_OPEN = 'A dialog is open on the page (dialog reads it): answer it first with dialog accept or dismiss.'

export const PAGE_HELD_WORDS = 'The page does not answer: most likely a dialog Walnut never saw is open on it (a step without real input opened it), or the page hangs, and Walnut cannot read or answer that dialog. '
  + 'Do not retry steps on it. close {discard: true} closes the tab anyway (what the page holds is lost); then open the page again in a new tab.'

/** The agent's leave of the page (agent-leave.ts) is what the open "Leave site?" holds up. */
export function noteLeaving(tabId: number, kind: LeaveKind): DialogInfo | undefined {
  const d = open.get(tabId)
  // The first leave it held up is the one it goes on with once answered Leave.
  if (d && d.type === 'beforeunload' && !d.leaving) d.leaving = kind
  return d
}

/** Actions that do not reach the page's script, so a dialog that holds it does not stop them (a leave meets it in agent-leave.ts). */
const PAST_A_DIALOG = new Set(['dialog', 'close', 'navigate', 'back', 'tabs', 'take', 'downloads', 'network', 'network_body', 'network_request_body', 'console', 'resize', 'open'])

/**
 * An action that needs the page while a dialog holds it is refused at once (it would wait for the
 * page and time out). A dialog only the person can answer is looked at first: a page that answers
 * has none open any more (the person answered it).
 */
export async function refuseWhileDialog(action: string, tabId: unknown): Promise<void> {
  if (typeof tabId !== 'number' || PAST_A_DIALOG.has(action)) return
  const d = open.get(tabId)
  if (d) throw new AgentError(DIALOG_OPEN, 'dialog_open', { dialog: d })
  const o = orphaned.get(tabId)
  if (!o) return
  if (await pageCheck(tabId, 800)) { orphaned.delete(tabId); return }
  throw new AgentError(PERSON_ONLY, 'dialog_open', { dialog: o, only_person: true })
}

/** What a step a dialog cut short does with the debugger before it is left (a drag lets the mouse button go). */
export type OnInterrupt = (send: Send) => void

/**
 * Real input with Page on: the work, or the dialog it opened (whichever comes first). The debugger
 * is the tab's held one when there is one (a recording), else attached for this step and let go
 * after, unless a dialog opened: then it stays until the dialog is answered (releaseDialogHold).
 * `linger`: an agent's step, whose session stays a while after it (cdp.ts LINGER_MS).
 */
export async function runWatching<T>(tabId: number, work: (send: Send) => Promise<T>, onInterrupt?: OnInterrupt, o: { linger?: LingerIf; enableMs?: number } = {}): Promise<{ done: T } | { dialog: DialogInfo }> {
  listen()
  const dbg = more.debugger!
  // The tab's session (cdp.ts): a recording's or live pictures' when one is held, else attached
  // for this step; this step holds it until it ends.
  const by = stepHolder()
  const mark = endMark(tabId)
  const raw = await acquireDebugger(dbg, tabId, by)
  const opened = whenDialog(tabId)
  // A step a dialog cut short stops there: whatever it would send after (the next key, the rest of
  // a drag) is refused, so nothing more happens once the dialog is answered.
  let interrupted = false
  // The step went through (or a dialog cut it short): only then may its session linger after it.
  let went = false
  const guarded: Send = (method, params) => (interrupted
    ? Promise.reject(new CdpError('A dialog opened: the step stopped there.', 'dialog_interrupted'))
    : raw(method, params))
  const began = Date.now()
  try {
    // `enableMs`: Page.enable waits for the page, which waits for any dialog open on it, so a
    // dialog no debugger saw (or a hung page) answers page_held here instead of a wait for good.
    if (o.enableMs === undefined) await raw('Page.enable')
    else {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CdpError(PAGE_HELD_WORDS, 'page_held')), o.enableMs) })
      try { await Promise.race([raw('Page.enable'), late]) } finally { clearTimeout(timer) }
    }
    const step = work(guarded).then((done) => ({ done }))
    // A step a dialog interrupted ends when the dialog is answered: its result is not waited for.
    step.catch(() => undefined)
    let r: { done: T } | { dialog: DialogInfo } = await Promise.race([step, opened.promise.then((dialog) => ({ dialog }))])
    // A dialog that opened during the step but whose event came after the step's own end (a busy
    // page's "Leave site?" after its back) is still this step's.
    const late = open.get(tabId)
    if ('done' in r && late && late.at >= began) r = { dialog: late }
    went = true
    if ('dialog' in r) {
      interrupted = true
      try { onInterrupt?.(raw) } catch { /* best effort */ }
      // A recording keeps its session (and Page on) anyway; otherwise the dialog holds it until it
      // is answered, whoever else lets go meanwhile (live pictures ending, this step).
      if (!holdersOf(tabId).includes('record')) {
        holdDebugger(tabId, raw, 'dialog')
        armHold(tabId)
      }
    }
    return r
  } finally {
    opened.cancel()
    if (went) await lingerAfter(dbg, tabId, o.linger, mark)
    await releaseDebugger(dbg, tabId, by)
  }
}

/** For tests: a shorter hold (HOLD_MS otherwise). */
export function _setHoldMsForTesting(ms: number = HOLD_MS): void { holdMs = ms }

/** For tests: forget every dialog and hold. */
export function _resetDialogsForTesting(): void {
  holdMs = HOLD_MS
  open.clear()
  orphaned.clear()
  walnutAnswered.clear()
  waiters.clear()
  for (const t of forDialog.values()) clearTimeout(t)
  forDialog.clear()
}
