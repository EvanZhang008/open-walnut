/**
 * Completing a task from its session column's header closes that column: it rolls up into its
 * header, leaves through the sessions area's ordinary removal, and an Undo puts the task's phase
 * and the column back where they were.
 *
 * The person used to complete the task and then click × on the same column. They also sometimes
 * want to look at a column after they shut it, so the close is not silent: the roll-up says what
 * happened, the toast says how to take it back.
 *
 * Real UI throughout (the fixture's three long-transcript columns, the real ring, the real
 * toast). Two things are injected, both on the test side: the server refusing a completion (the
 * UI's PATCH has no business rule that refuses it), and a HOLD on the roll-up's animation, so a
 * test that must act "during the roll-up" is not at the mercy of how fast the machine is (a step
 * takes seconds at load 100+, the roll-up takes 890ms).
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { homeColumns, loadHome, seedColumns, setPanelMode } from './draft-helpers'

const KEYS = ['a', 'b', 'c'] as const
type Key = (typeof KEYS)[number]
const SID = (k: Key) => `pw-rollup-${k}-session`
const TID = (k: Key) => `pw-task-rollup-${k}`
const SHOTS = '/tmp/column-roll-up'
const ROLL_UP_MS = 890

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
/** The bottom inset of the column's clip-path, in px: 0 = whole, grows as it rolls up; null = no clip.
 *  The browser reports the CSS shorthand ("inset(0px)", "inset(0px 0px 12px)"), so expand it. */
async function clipBottom(el: Locator): Promise<number | null> {
  return el.evaluate((node) => {
    const m = /^inset\(([^)]*)\)$/.exec(getComputedStyle(node).clipPath)
    if (!m) return null
    const v = m[1].trim().split(/\s+/).map(parseFloat)
    if (v.some(Number.isNaN)) return null
    // top right bottom left: 1 value = all, 2 = [v h], 3 = [top h bottom], 4 = as written
    return v.length === 3 || v.length === 4 ? v[2] : v[0]
  })
}
async function resetTasks(page: Page) {
  for (const k of KEYS) await page.request.patch(`/api/tasks/${TID(k)}`, { data: { phase: 'IN_PROGRESS' } })
}

/** Hold every roll-up at its first frame (and, with `fade`, the removal's fade of the rolled-up
 *  column too: the test then releases it). Call BEFORE the page loads. */
async function holdRollUps(page: Page, fade = false) {
  await page.addInitScript((holdFade: boolean) => {
    const original = Element.prototype.animate
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const anim = original.call(this, keyframes, options)
      if (Array.isArray(keyframes) && keyframes.some((f) => 'clipPath' in f)) {
        anim.pause()
        ;(window as unknown as { __rollHeld?: Animation }).__rollHeld = anim
      }
      // auto-animate's removal of a column: the node is re-inserted and faded (scale .98, opacity 0).
      if (holdFade && Array.isArray(keyframes) && keyframes.length === 2 && keyframes.every((f) => 'transform' in f && 'opacity' in f)
        && this instanceof HTMLElement && this.classList.contains('main-page-session-column')) {
        anim.pause()
        ;(window as unknown as { __fadeHeld?: Animation }).__fadeHeld = anim
      }
      return anim
    }
  }, fade)
}
const waitHeld = (page: Page) => page.waitForFunction(() => !!(window as unknown as { __rollHeld?: Animation }).__rollHeld, undefined, { timeout: 30_000 })
const seek = (page: Page, ms: number) => page.evaluate((t) => {
  const a = (window as unknown as { __rollHeld: Animation }).__rollHeld
  a.pause()
  a.currentTime = t
}, ms)
const resume = (page: Page) => page.evaluate(() => { (window as unknown as { __rollHeld: Animation }).__rollHeld.play() })

async function openThree(page: Page) {
  await resetTasks(page)
  await setPanelMode(page, '3')
  await seedColumns(page, KEYS.map(SID))
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 30_000 })
  // Real density: the chat is scrolled under the header, not an empty panel.
  await expect(col(page, 'b').getByText('roll-up b answer 45')).toBeVisible({ timeout: 30_000 })
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

