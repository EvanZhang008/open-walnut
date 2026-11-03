/**
 * Settings › Phones & Cloud is four tabs: each way (Cloud companion, Tailscale,
 * Browser link) and Devices (paired phones and browsers, Add a phone). The entry
 * opens the tab in use (devices-ways-and-qr.spec.ts). Specs about one tab open it
 * from the tab bar first, the way a person does.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export type DeviceWay = 'cloud' | 'tailscale' | 'browser'

/** The tab's section id (core-settings-registry): `#cloud` kept its old deep link. */
export const WAY_PANE: Record<DeviceWay, string> = { cloud: 'cloud', tailscale: 'devices-tailscale', browser: 'devices-browser' }

/** The Devices tab's pane id: paired phones and browsers, Add a phone. */
export const DEVICES_TAB = 'devices-phones'

/** Open a tab from the bar (no-op when it is showing) and return its section. Any tab must be open. */
async function openTab(page: Page, paneId: string): Promise<Locator> {
  const pane = page.locator(`#${paneId}`)
  if (await pane.isVisible()) return pane
  const tab = page.getByTestId(`pc-tab-${paneId}`)
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.click()
  await expect(pane).toBeVisible({ timeout: 30_000 })
  return pane
}

/** Open a way's tab (no-op when it is showing) and return its section. */
export async function openWay(page: Page, id: DeviceWay): Promise<Locator> {
  return openTab(page, WAY_PANE[id])
}

/** Open the Devices tab (no-op when it is showing) and return its section. */
export async function backToDevices(page: Page): Promise<Locator> {
  return openTab(page, DEVICES_TAB)
}

/**
 * Settings, then Phones & Cloud from the sidebar, then the Devices tab; returns its
 * section. Settings must be open (the sidebar shows).
 */
export async function openDevicesTab(page: Page): Promise<Locator> {
  await page.getByTestId('settings-nav-devices').click()
  await expect(page.getByTestId('pc-tabs')).toBeVisible({ timeout: 30_000 })
  return openTab(page, DEVICES_TAB)
}

/** The pairing QR dialog (cloud/PairQrDialog.tsx). */
export const qrDialog = (page: Page) => page.locator('.devices-qr-dialog')
