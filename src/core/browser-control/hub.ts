/**
 * Agents using the person's own browser through the Walnut browser extension
 * (packages/browser-extension): the server is the relay. A connected extension asks for work
 * with a long poll (POST /api/v1/browser/poll), runs each command in its own tabs, and posts
 * the result back (POST /api/v1/browser/result). An agent's command (POST /api/v1/browser/act,
 * the `browser` op, `walnut browser`) waits here for that result.
 *
 * A long poll instead of a socket: it rides the HTTP auth every device already has, works the
 * same in Chrome and Firefox, through the tunnel too, and a browser that sleeps or restarts
 * simply polls again.
 *
 * Tabs belong to who opened them: an agent sees and acts only on the tabs its own task opened
 * (the extension holds the same rule: only tabs in its agent window are ever touched).
 */
import crypto from 'node:crypto'

export interface ControllerInfo {
  /** The paired device (extension-<hex>). */
  device: string
  /** "Walnut extension (Chrome on Mac)". */
  label: string
  browser: string
  version: string
  /** What this browser can do: 'screenshot', 'trusted-input', ... */
  caps: string[]
  /**
   * The agent tabs it holds and who opened each (the owner key went with `open`): a restarted
   * server learns them back from the next poll.
   */
  tabs?: Array<{ id: number; owner: string }>
}

interface Controller extends ControllerInfo {
  lastSeen: number
  waiter?: { resolve: (cmds: WireCommand[]) => void; timer: ReturnType<typeof setTimeout>; promise: Promise<WireCommand[]> }
  queue: WireCommand[]
}

/** What the extension receives. */
export interface WireCommand {
  id: string
  action: string
  args: Record<string, unknown>
  /** The sites agents may use (the extension checks the tab it acts in against them). */
  /** The sites agents may use, and Walnut's own addresses (`host` or `host:port`), never theirs. */
  allow: { any: boolean; sites: string[]; walnut?: string[] }
}

