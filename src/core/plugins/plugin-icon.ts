/**
 * Plugin icons: the manifest `icon` field, and the one reader behind
 * GET /api/plugin-runtime/:id/icon and the store rows' `iconUrl`.
 *
 * Public contract (docs/reference/plugin-development.md, Manifest): `icon` names an SVG
 * file inside the plugin folder by a relative path. Settings draws it as a single-color
 * mark on the plugin's tinted tile (every visible pixel white), so a line or solid glyph
 * on a transparent background reads well; a plugin without one gets a monogram.
 *
 * Nothing here throws. An unusable field or file means "no icon", reported with a plain
 * reason, and the Settings row falls back to its monogram.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

/** An icon is a small mark; anything bigger is a mistake (an embedded bitmap), not an icon. */
export const PLUGIN_ICON_MAX_BYTES = 64 * 1024

export type PluginIconPathCheck = { ok: true; rel: string } | { ok: false; error: string }

/**
 * `icon` must be a relative `.svg` path that stays inside the plugin folder. `..` is
 * checked segment-wise, so an ordinary name such as `v1..2.svg` is still accepted.
 */
export function validatePluginIconPath(raw: unknown): PluginIconPathCheck {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'icon must name a file, for example "icon.svg"' }
  }
  const value = raw.trim().replace(/\\/g, '/')
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    return { ok: false, error: 'icon must be a path inside the plugin folder, not an absolute path' }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    return { ok: false, error: 'icon must be a file in the plugin folder, not a URL' }
  }
  if (/["'<>?#\0]/.test(value)) return { ok: false, error: 'icon contains characters a file name cannot use here' }
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return { ok: false, error: 'icon must name a file, for example "icon.svg"' }
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, error: 'icon must stay inside the plugin folder (no ".." in the path)' }
  }
  const rel = segments.join('/')
  if (!rel.toLowerCase().endsWith('.svg')) return { ok: false, error: 'icon must be an .svg file' }
  return { ok: true, rel }
}

export interface PluginIconFile {
  file: string
  size: number
  mtimeMs: number
}

export type PluginIconLookup =
  | ({ ok: true } & PluginIconFile)
  | { ok: false; status: 404 | 413; error: string }

const none = (error: string): PluginIconLookup => ({ ok: false, status: 404, error })

/**
 * The icon a plugin folder declares, when its manifest names a usable SVG that exists.
 * The folder and the file are both realpath'd, so a symlinked icon can never lead the
 * route out of the plugin folder.
 */
export async function findPluginIcon(pluginDir: string): Promise<PluginIconLookup> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(pluginDir, 'manifest.json'), 'utf-8'))
  } catch {
    return none('the plugin has no readable manifest.json')
  }
  const raw = manifest && typeof manifest === 'object' ? (manifest as { icon?: unknown }).icon : undefined
  if (raw === undefined) return none('the plugin declares no icon')
  const checked = validatePluginIconPath(raw)
  if (!checked.ok) return none(checked.error)
  let root: string
  let file: string
  try {
    root = await fsp.realpath(pluginDir)
    file = await fsp.realpath(path.join(root, checked.rel))
  } catch {
    return none(`${checked.rel} does not exist in the plugin folder`)
  }
  if (!file.startsWith(root + path.sep)) return none('icon must stay inside the plugin folder')
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size === 0) return none(`${checked.rel} is not a file`)
    if (stat.size > PLUGIN_ICON_MAX_BYTES) {
      return { ok: false, status: 413, error: `${checked.rel} is larger than ${PLUGIN_ICON_MAX_BYTES / 1024} KB` }
    }
    return { ok: true, file, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return none(`${checked.rel} does not exist in the plugin folder`)
  }
}

/** Changes whenever the file does, so the short browser cache never shows an old icon for long. */
export function pluginIconVersion(icon: PluginIconFile): string {
  return `${Math.round(icon.mtimeMs).toString(36)}-${icon.size.toString(36)}`
}

export function pluginIconUrl(pluginId: string, icon: PluginIconFile): string {
  return `/api/plugin-runtime/${encodeURIComponent(pluginId)}/icon?v=${pluginIconVersion(icon)}`
}

/** The file's bytes, or the lookup's refusal. A file that grew past the cap after its stat is refused too. */
export async function readPluginIcon(
  pluginDir: string,
): Promise<{ ok: true; body: Buffer } | { ok: false; status: 404 | 413; error: string }> {
  const found = await findPluginIcon(pluginDir)
  if (!found.ok) return found
  try {
    const body = await fsp.readFile(found.file)
    if (body.length > PLUGIN_ICON_MAX_BYTES) {
      return { ok: false, status: 413, error: `the icon is larger than ${PLUGIN_ICON_MAX_BYTES / 1024} KB` }
    }
    return { ok: true, body }
  } catch {
    return { ok: false, status: 404, error: 'the icon file could not be read' }
  }
}