test('completing from the header rolls the column up into its header, closes it, and names an Undo', async ({ page }, info) => {
  await holdRollUps(page, true)
  await openThree(page)
  expect(await order(page)).toEqual(KEYS.map(SID))
  const before = await widths(page)
  const engine = info.project.name

  await ring(page, 'b').click()
  // The completion is applied at once (the ring answers the click, not the server).
  await expect.poll(() => phase(page, 'b'), { timeout: 15_000 }).toBe('COMPLETE')

  // After the tick the column rolls: a clip-path that grows from the bottom.
  await waitHeld(page)
  await expect(col(page, 'b')).toHaveAttribute('data-rolling-up', 'true')
  await expect(undoToast(page)).toBeVisible()
  await expect(undoToast(page)).toContainText('Roll-up fixture B')     // named by its task, never by a session id

  await seek(page, 0)
  const whole = await clipBottom(col(page, 'b'))
  await seek(page, ROLL_UP_MS * 0.4)
  const early = await clipBottom(col(page, 'b'))
  await page.screenshot({ path: `${SHOTS}/${engine}-1-rolling-40pct.png` })
  await seek(page, ROLL_UP_MS * 0.7)
  const late = await clipBottom(col(page, 'b'))
  await page.screenshot({ path: `${SHOTS}/${engine}-2-rolling-70pct.png` })
  await seek(page, ROLL_UP_MS - 1)
  const strip = await clipBottom(col(page, 'b'))
  await page.screenshot({ path: `${SHOTS}/${engine}-3-strip.png` })

  // Whole -> rolling -> the strip, never jumping backwards; and the strip is the header, not nothing.
  expect(whole).toBe(0)
  expect(early!).toBeGreaterThan(0)
  expect(late!).toBeGreaterThan(early!)
  expect(strip!).toBeGreaterThan(late!)
  const colHeight = (await col(page, 'b').boundingBox())!.height
  expect(colHeight - strip!).toBeGreaterThan(40)                  // a header is left...
  expect(colHeight - strip!).toBeLessThan(200)                    // ...and only the header
  const headerBottom = await col(page, 'b').locator('.session-panel-header').evaluate((h) => h.getBoundingClientRect().bottom - (h.closest('.main-page-session-column') as HTMLElement).getBoundingClientRect().top)
  expect(Math.abs((colHeight - strip!) - headerBottom)).toBeLessThan(4)

  // Let it roll: it reaches the strip, the column is removed, and the sessions area's own removal
  // re-inserts THAT node to fade it. Hold that fade halfway: the node must still be the strip
  // (not the whole column flashing back), lifted out of the flow, and the neighbours already moving.
  await resume(page)
  await page.waitForFunction(() => !!(window as unknown as { __fadeHeld?: Animation }).__fadeHeld, undefined, { timeout: 30_000 })
  await page.evaluate(() => {
    const a = (window as unknown as { __fadeHeld: Animation }).__fadeHeld
    a.pause()
    a.currentTime = 160
  })
  const fading = await col(page, 'b').evaluate((node) => {
    const cs = getComputedStyle(node)
    return { position: cs.position, clip: cs.clipPath, height: node.getBoundingClientRect().height, headerBottom: (node.querySelector('.session-panel-header') as HTMLElement).getBoundingClientRect().bottom - node.getBoundingClientRect().top }
  })
  expect(fading.position).toBe('absolute')                        // out of the flow: the neighbours are free to move
  expect(fading.clip).toMatch(/^inset\(/)                           // still clipped to the strip...
  const fadingClip = await clipBottom(col(page, 'b'))
  expect(fading.height - fadingClip!).toBeLessThan(200)           // ...the header strip, not the column
  expect(fading.height - fadingClip!).toBeGreaterThan(40)
  await page.screenshot({ path: `${SHOTS}/${engine}-3b-fading-strip.png` })
  await page.evaluate(() => { (window as unknown as { __fadeHeld: Animation }).__fadeHeld.play() })
  await expect(col(page, 'b')).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => (await order(page)).join()).toBe([SID('a'), SID('c')].join())
  await expect.poll(async () => (await widths(page))[SID('a')], { timeout: 10_000 }).toBeGreaterThan(before[SID('a')] + 100)
  const after = await widths(page)
  expect(Math.abs(after[SID('a')] - after[SID('c')])).toBeLessThan(3)
  await page.screenshot({ path: `${SHOTS}/${engine}-4-closed.png` })
  expect(await phase(page, 'b')).toBe('COMPLETE')
})

test('Undo puts the column back in the middle and the task back in progress, round after round', async ({ page }) => {
  await openThree(page)
  const before = await widths(page)

  for (let round = 1; round <= 2; round++) {
    await ring(page, 'b').click()
    await expect(col(page, 'b')).toHaveCount(0, { timeout: 20_000 })
    await expect(undoButton(page), `round ${round}: the Undo outlives the roll-up`).toBeVisible()
    await undoButton(page).click()

    await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(async () => (await order(page)).join(), { message: `round ${round}: the column is back in the middle` }).toBe(KEYS.map(SID).join())
    await expect.poll(() => phase(page, 'b'), { timeout: 15_000 }).toBe('IN_PROGRESS')
    await expect(undoToast(page)).toHaveCount(0)
    // Back at its width once the strip has settled, and the ring is a live ring again.
    await expect.poll(async () => Math.abs((await widths(page))[SID('b')] - before[SID('b')]), { timeout: 10_000 }).toBeLessThan(3)
    await expect(ring(page, 'b')).toBeEnabled()
    await expect(col(page, 'b')).not.toHaveAttribute('data-rolling-up', 'true')
    expect(await clipBottom(col(page, 'b'))).toBeNull()
  }
})

