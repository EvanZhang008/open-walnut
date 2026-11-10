/**
 * Real input through the browser's debugger (Chrome DevTools Protocol): attach, send the commands,
 * let go. Chrome shows its "started debugging" bar only while attached. These are the command
 * sequences alone, so a test can drive them with a fake debugger
 * (tests/core/browser-control/cdp.test.ts); agent-trusted.ts wires them in.
 */
import type { DebuggerApi } from './agent-api'

export type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export class CdpError extends Error {
  constructor(message: string, readonly code: string) { super(message) }
}

/**
 * One debugger session per tab, shared by everything that needs it (the browser refuses a second
 * attach): a recording (agent-net.ts, `record`), a dialog waiting for its answer (agent-dialog.ts,
 * `dialog`), the live pictures of a watched tab (agent-live.ts, `picture` and `shot`), each
 * real-input step while it runs (`step:<n>`), and the short hold an agent's steps leave behind
 * (`linger`, below). Each holder names itself; the session is detached only when the last one lets
 * go, so a picture never cuts a click short and a click never ends a recording.
 */
const held = new Map<number, { send: Send; by: Set<string> }>()
/** Attaches under way: a second user waits for it instead of attaching again. */
const attaching = new Map<number, Promise<void>>()
const watchedApis = new WeakSet<object>()
/** The timer of each tab's lingering hold (LINGER_MS). */
const lingering = new Map<number, ReturnType<typeof setTimeout>>()

/**
 * After the person cancelled Chrome's debugging bar (it is browser-wide: one Cancel detaches every
 * tab), nothing Walnut does by itself attaches the debugger for this long, on any tab (live
 * pictures, an agent's screenshot through it, real input an agent did not ask for by name): the
 * bar would come straight back. agent-live.ts keeps it in storage.session, so a restart of the
 * background keeps it too.
 */
export const CANCEL_COOL_MS = 10 * 60_000
let cancelledAt = 0
let onCancel: ((at: number) => void) | undefined

/** The person cancelled the debugging bar within CANCEL_COOL_MS. (`tabId`: kept for the callers' words.) */
export const barCancelled = (_tabId?: number, now = Date.now()): boolean => now - cancelledAt < CANCEL_COOL_MS
/** The browser let go of a tab's session: the person's Cancel on the bar is remembered. */
export function noteDetached(tabId: number, reason?: string): void {
  dropDebugger(tabId)
  if (reason === 'canceled_by_user') { cancelledAt = Date.now(); onCancel?.(cancelledAt) }
}
/** Who keeps the Cancel across a restart (agent-live.ts), and the time it kept. */
export function keepCancel(save: (at: number) => void, at?: unknown): void {
  onCancel = save
  const stored = typeof at === 'number' && Number.isFinite(at) && at <= Date.now() ? at : 0
  if (stored > cancelledAt) cancelledAt = stored
  // A Cancel that came before the stored one was read: kept now.
  else if (cancelledAt > stored) save(cancelledAt)
}

/** `by` holds the tab's session `send` (joined when one is held already). */
export function holdDebugger(tabId: number, send: Send, by = 'record'): void {
  const e = held.get(tabId)
  if (e) e.by.add(by)
  else held.set(tabId, { send, by: new Set([by]) })
}
/**
 * `by` lets go; with no `by`, the session is gone for everyone (the browser detached it, the tab
 * closed). True when nobody holds it now (the caller then detaches).
 */
export function dropDebugger(tabId: number, by?: string): boolean {
  const e = held.get(tabId)
  if (!e) return false
  if (by !== undefined) e.by.delete(by)
  if (by !== undefined && e.by.size) return false
  held.delete(tabId)
  clearTimeout(lingering.get(tabId))
  lingering.delete(tabId)
  return true
}
export const debuggerHeld = (tabId: number): boolean => held.has(tabId)
/** The session a tab's debugger is held with (a recording, a dialog, live pictures), if any. */
export const heldSend = (tabId: number): Send | undefined => held.get(tabId)?.send
/** Who holds the tab's session now (tests, and whether a recording holds it). */
export const holdersOf = (tabId: number): string[] => [...(held.get(tabId)?.by ?? [])]

/**
 * How long a tab's session stays attached after an agent's last step there (a click, a key, a
 * screenshot through the debugger), so Chrome's "started debugging" bar does not come and go on
 * every step while the agent works (2026-11-09, the user: the bar flashed on each click). Each new
 * step starts it again; the agent letting the tab go, the person taking it over, or their Cancel on
 * the bar ends it at once.
 */
export const LINGER_MS = 30_000
let lingerMs = LINGER_MS

/** The session stays a while after this step (joined as `linger`), unless the person cancelled the bar. */
export function linger(dbg: DebuggerApi | undefined, tabId: number): void {
  const e = held.get(tabId)
  if (!e || !dbg || lingerMs <= 0 || barCancelled(tabId)) return
  e.by.add('linger')
  clearTimeout(lingering.get(tabId))
  lingering.set(tabId, setTimeout(() => { lingering.delete(tabId); void releaseDebugger(dbg, tabId, 'linger') }, lingerMs))
}

/**
 * Whether a step's session lingers: `true`, or a check run once the step went through (the agent
 * code's: the tab is still an agent's own, not the person's, not taken over; agent-debugger.ts).
 */
export type LingerIf = boolean | (() => Promise<boolean>)
/** How many times each tab's lingering was ended, and every tab's at once: a step that began before an end never lingers after it. */
const endsOf = new Map<number, number>()
let allEnds = 0
export const endMark = (tabId: number) => `${allEnds}:${endsOf.get(tabId) ?? 0}`

