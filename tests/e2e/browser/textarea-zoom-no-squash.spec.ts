/**
 * A multi-line input keeps its full height under page zoom (Cmd + / Cmd -).
 *
 * The user's report (2026-10-26, Mac app and Chrome): zoomed in, the Ask here
 * card's reply box showed a sliver of its placeholder, cut top and bottom, over
 * a grey horizontal scrollbar, with a small vertical thumb on the right; the
 * inbox letter's reply box and decision note showed the same bar. Cause: WebKit
 * lays an EMPTY textarea's placeholder out at the box width times the zoom, so
 * the box overflows sideways and the UA default `overflow: auto` shows a
 * horizontal bar. The app's WebKit scrollbar is always visible and takes room,
 * so the bar clips a one-line box and overflows it vertically too. The fix
 * is shared (web/src/styles/globals.css): the placeholder is held to the box
 * width, and a textarea never scrolls sideways (it wraps its text).
 *
 * The zoom is CSS `zoom` on the root, changed in place: WebKit's page zoom (what
 * the Mac app's WKWebView does on Cmd +) is the same effective zoom on the root,
 * and a fractional device scale factor does not reproduce it there. Chromium's
 * own browser zoom is a device scale factor, checked in a second test.
 *
 * Fields: the session chat input, the Ask here card's box (a draft question on
 * the tagged fixture session, never sent), the letter reply box and the
 * decision note. Chromium and WebKit (`PW_WEBKIT=1 ... --project webkit`).
 */
import fs from 'node:fs/promises'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { home } from './inbox-items-helpers'
import { centreInHistory, openThreadsSession, resetThreadsFixture, selectPassage } from './threads-helpers'
import { filler, TAGGED_READY, TAGGED_SESSION, TAGGED_TASK } from './threads-fixture'

const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5]
/** The first answer of the tagged session opens with these words, in no question. */
const PHRASE = filler(201, 60).slice(0, 40)
const LONG = 'The rollout finishes when every host has drained its queue and the second copy '
  + 'of the index has been checked against the first one, word for word, twice. '

interface Fit {
  cw: number; sw: number; ch: number; sh: number; oh: number
  overflowX: string; floor: number; maxHeight: number
}

