/**
 * Recording a walkthrough of a drawing (the drawing_narration experiment, Drawing plugin's
 * src/narration/): with the switch off the editor has no Record button; on, the person presses
 * Record, rests the pointer on a table while saying "this table is the core table", moves to the
 * cache while saying "this is only a cache", and stops. The take is saved beside the drawing, and
 * the AI's read of the drawing names which element each part of the talk was about.
 *
 * The microphone is Chromium's fake device playing a file with two "sentences" (a tone that rises
 * and falls like speech) between pauses; the host's speech to text is answered by a stub at the
 * network (the request it gets is checked: a WAV from the Drawing plugin). Nothing plays a sound.
 */
import { test, expect, type Page, type Request } from '@playwright/test'
import fs from 'node:fs'
import { loadHome } from './draft-helpers'
import { useDrawingFixture } from './plugin-fixture'
import { startProofVideo } from './proof-video'
import { fakeMicArgsFor, wavOf } from './fake-mic'

const RATE = 48_000
/**
 * Seconds of the file: [from, to) of the "sentence"; quiet elsewhere. Chromium loops it from a
 * point of its own, so every loop is the same: 1.8 s of speech, then 4 s of quiet.
 */
const SENTENCES: Array<[number, number]> = [[0.5, 2.3]]
const LENGTH_S = 6.3

/** The "speech": syllables (a 4 Hz rise and fall of a pitch that wanders), a faint hiss between. */
function speechWav(): Buffer {
  const samples = new Float32Array(Math.round(RATE * LENGTH_S))
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE
    const on = SENTENCES.some(([a, b]) => t >= a && t < b)
    samples[i] = on
      ? 0.35 * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * (180 + 40 * Math.sin(2 * Math.PI * 1.3 * t)) * t)
      : 0.0008 * Math.sin(2 * Math.PI * 997 * t)
  }
  return wavOf(samples, RATE)
}

useDrawingFixture()
test.describe.configure({ mode: 'default', timeout: 180_000 })
test.use({
  viewport: { width: 1280, height: 900 },
  // A proof video (PROOF_VIDEO_DIR) is taken at twice the pixels.
  deviceScaleFactor: process.env.PROOF_VIDEO_DIR ? 2 : 1,
  permissions: ['microphone'],
  launchOptions: { args: fakeMicArgsFor(speechWav(), 'speech.wav') },
})

