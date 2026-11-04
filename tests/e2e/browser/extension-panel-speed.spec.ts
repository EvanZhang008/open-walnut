/**
 * How fast the side panel shows something on Ask and Tasks, through the real extension: opened
 * the first time, and opened again with a conversation already going (the person's usual case).
 * Run it on the built SPA for the product's numbers (PW_BUILT_SPA=1 WALNUT_WEB_STATIC_DIR=<dist>);
 * Vite dev mode serves hundreds of modules and its times say nothing about the product. The
 * numbers go to PANEL_SPEED_OUT (JSON) when it is set.
 *
 * What it holds the panel to: opened again, Ask shows the page and its conversation (the person's
 * last question on screen) and Tasks shows its list, each within a second.
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
  record('ask-first:title', await until(panel, 'ext-panel', '.ext-panel-title', t0))
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
    record('ask-again:title', await until(panel, 'ext-panel', '.ext-panel-title', t0))
    record('ask-again:question', await until(panel, 'ext-panel', `[data-testid="ask-object-drawer"] :text("${q}")`, t0))
    // The person keeps the panel open a moment, as people do; then it closes.
    await panel.waitForTimeout(1200)
    if (process.env.PANEL_SPEED_TRACE) await trace(panel, t0)
    await panel.close()
  }
  expect.soft(median(results['ask-again:shown'])).toBeLessThan(1000)
})

test('Tasks, opened again: the list', async () => {
  test.setTimeout(180_000)
  // The first open of Tasks loads its frame; the person's usual case is the ones after.
  const first = await openPanel(lab, 'tasks')
  record('tasks-first:list', await until(first.panel, 'ext-tasks', '[data-testid="ext-task"]', first.t0))
  await first.panel.waitForTimeout(1500)
  await first.panel.close()
  for (let i = 0; i < 5; i++) {
    const { panel, t0 } = await openPanel(lab, 'tasks')
    record('tasks-again:shown', await firstShown(panel, 'ext-tasks', '[data-testid="ext-task"]', '[data-testid="panel-snap"] .panel-snap-task', t0))
    record('tasks-again:list', await until(panel, 'ext-tasks', '[data-testid="ext-task"]', t0))
    await panel.waitForTimeout(1200)
    await panel.close()
  }
  expect.soft(median(results['tasks-again:shown'])).toBeLessThan(1000)
})
