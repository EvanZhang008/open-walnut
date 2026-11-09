/**
 * Real input for an agent (`trusted: true`, and `dialog`, `evaluate`, `drag`): the browser's own
 * mouse, wheel and keys through its debugger (cdp.ts), for pages that ignore the page events agents
 * send otherwise. A step that may open a page dialog runs with the debugger watching for one
 * (agent-dialog.ts), and answers with it. Off until the person turns it on (trusted-switch.ts, an optional permission); the
 * debugger is attached for that one action and detached right after. Only in the top frame.
 * `evaluate` runs the page's own JavaScript, so only in a tab an agent opened, never the person's
 * (nor one their tab opened), and never on a site where fill_login put a password in. A trusted
 * upload sends only files this task's own downloads wrote.
 */
import { more } from './agent-api'
import { realInputOn } from './trusted-switch'
import { isFirefox, type Tab } from './ext'
import { cdpClick, cdpEvaluate, cdpHover, cdpPress, cdpType, cdpUpload, cdpWheel } from './cdp'
import { run, watched } from './agent-debugger'
import { AgentError, checkPage, filledHere, frameOp, nearPerson, reached, settled, where, WALNUT_PAGE, type AgentTab, type WireCommand } from './agent-shared'
import { downloadedFiles } from './agent-downloads'
import { outwardHeld, refByText } from './agent-page'
import { trustedOutward } from './page-agent-outward'
import type { DialogInfo } from './agent-dialog'
import { dialogAct } from './agent-dialog-act'
import { dragAct } from './agent-drag'
import { SLOW_KEY_MS, SLOW_MAX, wheelDelta } from './input-math'

export const TRUSTED_OPS = new Set(['click', 'type', 'press', 'hover', 'upload', 'scroll'])
/** A click by its words: the search may take this much of the command's time, the click the rest. */
const SEARCH_MS = 8000
/** These use the debugger whatever the command says. */
export const DEBUGGER_OPS = new Set(['dialog', 'evaluate', 'drag'])

/**
 * Where the person turns real input on, step by step (an agent passes it on as it is). Real input,
 * evaluate, dialog and recording a tab (agent-net.ts) all wait for this one switch.
 */
export const REAL_INPUT_SWITCH = 'Only the person can turn it on: in Chrome, click the Walnut extension\'s icon in the toolbar (in the puzzle-piece Extensions menu when it is not pinned), '
  + 'click the gear (Settings) at the top of the popup, and turn on "Let agents use real mouse and keys"; Chrome then asks to allow the debugger: Allow. '
  + 'While an agent uses it, Chrome shows its "started debugging" bar at the top of every tab.'
const OFF = `Real input is off in this browser. ${REAL_INPUT_SWITCH} Without it, use the action without trusted.`

/** The debugger permission and the person's real-input switch (trusted-switch.ts: the permission alone may be held for live pictures only). */
export async function trustedReady(): Promise<boolean> {
  return !isFirefox && !!more.debugger && await realInputOn()
}

