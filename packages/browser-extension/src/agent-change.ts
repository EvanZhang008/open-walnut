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
 * "nothing changed".
 */
import { ext } from './ext'
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

export interface PageMark { url?: string; doc?: string; values?: number; scroll?: number; watching?: boolean; mutations?: number; scrolls?: number }

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
    ...(page && look.read ? { watching: d!.watching === true, mutations: d!.mutations ?? 0, scrolls: d!.scrolls ?? 0 } : {}),
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
  if (before.values !== after.values) return 'a field\'s value changed'
  if ((after.scrolls ?? 0) > 0 || before.scroll !== after.scroll) return 'the page scrolled'
  return inFrame ? IN_FRAME : NOTHING
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
    throw err
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
  let line = changedLine(before, await markOf(tab, { read: id, done: !late }), r, inFrame)
  if (late) {
    for (const ms of LATE_MS) {
      if (line !== NOTHING && line !== IN_FRAME) break
      await sleep(ms)
      line = changedLine(before, await markOf(tab, { read: id }), r, inFrame)
    }
    void markOf(tab, { read: id, done: true }).catch(() => undefined)
  }
  return line ? { ...r, changed: line } : r
}
