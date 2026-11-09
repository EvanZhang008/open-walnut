/**
 * `drag`: from an element (ref) or a point (x, y) to another element (to_ref) or point (to_x,
 * to_y), with the browser's own mouse (real input: the person's switch, top frame only). The page
 * finds both ends with both on screen (page-input.ts dragPoints); the debugger presses, moves in
 * steps and releases (cdp.ts cdpDrag), dropping the browser's own drag data when the page uses
 * native drag and drop. A drag is a press and a release, so the page judges it as the click it may
 * be (the control it starts or ends on, and the one the release would click): a step that buys,
 * sends or deletes waits for the person's yes, as a click does (page-ops.ts).
 */
import { more } from './agent-api'
import { cdpDrag, type DragState } from './cdp'
import { AgentError, frameOp, settled, where, type AgentTab, type WireCommand } from './agent-shared'
import { watched } from './agent-debugger'
import { outwardHeld } from './agent-page'

/** The drag data the browser reported per tab while a drag runs (Input.dragIntercepted). */
const intercepted = new Map<number, Record<string, unknown>>()
let listening = false

function listen(): void {
  if (listening || !more.debugger?.onEvent) return
  listening = true
  more.debugger.onEvent.addListener((source, method, params) => {
    if (method === 'Input.dragIntercepted' && typeof source?.tabId === 'number' && params?.data && typeof params.data === 'object') {
      intercepted.set(source.tabId, params.data as Record<string, unknown>)
    }
  })
}

type End = { x: number; y: number; what: string }

export async function dragAct(c: WireCommand, tabId: number, rec: AgentTab): Promise<Record<string, unknown>> {
  const a = c.args
  const hasFrom = typeof a.ref === 'string' || (typeof a.x === 'number' && typeof a.y === 'number')
  const hasTo = typeof a.to_ref === 'string' || (typeof a.to_x === 'number' && typeof a.to_y === 'number')
  if (!hasFrom || !hasTo) throw new AgentError('drag takes where it starts (ref, or x and y) and where it ends (to_ref, or to_x and to_y).', 'bad_request')
  const found = await frameOp(tabId, 0, 'drag_points', {
    ...(typeof a.ref === 'string' ? { ref: a.ref } : { x: a.x, y: a.y }),
    ...(typeof a.to_ref === 'string' ? { to_ref: a.to_ref } : { to_x: a.to_x, to_y: a.to_y }),
    ...(typeof a.outward_ok === 'string' ? { outward_ok: a.outward_ok } : {}),
  }, c.allow)
  // A drag that would buy, send or delete: nothing was pressed, the person is asked.
  if (found.hold) throw outwardHeld(found.hold)
  const r = found as { from: End; to: End }
  listen()
  intercepted.delete(tabId)
  const steps = typeof a.steps === 'number' && a.steps > 0 ? a.steps : undefined
  let native = false
  const state: DragState = { pressed: false, at: r.from, intercepting: false }
  const dialog = await watched(tabId, rec.owner, async (send) => {
    native = (await cdpDrag(send, r.from, r.to, { ...(steps ? { steps } : {}), intercepted: () => intercepted.get(tabId), state })).native
  }, (send) => {
    // A dialog stopped the drag half way: the button goes up where the pointer is (so the page
    // never keeps a pressed mouse), and the browser's drags are its own again. Not waited for:
    // the page answers input only once the dialog is answered.
    if (state.pressed) void send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: state.at.x, y: state.at.y, button: 'left', clickCount: 1, buttons: 0 }).catch(() => undefined)
    if (state.intercepting) void send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
  })
  intercepted.delete(tabId)
  const out = { dragged: `${r.from.what} to ${r.to.what}`, from: { x: r.from.x, y: r.from.y }, to: { x: r.to.x, y: r.to.y }, ...(native ? { native: true } : {}), trusted: true }
  if (dialog) return { ...out, dialog, note: 'The drag opened a dialog: dialog accept or dismiss answers it.', ...(await where(tabId)) }
  await settled(tabId)
  return { ...out, ...(await where(tabId)) }
}
