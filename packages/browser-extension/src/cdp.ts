/**
 * Real input through the browser's debugger (Chrome DevTools Protocol), for the one action that
 * asked for it: attach, send the commands, detach. Chrome shows its "started debugging" bar only
 * while attached. These are the command sequences alone, so a test can drive them with a fake
 * debugger (tests/core/browser-control/cdp.test.ts); agent-trusted.ts wires them in.
 */
import type { DebuggerApi } from './agent-api'

export type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export class CdpError extends Error {
  constructor(message: string, readonly code: string) { super(message) }
}

/**
 * Tabs whose debugger stays attached while an agent records there (agent-net.ts): an action that
 * needs the debugger uses that session instead of a second attach (which the browser refuses),
 * and leaves it attached.
 */
const held = new Map<number, Send>()
export function holdDebugger(tabId: number, send: Send): void { held.set(tabId, send) }
export function dropDebugger(tabId: number): void { held.delete(tabId) }
export const debuggerHeld = (tabId: number): boolean => held.has(tabId)
/** The session a tab's debugger is held with (a recording, or a dialog waiting for its answer), if any. */
export const heldSend = (tabId: number): Send | undefined => held.get(tabId)

/** Attach to the tab, do the work, always detach (or the recording's session, left attached). */
export async function withDebugger<T>(dbg: DebuggerApi, tabId: number, work: (send: Send) => Promise<T>): Promise<T> {
  const kept = held.get(tabId)
  if (kept) return work(kept)
  const target = { tabId }
  try {
    await dbg.attach(target, '1.3')
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    throw new CdpError(/already attached/i.test(m) ? 'Another debugger (DevTools?) is open on that tab: close it and try again.' : `The browser would not attach its debugger: ${m}`, 'debugger_busy')
  }
  try {
    return await work((method, params) => dbg.sendCommand(target, method, params ?? {}))
  } finally {
    await dbg.detach(target).catch(() => undefined)
  }
}

export async function cdpClick(send: Send, x: number, y: number): Promise<void> {
  const at = { x, y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0 })
}

export async function cdpHover(send: Send, x: number, y: number): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, ' ': { code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 }, Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
}
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 }

/** "Control+a" → the key and the modifier bits CDP takes. */
export function parseCombo(combo: string): { key: string; modifiers: number } {
  const parts = combo === '+' ? ['+'] : combo.split('+').filter(Boolean)
  let modifiers = 0
  for (const p of parts.slice(0, -1)) {
    const bit = MODIFIERS[p]
    if (!bit) throw new CdpError(`Unknown modifier ${p} (Alt, Control, Meta, Shift).`, 'bad_key')
    modifiers |= bit
  }
  const last = parts[parts.length - 1] ?? ''
  if (!last) throw new CdpError('Say which key.', 'no_key')
  return { key: last === 'Space' ? ' ' : last, modifiers }
}

function keyParams(key: string, modifiers: number): Record<string, unknown> {
  const known = KEYS[key]
  if (known) return { key, code: known.code, windowsVirtualKeyCode: known.keyCode, ...(known.text && !(modifiers & 7) ? { text: known.text } : {}), modifiers }
  if (key.length === 1) {
    // Shift with a letter types the capital (Shift+a is "A").
    if (modifiers & 8 && /[a-z]/.test(key)) key = key.toUpperCase()
    const up = key.toUpperCase()
    const code = /[a-z]/i.test(key) ? `Key${up}` : /\d/.test(key) ? `Digit${key}` : ''
    // A shortcut (Control+a) sends no text; a plain character types itself.
    return { key, ...(code ? { code } : {}), windowsVirtualKeyCode: up.charCodeAt(0), ...(modifiers & 7 ? {} : { text: key }), modifiers }
  }
  if (/^F\d{1,2}$/.test(key)) return { key, code: key, windowsVirtualKeyCode: 111 + Number(key.slice(1)), modifiers }
  throw new CdpError(`Unknown key ${key}.`, 'bad_key')
}

