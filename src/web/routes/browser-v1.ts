/**
 * Agents in the person's own browser (core/browser-control/hub.ts):
 *
 *   POST /api/v1/browser/poll     the extension asks for work (its device token only)
 *   POST /api/v1/browser/result   the extension answers one command
 *   POST /api/v1/browser/off      the extension stopped letting agents in
 *   POST /api/v1/browser/act      an agent's command: { action, tab?, device?, ...args }
 *   GET  /api/v1/browser/status   connected browsers, the site setting, the allowed sites
 *   PUT  /api/v1/browser/settings the person's choice: { mode?, removeSite? }
 *   GET  /api/v1/browser/panel    { panel, askPanel, extension: { version, build } }: the build Walnut ships
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
import { startTabTidy, _stopTabTidyForTesting, type TidyDeps } from './browser-tab-tidy.js'
import { openAsk } from '../../core/browser-control/sign-in-ask.js'
import { onCredentialsRevoked } from '../../core/device-auth.js'
import { mountBrowserView, _resetBrowserViewForTesting } from './browser-view-v1.js'
import { missingIsNull } from '../../lib/id-ref.js'

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
  // A browser is here: Walnut tidies the tabs tasks no longer use (browser-tab-tidy.ts).
  startTabTidy(tidyDeps)
  void run(res, next, async () => {
    const b = (req.body ?? {}) as { browser?: unknown; version?: unknown; caps?: unknown; tabs?: unknown; waitMs?: unknown }
    const h = await hub()
    // Each agent tab, who holds it, and where it is (address, title, window: the task's Browser view; hub.ts cuts them to size).
    const tabs = Array.isArray(b.tabs) ? (b.tabs as Array<{ id?: unknown; owner?: unknown; grant?: unknown; url?: unknown; title?: unknown; window?: unknown; windowState?: unknown; driving?: unknown }>)
      .filter((t) => typeof t?.id === 'number' && typeof t?.owner === 'string')
      .map((t) => ({
        id: t.id as number, owner: t.owner as string,
        ...(typeof t.grant === 'string' ? { grant: t.grant } : {}),
        ...(typeof t.url === 'string' ? { url: t.url } : {}),
        ...(typeof t.title === 'string' ? { title: t.title } : {}),
        ...(t.window === 'agent' || t.window === 'person' ? { window: t.window as 'agent' | 'person' } : {}),
        ...(typeof t.windowState === 'string' ? { windowState: t.windowState } : {}),
        ...(t.driving === true ? { driving: true } : {}),
      })).slice(0, 200) : undefined
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

// A device removed (the extension's Disconnect, Settings, `walnut device revoke`): its browser is
// gone at once, and an agent's next command says the person disconnected it (no wait for a poll).
onCredentialsRevoked((names) => {
  void hub().then((h) => { for (const n of names) h.disconnect(n, 'disconnected') }).catch(() => undefined)
})

browserV1Router.post('/browser/off', (req, res, next) => {
  const device = extensionOf(req, res)
  if (!device) return
  void run(res, next, async () => {
    // `why: disconnected`: the extension is about to forget this Walnut (its Disconnect).
    const why = (req.body as { why?: unknown } | undefined)?.why === 'disconnected' ? 'disconnected' : 'off'
    ;(await hub()).disconnect(device, why)
    log.web.info('browser control off', { device, why })
    return { ok: true }
  })
})

browserV1Router.get('/browser/status', (_req, res, next) => {
  void run(res, next, async () => {
    const f = await (await sites()).readSites()
    const h = await hub()
    const left = h.lastGone()
    return { browsers: h.connected(), mode: f.mode, sites: f.sites, ...(left ? { gone: { label: left.label, at: new Date(left.at).toISOString(), why: left.why } } : {}) }
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
 * that build first, so the extension can reload itself from it. `askPanel: 2`: the panel view
 * opens as Walnut's own Ask (its drawer of asks, the key button the extension draws its vault
 * popover for), and the toolbar popup opens on it too; an extension that sees no such field keeps
 * its older panel (Ask, Tasks and Passwords tabs) and its vault popup.
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
    return { panel: 1, askPanel: 2, ...(bundled ? { extension: { ...bundled, ...(folder ? { folder } : {}) } } : {}) }
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
    if (!(await getTask(taskId).catch(missingIsNull))) throw new h.BrowserError('No such task.', 404, 'task_not_found')
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

export const ACTIONS = [
  'tabs', 'open', 'navigate', 'back', 'close', 'snapshot', 'text', 'find', 'form_values', 'click', 'hover', 'type', 'fill_form', 'select', 'press',
  'scroll', 'wait', 'screenshot', 'upload', 'downloads', 'take', 'fill_login', 'fill_code', 'dialog', 'evaluate',
  'network', 'network_body', 'network_request_body', 'console', 'resize', 'request_sign_in', 'drag', 'zoom', 'click_label',
] as const
type Action = typeof ACTIONS[number]
/** Actions that go to a page, so the page's site must be allowed. */
export const ON_TAB = new Set<Action>([
  'navigate', 'back', 'close', 'snapshot', 'text', 'find', 'form_values', 'click', 'hover', 'type', 'fill_form', 'select', 'press', 'scroll', 'wait',
  'screenshot', 'upload', 'fill_login', 'fill_code', 'dialog', 'evaluate', 'network', 'network_body', 'network_request_body', 'console', 'resize', 'request_sign_in',
  'drag', 'zoom', 'click_label',
])
/** Actions whose step may buy, send or delete (the page judges; outward-asks.ts asks the person): a drag's press and release, a dialog's OK too. */
const OUTWARD_ACTS = new Set<Action>(['click', 'press', 'type', 'drag', 'dialog'])
/** Actions the extension answers for the owner as a whole (its tabs, its downloads, a tab to take). */
export const FOR_OWNER = new Set<Action>(['tabs', 'downloads', 'take'])
const TIMEOUT: Partial<Record<Action, number>> = { open: 45_000, navigate: 45_000, back: 30_000, wait: 40_000, screenshot: 30_000, zoom: 30_000, downloads: 40_000, take: 30_000, network_body: 30_000, network_request_body: 30_000 }
/** A full-page screenshot scrolls through the page, two captures a second. */
const FULL_SCREENSHOT_MS = 50_000
/** The tab each owner used last: the browser its next command goes to (never which tab: tab-words.ts). */
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
    let b = (req.body ?? {}) as Record<string, unknown>
    const h = await hub()
    if (!ACTIONS.includes(String(b.action ?? '') as Action)) throw new h.BrowserError(`Unknown action "${String(b.action ?? '')}". One of: ${ACTIONS.join(', ')}.`, 400, 'bad_action')
    // A number from an annotated screenshot is a click on its element: the same click everywhere (an ask for the person's yes included).
    if (b.action === 'click_label') {
      if (typeof b.label !== 'number' || !Number.isInteger(b.label) || b.label < 1) throw new h.BrowserError('click_label takes label: a number from screenshot with annotate.', 400, 'bad_request')
      b = { ...b, action: 'click' }
    }
    const action = String(b.action) as Action
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
      const tw = await import('../../core/browser-control/tab-words.js')
      if (tab === undefined) {
        // Never a guess (the tab used last was another executor's: tab-words.ts): the task's only
        // tab, else the task's tabs listed, in every connected browser.
        const mine = h.viewOf(owner).tabs.filter((t) => t.connected && (typeof b.device !== 'string' || t.device === c.device))
        if (mine.length > 1) throw new h.BrowserError(tw.whichTabWords(mine), 400, 'which_tab', { tabs: mine.map((t) => t.tab) })
        tab = tw.defaultTab(h.tabsOf(c.device, owner))
        if (tab === undefined) throw new h.BrowserError('Open a page first (action "open"): agents act only in tabs they opened.', 400, 'which_tab', { tabs: [] })
      }
      const o = h.tabOwner(c.device, tab)
      if (o !== owner) throw new h.BrowserError(o ? 'That tab belongs to another task: tabs lists yours, open <url> starts a new one.' : tw.notYourTabWords(tab, h.tabEndOf(c.device, tab), owner), 403, 'not_your_tab')
      args.tab = tab
    }
    // What an older extension would get wrong is refused before it reaches it (input-v2.ts).
    const v2 = await import('../../core/browser-control/input-v2.js')
    const needs = v2.needsInputV2(action, args)
    if (needs && !h.hasCap(c.device, v2.INPUT_V2)) throw new h.BrowserError(v2.outdatedWords(needs, c.label), 409, 'extension_outdated', { needs })
    // The person signs in themselves (Take over in the task's Browser view), the agent waits: never a request to the page.
    if (action === 'request_sign_in') return signInAct(res, b, { device: c.device, label: c.label, owner, tab: tab!, left: left() })
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
    const w = await import('../../core/browser-control/where-words.js')
    // A sign-in on a site the person already has open in a tab of their own: never a second one
    // behind their back (2026-11-07). Only the person lets one go ahead: their own request, or their
    // yes on the ask an agent's fresh_sign_in starts (fresh-sign-in.ts). A check that cannot be made
    // refuses, never lets it through (review 2026-11-07: a failed tab list skipped it).
    let freshClaim: import('../../core/browser-control/fresh-sign-in.js').Claim | undefined
    let codeClaim: import('../../core/browser-control/fresh-sign-in.js').Claim | undefined
    // The ask's id was this rule's, not the vault's: it is not passed on (decided before answering it removes it).
    let freshAskHandled = false
    // The site the same-site check judged: the fill refuses a page that moved off it meanwhile.
    let checkedSite: string | undefined
    // A one-time code (fill_code) is a step of a sign-in: the same rule.
    if (action === 'fill_login' || action === 'fill_code') {
      const fresh = await import('../../core/browser-control/fresh-sign-in.js')
      const retry = (why: string) => new h.BrowserError(`Walnut could not check whether the person has this site open in a tab of their own (${why}), so it fills nothing yet. Call ${action} again in a moment.`, 503, 'same_site_unchecked')
      if (left() < 15_000) throw retry('no time left in this call')
      const listing = await allTabsOf(c.device, owner, { ...s.allowOf(f), walnut: own })
      // Agents only in the tab the person handed over: they hand it over in front of them, and see the sign-in there.
      const handedOnly = 'error' in listing && listing.error === 'agents_tab_only' && handed.has(tabKey(c.device, tab!))
      if ('error' in listing && !handedOnly) throw retry(listing.error)
      const all = 'tabs' in listing ? listing.tabs : []
      const mine = all.find((t) => t.id === tab)
      if (!handedOnly && (!mine || typeof mine.url !== 'string')) throw retry('the browser did not list this tab')
      const theirs = mine && typeof mine.url === 'string' ? w.sameSiteTabs(all, mine.url) : []
      if (mine && typeof mine.url === 'string') checkedSite = w.siteOf(mine.url) || undefined
      // A sign-in step: the next open of this site tells the person's tabs in full again.
      if (checkedSite) w.forgetPersonTabsNote({ owner, device: c.device }, checkedSite)
      if (theirs.length && !personCaller(req)) {
        const site = w.siteOf(mine!.url!)
        const scope = { owner, device: c.device, tab: tab!, site }
        const request = typeof b.request === 'string' ? b.request : undefined
        if (request && fresh.isFreshAsk(request)) {
          freshAskHandled = true
          const ans = await fresh.answerFreshSignIn({ ...scope, id: request, holdMs: Math.max(0, Math.min(25_000, Number(b.wait_ms) || 0)) })
          if (!ans.ok) { if (ans.status === 202) { res.status(202).json(ans.body); return undefined } throw new h.BrowserError(String(ans.body.error), ans.status, String(ans.body.code)) }
        }
        // A code right after the sign-in the person said yes to is part of it (fresh-sign-in.ts codeStepAfter).
        if (action === 'fill_code') codeClaim = fresh.claimCodeStep(scope)
        if (!codeClaim) freshClaim = fresh.claimGrant(scope)
        if (!freshClaim && !codeClaim) {
          if (b.fresh_sign_in === true) {
            log.web.info('browser fill_login asks the person for a new sign-in', { device: c.device, owner, tab, tabs: theirs.map((t) => t.id) })
            res.status(202).json(await fresh.askFreshSignIn({ ...scope, theirs, requester, testRun: ambientTestRun() }))
            return undefined
          }
          log.web.info('browser fill_login refused: the person has the site open', { device: c.device, owner, tab, tabs: theirs.map((t) => t.id) })
          throw new h.BrowserError(w.signInRefusal(site, theirs), 409, 'site_open_in_person_tab', { site, person_tabs: theirs })
        }
      }
    }
    if (action === 'fill_login' || action === 'fill_code') {
      // The vault's own ask has its own request: the new-sign-in ask's id is not passed on.
      const fresh = await import('../../core/browser-control/fresh-sign-in.js')
      let vb: Record<string, unknown> = freshAskHandled ? { ...b, request: undefined } : b
      // A code step is for the login its sign-in filled, and no other, whatever item names.
      const stepItem = codeClaim ? fresh.codeStepItem(codeClaim) : undefined
      if (stepItem) vb = { ...vb, item: stepItem }
      let out: unknown
      try {
        out = await fillLoginAct(req, res, vb, { device: c.device, label: c.label, owner, tab: tab!, requester, allow: { ...s.allowOf(f), walnut: own }, site: checkedSite, what: action === 'fill_code' ? 'code' : 'login' })
      } catch (err) {
        // A refusal before anything reached the page gives the yes back; a browser that did not
        // answer may have filled, so its yes is spent.
        if (err instanceof h.BrowserError && err.status < 500 && err.code !== 'browser_timeout') {
          if (freshClaim) fresh.restoreGrant(freshClaim)
          if (codeClaim) fresh.restoreCodeStep(codeClaim)
        }
        throw err
      }
      const filled = !!(out as { filled?: unknown } | undefined)?.filled
      // Still waiting (the vault asks about the login itself): the yes waits with it.
      if (freshClaim && !filled) fresh.restoreGrant(freshClaim)
      if (codeClaim && !filled) fresh.restoreCodeStep(codeClaim)
      // A sign-in filled with the person's yes: its one-time code may follow without a second ask.
      if (freshClaim && filled && action === 'fill_login') fresh.codeStepAfter(freshClaim, String((out as { item?: { id?: unknown } }).item?.id ?? '') || undefined)
      return out
    }
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
    // The person's own tabs on the site this open or navigate goes to, read before it goes (the
    // answer names them, so the agent asks for that tab instead of signing in again).
    const theirs = (action === 'open' || action === 'navigate') && typeof args.url === 'string' && left() > 55_000
      ? await allTabsOf(c.device, owner, { ...s.allowOf(f), walnut: own }, 6000).then((l) => ('tabs' in l ? w.sameSiteTabs(l.tabs, String(args.url)) : undefined))
      : undefined
    // A close ends the tab for the agent: so says the view, also when the browser's report comes in first.
    const undoEnd = action === 'close' && tab !== undefined
      ? h.endingTab(c.device, tab, handed.has(tabKey(c.device, tab)) || h.viewOf(owner).tabs.find((t) => t.tab === tab && t.device === c.device)?.window === 'person' ? 'given_back' : 'closed')
      : undefined
    let result: unknown
    // In use from the moment it is sent, so the tidy-up never takes a tab a command is on its way to.
    if (typeof tab === 'number') h.noteActed(c.device, tab)
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
      } else { undoEnd?.(); throw err }
    }
    const r = (result ?? {}) as { tab?: number; url?: string; title?: string; window?: 'agent' | 'person'; windowState?: string; tabs?: Array<{ id: number; owner?: string; url?: string; title?: string }>; released?: boolean; opened?: { tab?: unknown; url?: unknown } }
    const facts = { url: r.url, title: r.title, window: r.window, windowState: r.windowState }
    if ((action === 'open' || action === 'take') && typeof r.tab === 'number') h.ownTab(c.device, r.tab, owner, { ...facts, window: r.window ?? (action === 'open' ? 'agent' : 'person') })
    if (action === 'close' && tab !== undefined) { h.releaseTab(c.device, tab, r.released ? 'given_back' : 'closed'); handed.delete(tabKey(c.device, tab)) }
    // A tab the agent's tab opened (a link to a new tab, a popup window) is the same agent's.
    if (typeof r.opened?.tab === 'number') h.ownTab(c.device, r.opened.tab, owner, typeof r.opened.url === 'string' ? { url: r.opened.url } : undefined)
    const used = action === 'open' || action === 'take' ? r.tab : tab
    if (typeof used === 'number' && action !== 'close') {
      lastTab.set(owner, { device: c.device, tab: used })
      h.noteActed(c.device, used)
      if (action !== 'open' && action !== 'take' && typeof r.url === 'string') h.noteTab(c.device, used, facts)
    }
    log.web.info('browser act', { action, device: c.device, owner, tab: used })
    // Which window and tab, every time it may have changed; and the person's own tabs on the site.
    const extra: Record<string, unknown> = {}
    if (WHERE_ACTS.has(action) && typeof r.tab === 'number') extra.where = w.whereLine(action, r)
    // A sign-in page that refuses this browser (Google's "may not be secure"): the person signs in, not a retry.
    const refusal = (await import('../../core/browser-control/sign-in-refusal.js')).signInRefusalOf(r as Record<string, unknown>)
    if (refusal) { extra.hand_off = refusal; log.web.info('browser act met a sign-in refusal', { action, device: c.device, owner, tab: used, why: refusal.why }) }
    if (theirs?.length) { extra.person_tabs = theirs; extra.person_tabs_note = w.personTabsNoteFor({ owner, device: c.device }, w.siteOf(String(args.url)), theirs) }
    // `read_text`: the page's main text in the same call (a read takes 3 to 5 calls: open --read,
    // click --read, close). A tab the step opened is the one read; a page holding a dialog open
    // answers nothing until it is handled, so it is not read.
    if (b.read_text === true && READ_AFTER.has(action) && !(r as Record<string, unknown>).dialog) {
      const readTab = typeof r.opened?.tab === 'number' ? r.opened.tab : used
      if (typeof readTab === 'number') extra.page_text = await readAfter(c.device, readTab, owner, typeof args.max === 'number' ? args.max : undefined, { ...s.allowOf(f), walnut: own }, left())
    }
    if (action === 'tabs') {
      const all = Array.isArray(r.tabs) ? r.tabs : []
      for (const t of all) if (t.owner === owner && h.tabOwner(c.device, t.id) !== owner) h.ownTab(c.device, t.id, owner)
      // Every tab of the browser: whose each is, never another task's key.
      if (args.all === true) return { browser: c.label, all: true, tabs: all.map(({ owner: o, ...t }) => ({ ...t, owner: o === owner ? 'mine' : o ? 'other task' : 'person' })) }
      return { browser: c.label, tabs: all.filter((t) => t.owner === owner).map(({ owner: _o, ...t }) => t) }
    }
    return { browser: c.label, ...(r as Record<string, unknown>), ...extra }
  })
})

