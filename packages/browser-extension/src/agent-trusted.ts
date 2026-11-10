/**
 * Real input for an agent: the browser's own mouse, wheel and keys through its debugger (cdp.ts),
 * which pages take as a person's (isTrusted). A step that may open a page dialog runs with the
 * debugger watching for one (agent-dialog.ts), and answers with it. Only in the top frame. On with
 * the debugger permission (required in the manifest) unless the person turned "Let agents use real
 * mouse and keys" off (trusted-switch.ts).
 *
 *   - By default (2026-11-09, the user: "fully capable using debug"): an agent's click, type, press
 *     and hover in its own tab in Walnut's agent window go through the debugger without `trusted`
 *     (trustedByDefault). They fall back to the page's events, as before, in a frame, in a tab of
 *     the person's (handed over or taken: real input there only when the agent asks for it by name,
 *     as before), on a link to a new tab (the background opens that one, in the background), on a
 *     control that opens a picker of the browser's (a select, a file chooser), on a shortcut with
 *     Control, Meta or Alt or a key the debugger does not know, with
 *     DevTools open on the tab, for a while after the person cancelled Chrome's debugging bar, or
 *     with `trusted: false`. A scroll stays the page's (its answer says where the page is, which
 *     the wheel cannot).
 *   - `trusted: true` (and `dialog`, `evaluate`, `drag`, always): real input wherever the agent may
 *     act, or a refusal that says why.
 * Chrome drops real input on a page it does not draw (Walnut's agent window covered or minimized,
 * agent-delivery.ts): a step that sends it (INPUT_OPS) checks first and after, and a default step
 * takes the page's events instead (its answer says `trusted: false` and why); one that asked for
 * real input by name is refused (`window_hidden`, `input_dropped`), never answered as done.
 * Either way a step that buys, sends or deletes is judged the same (page-ops.ts held, right after
 * the cursor and again with the debugger attached): it waits for the person's yes.
 * `evaluate` runs the page's own JavaScript, so only in a tab an agent opened, never the person's
 * (nor one their tab opened), and never on a site where fill_login put a password in. A trusted
 * upload sends only files this task's own downloads wrote.
 */
import { more } from './agent-api'
import { realInputOn } from './trusted-switch'
import { isFirefox, type Tab } from './ext'
import { cdpClick, cdpEvaluate, cdpHover, cdpPress, cdpType, cdpUpload, cdpWheel } from './cdp'
import { run, watched } from './agent-debugger'
import { ACTING_MS, AgentError, acting, agentWindowId, checkPage, filledHere, frameOp, nearPerson, personsTab, reached, settled, where, WALNUT_PAGE, type AgentTab, type WireCommand } from './agent-shared'
import { downloadedFiles } from './agent-downloads'
import { openedSince, outwardHeld, refByText } from './agent-page'
import { barCancelled, comboModifiers } from './cdp'
import { cancelKnown } from './agent-live'
import { trustedOutward } from './page-agent-outward'
import type { DialogInfo } from './agent-dialog'
import { dialogAct } from './agent-dialog-act'
import { dragAct } from './agent-drag'
import { SLOW_KEY_MS, SLOW_MAX, wheelDelta } from './input-math'
import { DROPPED_WHY, HIDDEN_WHY, delivered, droppedWords, hiddenWords, probeId } from './agent-delivery'
import { sleep } from './page-reach'

export const TRUSTED_OPS = new Set(['click', 'type', 'press', 'hover', 'upload', 'scroll'])
/** A click by its words: the search may take this much of the command's time, the click the rest. */
const SEARCH_MS = 8000
/** These use the debugger whatever the command says. */
export const DEBUGGER_OPS = new Set(['dialog', 'evaluate', 'drag'])
/**
 * The steps of those two sets that send the debugger's mouse, wheel or keys (Input.*): each checks
 * that the page received them (agent-delivery.ts). Every one of TRUSTED_OPS and DEBUGGER_OPS is
 * here or in NO_INPUT_OPS (tests/core/browser-control/extension-hidden-input.test.ts).
 */
