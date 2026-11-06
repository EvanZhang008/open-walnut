/**
 * Old Settings links to plugins, and where they go now. Free of the Settings registry on
 * purpose: the sidebar's remembered locations (utils/last-location) read it.
 *
 * `#plugin-store` was the plugin list; `#<plugin>:<panel>` was one plugin's settings
 * panel, which is now on that plugin's page in Apps (`/apps?plugin=<id>&panel=<panel>`).
 * Walnut's own row anchors that carry a free-form part (a host alias with a port,
 * `#rh-host-box:2222`) can look like a plugin key, so they are excluded here, the one
 * test both Settings and the sidebar's memory use.
 */
import { wayPaneForRow } from './settings-way-panes'

/** One remote host's row in Remote Hosts (`#rh-host-<alias>`; mirrors HOST_ROW_ID_PREFIX in utils/host-settings-nav.ts). */
export const HOST_ROW_PREFIX = 'rh-host-'
/** One message hint's row in Sessions, Message hints (MessageHintsGroup). */
export const HINT_ROW_PREFIX = 'message-hint-'

/** The Settings hash plugins lived under before the Apps page (mirrors open-link LEGACY_PLUGINS_HASH). */
const LEGACY_PLUGINS_HASH = 'plugin-store'
/** A plugin id and a panel id, as host-api's validateLocalId and the manifest allow them. */
const PLUGIN_PANEL_KEY = /^([A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9][A-Za-z0-9._-]*)$/

function decode(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Where an old Settings link to a plugin goes now, or null when the hash names none. */
export function legacyPluginTarget(hash: string): string | null {
  const id = decode(hash)
  if (id === LEGACY_PLUGINS_HASH) return '/apps'
  const m = PLUGIN_PANEL_KEY.exec(id)
  if (!m || isWalnutRowAnchor(id)) return null
  return `/apps?${new URLSearchParams({ plugin: m[1]!, panel: m[2]! }).toString()}`
}

/** A Settings row anchor of Walnut's own whose id carries a free-form part. */
export function isWalnutRowAnchor(id: string): boolean {
  return id.startsWith(HOST_ROW_PREFIX) || id.startsWith(HINT_ROW_PREFIX) || id.startsWith('devices-way-') || wayPaneForRow(id) !== null
}
