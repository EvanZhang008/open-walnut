/**
 * Old Settings links to plugins, and where they go now. Import-free on purpose: the
 * sidebar's remembered locations (utils/last-location) read it without pulling in the
 * Settings registry.
 *
 * `#plugin-store` was the plugin list; `#<plugin>:<panel>` was one plugin's settings
 * panel, which is now on that plugin's page in Apps (`/apps?plugin=<id>&panel=<panel>`).
 */

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
  if (!m) return null
  return `/apps?${new URLSearchParams({ plugin: m[1]!, panel: m[2]! }).toString()}`
}