export async function trustedAct(c: WireCommand, tabId: number, tab: Tab, rec: AgentTab): Promise<Record<string, unknown>> {
  if (!(await trustedReady())) throw new AgentError(isFirefox ? 'Real input needs Chrome: Firefox does not let extensions use its debugger.' : OFF, 'trusted_off')
  let a = c.args
  const inFrame = (r: unknown) => typeof r === 'string' && /^f\d+:/.test(r)
  if (inFrame(a.ref) || inFrame(a.to_ref)) throw new AgentError('Real input works in the top frame of the page only: use the action without trusted in a frame.', 'trusted_frame')
  await checkPage(c.allow, tab.url ?? '')
  // A dialog blocks the page's script, so the page is not asked first.
  if (c.action === 'dialog') return dialogAct(c, tabId, rec)
  const page = await reached(tabId)
  if (page.walnut) throw new AgentError(WALNUT_PAGE, 'walnut_page')
  await checkPage(c.allow, page.href)
  const locate = async (extra: Record<string, unknown> = {}) => {
    const r = await frameOp(tabId, 0, 'locate', { ref: a.ref, x: a.x, y: a.y, ...(typeof a.label === 'number' ? { label: a.label } : {}), ...(a.outward_ok ? { outward_ok: a.outward_ok } : {}), ...extra }, c.allow)
    // A step that buys, sends or deletes waits for the person (page-ops.ts held).
    if (r.hold) throw outwardHeld(r.hold)
    return r as { x: number; y: number; what: string }
  }
  // A click by its words: the match, top frame only (real input).
  let matched: Record<string, unknown> | undefined
  if ((c.action === 'click' || c.action === 'hover') && typeof a.text === 'string' && a.text && a.ref === undefined && typeof a.x !== 'number' && typeof a.label !== 'number') {
    const m = await refByText(c, tabId, Date.now() + SEARCH_MS)
    if (inFrame(m.ref)) throw new AgentError(`"${String(a.text).slice(0, 60)}" is inside a frame (${m.ref}): real input works in the top frame only, so click it without trusted.`, 'trusted_frame')
    a = { ...a, ref: m.ref, text: undefined }
    matched = m
  }
  if (c.action === 'drag') return dragAct({ ...c, args: a }, tabId, rec)
  let out: Record<string, unknown>
  let dialog: DialogInfo | undefined
  switch (c.action) {
    case 'evaluate': {
      if (nearPerson(rec)) throw new AgentError('evaluate runs only in a tab an agent opened, never in the person\'s own tab or one it opened: open the page in a tab of your own (open {url}), which has their sign-ins too.', 'not_agent_opened')
      if (await filledHere(rec.owner, page.href)) throw new AgentError('evaluate does not run on a site where Walnut filled a login for you: it could read the password. Read the page with snapshot, text or find, or record its requests (network).', 'filled_here')
      const expression = typeof a.expression === 'string' ? a.expression : ''
      if (!expression) throw new AgentError('Give the expression to run.', 'bad_request')
      out = { ...(await run(tabId, rec.owner, (send) => cdpEvaluate(send, expression))) }
      break
    }
    case 'click': { const l = await locate(trustedOutward('click', a)); dialog = await watched(tabId, rec.owner, (send) => cdpClick(send, l.x, l.y)); out = { clicked: l.what, trusted: true }; break }
    case 'hover': { const l = await locate(); await run(tabId, rec.owner, (send) => cdpHover(send, l.x, l.y)); out = { hovered: l.what, trusted: true }; break }
    case 'press': {
      const k = String(a.key ?? '')
      // Every combo that ends in Enter, and Space or Enter on a focused button or link, is judged.
      await locate({ active: true, ...trustedOutward('press', a) })
      dialog = await watched(tabId, rec.owner, (send) => cdpPress(send, k))
      out = { pressed: k, trusted: true }
      break
    }
    case 'type': {
      const text = String(a.text ?? '')
      const slowly = a.slowly === true
      if (slowly && [...text].length > SLOW_MAX) throw new AgentError(`slowly types at most ${SLOW_MAX} characters (a key every ${SLOW_KEY_MS} ms); type the rest without it.`, 'too_long')
      // Real typing presses Enter for each newline: a newline counts as submit.
      const enter = trustedOutward('type', a)
      // At a point: a click there first, as a person puts the caret in a field.
      const at = a.ref === undefined && typeof a.x === 'number' && typeof a.y === 'number'
      // The click at the point is judged as any click is (a Pay button there waits for the person),
      // and with the Enter the text presses, as one step: one ask, one yes for both.
      const l = at ? await locate({ focus: true, clear: a.clear === true, outward: 'click', ...(enter.outward ? { then_enter: true, typing: enter.typing } : {}) })
        : a.ref !== undefined ? await locate({ focus: true, clear: a.clear === true, ...enter }) : (await locate({ active: true, ...enter }), undefined)
      dialog = await watched(tabId, rec.owner, async (send) => {
        if (at && l) await cdpClick(send, l.x, l.y)
        await cdpType(send, text, slowly ? SLOW_KEY_MS : 0)
        if (a.submit === true) await cdpPress(send, 'Enter')
      })
      out = { typed: `${text.length} characters${l ? ` into ${l.what}` : ''}${slowly ? ', one key at a time' : ''}`, trusted: true }
      break
    }
    case 'scroll': {
      // The wheel over the element (or point, or the middle of the page): what is under it scrolls.
      const l = await locate(a.ref === undefined && typeof a.x !== 'number' ? { middle: true } : {})
      const d = wheelDelta(a)
      await run(tabId, rec.owner, (send) => cdpWheel(send, l.x, l.y, d.x, d.y))
      out = { scrolled: `${d.said} over ${l.what}`, trusted: true }
      break
    }
    case 'upload': {
      const paths = Array.isArray(a.paths) ? (a.paths as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0) : []
      if (!paths.length) throw new AgentError('A trusted upload takes paths of files on the browser\'s own machine (paths); to send the bytes, upload without trusted.', 'bad_request')
      // Only what this task downloaded: any other file on the person's machine is theirs.
      const mine = await downloadedFiles(rec.owner)
      const other = paths.filter((p) => !mine.includes(p))
      if (other.length) throw new AgentError(`A trusted upload sends only files this task downloaded (downloads lists them); not ${other.slice(0, 3).join(', ')}. Send other files as bytes, without trusted.`, 'path_not_allowed')
      const markId = crypto.randomUUID().replace(/-/g, '')
      const l = await locate({ mark: markId, ...(typeof a.selector === 'string' && a.ref === undefined ? { selector: a.selector } : {}) })
      await run(tabId, rec.owner, (send) => cdpUpload(send, markId, paths))
      out = { uploaded: paths, into: l.what, trusted: true }
      break
    }
    default: throw new AgentError(`${c.action} has no real-input form.`, 'bad_action')
  }
  // A dialog the step opened holds the page: nothing loads until it is answered.
  if (dialog) return { ...out, ...(matched ? { matched } : {}), dialog, note: 'The step opened a dialog: dialog accept (with text for a prompt) or dialog dismiss answers it.', ...(await where(tabId)) }
  if (c.action !== 'hover' && c.action !== 'evaluate') await settled(tabId)
  return { ...out, ...(matched ? { matched } : {}), ...(await where(tabId)) }
}
