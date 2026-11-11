/**
 * What an acting step changed, in one line on its answer (`changed`): it went to another page, it
 * opened a tab, the page changed, a field's value or the scroll changed, or nothing changed on the
 * page. 2026-11-10: an agent whose click "said ok" while nothing happened waited 30 s on an address
 * and then listed every tab of the person's browser to find out whether it had worked.
 *
 * The page watches itself from right before the step to its answer (page-probe.ts: a mutation
 * outside Walnut's own elements, a scroll anywhere, its fields' values; never its words), and the
 * tab's address and document are compared. A step that may set work going (a click, a key, a form)
 * and changed nothing is looked at once or twice more, briefly, for a page that answers late. A
 * step in a frame, or a page that could not be watched, says so or says nothing: never a guessed
 * "nothing changed". The field being typed in changing (its value, its own box) is "a field's value
 * changed", never "the page content changed". A typed text that submits says what its Enter did,
 * apart from the typing (the page marks its watch right before the Enter): `Enter: went to <url>`,
 * or that Enter changed nothing, with what to do instead (2026-11-10: a search typed with --submit
 * read "the page content changed" while nothing was searched).
 *
 * A step whose answer the page never sent (it left for the page the step opened, or it stopped
 * answering) is judged by the tab itself (`lostAnswer`): another address or document means the step
 * ran, and the answer says where it went; else the step may have run, and the words say to look
 * before acting again, never a bare "try again" (2026-11-11, a review: `type --submit` on GitHub's
 * search ran the search and answered page_not_ready "try again").
 */
import { ext } from './ext'
import { AgentError } from './agent-shared'
import { sleep, toPage } from './page-reach'

/** The steps whose answer says what changed. */
export const CHANGE_ACTS = new Set(['click', 'type', 'press', 'select', 'navigate', 'back', 'hover', 'scroll', 'fill_form', 'drag', 'upload'])
/** The steps that may start work the page answers later (a fetch, then a render). */
const LATE_ACTS = new Set(['click', 'type', 'press', 'select', 'fill_form', 'drag', 'upload'])
/** Looks for a late change this long after a step that changed nothing. */
const LATE_MS = [400, 800]
export const NOTHING = 'nothing changed on the page'
const LOOK_WAIT_MS = 3000
export const IN_FRAME = 'it acted inside a frame; the page around it did not change (the frame\'s own change is not checked)'

/** What the watch saw after its mark (the Enter of a typed text). */
export interface EnterMark { mutations: number; scrolls: number; values: boolean; scroll: boolean }
export interface PageMark { url?: string; doc?: string; values?: number; scroll?: number; watching?: boolean; mutations?: number; fields?: number; scrolls?: number; enter?: EnterMark }

/** Enter changed nothing: the words, and what to try. */
export const ENTER_NOTHING = 'Enter changed nothing on the page (no navigation, nothing submitted; the text is in the field): '
  + 'click the search or submit button beside it (find search), or open the results address directly'

/** The tab's address and what its page says (`watch` starts its watch, `read` reads it). */
export async function markOf(tabId: number, look: { watch?: string; read?: string; done?: boolean } = {}): Promise<PageMark> {
  const [t, d] = await Promise.all([
    ext.tabs.get(tabId).catch(() => null),
    // A loaded machine answers a page's message slowly (seen at a load of 400): no answer is no line.
    toPage<PageMark & { ok?: boolean }>(tabId, { type: 'agent-digest', ...look }, LOOK_WAIT_MS).catch(() => null),
  ])
  const page = d?.ok === true && typeof d.values === 'number'
  return {
    ...(t?.url ? { url: t.url } : {}),
    ...(page ? { doc: d!.doc, values: d!.values, scroll: d!.scroll } : {}),
    ...(page && look.read ? { watching: d!.watching === true, mutations: d!.mutations ?? 0, fields: d!.fields ?? 0, scrolls: d!.scrolls ?? 0, ...(d!.enter ? { enter: d!.enter } : {}) } : {}),
  }
}