/**
 * `request_sign_in {tab, text?}`: the person signs in themselves (core/browser-control/sign-in-ask.ts).
 * The ask shows on the task's Browser view; the call holds up to `wait_ms` and answers `needs_ok`
 * with the ask's `request` while they have not handed the tab back, then `done` (or `stopped`).
 */
async function signInAct(res: Response, b: Record<string, unknown>, at: { device: string; label: string; owner: string; tab: number; left: number }): Promise<unknown> {
  const h = await hub()
  // The person answers through Take over and Done: an older extension has neither.
  if (!h.hasCap(at.device, 'takeover')) {
    throw new h.BrowserError('This browser\'s Walnut extension is older than the sign-in hand-off: ask the person in your chat to sign in on that tab themselves and to tell you when they are done (or to update the extension).', 409, 'old_extension')
  }
  const si = await import('../../core/browser-control/sign-in-ask.js')
  const w = await import('../../core/browser-control/where-words.js')
  const id = typeof b.request === 'string' ? b.request.slice(0, 100) : ''
  let a = id ? si.getAsk(id) : undefined
  if (a && (a.owner !== at.owner || a.device !== at.device || a.tab !== at.tab)) a = undefined
  if (!a) {
    const facts = h.viewOf(at.owner).tabs.find((t) => t.device === at.device && t.tab === at.tab)
    const note = typeof b.text === 'string' && b.text.trim() ? b.text.trim().slice(0, 300) : undefined
    const site = (typeof b.site === 'string' && b.site.trim() ? b.site.trim().slice(0, 200) : undefined) ?? (facts?.url ? w.siteOf(facts.url) || undefined : undefined)
    a = si.askSignIn({ owner: at.owner, device: at.device, tab: at.tab, ...(site ? { site } : {}), ...(note ? { note } : {}) })
    h.ownerChanged(at.owner)
    log.web.info('browser asks the person to sign in', { device: at.device, owner: at.owner, tab: at.tab, site })
  }
  const hold = Math.max(0, Math.min(25_000, Number(b.wait_ms) || 0, at.left - 5000))
  const now = await si.waitSignIn(a.id, hold) ?? a
  lastTab.set(at.owner, { device: at.device, tab: at.tab })
  if (now.end) {
    const facts = h.viewOf(at.owner).tabs.find((t) => t.device === at.device && t.tab === at.tab)
    return { browser: at.label, tab: at.tab, signIn: now.end.why, ...(now.end.why === 'done' ? { done: true } : {}), ...(facts ? { url: facts.url, title: facts.title } : {}) }
  }
  res.status(202).json({
    status: 'needs_ok', code: 'sign_in_waiting', request: now.id, tab: at.tab, ...(now.site ? { site: now.site } : {}),
    error: `Waiting for the person to sign in${now.site ? ` to ${now.site}` : ''} themselves: the task's Browser view asks them (Take over, sign in, Done)`,
  })
  return undefined
}

