/**
 * Agents in the person's own browser (core/browser-control/hub.ts):
 *
 *   POST /api/v1/browser/poll     the extension asks for work (its device token only)
 *   POST /api/v1/browser/result   the extension answers one command
 *   POST /api/v1/browser/off      the extension stopped letting agents in
 *   POST /api/v1/browser/act      an agent's command: { action, tab?, device?, ...args }
 *   GET  /api/v1/browser/status   connected browsers, the site setting, the allowed sites
 *   PUT  /api/v1/browser/settings the person's choice: { mode?, removeSite? }
 *   GET  /api/v1/browser/panel    { panel, extension: { version, build } }: the build Walnut ships
 *   POST /api/v1/browser/extension/setup { browser } → { dir, build, copied, opened }
 *
 * A site an agent has not used before asks the person first (a Walnut approval), unless they
 * let agents use any site; the act answers 202 `needs_ok` with the approval, and the same act
 * after the person approved goes through. Walnut's own pages and the browser's are never an
 * agent's (the extension refuses them as well).
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { requestOrigin } from '../middleware/request-origin.js'
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN } from '../../lib/caller-origin.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'
import { ambientTestRun } from '../../core/test-run.js'
import { log } from '../../logging/index.js'

export const browserV1Router = Router()

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name]
  return typeof v === 'string' && v ? v : undefined
}

const hub = () => import('../../core/browser-control/hub.js')

/**
 * Where Walnut itself answers, besides this machine's loopback (the extension knows that one):
 * its tunnel, the cloud companion, this Mac's LAN and Tailscale addresses. A page there is the
 * person's Walnut, so no agent opens it, whatever it serves (the app, JSON, a file).
 */
let ownCache: { at: number; list: string[] } | null = null
async function walnutAddresses(req: Request): Promise<string[]> {
  if (ownCache && Date.now() - ownCache.at < 60_000) return ownCache.list
  const out = new Set<string>()
  const add = (u: string | undefined, withPort: boolean) => {
    if (!u) return
    try { const x = new URL(u); out.add(withPort && x.port ? `${x.hostname}:${x.port}` : x.hostname) } catch { /* not a URL */ }
  }
  try {
    const { currentExposeStatus } = await import('../../core/expose/status.js')
    add(currentExposeStatus().url, false)
  } catch { /* no tunnel */ }
  try {
    const p = await import('../../core/pairing-targets.js')
    add((await p.getCloudPairingEndpointAsync())?.origin, false)
    const port = req.socket.localPort ?? 0
    for (const t of await p.getPairingTargets(`http://localhost:${port}`, port)) add(t.origin, t.kind !== 'cloud')
  } catch { /* none known */ }
  ownCache = { at: Date.now(), list: [...out].slice(0, 50) }
  return ownCache.list
}

function isWalnutAddress(list: string[], url: string): boolean {
  try {
    const u = new URL(url)
    return list.includes(u.hostname) || list.includes(`${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`)
  } catch { return false }
}
const sites = () => import('../../core/browser-control/sites.js')

async function run(res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  try {
    const out = await work()
    if (res.headersSent) return
    res.json(out)
  } catch (err) {
    const { BrowserError } = await hub()
    if (err instanceof BrowserError) { res.status(err.status).json({ error: err.message, code: err.code, ...err.extra }); return }
    next(err)
  }
}

/** The extension's own device (extension-<hex>), from its token. */
function extensionOf(req: Request, res: Response): string | null {
  const d = (req as Request & { deviceName?: string }).deviceName
  if (d && /^extension-[0-9a-f]{6}$/.test(d)) return d
  res.status(403).json({ error: 'Only the Walnut browser extension polls here, with its own token.', code: 'not_extension' })
  return null
}

/** A person's own request: no session, no agent kind, from this machine or their own browser. */
function personCaller(req: Request): boolean {
  const origin = requestOrigin(req)
  return !header(req, 'x-walnut-caller-sid') && !header(req, CALLER_KIND_HEADER) && (origin === LOCAL_ORIGIN || origin === REMOTE_HTTP_ORIGIN)
}