/**
 * After a step that went through, while its own hold is still on: the session lingers when `when`
 * says so and nobody ended the tab's lingering since the step began (`mark`, from endMark). So a
 * Stop, a let-go or a take-over that comes while the step runs, or while its check is on its way,
 * leaves nothing attached behind it (review 2026-11-09).
 */
export async function lingerAfter(dbg: DebuggerApi, tabId: number, when: LingerIf | undefined, mark: string): Promise<void> {
  if (!when) return
  if (when !== true && !(await when().catch(() => false))) return
  if (endMark(tabId) !== mark) return
  linger(dbg, tabId)
}

/** Every lingering hold goes now, and no step running lingers after it (the person turned real input off). */
export async function endAllLingers(dbg: DebuggerApi | undefined): Promise<void> {
  allEnds++
  for (const tabId of [...lingering.keys()]) await endLinger(dbg, tabId)
}

/** The agent's work in the tab is over (let go, taken over): the lingering hold goes now, and a step still running keeps none. */
export async function endLinger(dbg: DebuggerApi | undefined, tabId: number): Promise<void> {
  endsOf.set(tabId, (endsOf.get(tabId) ?? 0) + 1)
  if (!lingering.has(tabId)) return
  clearTimeout(lingering.get(tabId))
  lingering.delete(tabId)
  await releaseDebugger(dbg, tabId, 'linger')
}

/** For tests: how long a session lingers after a step (0: detached at once, as before). */
export function _setLingerMsForTesting(ms: number = LINGER_MS): void { lingerMs = ms }

let steps = 0
/** A holder name for one step (each real-input step its own). */
export const stepHolder = (): string => `step:${++steps}`

const busyError = (err: unknown) => {
  const m = err instanceof Error ? err.message : String(err)
  return new CdpError(/already attached/i.test(m) ? 'Another debugger (DevTools?) is open on that tab: close it and try again.' : `The browser would not attach its debugger: ${m}`, 'debugger_busy')
}

/** `by` holds the tab's session: the one held already, else a new attach. */
export async function acquireDebugger(dbg: DebuggerApi, tabId: number, by: string): Promise<Send> {
  // The browser let go by itself (the tab closed, the person cancelled its bar): nobody holds it.
  if (!watchedApis.has(dbg) && dbg.onDetach) {
    watchedApis.add(dbg)
    dbg.onDetach.addListener((source, reason) => { if (typeof source?.tabId === 'number') noteDetached(source.tabId, reason) })
  }
  for (let p = attaching.get(tabId); p; p = attaching.get(tabId)) await p
  const e = held.get(tabId)
  if (e) { e.by.add(by); return e.send }
  const target = { tabId }
  // Set before anything is awaited: a second user arriving now waits for this attach.
  const attach = dbg.attach(target, '1.3')
  attaching.set(tabId, attach.then(() => undefined, () => undefined))
  try {
    await attach
  } catch (err) {
    throw busyError(err)
  } finally {
    attaching.delete(tabId)
  }
  const send: Send = (method, params) => dbg.sendCommand(target, method, params ?? {})
  held.set(tabId, { send, by: new Set([by]) })
  return send
}

/** `by` lets go of the tab's session; the last holder detaches it. */
export async function releaseDebugger(dbg: DebuggerApi | undefined, tabId: number, by: string): Promise<void> {
  if (dropDebugger(tabId, by)) await dbg?.detach({ tabId }).catch(() => undefined)
}

/** For tests: no session held, none attaching, no Cancel remembered. */
export function _resetDebuggerForTesting(): void {
  held.clear()
  attaching.clear()
  for (const t of lingering.values()) clearTimeout(t)
  lingering.clear()
  endsOf.clear()
  cancelledAt = 0
}

/**
 * Attach to the tab (or join the session held), do the work, let go (detached unless another
 * holder needs it). `linger`: an agent's step, whose session stays a while after (LINGER_MS) when
 * it went through (a step that failed or fell back keeps nothing attached for itself).
 */
export async function withDebugger<T>(dbg: DebuggerApi, tabId: number, work: (send: Send) => Promise<T>, o: { linger?: LingerIf } = {}): Promise<T> {
  const by = stepHolder()
  const mark = endMark(tabId)
  const send = await acquireDebugger(dbg, tabId, by)
  let done = false
  try {
    const r = await work(send)
    done = true
    return r
  } finally {
    if (done) await lingerAfter(dbg, tabId, o.linger, mark)
    await releaseDebugger(dbg, tabId, by)
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

/** The combo's modifiers when the debugger can press it (a key it knows), else null. */
export function comboModifiers(combo: string): number | null {
  try {
    const { key, modifiers } = parseCombo(combo)
    keyParams(key, modifiers)
    return modifiers
  } catch {
    return null
  }
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
export interface DragState { pressed: boolean; at: Point; intercepting: boolean }

export async function cdpDrag(send: Send, from: Point, to: Point, opts: { steps?: number; stepMs?: number; intercepted?: () => Record<string, unknown> | undefined; state?: DragState } = {}): Promise<{ native: boolean }> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // Where the drag is, for a step a dialog cuts short (agent-drag.ts lets the button go there).
  const st = opts.state ?? { pressed: false, at: from, intercepting: false }
  const intercept = !!opts.intercepted && await send('Input.setInterceptDrags', { enabled: true }).then(() => true, () => false)
  st.intercepting = intercept
  let native = false
  try {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
    st.pressed = true
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 })
    for (const p of dragPath(from, to, opts.steps ?? 12)) {
      st.at = p
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
    st.pressed = false
  } finally {
    if (intercept) await send('Input.setInterceptDrags', { enabled: false }).then(() => { st.intercepting = false }, () => undefined)
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