/** Actions that may read the page's text right after (`read_text`). */
const READ_AFTER = new Set<Action>(['open', 'navigate', 'back', 'take', 'click', 'press', 'type', 'select', 'fill_form', 'scroll', 'hover'])

/** The page's main text after a step, or why it could not be read (the step itself went through). */
async function readAfter(device: string, tab: number, owner: string, max: number | undefined, allow: import('../../core/browser-control/hub.js').WireCommand['allow'], left: number): Promise<Record<string, unknown>> {
  const h = await hub()
  if (left < 8000) return { tab, error: 'No time was left in this call to read the page: call text.', code: 'browser_timeout' }
  try {
    const t = await h.send(device, 'text', { tab, ...(max !== undefined ? { max } : {}) }, allow, Math.min(20_000, left - 3000)) as Record<string, unknown>
    return { tab, text: t.text, ...(t.scope ? { scope: t.scope } : {}), ...(typeof t.chars === 'number' ? { chars: t.chars } : {}), ...(t.cut ? { cut: true } : {}) }
  } catch (err) {
    const code = err instanceof h.BrowserError ? err.code : 'browser_error'
    // A tab gone meanwhile: what happened to it (tab-words.ts), as a command naming it is told.
    const message = code === 'not_your_tab' && h.tabOwner(device, tab) !== owner
      ? (await import('../../core/browser-control/tab-words.js')).notYourTabWords(tab, h.tabEndOf(device, tab), owner)
      : err instanceof Error ? err.message : String(err)
    return { tab, error: message, code }
  }
}

