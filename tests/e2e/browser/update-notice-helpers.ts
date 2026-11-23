/**
 * The update notice's × wherever it is drawn: in the collapsed rail it lives in the rail
 * peek (hover the key, then its ×); everywhere else it is the notice's own button.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect, type Page } from '@playwright/test'

/** Hover the collapsed rail's update key until its peek is up (the peek waits a short hover intent). */
export async function peekUpdateNotice(page: Page): Promise<void> {
  const key = page.locator('.stale-build-pill-action')
  const box = (await key.boundingBox())!
  const pill = page.getByTestId('rail-item-pill')
  await expect(async () => {
    // A pointer that has not moved yet does not peek: two moves, then the intent's timer
    // (a test with a fake clock runs it on).
    await page.mouse.move(box.x + box.width / 2 - 2, box.y + box.height / 2)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.clock.runFor(200).catch(() => {})
    await expect(pill).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
}

export async function dismissUpdateNotice(page: Page): Promise<void> {
  await expect(page.locator('.stale-build-pill')).toBeVisible({ timeout: 20_000 })
  if (await page.locator('.sidebar.collapsed .stale-build-pill.is-rail').count()) {
    await peekUpdateNotice(page)
    await page.getByTestId('rail-item-pill-dismiss').click()
    return
  }
  await page.locator('.stale-build-pill-later').click()
}
