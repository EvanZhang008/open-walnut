/**
 * Completing a task from its session column's header closes that column, the ordinary way (the
 * sessions area's own removal fades it and the neighbours take the width), and an Undo puts the
 * task's phase and the column back where they were.
 *
 * The person used to complete the task and then click × on the same column. They also sometimes
 * want to look at a column after they shut it, so the close is not silent: the toast says how to
 * take it back.
 *
 * Real UI throughout (the fixture's three long-transcript columns, the real ring, the real
 * toast). Two things are injected, both on the test side: the server refusing a completion (the
 * UI's PATCH has no business rule that refuses it), and a HOLD on the 400ms tick between the click
 * and the close, so a test that must act "during the tick" is not at the mercy of how fast the
 * machine is (a step takes seconds at load 100+).
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { homeColumns, loadHome, seedColumns, setPanelMode } from './draft-helpers'

const KEYS = ['a', 'b', 'c'] as const
type Key = (typeof KEYS)[number]
const SID = (k: Key) => `pw-close-${k}-session`
const TID = (k: Key) => `pw-task-close-${k}`
const SHOTS = '/tmp/column-complete-close'

const col = (page: Page, k: Key) => page.locator(`.main-page-session-column[data-column-id="${SID(k)}"]`)
const ring = (page: Page, k: Key) => col(page, k).locator('.task-quick-phase-btn')
const undoToast = (page: Page) => page
  .locator('.notification-toast--success', { hasText: 'Task completed' })
  .filter({ has: page.locator('.notification-toast-action', { hasText: 'Undo' }) })
const undoButton = (page: Page) => undoToast(page).locator('.notification-toast-action', { hasText: 'Undo' })

async function order(page: Page): Promise<string[]> {
  return homeColumns(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-column-id') ?? ''))
}
async function widths(page: Page): Promise<Record<string, number>> {
  return homeColumns(page).evaluateAll((els) => Object.fromEntries(els.map((el) => [el.getAttribute('data-column-id') ?? '', el.getBoundingClientRect().width])))
}
async function phase(page: Page, k: Key): Promise<string | undefined> {
  const res = await page.request.get(`/api/tasks/${TID(k)}`)
  return ((await res.json()) as { task?: { phase?: string } }).task?.phase
}
async function resetTasks(page: Page) {
  for (const k of KEYS) await page.request.patch(`/api/tasks/${TID(k)}`, { data: { phase: 'IN_PROGRESS' } })
}

/** Hold the tick between the click and the close until the test releases it. Call BEFORE the
 *  page loads. (The tick is the 400ms timer set from the hook's module, told apart by its stack.) */
async function holdTick(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __tickHeld: Array<() => void> }
    w.__tickHeld = []
    const original = window.setTimeout.bind(window)
    window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof fn === 'function' && delay === 400 && (new Error().stack ?? '').includes('useColumnCompleteClose')) {
        w.__tickHeld.push(() => { original(fn, 0, ...args) })
        return -1 as unknown as number
      }
      return original(fn, delay, ...args)
    }) as typeof window.setTimeout
  })
}
const waitTickHeld = (page: Page) => page.waitForFunction(
  () => (window as unknown as { __tickHeld: unknown[] }).__tickHeld.length > 0, undefined, { timeout: 30_000 })
const releaseTick = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __tickHeld: Array<() => void> }
  w.__tickHeld.splice(0).forEach((run) => run())
})

/** Keep the 8s toasts (and the hook's 8s refusal watch) up for two minutes, for a test that
 *  must do a slow UI step (open another session) while the Undo is still on screen. */
async function stretchToasts(page: Page) {
  await page.addInitScript(() => {
    const original = window.setTimeout.bind(window)
    window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) =>
      original(fn, delay === 8000 ? 120_000 : delay, ...args)) as typeof window.setTimeout
  })
}