/** Actions whose answer names the window and tab (where-words.ts). */
const WHERE_ACTS = new Set<Action>(['open', 'navigate', 'back', 'take'])

/**
 * Every tab of the browser, the person's too (title, address, whose), for the same-site check; nothing
 * when the browser answers no list (agents only in a handed tab, an older extension, no time).
 */
async function allTabsOf(device: string, owner: string, allow: import('../../core/browser-control/hub.js').WireCommand['allow'], ms = 8000): Promise<{ tabs: Array<{ id: number; url?: string; title?: string; active?: boolean; owner?: string }> } | { error: string }> {
  const h = await hub()
  try {
    const r = await h.send(device, 'tabs', { all: true, owner }, allow, ms) as { tabs?: Array<{ id: number; url?: string; title?: string; active?: boolean; owner?: string }>; all?: boolean }
    // Only a list that says it is every tab counts: one of the agents' tabs alone shows none of the person's.
    return Array.isArray(r?.tabs) && r.all === true ? { tabs: r.tabs } : { error: 'no_full_list' }
  } catch (err) {
    const code = err instanceof h.BrowserError ? err.code : 'error'
    log.web.info('browser tab list for the same-site check failed', { device, code })
    return { error: code }
  }
}

/**
 * `fill_login` and `fill_code`: the vault decides (core/browser-control/fill-login.ts); the login
 * or its one-time code goes to the extension alone and is never logged or answered. A vault refusal answers as password_use does.
 */
