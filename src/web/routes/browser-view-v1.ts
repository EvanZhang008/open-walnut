/**
 * The task's Browser view (web: components/sessions/SessionBrowserCard.tsx; 2026-11-07, the user:
 * "if this task is using browser ... we also show a browser screen in the task, it can be a bit
 * slow it is fine, but at least we know"):
 *
 *   GET  /api/v1/browser/view?task=<id>              the task's agent tabs (title, address, window), or why its last one went
 *   GET  /api/v1/browser/view/frame?task=<id>&tab=N&device=D  a picture of the tab now (a person's request only)
 *   POST /api/v1/browser/view/stop { task, tab, device }      the agent's use of the tab ends; the tab stays open (a person's request only)
 *
 * A tab id is unique within one browser only: a frame and a Stop name the browser (device) too, and
 * one that leaves it out is answered only when it names one tab. A test run gets nothing of the
 * person's browser: no tabs, no frame, no Stop (as /browser/act refuses it).
 *
 * A frame is taken only when a viewer asks for one (the web asks about once a second and a half,
 * only while the view is on screen), never in the background; two viewers of one tab share one
 * capture. `browser:tabs` tells the web when a task's tabs came or went, so the view appears when
 * the session starts using the browser and says so when it stops; the extension's own reports
 * bring the tabs back after a restart of Walnut or of the extension.
 */
import type { Router, Request, Response, NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { ambientTestRun } from '../../core/test-run.js'

const hub = () => import('../../core/browser-control/hub.js')
const sites = () => import('../../core/browser-control/sites.js')

export interface ViewDeps {
  personCaller: (req: Request) => boolean
  run: (res: Response, next: NextFunction, work: () => Promise<unknown>) => Promise<void>
  walnutAddresses: (req: Request) => Promise<string[]>
}

/** A frame shared by every viewer of the tab while it is taken and for this long after. */
const FRAME_SHARE_MS = 900
const FRAME_MS = 8000
/** The capture under way or just taken, per tab (`done`: when it came back). */
const frames = new Map<string, { done?: number; p: Promise<Record<string, unknown>> }>()

/** One `browser:tabs` per task per burst (an open is an own, a report and a note within a moment). */
const ANNOUNCE_MS = 150
const announcing = new Map<string, ReturnType<typeof setTimeout>>()
function announce(owner: string): void {
  if (!owner.startsWith('task:')) return
  const taskId = owner.slice(5)
  if (announcing.has(taskId)) return
  const t = setTimeout(() => {
    announcing.delete(taskId)
    bus.emit(EventNames.BROWSER_TABS_CHANGED, { taskId }, ['web-ui'], { source: 'browser' })
  }, ANNOUNCE_MS)
  t.unref?.()
  announcing.set(taskId, t)
}

const taskOf = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 100) : '')
// A device's name as the hub keeps it (any name a device was given, no control characters).
const deviceOf = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 120 && v.trim() !== '' && !/[\u0000-\u001f]/.test(v) ? v : undefined)
const tabOf = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

type Hub = typeof import('../../core/browser-control/hub.js')

/** The task's tab a frame or Stop names: the browser and the tab; a tab id alone only when it is the task's in one browser. */
function pickTab(h: Hub, owner: string, tab: number, device: string | undefined) {
  const hits = h.viewOf(owner).tabs.filter((t) => t.tab === tab && (!device || t.device === device))
  if (!hits.length) throw new h.BrowserError('That tab is not this task\'s now.', 404, 'not_your_tab')
  if (hits.length > 1) throw new h.BrowserError('That tab id is the task\'s in more than one browser: say which (device).', 409, 'which_browser', { devices: hits.map((t) => t.device) })
  return hits[0]
}

