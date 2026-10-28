/**
 * The Apps page is a store: one card per plugin, and a detail page per card that holds
 * the switch, the settings, the parts, where the code comes from and Update. These open a
 * plugin's (or a built-in app's) detail page the way a person does, by clicking its card.
 */
import { expect, type Page } from '@playwright/test'

/** Click a plugin's card on the Apps page (already open) and wait for its detail page. */
export async function openPluginDetail(page: Page, pluginId: string): Promise<void> {
  const open = page.getByTestId(`plugin-card-${pluginId}-details`)
  await expect(open).toBeVisible({ timeout: 60_000 })
  await open.scrollIntoViewIfNeeded()
  await open.click()
  await expect(page.getByTestId('plugin-detail')).toHaveAttribute('data-plugin-id', pluginId, { timeout: 30_000 })
  await expect(page.getByTestId(`plugin-row-${pluginId}`)).toBeVisible()
}

/** Open a part's page (`slack-mcp` of Slack) from its parent's detail page. */
export async function openPartDetail(page: Page, partId: string): Promise<void> {
  await page.getByTestId(`plugin-part-open-${partId}`).click()
  await expect(page.getByTestId('plugin-detail')).toHaveAttribute('data-plugin-id', partId, { timeout: 30_000 })
}

/** Click a built-in app's card and wait for its detail page. */
export async function openBuiltinDetail(page: Page, id: string): Promise<void> {
  await page.getByTestId(`apps-builtin-${id}-details`).click()
  await expect(page.getByTestId('builtin-detail')).toHaveAttribute('data-builtin-id', id, { timeout: 30_000 })
}

/** Back to the card grid from a detail page. */
export async function backToApps(page: Page): Promise<void> {
  await page.getByTestId('plugin-detail-back').click()
  await expect(page.getByTestId('plugin-detail')).toHaveCount(0)
  await expect(page.getByTestId('builtin-detail')).toHaveCount(0)
  await expect(page.getByTestId('apps-plugins')).toBeVisible()
}
