/**
 * Shared by send-waits-for-dictation.spec.ts (Chromium) and
 * send-waits-for-dictation.webkit.spec.ts (the Mac app's engine).
 *
 * 2026-11-01, the user: "currently send doesn't wait the voice button I think it
 * should wait, and send afterward". Send pressed while the mic records (or while
 * its words are still being transcribed) stops the recording, waits for the final
 * words, puts them in the box and sends the whole message once. A second press or
 * Esc cancels the wait and keeps the words; a failed transcription sends nothing.
 *
 * The microphone is synthetic (stt-failure-helpers.ts `useSyntheticMic`), the rest
 * is the real app. The engine is canned and HELD from the moment Send is pressed,
 * so the test sees the wait itself before it lets the final words through.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { openSession, stubSttStatus } from './voice-selection-helpers'
import { useSyntheticMic } from './stt-failure-helpers'

export const SHOTS = '/tmp/send-waits-for-dictation/shots'
/** What the live preview shows while recording. */
const DRAFTED = 'deploy the'
/** What the final pass hears in the whole clip. */
const FULL = 'deploy the build to staging tonight'
const TYPED = 'Note:'

async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  // Evidence only: a screenshot slowed by a loaded machine must not fail the scenario.
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, timeout: 15_000 }).catch(() => {})
}

interface Lane {
  /** Requests after this point wait for `release()`. */
  held: boolean
  /** The held passes answer 500 instead of FULL. */
  fail: boolean
  parked: Array<() => void>
  release: () => void
}

async function stubEngine(page: Page): Promise<Lane> {
  const lane: Lane = {
    held: false,
    fail: false,
    parked: [],
    release: () => { lane.held = false; for (const go of lane.parked.splice(0)) go() },
  }
  await stubSttStatus(page)
  await page.route('**/api/stt/warmup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  const answer = async (route: Parameters<Parameters<Page['route']>[1]>[0], drafting: boolean) => {
    if (lane.held) await new Promise<void>((go) => lane.parked.push(go))
    else if (drafting) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: DRAFTED, durationMs: 40 }) })
      return
    }
    if (lane.fail) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fetch failed' }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: FULL, durationMs: 60 }) })
  }
  await page.route('**/api/stt/draft', (route) => answer(route, true))
  await page.route('**/api/stt/transcribe', (route) => answer(route, false))
  await page.route('**/api/stt/save', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recordingId: 'rec-sendwait-1', debugAudioPath: '/tmp/rec-sendwait-1.webm' }) }))
  return lane
}

interface Composer { panel: Locator; mic: Locator; textarea: Locator; send: Locator; bubble: Locator; sent: string[] }

async function openComposer(page: Page, sid: string, taskId: string): Promise<Composer> {
  const sent: string[] = []
  page.on('websocket', (socket) => socket.on('framesent', (frame) => {
    if (typeof frame.payload !== 'string') return
    try {
      const row = JSON.parse(frame.payload) as { method?: string; payload?: { sessionId?: string; message?: string } }
      if (row.method === 'session:send' && row.payload?.sessionId === sid) sent.push(row.payload.message ?? '')
    } catch { /* not JSON */ }
  }))
  // The dictation's own log lines, printed with the run: what the stop decided and when the send went.
  page.on('console', (m) => { if (/\[stt\]/.test(m.text())) console.log(`[send-waits] ${m.text()}`) })
  await page.goto('/')
  const panel = await openSession(page, sid, taskId)
  return {
    panel,
    mic: panel.locator('.mic-btn-wrapper .mic-btn').first(),
    textarea: panel.locator('.chat-input-textarea').first(),
    send: panel.locator('.chat-send-btn-icon').first(),
    bubble: panel.locator('.mic-error-bubble').first(),
    sent,
  }
}