/**
 * The line, or undefined when the page could not be watched (no guess). `inFrame`: the step acted
 * inside a frame, whose own changes the top page's watch does not see.
 */
export function changedLine(before: PageMark, after: PageMark, result: Record<string, unknown>, inFrame = false): string | undefined {
  const opened = result.opened as { tab?: unknown; url?: unknown } | undefined
  if (opened && typeof opened.tab === 'number') return `opened a new tab ${opened.tab}: ${String(opened.url ?? '')} (yours too: --tab ${opened.tab})`
  if (result.dialog) return 'it opened a dialog'
  // The address now (a page may move on after the step answered), with the title the step saw there.
  const url = after.url ?? (typeof result.url === 'string' ? result.url : undefined)
  const title = typeof result.title === 'string' && result.title && (!after.url || after.url === result.url) ? ` "${result.title}"` : ''
  if (before.url && url && before.url !== url) return `went to ${url}${title}`
  if (before.doc && after.doc && before.doc !== after.doc) return `the page loaded again${title}`
  if (before.values === undefined || after.values === undefined || after.watching !== true) return undefined
  if ((after.mutations ?? 0) > 0) return 'the page content changed'
  if (before.values !== after.values || (after.fields ?? 0) > 0) return 'a field\'s value changed'
  if ((after.scrolls ?? 0) > 0 || before.scroll !== after.scroll) return 'the page scrolled'
  return inFrame ? IN_FRAME : NOTHING
}

/**
 * The line of a typed text that submits: what its Enter did (and the search button page-enter.ts
 * clicked when Enter alone did nothing). Undefined when the page could not be watched.
 */
export function enterLine(before: PageMark, after: PageMark, result: Record<string, unknown>, inFrame = false): string | undefined {
  const button = typeof result.submit === 'string' && result.submit !== 'form' ? result.submit : undefined
  const lead = button ? `Enter changed nothing, so it clicked ${button}: ` : 'Enter: '
  const whole = changedLine(before, after, result, inFrame)
  if (whole === undefined || inFrame) return whole
  // An address, a reload, a new tab or a dialog: the Enter's (the typing makes none of them).
  if (whole !== 'the page content changed' && whole !== 'a field\'s value changed' && whole !== 'the page scrolled' && whole !== NOTHING) return `${lead}${whole}`
  const e = after.enter
  if (!e) {
    // The page never saw the mark (an older page script): the typing and the Enter are not told apart.
    if (whole === 'the page content changed') return 'the page content changed (the typing or its Enter: text or snapshot shows which)'
    return result.enter_quiet === true || whole === NOTHING || whole === 'a field\'s value changed' ? ENTER_NOTHING : whole
  }
  if (e.mutations > 0) return `${lead}the page content changed (no navigation)`
  if (e.values) return `${lead}a field's value changed (no navigation)`
  if (e.scrolls > 0 || e.scroll) return `${lead}the page scrolled (no navigation)`
  return ENTER_NOTHING
}

