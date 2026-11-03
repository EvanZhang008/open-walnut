/**
 * Settings › Phones & Cloud is the main entry; each way (Cloud companion, Tailscale,
 * Browser link) is its own sub-page under it, opened from its card on the main entry
 * or its indented row in the sidebar (devices-ways-and-qr.spec.ts). Specs about a
 * way's settings open its sub-page first, the way a person does.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export type DeviceWay = 'cloud' | 'tailscale' | 'browser'

/** The sub-page's lead section id (core-settings-registry): `#cloud` kept its old deep link. */
export const WAY_PANE: Record<DeviceWay, string> = { cloud: 'cloud', tailscale: 'devices-tailscale', browser: 'devices-browser' }

/**
 * Open a way's sub-page from its card on Phones & Cloud (no-op when it is showing)
 * and return its section. Phones & Cloud must be open, or the sub-page already.
 */
export async function openWay(page: Page, id: DeviceWay): Promise<Locator> {
  const pane = page.locator(`#${WAY_PANE[id]}`)
  if (await pane.isVisible()) return pane
  const btn = page.getByTestId(`devices-way-${id}-action`)
  await expect(btn).toBeVisible({ timeout: 30_000 })
  await btn.click()
  await expect(pane).toBeVisible({ timeout: 30_000 })
  return pane
}

/** From a sub-page back to Phones & Cloud by its back link; returns the main entry's section. */
export async function backToDevices(page: Page): Promise<Locator> {
  await page.getByTestId('settings-pane-back').click()
  const section = page.locator('#devices')
  await expect(section).toBeVisible({ timeout: 30_000 })
  return section
}

/** The pairing QR dialog (cloud/PairQrDialog.tsx). */
export const qrDialog = (page: Page) => page.locator('.devices-qr-dialog')
