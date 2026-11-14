/**
 * The task's Browser view (web: components/sessions/SessionBrowserCard.tsx; 2026-11-07, the user:
 * "if this task is using browser ... we also show a browser screen in the task, it can be a bit
 * slow it is fine, but at least we know"):
 *
 *   GET  /api/v1/browser/view?task=<id>              the task's agent tabs (title, address, window), or why its last one went
 *   GET  /api/v1/browser/view/frame?task=<id>&tab=N&device=D  a picture of the tab now (a person's request only)
 *   POST /api/v1/browser/view/stop { task, tab, device }      the agent's use of the tab ends; the tab stays open (a person's request only)
 *   POST /api/v1/browser/view/takeover { task, tab, device }  Take over: the tab comes forward for the person, agents wait (a person's request only)
 *   POST /api/v1/browser/view/handback { task, tab, device }  Hand back: the agent may use the tab again (a person's request only)
 *   POST /api/v1/browser/view/grant { task, tab, device }     "Show it live": the extension opens its page that turns live pictures on
 *   POST /api/v1/browser/view/push   the extension's pictures while someone watches (browser-view-stream.ts)
 *   POST /api/v1/browser/handback    the extension: the person pressed Hand back on the tab's own pill
 *   GET  /api/v1/browser/view/replay?task=<id>          the task's recorded steps, oldest first (a person's request only)
 *   GET  /api/v1/browser/view/replay/frame?task=&id=    one step's picture (a person's request only)
 *   POST /api/v1/browser/view/replay  the extension's picture of an agent's step (core/browser-control/replay-store.ts)
 *
 * A tab id is unique within one browser only: a frame and a Stop name the browser (device) too, and
 * one that leaves it out is answered only when it names one tab. A test run gets nothing of the
 * person's browser: no tabs, no frame, no Stop (as /browser/act refuses it).
 *
 * Pictures are taken only while a viewer watches (the web asks only while the view is on screen),
 * never in the background. A browser that streams (`view-stream`) posts them as it takes them
 * (browser-view-stream.ts); an older one is asked for one picture at a time, and two viewers of one
 * tab share one capture. A sign-in the agent asked the person for (request_sign_in,
 * core/browser-control/sign-in-ask.ts) rides on its tab in the tab list. `browser:tabs` tells the web when a task's tabs came or went, so the view appears when
 * the session starts using the browser and says so when it stops; the extension's own reports
 * bring the tabs back after a restart of Walnut or of the extension.
 */
