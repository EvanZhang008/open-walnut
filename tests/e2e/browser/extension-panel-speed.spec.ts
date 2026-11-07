/**
 * How fast the side panel shows something on Ask and Tasks, through the real extension: opened
 * the first time, and opened again with a conversation already going (the person's usual case).
 * Run it on the built SPA for the product's numbers (PW_BUILT_SPA=1 WALNUT_WEB_STATIC_DIR=<dist>);
 * Vite dev mode serves hundreds of modules and its times say nothing about the product. The
 * numbers go to PANEL_SPEED_OUT (JSON) when it is set.
 *
 * What it holds the panel to: opened again, Ask shows the page and its conversation (the person's
 * last question on screen), and the first page shows its task list, each within a second.
 */
import { expect, test, type Frame, type Page } from '@playwright/test'
import fs from 'node:fs'
import { askView, openPanel, startPanelLab, type PanelLab } from './extension-panel-harness'

test.describe.configure({ mode: 'serial' })

let lab: PanelLab
const results: Record<string, number[]> = {}
const record = (name: string, ms: number) => { (results[name] ??= []).push(ms); console.log(`[panel-speed] ${name}: ${ms} ms`) }
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'speed')
})

test.afterAll(async () => {
  const out = process.env.PANEL_SPEED_OUT
  const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { runs: v, median: median(v) }]))
  console.log('[panel-speed] summary', JSON.stringify(summary))
  if (out) fs.writeFileSync(out, JSON.stringify({ build: process.env.PW_BUILT_SPA === '1' ? 'built' : 'dev', summary }, null, 2))
  await lab?.close()
})

async function frameOf(panel: Page, view: string): Promise<Frame> {
  for (;;) {
    const f = panel.frames().find((x) => x.url().includes(`view=${view}`))
    if (f) return f
    await panel.waitForTimeout(10)
  }
}

/** Milliseconds from t0 until the panel shows `words`: its own drawing of last time, or the view's frame. */
async function firstShown(panel: Page, view: string, frameSel: string, snapSel: string, t0: number, timeout = 60_000): Promise<number> {
  const inFrame = (async () => { const f = await frameOf(panel, view); await f.waitForSelector(frameSel, { state: 'visible', timeout }) })()
  const inPanel = panel.waitForSelector(snapSel, { state: 'visible', timeout })
  await Promise.any([inFrame, inPanel])
  inFrame.catch(() => undefined); inPanel.catch(() => undefined)
  return Date.now() - t0
}

/** Milliseconds from t0 until `sel` is visible in the view's frame. */
async function until(panel: Page, view: string, sel: string, t0: number, timeout = 60_000): Promise<number> {
  const f = await frameOf(panel, view)
  await f.waitForSelector(sel, { state: 'visible', timeout })
  return Date.now() - t0
}

/** Where the time went: the panel page's and the frame's own requests, from t0. */
async function trace(panel: Page, t0: number): Promise<void> {
  const own = await panel.evaluate(() => ({ origin: performance.timeOrigin, rows: performance.getEntriesByType('resource').map((e) => [e.name.slice(-60), Math.round(e.startTime), Math.round(e.responseEnd)]) }))
  const f = await frameOf(panel, 'ext-panel')
  const fr = await f.evaluate(() => ({ origin: performance.timeOrigin, nav: performance.getEntriesByType('navigation').map((e) => { const n = e as PerformanceNavigationTiming; return [Math.round(n.responseEnd), Math.round(n.domContentLoadedEventEnd)] }), rows: performance.getEntriesByType('resource').map((e) => [e.name.slice(-70), Math.round(e.startTime), Math.round(e.responseEnd)]), marks: performance.getEntriesByType('mark').map((e) => [e.name, Math.round(e.startTime)]) }))
  console.log('[panel-trace] marks', JSON.stringify(fr.marks))
  console.log('[panel-trace] panel page', Math.round(own.origin - t0), JSON.stringify(own.rows))
  console.log('[panel-trace] frame', Math.round(fr.origin - t0), JSON.stringify(fr.nav), JSON.stringify(fr.rows))
}

test('Ask, the first time: the page and the composer', async () => {
  test.setTimeout(120_000)
  const { panel, t0 } = await openPanel(lab, 'ask')
  record('ask-first:title', await until(panel, 'ext-panel', '[data-testid="ext-panel-include"]', t0))
  record('ask-first:composer', await until(panel, 'ext-panel', '[data-testid="ask-object-drawer"] textarea', t0))
  // A conversation for the next opens.
  const composer = askView(panel).locator('[data-testid="ask-object-compose"] textarea')
  await composer.fill('What changed for uploads?')
  await composer.press('Enter')
  await expect(askView(panel).getByTestId('ask-object-session')).toBeVisible({ timeout: 60_000 })
  await expect(askView(panel).getByText('Hello! I processed your message', { exact: false }).first()).toBeVisible({ timeout: 60_000 })
  await panel.waitForTimeout(1500)
  await panel.close()
})

