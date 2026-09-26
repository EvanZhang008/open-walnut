/**
 * GET /api/plugin-runtime/:pluginId/icon, and the `iconUrl` every store row carries.
 *
 * One lookup serves both, so a row never advertises an icon the route would 404: the
 * folder an installed plugin runs from wins; a plugin that is not installed is found
 * where its catalog entry says it lives on this machine (the bundled store folder, the
 * builtin folder, or an example in this checkout). git and npm catalog rows have no
 * files here until they are installed, so they keep their monogram.
 *
 * A replica computes the same answer from its own copy of the build: bundled and builtin
 * icons resolve there, and a plugin that exists only on the Mac simply has no `iconUrl`.
 * The route sits behind the replica's Bearer auth, which an `<img>` cannot send, so the
 * web tile fetches the SVG with the device token there (PluginIcon.tsx).
 */

import path from 'node:path'
import type { Router } from 'express'
import { validatePluginId } from '../../core/plugins/ids.js'
import type { PluginCatalogEntry, PluginCatalogSource } from '../../core/plugins/plugin-catalog.js'
import { findPluginIcon, pluginIconUrl, readPluginIcon } from '../../core/plugins/plugin-icon.js'

/** Short: an icon can change under a linked checkout, and `?v=` already busts it when it does. */
const ICON_CACHE_CONTROL = 'private, max-age=300'

/**
 * An SVG is a document. Opened on its own it would run script in this origin, so the
 * response forbids every subresource and script and sandboxes it; an `<img>` never runs
 * script anyway, and the inline styles a drawing uses still apply.
 */
const ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

export interface PluginIconDirs {
  /** The folder a discovered plugin runs from, whatever its state. */
  installed(pluginId: string): Promise<string | undefined>
  /** This build's bundled store folder, or null when it carries none. */
  storeDir(): Promise<string | null>
  /** This build's builtin plugin folder (`dist/integrations` or `src/integrations`). */
  builtinDir(): Promise<string | null>
  /** The checkout an `example` entry's path is relative to, or null. */
  exampleRoot: string | null
}

/** A catalog path that stays under its root, or null. */
function safeRelative(value: string): string | null {
  const segments = value.replace(/\\/g, '/').split('/').filter((segment) => segment !== '' && segment !== '.')
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value) || segments.length === 0) return null
  return segments.some((segment) => segment === '..') ? null : segments.join('/')
}

/** Where a catalog entry's files are on this machine before it is installed, if anywhere. */
export async function catalogIconDir(
  entry: { id: string; source: PluginCatalogSource },
  dirs: PluginIconDirs,
): Promise<string | undefined> {
  const { source } = entry
  if (source.kind === 'bundled') {
    const store = await dirs.storeDir()
    const folder = path.posix.basename(source.path ?? entry.id)
    return store && folder !== '..' && folder !== '.' ? path.join(store, folder) : undefined
  }
  if (source.kind === 'builtin') {
    const builtin = await dirs.builtinDir()
    return builtin ? path.join(builtin, entry.id) : undefined
  }
  if (source.kind === 'example' && source.path && dirs.exampleRoot) {
    const rel = safeRelative(source.path)
    return rel ? path.join(dirs.exampleRoot, rel) : undefined
  }
  return undefined
}

/** The one lookup: the installed folder, else where the catalog entry lives here. */
async function iconDirFor(
  pluginId: string,
  entry: { id: string; source: PluginCatalogSource } | undefined,
  dirs: PluginIconDirs,
): Promise<string | undefined> {
  const installed = await dirs.installed(pluginId).catch(() => undefined)
  if (installed) return installed
  return entry ? catalogIconDir(entry, dirs) : undefined
}

/** Every row, in order, plus `iconUrl` where the icon exists. A lookup failure only drops that row's icon. */
export async function withPluginIconUrls<T extends { id: string; source: PluginCatalogSource }>(
  rows: readonly T[],
  catalog: readonly PluginCatalogEntry[],
  dirs: PluginIconDirs,
): Promise<Array<T & { iconUrl?: string }>> {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]))
  return Promise.all(rows.map(async (row) => {
    try {
      const dir = await iconDirFor(row.id, byId.get(row.id) ?? row, dirs)
      const icon = dir ? await findPluginIcon(dir) : null
      return icon?.ok ? { ...row, iconUrl: pluginIconUrl(row.id, icon) } : row
    } catch {
      return row
    }
  }))
}

export function mountPluginIconRoute(
  router: Router,
  opts: { dirs: PluginIconDirs; loadCatalog(): Promise<PluginCatalogEntry[]> },
): void {
  router.get('/:pluginId/icon', async (req, res) => {
    let pluginId: string
    try {
      const raw = req.params.pluginId
      pluginId = validatePluginId(Array.isArray(raw) ? raw[0] : raw)
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
      return
    }
    try {
      let dir = await opts.dirs.installed(pluginId).catch(() => undefined)
      if (!dir) {
        const entry = (await opts.loadCatalog()).find((candidate) => candidate.id === pluginId)
        dir = entry ? await catalogIconDir(entry, opts.dirs) : undefined
      }
      if (!dir) {
        res.status(404).json({ error: `Plugin "${pluginId}" is not on this machine` })
        return
      }
      const icon = await readPluginIcon(dir)
      if (!icon.ok) {
        res.status(icon.status).json({ error: `Plugin "${pluginId}" has no usable icon: ${icon.error}` })
        return
      }
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
      res.setHeader('Cache-Control', ICON_CACHE_CONTROL)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', ICON_CSP)
      // res.send adds the ETag and answers a matching If-None-Match with 304.
      res.send(icon.body)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