/** A person, not an agent: what agents may do in the browser is theirs to set. */
function personOnly(req: Request, res: Response): boolean {
  const ok = personCaller(req)
  if (!ok) res.status(403).json({ error: 'Only a person changes which sites agents may use in their browser.', code: 'human_only' })
  return ok
}

async function deviceLabel(device: string): Promise<string> {
  try {
    const { listDevices } = await import('../../core/device-auth.js')
    const d = (await listDevices()).find((x) => x.name === device) as { info?: { deviceName?: string } } | undefined
    return d?.info?.deviceName || device
  } catch { return device }
}

browserV1Router.post('/browser/poll', (req, res, next) => {
  const device = extensionOf(req, res)
  if (!device) return
  void run(res, next, async () => {
    const b = (req.body ?? {}) as { browser?: unknown; version?: unknown; caps?: unknown; tabs?: unknown; waitMs?: unknown }
    const h = await hub()
    const tabs = Array.isArray(b.tabs) ? (b.tabs as Array<{ id?: unknown; owner?: unknown }>).filter((t) => typeof t?.id === 'number' && typeof t?.owner === 'string').map((t) => ({ id: t.id as number, owner: t.owner as string })).slice(0, 200) : undefined
    const label = await deviceLabel(device)
    let gone = false
    let polling: Promise<import('../../core/browser-control/hub.js').WireCommand[]> | undefined
    res.on('close', () => { if (!res.writableFinished) { gone = true; if (polling) h.dropPoll(device, polling) } })
    // Gone before it asked: nothing is handed to it.
    if (res.destroyed || req.socket.destroyed) return undefined
    polling = h.poll({
      device,
      label,
      browser: typeof b.browser === 'string' ? b.browser.slice(0, 40) : 'browser',
      version: typeof b.version === 'string' ? b.version.slice(0, 40) : '',
      caps: Array.isArray(b.caps) ? b.caps.filter((c): c is string => typeof c === 'string').slice(0, 20) : [],
      ...(tabs ? { tabs } : {}),
    }, typeof b.waitMs === 'number' ? b.waitMs : undefined)
    const commands = await polling
    // The extension stopped listening (its background was stopped): the next poll takes them.
    if (gone) { h.requeue(device, commands); return undefined }
    return { commands }
  })
})

browserV1Router.post('/browser/result', (req, res, next) => {
  const device = extensionOf(req, res)
  if (!device) return
  void run(res, next, async () => {
    const b = (req.body ?? {}) as { id?: unknown; ok?: unknown; result?: unknown; error?: { message?: string; code?: string; extra?: Record<string, unknown> } }
    const taken = (await hub()).answer(device, String(b.id ?? ''), b.ok === true, b.result, b.error)
    return { ok: taken }
  })
})

browserV1Router.post('/browser/off', (req, res, next) => {
  const device = extensionOf(req, res)
  if (!device) return
  void run(res, next, async () => {
    (await hub()).disconnect(device)
    log.web.info('browser control off', { device })
    return { ok: true }
  })
})

browserV1Router.get('/browser/status', (_req, res, next) => {
  void run(res, next, async () => {
    const f = await (await sites()).readSites()
    return { browsers: (await hub()).connected(), mode: f.mode, sites: f.sites }
  })
})

browserV1Router.put('/browser/settings', (req, res, next) => {
  if (!personOnly(req, res)) return
  void run(res, next, async () => {
    const s = await sites()
    const b = (req.body ?? {}) as { mode?: unknown; removeSite?: unknown }
    let f = await s.readSites()
    if (b.mode === 'ask' || b.mode === 'any') f = await s.setMode(b.mode)
    if (typeof b.removeSite === 'string' && b.removeSite) f = await s.removeSite(b.removeSite)
    return { mode: f.mode, sites: f.sites }
  })
})

// ── the side panel ──

/**
 * The side panel asks whether this Walnut has it (an older one answers 404), and the extension
 * which build of it Walnut ships: a folder Walnut set up (extension-install.ts) is brought up to
 * that build first, so the extension can reload itself from it.
 */
