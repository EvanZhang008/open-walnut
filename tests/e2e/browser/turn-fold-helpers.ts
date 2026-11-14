import type { Locator } from '@playwright/test'

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