import type { Router, Request, Response, NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { ambientTestRun } from '../../core/test-run.js'
import { endStream, streamFrame, streamPush, _resetBrowserStreamsForTesting } from './browser-view-stream.js'
import { endSignIn, openAsk } from '../../core/browser-control/sign-in-ask.js'

const hub = () => import('../../core/browser-control/hub.js')
const replays = () => import('../../core/browser-control/replay-store.js')
const sites = () => import('../../core/browser-control/sites.js')

export interface ViewDeps {
  personCaller: (req: Request) => boolean
  run: (res: Response, next: NextFunction, work: () => Promise<unknown>) => Promise<void>
  walnutAddresses: (req: Request) => Promise<string[]>
  /** The extension's own device from its token, else answered 403 (null). */
  extensionOf: (req: Request, res: Response) => string | null
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
      const view = h.viewOf(`task:${taskId}`)
      // A sign-in the agent waits for rides on its tab (sign-in-ask.ts).
      const tabs = view.tabs.map((t) => {
        const a = openAsk(t.device, t.tab, `task:${taskId}`)
        return a ? { ...t, signIn: { id: a.id, at: new Date(a.at).toISOString(), ...(a.site ? { site: a.site } : {}), ...(a.note ? { note: a.note } : {}) } } : t
      })
      // The task's recorded steps: the pill offers the replay after its tabs are gone too.
      const replay = await (await replays()).replaySummary(taskId).catch(() => undefined)
      return { taskId, ...view, tabs, browsers: h.connected().length, ...(replay ? { replay } : {}) }
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
      // Per holding: a tab another task took, or this task holds again after a Stop, never gets
      // the picture of an earlier holding (review 2026-11-07).
      const gen = h.tabGen(known.device, tab)
      // The person watching counts as use: the tidy-up never closes a tab under their eyes.
      h.noteActed(known.device, tab)
      const stillHeld = () => h.tabOwner(known.device, tab) === owner && h.tabGen(known.device, tab) === gen
      const notHeld = () => new h.BrowserError('That tab is not this task\'s now.', 404, 'not_your_tab')
      const allowNow = async () => {
        const s = await sites()
        return { ...s.allowOf(await s.readSites()), walnut: await d.walnutAddresses(req) }
      }
      // A browser that streams posts its pictures itself while someone watches (browser-view-stream.ts).
      if (h.hasCap(known.device, 'view-stream')) {
        return streamFrame(req, res, {
          device: known.device, tab, gen, browser: known.browser, stillHeld, notHeld,
          watch: async () => h.send(known.device, 'view_watch', { tab, ms: 6000 }, await allowNow(), FRAME_MS),
        })
      }
      const key = `${owner}\0${known.device}:${tab}\0${gen ?? ''}`
      const held = frames.get(key)
      if (held && (held.done === undefined || Date.now() - held.done < FRAME_SHARE_MS)) return held.p.then((o) => {
        if (!stillHeld()) throw new h.BrowserError('That tab is not this task\'s now.', 404, 'not_your_tab')
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
          if (!stillHeld()) throw new h.BrowserError('That tab is not this task\'s now.', 404, 'not_your_tab')
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
      // Only this holding is stopped: the browser and the hub both compare before they let go
      // (review 2026-11-07: a late Stop released the tab the next task had taken meanwhile).
      const gen = h.tabGen(known.device, tab)
      for (const k of [...frames.keys()]) if (k.startsWith(`${owner}\0${known.device}:${tab}\0`)) frames.delete(k)
      endStream(known.device, tab)
      const undo = h.endingTab(known.device, tab, 'stopped')
      try {
        out = (await h.send(known.device, 'view_stop', { tab, owner }, allow, 10_000) ?? {}) as Record<string, unknown>
      } catch (err) {
        undo()
        if (err instanceof h.BrowserError && err.code === 'bad_action') {
          throw new h.BrowserError('This browser\'s Walnut extension is older than the Browser view: use Stop on the page itself, or update the extension (Settings, Browser extension).', 409, 'old_extension')
        }
        throw err
      }
      if (out.stopped === false) {
        undo()
        return { ok: true, ...out, tab, device: known.device, stopped: false }
      }
      // Before the release, which would end the ask as `gone`: the agent hears it was stopped.
      if (endSignIn(known.device, tab, 'stopped', owner)) h.ownerChanged(owner)
      if (!h.releaseTabIf(known.device, tab, owner, gen, 'stopped')) undo()
      log.web.info('browser view stop', { device: known.device, owner, tab, by: 'person' })
      return { ok: true, ...out, tab, device: known.device, stopped: true }
    })
  })

  // Take over and Hand back (the extension's agent-takeover.ts): the person's own clicks in the view.
  const personTab = async (req: Request, h: Hub, verb: string) => {
    if (!d.personCaller(req)) throw new h.BrowserError(`${verb} in the Browser view is the person's: an agent asks them with request_sign_in.`, 403, 'human_only')
    if (ambientTestRun()) throw new h.BrowserError('A test run does not use the person\'s browser.', 409, 'test_run')
    const b = (req.body ?? {}) as { task?: unknown; tab?: unknown; device?: unknown }
    const taskId = taskOf(b.task)
    const tab = tabOf(b.tab)
    if (!taskId || tab === undefined) throw new h.BrowserError('A task and a tab are needed.', 400, 'bad_request')
    const owner = `task:${taskId}`
    const known = pickTab(h, owner, tab, deviceOf(b.device))
    if (!known.connected) throw new h.BrowserError(`${known.browser} does not answer right now.`, 409, 'browser_not_connected')
    if (!h.hasCap(known.device, 'takeover')) throw new h.BrowserError('This browser\'s Walnut extension is older than Take over: update it (Settings, Browser extension), or use the tab in Chrome yourself.', 409, 'old_extension')
    const s = await sites()
    return { owner, tab, known, allow: { ...s.allowOf(await s.readSites()), walnut: await d.walnutAddresses(req) } }
  }

  r.post('/browser/view/takeover', (req, res, next) => {
    void d.run(res, next, async () => {
      const h = await hub()
      const { owner, tab, known, allow } = await personTab(req, h, 'Take over')
      const out = (await h.send(known.device, 'view_takeover', { tab, owner }, allow, 15_000) ?? {}) as Record<string, unknown>
      h.noteTab(known.device, tab, { driving: true })
      h.noteActed(known.device, tab)
      log.web.info('browser view take over', { device: known.device, owner, tab, by: 'person' })
      return { ok: true, ...out, tab, device: known.device, driving: true }
    })
  })

  r.post('/browser/view/handback', (req, res, next) => {
    void d.run(res, next, async () => {
      const h = await hub()
      const { owner, tab, known, allow } = await personTab(req, h, 'Hand back')
      const out = (await h.send(known.device, 'view_handback', { tab, owner }, allow, 10_000) ?? {}) as Record<string, unknown>
      h.noteTab(known.device, tab, { driving: false })
      h.noteActed(known.device, tab)
      // The sign-in the agent waited for is done: its waiting call answers now.
      const ask = endSignIn(known.device, tab, 'done', owner)
      h.ownerChanged(owner)
      log.web.info('browser view hand back', { device: known.device, owner, tab, by: 'person', signIn: !!ask })
      return { ok: true, ...out, tab, device: known.device, driving: false, ...(ask ? { signIn: 'done' } : {}) }
    })
  })

  // "Show it live" on a covered window (the extension's grant-open.ts): Chrome lets the extension
  // ask for its debugger only inside a click on its own page, so this opens that page; the grant
  // itself is the person's two clicks there. A person's request brings the page up in their window;
  // anyone else's (an agent may ask too) opens it in the background, never focusing anything.
  r.post('/browser/view/grant', (req, res, next) => {
    void d.run(res, next, async () => {
      const h = await hub()
      if (ambientTestRun()) throw new h.BrowserError('A test run does not use the person\'s browser.', 409, 'test_run')
      const b = (req.body ?? {}) as { task?: unknown; tab?: unknown; device?: unknown }
      const taskId = taskOf(b.task)
      const tab = tabOf(b.tab)
      if (!taskId || tab === undefined) throw new h.BrowserError('A task and a tab are needed.', 400, 'bad_request')
      const owner = `task:${taskId}`
      const known = pickTab(h, owner, tab, deviceOf(b.device))
      if (!known.connected) throw new h.BrowserError(`${known.browser} does not answer right now.`, 409, 'browser_not_connected')
      if (!h.hasCap(known.device, 'live-pictures')) throw new h.BrowserError('This browser\'s Walnut extension is older than live pictures: update it (Settings, Browser extension).', 409, 'old_extension')
      const person = d.personCaller(req)
      const s = await sites()
      const allow = { ...s.allowOf(await s.readSites()), walnut: await d.walnutAddresses(req) }
      const out = (await h.send(known.device, 'view_grant', { tab, person }, allow, 10_000) ?? {}) as Record<string, unknown>
      log.web.info('browser view grant page', { device: known.device, owner, tab, by: person ? 'person' : 'agent', opened: out.opened === true })
      return { ok: true, ...out, tab, device: known.device }
    })
  })

  // The extension: the person pressed Hand back on the tab's own pill.
  r.post('/browser/handback', (req, res, next) => {
    const device = d.extensionOf(req, res)
    if (!device) return
    void d.run(res, next, async () => {
      const h = await hub()
      const tab = tabOf((req.body as { tab?: unknown } | undefined)?.tab)
      const owner = tab === undefined ? undefined : h.tabOwner(device, tab)
      if (tab === undefined || !owner) return { ok: true, handedBack: false }
      h.noteTab(device, tab, { driving: false })
      const ask = endSignIn(device, tab, 'done', owner)
      h.ownerChanged(owner)
      log.web.info('browser view hand back', { device, owner, tab, by: 'person', from: 'page', signIn: !!ask })
      return { ok: true, handedBack: true }
    })
  })

  // The Browser replay (replay-store.ts). Its pictures are not masked, as a live frame is not: the person's alone.
  r.get('/browser/view/replay', (req, res, next) => {
    void d.run(res, next, async () => {
      const h = await hub()
      if (!d.personCaller(req)) throw new h.BrowserError('Only a person watches the Browser replay.', 403, 'human_only')
      const taskId = taskOf(req.query.task)
      if (!taskId) throw new h.BrowserError('Which task: ?task=<id>.', 400, 'bad_request')
      const r = await replays()
      const { readSites } = await sites()
      const steps = (await r.listSteps(taskId)).map(({ file, ...s }) => ({ ...s, picture: !!file }))
      return { taskId, steps, days: (await readSites()).replayDays }
    })
  })

  r.get('/browser/view/replay/frame', (req, res, next) => {
    void d.run(res, next, async () => {
      const h = await hub()
      if (!d.personCaller(req)) throw new h.BrowserError('Only a person watches the Browser replay.', 403, 'human_only')
      const taskId = taskOf(req.query.task)
      const id = typeof req.query.id === 'string' ? req.query.id.slice(0, 40) : ''
      if (!taskId || !id) throw new h.BrowserError('Which task and step: ?task=<id>&id=<step>.', 400, 'bad_request')
      const pic = await (await replays()).stepPicture(taskId, id)
      if (!pic) throw new h.BrowserError('That step has no picture (deleted after the days kept, or never taken).', 404, 'no_picture')
      // JSON, as the live frame: the web's client adds the device's token, which an <img> would not.
      res.setHeader('Cache-Control', 'private, max-age=3600')
      return { id, image: `data:image/jpeg;base64,${pic.toString('base64')}` }
    })
  })

  r.post('/browser/view/replay', (req, res, next) => {
    const device = d.extensionOf(req, res)
    if (!device) return
    void d.run(res, next, async () => (await replays()).acceptStep(await hub(), device, (req.body ?? {}) as Record<string, unknown>))
  })

  // The extension's pictures while someone watches (browser-view-stream.ts).
  r.post('/browser/view/push', (req, res, next) => {
    const device = d.extensionOf(req, res)
    if (!device) return
    void d.run(res, next, async () => streamPush(await hub(), device, (req.body ?? {}) as Record<string, unknown>))
  })
}

export function _resetBrowserViewForTesting(): void {
  frames.clear()
  _resetBrowserStreamsForTesting()
  for (const t of announcing.values()) clearTimeout(t)
  announcing.clear()
}