const watchId = (): string => `w${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
const framed = (r: unknown) => typeof r === 'string' && /^f\d+:/.test(r)

/**
 * The step run inside the page's watch; its answer with `changed`. `args`: the step's own (a ref
 * or form field in a frame means it acted there).
 */
export async function withChange(tabId: number, action: string, args: Record<string, unknown>, step: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const id = watchId()
  const before = await markOf(tabId, { watch: id })
  let r: Record<string, unknown>
  try {
    r = await step()
  } catch (err) {
    void markOf(tabId, { read: id, done: true }).catch(() => undefined)
    const lost = await lostAnswer(tabId, action, args, before, err)
    if ('answer' in lost) return lost.answer
    throw lost.error
  }
  // A dialog holds the page's script: nothing more to look at (the watch ends by itself).
  if (r.dialog) return { ...r, changed: 'it opened a dialog' }
  // A new tab is the answer: its own line, no look needed.
  if (r.opened) {
    void markOf(tabId, { read: id, done: true }).catch(() => undefined)
    return { ...r, changed: changedLine(before, {}, r) }
  }
  const tab = typeof r.tab === 'number' ? r.tab : tabId
  const m = r.matched as { frame?: unknown; ref?: unknown } | undefined
  const inFrame = framed(args.ref) || !!m?.frame || framed(m?.ref)
    || (Array.isArray(args.fields) && (args.fields as Array<{ ref?: unknown }>).some((f) => framed(f?.ref)))
  const late = LATE_ACTS.has(action)
  // A typed text that submits: what its Enter did, apart from the typing.
  const submits = (action === 'type' && args.submit === true) || (action === 'press' && args.key === 'Enter')
  const lineOf = (after: PageMark) => (submits ? enterLine : changedLine)(before, after, r, inFrame)
  // An Enter that changed the page but not its address yet may still go somewhere: looked at again too.
  const quiet = (l: string | undefined) => l === NOTHING || l === IN_FRAME || l === ENTER_NOTHING || (submits && !!l?.endsWith('(no navigation)'))
  let line = lineOf(await markOf(tab, { read: id, done: !late }))
  if (late) {
    for (const ms of LATE_MS) {
      if (!quiet(line)) break
      await sleep(ms)
      line = lineOf(await markOf(tab, { read: id }))
    }
    void markOf(tab, { read: id, done: true }).catch(() => undefined)
  }
  return line ? { ...r, changed: line } : r
}

/** What the answer of a step names it by, when the page never answered (the CLI's line reads them). */
function didOf(action: string, args: Record<string, unknown>): Record<string, unknown> {
  const what = typeof args.ref === 'string' ? args.ref : typeof args.text === 'string' && action !== 'type' ? `"${args.text}"` : 'it'
  switch (action) {
    case 'click': return { clicked: what }
    case 'hover': return { hovered: what }
    case 'type': return { typed: `${typeof args.text === 'string' ? args.text.length : 0} characters${typeof args.ref === 'string' ? ` into ${args.ref}` : ''}` }
    case 'press': return { pressed: String(args.key ?? '') }
    case 'select': return { selected: String(args.value ?? '') }
    default: return {}
  }
}

/** The words of a step whose answer was lost and whose tab shows no change: it may have run. */
export const MAYBE_RAN = 'The page did not answer this step in time, so Walnut cannot tell whether it ran: '
  + 'text or snapshot shows the page now; act again only if it did not.'

/**
 * A step that failed because the page never answered: its answer, when the tab shows it ran (another
 * address or document: it went there before it could answer), or the error to throw. Any other
 * failure is thrown as it is.
 */
export async function lostAnswer(tabId: number, action: string, args: Record<string, unknown>, before: PageMark, err: unknown): Promise<{ answer: Record<string, unknown> } | { error: unknown }> {
  if (!(err instanceof AgentError) || err.code !== 'page_not_ready' || err.extra.unanswered !== true || !CHANGE_ACTS.has(action)) return { error: err }
  const t = await ext.tabs.get(tabId).catch(() => null)
  // The tab is gone: the step may have closed it (a page that closes itself), so never "try again".
  if (!t) return { error: new AgentError('The tab closed before it answered the step (the step may have closed it): tabs lists yours.', 'not_your_tab') }
  const after = await markOf(tabId).catch((): PageMark => ({}))
  const url = after.url ?? t.url
  const submits = (action === 'type' && args.submit === true) || (action === 'press' && args.key === 'Enter')
  const lead = submits ? 'Enter: ' : ''
  const ran = { tab: tabId, ...(url ? { url } : {}), ...didOf(action, args), note: '(the page left before it answered; its address shows the step ran)' }
  if (before.url && url && before.url !== url) return { answer: { ...ran, changed: `${lead}went to ${url}${t.title ? ` "${t.title}"` : ''}` } }
  if (before.doc && after.doc && before.doc !== after.doc) return { answer: { ...ran, changed: `${lead}the page loaded again`, note: '(the page loaded again before it answered: the step ran)' } }
  const { unanswered: _u, ...extra } = err.extra
  return { error: new AgentError(MAYBE_RAN, 'page_not_ready', extra) }
}