test('Undo during the roll-up cancels it: the column never goes', async ({ page }) => {
  await holdRollUps(page)
  await openThree(page)
  await ring(page, 'a').click()
  await waitHeld(page)
  await seek(page, ROLL_UP_MS * 0.5)
  expect(await clipBottom(col(page, 'a'))).toBeGreaterThan(0)
  await undoButton(page).click()

  await expect(col(page, 'a')).not.toHaveAttribute('data-rolling-up', 'true')
  expect(await clipBottom(col(page, 'a'))).toBeNull()      // whole again, no clip left behind
  await expect.poll(() => phase(page, 'a'), { timeout: 15_000 }).toBe('IN_PROGRESS')
  await page.waitForTimeout(2_500)                          // longer than the rest of the roll-up and the removal
  await expect(homeColumns(page)).toHaveCount(3)
  expect(await order(page)).toEqual(KEYS.map(SID))
})

test('clicking the ring again while it rolls reopens the task and the column stays', async ({ page }) => {
  await holdRollUps(page)
  await openThree(page)
  await ring(page, 'c').click()
  await waitHeld(page)
  await seek(page, ROLL_UP_MS * 0.3)
  await ring(page, 'c').click()                             // the header is still there to click

  await expect.poll(() => phase(page, 'c'), { timeout: 15_000 }).not.toBe('COMPLETE')
  await expect(col(page, 'c')).not.toHaveAttribute('data-rolling-up', 'true')
  expect(await clipBottom(col(page, 'c'))).toBeNull()
  await expect(undoToast(page)).toHaveCount(0)              // nothing left to undo
  await page.waitForTimeout(2_500)
  await expect(homeColumns(page)).toHaveCount(3)
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

  // The store rolls the optimistic phase back inside the tick, so the column never starts to roll.
  await page.waitForTimeout(3_500)
  await expect(homeColumns(page)).toHaveCount(3)
  await expect(col(page, 'b')).not.toHaveAttribute('data-rolling-up', 'true')
  expect(await clipBottom(col(page, 'b'))).toBeNull()
  await expect(undoToast(page)).toHaveCount(0)
  expect(await phase(page, 'b')).toBe('IN_PROGRESS')
})

