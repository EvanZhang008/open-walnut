/**
 * What Walnut added to a person's message (its notes in front, the context it
 * prepended, its message hints) is hidden by default (ui.show_walnut_additions
 * off); the message footer's "Walnut added N" button shows it for that message.
 * Specs that check those rows open it first, the way a reader does: hover the
 * bubble (the footer is hover-only), then click the button.
 */
import { expect, type Locator } from '@playwright/test'

/** Show what Walnut added to the user bubble `bubble` (a `.session-msg-user` row). */
export async function revealWalnutAdded(bubble: Locator): Promise<void> {
  const toggle = bubble.getByTestId('walnut-added-toggle')
  if (await toggle.getAttribute('aria-expanded').catch(() => null) === 'true') return
  await bubble.hover()
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}