async function shotDir(): Promise<string> {
  const dir = `${process.env.ZOOM_SHOT_DIR ?? '/tmp/textarea-zoom'}/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function setZoom(page: Page, z: number): Promise<void> {
  await page.evaluate((zoom) => { document.documentElement.style.zoom = String(zoom) }, z)
  // Two frames: the layout and any resize work the app does on it.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

async function fit(box: Locator): Promise<Fit> {
  return box.evaluate((t: HTMLTextAreaElement) => {
    const cs = getComputedStyle(t)
    return {
      cw: t.clientWidth, sw: t.scrollWidth, ch: t.clientHeight, sh: t.scrollHeight, oh: t.offsetHeight,
      overflowX: cs.overflowX,
      // One full line of text plus the vertical padding.
      floor: Math.floor(parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)),
      maxHeight: parseFloat(cs.maxHeight) || Infinity,
    }
  })
}

/** No sideways scroll, room for a whole line, and (empty or one line) no vertical scroll. */
async function expectNotSquashed(box: Locator, label: string): Promise<Fit> {
  const f = await fit(box)
  const at = `${label}: ${JSON.stringify(f)}`
  expect(['hidden', 'clip'], at).toContain(f.overflowX)
  // At a fractional zoom a box of 356.2px reads clientWidth 356 and scrollWidth
  // 357: rounding, never a bar (overflow-x is hidden, checked above). The bug
  // overflowed by the zoom: 35px at 110%, 88px at 125%, 175px at 150%.
  expect(f.sw, `${at} overflows sideways`).toBeLessThanOrEqual(f.cw + 1)
  expect(f.ch, `${at} is shorter than one line plus padding`).toBeGreaterThanOrEqual(f.floor)
  // scrollHeight is rounded the same way, so it may read 1px over too.
  expect(f.sh, `${at} scrolls vertically while empty`).toBeLessThanOrEqual(f.ch + 1)
  return f
}

/** A long draft grows to the max and only then scrolls, still never sideways. */
async function expectLongDraftScrollsDown(box: Locator, label: string): Promise<void> {
  const one = (await fit(box)).oh
  await box.fill(LONG.repeat(8))
  await expect.poll(async () => (await fit(box)).oh, { message: `${label} grows` }).toBeGreaterThan(one)
  const f = await fit(box)
  const at = `${label} long: ${JSON.stringify(f)}`
  expect(f.sw, `${at} overflows sideways`).toBeLessThanOrEqual(f.cw + 1)
  expect(f.oh, `${at} stops at its max height`).toBeLessThanOrEqual(Math.ceil(f.maxHeight) + 1)
  expect(f.oh, `${at} did not reach its max height`).toBeGreaterThanOrEqual(Math.floor(f.maxHeight) - 1)
  expect(f.sh, `${at} has nothing to scroll`).toBeGreaterThan(f.ch)
  await box.fill('')
}

async function sendLetter(request: APIRequestContext): Promise<string> {
  const subject = `Zoom squash ${Date.now().toString(36)}-${test.info().project.name}`
  const res = await request.post('/api/v1/human-inbox', {
    data: {
      subject, type: 'action_required',
      markdown: 'Which cache should we keep? Option A halves cold reads. Option B keeps memory flat.',
      actions: [{ id: 'a', label: 'Keep A' }, { id: 'b', label: 'Keep B' }],
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  return subject
}

async function openLetter(page: Page, subject: string): Promise<Locator> {
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const center = page.locator('.notification-panel')
  await center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
  await center.locator('.hib-row').filter({ hasText: subject }).first().locator('.hib-subject').click()
  const reader = page.locator('.hib-reader')
  await expect(reader.locator('.hib-composer-input')).toBeVisible({ timeout: 30_000 })
  await expect(reader.locator('.hib-freetext')).toBeVisible()
  return reader
}

test.describe('multi-line inputs under page zoom', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(300_000)
  test.beforeAll(async ({ request }) => { await resetThreadsFixture(request, TAGGED_SESSION) })
  test.afterAll(async ({ request }) => { await resetThreadsFixture(request, TAGGED_SESSION) })

  test('chat input, Ask here box, letter reply and note: no sideways bar, a whole line, at every zoom', async ({ page, request }) => {
    const dir = await shotDir()
    const subject = await sendLetter(request)
    await page.setViewportSize({ width: 1280, height: 860 })
    await home(page)
    await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })

    // The session column: its chat input, and the Ask here card on a passage.
    const panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear', map: 'default' })
    const chat = panel.locator('.chat-input-textarea')
    await expect(chat).toBeVisible({ timeout: 30_000 })
    await centreInHistory(page, panel, PHRASE, { tolerance: 40 })
    await selectPassage(page, panel, PHRASE)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    const card = panel.locator('.thread-card .thread-card-input')
    await expect(card).toBeVisible({ timeout: 15_000 })

    for (const z of ZOOMS) {
      await setZoom(page, z)
      await expect(card, `the card closed at zoom ${z}`).toBeVisible()
      await expectNotSquashed(chat, `chat @${z}`)
      await expectNotSquashed(card, `card @${z}`)
      await panel.locator('.thread-card-composer').screenshot({ path: `${dir}/card-${z}.png`, scale: 'css' })
      await chat.screenshot({ path: `${dir}/chat-${z}.png`, scale: 'css' })
      if (z === 1 || z === 1.25) {
        await expectLongDraftScrollsDown(chat, `chat @${z}`)
        await expectLongDraftScrollsDown(card, `card @${z}`)
        await expectNotSquashed(card, `card emptied @${z}`)
      }
    }
    await setZoom(page, 1)
    await card.press('Escape')
    await expect(panel.locator('.thread-card')).toHaveCount(0)

    // The letter reader: the reply box and the note beside the choices.
    const reader = await openLetter(page, subject)
    const reply = reader.locator('.hib-composer-input')
    const note = reader.locator('.hib-freetext')
    for (const z of ZOOMS) {
      await setZoom(page, z)
      await expectNotSquashed(reply, `letter reply @${z}`)
      await expectNotSquashed(note, `letter note @${z}`)
      await reader.locator('.hib-composer').screenshot({ path: `${dir}/letter-reply-${z}.png`, scale: 'css' })
      await note.screenshot({ path: `${dir}/letter-note-${z}.png`, scale: 'css' })
    }
    await setZoom(page, 1)
  })

  test('Chromium browser zoom (device scale factor): the letter reply and note keep a whole line', async ({ browser, request, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium zooms by device scale factor; WebKit is covered above')
    const dir = await shotDir()
    const subject = await sendLetter(request)
    for (const z of [0.8, 1.1, 1.25, 1.5]) {
      const context = await browser.newContext({
        baseURL: test.info().project.use.baseURL,
        viewport: { width: Math.round(1280 / z), height: Math.round(860 / z) },
        deviceScaleFactor: 2 * z,
      })
      try {
        const page = await context.newPage()
        await home(page)
        const reader = await openLetter(page, subject)
        await expectNotSquashed(reader.locator('.hib-composer-input'), `letter reply dsf @${z}`)
        await expectNotSquashed(reader.locator('.hib-freetext'), `letter note dsf @${z}`)
        await reader.locator('.hib-composer').screenshot({ path: `${dir}/dsf-letter-reply-${z}.png`, scale: 'css' })
      } finally {
        await context.close()
      }
    }
  })
})
