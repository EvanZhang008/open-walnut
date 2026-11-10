/**
 * The Files panel's document bar folds its tools into ⋯ one at a time while the
 * file's name is cut (BAR_STEPS in web/src/components/common/FileContentView.tsx):
 * History, then ‹ ›, then Find, then Preview / Source, then the host's Terminal toggle. A spec that presses one
 * of them goes through pressBarTool, which finds it wherever it is now.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** The bar has settled: its name is whole, or there is nothing left to fold. */
export async function docBarSettled(bar: Locator): Promise<void> {
  await expect.poll(() => bar.evaluate((el) => {
    const name = el.querySelector('.sfe-crumb.is-last .sfe-crumb-text, .fv-doc-crumb-file')
    return el.getAttribute('data-fold') === '5' || !name || name.scrollWidth <= name.clientWidth + 1
  }), { message: 'the document bar settles: the name is whole, or nothing is left to fold' }).toBe(true)
}

export type BarTool = 'History' | 'Find in file' | 'Source' | 'Preview'

/** How many tools each one needs folded before it leaves the bar for ⋯. */
const FOLDED_AT: Record<BarTool, number> = { History: 1, 'Find in file': 3, Source: 4, Preview: 4 }

/** Press a tool of `bar`, on the bar (Source / Preview, or a tight bar's one
 *  "Show source" switch) or in its ⋯ menu when a cut name folded it there. Where
 *  it is comes from the bar's data-fold, read again until the tool is there: the
 *  bar redraws as it settles, and a tool that appears late (Preview / Source once
 *  the file has loaded) can fold the bar one step further. */
export async function pressBarTool(page: Page, bar: Locator, tool: BarTool): Promise<void> {
  const row = tool === 'Source' ? 'Show source' : tool === 'Preview' ? 'Show preview' : tool
  const name = tool === 'Source' ? /^(Source|Show source)$/ : tool === 'Preview' ? /^(Preview|Show preview)$/ : new RegExp(`^${tool}$`)
  const button = bar.getByRole('button', { name })
  const menuRow = page.getByTestId('fv-more-menu').getByRole('menuitem', { name: row, exact: true })
  // Pressed once it is found: on the bar, or as a row of an open ⋯ (a menu
  // opened just as the bar stepped back is closed, and the bar read again).
  await expect.poll(async () => {
    await docBarSettled(bar)
    if (Number(await bar.getAttribute('data-fold')) < FOLDED_AT[tool]) {
      if (!(await button.first().isVisible().catch(() => false))) return false
      await button.first().click()
      return true
    }
    await bar.getByRole('button', { name: 'More file actions' }).click()
    if (await menuRow.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await menuRow.click()
      return true
    }
    await page.keyboard.press('Escape')
    return false
  }, { message: `${tool}: pressed on the bar or in ⋯`, timeout: 20_000 }).toBe(true)
}
