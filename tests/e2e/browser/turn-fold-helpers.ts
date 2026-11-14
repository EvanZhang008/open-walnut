import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Open every closed fold (turn, process, rider, hidden turns) in a panel,
 * for specs that read the rows inside them (cards, banners). Each toggle is
 * brought into view with a real wheel gesture and clicked like a reader would:
 * the timeline follows its own bottom and snaps scroll-into-view back.
 */
export async function openAllTurnFolds(panel: Locator): Promise<void> {
  const page = panel.page()
  const history = panel.locator('.session-history')
  const closed = history.locator(
    ['turn-fold', 'process-fold', 'rider-fold'].map((id) => `[data-testid="${id}"][data-open="false"] > .tool-run-toggle`)
      .concat('[data-testid="hidden-turns"][data-open="false"] > .hidden-turns-toggle').join(', '),
  )
  const view = (await history.boundingBox())!
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  for (let n = 0; n < 40 && (await closed.count()) > 0; n++) {
    const target = closed.first()
    for (let i = 0; i < 40; i++) {
      const box = await target.boundingBox()
      if (box && box.y >= view.y && box.y + box.height <= view.y + view.height) break
      await page.mouse.wheel(0, box && box.y < view.y ? -200 : 200)
      await page.waitForTimeout(120)
    }
    await target.click()
  }
}

/**
 * Bring a card inside the timeline's scroller.
 *
 * The timeline follows its bottom, so Playwright's scroll-into-view is snapped
 * straight back (measured: the first screenshot attempt produced a blank PNG,
 * and a click on a card above the fold never lands). A REAL wheel gesture is
 * what tells the component the reader left the tail, so wheel until the card is
 * in view. Headless WebKit honours only the first synthetic wheel, so once that
 * one has released the tail, finish by setting the scroller's scrollTop.
 */
export async function revealCard(page: Page, panel: Locator, target: Locator): Promise<void> {
  const scroller = panel.locator('.session-history')
  const view = (await scroller.boundingBox())!
  const inView = async () => {
    const box = await target.boundingBox()
    return Boolean(box && box.y >= view.y && box.y + box.height <= view.y + view.height)
  }
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  for (let i = 0; i < 20 && !(await inView()); i++) {
    const box = await target.boundingBox()
    await page.mouse.wheel(0, box && box.y < view.y ? -160 : 160)
    await page.waitForTimeout(120)
  }
  if (await inView()) return
  await target.evaluate((el) => {
    const history = el.closest('.session-history')
    if (!history) return
    const offset = el.getBoundingClientRect().top - history.getBoundingClientRect().top
    history.scrollTop += offset - 8
  })
  await expect.poll(inView, { timeout: 5_000 }).toBe(true)
}