browserV1Router.get('/browser/panel', (req, res, next) => {
  void run(res, next, async () => {
    const x = await import('../../core/browser-control/extension-install.js')
    const bundled = x.bundledExtension()
    if (bundled && !ambientTestRun()) {
      const done = await x.refreshInstalled(undefined, undefined, ownUrl(req)).catch((err: unknown) => { log.web.warn('browser extension folder refresh failed', { error: err instanceof Error ? err.message : String(err) }); return [] })
      if (done.length) log.web.info('browser extension folder brought up to this build', { browsers: done, build: bundled.build })
    }
    // `folder`: the id the marker in a folder this Walnut keeps carries (only such a copy reloads itself).
    const folder = bundled ? x.folderId() : null
    return { panel: 1, ...(bundled ? { extension: { ...bundled, ...(folder ? { folder } : {}) } } : {}) }
  })
})

/** This server as the extension on this machine reaches it. */
const ownUrl = (req: Request) => (req.socket.localPort ? `http://localhost:${req.socket.localPort}` : undefined)

/**
 * Settings, Browser extension, Set up in Chrome: the extension into its folder on this machine,
 * the folder's path copied and the browser's extensions page opened (on a Mac), so the person
 * only turns on Developer mode and picks the folder. Never in a test run: it is the person's
 * own machine and browser.
 */
browserV1Router.post('/browser/extension/setup', (req, res, next) => {
  void run(res, next, async () => {
    const h = await hub()
    if (ambientTestRun()) throw new h.BrowserError('A test run does not set up the person\'s browser.', 409, 'test_run')
    const browser = (req.body as { browser?: unknown } | undefined)?.browser
    const x = await import('../../core/browser-control/extension-install.js')
    if (browser !== 'chrome' && browser !== 'firefox') throw new h.BrowserError('browser must be chrome or firefox', 400, 'bad_request')
    if (!x.bundledExtension()) throw new h.BrowserError('This Walnut was built without the browser extension.', 404, 'no_extension_build')
    const { dir, build } = await x.installExtension(browser, undefined, undefined, ownUrl(req))
    const { copied, opened } = await x.openForSetup(browser, dir)
    log.web.info('browser extension set up', { browser, dir, build, copied, opened })
    return { dir, build, copied, opened }
  })
})

/** A page the person asks about in the side panel: its text goes into a file the ask names. */
browserV1Router.post('/browser/page', (req, res, next) => {
  void run(res, next, async () => {
    const { cleanPageText, savePageText } = await import('../../core/browser-control/page-context.js')
    const page = cleanPageText(req.body)
    if (!page) { res.status(400).json({ error: 'A web page address and its text are needed.', code: 'bad_request' }); return undefined }
    const { WALNUT_HOME } = await import('../../constants.js')
    return { file: await savePageText(page, WALNUT_HOME) }
  })
})

/**
 * The person let the ask in their side panel act in the tab they are on (their click in the
 * extension's own panel): the tab becomes that task's agent tab. Its site is allowed for that
 * tab alone (the extension holds that), never added to the sites every agent may open.
 */
browserV1Router.post('/browser/adopt', (req, res, next) => {
  const device = extensionOf(req, res)
  if (!device) return
  void run(res, next, async () => {
    const h = await hub()
    const b = (req.body ?? {}) as { tab?: unknown; task?: unknown; url?: unknown }
    const tab = typeof b.tab === 'number' && Number.isInteger(b.tab) && b.tab >= 0 ? b.tab : undefined
    const taskId = typeof b.task === 'string' ? b.task.slice(0, 100) : ''
    const url = typeof b.url === 'string' ? b.url.slice(0, 4000) : ''
    if (tab === undefined || !taskId) throw new h.BrowserError('A tab and a task are needed.', 400, 'bad_request')
    const { getTask } = await import('../../core/task-manager.js')
    if (!(await getTask(taskId).catch(() => null))) throw new h.BrowserError('No such task.', 404, 'task_not_found')
    const s = await sites()
    const site = s.siteOf(url)
    if (!site) throw new h.BrowserError('Agents use web pages only (http or https).', 400, 'not_a_web_page')
    if (isWalnutAddress(await walnutAddresses(req), url)) throw new h.BrowserError('Agents never use Walnut\'s own pages in the browser.', 403, 'walnut_page')
    const owner = `task:${taskId}`
    h.ownTab(device, tab, owner)
    handed.set(tabKey(device, tab), { owner, site })
    lastTab.set(owner, { device, tab })
    log.web.info('browser tab adopted', { device, tab, owner, site })
    return { ok: true, tab, site }
  })
})

