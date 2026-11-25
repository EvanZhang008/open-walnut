/**
 * The app's motion (web/src/styles/motion.css), on the real Home page:
 *
 *  - a menu grows in from 96 % and fades in, then rests at full size and opacity; when it closes a
 *    copy of it fades out in its place (web/src/utils/overlay-exit.ts), inert and hidden from
 *    assistive tech, and is dropped;
 *  - the picked segment's capsule slides to the new pick (web/src/utils/selection-slide.ts; tabs
 *    take the same one) and is dropped, the new segment drawing its own picked look again;
 *  - a fold its heading opens slides its rows down (web/src/utils/reveal.ts), once;
 *  - in a browser under automation (every other spec) nothing moves: data-motion="off".
 *
 * 2026-11-25, the user: "the transition, I want it very smooth ... learn from Apple".
 * A spec sees the motion only with localStorage['walnut.motion'] = 'full' (web/src/utils/motion.ts).
 */
import { test, expect, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'

const displayButton = (page: Page) => page.locator('.todo-panel .todo-panel-toolbar button[aria-label="Display"]')
const displayMenu = (page: Page) => page.locator('.fb-menu:not([data-overlay-exit])')
/** The Display menu's first segmented control (the shared SegmentedControl) and its segments. */
const segments = (page: Page) => displayMenu(page).locator('.dm-seg').first().locator('[role="radio"]')
const pickedAt = (page: Page) => segments(page).evaluateAll((els) => els.findIndex((e) => e.getAttribute('aria-checked') === 'true'))

async function fullMotion(page: Page) {
  await page.addInitScript(() => { try { localStorage.setItem('walnut.motion', 'full') } catch { /* storage blocked */ } })
}

/** Records what the given selectors draw on each frame from now on, and every copy or capsule added and dropped. */
async function record(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const w = window as unknown as { __frames: string[]; __dom: string[]; __runs: string[]; __stop?: () => void }
    w.__stop?.()
    w.__frames = []
    w.__dom = []
    w.__runs = []
    let on = true
    const tick = () => {
      const el = document.querySelector<HTMLElement>(sel)
      if (el) { const cs = getComputedStyle(el); w.__frames.push(`${cs.opacity}|${cs.scale}|${cs.transform}`) }
      if (on) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        // What starts moving the moment an element of `sel` is put in: read in the same task, so a
        // late first frame (headless WebKit draws few) cannot hide it.
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLElement) || n.hasAttribute('data-overlay-exit')) continue
          const el = n.matches(sel) ? n : n.querySelector<HTMLElement>(sel)
          if (el) w.__runs.push(...el.getAnimations().map((a) => (a as CSSTransition).transitionProperty ?? (a as CSSAnimation).animationName ?? 'script'))
        }
        for (const n of r.addedNodes) if (n instanceof HTMLElement && (n.matches('.wn-slide-thumb') || n.hasAttribute('data-overlay-exit'))) w.__dom.push(`+${n.matches('.wn-slide-thumb') ? 'thumb' : 'copy'}:${n.getAttribute('aria-hidden')}:${n.inert}`)
        for (const n of r.removedNodes) if (n instanceof HTMLElement && (n.matches('.wn-slide-thumb') || n.hasAttribute('data-overlay-exit'))) w.__dom.push(`-${n.matches('.wn-slide-thumb') ? 'thumb' : 'copy'}`)
      }
    })
    mo.observe(document.body, { childList: true, subtree: true })
    w.__stop = () => { on = false; mo.disconnect() }
  }, selector)
}
const frames = (page: Page) => page.evaluate(() => (window as unknown as { __frames: string[] }).__frames)
const runs = (page: Page) => page.evaluate(() => (window as unknown as { __runs: string[] }).__runs)
const domLog = (page: Page) => page.evaluate(() => (window as unknown as { __dom: string[] }).__dom)