export const INPUT_OPS = new Set(['click', 'hover', 'type', 'press', 'scroll', 'drag'])
/** The debugger steps that send no input, and why a page Chrome does not draw takes them all the same. */
export const NO_INPUT_OPS: Record<string, string> = {
  dialog: 'Page.handleJavaScriptDialog answers the dialog itself',
  evaluate: 'Runtime.evaluate runs a script, no input',
  upload: 'DOM.setFileInputFiles sets the files, no input',
}

/**
 * Where the person turns real input on, step by step (an agent passes it on as it is). Real input,
 * evaluate, dialog and recording a tab (agent-net.ts) all wait for this one switch.
 */
export const REAL_INPUT_SWITCH = 'It is on unless the person turned it off, and only the person can turn it back on: in Chrome, click the Walnut extension\'s icon in the toolbar (in the puzzle-piece Extensions menu when it is not pinned), '
  + 'click the gear (Settings) at the top of the popup, and turn on "Let agents use real mouse and keys"; if Chrome asks to allow the debugger: Allow. '
  + 'While an agent uses it, Chrome shows its "started debugging" bar at the top of every tab.'
const OFF = `Real input is off in this browser. ${REAL_INPUT_SWITCH} Without it, use the action without trusted.`

/** The debugger permission and the person's real-input switch (trusted-switch.ts). */
export async function trustedReady(): Promise<boolean> {
  return !isFirefox && !!more.debugger && await realInputOn()
}

/** Steps that go through the debugger by default (trustedByDefault), with no `trusted` asked. */
export const DEFAULT_TRUSTED_OPS = new Set(['click', 'type', 'press', 'hover'])
/** Typed text longer than this stays the page's by default: real typing sends two commands a character. */
export const DEFAULT_TYPE_MAX = 200

const inFrame = (r: unknown) => typeof r === 'string' && /^f\d+:/.test(r)
/**
 * The page's key events take this press by default: Alt (1), Control (2) or Meta (4) in the combo,
 * or a key the debugger does not know (the page's own press takes any key name, review 2026-11-09).
 */
function pageTakesKey(combo: string): boolean {
  const m = comboModifiers(combo)
  return m === null || (m & 7) !== 0
}

/**
 * Whether this step goes through the debugger though the agent did not ask (`trusted` not given):
 * real input is on, the tab is the agent's own in Walnut's agent window (never one of the
 * person's), the step names no frame, and the person did not cancel the debugging bar lately.
 */
export async function trustedByDefault(c: WireCommand, tabId: number, tab: Tab, rec: AgentTab): Promise<boolean> {
  const a = c.args
  if (!DEFAULT_TRUSTED_OPS.has(c.action) || a.trusted !== undefined) return false
  if (inFrame(a.ref) || personsTab(rec)) return false
  if (c.action === 'type' && [...String(a.text ?? '')].length > DEFAULT_TYPE_MAX) return false
  // A shortcut with Control, Meta or Alt is the browser's too (a new tab, a new window, history,
  // closing the tab): the page's own key events reach only the page (review 2026-11-09).
  if (c.action === 'press' && pageTakesKey(String(a.key ?? ''))) return false
  if (tab.windowId === undefined || tab.windowId !== await agentWindowId()) return false
  await cancelKnown()
  if (barCancelled(tabId)) return false
  return trustedReady()
}

/** Real input could not take this default step before it acted: the page's events take it instead. */
class Fallback extends Error {
  /** `why`: the page was not drawn, or did not receive the input (the answer says so). */
  constructor(readonly found?: Awaited<ReturnType<typeof refByText>>, readonly why?: string) { super('real input falls back to the page') }
}
/** Refusals that come before anything is pressed: a default step falls back on them. */
const FALLBACK_CODES = new Set(['trusted_frame', 'debugger_busy'])