export async function cdpPress(send: Send, combo: string): Promise<void> {
  const { key, modifiers } = parseCombo(combo)
  const p = keyParams(key, modifiers)
  const { text: _t, ...up } = p
  await send('Input.dispatchKeyEvent', { type: p.text ? 'keyDown' : 'rawKeyDown', ...p })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...up })
}

/** Each character as its own key press, as a person types (pages that watch keystrokes see them); `delayMs` between keys. */
export async function cdpType(send: Send, text: string, delayMs = 0): Promise<void> {
  let first = true
  for (const ch of text) {
    if (!first && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    first = false
    if (ch === '\n') { await cdpPress(send, 'Enter'); continue }
    const p = /^[\x20-\x7e]$/.test(ch) ? keyParams(ch, 0) : { key: ch, text: ch, modifiers: 0 }
    const { text: _t, ...up } = p
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...p })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...up })
  }
}

/** The wheel at a point: what is under it scrolls (a list, a map, a box inside the page). */
export async function cdpWheel(send: Send, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
}

export interface Point { x: number; y: number }

/** The points a drag passes through: `steps` moves from one end to the other, the last on the end itself. */
export function dragPath(from: Point, to: Point, steps: number): Point[] {
  const n = Math.max(2, Math.min(50, Math.round(steps)))
  const out: Point[] = []
  for (let i = 1; i <= n; i++) out.push({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n })
  return out
}

/**
 * A drag as a person makes it: press at `from`, move in steps, release at `to`. A page that uses the
 * browser's own drag and drop (draggable elements) starts a drag the debugger intercepts
 * (Input.setInterceptDrags): its data is then dropped on `to` with drag events, as Chrome's own
 * DevTools does; a page that follows the pointer (sortable lists, sliders) sees the moves.
 * `intercepted` answers the drag data once the browser reported one (Input.dragIntercepted).
 */
export async function cdpDrag(send: Send, from: Point, to: Point, opts: { steps?: number; stepMs?: number; intercepted?: () => Record<string, unknown> | undefined } = {}): Promise<{ native: boolean }> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const intercept = !!opts.intercepted && await send('Input.setInterceptDrags', { enabled: true }).then(() => true, () => false)
  let native = false
  try {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 })
    for (const p of dragPath(from, to, opts.steps ?? 12)) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 })
      await wait(opts.stepMs ?? 16)
      const data = intercept ? opts.intercepted?.() : undefined
      if (data) {
        native = true
        for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data, modifiers: 0 })
        break
      }
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 })
  } finally {
    if (intercept) await send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
  }
  return { native }
}

/** Answer the page's alert, confirm or prompt. */
export async function cdpDialog(send: Send, accept: boolean, promptText?: string): Promise<void> {
  await send('Page.enable')
  try {
    await send('Page.handleJavaScriptDialog', { accept, ...(promptText !== undefined ? { promptText } : {}) })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    throw new CdpError(/no dialog/i.test(m) ? 'No dialog is open on that page.' : `The browser could not answer the dialog: ${m}`, 'no_dialog')
  }
}

export const EVAL_MAX = 50_000

/** The page's own JavaScript, its result as JSON (cut at EVAL_MAX characters). */
export async function cdpEvaluate(send: Send, expression: string): Promise<{ value?: unknown; json?: string; cut?: boolean; type: string }> {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 10_000 }) as {
    result?: { type?: string; value?: unknown; description?: string; unserializableValue?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  if (r.exceptionDetails) throw new CdpError(`The script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'an error'}`.slice(0, 2000), 'eval_error')
  const type = r.result?.type ?? 'undefined'
  const value = r.result?.unserializableValue ?? r.result?.value
  const json = JSON.stringify(value) ?? 'undefined'
  if (json.length > EVAL_MAX) return { json: json.slice(0, EVAL_MAX), cut: true, type }
  return { value, type }
}

/** Files on the browser's own machine into the file input the page marked. */
export async function cdpUpload(send: Send, mark: string, paths: string[]): Promise<void> {
  const doc = await send('DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } }
  const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `[data-walnut-upload="${mark}"]` }) as { nodeId: number }
  if (!q?.nodeId) throw new CdpError('The file field is gone: snapshot again.', 'stale_ref')
  await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: paths })
}
