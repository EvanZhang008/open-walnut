/**
 * Playwright (Chromium, fake camera and microphone): the chat box's Camera
 * (on for everyone; it was the `camera_capture` experiment). The + menu keeps
 * every row it had on its first level and has Camera first in its More flyout;
 * the panel opens above the box with the live picture; each photo goes straight
 * into the box, while recording too; a stopped video goes in once its words are in,
 * and the box's own Send sends it as its file, its stills and what was said; the camera and microphone are off whenever the panel is closed; a
 * refused camera says what to do; a page that cannot open the camera uses the
 * phone's camera app instead.
 *
 * Harness: composer-send-harness.ts (session reads, uploads and the WS send in
 * the page). Speech to text is answered in the page: its engines have their own tests.
 * Fake devices only (fake-mic.ts): no real camera, nothing plays aloud.
 */
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { FILES_LINE, HOST_DIR, PNG, open } from './composer-send-harness'
import { fakeCameraArgs } from './fake-mic'

test.skip(({ browserName }) => browserName !== 'chromium', 'Fake camera and microphone flags are Chromium\'s (Linux WebKit has no MediaRecorder)')
test.use({ launchOptions: { args: fakeCameraArgs() } })
test.describe.configure({ timeout: 240_000 })

const SHOTS = process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'shots') : '/tmp/composer-camera'
const SAID = 'so the request goes into the queue here and the worker retries three times'

/** An old camera_capture choice in the config as this page reads it (never written to the fixture's config). */
async function oldCameraChoice(page: Page, on: boolean) {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    try {
      const res = await route.fetch()
      const body = await res.json() as { config?: { experimental?: Record<string, boolean> } }
      const config = { ...(body.config ?? {}), experimental: { ...(body.config?.experimental ?? {}), camera_capture: on } }
      await route.fulfill({ response: res, json: { ...body, config } })
    } catch { /* the page closed */ }
  })
}

/** Every stream the page opened, so a spec can see the camera and mic are off again. */
async function watchStreams(page: Page, opts: { refuse?: 'NotAllowedError'; noCamera?: boolean; slowMic?: boolean } = {}) {
  await page.addInitScript((o) => {
    const w = window as unknown as { __streams: MediaStream[]; __releaseMic?: () => void; __micAsked?: number }
    w.__streams = []
    w.__micAsked = 0
    const md = navigator.mediaDevices
    if (!md) return
    if (o.noCamera) { Object.defineProperty(md, 'getUserMedia', { value: undefined, configurable: true }); return }
    const orig = md.getUserMedia.bind(md)
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (o.refuse && c?.video) throw new DOMException('Permission denied', o.refuse)
      // The browser's microphone prompt, answered only when the spec says so.
      if (o.slowMic && c?.audio) { w.__micAsked = (w.__micAsked ?? 0) + 1; await new Promise<void>((r) => { w.__releaseMic = r }) }
      const s = await orig(c)
      w.__streams.push(s)
      return s
    }
  }, opts)
}

const liveTracks = (page: Page) => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams
  .flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').map((t) => t.kind).sort())

const composer = (page: Page) => page.locator('.session-panel-input .chat-input-container').last()
const dock = (page: Page) => composer(page).getByTestId('camera-dock')
const plusMenu = (page: Page) => composer(page).locator('.chat-plus-group > .chat-plus-menu').first()

async function openMenu(page: Page) {
  await composer(page).locator('.chat-plus-btn').first().click()
  await expect(plusMenu(page)).toBeVisible()
}

async function rows(page: Page): Promise<string[]> {
  return plusMenu(page).getByRole('menuitem').evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()))
}

const moreFlyout = (page: Page) => page.locator('.chat-plus-more-flyout').last()

/** + menu, then More: the Camera row (the first row there). */
async function cameraRow(page: Page) {
  await openMenu(page)
  await plusMenu(page).getByRole('menuitem', { name: /^\W*More/ }).click()
  await expect(moreFlyout(page)).toBeVisible()
  return moreFlyout(page).getByTestId('plus-menu-camera')
}

async function openCamera(page: Page) {
  await (await cameraRow(page)).click()
}

const send = (page: Page) => composer(page).locator('.chat-input-textarea').first().press('Enter')

