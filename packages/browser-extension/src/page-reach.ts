/**
 * Reaching the extension's script in a tab (content.ts). A browser puts it only into pages loaded
 * after the extension started: a tab that was open before the person installed it, or before
 * the extension reloaded (an update), has none, so every message to it went unanswered and an
 * agent got "page not ready" on a page that had long finished loading (2026-11-04, the person's
 * Gmail, open since before the install). Such a tab gets the script now, through the scripting
 * API (no debugger, so the browser shows no "started debugging" bar). A page asleep (discarded
 * by the browser to save memory) is woken first; one that does not answer in time is reported,
 * never waited on forever.
 */
import { ext } from './ext'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A message to the page's script in the top frame, or null when it does not answer in `ms`. */
export async function toPage<T = Record<string, unknown>>(tabId: number, msg: Record<string, unknown>, ms = 10_000, frameId = 0): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms) })
  try {
    return await Promise.race([
      Promise.resolve(ext.tabs.sendMessage(tabId, msg, { frameId })).then((r) => (r ?? null) as T | null, () => null),
      late,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The page's own word on what it is: Walnut, and the address of the document now loaded. */
export async function pageCheck(tabId: number, ms = 4000): Promise<{ walnut: boolean; href: string } | null> {
  const r = await toPage<{ ok?: boolean; walnut?: boolean; href?: string }>(tabId, { type: 'agent-check' }, ms)
  return r?.ok ? { walnut: r.walnut === true, href: String(r.href ?? '') } : null
}

/**
 * Puts the content script into every frame of a tab (content.js runs once per frame). Always the
 * default ISOLATED world, never MAIN: there the page could read or fake the copy's liveness
 * (`__walnutContentLive`, scripts/build-extension.mjs). A frozen renderer never answers, so the
 * call has its own time limit.
 */
export async function injectContent(tabId: number, ms = 5000): Promise<boolean> {
  if (!ext.scripting) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      ext.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function settled(tabId: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const end = Date.now() + Math.max(0, ms)
    const tick = () => {
      void ext.tabs.get(tabId).then((t) => {
        if (t.status === 'complete' || Date.now() > end) resolve()
        else setTimeout(tick, 200)
      }, () => resolve())
    }
    tick()
  })
}

export type ReachError = 'gone' | 'not_web' | 'no_script'

/** A tab that could not be reached just now is not tried again for a moment (a page refresh asks often). */
const unreachable = new Map<number, number>()
const UNREACHABLE_MS = 10_000

/**
 * The tab's script answers (the page's check), after putting it in when it was missing, all
 * within `deadlineMs`: the caller's own command has a time limit, and an answer after it would
 * be an action the agent was already told failed.
 * `wake`: a tab the browser discarded is loaded again (an agent's own tab; the person's tab
 * the browser discarded comes back the same way when they click it).
 * `quick`: a tab that failed in the last few seconds fails at once (the side panel's refresh).
 */
export async function reachPage(tabId: number, wake = true, opts: { deadlineMs?: number; quick?: boolean } = {}): Promise<{ ok: true; walnut: boolean; href: string } | { ok: false; why: ReachError }> {
  const end = Date.now() + (opts.deadlineMs ?? 8000)
  const left = () => end - Date.now()
  const fail = (why: ReachError) => { if (why === 'no_script') unreachable.set(tabId, Date.now()); return { ok: false as const, why } }
  const first = await pageCheck(tabId, Math.min(3000, left()))
  if (first) { unreachable.delete(tabId); return { ok: true, ...first } }
  if (opts.quick && Date.now() - (unreachable.get(tabId) ?? 0) < UNREACHABLE_MS) return { ok: false, why: 'no_script' }
  const tab = await ext.tabs.get(tabId).catch(() => null)
  if (!tab) return fail('gone')
  if (!/^https?:\/\//i.test(tab.url ?? '')) return fail('not_web')
  if (tab.discarded && wake) {
    await ext.tabs.reload(tabId).catch(() => undefined)
    await settled(tabId, left() - 2000)
    const back = await pageCheck(tabId, Math.min(1500, left()))
    if (back) return { ok: true, ...back }
  } else if (tab.status === 'loading') {
    // Still loading: its script comes with the page.
    await settled(tabId, left() - 2000)
    const loaded = await pageCheck(tabId, Math.min(1500, left()))
    if (loaded) return { ok: true, ...loaded }
  }
  if (left() < 1000 || !(await injectContent(tabId, Math.min(5000, left())))) return fail('no_script')
  // The script registers its listener as it starts: give it a moment.
  while (left() > 0) {
    const r = await pageCheck(tabId, Math.min(1500, left()))
    if (r) { unreachable.delete(tabId); return { ok: true, ...r } }
    await sleep(200)
  }
  return fail('no_script')
}

/**
 * Right after an install or an update: every open web page gets the script, so the person's
 * tabs work without being reloaded. The script runs once per frame however often it is put in.
 */
export async function injectOpenTabs(): Promise<number> {
  if (!ext.scripting) return 0
  const tabs = (await ext.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []))
    .filter((t) => t.id !== undefined && !t.discarded)
  let n = 0
  // A few at a time: one frozen tab must not hold up the rest.
  for (let i = 0; i < tabs.length; i += 6) {
    const done = await Promise.all(tabs.slice(i, i + 6).map((t) => injectContent(t.id!)))
    n += done.filter(Boolean).length
  }
  return n
}