const SAID = ['this table is the core table, every order is written here first', 'this one is only a cache']
const workspace = (page: Page) => page.locator('.drawing-workspace')
const SHOTS = process.env.NARRATION_SHOTS ?? '/tmp/drawing-narration'

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png`, scale: 'css' })
}

async function setNarration(page: Page, on: boolean) {
  const res = await page.request.put('/api/config', { data: { experimental: { drawing_app: true, apps_stay_open: true, drawing_narration: on } } })
  expect(res.ok(), await res.text()).toBe(true)
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

/** Where a scene point is on the page: the editor's box carries its zoom and scroll. */
async function onScreen(page: Page, sceneX: number, sceneY: number) {
  const host = workspace(page).locator('.drawing-canvas-host')
  const canvas = workspace(page).locator('canvas.excalidraw__canvas.interactive')
  const box = await canvas.boundingBox()
  const { zoom, scrollX, scrollY } = await host.evaluate((el) => ({ zoom: Number(el.dataset.zoom ?? 1), scrollX: Number(el.dataset.scrollX ?? 0), scrollY: Number(el.dataset.scrollY ?? 0) }))
  if (!box) throw new Error('no canvas')
  return { x: box.x + (sceneX + scrollX) * zoom, y: box.y + (sceneY + scrollY) * zoom }
}

test('a walkthrough: Record, point at a table while saying it is the core table, and the AI knows which', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the fake microphone file is a Chromium flag')
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_ABORTED/.test(m.text())) errors.push(m.text()) })

  const video = await startProofVideo(page)
  await setNarration(page, false)
  const made = await page.request.post('/api/drawings', { data: { title: 'Shop design' } })
  expect(made.ok(), await made.text()).toBe(true)
  const doc = await made.json() as { path: string; revision: string }
  const seeded = await page.request.post('/api/drawings/append', { data: { path: doc.path, revision: doc.revision, elements: [
    { type: 'rectangle', x: 0, y: 0, width: 240, height: 140, text: 'orders' },
    { type: 'rectangle', x: 420, y: 0, width: 240, height: 140, text: 'Redis cache' },
  ] } })
  expect(seeded.ok(), await seeded.text()).toBe(true)

  // Off: the editor is as it was, no Record button anywhere.
  await openDrawing(page, 'Shop design', doc.path)
  await expect(workspace(page).locator('.walnut-narration')).toHaveCount(0)
  await video.caption('Experiment off: the Drawing app is unchanged, no Record button')
  await video.hold(2_000)
  await shot(page, '01-switch-off')

  // On: the button appears in the top bar without a reload.
  await setNarration(page, true)
  const record = workspace(page).getByRole('button', { name: 'Record', exact: true })
  await expect(record).toBeVisible({ timeout: 30_000 })
  await expect(record).toBeEnabled({ timeout: 30_000 })
  await video.caption('Experiment on: a Record button in the top bar')
  await video.hold(1_500)
  await shot(page, '02-record-button')

  const sttRequests: Request[] = []
  let heard = 0
  await page.route('**/api/stt/transcribe', async (route) => {
    sttRequests.push(route.request())
    const text = SAID[heard++] ?? ''
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text, durationMs: 30, recordingId: `rec-${heard}` }) })
  })

  if (video.on) {
    const r = await record.boundingBox()
    if (r) await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 20 })
    await video.caption('Press Record')
    await video.hold(800)
  }
  await record.click()
  const stop = workspace(page).getByRole('button', { name: 'Stop recording the walkthrough' })
  await expect(stop).toBeVisible()
  // Rest on the orders table and select it while the first sentence is said.
  const orders = await onScreen(page, 120, 40)
  await video.caption('Point at the orders table and say: "this table is the core table"')
  await page.mouse.move(orders.x, orders.y, { steps: video.on ? 25 : 8 })
  await page.mouse.click(orders.x, orders.y)
  await expect(workspace(page).locator('.walnut-narration-caption')).toContainText(SAID[0], { timeout: 20_000 })
  await video.hold(1_000)
  await shot(page, '03-recording-core-table')
  // Then rest on the cache for the second, the table still selected (as people leave it).
  const redis = await onScreen(page, 540, 40)
  await video.caption('Move to the cache and say: "this one is only a cache"')
  await page.mouse.move(redis.x, redis.y, { steps: video.on ? 25 : 8 })
  await expect(workspace(page).locator('.walnut-narration-caption')).toContainText(SAID[1], { timeout: 20_000 })
  await video.hold(1_000)
  await shot(page, '04-recording-cache')
  if (video.on) {
    const b = await stop.boundingBox()
    if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 })
    await video.caption('Stop: the walkthrough is saved beside the drawing')
  }
  await stop.click()
  await expect(workspace(page).getByText('Walkthrough saved')).toBeVisible({ timeout: 30_000 })
  await video.hold(1_500)
  await shot(page, '05-saved')
  await expect(record).toBeVisible({ timeout: 10_000 })

  // What the host's speech to text was asked: WAV pieces from this plugin.
  expect(sttRequests.length).toBeGreaterThanOrEqual(2)
  for (const r of sttRequests) {
    const body = r.postDataJSON() as { audio: string; format: string; surface: string }
    expect(body.format).toBe('wav')
    expect(body.surface).toBe('plugin:walnut-drawing')
    expect(body.audio.startsWith('UklGR')).toBe(true)
  }

  // The AI's read of the drawing carries the overview: which element each part was about.
  const ids = await page.request.get(`/api/drawings/file?path=${encodeURIComponent(doc.path)}`)
  const scene = (await ids.json() as { scene: { elements: Array<{ id: string; type: string; text?: string; containerId?: string }> } }).scene
  const idOf = (words: string) => scene.elements.find((e) => e.type === 'text' && e.text === words)!.containerId!
  const read = await page.request.post('/api/plugin-runtime/walnut-drawing/ops/walnut_drawing_read', { data: { path: doc.path } })
  expect(read.ok(), await read.text()).toBe(true)
  const answer = await read.json() as { ok: boolean; result?: { walkthroughs?: string }; message?: string }
  expect(answer.ok, JSON.stringify(answer).slice(0, 2000)).toBe(true)
  const result = answer.result!
  const overview = result.walkthroughs ?? ''
  // Everything that was recorded, kept for a look when the next lines fail.
  const all = await page.request.get(`/api/drawings/narration?path=${encodeURIComponent(doc.path)}&from=0`)
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(`${SHOTS}/ai-read-all.txt`, `${overview}\n\n${(await all.json() as { detail?: string }).detail ?? ''}\n`)
  expect(overview).toMatch(/take 1 \u00b7 .* \u00b7 2 sentences in 2 parts/)
  expect(overview).toContain(`orders (${idOf('orders')}): "${SAID[0]}"`)
  expect(overview).toContain(`Redis cache (${idOf('Redis cache')}): "${SAID[1]}"`)
  const detail = await page.request.post('/api/plugin-runtime/walnut-drawing/ops/walnut_drawing_narration', { data: { path: doc.path, take: 1, part: 1 } })
  const fineAnswer = await detail.json() as { ok: boolean; result?: { detail: string } }
  expect(fineAnswer.ok, JSON.stringify(fineAnswer).slice(0, 2000)).toBe(true)
  const fine = fineAnswer.result!.detail
  expect(fine).toMatch(new RegExp(`about: orders \\(${idOf('orders')}\\): pointer on it from [0-9:.]+; selected from`))
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(`${SHOTS}/ai-read.txt`, `${overview}\n\n${fine}\n`)
  if (video.on) {
    // What the drawing's assistant reads (walnut_drawing_read, then walnut_drawing_narration), shown on the page.
    await page.evaluate((text) => {
      const box = document.createElement('pre')
      box.id = 'proof-ai-read'
      box.textContent = text
      Object.assign(box.style, { position: 'fixed', zIndex: '2147483640', left: '50%', top: '70px', transform: 'translateX(-50%)', width: '1120px', maxHeight: '720px', overflow: 'hidden', margin: '0', padding: '18px 22px', borderRadius: '12px', background: '#0d1117', color: '#e6edf3', font: '14px/1.55 ui-monospace,Menlo,monospace', whiteSpace: 'pre-wrap', boxShadow: '0 12px 40px rgba(0,0,0,.35)' })
      document.body.appendChild(box)
    }, `What the assistant reads: walnut_drawing_read (overview)\n\n${overview}\n\nwalnut_drawing_narration {take: 1, part: 1} (detail, when it asks)\n\n${fine}`)
    await video.caption('The assistant reads which element each part of the talk was about')
    await video.hold(6_000)
    await video.stop('drawing-narration')
  }

  // The file sits beside the drawing; the drawing itself was not rewritten by the recording.
  const onDisk = await page.request.get(`/api/drawings/narration?path=${encodeURIComponent(doc.path)}`)
  expect((await onDisk.json() as { takes: number }).takes).toBe(1)
  expect(errors).toEqual([])
})
