/**
 * What Walnut added to a person's message (its notes in front, the context it
 * prepended, its message hints) shows by default (ui.show_walnut_additions, on
 * since 2026-10-31); a person who turned it off gets the message footer's
 * "Walnut added N" button, which shows it for that message. Specs that check those
 * rows open it first when it is hidden, the way a reader does: hover the bubble
 * (the footer is hover-only), then click the button.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** Show what Walnut added to the user bubble `bubble` (a `.session-msg-user` row). */
export async function revealWalnutAdded(bubble: Locator): Promise<void> {
  const toggle = bubble.getByTestId('walnut-added-toggle')
  // Shown by default: no button at all.
  await bubble.hover()
  if (await toggle.count() === 0) return
  if (await toggle.getAttribute('aria-expanded').catch(() => null) === 'true') return
  await bubble.hover()
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/**
 * This page reads "Always show what Walnut added" as `on`. Only the browser's
 * config read is answered, and its config writes go nowhere, so the shared
 * fixture server's setting never changes under another spec.
 */
export async function pinWalnutAdditions(page: Page, on: boolean): Promise<void> {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      return
    }
    const res = await route.fetch()
    const body = await res.json() as { config: { ui?: Record<string, unknown> } }
    body.config.ui = { ...(body.config.ui ?? {}), show_walnut_additions: on }
    await route.fulfill({ response: res, json: body })
  })
}
