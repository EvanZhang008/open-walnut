/**
 * The walkthrough control keeps its place (the drawing_narration experiment, Drawing plugin's
 * src/narration/NarrationControl.tsx). 2026-11-20, Evan, on the first version: "why the fucking
 * button is moving". The Stop button sat left of the newest sentence in the top bar, so each
 * sentence heard moved it, and "Walkthrough saved" took its place when it ended. Now the bar holds
 * one pill of one size in every state, and the words show in a strip over the canvas; this spec
 * fails when the pill, or any button of the bar, moves by a pixel while a take is recorded, saved
 * and done, at a wide and at a narrow window.
 *
 * Runs in Chromium (drawing-narration-layout.spec.ts) and in WebKit, the Mac app's engine
 * (drawing-narration-layout.webkit.spec.ts): the microphone is a stream made in the page (fake-mic.ts
 * useSyntheticMic), speech to text a stub at the network. Nothing plays a sound.
 *
 * Env for a proof video: PROOF_VIDEO_DIR, NARRATION_VIEWPORT=<w>x<h>, NARRATION_SCENE=<a drawing
 * file's JSON (GET /api/drawings/file)>, NARRATION_TARGETS=<JSON list of the words that start
 * the two shapes to point at>, NARRATION_SAID=<JSON list of the two sentences>, NARRATION_FLAGS=<a
 * JSON object of experimental flags, the user's own set (GET /api/config), applied first>.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import { loadHome } from './draft-helpers'
import { useDrawingFixture } from './plugin-fixture'
import { startProofVideo } from './proof-video'
import { useSyntheticMic } from './fake-mic'
import { isolateUiPrefs } from './todo-panel-helpers'

const [VW, VH] = (process.env.NARRATION_VIEWPORT ?? '1280x800').split('x').map(Number)
const SCENE = process.env.NARRATION_SCENE ? JSON.parse(fs.readFileSync(process.env.NARRATION_SCENE, 'utf8')) as { scene?: { elements: unknown[] }; result?: { scene: { elements: unknown[] } } } : null
const TARGETS: string[] = JSON.parse(process.env.NARRATION_TARGETS ?? '["orders","Redis cache"]')
const SAID: string[] = JSON.parse(process.env.NARRATION_SAID ?? JSON.stringify([
  'this table is the core table, every order is written here first, and everything else reads from it later on',
  'this one is only a cache',
]))


const workspace = (page: Page) => page.locator('.drawing-workspace')
const bar = (page: Page) => workspace(page).locator('.drawing-workspace-bar')
const pill = (page: Page) => workspace(page).locator('.walnut-narration-pill')

/** Every button of the top bar right of the gap, by name: where it is, to the pixel. */
async function barPlaces(page: Page): Promise<Record<string, string>> {
  return bar(page).evaluate((el) => {
    const out: Record<string, string> = {}
    for (const b of Array.from(el.querySelectorAll('button'))) {
      const name = b.closest('.walnut-narration-pill, .walnut-narration' /* the first version's wrapper */) ? 'walkthrough' : (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()
      if (!name || b.closest('.drawing-workspace-title')) continue
      const r = b.getBoundingClientRect()
      out[name] = `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
    }
    return out
  })
}

async function expectSamePlaces(page: Page, before: Record<string, string>, when: string) {
  expect(await barPlaces(page), `the top bar moved ${when}`).toEqual(before)
}

const USER_FLAGS: Record<string, boolean> = JSON.parse(process.env.NARRATION_FLAGS ?? '{}')

async function setNarration(page: Page, on: boolean) {
  const res = await page.request.put('/api/config', { data: { experimental: { ...USER_FLAGS, drawing_app: true, apps_stay_open: true, drawing_narration: on } } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function makeDrawing(page: Page, title: string): Promise<string> {
  const made = await page.request.post('/api/drawings', { data: { title } })
  expect(made.ok(), await made.text()).toBe(true)
  const doc = await made.json() as { path: string; revision: string }
  const scene = SCENE ? (SCENE.scene ?? SCENE.result!.scene) : null
  const res = scene
    ? await page.request.put('/api/drawings/file', { data: { path: doc.path, revision: doc.revision, scene } })
    : await page.request.post('/api/drawings/append', { data: { path: doc.path, revision: doc.revision, elements: [
        { type: 'rectangle', x: 0, y: 0, width: 240, height: 140, text: 'orders' },
        { type: 'rectangle', x: 420, y: 0, width: 240, height: 140, text: 'Redis cache' },
      ] } })
  expect(res.ok(), await res.text()).toBe(true)
  return doc.path
}

async function openDrawing(page: Page, title: string, docPath: string) {
  await loadHome(page)
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click()
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('apps-search').fill('Drawing')
  await page.getByTestId('plugin-card-open-walnut-drawing').click()
  await expect(workspace(page)).toBeVisible({ timeout: 60_000 })
  await workspace(page).locator('.drawing-workspace-file').filter({ hasText: title }).click()
  await expect(workspace(page)).toHaveAttribute('data-drawing-path', docPath, { timeout: 60_000 })
  await expect(workspace(page)).toHaveAttribute('data-save-state', 'saved', { timeout: 30_000 })
}

/** The middle of the shape whose words start with `words`, on the page. */
async function shapeOnScreen(page: Page, docPath: string, words: string) {
  const file = await page.request.get(`/api/drawings/file?path=${encodeURIComponent(docPath)}`)
  const elements = (await file.json() as { scene: { elements: Array<{ id: string; type: string; text?: string; containerId?: string | null; x: number; y: number; width: number; height: number; isDeleted?: boolean }> } }).scene.elements
  const text = elements.find((e) => e.type === 'text' && !e.isDeleted && (e.text ?? '').startsWith(words))
  if (!text) throw new Error(`no shape says ${JSON.stringify(words)}`)
  const shape = (text.containerId && elements.find((e) => e.id === text.containerId)) || text
  const host = workspace(page).locator('.drawing-canvas-host')
  const box = await workspace(page).locator('canvas.excalidraw__canvas.interactive').boundingBox()
  const { zoom, scrollX, scrollY } = await host.evaluate((el) => ({ zoom: Number(el.dataset.zoom ?? 1), scrollX: Number(el.dataset.scrollX ?? 0), scrollY: Number(el.dataset.scrollY ?? 0) }))
  if (!box) throw new Error('no canvas')
  const left = box.x + (shape.x + scrollX) * zoom
  const top = box.y + (shape.y + scrollY) * zoom
  return { x: left + (shape.width * zoom) / 2, y: top + (shape.height * zoom) / 2, top, right: left + shape.width * zoom }
}

/** Pan the canvas until the shape's top right corner is at (x, y) on the page. */
async function panShapeCornerTo(page: Page, docPath: string, words: string, x: number, y: number) {
  for (let i = 0; i < 4; i++) {
    const at = await shapeOnScreen(page, docPath, words)
    const dx = at.right - x
    const dy = at.top - y
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    await page.mouse.move(x, y - 200)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(300)
  }
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

async function centerOf(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error('not on screen')
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

export function registerNarrationLayoutScenario(): void {
  useDrawingFixture()
  test.describe.configure({ mode: 'default', timeout: 240_000 })
  test.use({ viewport: { width: VW, height: VH }, deviceScaleFactor: process.env.PROOF_VIDEO_DIR && VW <= 1600 ? 2 : 1 })
  test('the Record pill and the bar stay put through a whole walkthrough, and the words show over the canvas', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    // A read that timed out is a loaded test host or the dev server's first-load compile holding
    // its event loop (seconds of Babel; production serves built files), not this feature's error:
    // the scenario still proves the drawing showed (it selects its shapes) and was saved. Other
    // writes and STT stay strict.
    const slowRead = /\[api\] (GET \/api\/(?!stt)|[A-Z]+ \/api\/(?!drawings|stt))\S+ FAILED after \d+ms \(timeout/
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_ABORTED/.test(m.text()) && !slowRead.test(m.text())) errors.push(m.text()) })
    // This spec opens the sidebar: its prefs stay its own, never the shared fixture's.
    await isolateUiPrefs(page)
    // Sentences: 1.8 s of speech, then 2.6 s of quiet, again and again.
    await useSyntheticMic(page, { speech: { leadMs: 600, onMs: 1_800, offMs: 2_600 } })
    const video = await startProofVideo(page)
    let heard = 0
    await page.route('**/api/stt/transcribe', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: SAID[heard++ % SAID.length], durationMs: 30, recordingId: `rec-${heard}` }) }))

    await setNarration(page, true)
    const title = SCENE ? 'Walkthrough of my drawing' : 'Shop design'
    const docPath = await makeDrawing(page, title)
    await openDrawing(page, title, docPath)
    if (SCENE) {
      // Fit the whole drawing in view, as one does before talking it through.
      await workspace(page).locator('canvas.excalidraw__canvas.interactive').click({ position: { x: 8, y: 120 } })
      await page.keyboard.press('Shift+Digit1')
      await page.waitForTimeout(600)
      // Then in on the shapes talked about, close enough to read them.
      const near = await shapeOnScreen(page, docPath, TARGETS[0])
      await page.mouse.move(near.x, near.y)
      await page.keyboard.down('Control')
      for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(120) }
      await page.keyboard.up('Control')
      await page.waitForTimeout(600)
    }
    const record = workspace(page).getByRole('button', { name: 'Record', exact: true })
    await expect(record).toBeEnabled({ timeout: 30_000 })
    await video.caption('The Record button sits in the top bar')
    await video.hold(1_500)
    const idle = await barPlaces(page)
    expect(Object.keys(idle)).toContain('walkthrough')

    if (video.on) { await page.mouse.move(...Object.values(await centerOf(record)) as [number, number], { steps: 20 }); await video.caption('Press Record') ; await video.hold(600) }
    await record.click()
    const stop = workspace(page).getByRole('button', { name: 'Stop recording the walkthrough' })
    await expect(stop).toBeVisible()
    await expectSamePlaces(page, idle, 'when recording started')
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording', { timeout: 15_000 })
    const strip = workspace(page).locator('.walnut-narration-strip')
    await expect(strip).toBeVisible()

    const first = await shapeOnScreen(page, docPath, TARGETS[0])
    await video.caption(`Point at a shape and talk: "${SAID[0]}"`)
    await page.mouse.move(first.x, first.y, { steps: video.on ? 25 : 8 })
    await expect(strip).toContainText(SAID[0].slice(0, 30), { timeout: 30_000 })
    await expectSamePlaces(page, idle, 'when the first sentence came in')
    await video.hold(1_200)

    const second = await shapeOnScreen(page, docPath, TARGETS[1])
    await video.caption(`Move on and keep talking: "${SAID[1]}"`)
    await page.mouse.move(second.x, second.y, { steps: video.on ? 25 : 8 })
    await expect(strip).toContainText(SAID[1].slice(0, 20), { timeout: 30_000 })
    await expectSamePlaces(page, idle, 'when the second sentence came in')
    await video.hold(1_200)

    if (!video.on) {
      // A shape selected near the bottom: its "Make a diagram" button keeps clear of the strip
      // (2026-11-20: held only above the editor's bottom bar, it sat on the words).
      await page.mouse.click(second.x, second.y)
      const c = (await workspace(page).locator('.drawing-workspace-canvas').boundingBox())!
      const s1 = (await strip.boundingBox())!
      await panShapeCornerTo(page, docPath, TARGETS[1], s1.x + s1.width / 2 + 40, c.y + c.height - 80)
      const diagramPill = workspace(page).locator('.drawing-diagram-pill')
      await expect(diagramPill).toBeVisible()
      await expect.poll(async () => overlaps((await diagramPill.boundingBox())!, (await strip.boundingBox())!), { message: 'the Make a diagram button sits on the caption strip' }).toBe(false)
      await expectSamePlaces(page, idle, 'when a shape was selected')
      await page.keyboard.press('Escape')
    }

    // The strip is over the canvas, clear of the bar and of the editor's bottom tools.
    const stripBox = (await strip.boundingBox())!
    const barBox = (await bar(page).boundingBox())!
    const canvasBox = (await workspace(page).locator('.drawing-workspace-canvas').boundingBox())!
    expect(stripBox.y).toBeGreaterThan(barBox.y + barBox.height)
    expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(canvasBox.y + canvasBox.height - 64)
    expect(stripBox.x).toBeGreaterThanOrEqual(canvasBox.x)
    expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width)

    if (video.on) { await page.mouse.move(...Object.values(await centerOf(stop)) as [number, number], { steps: 20 }); await video.caption('Stop: the button stays where it is') }
    await stop.click()
    // Saving, then Saved, then Record again: the same pill in the same place each time.
    for (const phase of ['saved', 'idle']) {
      await expect(pill(page)).toHaveAttribute('data-phase', phase, { timeout: 60_000 })
      await expectSamePlaces(page, idle, `at ${phase}`)
    }
    await expect(strip).toHaveCount(0)
    await video.hold(800)

    // A narrow window (the drawing beside a chat): the bar still fits, and still holds still.
    if (!video.on) {
      await page.setViewportSize({ width: 760, height: VH })
      await expect(record).toBeVisible()
      const narrow = await barPlaces(page)
      const places = Object.values(narrow).map((p) => p.match(/^(-?\d+),(-?\d+) (\d+)x(\d+)$/)!.slice(1).map(Number))
      for (const [x, , w] of places) expect(x + w).toBeLessThanOrEqual(760)
      await record.click()
      await expect(pill(page)).toHaveAttribute('data-phase', 'recording', { timeout: 15_000 })
      await expect(strip).toContainText('\u201c', { timeout: 30_000 })
      await expectSamePlaces(page, narrow, 'in a narrow window while recording')
      await stop.click()
      await expect(pill(page)).toHaveAttribute('data-phase', 'idle', { timeout: 60_000 })
      await expectSamePlaces(page, narrow, 'in a narrow window after saving')
    }

    if (video.on) {
      await video.caption('The walkthrough is saved beside the drawing; the bar never moved')
      await video.hold(2_000)
      await video.stop(process.env.PROOF_VIDEO_NAME ?? 'drawing-narration-steady')
    }
    const saved = await page.request.get(`/api/drawings/narration?path=${encodeURIComponent(docPath)}`)
    expect((await saved.json() as { takes: number }).takes).toBeGreaterThanOrEqual(1)
    expect(errors).toEqual([])
  })
}
