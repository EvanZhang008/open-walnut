/**
 * A page's alert, confirm or prompt, for an agent (`dialog`). Chrome hands a dialog to the
 * debugger only when the debugger's Page domain was on as the dialog opened (Chromium's
 * PageHandler keeps the dialog's answer only then; one that opened before an attach cannot be
 * read or answered from it). So every real-input step that may open one (a click, a key, typing, a
 * drag) runs with Page on, and when a dialog opens meanwhile the step answers at once with what it
 * says, and the debugger stays on the tab (at most HOLD_MS) until the agent answers it. A tab that
 * records (agent-net.ts) has Page on all along, so a page action there sees its dialogs too.
 */
import { more } from './agent-api'
import { ext } from './ext'
import { CdpError, dropDebugger, heldSend, holdDebugger, type Send } from './cdp'
import { AgentError } from './agent-shared'
import { pageCheck } from './page-reach'

export interface DialogInfo { type: string; message: string; default_prompt?: string; url?: string; at: number }

/** How long a dialog keeps the debugger on its tab, waiting for the agent's answer (each look at it starts it again). */
export const HOLD_MS = 120_000
/** The longest a dialog keeps it, looks included: the person's yes for an accept may take a while (outward-asks.ts, 10 minutes). */
export const HOLD_MAX_MS = 11 * 60_000

const open = new Map<number, DialogInfo>()
/**
 * Dialogs still open whose debugger let go before anyone answered (its hold ran out, or it was
 * detached): Chrome never hands them to a debugger again, so only the person can answer them. Kept
 * until the dialog closes, the tab loads another page or closes.
 */
const orphaned = new Map<number, DialogInfo>()
const waiters = new Map<number, Set<(d: DialogInfo) => void>>()
/** Tabs whose debugger is held only for a dialog's answer (not a recording): let go once it is answered. */
const forDialog = new Map<number, ReturnType<typeof setTimeout>>()
let listening = false

/** What the browser's debugger says about dialogs, in every tab it is on. */
export function foldDialogEvent(tabId: number, method: string, params: Record<string, unknown> | undefined): void {
  if (method === 'Page.javascriptDialogOpening') {
    const p = params ?? {}
    const d: DialogInfo = {
      type: typeof p.type === 'string' ? p.type : 'alert', message: typeof p.message === 'string' ? p.message.slice(0, 4000) : '',
      ...(typeof p.defaultPrompt === 'string' && p.type === 'prompt' ? { default_prompt: p.defaultPrompt.slice(0, 2000) } : {}),
      ...(typeof p.url === 'string' ? { url: p.url } : {}), at: Date.now(),
    }
    open.set(tabId, d)
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
  ext.tabs.onRemoved?.addListener((tabId) => { open.delete(tabId); orphaned.delete(tabId) })
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

export const PERSON_ONLY = 'A dialog is open on the page that only the person can answer now (Walnut\'s hold on it ran out, and Chrome does not hand it over again): '
  + 'ask them in your chat to answer it in that tab (say what it asks), then go on. Nothing that needs the page works until then.'

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
  dropDebugger(tabId)
  await more.debugger?.detach({ tabId }).catch(() => undefined)
}

/**
 * Nobody answered in time, or the debugger lets go of the tab for another reason (a recording
 * stops): a dialog still open is left to the person.
 */
export async function leaveDialog(tabId: number): Promise<void> {
  orphan(tabId)
  const t = forDialog.get(tabId)
  if (t === undefined) return
  clearTimeout(t)
  forDialog.delete(tabId)
  dropDebugger(tabId)
  await more.debugger?.detach({ tabId }).catch(() => undefined)
}

let holdMs = HOLD_MS

function armHold(tabId: number, ms = holdMs): void {
  clearTimeout(forDialog.get(tabId))
  const d = open.get(tabId)
  const left = d ? Math.min(ms, d.at + HOLD_MAX_MS - Date.now()) : ms
  forDialog.set(tabId, setTimeout(() => { void leaveDialog(tabId) }, Math.max(0, left)))
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

/** Actions that do not reach the page's script, so a dialog that holds it does not stop them. */
const PAST_A_DIALOG = new Set(['dialog', 'close', 'tabs', 'take', 'downloads', 'network', 'network_body', 'network_request_body', 'console', 'resize', 'open'])

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
 */
export async function runWatching<T>(tabId: number, work: (send: Send) => Promise<T>, onInterrupt?: OnInterrupt): Promise<{ done: T } | { dialog: DialogInfo }> {
  listen()
  const dbg = more.debugger!
  const target = { tabId }
  let send = heldSend(tabId)
  let mine = false
  if (!send) {
    try {
      await dbg.attach(target, '1.3')
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      throw new CdpError(/already attached/i.test(m) ? 'Another debugger (DevTools?) is open on that tab: close it and try again.' : `The browser would not attach its debugger: ${m}`, 'debugger_busy')
    }
    send = (method, params) => dbg.sendCommand(target, method, params ?? {})
    mine = true
  }
  const opened = whenDialog(tabId)
  const raw = send
  // A step a dialog cut short stops there: whatever it would send after (the next key, the rest of
  // a drag) is refused, so nothing more happens once the dialog is answered.
  let interrupted = false
  const guarded: Send = (method, params) => (interrupted
    ? Promise.reject(new CdpError('A dialog opened: the step stopped there.', 'dialog_interrupted'))
    : raw(method, params))
  try {
    await raw('Page.enable')
    const step = work(guarded).then((done) => ({ done }))
    // A step a dialog interrupted ends when the dialog is answered: its result is not waited for.
    step.catch(() => undefined)
    const r = await Promise.race([step, opened.promise.then((dialog) => ({ dialog }))])
    if ('dialog' in r) {
      interrupted = true
      try { onInterrupt?.(raw) } catch { /* best effort */ }
      if (mine) {
        holdDebugger(tabId, raw)
        armHold(tabId)
        mine = false
      }
    }
    return r
  } finally {
    opened.cancel()
    if (mine) await dbg.detach(target).catch(() => undefined)
  }
}

/** For tests: a shorter hold (HOLD_MS otherwise). */
export function _setHoldMsForTesting(ms: number = HOLD_MS): void { holdMs = ms }

/** For tests: forget every dialog and hold. */
export function _resetDialogsForTesting(): void {
  holdMs = HOLD_MS
  open.clear()
  orphaned.clear()
  waiters.clear()
  for (const t of forDialog.values()) clearTimeout(t)
  forDialog.clear()
}
