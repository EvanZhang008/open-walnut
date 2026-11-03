/**
 * Phones & Cloud's three ways, each its own sub-page (core-settings-registry
 * `parent: 'devices'`). The overview's old in-page anchors (`devices-way-<way>`,
 * `devices-way-panel-<way>`) open the sub-page, and a row that lives on one (a deep
 * link, a Find a setting anchor) opens it at that row.
 *
 * Import-free on purpose: the sections read it too, and settings-routing imports
 * the registry that imports those sections.
 */
export const WAY_PANES = { cloud: 'cloud', tailscale: 'devices-tailscale', browser: 'devices-browser' } as const
const WAY_ROW_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['devices-backup-leader', WAY_PANES.cloud],
  ['companion-keep', WAY_PANES.cloud],
  ['companion-copies', WAY_PANES.cloud],
  ['remote-access', WAY_PANES.tailscale],
  ['browser-access', WAY_PANES.browser],
]

/** The sub-page that holds this element id, or null when none of the ways does. */
export function wayPaneForRow(id: string): string | null {
  return WAY_ROW_PREFIXES.find(([prefix]) => id === prefix || id.startsWith(`${prefix}-`))?.[1] ?? null
}