test('closing the column with × while it rolls closes it once, and the Undo still brings it back', async ({ page }) => {
  await holdRollUps(page)
  await openThree(page)
  await ring(page, 'a').click()
  await waitHeld(page)
  await seek(page, ROLL_UP_MS * 0.5)
  await col(page, 'a').locator('.session-panel-close').click()

  await expect(col(page, 'a')).toHaveCount(0, { timeout: 15_000 })
  await page.waitForTimeout(1_500)
  await expect(homeColumns(page)).toHaveCount(2)
  await undoButton(page).click()
  await expect(col(page, 'a')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(async () => (await order(page)).join()).toBe(KEYS.map(SID).join())
  await expect.poll(() => phase(page, 'a'), { timeout: 15_000 }).toBe('IN_PROGRESS')
})

test('a refusal that lands after the column has gone gives the column back and takes the toast down', async ({ page }) => {
  await openThree(page)
  // The server answers late: long after the roll-up and the close (a failed write is retried
  // with backoff before the list is re-read), so the store rolls back on a column that is gone.
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

test('pinning the column while it rolls keeps it: the strip is still there to click', async ({ page }) => {
  await holdRollUps(page)
  await openThree(page)
  await ring(page, 'a').click()
  await waitHeld(page)
  await seek(page, ROLL_UP_MS * 0.5)
  expect(await clipBottom(col(page, 'a'))).toBeGreaterThan(0)
  await col(page, 'a').locator('.session-panel-lock').click()

  await expect(col(page, 'a').locator('.session-panel-lock')).toHaveClass(/is-locked/)
  await expect.poll(() => clipBottom(col(page, 'a')), { timeout: 10_000 }).toBeNull()   // whole again
  await expect(col(page, 'a')).not.toHaveAttribute('data-rolling-up', 'true')
  await expect(undoToast(page)).toHaveCount(0)
  await page.waitForTimeout(2_500)
  await expect(homeColumns(page)).toHaveCount(3)
  expect(await phase(page, 'a')).toBe('COMPLETE')
})

test('× in the middle of the roll fades the strip it had reached, never the whole column again', async ({ page }) => {
  await holdRollUps(page, true)
  await openThree(page)
  await ring(page, 'a').click()
  await waitHeld(page)
  await seek(page, ROLL_UP_MS * 0.5)
  const reached = await clipBottom(col(page, 'a'))
  expect(reached).toBeGreaterThan(100)
  await col(page, 'a').locator('.session-panel-close').click()

  await page.waitForFunction(() => !!(window as unknown as { __fadeHeld?: Animation }).__fadeHeld, undefined, { timeout: 30_000 })
  await page.evaluate(() => {
    const a = (window as unknown as { __fadeHeld: Animation }).__fadeHeld
    a.pause()
    a.currentTime = 160
  })
  const fading = await col(page, 'a').evaluate((node) => ({ position: getComputedStyle(node).position, height: node.getBoundingClientRect().height }))
  const clip = await clipBottom(col(page, 'a'))
  expect(fading.position).toBe('absolute')
  expect(clip).not.toBeNull()
  expect(clip!).toBeGreaterThanOrEqual(reached! - 2)                 // kept where the roll was, not reset to 0
  await page.evaluate(() => { (window as unknown as { __fadeHeld: Animation }).__fadeHeld.play() })
  await expect(col(page, 'a')).toHaveCount(0, { timeout: 20_000 })
})

test('two columns completed back to back each keep their own Undo and their own place', async ({ page }) => {
  await openThree(page)
  await ring(page, 'a').click()
  await ring(page, 'c').click()

  await expect(homeColumns(page)).toHaveCount(1, { timeout: 30_000 })
  expect(await order(page)).toEqual([SID('b')])
  const toasts = page.locator('.notification-toast--success', { hasText: 'Task completed' })
  await expect(toasts).toHaveCount(2)
  await expect(toasts.filter({ hasText: 'Roll-up fixture A' })).toHaveCount(1)
  await expect(toasts.filter({ hasText: 'Roll-up fixture C' })).toHaveCount(1)

  // The later one first: C comes back on the right, A is still away.
  await toasts.filter({ hasText: 'Roll-up fixture C' }).locator('.notification-toast-action').click()
  await expect.poll(async () => (await order(page)).join(), { timeout: 15_000 }).toBe([SID('b'), SID('c')].join())
  await expect.poll(() => phase(page, 'c'), { timeout: 15_000 }).toBe('IN_PROGRESS')
  expect(await phase(page, 'a')).toBe('COMPLETE')

  // Then A: back on the left, where it was.
  await toasts.filter({ hasText: 'Roll-up fixture A' }).locator('.notification-toast-action').click()
  await expect.poll(async () => (await order(page)).join(), { timeout: 15_000 }).toBe(KEYS.map(SID).join())
  await expect.poll(() => phase(page, 'a'), { timeout: 15_000 }).toBe('IN_PROGRESS')
})

test('a pinned column is completed but not closed: a pin means keep this panel', async ({ page }) => {
  await openThree(page)
  await col(page, 'b').locator('.session-panel-lock').click()
  await expect(col(page, 'b').locator('.session-panel-lock')).toHaveClass(/is-locked/)
  await ring(page, 'b').click()

  await expect.poll(() => phase(page, 'b'), { timeout: 15_000 }).toBe('COMPLETE')
  await page.waitForTimeout(2_500)
  await expect(col(page, 'b')).toHaveCount(1)
  await expect(col(page, 'b')).not.toHaveAttribute('data-rolling-up', 'true')
  await expect(undoToast(page)).toHaveCount(0)
  await expect(homeColumns(page)).toHaveCount(3)
})

test('with reduced motion the column closes without a roll-up and still has its Undo', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openThree(page)
  const seen: string[] = []
  await page.exposeFunction('__noteRolling', (v: string) => seen.push(v))
  await page.evaluate(() => {
    new MutationObserver(() => {
      if (document.querySelector('[data-rolling-up]')) (window as unknown as { __noteRolling: (v: string) => void }).__noteRolling('rolling')
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-rolling-up'] })
  })
  await ring(page, 'a').click()

  await expect(col(page, 'a')).toHaveCount(0, { timeout: 15_000 })
  expect(seen).toEqual([])
  await undoButton(page).click()
  await expect(col(page, 'a')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => phase(page, 'a'), { timeout: 15_000 }).toBe('IN_PROGRESS')
})

test('Complete from the kebab\'s status menu takes the same road', async ({ page }) => {
  await holdRollUps(page)
  await openThree(page)
  await col(page, 'c').locator('.task-kebab-btn').click()
  await page.locator('[data-testid="task-status-toggle"]').click()
  await page.locator('.task-status-pill[data-phase="COMPLETE"]').click()

  await expect.poll(() => phase(page, 'c'), { timeout: 15_000 }).toBe('COMPLETE')
  await waitHeld(page)
  await expect(col(page, 'c')).toHaveAttribute('data-rolling-up', 'true')
  await resume(page)
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