interface Pending {
  device: string
  resolve: (r: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** The tab the command acts on. */
  tab?: number
}

export class BrowserError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

/** A controller that has not polled for this long is not connected. */
export const CONNECTED_MS = 45_000
export const POLL_MAX_MS = 25_000
export const DEFAULT_COMMAND_MS = 30_000

const controllers = new Map<string, Controller>()
const pending = new Map<string, Pending>()
/** `${device}:${tabId}` → the owner key (task or session) that opened it. */
const tabOwners = new Map<string, string>()
const tabSetAt = new Map<string, number>()
/**
 * Tabs a report of their browser has listed. One of them missing from a later report is gone (closed,
 * or one the extension let go of, such as Walnut's own page), at once; only a tab known from an
 * action's answer alone waits out the grace, since a report may have been read before that answer.
 */
const tabReported = new Set<string>()
const TAB_REPORT_GRACE_MS = 60_000
/**
 * Browsers that left on purpose (agents turned off, or the person disconnected the extension), so
 * a command fails at once saying which, instead of waiting for a poll that never comes.
 */
type GoneWhy = 'off' | 'disconnected'
const gone = new Map<string, { label: string; at: number; why: GoneWhy }>()
const GONE_MS = 30 * 60_000

/** The extension asks for work: the queued commands, or wait for one up to `waitMs`. */
export function poll(info: ControllerInfo, waitMs = POLL_MAX_MS): Promise<WireCommand[]> {
  const c: Controller = controllers.get(info.device) ?? { device: info.device, label: info.label, browser: info.browser, version: info.version, caps: info.caps, lastSeen: 0, queue: [] }
  const { tabs: _tabs, ...rest } = info
  Object.assign(c, rest, { lastSeen: Date.now() })
  controllers.set(info.device, c)
  gone.delete(info.device)
  if (info.tabs) {
    // The report was read before the request left: a tab an open just gave (its result may
    // arrive first) is kept until a report a while later still lacks it.
    const reported = new Set<string>()
    for (const t of info.tabs) {
      if (!Number.isInteger(t.id) || typeof t.owner !== 'string' || !t.owner) continue
      const k = `${info.device}:${t.id}`
      reported.add(k)
      if (tabOwners.get(k) !== t.owner) { tabOwners.set(k, t.owner); tabSetAt.set(k, Date.now()) }
      tabReported.add(k)
    }
    for (const k of [...tabOwners.keys()]) {
      if (!k.startsWith(`${info.device}:`) || reported.has(k)) continue
      if (tabReported.has(k) || Date.now() - (tabSetAt.get(k) ?? 0) > TAB_REPORT_GRACE_MS) forgetTab(k)
    }
  }
  // A second poll (the background restarted) takes over: the first one gets nothing.
  if (c.waiter) { clearTimeout(c.waiter.timer); c.waiter.resolve([]); c.waiter = undefined }
  if (c.queue.length) return Promise.resolve(c.queue.splice(0))
  let waiter!: NonNullable<Controller['waiter']>
  const promise = new Promise<WireCommand[]>((resolve) => {
    const timer = setTimeout(() => {
      if (c.waiter?.timer === timer) c.waiter = undefined
      c.lastSeen = Date.now()
      resolve([])
    }, Math.max(0, Math.min(POLL_MAX_MS, waitMs)))
    timer.unref?.()
    waiter = { resolve: (cmds) => { c.lastSeen = Date.now(); resolve(cmds) }, timer, promise: undefined as unknown as Promise<WireCommand[]> }
  })
  waiter.promise = promise
  c.waiter = waiter
  return promise
}

/** The extension's answer to one command. Only the device the command went to may answer it. */
export function answer(device: string, id: string, ok: boolean, result: unknown, error?: { message?: string; code?: string; extra?: Record<string, unknown> }): boolean {
  const p = pending.get(id)
  if (!p || p.device !== device) return false
  pending.delete(id)
  clearTimeout(p.timer)
  if (ok) p.resolve(result)
  else {
    const code = error?.code || 'browser_error'
    // The extension no longer holds that tab (the person took it back, or closed it).
    if (code === 'not_your_tab' && typeof p.tab === 'number') releaseTab(device, p.tab)
    p.reject(new BrowserError(error?.message || 'The browser could not do that.', code === 'not_your_tab' ? 403 : 409, code, error?.extra ?? {}))
  }
  return true
}

const DISCONNECTED = 'The person disconnected this browser from Walnut: nothing reaches it until they connect it again '
  + '(the Walnut extension\'s popup, Connect). Ask them to, if the work needs their browser.'
const OFF = 'The person turned agents off in this browser (the Walnut extension\'s popup, Settings, "Let Walnut agents use this browser").'

/** Why the browser left, as the agent hears it. */
function goneError(why: GoneWhy): BrowserError {
  return why === 'disconnected' ? new BrowserError(DISCONNECTED, 409, 'browser_disconnected') : new BrowserError(OFF, 409, 'browser_off')
}

/**
 * The browser stopped (the person turned agents off, `off`; disconnected the extension or its
 * device was removed, `disconnected`): nothing waits on it, and the next command hears why.
 */
export function disconnect(device: string, why: GoneWhy = 'off'): void {
  const c = controllers.get(device)
  if (c?.waiter) { clearTimeout(c.waiter.timer); c.waiter.resolve([]); c.waiter = undefined }
  const before = gone.get(device)
  if (c || before) gone.set(device, { label: c?.label ?? before!.label, at: Date.now(), why: before?.why === 'disconnected' ? 'disconnected' : why })
  controllers.delete(device)
  for (const [id, p] of pending) {
    if (p.device !== device) continue
    pending.delete(id)
    clearTimeout(p.timer)
    p.reject(goneError(why))
  }
  for (const k of [...tabOwners.keys()]) if (k.startsWith(`${device}:`)) forgetTab(k)
}

/** With no browser connected, the one that left on purpose most recently (the last half hour), for the words. */
export function lastGone(now = Date.now()): { label: string; at: number; why: GoneWhy } | undefined {
  if (connected(now).length) return undefined
  let best: { label: string; at: number; why: GoneWhy } | undefined
  for (const [d, g] of gone) {
    if (now - g.at > GONE_MS) { gone.delete(d); continue }
    if (!best || g.at > best.at) best = g
  }
  return best
}

/** The browsers that let agents in now. Which tab is whose stays here: it is no one else's to read. */
export function connected(now = Date.now()): ControllerInfo[] {
  return [...controllers.values()]
    .filter((c) => now - c.lastSeen < CONNECTED_MS || !!c.waiter)
    .map(({ device, label, browser, version, caps }) => ({ device, label, browser, version, caps }))
}

/** The poll that took these commands is gone (its client went away): they wait for the next one. */
export function requeue(device: string, cmds: WireCommand[]): void {
  const c = controllers.get(device)
  if (!c || !cmds.length) return
  const live = cmds.filter((x) => pending.has(x.id))
  if (c.waiter) { const w = c.waiter; c.waiter = undefined; clearTimeout(w.timer); w.resolve(live) } else c.queue.unshift(...live)
}

/**
 * Stop waiting for a poll whose client went away, so nothing is handed to it, and count that
 * browser as gone until it polls again (a background that restarted polls at once; a browser
 * that quit does not, and must not take the next command).
 */
export function dropPoll(device: string, which: Promise<WireCommand[]>): void {
  const c = controllers.get(device)
  if (c?.waiter && c.waiter.promise === which) {
    clearTimeout(c.waiter.timer)
    const w = c.waiter
    c.waiter = undefined
    w.resolve([])
    c.lastSeen = 0
  }
}

/** The connected browser holding this owner's tab (the one named, else any of theirs). */
export function deviceForTab(owner: string, tab?: number): string | undefined {
  const live = new Set(connected().map((c) => c.device))
  for (const [k, o] of tabOwners) {
    if (o !== owner) continue
    const i = k.lastIndexOf(':')
    const device = k.slice(0, i)
    if (live.has(device) && (tab === undefined || Number(k.slice(i + 1)) === tab)) return device
  }
  return undefined
}

/**
 * A moment for a browser to come in: one that just turned agents on (or whose background just
 * started again) polls within a second or two, and a command sent in that gap should not fail.
 */
export async function waitConnected(ms: number): Promise<void> {
  // A browser the person disconnected does not come back by itself: no wait.
  if (lastGone()?.why === 'disconnected') return
  const until = Date.now() + ms
  while (!connected().length && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
}

/** The browser a command goes to: the one named, else the only one, else the most recent. */
export function pickController(device?: string): ControllerInfo {
  const live = connected()
  if (device) {
    const c = live.find((x) => x.device === device || x.label === device)
    if (!c) throw new BrowserError(`No browser named ${device} is connected.`, 404, 'browser_not_connected')
    return c
  }
  if (!live.length) {
    const left = lastGone()
    if (left) throw goneError(left.why)
    throw new BrowserError(
      'No browser lets agents in now: the person turns it on in the Walnut extension (popup, Settings, "Let Walnut agents use this browser").',
      409, 'browser_not_connected')
  }
  return live.sort((a, b) => (controllers.get(b.device)!.lastSeen - controllers.get(a.device)!.lastSeen))[0]
}

/** Send one command and wait for its result. */
export function send(device: string, action: string, args: Record<string, unknown>, allow: WireCommand['allow'], timeoutMs = DEFAULT_COMMAND_MS): Promise<unknown> {
  const c = controllers.get(device)
  if (!c) return Promise.reject(new BrowserError('That browser is not connected.', 409, 'browser_not_connected'))
  const id = crypto.randomUUID()
  const cmd: WireCommand = { id, action, args, allow }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      const i = c.queue.indexOf(cmd)
      if (i >= 0) c.queue.splice(i, 1)
      reject(new BrowserError(`The browser did not answer within ${Math.round(timeoutMs / 1000)} s. It may still have done it: snapshot before you try again.`, 504, 'browser_timeout'))
    }, timeoutMs)
    timer.unref?.()
    pending.set(id, { device, resolve, reject, timer, ...(typeof args.tab === 'number' ? { tab: args.tab } : {}) })
    if (c.waiter) { const w = c.waiter; c.waiter = undefined; clearTimeout(w.timer); w.resolve([cmd]) } else c.queue.push(cmd)
  })
}

// ── tabs ──

function forgetTab(k: string): void {
  tabOwners.delete(k)
  tabSetAt.delete(k)
  tabReported.delete(k)
}

export function ownTab(device: string, tabId: number, owner: string): void {
  const k = `${device}:${tabId}`
  tabOwners.set(k, owner)
  tabSetAt.set(k, Date.now())
  // Known from this answer: a report read before it may still lack the tab.
  tabReported.delete(k)
}

export function releaseTab(device: string, tabId: number): void {
  forgetTab(`${device}:${tabId}`)
}

export function tabOwner(device: string, tabId: number): string | undefined {
  return tabOwners.get(`${device}:${tabId}`)
}

export function tabsOf(device: string, owner: string): number[] {
  const out: number[] = []
  for (const [k, o] of tabOwners) if (o === owner && k.startsWith(`${device}:`)) out.push(Number(k.slice(device.length + 1)))
  return out
}

export function _resetBrowserHubForTesting(): void {
  for (const c of controllers.values()) if (c.waiter) { clearTimeout(c.waiter.timer); c.waiter.resolve([]) }
  controllers.clear()
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
  tabOwners.clear()
  tabSetAt.clear()
  tabReported.clear()
  gone.clear()
}
