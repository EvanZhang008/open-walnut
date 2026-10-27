import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { useSyntheticMic } from './stt-failure-helpers'
import { stubSttStatus } from './voice-selection-helpers'

/**
 * Dictation in a plugin's own text box (`walnut.ui.views.MicButton`, web/src/plugins/views.tsx),
 * as a user meets it, in Chromium and in WebKit (the Mac app's engine: PW_WEBKIT=1 --project webkit).
 *
 * The fixture (plugin-mic-server.ts) links a plugin whose App is one text box with two drafts, the
 * host's mic, a Send and an "Other draft" button. The microphone is synthetic (an oscillator, so
 * WebKit can record at all) and the engine is canned in the page; everything between them is the
 * real host: the recorder, the live drafts, the final pass, the write into the box.
 *
 * What it pins: the mic is drawn in the plugin's row and is on top there; words appear while
 * recording, at the caret between typed parts, and the final text replaces them and brings the focus
 * back with the caret after the words, with nothing sent; a second round adds at the caret; a Send in
 * the middle of a recording stops it, and a Send while the final text is still on its way drops it;
 * switching drafts mid-recording leaves the other draft untouched; with voice not set up, the click
 * opens Settings → Voice.
 */

interface Fixture { port: number }

const SHOTS = process.env.PLUGIN_MIC_SHOTS ?? '/tmp/plugin-mic'
const APP_PATH = '/apps/plugin-mic-fixture~main'
/** What the engine hears while recording, and in the whole clip once stopped. */
const DRAFTED = 'why does phase'
const FULL = 'why does phase two matter so much'
let fixture: Fixture
let child: ChildProcessWithoutNullStreams | null = null

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SHOTS, { recursive: true })
  const port = await reservePort()
  let output = ''
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/plugin-mic-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_PLUGIN_MIC_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await new Promise<Fixture>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Plugin mic fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      const match = /PLUGIN_MIC_READY (\{.*\})/.exec(output)
      if (match) { clearInterval(timer); clearTimeout(deadline); resolve(JSON.parse(match[1]!) as Fixture) }
      else if (child?.exitCode !== null) { clearInterval(timer); clearTimeout(deadline); reject(new Error(`Fixture exited\n${output.slice(-8000)}`)) }
    }, 200)
  })
})

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 20_000))])
  if (!graceful) child.kill('SIGKILL')
})

interface Engine { stopped: boolean; posts: number; hold: Promise<void> | null }

/**
 * The canned engine: live passes hear DRAFTED, and every pass after the stop hears FULL. While `hold`
 * is set, the passes after the stop wait for it: the final text is still on its way.
 */
async function stubEngine(page: Page): Promise<Engine> {
  const engine: Engine = { stopped: false, posts: 0, hold: null }
  await stubSttStatus(page)
  await page.route('**/api/stt/warmup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  const answer = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    engine.posts += 1
    if (engine.stopped && engine.hold) await engine.hold
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: engine.stopped ? FULL : DRAFTED, durationMs: 40 }) })
  }
  await page.route('**/api/stt/draft', answer)
  await page.route('**/api/stt/transcribe', answer)
  await page.route('**/api/stt/save', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"recordingId":"rec-plugin-mic"}' }))
  return engine
}

interface Note { app: Locator; box: Locator; mic: Locator; sent: Locator; errors: string[] }

async function openNote(page: Page): Promise<Note> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-home-chat-visible', '0')
      sessionStorage.removeItem('open-walnut-home-session-columns')
    } catch { /* storage off */ }
  })
  await page.goto(`http://127.0.0.1:${fixture.port}/`)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
  const entry = page.locator(`a[href="${APP_PATH}"]`).first()
  await expect(entry).toBeAttached({ timeout: 60_000 })
  await entry.click()
  const app = page.getByTestId('mic-fixture-app')
  await expect(app).toBeVisible({ timeout: 30_000 })
  return {
    app,
    box: page.getByTestId('mic-fixture-box'),
    mic: page.getByTestId('mic-fixture-row').locator('.plugin-mic-button .mic-btn'),
    sent: page.getByTestId('mic-fixture-sent').locator('li'),
    errors,
  }
}

async function shot(page: Page, name: string, around: Locator): Promise<void> {
  const box = await around.boundingBox()
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({
    path: `${SHOTS}/${engine}-${name}.png`,
    ...(box ? { clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: Math.min(1280, box.width + 32), height: box.height + 32 } } : {}),
  })
}