/** Open a session as a home column through the finder (⌘⇧O → type → click). */
async function openViaFinder(page: Page, query: string, sid: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+Shift+O')
  const finder = page.locator('.session-search-panel')
  await expect(finder).toBeVisible()
  await finder.locator('.session-search-input').fill(query)
  const result = finder.locator('.session-search-result').filter({ has: page.locator('.session-search-title', { hasText: query }) })
  await expect(result).toHaveCount(1, { timeout: 10_000 })
  await result.click()
  await expect(page.locator(`.main-page-session-column[data-column-id="${sid}"]`)).toBeVisible({ timeout: 20_000 })
}

/** Record every animation that is a clip-path on a column (there must be none: the close is the
 *  ordinary fade), and with `hold` pause the removal's own fade so the test can look at it. */
async function watchAnimations(page: Page, hold = false) {
  await page.addInitScript((holdFade: boolean) => {
    const w = window as unknown as { __clipAnimations: number; __fadeHeld?: Animation }
    w.__clipAnimations = 0
    const original = Element.prototype.animate
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const anim = original.call(this, keyframes, options)
      const onColumn = this instanceof HTMLElement && this.classList.contains('main-page-session-column')
      if (onColumn && Array.isArray(keyframes) && keyframes.some((f) => 'clipPath' in f)) w.__clipAnimations++
      // auto-animate's removal of a column: the node is re-inserted and faded (scale .98, opacity 0).
      if (holdFade && onColumn && Array.isArray(keyframes) && keyframes.length === 2 && keyframes.every((f) => 'transform' in f && 'opacity' in f)) {
        anim.pause()
        w.__fadeHeld = anim
      }
      return anim
    }
  }, hold)
}

async function openThree(page: Page) {
  await resetTasks(page)
  await setPanelMode(page, '3')
  await seedColumns(page, KEYS.map(SID))
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 30_000 })
  // Real density: the chat is scrolled under the header, not an empty panel.
  await expect(col(page, 'b').getByText('close b answer 45')).toBeVisible({ timeout: 30_000 })
}

// Setting the panel count goes through Settings and the config lock, and the first load of the
// fixture is cold: on a busy machine that alone is most of the default 30s.
test.setTimeout(180_000)

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', '0') } catch { /* off */ }
  })
})

test.afterEach(async ({ page }) => {
  await resetTasks(page)
})

test('completing from the header closes the column with the ordinary fade, and names an Undo', async ({ page }, info) => {
  await watchAnimations(page, true)
  await openThree(page)
  expect(await order(page)).toEqual(KEYS.map(SID))
  const before = await widths(page)
  const engine = info.project.name

  await ring(page, 'b').click()
  // The completion is applied at once (the ring answers the click, not the server).
  await expect.poll(() => phase(page, 'b'), { timeout: 15_000 }).toBe('COMPLETE')
  await expect(undoToast(page)).toBeVisible({ timeout: 15_000 })
  await expect(undoToast(page)).toContainText('Close fixture B')      // named by its task, never by a session id

  // The removal's own fade, held halfway: the whole column (not a strip of it) fades, lifted out
  // of the flow, while the neighbours are already taking its width.
  await page.waitForFunction(() => !!(window as unknown as { __fadeHeld?: Animation }).__fadeHeld, undefined, { timeout: 30_000 })
  await page.evaluate(() => {
    const a = (window as unknown as { __fadeHeld: Animation }).__fadeHeld
    a.pause()
    a.currentTime = 160
  })
  const fading = await col(page, 'b').evaluate((node) => ({ position: getComputedStyle(node).position, clip: getComputedStyle(node).clipPath }))
  expect(fading.position).toBe('absolute')
  expect(fading.clip).toBe('none')
  await page.screenshot({ path: `${SHOTS}/${engine}-1-fading.png` })
  await page.evaluate(() => { (window as unknown as { __fadeHeld: Animation }).__fadeHeld.play() })

  await expect(col(page, 'b')).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => (await order(page)).join()).toBe([SID('a'), SID('c')].join())
  await expect.poll(async () => (await widths(page))[SID('a')], { timeout: 10_000 }).toBeGreaterThan(before[SID('a')] + 100)
  const after = await widths(page)
  expect(Math.abs(after[SID('a')] - after[SID('c')])).toBeLessThan(3)
  await page.screenshot({ path: `${SHOTS}/${engine}-2-closed.png` })
  expect(await phase(page, 'b')).toBe('COMPLETE')
  expect(await page.evaluate(() => (window as unknown as { __clipAnimations: number }).__clipAnimations)).toBe(0)
})