test('Ask, opened again: the page, then the conversation with the person\'s question', async () => {
  test.setTimeout(180_000)
  for (let i = 0; i < 5; i++) {
    const { panel, t0 } = await openPanel(lab, 'ask')
    // The conversation's words on screen (the fixture's mock CLI keeps no transcript, so a reopened
    // conversation shows the reply, which repeats the question; the measure before the fix was the same).
    const q = 'What changed for uploads?'
    record('ask-again:shown', await firstShown(panel, 'ext-panel', `[data-testid="ask-object-drawer"] :text("${q}")`, `[data-testid="panel-snap"] .panel-snap-msg:has-text("${q}")`, t0))
    record('ask-again:title', await until(panel, 'ext-panel', '[data-testid="ext-panel-include"]', t0))
    record('ask-again:question', await until(panel, 'ext-panel', `[data-testid="ask-object-drawer"] :text("${q}")`, t0))
    // The person keeps the panel open a moment, as people do; then it closes.
    await panel.waitForTimeout(1200)
    if (process.env.PANEL_SPEED_TRACE) await trace(panel, t0)
    await panel.close()
  }
  expect.soft(median(results['ask-again:shown'])).toBeLessThan(1000)
})

/**
 * The first page (a new task over the task list), the page the panel opens on until the person
 * goes to an ask: from Ask, the ≡ drawer's Tasks row goes back to it, and the panel is closed there.
 */
async function leaveOnFirstPage(): Promise<void> {
  const { panel } = await openPanel(lab, 'home')
  const v = askView(panel)
  const home = v.getByTestId('ext-home')
  await expect(v.getByTestId('ext-ask-head').or(home).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 })
  if (!(await home.isVisible())) {
    await v.getByTestId('ask-walnut-menu').click()
    await v.getByTestId('ext-drawer-tasks').click()
    await expect(home).toBeVisible()
  }
  await expect(v.locator(HOME_ROW).first()).toBeVisible({ timeout: 60_000 })
  await panel.waitForTimeout(1500)
  await panel.close()
}
const HOME_ROW = '.ext-home:not([hidden]) :is(.todo-pinned-card, .todo-panel-item)'

test('the first page, opened again: the task list', async () => {
  test.setTimeout(180_000)
  // The first open there loads the list and keeps its drawing; the person's usual case is the ones after.
  await leaveOnFirstPage()
  for (let i = 0; i < 5; i++) {
    const { panel, t0 } = await openPanel(lab, 'home')
    record('tasks-again:shown', await firstShown(panel, 'ext-panel', HOME_ROW, '[data-testid="panel-snap"] .look-home-row', t0))
    record('tasks-again:list', await until(panel, 'ext-panel', HOME_ROW, t0))
    await panel.waitForTimeout(1200)
    await panel.close()
  }
  expect.soft(median(results['tasks-again:shown'])).toBeLessThan(1000)
  // Back on Ask, as the next tests open it.
  const { panel } = await openPanel(lab, 'ask')
  await panel.waitForTimeout(800)
  await panel.close()
})

/**
 * Open time as the person sees it (review R1-4): `look` is the first moment the panel shows the
 * view's shape (its header with ≡, key and New chat, and the composer), whether the extension
 * page's own placeholder draws it or Walnut's frame; `real` is Walnut's own view up (its header
 * and composer). Cold is the first open after the browser started; warm the ones after.
 */
const LOOK_PANEL = '[data-testid="panel-snap"] [data-testid="panel-snap-menu"]'
const REAL_HEAD = '[data-testid="ext-ask-head"]'
/** The popup opens on the first page: its header and its composer. */
const REAL_POPUP_HEAD = '[data-testid="ext-home-head"]'
/** Either composer: a new chat's, or the conversation's when the page has one (its follow-up). */
const REAL_COMPOSER = '[data-testid="ask-object-compose"] textarea, .session-panel.is-plain-chat textarea'
const REAL_POPUP_COMPOSER = '[data-testid="ext-home-composer"] textarea'

async function openPopupAsk(): Promise<{ pop: Page; t0: number }> {
  const opened = lab.ctx.waitForEvent('page')
  const t0 = Date.now()
  await lab.ctx.serviceWorkers()[0].evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`popup-ask.html?window=${w}`), type: 'popup', width: 380, height: 560 }), lab.docWindow)
  return { pop: await opened, t0 }
}

/**
 * Until the drawing is gone and the view is what it will stay (`settled`), what the person sees
 * is sampled: a "Loading your asks…" in the view with no drawing over it is the jump of review
 * R2-6 (drawing, then a spinner, then the list again), counted in `uncovered`.
 */