test.describe('motion, full', () => {
  test.beforeEach(async ({ page }) => {
    await fullMotion(page)
    await loadHome(page)
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full')
  })

  test('a menu grows in, rests, and fades out in its place when it closes', async ({ page, browserName }) => {
    await record(page, '.fb-menu')
    await displayButton(page).click()
    await expect(displayMenu(page)).toBeVisible()
    // At rest: full size, fully opaque.
    await expect.poll(async () => displayMenu(page).evaluate((el) => `${getComputedStyle(el).opacity}|${getComputedStyle(el).scale}`)).toMatch(/^1\|(none|1)$/)
    // It started fading and growing the moment it was put in.
    expect((await runs(page)).sort()).toEqual(['opacity', 'scale'])
    // Chromium draws every frame headless: there it was drawn on its way, transparent-ish and
    // smaller. (Headless Linux WebKit draws its first frame late, when the 200 ms are nearly over.)
    const opening = await frames(page)
    if (browserName === 'chromium') {
      expect(opening.some((f) => Number(f.split('|')[0]) < 0.9), opening.join(' ')).toBe(true)
      expect(opening.some((f) => { const s = f.split('|')[1]; return s !== 'none' && Number(s) < 0.99 }), opening.join(' ')).toBe(true)
    }

    await record(page, '.fb-menu')
    await page.keyboard.press('Escape')
    await expect(displayMenu(page)).toHaveCount(0)
    // Its copy fades out, inert and hidden from assistive tech, then is dropped.
    await expect.poll(() => domLog(page)).toEqual(['+copy:true:true', '-copy'])
    await expect(page.locator('[data-overlay-exit]')).toHaveCount(0)
    const closing = (await frames(page)).map((f) => Number(f.split('|')[0]))
    if (browserName === 'chromium') expect(closing.some((o) => o > 0 && o < 0.9), closing.join(' ')).toBe(true)
  })

  test('the picked segment\'s capsule slides to the new pick and is dropped', async ({ page }) => {
    await displayButton(page).click()
    expect(await segments(page).count()).toBeGreaterThan(1)
    const from = await pickedAt(page)
    const to = from === 0 ? 1 : 0
    await record(page, '.wn-slide-thumb')
    await segments(page).nth(to).click()
    await expect(segments(page).nth(to)).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => domLog(page)).toEqual(['+thumb:true:false', '-thumb'])
    const moving = (await frames(page)).map((f) => f.split('|')[2])
    // On its way it is offset toward the old tab, and it lands at the new one.
    expect(moving.some((t) => /matrix\(1, 0, 0, 1, -?[1-9]/.test(t)), moving.join(' ')).toBe(true)
    // The new tab draws its own picked look again; nothing of the slide is left.
    await expect(page.locator('[data-slide-to], [data-slide-from], .wn-slide-thumb')).toHaveCount(0)
    const fill = await segments(page).nth(to).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(fill).not.toBe('rgba(0, 0, 0, 0)')
    // Put the view back as it was.
    if (from >= 0) await segments(page).nth(from).click()
  })

  test('a fold its heading opens slides its rows down once', async ({ page }) => {
    const head = page.locator('.status-section-heading').first()
    const key = (await head.getAttribute('data-testid'))!.replace('status-section-', '')
    const heading = head.locator('.navigation-heading-open')
    const rows = `[data-testid="status-section-${key}-rows"]`
    if ((await heading.getAttribute('aria-expanded')) === 'true') await heading.click()
    await expect(heading).toHaveAttribute('aria-expanded', 'false')
    await record(page, rows)
    await heading.click()
    await expect(page.locator(rows)).toBeVisible()
    await page.waitForTimeout(400)
    const opening = (await frames(page)).map((f) => f.split('|')[2])
    expect(opening.some((t) => /matrix\(1, 0, 0, 1, 0, -/.test(t)), opening.join(' ')).toBe(true)
    expect(opening.at(-1)).toBe('none')
    // A plain redraw of the same rows (fold and open from the keyboard-free path again) slides only on a click.
    await record(page, rows)
    await page.waitForTimeout(300)
    expect((await frames(page)).every((f) => f.endsWith('|none')), 'the rows rest after the one reveal').toBe(true)
  })
})

test('under automation nothing moves', async ({ page }) => {
  await loadHome(page)
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off')
  await record(page, '.fb-menu')
  await displayButton(page).click()
  await expect(displayMenu(page)).toBeVisible()
  const opening = await frames(page)
  expect(opening.length).toBeGreaterThan(0)
  expect(opening.every((f) => f.startsWith('1|')), opening.join(' ')).toBe(true)
  const from = await pickedAt(page)
  await segments(page).nth(from === 0 ? 1 : 0).click()
  await page.waitForTimeout(300)
  if (from >= 0) await segments(page).nth(from).click()
  await page.keyboard.press('Escape')
  await expect(displayMenu(page)).toHaveCount(0)
  await page.waitForTimeout(300)
  // No capsule slid and no closing copy was made.
  expect(await domLog(page)).toEqual([])
})