export function mountBrowserView(r: Router, d: ViewDeps): void {
  void hub().then((h) => { h.onTabsChanged(announce) }).catch(() => undefined)

  r.get('/browser/view', (req, res, next) => {
    void d.run(res, next, async () => {
      const h = await hub()
      const taskId = taskOf(req.query.task)
      if (!taskId) throw new h.BrowserError('Which task: ?task=<id>.', 400, 'bad_request')
      // A test run sees none of the person's browser.
      if (ambientTestRun()) return { taskId, tabs: [], browsers: 0, testRun: true }
      return { taskId, ...h.viewOf(`task:${taskId}`), browsers: h.connected().length }
    })
  })

  r.get('/browser/view/frame', (req, res, next) => {
    void d.run(res, next, async () => {
      const h = await hub()
      // A frame is not masked (a password a page shows as text shows in it): the person's alone.
      if (!d.personCaller(req)) throw new h.BrowserError('Only a person watches the live Browser view. An agent takes a screenshot (browser, action screenshot), which draws a shown password as dots.', 403, 'human_only')
      if (ambientTestRun()) throw new h.BrowserError('A test run does not see the person\'s browser.', 409, 'test_run')
      const taskId = taskOf(req.query.task)
      const tab = tabOf(req.query.tab)
      if (!taskId || tab === undefined) throw new h.BrowserError('Which task and tab: ?task=<id>&tab=<n>&device=<browser>.', 400, 'bad_request')
      const owner = `task:${taskId}`
      const known = pickTab(h, owner, tab, deviceOf(req.query.device))
      if (!known.connected) throw new h.BrowserError(`${known.browser} does not answer right now.`, 409, 'browser_not_connected')
      // Per owner too: a tab another task took a moment ago never gets this one's picture.
      const key = `${owner}\0${known.device}:${tab}`
      const held = frames.get(key)
      if (held && (held.done === undefined || Date.now() - held.done < FRAME_SHARE_MS)) return held.p.then((o) => {
        if (h.tabOwner(known.device, tab) !== owner) throw new h.BrowserError('That tab is not this task\'s now.', 404, 'not_your_tab')
        return o
      })
      // Shared from this moment on, before anything is awaited: a second viewer's request joins it.
      const p = (async () => {
        const s = await sites()
        return { ...s.allowOf(await s.readSites()), walnut: await d.walnutAddresses(req) }
      })().then((allow) => h.send(known.device, 'view_frame', { tab }, allow, FRAME_MS)).then(
        (out) => {
          const o = (out ?? {}) as Record<string, unknown>
          // The tab may have gone to the person or another task while the picture was taken: then none.
          if (h.tabOwner(known.device, tab) !== owner) throw new h.BrowserError('That tab is not this task\'s now.', 404, 'not_your_tab')
          h.noteTab(known.device, tab, o)
          return { ...o, tab, device: known.device, browser: known.browser }
        },
        (err: unknown) => {
          // An older extension knows no frames; a busy one answers the next time.
          if (err instanceof h.BrowserError && err.code === 'bad_action') return { tab, browser: known.browser, shown: false, why: 'old_extension', url: known.url, title: known.title, window: known.window }
          if (err instanceof h.BrowserError && err.code === 'browser_timeout') return { tab, browser: known.browser, shown: false, why: 'slow', url: known.url, title: known.title, window: known.window }
          throw err
        },
      )
      // Old pictures are not kept: each holds an image.
      for (const [k, e] of frames) if (e.done !== undefined && Date.now() - e.done > FRAME_SHARE_MS) frames.delete(k)
      const entry: { done?: number; p: typeof p } = { p }
      frames.set(key, entry)
      p.then(() => { entry.done = Date.now() }, () => { if (frames.get(key) === entry) frames.delete(key) })
      return p
    })
  })

  r.post('/browser/view/stop', (req, res, next) => {
    void d.run(res, next, async () => {
      const h = await hub()
      // The person's Stop: a session ends its own use of a tab with close (review 2026-11-07: any
      // session could name any task here and stop its work).
      if (!d.personCaller(req)) throw new h.BrowserError('Stop in the Browser view is the person\'s. An agent gives its own tab back with close.', 403, 'human_only')
      if (ambientTestRun()) throw new h.BrowserError('A test run does not stop work in the person\'s browser.', 409, 'test_run')
      const b = (req.body ?? {}) as { task?: unknown; tab?: unknown; device?: unknown }
      const taskId = taskOf(b.task)
      const tab = tabOf(b.tab)
      if (!taskId || tab === undefined) throw new h.BrowserError('A task and a tab are needed.', 400, 'bad_request')
      const owner = `task:${taskId}`
      let known: ReturnType<typeof pickTab>
      try { known = pickTab(h, owner, tab, deviceOf(b.device)) } catch (err) {
        if (err instanceof h.BrowserError && err.code === 'not_your_tab') return { ok: true, tab, stopped: false }
        throw err
      }
      const s = await sites()
      const allow = { ...s.allowOf(await s.readSites()), walnut: await d.walnutAddresses(req) }
      let out: Record<string, unknown> = {}
      const undo = h.endingTab(known.device, tab, 'stopped')
      try {
        out = (await h.send(known.device, 'view_stop', { tab }, allow, 10_000) ?? {}) as Record<string, unknown>
      } catch (err) {
        undo()
        if (err instanceof h.BrowserError && err.code === 'bad_action') {
          throw new h.BrowserError('This browser\'s Walnut extension is older than the Browser view: use Stop on the page itself, or update the extension (Settings, Browser extension).', 409, 'old_extension')
        }
        throw err
      }
      h.releaseTab(known.device, tab, 'stopped')
      log.web.info('browser view stop', { device: known.device, owner, tab, by: 'person' })
      return { ok: true, ...out, tab, device: known.device, stopped: true }
    })
  })
}

export function _resetBrowserViewForTesting(): void {
  frames.clear()
  for (const t of announcing.values()) clearTimeout(t)
  announcing.clear()
}
