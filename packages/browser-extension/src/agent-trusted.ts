/**
 * Real input for an agent (`trusted: true`, and `dialog`, `evaluate`): the browser's own mouse
 * and keys through its debugger (cdp.ts), for pages that ignore the page events agents send
 * otherwise. Off until the person turns it on (trusted-switch.ts, an optional permission); the
 * debugger is attached for that one action and detached right after. Only in the top frame.
 * `evaluate` runs the page's own JavaScript, so only in a tab an agent opened, never the person's
 * (nor one their tab opened), and never on a site where fill_login put a password in. A trusted
 * upload sends only files this task's own downloads wrote.
 */
import { more } from './agent-api'
import { isFirefox, type Tab } from './ext'
import { CdpError, cdpClick, cdpDialog, cdpEvaluate, cdpHover, cdpPress, cdpType, cdpUpload, withDebugger, type Send } from './cdp'
import { AgentError, checkPage, filledHere, frameOp, nearPerson, noteTampered, reached, settled, where, WALNUT_PAGE, type AgentTab, type WireCommand } from './agent-shared'
import { downloadedFiles } from './agent-downloads'
import { outwardHeld } from './agent-page'
import { trustedOutward } from './page-agent-outward'

export const TRUSTED_OPS = new Set(['click', 'type', 'press', 'hover', 'upload'])
/** These use the debugger whatever the command says. */
export const DEBUGGER_OPS = new Set(['dialog', 'evaluate'])

/**
 * Where the person turns real input on, step by step (an agent passes it on as it is). Real input,
 * evaluate, dialog and recording a tab (agent-net.ts) all wait for this one switch.
 */
export const REAL_INPUT_SWITCH = 'Only the person can turn it on: in Chrome, click the Walnut extension\'s icon in the toolbar (in the puzzle-piece Extensions menu when it is not pinned), '
  + 'click the gear (Settings) at the top of the popup, and turn on "Let agents use real mouse and keys"; Chrome then asks to allow the debugger: Allow. '
  + 'While an agent uses it, Chrome shows its "started debugging" bar on that tab.'
const OFF = `Real input is off in this browser. ${REAL_INPUT_SWITCH} Without it, use the action without trusted.`

export async function trustedReady(): Promise<boolean> {
  return !isFirefox && !!more.debugger && await more.permissions.contains({ permissions: ['debugger'] }).catch(() => false)
}

/**
 * The debugger acts in the tab. Marked first (agent-shared.ts noteTampered): whatever it does to
 * this document, fill_login stays off it until it loads again. A dialog holds the page's script,
 * so the page is not asked which document it is then.
 */
async function run<T>(tabId: number, owner: string, work: (send: Send) => Promise<T>, opts: { askPage?: boolean } = {}): Promise<T> {
  await noteTampered(tabId, owner, opts.askPage !== false)
  try {
    return await withDebugger(more.debugger!, tabId, work)
  } catch (err) {
    if (err instanceof CdpError) throw new AgentError(err.message, err.code)
    throw err
  }
}

export async function trustedAct(c: WireCommand, tabId: number, tab: Tab, rec: AgentTab): Promise<Record<string, unknown>> {
  if (!(await trustedReady())) throw new AgentError(isFirefox ? 'Real input needs Chrome: Firefox does not let extensions use its debugger.' : OFF, 'trusted_off')
  const a = c.args
  if (typeof a.ref === 'string' && /^f\d+:/.test(a.ref)) throw new AgentError('Real input works in the top frame of the page only: use the action without trusted in a frame.', 'trusted_frame')
  await checkPage(c.allow, tab.url ?? '')
  if (c.action === 'dialog') {
    // A dialog blocks the page's script, so the page is not asked first.
    await run(tabId, rec.owner, (send) => cdpDialog(send, a.accept !== false, typeof a.text === 'string' ? a.text : undefined), { askPage: false })
    await settled(tabId)
    return { dialog: a.accept !== false ? 'accepted' : 'dismissed', ...(await where(tabId)) }
  }
  const page = await reached(tabId)
  if (page.walnut) throw new AgentError(WALNUT_PAGE, 'walnut_page')
  await checkPage(c.allow, page.href)
  const locate = async (extra: Record<string, unknown> = {}) => {
    const r = await frameOp(tabId, 0, 'locate', { ref: a.ref, x: a.x, y: a.y, ...(a.outward_ok ? { outward_ok: a.outward_ok } : {}), ...extra }, c.allow)
    // A step that buys, sends or deletes waits for the person (page-ops.ts held).
    if (r.hold) throw outwardHeld(r.hold)
    return r as { x: number; y: number; what: string }
  }
  let out: Record<string, unknown>
  switch (c.action) {
    case 'evaluate': {
      if (nearPerson(rec)) throw new AgentError('evaluate runs only in a tab an agent opened, never in the person\'s own tab or one it opened: open the page in a tab of your own (open {url}), which has their sign-ins too.', 'not_agent_opened')
      if (await filledHere(rec.owner, page.href)) throw new AgentError('evaluate does not run on a site where Walnut filled a login for you: it could read the password. Read the page with snapshot, text or find, or record its requests (network).', 'filled_here')
      const expression = typeof a.expression === 'string' ? a.expression : ''
      if (!expression) throw new AgentError('Give the expression to run.', 'bad_request')
      out = { ...(await run(tabId, rec.owner, (send) => cdpEvaluate(send, expression))) }
      break
    }
    case 'click': { const l = await locate(trustedOutward('click', a)); await run(tabId, rec.owner, (send) => cdpClick(send, l.x, l.y)); out = { clicked: l.what, trusted: true }; break }
    case 'hover': { const l = await locate(); await run(tabId, rec.owner, (send) => cdpHover(send, l.x, l.y)); out = { hovered: l.what, trusted: true }; break }
    case 'press': {
      const k = String(a.key ?? '')
      // Every combo that ends in Enter, and Space or Enter on a focused button or link, is judged.
      await locate({ active: true, ...trustedOutward('press', a) })
      await run(tabId, rec.owner, (send) => cdpPress(send, k))
      out = { pressed: k, trusted: true }
      break
    }
    case 'type': {
      const text = String(a.text ?? '')
      // Real typing presses Enter for each newline: a newline counts as submit.
      const enter = trustedOutward('type', a)
      const l = a.ref !== undefined ? await locate({ focus: true, clear: a.clear === true, ...enter }) : (await locate({ active: true, ...enter }), undefined)
      await run(tabId, rec.owner, async (send) => { await cdpType(send, text); if (a.submit === true) await cdpPress(send, 'Enter') })
      out = { typed: `${text.length} characters${l ? ` into ${l.what}` : ''}`, trusted: true }
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
  if (c.action !== 'hover' && c.action !== 'evaluate') await settled(tabId)
  return { ...out, ...(await where(tabId)) }
}
