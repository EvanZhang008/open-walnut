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
 *   a full memory                              a page holding a large heap and making garbage
 *                                              while the keys go in, so collections run mid-word
 *   a box replaced under the caret             a composer removed and put back while the person
 *                                              types (the 2026-11-11 record: 3 keys on the page
 *                                              body): the keys after it go into the new box
 *   a box that stays but loses the caret       the 2026-11-12 record: 3 to 8 keys on the body
 *                                              after a send, the box still there. Every way code
 *                                              takes the caret from a box it keeps (a blur(), a
 *                                              neighbour that took focus and went away, a focus
 *                                              moved to the body) gives it back at the next key;
 *                                              a person's click keeps their choice, and a box
 *                                              that cannot take text is named in the record
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
  keys: number; inserted: number; prevented: number; dropped: number; overwrites: number; offBox: number; rescued: number
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
/** A page near its memory limit: a large live heap, and garbage made every 50 ms, so the
 *  collector runs while the keys go in. */
async function fillMemory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __heap: unknown[]; __churn: number }
    w.__heap = []
    for (let i = 0; i < 1_500_000; i++) w.__heap.push({ i, s: `row ${i}` })
    w.__churn = window.setInterval(() => { let a: unknown[] = []; for (let i = 0; i < 200_000; i++) a.push({ i }); a = [] }, 50)
  })
}
const freeMemory = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __heap: unknown[]; __churn: number }
  window.clearInterval(w.__churn); w.__heap = []
})
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

test('a session column composer keeps every key while the page is short of memory', async ({ page }) => {
  test.setTimeout(240_000)
  await seedColumns(page, ['pw-normal-session'])
  await loadHome(page)
  const box = page.locator(`${REAL_PANEL} textarea.chat-input-textarea`).first()
  await expect(box).toBeVisible({ timeout: 30_000 })
  await fillMemory(page)
  try {
    await expectEveryKey(page, box)
  } finally {
    await freeMemory(page)
  }
})

test('keys typed after the composer is replaced under the caret go into the new box', async ({ page }) => {
  test.setTimeout(120_000)
  await seedColumns(page, ['pw-normal-session'])
  await loadHome(page)
  const box = page.locator(`${REAL_PANEL} textarea.chat-input-textarea`).first()
  await expect(box).toBeVisible({ timeout: 30_000 })
  await box.click()
  await box.fill('')
  await page.keyboard.type('hello ', { delay: 0 })
  const before = await integrity(page)
  // What a re-mount does: the focused box leaves the page and one with the same draft key and
  // text takes its place, so the caret is on the body.
  const onBody = await box.evaluate((old: HTMLTextAreaElement) => {
    const fresh = old.cloneNode() as HTMLTextAreaElement
    fresh.value = old.value
    fresh.dataset.pwReplaced = '1'
    old.parentElement!.insertBefore(fresh, old)
    old.remove()
    return document.activeElement === document.body
  })
  expect(onBody).toBe(true)
  await page.keyboard.type('world', { delay: 0 })
  const fresh = page.locator('textarea[data-pw-replaced="1"]')
  await expect(fresh).toHaveValue('hello world')
  await page.waitForTimeout(1_200)
  const after = await integrity(page)
  expect({ rescued: after.rescued - before.rescued, offBox: after.offBox - before.offBox, dropped: after.dropped - before.dropped })
    .toEqual({ rescued: 1, offBox: 0, dropped: 0 })
})

/** Ways code takes the caret from a composer it keeps on the page; each leaves it on the body
 *  (run in the page by name, so the page's script policy never sees generated code). */
const CARET_TAKERS = ['a blur()', 'a neighbour that took focus and went away', 'a focus moved to the body'] as const
type Taker = typeof CARET_TAKERS[number] | 'a disable'

async function typedThenLost(page: Page, way: Taker): Promise<{ box: Locator; before: Integrity }> {
  await seedColumns(page, ['pw-normal-session'])
  await loadHome(page)
  const box = page.locator(`${REAL_PANEL} textarea.chat-input-textarea`).first()
  await expect(box).toBeVisible({ timeout: 30_000 })
  await box.click()
  await box.fill('')
  await page.keyboard.type('hello ', { delay: 0 })
  const before = await integrity(page)
  const onBody = await box.evaluate((el: HTMLTextAreaElement, w: string) => {
    if (w === 'a blur()') el.blur()
    else if (w === 'a neighbour that took focus and went away') {
      const b = document.createElement('button')
      el.parentElement!.appendChild(b)
      b.focus()
      b.remove()
    } else if (w === 'a focus moved to the body') { el.blur(); document.body.focus() }
    else if (w === 'a disable') { el.disabled = true; el.blur() }
    return document.activeElement === document.body || document.activeElement === null
  }, way)
  expect(onBody).toBe(true)
  return { box, before }
}

for (const way of CARET_TAKERS) {
  test(`keys typed after ${way} took the caret go back into the composer`, async ({ page }) => {
    test.setTimeout(120_000)
    const { box, before } = await typedThenLost(page, way)
    await page.keyboard.type('world', { delay: 0 })
    await expect(box).toHaveValue('hello world')
    await page.waitForTimeout(1_200)
    const after = await integrity(page)
    expect({ rescued: after.rescued - before.rescued, offBox: after.offBox - before.offBox, dropped: after.dropped - before.dropped })
      .toEqual({ rescued: 1, offBox: 0, dropped: 0 })
  })
}

test('a person who clicks away after typing keeps the caret where they put it', async ({ page }) => {
  test.setTimeout(120_000)
  await seedColumns(page, ['pw-normal-session'])
  await loadHome(page)
  const box = page.locator(`${REAL_PANEL} textarea.chat-input-textarea`).first()
  await expect(box).toBeVisible({ timeout: 30_000 })
  await box.click()
  await box.fill('')
  await page.keyboard.type('hello ', { delay: 0 })
  // A press on a part of the page that takes no focus: the caret leaves the box by their hand.
  await page.evaluate(() => {
    const pad = document.createElement('div')
    pad.id = 'pw-pad'
    Object.assign(pad.style, { position: 'fixed', left: '0', top: '0', width: '40px', height: '40px', zIndex: '99999' })
    document.body.appendChild(pad)
  })
  await page.locator('#pw-pad').click()
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur() })
  await page.keyboard.type('x', { delay: 0 })
  await expect(box).toHaveValue('hello ')
  const after = await integrity(page)
  expect(after.offBoxAt.some((at) => at.includes('(after a click)'))).toBe(true)
})

test('the typing record names a composer that lost the caret and cannot take it back', async ({ page }) => {
  test.setTimeout(120_000)
  const { box, before } = await typedThenLost(page, 'a disable')
  await page.keyboard.type('world', { delay: 0 })
  await expect(box).toHaveValue('hello ')
  const after = await integrity(page)
  expect(after.offBox - before.offBox).toBe(5)
  expect(after.offBoxAt.some((at) => at.includes('(box disabled)'))).toBe(true)
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