// ── an agent's command ──

const ACTIONS = [
  'tabs', 'open', 'navigate', 'back', 'close', 'snapshot', 'text', 'find', 'form_values', 'click', 'hover', 'type', 'fill_form', 'select', 'press',
  'scroll', 'wait', 'screenshot', 'upload', 'downloads', 'take', 'fill_login', 'dialog', 'evaluate',
] as const
type Action = typeof ACTIONS[number]
/** Actions that go to a page, so the page's site must be allowed. */
const ON_TAB = new Set<Action>([
  'navigate', 'back', 'close', 'snapshot', 'text', 'find', 'form_values', 'click', 'hover', 'type', 'fill_form', 'select', 'press', 'scroll', 'wait',
  'screenshot', 'upload', 'fill_login', 'dialog', 'evaluate',
])
/** Actions whose step may buy, send or delete (the page judges; outward-asks.ts asks the person). */
const OUTWARD_ACTS = new Set<Action>(['click', 'press', 'type'])
/** Actions the extension answers for the owner as a whole (its tabs, its downloads, a tab to take). */
const FOR_OWNER = new Set<Action>(['tabs', 'downloads', 'take'])
const TIMEOUT: Partial<Record<Action, number>> = { open: 45_000, navigate: 45_000, back: 30_000, wait: 40_000, screenshot: 30_000, downloads: 40_000, take: 30_000 }
/** A full-page screenshot scrolls through the page, two captures a second. */
const FULL_SCREENSHOT_MS = 50_000
/** The tab each owner used last, so `tab` may be left out. */
const lastTab = new Map<string, { device: string; tab: number }>()
/**
 * The tabs the person handed over from the side panel, and the site each was on: an agent may go
 * on in that site in that tab with no ask (the extension allows it there alone too), while the
 * tab is still the task's.
 */
const handed = new Map<string, { owner: string; site: string }>()
const tabKey = (device: string, tab: number) => `${device}\0${tab}`
/** A site an owner asked the person for, until it is decided. */
const siteAsks = new Map<string, string>()
/** A site the person refused an owner, until when. */
const siteDenied = new Map<string, number>()

/**
 * The site is allowed, or the person is asked: approved → allowed from now on (and this act
 * goes through); still pending → the same ask again (held up to `wait_ms` for the answer);
 * denied → refused, and not asked again for an hour.
 */