async function fillLoginAct(req: Request, res: Response, b: Record<string, unknown>, at: {
  device: string; label: string; owner: string; tab: number; requester: import('../../core/vault/agent.js').AgentRequester
  allow: import('../../core/browser-control/hub.js').WireCommand['allow']
  /** The site the same-site check judged; the fill refuses a page on another one. */
  site?: string
  /** `code`: fill_code, the login's one-time code. */
  what: 'login' | 'code'
}): Promise<unknown> {
  const h = await hub()
  const { isFollower } = await import('../../core/server-role.js')
  if (isFollower()) throw new h.BrowserError('Passwords are kept on the Mac, which does not answer right now.', 503, 'vault_not_here')
  const v = await import('./vault-agent-v1.js')
  const { fillLogin } = await import('../../core/browser-control/fill-login.js')
  const { VaultError } = await import('../../core/vault/store.js')
  const { ApprovalError } = await import('../../core/approvals/store.js')
  const str = (x: unknown, n: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : undefined)
  try {
    const out = await fillLogin({
      owner: at.owner, tab: at.tab, item: str(b.item, 200), request: str(b.request, 100), purpose: str(b.purpose, 200),
      waitMs: Math.max(0, Math.min(25_000, Number(b.wait_ms) || 0)), requester: at.requester, testRun: ambientTestRun(), what: at.what,
      ...(at.site ? { site: at.site } : {}),
    }, {
      send: (action, args, ms) => h.send(at.device, action, args, at.allow, ms),
      agents: v.agentsSwitch, createApproval: v.createApproval, waitApproval: v.waitApproval,
    })
    log.web.info('browser act', { action: at.what === 'code' ? 'fill_code' : 'fill_login', device: at.device, owner: at.owner, tab: at.tab, status: out.status })
    lastTab.set(at.owner, { device: at.device, tab: at.tab })
    if (out.status === 202) { res.status(202).json(out.body); return undefined }
    return { browser: at.label, ...out.body }
  } catch (err) {
    if (err instanceof VaultError || err instanceof ApprovalError) throw new h.BrowserError(err.message, err.status, err.code)
    throw err
  }
}