async function liveVideoPlays(page: Page) {
  await expect.poll(() => dock(page).getByTestId('camera-live').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0)
}

function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  return composer(page).screenshot({ path: path.join(SHOTS, `camera-${name}.png`) })
}

async function answerSpeech(page: Page) {
  let calls = 0
  await page.route('**/api/stt/transcribe', async (route) => { calls++; await route.fulfill({ json: { text: SAID, engine: 'fake' } }) })
  return () => calls
}

test('Camera is the first row of the + menu\'s More, never on its first level, whatever an old choice says', async ({ page }) => {
  await watchStreams(page)
  await open(page)
  const row = await cameraRow(page)
  const first = await rows(page)
  expect(first[0]).toMatch(/^Attach files or images/)
  expect(first[1]).toBe('Draw')
  expect(first.some((r) => r.startsWith('Camera'))).toBe(false)
  const more = await moreFlyout(page).getByRole('menuitem').evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()))
  expect(more[0]).toMatch(/^Camera\s*Photo or video$/)
  await expect(row).toBeVisible()
  // Opening the menus opened nothing.
  expect(await liveTracks(page)).toEqual([])
  await page.keyboard.press('Escape')

  // The experiment ended on: a camera_capture: false left in the config hides nothing.
  await oldCameraChoice(page, false)
  await watchStreams(page)
  await open(page)
  await expect(await cameraRow(page)).toBeVisible()
})

test('a photo goes straight into the box: no preview step, the panel stays for the next, the box sends them with its words', async ({ page }) => {
  await watchStreams(page)
  const h = await open(page)
  const input = composer(page).locator('.chat-input-textarea').first()
  await input.fill('Look at this whiteboard, what is wrong in the second box?')
  await openCamera(page)
  await expect(dock(page)).toBeVisible()
  await expect(dock(page).getByTestId('camera-on')).toHaveText(/Camera on/)
  await liveVideoPlays(page)
  expect(await liveTracks(page)).toEqual(['video'])
  // The box below still takes words while the camera is on.
  await expect(input).toHaveValue(/second box\?$/)
  // The panel sits above the box.
  const panel = await dock(page).boundingBox()
  const box = await composer(page).locator('.chat-input-box').boundingBox()
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(box!.y + 1)
  await shot(page, 'live')
  await dock(page).getByTestId('camera-shutter').click()
  await expect(composer(page).locator('.chat-image-preview')).toHaveCount(1)
  await expect(dock(page).getByTestId('camera-added')).toHaveText('1 photo added')
  // No preview step: no Retake, Add another or Send, and the camera stays on for the next.
  for (const name of ['Retake', 'Add another', 'Send']) await expect(dock(page).getByRole('button', { name, exact: true })).toHaveCount(0)
  expect((await dock(page).boundingBox())!.height).toBeCloseTo(panel!.height, 0)
  expect(await liveTracks(page)).toEqual(['video'])
  await dock(page).getByTestId('camera-shutter').click()
  await expect(composer(page).locator('.chat-image-preview')).toHaveCount(2)
  await expect(dock(page).getByTestId('camera-added')).toHaveText('2 photos added')
  await shot(page, 'photos-added')
  // Closed with ×: off, and the photos stay in the box.
  await dock(page).getByRole('button', { name: 'Close camera' }).click()
  await expect(dock(page)).toHaveCount(0)
  await expect.poll(() => liveTracks(page)).toEqual([])
  await expect(composer(page).locator('.chat-image-preview')).toHaveCount(2)
  // Nothing was sent until the box's own send.
  expect(await h.sent()).toHaveLength(0)
  await send(page)
  await expect.poll(async () => (await h.sent()).length, { timeout: 30_000 }).toBe(1)
  const [msg] = await h.sent()
  expect(msg.message).toBe('Look at this whiteboard, what is wrong in the second box?')
  expect(msg.imageRefs).toHaveLength(2)
})