async function siteGate(req: Request, owner: string, url: string, holdMs: number): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  const s = await sites()
  const site = s.siteOf(url)
  if (!site) return { ok: false, status: 400, body: { error: 'Agents use web pages only (http or https).', code: 'not_a_web_page' } }
  if (s.isAllowed(await s.readSites(), url)) return { ok: true }
  const key = `${owner}\0${site}`
  const denied = { ok: false as const, status: 403, body: { error: `The person did not let agents use ${site}. Do not ask again unless they say so.`, code: 'site_denied', site } }
  if ((siteDenied.get(key) ?? 0) > Date.now()) return denied
  const store = await import('../../core/approvals/store.js')
  let id = siteAsks.get(key)
  let a = id ? await store.getApproval(id) : undefined
  if (!a || (a.status !== 'pending' && a.status !== 'approved' && a.status !== 'denied')) {
    const { requesterOf } = await import('./approvals-v1.js')
    const requester = await requesterOf(req, (req.body ?? {}) as Record<string, unknown>)
    const made = await store.createApproval({
      what: `Let Walnut agents use ${site} in your browser?`,
      detail: `${requester.taskTitle ? `"${requester.taskTitle}" wants to open ${url}` : `An agent wants to open ${url}`} in the Walnut agent window of your browser. `
        + `Approve once and agents may use ${site} until you remove it in Settings, Browser extension.`,
      mode: 'tap', timeoutMs: 10 * 60_000, requester, testRun: ambientTestRun(),
    })
    id = made.approval.id
    siteAsks.set(key, id)
    a = await store.getApproval(id)
  }
  // The asker may hold for the answer (wait_ms), a second at a time.
  const until = Date.now() + Math.max(0, Math.min(holdMs, Number((req.body as { wait_ms?: unknown } | undefined)?.wait_ms) || 0))
  while (a?.status === 'pending' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000))
    a = await store.getApproval(id!)
  }
  // This call hands the agent the answer itself: its session needs no note about it (tell-asker.ts).
  if (a && (a.status === 'approved' || a.status === 'denied')) await store.noteAskerRead(a.id)
  if (a?.status === 'approved') {
    siteAsks.delete(key)
    await s.allowSite(site, `approval:${id}`)
    return { ok: true }
  }
  if (a?.status === 'denied') {
    siteAsks.delete(key)
    siteDenied.set(key, Date.now() + 60 * 60_000)
    return denied
  }
  return { ok: false, status: 202, body: needsOk(site, id!) }
}

function needsOk(site: string, approvalId: string): Record<string, unknown> {
  return {
    status: 'needs_ok', site, approvalId,
    error: `Waiting for the person to let agents use ${site} (a notification on their Mac and phone).`,
    code: 'site_needs_ok',
  }
}

/** The whole act answers within this, under the op's own 75 s. */
const ACT_BUDGET_MS = 70_000

