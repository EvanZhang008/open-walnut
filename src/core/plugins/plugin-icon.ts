/**
 * Plugin pictures: the manifest `icon` and `screenshot` fields, and the one reader behind
 * GET /api/plugin-runtime/:id/icon and /screenshot, and the store rows' `iconUrl` and
 * `screenshotUrl`. Both name a file inside the plugin folder by a relative path; they differ
 * only in the file types and the size they take (`PLUGIN_ICON`, `PLUGIN_SCREENSHOT`).
 *
 * Public contract (docs/reference/plugin-development.md, Manifest): `icon` names an SVG
 * file inside the plugin folder by a relative path. Settings draws it as a single-color
 * mark on the plugin's tinted tile (every visible pixel white), so a line or solid glyph
 * on a transparent background reads well; a plugin without one gets a monogram.
 * `screenshot` names a PNG, JPEG or WebP picture of the plugin at work, at most 2 MB: the Apps
 * page's Store shows it under the plugin's card, and a plugin without one takes no room there.
 * An older Walnut reads only the manifest fields it knows, so a manifest with `screenshot` loads
 * there as before.
 *
 * Nothing here throws. An unusable field or file means "no picture", reported with a plain
 * reason, and the Settings row falls back to its monogram.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

/** An icon is a small mark; anything bigger is a mistake (an embedded bitmap), not an icon. */
export const PLUGIN_ICON_MAX_BYTES = 64 * 1024
/** A screenshot is one picture of the plugin's screen: more than a few MB is too much for a list. */
export const PLUGIN_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024

/** One kind of picture a manifest field names: the field, the file types it takes, its size cap. */
export interface PluginAssetRule {
  field: 'icon' | 'screenshot'
  /** Lower-case extensions with their dot. */
  extensions: readonly string[]
  maxBytes: number
  example: string
  /** How an error names the types it takes. */
  kinds: string
}

export const PLUGIN_ICON: PluginAssetRule = {
  field: 'icon', extensions: ['.svg'], maxBytes: PLUGIN_ICON_MAX_BYTES, example: 'icon.svg', kinds: 'an .svg file',
}
export const PLUGIN_SCREENSHOT: PluginAssetRule = {
  field: 'screenshot', extensions: ['.png', '.jpg', '.jpeg', '.webp'], maxBytes: PLUGIN_SCREENSHOT_MAX_BYTES,
  example: 'screenshot.png', kinds: 'a .png, .jpg or .webp file',
}

const sizeWords = (bytes: number) => (bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`)

export type PluginIconPathCheck = { ok: true; rel: string } | { ok: false; error: string }

/**
 * The field must be a relative path of one of its types that stays inside the plugin folder.
 * `..` is checked segment-wise, so an ordinary name such as `v1..2.svg` is still accepted.
 */
export function validatePluginAssetPath(raw: unknown, rule: PluginAssetRule): PluginIconPathCheck {
  const { field } = rule
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: `${field} must name a file, for example "${rule.example}"` }
  }
  const value = raw.trim().replace(/\\/g, '/')
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    return { ok: false, error: `${field} must be a path inside the plugin folder, not an absolute path` }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    return { ok: false, error: `${field} must be a file in the plugin folder, not a URL` }
  }
  if (/["'<>?#\0]/.test(value)) return { ok: false, error: `${field} contains characters a file name cannot use here` }
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return { ok: false, error: `${field} must name a file, for example "${rule.example}"` }
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, error: `${field} must stay inside the plugin folder (no ".." in the path)` }
  }
  const rel = segments.join('/')
  if (!rule.extensions.some((ext) => rel.toLowerCase().endsWith(ext))) return { ok: false, error: `${field} must be ${rule.kinds}` }
  return { ok: true, rel }
}

/** `icon` must be a relative `.svg` path that stays inside the plugin folder. */
export function validatePluginIconPath(raw: unknown): PluginIconPathCheck {
  return validatePluginAssetPath(raw, PLUGIN_ICON)
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
 * The picture a plugin folder's manifest names under `rule.field`, when it is usable and
 * exists. The folder and the file are both realpath'd, so a symlinked picture can never lead
 * the route out of the plugin folder.
 */
export async function findPluginAsset(pluginDir: string, rule: PluginAssetRule): Promise<PluginIconLookup> {
  const { field } = rule
  let manifest: unknown
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(pluginDir, 'manifest.json'), 'utf-8'))
  } catch {
    return none('the plugin has no readable manifest.json')
  }
  const raw = manifest && typeof manifest === 'object' ? (manifest as Record<string, unknown>)[field] : undefined
  if (raw === undefined) return none(`the plugin declares no ${field}`)
  const checked = validatePluginAssetPath(raw, rule)
  if (!checked.ok) return none(checked.error)
  let root: string
  let file: string
  try {
    root = await fsp.realpath(pluginDir)
    file = await fsp.realpath(path.join(root, checked.rel))
  } catch {
    return none(`${checked.rel} does not exist in the plugin folder`)
  }
  if (!file.startsWith(root + path.sep)) return none(`${field} must stay inside the plugin folder`)
  // The realpath may name another type (a symlink `shot.png` to `x.html`): the rule holds for it too.
  if (!rule.extensions.includes(path.extname(file).toLowerCase())) return none(`${field} must be ${rule.kinds}`)
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size === 0) return none(`${checked.rel} is not a file`)
    if (stat.size > rule.maxBytes) {
      return { ok: false, status: 413, error: `${checked.rel} is larger than ${sizeWords(rule.maxBytes)}` }
    }
    return { ok: true, file, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return none(`${checked.rel} does not exist in the plugin folder`)
  }
}

/** The icon a plugin folder declares, when its manifest names a usable SVG that exists. */
export function findPluginIcon(pluginDir: string): Promise<PluginIconLookup> {
  return findPluginAsset(pluginDir, PLUGIN_ICON)
}

/** Changes whenever the file does, so the short browser cache never shows an old picture for long. */
export function pluginIconVersion(icon: PluginIconFile): string {
  return `${Math.round(icon.mtimeMs).toString(36)}-${icon.size.toString(36)}`
}

export function pluginAssetUrl(pluginId: string, file: PluginIconFile, rule: PluginAssetRule): string {
  return `/api/plugin-runtime/${encodeURIComponent(pluginId)}/${rule.field}?v=${pluginIconVersion(file)}`
}

export function pluginIconUrl(pluginId: string, icon: PluginIconFile): string {
  return pluginAssetUrl(pluginId, icon, PLUGIN_ICON)
}

export type PluginAssetRead = { ok: true; body: Buffer; file: string } | { ok: false; status: 404 | 413; error: string }

/** The file's bytes, or the lookup's refusal. A file that grew past the cap after its stat is refused too. */
export async function readPluginAsset(pluginDir: string, rule: PluginAssetRule): Promise<PluginAssetRead> {
  const found = await findPluginAsset(pluginDir, rule)
  if (!found.ok) return found
  try {
    const body = await fsp.readFile(found.file)
    if (body.length > rule.maxBytes) {
      return { ok: false, status: 413, error: `the ${rule.field} is larger than ${sizeWords(rule.maxBytes)}` }
    }
    return { ok: true, body, file: found.file }
  } catch {
    return { ok: false, status: 404, error: `the ${rule.field} file could not be read` }
  }
}

export function readPluginIcon(pluginDir: string): Promise<PluginAssetRead> {
  return readPluginAsset(pluginDir, PLUGIN_ICON)
}