test('a video: photos taken while it records, then it goes as its file, its stills and what was said', async ({ page }) => {
  await watchStreams(page)
  const speech = await answerSpeech(page)
  const h = await open(page)
  const input = composer(page).locator('.chat-input-textarea').first()
  await input.fill('Here is the design, check it')
  await openCamera(page)
  await liveVideoPlays(page)
  await dock(page).getByRole('radio', { name: 'Video' }).click()
  await expect(dock(page).getByRole('button', { name: /Sound on/ })).toBeVisible()
  await dock(page).getByTestId('camera-record').click()
  await expect(dock(page).getByTestId('camera-timer')).toHaveText(/0:0[1-9]/, { timeout: 10_000 })
  // The microphone is on only while it records, and the box's own mic waits.
  await expect.poll(() => liveTracks(page)).toEqual(['audio', 'video'])
  await expect(composer(page).locator('.chat-input-controls .mic-btn').first()).toBeDisabled()
  await shot(page, 'recording')
  // A photo while it records: into the box at once, the recording goes on.
  await dock(page).getByTestId('camera-photo-while-recording').click()
  await expect(dock(page).getByTestId('camera-added')).toHaveText('1 photo added')
  await expect(composer(page).locator('.chat-image-preview')).toHaveCount(1)
  await expect(dock(page).getByTestId('camera-stop')).toBeVisible()
  await expect(dock(page).getByTestId('camera-timer')).toHaveText(/0:0[6-9]|0:1\d/, { timeout: 15_000 })
  await dock(page).getByTestId('camera-stop').click()
  // Once its words are in it goes into the box by itself; the camera stays on, the microphone is off.
  await expect(composer(page).locator('.file-card').filter({ hasText: /camera-\d{6}\.(?:mp4|webm)/ })).toHaveCount(1, { timeout: 20_000 })
  await expect(dock(page).getByTestId('camera-added')).toHaveText('1 photo and 1 video added')
  await expect(dock(page).getByTestId('camera-held')).toHaveCount(0)
  await expect.poll(() => liveTracks(page)).toEqual(['video'])
  expect(speech()).toBe(1)
  await shot(page, 'video-added')
  expect(await h.sent()).toHaveLength(0)
  await dock(page).getByRole('button', { name: 'Close camera' }).click()
  await expect.poll(() => liveTracks(page)).toEqual([])
  await send(page)
  await expect.poll(async () => (await h.sent()).length, { timeout: 60_000 }).toBe(1)
  const [msg] = await h.sent()
  const lines = msg.message.split('\n')
  expect(lines[0]).toBe(FILES_LINE)
  expect(lines[1]).toMatch(new RegExp(`^- ${HOST_DIR}/up-[^/]+/camera-\\d{6}\\.(?:mp4|webm)$`))
  expect(lines[3]).toMatch(/^\[Video stills — frames of camera-\d{6}\.(?:mp4|webm) \(0:\d\d\), time in each name; use the Read tool to view them\]$/)
  const stills = lines.filter((l) => /-still-\dm\d\ds\.jpg$/.test(l))
  // At least the first, at 0:00. Which others go is pickStills' (tests/web/chat-camera-model.test.ts):
  // under automation the page silencer holds every <video> paused (src/lib/automation-silence.ts),
  // so this preview shows one frame and a recording here has nothing else that changed.
  expect(stills.length).toBeGreaterThanOrEqual(1)
  expect(stills[0]).toMatch(/-still-0m00s\.jpg$/)
  expect(msg.message).toContain(`[Video narration — what was said in `)
  expect(msg.message).toContain(`- ${SAID}\n\nHere is the design, check it`)
  expect(msg.imageRefs).toHaveLength(1)
})