/** Start a recording and wait until the box reads `expected`, the live words in it. */
async function recordUntilDraft(note: Note, expected: string): Promise<void> {
  await note.mic.click()
  await expect(note.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
  await expect(note.box).toHaveValue(expected, { timeout: 30_000 })
  await expect(note.mic, 'the words came while still recording').toHaveClass(/mic-recording/)
}

test('the mic sits in the plugin\'s own row and is on top there', async ({ page }) => {
  await page.context().grantPermissions(['microphone']).catch(() => undefined)
  await stubEngine(page)
  const note = await openNote(page)
  await expect(note.mic).toBeVisible()
  const rect = await note.mic.boundingBox()
  expect(rect).not.toBeNull()
  const onTop = await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.plugin-mic-button .mic-btn')), { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 })
  expect(onTop, 'nothing covers the mic at its centre').toBe(true)
  const row = await page.getByTestId('mic-fixture-row').boundingBox()
  expect(rect!.y).toBeGreaterThanOrEqual(row!.y - 1)
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(row!.y + row!.height + 1)
  await shot(page, '1-mic-in-row', note.app)
  expect(note.errors).toEqual([])
})

test('dictation fills the box live, then with the final text, at the caret, and sends nothing', async ({ page }) => {
  await useSyntheticMic(page)
  await page.context().grantPermissions(['microphone']).catch(() => undefined)
  const engine = await stubEngine(page)
  const note = await openNote(page)
  // The caret sits between two typed parts: the words go there, not at the end.
  await note.box.fill('Note: done.')
  await note.box.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(5, 5) })

  await recordUntilDraft(note, `Note: ${DRAFTED} done.`)
  await shot(page, '2-live-draft', note.app)
  // The focus went elsewhere meanwhile: the final text brings it back to the box.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(note.box).not.toBeFocused()
  engine.stopped = true
  await note.mic.click()
  await expect(note.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
  await expect(note.box).toHaveValue(`Note: ${FULL} done.`, { timeout: 30_000 })
  await expect(note.box).toBeFocused()
  const after = 'Note: '.length + FULL.length
  await expect.poll(() => note.box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]), { message: 'the caret sits right after the words' }).toEqual([after, after])
  await shot(page, '3-final', note.app)

  // A second round lands at the caret, after the first.
  engine.stopped = false
  await recordUntilDraft(note, `Note: ${FULL} ${DRAFTED} done.`)
  engine.stopped = true
  await note.mic.click()
  await expect(note.box).toHaveValue(`Note: ${FULL} ${FULL} done.`, { timeout: 30_000 })
  await expect(note.sent, 'the mic never sends').toHaveCount(0)
  expect(note.errors).toEqual([])
})

test('a send while the final text is still on its way: the late text never lands', async ({ page }) => {
  await useSyntheticMic(page)
  await page.context().grantPermissions(['microphone']).catch(() => undefined)
  const engine = await stubEngine(page)
  const note = await openNote(page)
  await recordUntilDraft(note, DRAFTED)
  let release = () => {}
  engine.hold = new Promise<void>((resolve) => { release = resolve })
  engine.stopped = true
  const atStop = engine.posts
  await note.mic.click()
  await expect(note.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
  // The stop's final pass has gone out, and the engine is holding it.
  await expect.poll(() => engine.posts > atStop, { timeout: 15_000 }).toBe(true)
  // Sent while the engine still holds the final pass.
  await page.getByTestId('mic-fixture-send').click()
  await expect(note.sent).toHaveCount(1)
  await expect(note.box).toHaveValue('')
  release()
  await page.waitForTimeout(4_000)
  await expect(note.box, 'the final text arrived after the send and was dropped').toHaveValue('')
  await expect(note.sent).toHaveCount(1)
  expect(note.errors).toEqual([])
})

test('a send in the middle of a recording stops it, and no late words land', async ({ page }) => {
  await useSyntheticMic(page)
  await page.context().grantPermissions(['microphone']).catch(() => undefined)
  const engine = await stubEngine(page)
  const note = await openNote(page)
  await note.box.fill('Typed first.')
  await recordUntilDraft(note, `Typed first. ${DRAFTED}`)
  await page.getByTestId('mic-fixture-send').click()
  await expect(note.sent).toHaveCount(1)
  await expect(note.sent.first()).toHaveText(`Typed first. ${DRAFTED}`)
  await expect(note.box).toHaveValue('')
  await expect(page.locator('.mic-recording')).toHaveCount(0, { timeout: 10_000 })
  const posts = engine.posts
  engine.stopped = true
  await page.waitForTimeout(5_000)
  expect(engine.posts, 'no audio posted after the send cut the recording').toBe(posts)
  await expect(note.box).toHaveValue('')
  expect(note.errors).toEqual([])
})

test('switching drafts mid-recording leaves the other draft untouched', async ({ page }) => {
  await useSyntheticMic(page)
  await page.context().grantPermissions(['microphone']).catch(() => undefined)
  const engine = await stubEngine(page)
  const note = await openNote(page)
  await recordUntilDraft(note, DRAFTED)
  await page.getByTestId('mic-fixture-switch').click()
  await expect(page.getByTestId('mic-fixture-draft')).toHaveText('second')
  await expect(page.locator('.mic-recording')).toHaveCount(0, { timeout: 10_000 })
  engine.stopped = true
  await page.waitForTimeout(5_000)
  await expect(note.box, 'nothing of the first draft\'s recording reached the second').toHaveValue('')
  await page.getByTestId('mic-fixture-switch').click()
  await expect(note.box).toHaveValue(DRAFTED)
  expect(note.errors).toEqual([])
})

test('with voice not set up, the mic opens Settings → Voice', async ({ page }) => {
  await page.route('**/api/stt/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ engine: null, available: false }) }))
  const note = await openNote(page)
  await expect(note.mic).toHaveClass(/mic-unconfigured/, { timeout: 15_000 })
  await note.mic.click()
  await expect.poll(() => page.evaluate(() => `${location.pathname}${location.hash}`)).toBe('/settings#stt')
  expect(note.errors).toEqual([])
})
