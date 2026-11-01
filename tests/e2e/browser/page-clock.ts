import type { Page } from '@playwright/test'

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