test('a sent video shows in the chat as its card, with the stills and the words the AI was given', async ({ page }) => {
  const video = `${HOST_DIR}/up-1/camera-141605.mp4`
  const text = `${FILES_LINE}\n- ${video}\n\n`
    + `[Video stills — frames of camera-141605.mp4 (0:42), time in each name; use the Read tool to view them]\n- ${HOST_DIR}/up-2/camera-141605-still-0m00s.jpg\n- ${HOST_DIR}/up-3/camera-141605-still-0m12s.jpg\n\n`
    + `[Video narration — what was said in camera-141605.mp4]\n- ${SAID}\n\n`
    + 'check the board'
  await open(page, [{ role: 'user', text, timestamp: '2026-01-01T00:01:00.000Z' }])
  const bubble = page.locator('.session-history .session-msg-user').filter({ hasText: 'check the board' }).last()
  await expect(bubble.locator('.file-card')).toHaveCount(1)
  await expect(bubble.locator('.file-card')).toContainText('camera-141605.mp4')
  await expect(bubble.locator('.file-card')).toContainText('2 stills · what was said')
  const clip = bubble.getByTestId('message-clip')
  await expect(clip.locator('img.message-attachment-still')).toHaveCount(2)
  await expect(clip.locator('img.message-attachment-still').first()).toHaveAttribute('alt', 'camera-141605-still-0m00s.jpg')
  // The words are one click away, never the raw header blocks.
  await expect(bubble).not.toContainText(/Video (?:stills|narration)/)
  await expect(clip.getByText(SAID)).toBeHidden()
  await clip.locator('summary', { hasText: 'What was said' }).click()
  await expect(clip.getByText(SAID)).toBeVisible()
  await bubble.screenshot({ path: path.join(SHOTS, 'camera-sent-bubble.png') }).catch(() => undefined)
})

test('a refused camera says what to do, and Pick a file instead opens the picker', async ({ page }) => {
  await watchStreams(page, { refuse: 'NotAllowedError' })
  await open(page)
  await openCamera(page)
  const refused = dock(page).getByTestId('camera-refused')
  await expect(refused).toContainText('Walnut can’t use the camera')
  await expect(refused).toContainText('Allow the camera for this site')
  await shot(page, 'refused')
  await refused.getByRole('button', { name: 'Try again' }).click()
  await expect(refused).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await refused.getByRole('button', { name: 'Pick a file instead' }).click()
  await chooser
  await expect(dock(page)).toHaveCount(0)
})

test('a page that cannot open the camera hands it to the phone camera app', async ({ page }) => {
  await watchStreams(page, { noCamera: true })
  await open(page)
  const row = await cameraRow(page)
  await expect(row).toContainText('Opens the phone camera')
  const chooser = page.waitForEvent('filechooser')
  await row.click()
  const picker = await chooser
  expect(await picker.element().getAttribute('capture')).toBe('environment')
  await picker.setFiles({ name: 'IMG_0001.png', mimeType: 'image/png', buffer: PNG })
  await expect(composer(page).locator('.chat-image-preview')).toHaveCount(1)
})

test('a hidden page closes the camera', async ({ page }) => {
  await watchStreams(page)
  await open(page)
  await openCamera(page)
  await liveVideoPlays(page)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(dock(page)).toHaveCount(0)
  await expect.poll(() => liveTracks(page)).toEqual([])
})

test('closing the panel while the browser asks for the microphone leaves nothing on, and Record waits for the answer', async ({ page }) => {
  await watchStreams(page, { slowMic: true })
  await open(page)
  await openCamera(page)
  await liveVideoPlays(page)
  await dock(page).getByRole('radio', { name: 'Video' }).click()
  await dock(page).getByTestId('camera-record').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __micAsked: number }).__micAsked)).toBe(1)
  // A second click while the prompt is up starts no second recording.
  await expect(dock(page).getByTestId('camera-record')).toBeDisabled()
  await dock(page).getByRole('button', { name: 'Close camera' }).click()
  await expect(dock(page)).toHaveCount(0)
  // The person allows the microphone after the panel is gone.
  await page.evaluate(() => (window as unknown as { __releaseMic: () => void }).__releaseMic())
  await expect.poll(() => liveTracks(page)).toEqual([])
  await page.waitForTimeout(1500)
  expect(await liveTracks(page)).toEqual([])
  await expect(composer(page).locator('.file-card')).toHaveCount(0)
})

