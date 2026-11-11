/**
 * Every key typed fast into a composer reaches it (2026-11-10, the user in the Mac app: "all of
 * a sudden walnut can only type slow, if fast walnut lost text in the input ... it should always
 * be super smooth, did we hook anything to the input").
 *
 *   a session column's box and the draft box   every one of 220 keys is in the box, typed with
 *                                              no delay, while the page's main thread is busy
 *                                              (300 ms of work every 400 ms, what the Mac app's
 *                                              page showed while he typed), and in a burst of
 *                                              keys sent without waiting for each other
 *   the window's own record                    web/src/utils/typing-integrity.ts counts no key
 *                                              prevented, dropped, overwritten or typed after
 *                                              the box lost the caret
 *   a slow machine                             Chromium with its CPU throttled 6x (what an
 *                                              overloaded Mac does to the page), the same keys
 *   the record itself                          a handler that eats every 10th key and code that
 *                                              cuts what was just typed are both caught, with
 *                                              the code that did it named, so the record a
 *                                              window sends to the log can be trusted
 *
 * Run on WebKit for the Mac app: PW_WEBKIT=1 bun x playwright test composer-fast-typing --project webkit
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { draftComposer, loadHome, openDraft, REAL_PANEL, seedColumns } from './draft-helpers'

interface Integrity {
  keys: number; inserted: number; prevented: number; dropped: number; overwrites: number; offBox: number
  preventedBy: string[]; overwrittenBy: string[]; offBoxAt: string[]
}

const TEXT = 'the quick brown fox jumps over the lazy dog 0123456789 '.repeat(4)

const integrity = (page: Page) => page.evaluate(() => (window as unknown as { __walnutTypingIntegrity: () => Integrity }).__walnutTypingIntegrity())

/** Keep the main thread busy the way a heavy render does: `ms` of work every `ms + 100`. */
async function busyMainThread(page: Page, ms: number): Promise<void> {
  await page.evaluate((m) => {
    (window as unknown as { __busy: number }).__busy = window.setInterval(() => { const t = performance.now(); while (performance.now() - t < m) { /* work */ } }, m + 100)
  }, ms)
}
const idleMainThread = (page: Page) => page.evaluate(() => window.clearInterval((window as unknown as { __busy: number }).__busy))

async function typeFast(page: Page, box: Locator, burst: boolean): Promise<string> {
  await box.click()
  await box.fill('')
  if (burst) await Promise.all([...TEXT].map((c) => page.keyboard.press(c === ' ' ? 'Space' : c)))
  else await page.keyboard.type(TEXT, { delay: 0 })
  // Every key the engine still holds lands before the box is read.
  await expect.poll(() => box.inputValue(), { timeout: 15_000 }).toHaveLength(TEXT.length)
  return box.inputValue()
}

async function expectEveryKey(page: Page, box: Locator): Promise<void> {
  const before = await integrity(page)
  for (const burst of [false, true]) {
    for (const busy of [false, true]) {
      if (busy) await busyMainThread(page, 300)
      const got = await typeFast(page, box, burst)
      if (busy) await idleMainThread(page)
      expect(got, `burst=${burst} busy=${busy}`).toBe(TEXT)
    }
  }
  // The keys' own ends settle a second after the last one.
  await page.waitForTimeout(1_200)
  const after = await integrity(page)
  expect(after.keys - before.keys).toBeGreaterThanOrEqual(TEXT.length * 4)
  expect({ prevented: after.prevented, dropped: after.dropped, overwrites: after.overwrites, offBox: after.offBox, by: [...after.preventedBy, ...after.overwrittenBy, ...after.offBoxAt] })
    .toEqual({ prevented: 0, dropped: 0, overwrites: 0, offBox: 0, by: [] })
  await box.fill('')
}

test('a session column composer keeps every key typed fast, busy page or not', async ({ page }) => {
  test.setTimeout(180_000)
  await seedColumns(page, ['pw-normal-session'])
  await loadHome(page)
  const box = page.locator(`${REAL_PANEL} textarea.chat-input-textarea`).first()
  await expect(box).toBeVisible({ timeout: 30_000 })
  await expectEveryKey(page, box)
})

test('the draft composer keeps every key typed fast, busy page or not', async ({ page }) => {
  test.setTimeout(180_000)
  await loadHome(page)
  await openDraft(page)
  const box = draftComposer(page)
  await expect(box).toBeVisible()
  await expectEveryKey(page, box)
})

test('a session column composer keeps every key with the CPU throttled 6x (Chromium)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CPU throttling is a Chromium DevTools control; WebKit runs the busy-thread cases above')
  test.setTimeout(240_000)
  await seedColumns(page, ['pw-normal-session'])
  await loadHome(page)
  const box = page.locator(`${REAL_PANEL} textarea.chat-input-textarea`).first()
  await expect(box).toBeVisible({ timeout: 30_000 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  try {
    await expectEveryKey(page, box)
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  }
})

test('the typing record names a handler that eats keys and code that cuts typed text', async ({ page }) => {
  test.setTimeout(120_000)
  await seedColumns(page, ['pw-normal-session'])
  await loadHome(page)
  const box = page.locator(`${REAL_PANEL} textarea.chat-input-textarea`).first()
  await expect(box).toBeVisible({ timeout: 30_000 })
  const before = await integrity(page)

  // Every 10th printable key is eaten by a page handler.
  await page.evaluate(() => {
    let n = 0
    window.addEventListener('keydown', function eatEveryTenthKey(e) {
      if (e.key.length === 1 && ++n % 10 === 0) e.preventDefault()
    }, true)
  })
  await box.click()
  await page.keyboard.type('abcdefghijklmnopqrst', { delay: 5 })
  await expect(box).toHaveValue('abcdefghiklmnopqrs')
  await page.waitForTimeout(1_200)
  let now = await integrity(page)
  expect(now.prevented - before.prevented).toBe(2)
  expect(now.preventedBy.join('\n')).toContain('eatEveryTenthKey')

  // Code that puts an older value back while the person types.
  await box.fill('')
  await page.keyboard.type('hello world', { delay: 5 })
  await box.evaluate(function putOlderTextBack(el: HTMLTextAreaElement) { el.value = 'hello' })
  now = await integrity(page)
  expect(now.overwrites - before.overwrites).toBe(1)
  expect(now.overwrittenBy.join('\n')).toContain('putOlderTextBack')
  await box.fill('')
})