test('Undo puts the column back in the middle and the task back in progress, round after round', async ({ page }) => {
  await openThree(page)
  const before = await widths(page)

  for (let round = 1; round <= 2; round++) {
    await ring(page, 'b').click()
    await expect(col(page, 'b')).toHaveCount(0, { timeout: 20_000 })
    await expect(undoButton(page), `round ${round}: the Undo outlives the removal`).toBeVisible()
    await undoButton(page).click()

    await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(async () => (await order(page)).join(), { message: `round ${round}: the column is back in the middle` }).toBe(KEYS.map(SID).join())
    await expect.poll(() => phase(page, 'b'), { timeout: 15_000 }).toBe('IN_PROGRESS')
    await expect(undoToast(page)).toHaveCount(0)
    await expect.poll(async () => Math.abs((await widths(page))[SID('b')] - before[SID('b')]), { timeout: 10_000 }).toBeLessThan(3)
    await expect(ring(page, 'b')).toBeEnabled()
  }
})

test('clicking the ring again before the column goes reopens the task and the column stays', async ({ page }) => {
  await holdTick(page)
  await openThree(page)
  await ring(page, 'c').click()
  await waitTickHeld(page)
  await ring(page, 'c').click()                             // the header is still there to click
  await expect.poll(() => phase(page, 'c'), { timeout: 15_000 }).not.toBe('COMPLETE')
  await releaseTick(page)

  await page.waitForTimeout(2_500)
  await expect(homeColumns(page)).toHaveCount(3)
  await expect(undoToast(page)).toHaveCount(0)              // nothing left to undo
})

test('pinning the column before it goes still closes it, and the Undo brings it back pinned', async ({ page }) => {
  await holdTick(page)
  await openThree(page)
  await ring(page, 'a').click()
  await waitTickHeld(page)
  await col(page, 'a').locator('.session-panel-lock').click()
  await expect(col(page, 'a').locator('.session-panel-lock')).toHaveClass(/is-locked/)
  const pinnedOrder = await order(page)                      // the pin moved it to the right
  await releaseTick(page)

  await expect(col(page, 'a')).toHaveCount(0, { timeout: 15_000 })
  await undoButton(page).click()
  await expect(col(page, 'a')).toHaveCount(1, { timeout: 15_000 })
  await expect(col(page, 'a').locator('.session-panel-lock')).toHaveClass(/is-locked/)
  await expect.poll(async () => (await order(page)).join()).toBe(pinnedOrder.join())
  await expect.poll(() => phase(page, 'a'), { timeout: 15_000 }).toBe('IN_PROGRESS')
})

test('closing the column with × before the tick ends closes it once and announces nothing', async ({ page }) => {
  await holdTick(page)
  await openThree(page)
  await ring(page, 'a').click()
  await waitTickHeld(page)
  await col(page, 'a').locator('.session-panel-close').click()
  await releaseTick(page)

  await expect(col(page, 'a')).toHaveCount(0, { timeout: 15_000 })
  await page.waitForTimeout(2_000)
  await expect(homeColumns(page)).toHaveCount(2)
  await expect(undoToast(page)).toHaveCount(0)
  expect(await phase(page, 'a')).toBe('COMPLETE')
})