/** Type a few words, start the mic and wait for the live preview after them. */
async function typeThenDictate(c: Composer): Promise<void> {
  await c.textarea.click()
  await c.textarea.fill(TYPED)
  await c.mic.click()
  await expect(c.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
  await expect(c.textarea).toHaveValue(`${TYPED} ${DRAFTED}`, { timeout: 15_000 })
}

async function expectWaiting(c: Composer): Promise<void> {
  await expect(c.send).toHaveAttribute('data-dictation-wait', 'true')
  await expect(c.send).toBeEnabled()
  await expect(c.mic).not.toHaveClass(/mic-recording/, { timeout: 10_000 })
}

export function registerSendWaitsScenarios(sid: string, taskId: string): void {
  // One session per engine, and its composer draft is synced across windows: the
  // scenarios run one after another, never side by side on the same composer.
  test.describe.configure({ mode: 'default' })

  test('Send while recording waits for the final words and sends the whole message once, twice in a row', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const lane = await stubEngine(page)
    const c = await openComposer(page, sid, taskId)

    for (const round of [1, 2]) {
      await typeThenDictate(c)
      lane.held = true
      await c.send.click()
      await expectWaiting(c)
      await shot(page, `click-${round}-waiting`)
      // Nothing goes out while the words are still coming.
      await page.waitForTimeout(600)
      expect(c.sent).toHaveLength(round - 1)
      lane.release()
      await expect.poll(() => c.sent.length, { timeout: 20_000 }).toBe(round)
      expect(c.sent[round - 1]).toBe(`${TYPED} ${FULL}`)
      await expect(c.textarea).toHaveValue('')
      await expect(c.send).not.toHaveAttribute('data-dictation-wait', 'true')
      await shot(page, `click-${round}-sent`)
    }
    // No late copy of the words comes back into the empty box, and nothing is sent twice.
    await page.waitForTimeout(1500)
    await expect(c.textarea).toHaveValue('')
    expect(c.sent).toHaveLength(2)
  })

  test('Enter while recording waits the same way', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const lane = await stubEngine(page)
    const c = await openComposer(page, sid, taskId)

    await typeThenDictate(c)
    lane.held = true
    await c.textarea.press('Enter')
    await expectWaiting(c)
    expect(c.sent).toHaveLength(0)
    lane.release()
    await expect.poll(() => c.sent.length, { timeout: 20_000 }).toBe(1)
    expect(c.sent[0]).toBe(`${TYPED} ${FULL}`)
    await expect(c.textarea).toHaveValue('')
  })

  test('a second press cancels the wait: the words land in the box, unsent, and Send then sends them', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const lane = await stubEngine(page)
    const c = await openComposer(page, sid, taskId)

    await typeThenDictate(c)
    lane.held = true
    await c.send.click()
    await expectWaiting(c)
    await c.send.click()
    await expect(c.send).not.toHaveAttribute('data-dictation-wait', 'true')
    lane.release()
    await expect(c.textarea).toHaveValue(`${TYPED} ${FULL}`, { timeout: 20_000 })
    await page.waitForTimeout(800)
    expect(c.sent).toHaveLength(0)
    await shot(page, 'cancel-press-kept')

    await c.send.click()
    await expect.poll(() => c.sent.length, { timeout: 10_000 }).toBe(1)
    expect(c.sent[0]).toBe(`${TYPED} ${FULL}`)
  })

  test('Esc cancels the wait and keeps the words', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const lane = await stubEngine(page)
    const c = await openComposer(page, sid, taskId)

    await typeThenDictate(c)
    lane.held = true
    await c.textarea.press('Enter')
    await expectWaiting(c)
    await page.keyboard.press('Escape')
    await expect(c.send).not.toHaveAttribute('data-dictation-wait', 'true')
    lane.release()
    await expect(c.textarea).toHaveValue(`${TYPED} ${FULL}`, { timeout: 20_000 })
    await page.waitForTimeout(800)
    expect(c.sent).toHaveLength(0)
    // The panel is still open: Esc went to the wait, not to the page.
    await expect(c.panel).toBeVisible()
  })

  test('a failed transcription sends nothing and shows the error, with the text kept', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const lane = await stubEngine(page)
    const c = await openComposer(page, sid, taskId)

    await typeThenDictate(c)
    lane.held = true
    lane.fail = true
    await c.send.click()
    await expectWaiting(c)
    lane.release()
    await expect(c.bubble).toBeVisible({ timeout: 20_000 })
    await expect(c.send).not.toHaveAttribute('data-dictation-wait', 'true')
    await expect(c.textarea).toHaveValue(`${TYPED} ${DRAFTED}`)
    await page.waitForTimeout(800)
    expect(c.sent).toHaveLength(0)
    await shot(page, 'failed-kept')
  })

  test('Send pressed after the mic was stopped, while its words are still coming, waits too', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const lane = await stubEngine(page)
    const c = await openComposer(page, sid, taskId)

    await typeThenDictate(c)
    lane.held = true
    await c.mic.click()
    await expect(c.mic).toHaveClass(/mic-transcribing/, { timeout: 10_000 })
    await c.send.click()
    await expect(c.send).toHaveAttribute('data-dictation-wait', 'true')
    expect(c.sent).toHaveLength(0)
    lane.release()
    await expect.poll(() => c.sent.length, { timeout: 20_000 }).toBe(1)
    expect(c.sent[0]).toBe(`${TYPED} ${FULL}`)
  })

  test('with no dictation, Send sends at once', async ({ page }) => {
    test.setTimeout(90_000)
    await useSyntheticMic(page)
    await stubEngine(page)
    const c = await openComposer(page, sid, taskId)
    await c.textarea.click()
    await c.textarea.fill('plain typed message')
    await c.send.click()
    await expect.poll(() => c.sent.length, { timeout: 10_000 }).toBe(1)
    expect(c.sent[0]).toBe('plain typed message')
    await expect(c.send).not.toHaveAttribute('data-dictation-wait', 'true')
  })
}