async function settleWatch(p: Page, view: string, t0: number): Promise<{ settled: number; uncovered: number }> {
  let uncovered = 0
  const deadline = Date.now() + 20_000
  for (;;) {
    const f = p.frames().find((x) => x.url().includes(`view=${view}`))
    const lookUp = await p.locator('[data-testid="panel-snap"]').isVisible().catch(() => false)
    const state = f ? await f.evaluate(() => {
      const root = document.querySelector('[data-testid="ext-panel"]')
      const shown = (sel: string) => Array.from(document.querySelectorAll(sel)).some((e) => (e as HTMLElement).offsetParent !== null)
      const spinner = shown('.ext-continue-empty') || shown('.ext-home-loading')
      // A conversation's messages are on screen; or a new chat's Continue rows, with nothing
      // loading; or the first page's task rows. A build before `data-asks` (an A/B baseline) is
      // judged by what shows alone.
      const ready = !!document.querySelector('.session-msg')
        || (root?.getAttribute('data-asks') !== 'loading' && !spinner && !!document.querySelector('[data-testid="ext-continue-row"]'))
        || (!spinner && shown('.ext-home :is(.todo-pinned-card, .todo-panel-item)'))
      return { ready, spinner }
    }).catch(() => null) : null
    if (state?.spinner && !lookUp) uncovered++
    if (state && !lookUp && state.ready) return { settled: Date.now() - t0, uncovered }
    if (Date.now() > deadline) return { settled: Date.now() - t0, uncovered }
    await p.waitForTimeout(25)
  }
}

async function lookAndReal(p: Page, view: string, t0: number, name: string, realSel: string, head = REAL_HEAD): Promise<void> {
  const look = firstShown(p, view, head, LOOK_PANEL, t0)
  const real = (async () => { await until(p, view, head, t0); return until(p, view, realSel, t0) })()
  const settle = settleWatch(p, view, t0)
  record(`${name}:look`, await look)
  record(`${name}:real`, await real)
  const { settled, uncovered } = await settle
  record(`${name}:settled`, settled)
  record(`${name}:spinner-uncovered`, uncovered)
}

test('open time, as seen: the side panel and the popup, cold and warm', async () => {
  test.setTimeout(300_000)
  for (let i = 0; i < 4; i++) {
    const { panel, t0 } = await openPanel(lab, 'ask')
    await lookAndReal(panel, 'ext-panel', t0, i === 0 ? 'panel-open-1st' : 'panel-open-again', REAL_COMPOSER)
    await panel.waitForTimeout(1200)
    if (process.env.PANEL_SPEED_TRACE) await trace(panel, t0)
    await panel.close()
  }
  for (let i = 0; i < 4; i++) {
    const { pop, t0 } = await openPopupAsk()
    await lookAndReal(pop, 'ext-panel', t0, i === 0 ? 'popup-open-1st' : 'popup-open-again', REAL_POPUP_COMPOSER, REAL_POPUP_HEAD)
    await pop.waitForTimeout(1200)
    await pop.close()
  }
  // No open shows the view's own loading state without the drawing over it (R2-6).
  for (const k of Object.keys(results).filter((n) => n.endsWith(':spinner-uncovered'))) expect.soft(Math.max(...results[k]), k).toBe(0)
})

/**
 * A board slower than the frame's own start (a person's real board, a busy machine: the review of
 * R2-6 saw the drawing, then "Loading your asks…", then the list): the drawing stays until the
 * rows are real, and the view never shows its loading state uncovered.
 */
test('a slow board: the drawing stays until the asks are real (R2-6)', async () => {
  test.setTimeout(240_000)
  // A page with no conversation: a new chat, its Continue list over the composer, as the review saw.
  await lab.doc.goto(lab.site('docs.example.test', '/other'))
  const slow = /\/api\/tasks(\?|$)/
  await lab.ctx.route(slow, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue() })
  try {
    // The first open of this page makes the drawing the next ones show.
    { const { panel } = await openPanel(lab, 'ask'); await settleWatch(panel, 'ext-panel', Date.now()); await panel.waitForTimeout(1500); await panel.close() }
    for (let i = 0; i < 3; i++) {
      const { panel, t0 } = await openPanel(lab, 'ask')
      const { settled, uncovered } = await settleWatch(panel, 'ext-panel', t0)
      record('slow-board:settled', settled)
      record('slow-board:spinner-uncovered', uncovered)
      await panel.waitForTimeout(800)
      await panel.close()
    }
  } finally {
    await lab.ctx.unroute(slow)
    await lab.doc.goto(lab.site('docs.example.test', '/notes'))
  }
  expect.soft(Math.max(...results['slow-board:spinner-uncovered'])).toBe(0)
})