test('a completion the server refuses leaves the column and the ring as they were', async ({ page }) => {
  await openThree(page)
  await page.route(`**/api/tasks/${TID('b')}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'refused for the test' }) })
      return
    }
    await route.fallback()
  })
  await ring(page, 'b').click()

  // The store rolls the optimistic phase back, at the latest when the list is re-read.
  await page.waitForTimeout(3_500)
  await expect(homeColumns(page)).toHaveCount(3)
  await expect(undoToast(page)).toHaveCount(0)
  expect(await phase(page, 'b')).toBe('IN_PROGRESS')
})

test('a refusal that lands after the column has gone gives the column back and takes the toast down', async ({ page }) => {
  await openThree(page)
  // The server answers late: long after the close (a failed write is retried with backoff before
  // the list is re-read), so the store rolls back on a column that is gone.
  await page.route(`**/api/tasks/${TID('b')}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      await new Promise((resolve) => setTimeout(resolve, 6_000))
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'refused late, for the test' }) })
      return
    }
    await route.fallback()
  })
  await ring(page, 'b').click()
  await expect(col(page, 'b')).toHaveCount(0, { timeout: 20_000 })
  await expect(undoToast(page)).toBeVisible()

  await expect(col(page, 'b')).toHaveCount(1, { timeout: 30_000 })
  await expect.poll(async () => (await order(page)).join(), { timeout: 10_000 }).toBe(KEYS.map(SID).join())
  await expect(undoToast(page)).toHaveCount(0)
  expect(await phase(page, 'b')).toBe('IN_PROGRESS')
  await expect(ring(page, 'b')).toBeEnabled()
})

test('two columns completed back to back each keep their own Undo and their own place', async ({ page }) => {
  await stretchToasts(page)       // the second Undo comes after several slow steps
  await openThree(page)
  await ring(page, 'a').click()
  await ring(page, 'c').click()

  await expect(homeColumns(page)).toHaveCount(1, { timeout: 30_000 })
  expect(await order(page)).toEqual([SID('b')])
  const toasts = page.locator('.notification-toast--success', { hasText: 'Task completed' })
  await expect(toasts).toHaveCount(2)
  await expect(toasts.filter({ hasText: 'Close fixture A' })).toHaveCount(1)
  await expect(toasts.filter({ hasText: 'Close fixture C' })).toHaveCount(1)

  // The later one first: C comes back on the right, A is still away.
  await toasts.filter({ hasText: 'Close fixture C' }).locator('.notification-toast-action').click()
  await expect.poll(async () => (await order(page)).join(), { timeout: 15_000 }).toBe([SID('b'), SID('c')].join())
  await expect.poll(() => phase(page, 'c'), { timeout: 15_000 }).toBe('IN_PROGRESS')
  expect(await phase(page, 'a')).toBe('COMPLETE')

  // Then A: back on the left, where it was.
  await toasts.filter({ hasText: 'Close fixture A' }).locator('.notification-toast-action').click()
  await expect.poll(async () => (await order(page)).join(), { timeout: 15_000 }).toBe(KEYS.map(SID).join())
  await expect.poll(() => phase(page, 'a'), { timeout: 15_000 }).toBe('IN_PROGRESS')
})

