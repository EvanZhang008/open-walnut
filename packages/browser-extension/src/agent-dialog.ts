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
import { CdpError, dropDebugger, heldSend, holdDebugger, type Send } from './cdp'
import { AgentError } from './agent-shared'

export interface DialogInfo { type: string; message: string; default_prompt?: string; url?: string; at: number }

/** How long a dialog keeps the debugger on its tab, waiting for the agent's answer. */
export const HOLD_MS = 120_000

const open = new Map<number, DialogInfo>()
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
    open.delete(tabId)
    if (forDialog.has(tabId)) { clearTimeout(forDialog.get(tabId)); forDialog.delete(tabId); dropDebugger(tabId) }
  })
}

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
  const t = forDialog.get(tabId)
  if (t === undefined) return
  clearTimeout(t)
  forDialog.delete(tabId)
  dropDebugger(tabId)
  await more.debugger?.detach({ tabId }).catch(() => undefined)
}

/** Whether the tab's debugger is held only for a dialog's answer. */
export const heldForDialog = (tabId: number): boolean => forDialog.has(tabId)

/** A recording turns Page on from its start: its tab's dialogs are seen too (agent-net.ts). */
export const watchDialogs = (): void => listen()

export const DIALOG_OPEN = 'A dialog is open on the page (dialog reads it): answer it first with dialog accept or dismiss.'

/** Actions that do not reach the page's script, so a dialog that holds it does not stop them. */
const PAST_A_DIALOG = new Set(['dialog', 'close', 'tabs', 'take', 'downloads', 'network', 'network_body', 'network_request_body', 'console', 'resize', 'open'])

/** An action that needs the page while a dialog holds it is refused at once (it would wait for the page and time out). */
export function refuseWhileDialog(action: string, tabId: unknown): void {
  if (typeof tabId !== 'number' || PAST_A_DIALOG.has(action)) return
  const d = open.get(tabId)
  if (d) throw new AgentError(DIALOG_OPEN, 'dialog_open', { dialog: d })
}

/**
 * Real input with Page on: the work, or the dialog it opened (whichever comes first). The debugger
 * is the tab's held one when there is one (a recording), else attached for this step and let go
 * after, unless a dialog opened: then it stays until the dialog is answered (releaseDialogHold).
 */
export async function runWatching<T>(tabId: number, work: (send: Send) => Promise<T>): Promise<{ done: T } | { dialog: DialogInfo }> {
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
  try {
    await send('Page.enable')
    const step = work(send).then((done) => ({ done }))
    // A step a dialog interrupted ends when the dialog is answered: its result is not waited for.
    step.catch(() => undefined)
    const r = await Promise.race([step, opened.promise.then((dialog) => ({ dialog }))])
    if ('dialog' in r && mine) {
      holdDebugger(tabId, send)
      forDialog.set(tabId, setTimeout(() => { void releaseDialogHold(tabId) }, HOLD_MS))
      mine = false
    }
    return r
  } finally {
    opened.cancel()
    if (mine) await dbg.detach(target).catch(() => undefined)
  }
}

/** For tests: forget every dialog and hold. */
export function _resetDialogsForTesting(): void {
  open.clear()
  waiters.clear()
  for (const t of forDialog.values()) clearTimeout(t)
  forDialog.clear()
}