export const tidyDeps: TidyDeps = {
  hub,
  taskOf: async (taskId) => {
    const { getTask } = await import('../../core/task-manager.js')
    const { fallbackUserState, shownState, storedUserState } = await import('../../core/user-status.js')
    // Only "no such task" counts as gone; any other trouble reading it throws, and the pass skips it.
    try {
      const t = await getTask(taskId)
      const state = t.user_status ? storedUserState(t.user_status) : fallbackUserState(t.phase)
      return { done: t.phase === 'COMPLETE', needsYou: shownState(state) === 'needs' }
    } catch (err) {
      if (err instanceof Error && /^No task found matching/.test(err.message)) return undefined
      throw err
    }
  },
  allow: async () => { const s = await sites(); return s.allowOf(await s.readSites()) },
  asksOn: (device, tab, owner) => !!openAsk(device, tab, owner),
}

// The task's Browser view: its tabs, a live frame, Stop (browser-view-v1.ts).
mountBrowserView(browserV1Router, { personCaller, run, walnutAddresses, extensionOf })

export function _resetBrowserRoutesForTesting(): void {
  ownCache = null
  lastTab.clear()
  siteAsks.clear()
  siteDenied.clear()
  handed.clear()
  _stopTabTidyForTesting()
  _resetBrowserViewForTesting()
}