test('a pinned column closes too, and the Undo puts it back pinned, in its place among the pins', async ({ page }) => {
  await openThree(page)
  // Pin b, then c: the first pin is the anchor on the far right, the next slides in left of it.
  await col(page, 'b').locator('.session-panel-lock').click()
  await expect(col(page, 'b').locator('.session-panel-lock')).toHaveClass(/is-locked/)
  await col(page, 'c').locator('.session-panel-lock').click()
  await expect(col(page, 'c').locator('.session-panel-lock')).toHaveClass(/is-locked/)
  await expect.poll(async () => (await order(page)).join()).toBe([SID('a'), SID('c'), SID('b')].join())

  // The middle one, a pin between the unlocked column and the anchor.
  await ring(page, 'c').click()
  await expect.poll(() => phase(page, 'c'), { timeout: 15_000 }).toBe('COMPLETE')
  await expect(col(page, 'c')).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => (await order(page)).join()).toBe([SID('a'), SID('b')].join())
  await expect(undoToast(page)).toContainText('Close fixture C')
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-3-pinned-closed.png` })

  await undoButton(page).click()
  await expect(col(page, 'c')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(async () => (await order(page)).join()).toBe([SID('a'), SID('c'), SID('b')].join())
  await expect(col(page, 'c').locator('.session-panel-lock')).toHaveClass(/is-locked/)
  await expect(col(page, 'b').locator('.session-panel-lock')).toHaveClass(/is-locked/)
  await expect.poll(() => phase(page, 'c'), { timeout: 15_000 }).toBe('IN_PROGRESS')

  // And the anchor itself, round two: it goes and comes back on the far right.
  await ring(page, 'b').click()
  await expect(col(page, 'b')).toHaveCount(0, { timeout: 20_000 })
  await undoButton(page).click()
  await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(async () => (await order(page)).join()).toBe([SID('a'), SID('c'), SID('b')].join())
  await expect(col(page, 'b').locator('.session-panel-lock')).toHaveClass(/is-locked/)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-4-pinned-undone.png` })
})

test('Undo of a pinned column after the strip refilled opens it like any column and pins it again', async ({ page }) => {
  await stretchToasts(page)
  await openThree(page)
  await col(page, 'b').locator('.session-panel-lock').click()
  await expect.poll(async () => (await order(page)).join()).toBe([SID('a'), SID('c'), SID('b')].join())
  await ring(page, 'b').click()
  await expect(col(page, 'b')).toHaveCount(0, { timeout: 20_000 })

  // Another session takes the free slot while the Undo is still up: the strip is full again.
  const other = 'pw-service-session'
  await openViaFinder(page, 'Service preview', other)
  await expect(homeColumns(page)).toHaveCount(3)

  await undoButton(page).click()
  await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
  await expect(col(page, 'b').locator('.session-panel-lock')).toHaveClass(/is-locked/)
  await expect.poll(async () => (await order(page)).at(-1)).toBe(SID('b'))      // back among the pins, on the right
  await expect(homeColumns(page)).toHaveCount(3)                                 // the count held: an unlocked column yielded
  expect(await order(page)).toContain(other)
  await expect.poll(() => phase(page, 'b'), { timeout: 15_000 }).toBe('IN_PROGRESS')
})

test('with reduced motion the column still closes and still has its Undo', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openThree(page)
  await ring(page, 'a').click()

  await expect(col(page, 'a')).toHaveCount(0, { timeout: 15_000 })
  await undoButton(page).click()
  await expect(col(page, 'a')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => phase(page, 'a'), { timeout: 15_000 }).toBe('IN_PROGRESS')
})

test('Complete from the kebab\'s status menu takes the same road', async ({ page }) => {
  await openThree(page)
  await col(page, 'c').locator('.task-kebab-btn').click()
  await page.locator('[data-testid="task-status-toggle"]').click()
  await page.locator('.task-status-pill[data-phase="COMPLETE"]').click()

  await expect.poll(() => phase(page, 'c'), { timeout: 15_000 }).toBe('COMPLETE')
  await expect(col(page, 'c')).toHaveCount(0, { timeout: 20_000 })
  await expect(undoToast(page)).toBeVisible()
})

test('completing the task from the board, not the column, closes nothing', async ({ page }) => {
  await openThree(page)
  await page.request.patch(`/api/tasks/${TID('b')}`, { data: { phase: 'COMPLETE' } })
  await expect.poll(() => phase(page, 'b')).toBe('COMPLETE')
  await page.waitForTimeout(2_500)
  await expect(homeColumns(page)).toHaveCount(3)
  await expect(undoToast(page)).toHaveCount(0)
})
