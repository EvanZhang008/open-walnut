import { expect, type Page } from '@playwright/test'

/**
 * Pause the page's installed clock a little ahead of where it is NOW, never at a time read elsewhere.
 *
 * `page.clock.pauseAt` can only move forward. The page's clock keeps running between the moment a
 * spec reads a time (the driver's `Date.now()`, a timestamp the page printed) and the moment the pause
 * reaches the page, and on a loaded CI runner that gap passed the second a spec added on top
 * (2026-11-01: both mail-sync-line specs, "Cannot fast-forward to the past", in most runs). So the
 * target is read from the page's own clock, at least `notBefore` when given, and a pause that still
 * arrives late is tried again from the page's new time. Returns the time the clock stopped at.
 */
export async function pausePageClock(page: Page, opts: { notBefore?: number; leadMs?: number } = {}): Promise<number> {
  const lead = opts.leadMs ?? 1_000
  for (let attempt = 1; ; attempt++) {
    const pageNow = await page.evaluate(() => Date.now())
    const target = Math.max(pageNow, opts.notBefore ?? 0) + lead
    try {
      await page.clock.pauseAt(target)
      return target
    } catch (error) {
      if (attempt >= 3 || !String(error).includes('Cannot fast-forward to the past')) throw error
    }
  }
}

/**
 * Turn the wheel and wait until the PAGE has seen the wheel event, before a spec moves its clock.
 *
 * `page.mouse.wheel` resolves when the browser took the input, not when the page ran its
 * listeners: with only passive wheel listeners Chromium scrolls on the compositor and hands the
 * event to the page later. A `clock.fastForward` issued in between runs first, and the page then
 * stamps the wheel at the forwarded time (2026-11-07 CI: section-auto-fold's "wheel 62 s ago" read
 * only 22 s, the fold still open). tests/web/wheel-before-clock-guard.test.ts keeps specs on this.
 */
export async function wheelSeenByPage(page: Page, deltaX: number, deltaY: number): Promise<void> {
  type Counted = Window & { __walnutWheelsSeen?: number }
  const before = await page.evaluate(() => {
    const w = window as Counted
    if (w.__walnutWheelsSeen === undefined) {
      w.__walnutWheelsSeen = 0
      document.addEventListener('wheel', () => { w.__walnutWheelsSeen = (w.__walnutWheelsSeen ?? 0) + 1 }, { capture: true, passive: true })
    }
    return w.__walnutWheelsSeen
  })
  await page.mouse.wheel(deltaX, deltaY)
  await expect.poll(() => page.evaluate(() => (window as Counted).__walnutWheelsSeen ?? 0), { message: 'the page saw the wheel' }).toBeGreaterThan(before)
}