test('a video the box cannot take (its files are full) stays in the panel to add again, and nothing is sent', async ({ page }) => {
  await watchStreams(page)
  await answerSpeech(page)
  const h = await open(page)
  await composer(page).getByTestId('composer-file-input').setInputFiles(
    Array.from({ length: 10 }, (_, i) => ({ name: `notes-${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`note ${i}`) })),
  )
  await expect(composer(page).locator('.file-card')).toHaveCount(10)
  await openCamera(page)
  await liveVideoPlays(page)
  await dock(page).getByRole('radio', { name: 'Video' }).click()
  await dock(page).getByRole('button', { name: /Sound on/ }).click()
  await dock(page).getByTestId('camera-record').click()
  await expect(dock(page).getByTestId('camera-timer')).toHaveText(/0:0[2-9]/, { timeout: 10_000 })
  await dock(page).getByTestId('camera-stop').click()
  await expect(composer(page)).toContainText('Only 10 files fit in one message')
  const held = dock(page).getByTestId('camera-held')
  await expect(held).toContainText('The video is not in the message yet')
  // Nothing to aim at while it waits: the camera is off.
  await expect.poll(() => liveTracks(page)).toEqual([])
  // Make room, then add it again: the same recording goes in.
  await composer(page).getByRole('button', { name: 'Remove notes-0.txt' }).click()
  await expect(composer(page).locator('.file-card')).toHaveCount(9)
  await held.getByRole('button', { name: 'Add the video' }).click()
  await expect(composer(page).locator('.file-card').filter({ hasText: /camera-\d{6}\.(?:mp4|webm)/ })).toHaveCount(1)
  await expect(held).toHaveCount(0)
  expect(await h.sent()).toHaveLength(0)
})

test('a still that failed to upload is retried on its own: the video does not go up again', async ({ page }) => {
  await watchStreams(page)
  const h = await open(page)
  h.setPlan((name, attempt) => (/-still-0m00s\.jpg$/.test(name) && attempt === 1
    ? { status: 507, body: { error: { code: 'host_disk_full', message: "The session's host does not have room for this file." } } }
    : { status: 200 }))
  await openCamera(page)
  await liveVideoPlays(page)
  await dock(page).getByRole('radio', { name: 'Video' }).click()
  await dock(page).getByRole('button', { name: /Sound on/ }).click()
  await dock(page).getByTestId('camera-record').click()
  await expect(dock(page).getByTestId('camera-timer')).toHaveText(/0:0[2-9]/, { timeout: 10_000 })
  await dock(page).getByTestId('camera-stop').click()
  const video = composer(page).locator('.file-card').filter({ hasText: /camera-\d{6}\.(?:mp4|webm)/ })
  await expect(video).toHaveClass(/is-failed/, { timeout: 20_000 })
  const name = (await video.textContent())!.match(/camera-\d{6}\.(?:mp4|webm)/)![0]
  const videoChunks = () => h.chunks.filter((c) => c.url.includes(`name=${encodeURIComponent(name)}`)).length
  const before = videoChunks()
  expect(before).toBeGreaterThan(0)
  // The box draws again (a new upload target object each time) before the retry.
  await composer(page).locator('.chat-input-textarea').first().fill('redraw')
  await video.getByRole('button', { name: `Retry uploading ${name}` }).click()
  await expect(video).not.toHaveClass(/is-failed/, { timeout: 20_000 })
  await expect(video).toContainText(/\d+ stills?/)
  expect(videoChunks()).toBe(before)
  expect(h.chunks.filter((c) => /-still-0m00s\.jpg/.test(c.url))).toHaveLength(2)
})

test('closing the panel while a video waits for its words still puts the video in the message', async ({ page }) => {
  await watchStreams(page)
  // Speech to text that never answers while the spec looks.
  await page.route('**/api/stt/transcribe', () => { /* held */ })
  const h = await open(page)
  await openCamera(page)
  await liveVideoPlays(page)
  await dock(page).getByRole('radio', { name: 'Video' }).click()
  await dock(page).getByTestId('camera-record').click()
  await expect(dock(page).getByTestId('camera-timer')).toHaveText(/0:0[2-9]/, { timeout: 10_000 })
  await dock(page).getByTestId('camera-stop').click()
  await expect(dock(page).getByTestId('camera-held')).toContainText('Adding the video once its words are in')
  await expect.poll(() => liveTracks(page)).toEqual([])
  await dock(page).getByRole('button', { name: 'Close camera' }).click()
  await expect(dock(page)).toHaveCount(0)
  const video = composer(page).locator('.file-card').filter({ hasText: /camera-\d{6}\.(?:mp4|webm)/ })
  await expect(video).toHaveCount(1, { timeout: 20_000 })
  await expect.poll(() => liveTracks(page)).toEqual([])
  expect(await h.sent()).toHaveLength(0)
})
