/**
 * The 28px tile that leads every plugin row in Settings, Plugins.
 *
 * A plugin whose manifest declares `icon` gets that SVG, drawn white on its tint (the
 * icon is a template mark, see src/core/plugins/plugin-icon.ts); one without gets its
 * monogram on the same tint. Tints and the letter rule come from the Settings sidebar
 * (settings-icons.tsx), so a plugin reads the same in both places. An icon that fails
 * to load falls back to the monogram instead of a broken image.
 *
 * On a cloud replica every /api request needs the device token, which an `<img>` cannot
 * send, so there the SVG is fetched with it and drawn from a blob URL. With no token
 * stored (the Mac on its own LAN) the tile keeps the plain `<img src>`.
 */
import { useEffect, useState } from 'react'
import { apiGetText } from '@/api/client'
import { getDeviceToken } from '@/api/device-token'
import { hashPluginId, monogramFor, PLUGIN_TINTS } from './settings-icons'
import '@/styles/settings-plugin-icon.css'

/** One fetch per icon version (`?v=` is in the key) for the page's life; a few KB each. */
const authedIcons = new Map<string, Promise<string>>()

function authedIconSrc(iconUrl: string): Promise<string> {
  let pending = authedIcons.get(iconUrl)
  if (!pending) {
    pending = apiGetText(iconUrl, undefined, { timeoutMs: 10_000 })
      .then((svg) => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })))
    // A failure is not cached: the next mount tries again.
    pending.catch(() => { authedIcons.delete(iconUrl) })
    authedIcons.set(iconUrl, pending)
  }
  return pending
}

/** The src to draw: the URL itself, or (with a device token) a blob URL once it has loaded. */
function useIconSrc(iconUrl: string | undefined): { src?: string; failed: boolean } {
  const needsToken = Boolean(iconUrl) && Boolean(getDeviceToken())
  const [loaded, setLoaded] = useState<{ url: string; src?: string; failed: boolean } | null>(null)
  useEffect(() => {
    if (!iconUrl || !needsToken) return
    let live = true
    authedIconSrc(iconUrl).then(
      (src) => { if (live) setLoaded({ url: iconUrl, src, failed: false }) },
      () => { if (live) setLoaded({ url: iconUrl, failed: true }) },
    )
    return () => { live = false }
  }, [iconUrl, needsToken])
  if (!iconUrl) return { failed: false }
  if (!needsToken) return { src: iconUrl, failed: false }
  return loaded?.url === iconUrl ? { src: loaded.src, failed: loaded.failed } : { failed: false }
}

interface PluginIconProps {
  name: string
  tint: string
  iconUrl?: string
}

export function PluginIcon({ name, tint, iconUrl }: PluginIconProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const icon = useIconSrc(iconUrl)
  const showImage = Boolean(icon.src) && !icon.failed && failedUrl !== iconUrl
  return (
    <span
      className="plugin-icon"
      style={{ background: tint }}
      data-plugin-icon={showImage ? 'image' : 'monogram'}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          className="plugin-icon-image"
          src={icon.src}
          alt=""
          width={18}
          height={18}
          decoding="async"
          draggable={false}
          onError={() => setFailedUrl(iconUrl ?? null)}
        />
      ) : (
        // Drawn by CSS from the attribute, so the row's text stays the plugin name alone.
        <span className="plugin-icon-monogram" data-letter={monogramFor(name)} />
      )}
    </span>
  )
}

/**
 * One tint per plugin id for a whole list, walked in list order. Each row starts at its
 * id's hashed tint (the sidebar's rule) and moves to the next tint not yet used in the
 * current run of six, so the first six rows all differ and neighbours never repeat.
 * Deterministic for a given list, and a row keeps its tint while rows below it change.
 */
export function pluginTileTints(rows: ReadonlyArray<{ id: string }>): Map<string, string> {
  const tints = new Map<string, string>()
  let used = new Set<string>()
  for (const row of rows) {
    if (tints.has(row.id)) continue
    if (used.size >= PLUGIN_TINTS.length) used = new Set()
    const start = hashPluginId(row.id) % PLUGIN_TINTS.length
    let tint: string = PLUGIN_TINTS[start]
    for (let i = 0; i < PLUGIN_TINTS.length; i++) {
      const candidate = PLUGIN_TINTS[(start + i) % PLUGIN_TINTS.length]
      if (!used.has(candidate)) { tint = candidate; break }
    }
    used.add(tint)
    tints.set(row.id, tint)
  }
  return tints
}