browserV1Router.post('/browser/act', (req, res, next) => {
  void run(res, next, async () => {
    const deadline = Date.now() + ACT_BUDGET_MS
    const left = () => deadline - Date.now()
    const b = (req.body ?? {}) as Record<string, unknown>
    const action = String(b.action ?? '') as Action
    const h = await hub()
    if (!ACTIONS.includes(action)) throw new h.BrowserError(`Unknown action "${action}". One of: ${ACTIONS.join(', ')}.`, 400, 'bad_action')
    // What a test run does must stay inside Walnut: the person's browser is not.
    if (ambientTestRun()) throw new h.BrowserError('A test run does not use the person\'s browser.', 409, 'test_run')
    const { requesterOf } = await import('./approvals-v1.js')
    const requester = await requesterOf(req, b)
    // A task's tabs are its own; a caller Walnut cannot place (a script, an agent outside a
    // task) shares one set of tabs apart from the person's own.
    const owner = requester.taskId ? `task:${requester.taskId}` : requester.sessionId ? `session:${requester.sessionId}`
      : personCaller(req) ? 'person' : 'agent'
    const s = await sites()
    const args = (await import('../../core/browser-control/act-args.js')).cleanArgs(b)

    let tab: number | undefined = typeof b.tab === 'number' ? b.tab : typeof b.tab === 'string' && /^\d+$/.test(b.tab) ? Number(b.tab) : undefined
    // A tab is in one browser: its commands go there, whichever browser polled last.
    const last = lastTab.get(owner)
    const live = new Set(h.connected().map((x) => x.device))
    const lastHolds = !!last && live.has(last.device) && h.tabOwner(last.device, tab ?? last.tab) === owner
    const held = typeof b.device === 'string' ? undefined
      : lastHolds ? last!.device
        : ON_TAB.has(action) || action === 'tabs' || action === 'downloads' ? h.deviceForTab(owner, action === 'downloads' ? undefined : tab) : undefined
    if (!h.connected().length) await h.waitConnected(3000)
    const c = h.pickController(typeof b.device === 'string' ? b.device : held)
    if (ON_TAB.has(action)) {
      if (tab === undefined) {
        const mine = h.tabsOf(c.device, owner)
        tab = last && last.device === c.device && mine.includes(last.tab) ? last.tab : mine.length === 1 ? mine[0] : undefined
        if (tab === undefined) {
          throw new h.BrowserError(mine.length ? `Say which tab: ${mine.join(', ')}.` : 'Open a page first (action "open"): agents act only in tabs they opened.', 400, 'which_tab', { tabs: mine })
        }
      }
      const o = h.tabOwner(c.device, tab)
      if (o !== owner) throw new h.BrowserError(o ? 'That tab belongs to another task.' : 'That tab is not one an agent opened (or the person took it back with Stop).', 403, 'not_your_tab')
      args.tab = tab
    }
    const own = await walnutAddresses(req)
    if ((action === 'open' || action === 'navigate') && typeof args.url === 'string') {
      if (isWalnutAddress(own, args.url)) throw new h.BrowserError('Agents never use Walnut\'s own pages in the browser: use Walnut\'s ops instead.', 403, 'walnut_page')
      const given = tab !== undefined ? handed.get(tabKey(c.device, tab)) : undefined
      const inHanded = action === 'navigate' && given?.owner === owner && given.site === s.siteOf(args.url)
      if (!inHanded) {
        const g = await siteGate(req, owner, args.url, Math.min(25_000, left() - 45_000))
        if (!g.ok) { res.status(g.status).json(g.body); return undefined }
      }
    }
    if (action === 'take') {
      if (tab === undefined) throw new h.BrowserError('Say which tab to take (tabs with all lists them).', 400, 'which_tab')
      args.tab = tab
    }
    if (action === 'open' || action === 'take') { if (requester.taskTitle) args.who = requester.taskTitle.slice(0, 80) }
    if (action === 'open' || FOR_OWNER.has(action)) args.owner = owner

    let f = await s.readSites()
    if (action === 'fill_login') return fillLoginAct(req, res, b, { device: c.device, label: c.label, owner, tab: tab!, requester, allow: { ...s.allowOf(f), walnut: own } })
    // A step that buys, sends or deletes the person approved: it goes to the page with the approval's mark.
    const outward = await import('../../core/browser-control/outward-asks.js')
    if (OUTWARD_ACTS.has(action) && typeof b.request === 'string' && b.request && tab !== undefined) {
      const holdMs = Math.max(0, Math.min(25_000, Number(b.wait_ms) || 0, left() - 40_000))
      const o = await outward.answerOutward({ id: b.request.slice(0, 100), owner, tab, action, args, holdMs })
      if (!o.ok) { res.status(o.status).json(o.body); return undefined }
      args.outward_ok = o.sig
    }
    const go = () => {
      const ms = Math.min(action === 'screenshot' && args.full === true ? FULL_SCREENSHOT_MS : TIMEOUT[action] ?? h.DEFAULT_COMMAND_MS, left())
      if (ms < 5000) throw new h.BrowserError('Out of time for this call: call it again.', 504, 'browser_timeout')
      return h.send(c.device, action, args, { ...s.allowOf(f), walnut: own }, ms)
    }
    // The page held a step that buys, sends or deletes: the person is asked (outward-asks.ts).
    const askIfHeld = async (err: unknown): Promise<Record<string, unknown> | null> => {
      const hold = err instanceof h.BrowserError && err.code === 'outward_needs_ok' && tab !== undefined ? outward.holdOf(err.extra) : null
      if (!hold) return null
      log.web.info('browser act waits for the person', { action, device: c.device, owner, tab, kind: hold.kind })
      return outward.askOutward({ owner, tab: tab!, action, args, hold, requester, testRun: ambientTestRun() })
    }
    let result: unknown
    try {
      result = await go()
    } catch (err) {
      const ask = await askIfHeld(err)
      if (ask) { res.status(202).json(ask); return undefined }
      // The page went to a site not allowed yet (a link, a redirect): ask, as for an open.
      if (err instanceof h.BrowserError && err.code === 'site_not_allowed' && typeof err.extra.url === 'string') {
        const g = await siteGate(req, owner, err.extra.url, 0)
        if (!g.ok) { res.status(g.status).json(g.body); return undefined }
        f = await s.readSites()
        try { result = await go() } catch (again) {
          const ask2 = await askIfHeld(again)
          if (ask2) { res.status(202).json(ask2); return undefined }
          throw again
        }
      } else throw err
    }
    const r = (result ?? {}) as { tab?: number; tabs?: Array<{ id: number; owner?: string }>; released?: boolean; opened?: { tab?: unknown } }
    if ((action === 'open' || action === 'take') && typeof r.tab === 'number') h.ownTab(c.device, r.tab, owner)
    if (action === 'close' && tab !== undefined) { h.releaseTab(c.device, tab); handed.delete(tabKey(c.device, tab)) }
    // A tab the agent's tab opened (a link to a new tab, a popup window) is the same agent's.
    if (typeof r.opened?.tab === 'number') h.ownTab(c.device, r.opened.tab, owner)
    const used = action === 'open' || action === 'take' ? r.tab : tab
    if (typeof used === 'number' && action !== 'close') lastTab.set(owner, { device: c.device, tab: used })
    log.web.info('browser act', { action, device: c.device, owner, tab: used })
    if (action === 'tabs') {
      const all = Array.isArray(r.tabs) ? r.tabs : []
      for (const t of all) if (t.owner === owner && h.tabOwner(c.device, t.id) !== owner) h.ownTab(c.device, t.id, owner)
      // Every tab of the browser: whose each is, never another task's key.
      if (args.all === true) return { browser: c.label, all: true, tabs: all.map(({ owner: o, ...t }) => ({ ...t, owner: o === owner ? 'mine' : o ? 'other task' : 'person' })) }
      return { browser: c.label, tabs: all.filter((t) => t.owner === owner).map(({ owner: _o, ...t }) => t) }
    }
    return { browser: c.label, ...(r as Record<string, unknown>) }
  })
})