/**
 * A step trustedByDefault chose: real input, or `fallback` (with the words' match, when a click
 * by its words found it in a frame) for the page's events. Every other answer, an outward step's
 * hold included, is the step's own.
 */
export async function defaultTrustedAct(c: WireCommand, tabId: number, tab: Tab, rec: AgentTab): Promise<{ done: Record<string, unknown> } | { fallback: true; found?: Awaited<ReturnType<typeof refByText>>; why?: string }> {
  try {
    return { done: await trustedAct(c, tabId, tab, rec, true) }
  } catch (err) {
    if (err instanceof Fallback) return { fallback: true, ...(err.found ? { found: err.found } : {}), ...(err.why ? { why: err.why } : {}) }
    if (err instanceof AgentError && FALLBACK_CODES.has(err.code)) return { fallback: true }
    throw err
  }
}

/** `soft`: a step trustedByDefault chose (it falls back where the page's events would do). */
export async function trustedAct(c: WireCommand, tabId: number, tab: Tab, rec: AgentTab, soft = false): Promise<Record<string, unknown>> {
  if (!(await trustedReady())) throw new AgentError(isFirefox ? 'Real input needs Chrome: Firefox does not let extensions use its debugger.' : OFF, 'trusted_off')
  let a = c.args
  if (inFrame(a.ref) || inFrame(a.to_ref)) throw new AgentError('Real input works in the top frame of the page only: use the action without trusted in a frame.', 'trusted_frame')
  await checkPage(c.allow, tab.url ?? '')
  // A dialog blocks the page's script, so the page is not asked first.
  if (c.action === 'dialog') return dialogAct(c, tabId, rec)
  let page = await reached(tabId)
  // A tab just brought to the front may still read hidden for a moment: a named step asks twice more.
  for (let i = 0; i < 2 && page.hidden && !soft && INPUT_OPS.has(c.action); i++) { await sleep(150); page = await reached(tabId) }
  if (page.walnut) throw new AgentError(WALNUT_PAGE, 'walnut_page')
  await checkPage(c.allow, page.href)
  // A page Chrome does not draw drops the debugger's input: never sent there (agent-delivery.ts).
  if (page.hidden && INPUT_OPS.has(c.action)) {
    if (soft) throw new Fallback(undefined, HIDDEN_WHY)
    throw new AgentError(hiddenWords(c.action), 'window_hidden')
  }
  // The step's delivery probe, armed by the last look before the debugger acts (page-probe.ts);
  // after it, a page that saw none of its events had the input dropped.
  const probe = probeId()
  // Armed and not read yet: a step that fails after arming disarms it (finally, below).
  let armed = false
  const probing = (kind: string) => { armed = true; return { probe, probe_kind: kind } }
  const check = async (kind: string) => {
    armed = false
    if (await delivered(tabId, probe, c.allow)) return
    if (soft) throw new Fallback(matched, DROPPED_WHY)
    throw new AgentError(droppedWords(kind), 'input_dropped')
  }
  // `cursor`: the page draws the agent's cursor at the point before the debugger acts there (page-cursor.ts).
  const locate = async (extra: Record<string, unknown> = {}) => {
    const r = await frameOp(tabId, 0, 'locate', { ref: a.ref, x: a.x, y: a.y, ...(typeof a.label === 'number' ? { label: a.label } : {}), ...(a.outward_ok ? { outward_ok: a.outward_ok } : {}), ...extra }, c.allow)
    // A step that buys, sends or deletes waits for the person (page-ops.ts held).
    if (r.hold) throw outwardHeld(r.hold)
    return r as { x: number; y: number; what: string }
  }
  /**
   * The step judged once more with the debugger attached, right before it presses (review
   * 2026-11-09): attaching shows Chrome's debugging bar, which makes the page shorter and may move
   * a "Place order" bar under the point. No cursor, no focus: only what is there now, and where.
   */
  const again = (extra: Record<string, unknown>) => locate({ ...extra, recheck: true })
  // A click by its words: the match, top frame only (real input).
  let matched: Awaited<ReturnType<typeof refByText>> | undefined
  if ((c.action === 'click' || c.action === 'hover') && typeof a.text === 'string' && a.text && a.ref === undefined && typeof a.x !== 'number' && typeof a.label !== 'number') {
    const m = await refByText(c, tabId, Date.now() + SEARCH_MS)
    if (inFrame(m.ref) && soft) throw new Fallback(m)
    if (inFrame(m.ref)) throw new AgentError(`"${String(a.text).slice(0, 60)}" is inside a frame (${m.ref}): real input works in the top frame only, so click it without trusted.`, 'trusted_frame')
    a = { ...a, ref: m.ref, text: undefined }
    matched = m
  }
  if (c.action === 'drag') {
    armed = true
    try { return await dragAct({ ...c, args: a }, tabId, rec, { probe, check: () => check('drag') }) } finally { if (armed) disarmProbe(tabId, probe, c.allow) }
  }
  let out: Record<string, unknown>
  let dialog: DialogInfo | undefined
  // A default step sends only mouse and key events: the page stays fillable (agent-debugger.ts run).
  const taint = { taint: !soft }
  // A window or tab the page opens from this step is the agent's (agent-page.ts watchOpened).
  const started = Date.now()
  acting.set(tabId, started + 30_000 + ACTING_MS)
  try {
    switch (c.action) {
      case 'evaluate': {
        if (nearPerson(rec)) throw new AgentError('evaluate runs only in a tab an agent opened, never in the person\'s own tab or one it opened: open the page in a tab of your own (open {url}), which has their sign-ins too.', 'not_agent_opened')
        if (await filledHere(rec.owner, page.href)) throw new AgentError('evaluate does not run on a site where Walnut filled a login for you: it could read the password. Read the page with snapshot, text or find, or record its requests (network).', 'filled_here')
        const expression = typeof a.expression === 'string' ? a.expression : ''
        if (!expression) throw new AgentError('Give the expression to run.', 'bad_request')
        out = { ...(await run(tabId, rec.owner, (send) => cdpEvaluate(send, expression))) }
        break
      }
      case 'click': {
        const judge = trustedOutward('click', a)
        // A default click asks whether it is a link to a new tab (the page's own click opens that one
        // in the background) or a control that opens a picker of the browser's (a select, a file
        // chooser): those stay the page's.
        const pageTakes = (r: unknown) => soft && (typeof (r as { newTab?: unknown }).newTab === 'string' || (r as { native?: unknown }).native === true)
        const blank = soft ? { blank: true } : {}
        let l = await locate({ ...judge, cursor: 'click', ...blank })
        if (pageTakes(l)) throw new Fallback(matched)
        dialog = await watched(tabId, rec.owner, async (send) => {
          l = await again({ ...judge, ...blank, ...probing('click') })
          // What is under the point changed once the debugger attached: still nothing pressed.
          if (pageTakes(l)) throw new Fallback(matched)
          await cdpClick(send, l.x, l.y)
        }, undefined, taint)
        if (!dialog) await check('click')
        out = { clicked: l.what, trusted: true }
        break
      }
      case 'hover': {
        const l = await locate({ cursor: 'move', ...probing('hover') })
        // A step aside first: a mouse already at the point would move nowhere and the page see nothing.
        await run(tabId, rec.owner, async (send) => { await cdpHover(send, l.x + 1, l.y); await cdpHover(send, l.x, l.y) }, taint)
        await check('hover')
        out = { hovered: l.what, trusted: true }
        break
      }
      case 'press': {
        const k = String(a.key ?? '')
        // Every combo that ends in Enter, and Space or Enter on a focused button or link, is judged.
        await locate({ active: true, ...trustedOutward('press', a) })
        dialog = await watched(tabId, rec.owner, async (send) => { await again({ active: true, ...trustedOutward('press', a), ...probing('press') }); await cdpPress(send, k) }, undefined, taint)
        if (!dialog) await check('press')
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
        const atJudge = { outward: 'click', ...(enter.outward ? { then_enter: true, typing: enter.typing } : {}) }
        let l = at ? await locate({ focus: true, clear: a.clear === true, cursor: 'click', ...atJudge })
          : a.ref !== undefined ? await locate({ focus: true, clear: a.clear === true, cursor: 'move', ...enter }) : (await locate({ active: true, ...enter }), undefined)
        // Nothing is sent for no text, no Enter and no click at a point: nothing to check. A click
        // with no keys after it is checked as a click.
        const keys = text.length > 0 || a.submit === true
        const sends = keys || at
        const kind = keys ? 'type' : 'click'
        const typeProbe = sends ? probing(kind) : {}
        dialog = await watched(tabId, rec.owner, async (send) => {
          // Judged again on what is there now: at the point, or the focused field the text goes to.
          if (at) l = await again({ ...atJudge, ...typeProbe })
          else await again({ active: true, ...enter, ...typeProbe })
          if (at && l) await cdpClick(send, l.x, l.y)
          await cdpType(send, text, slowly ? SLOW_KEY_MS : 0)
          // The page's watch is marked before the Enter, so the answer tells what the Enter did (agent-change.ts).
          if (a.submit === true) { await frameOp(tabId, 0, 'watch_mark', {}, c.allow, 2000).catch(() => undefined); await cdpPress(send, 'Enter') }
        }, undefined, taint)
        if (!dialog && sends) await check(kind)
        out = { typed: `${text.length} characters${l ? ` into ${l.what}` : ''}${slowly ? ', one key at a time' : ''}`, trusted: true }
        break
      }
      case 'scroll': {
        // The wheel over the element (or point, or the middle of the page): what is under it scrolls.
        const l = await locate({ ...(a.ref === undefined && typeof a.x !== 'number' ? { middle: true, cursor: 'move' } : { cursor: 'move' }), ...probing('scroll') })
        const d = wheelDelta(a)
        await run(tabId, rec.owner, (send) => cdpWheel(send, l.x, l.y, d.x, d.y))
        await check('scroll')
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
        const l = await locate({ mark: markId, cursor: 'move', ...(typeof a.selector === 'string' && a.ref === undefined ? { selector: a.selector } : {}) })
        await run(tabId, rec.owner, (send) => cdpUpload(send, markId, paths))
        out = { uploaded: paths, into: l.what, trusted: true }
        break
      }
      default: throw new AgentError(`${c.action} has no real-input form.`, 'bad_action')
    }
    // A dialog the step opened holds the page: nothing loads until it is answered.
    if (dialog) return { ...out, ...(matched ? { matched } : {}), dialog, note: 'The step opened a dialog: dialog accept (with text for a prompt) or dialog dismiss answers it.', ...(await where(tabId)) }
    if (c.action !== 'hover' && c.action !== 'evaluate') await settled(tabId)
    const popup = c.action === 'click' || c.action === 'press' || c.action === 'type' ? await openedSince(tabId, started) : undefined
    return { ...out, ...(matched ? { matched } : {}), ...(await where(tabId)), ...(popup ? { opened: popup } : {}) }
  } finally {
    acting.set(tabId, Date.now() + ACTING_MS)
    if (armed) disarmProbe(tabId, probe, c.allow)
  }
}

/** A probe the step armed and never read (it failed, or a dialog took the page): taken off, in the background. */
function disarmProbe(tabId: number, probe: string, allow: WireCommand['allow']): void {
  void frameOp(tabId, 0, 'probe_read', { probe, done: true }, allow).catch(() => undefined)
}
