/**
 * Settings › Phones & Cloud keeps each way's own settings (Tailscale, browser link,
 * cloud companion) folded under its card until asked (devices-ways-and-qr.spec.ts).
 * Specs about those settings open the card first, the way a person does.
 */
import { expect, type Page } from '@playwright/test'

export type DeviceWay = 'cloud' | 'tailscale' | 'browser'

/** Open a way's settings under the cards; no-op when open, or when the companion is not set up yet. */
export async function openWay(page: Page, id: DeviceWay): Promise<void> {
  const btn = page.getByTestId(`devices-way-${id}-action`)
  await expect(btn).toBeVisible({ timeout: 30_000 })
  if (await btn.getAttribute('aria-expanded') === 'true') return
  // A companion not set up has no settings of its own: its button scrolls to the setup.
  if (id === 'cloud' && (await btn.innerText()).trim() === 'Set up') return
  await btn.click()
  await expect(btn).toHaveAttribute('aria-expanded', 'true')
}

/** The pairing QR dialog (cloud/PairQrDialog.tsx). */
export const qrDialog = (page: Page) => page.locator('.devices-qr-dialog')
