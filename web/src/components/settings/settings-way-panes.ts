/**
 * Phones & Cloud's four tabs: the three ways to reach Walnut (Cloud companion,
 * Tailscale, the browser link) and Devices (paired phones and browsers, pairing a
 * new phone). Each tab is its own pane (core-settings-registry `tabOf: 'devices'`),
 * so its address, back button and Find a setting work as for any pane; the nav
 * shows only Phones & Cloud, and the entry itself opens the tab in use. The
 * overview's old in-page anchors (`devices-way-<way>`, `devices-way-panel-<way>`)
 * open the tab, and a row that lives on one (a deep link, a Find a setting
 * anchor) opens it at that row.
 *
 * Import-free on purpose: the sections read it too, and settings-routing imports
 * the registry that imports those sections.
 */
export const WAY_PANES = { cloud: 'cloud', tailscale: 'devices-tailscale', browser: 'devices-browser' } as const
/** The Devices tab: paired phones, signed-in browsers, other Macs, Add a phone. */
export const DEVICES_TAB = 'devices-phones'
/** The entry the tabs sit under. */
export const PHONES_CLOUD_PANE = 'devices'
export type PhonesCloudTab = typeof WAY_PANES[keyof typeof WAY_PANES] | typeof DEVICES_TAB
/** Tab order, left to right. */
export const PHONES_CLOUD_TABS: readonly PhonesCloudTab[] = [WAY_PANES.cloud, WAY_PANES.tailscale, WAY_PANES.browser, DEVICES_TAB]

const WAY_ROW_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['devices-backup-leader', WAY_PANES.cloud],
  ['companion-keep', WAY_PANES.cloud],
  ['companion-copies', WAY_PANES.cloud],
  ['remote-access', WAY_PANES.tailscale],
  ['browser-access', WAY_PANES.browser],
  // The Devices tab's rows (an old `#devices-new-name` link lands on the name field).
  ['devices-new-name', DEVICES_TAB],
  ['devices-phones-group', DEVICES_TAB],
  ['devices-browsers-group', DEVICES_TAB],
  ['devices-macs', DEVICES_TAB],
  ['devices-add-group', DEVICES_TAB],
  ['devices-others', DEVICES_TAB],
]

/** The tab that holds this element id, or null when none does. */
export function wayPaneForRow(id: string): string | null {
  return WAY_ROW_PREFIXES.find(([prefix]) => id === prefix || id.startsWith(`${prefix}-`))?.[1] ?? null
}