/**
 * `fill_login`: the vault decides (core/browser-control/fill-login.ts); the login goes to the
 * extension alone and is never logged or answered. A vault refusal answers as password_use does.
 */
async function fillLoginAct(req: Request, res: Response, b: Record<string, unknown>, at: {
  device: string; label: string; owner: string; tab: number; requester: import('../../core/vault/agent.js').AgentRequester
  allow: import('../../core/browser-control/hub.js').WireCommand['allow']
}): Promise<unknown> {
  const h = await hub()
  const { isFollower, role } = await import('../../core/server-role.js')
  if (role() !== 'leader' || isFollower()) throw new h.BrowserError('Passwords are kept on the Mac, which does not answer right now.', 503, 'vault_not_here')
  const v = await import('./vault-agent-v1.js')
  const { fillLogin } = await import('../../core/browser-control/fill-login.js')
  const { VaultError } = await import('../../core/vault/store.js')
  const { ApprovalError } = await import('../../core/approvals/store.js')
  const str = (x: unknown, n: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : undefined)
  try {
    const out = await fillLogin({
      owner: at.owner, tab: at.tab, item: str(b.item, 200), request: str(b.request, 100), purpose: str(b.purpose, 200),
      waitMs: Math.max(0, Math.min(25_000, Number(b.wait_ms) || 0)), requester: at.requester, testRun: ambientTestRun(),
    }, {
      send: (action, args, ms) => h.send(at.device, action, args, at.allow, ms),
      agents: v.agentsSwitch, createApproval: v.createApproval, waitApproval: v.waitApproval,
    })
    log.web.info('browser act', { action: 'fill_login', device: at.device, owner: at.owner, tab: at.tab, status: out.status })
    lastTab.set(at.owner, { device: at.device, tab: at.tab })
    if (out.status === 202) { res.status(202).json(out.body); return undefined }
    return { browser: at.label, ...out.body }
  } catch (err) {
    if (err instanceof VaultError || err instanceof ApprovalError) throw new h.BrowserError(err.message, err.status, err.code)
    throw err
  }
}

export function _resetBrowserRoutesForTesting(): void {
  ownCache = null
  lastTab.clear()
  siteAsks.clear()
  siteDenied.clear()
  handed.clear()
}
