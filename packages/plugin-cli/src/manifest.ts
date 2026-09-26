import fs from 'node:fs/promises'
import path from 'node:path'

export interface PluginBuildConfig {
  server?: string
  web?: string
  external?: string[]
}

export interface PluginManifest {
  id: string
  name: string
  version?: string
  apiVersion?: number
  engines?: { walnut?: string }
  server?: string
  web?: string
  webview?: { title: string; entry?: string; icon?: string }
  /** Relative `.svg` path inside the plugin folder: the plugin's tile in Settings, Plugins. */
  icon?: string
  build?: PluginBuildConfig
  settingsIn?: 'plugins' | 'app'
}

export interface ValidationResult {
  manifest?: PluginManifest
  errors: string[]
  warnings: string[]
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** The host refuses a larger icon (413) and draws the monogram instead. */
const ICON_MAX_BYTES = 64 * 1024

export async function readManifest(root = process.cwd()): Promise<PluginManifest> {
  const file = path.join(root, 'manifest.json')
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object') throw new Error('manifest.json must contain an object')
  return raw as PluginManifest
}

export function safeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) return false
  return !normalized.split('/').some((segment) => segment === '..')
}

export async function validatePlugin(root = process.cwd()): Promise<ValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  let manifest: PluginManifest
  try {
    manifest = await readManifest(root)
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)], warnings }
  }

  if (!ID_PATTERN.test(manifest.id ?? '')) errors.push('manifest.id must match /^[a-z0-9][a-z0-9._-]{0,63}$/')
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('manifest.name is required')
  if (manifest.apiVersion !== 1) errors.push('manifest.apiVersion must be 1')
  if (!manifest.engines?.walnut) errors.push('manifest.engines.walnut is required')
  if (!manifest.server && !manifest.web && !manifest.webview) {
    warnings.push('plugin has no server, web, or webview entry')
  }

  for (const [field, value] of [['server', manifest.server], ['web', manifest.web]] as const) {
    if (value !== undefined && !safeRelativePath(value)) errors.push(`manifest.${field} must be a safe relative path`)
  }
  if (manifest.webview?.entry && !safeRelativePath(manifest.webview.entry)) {
    errors.push('manifest.webview.entry must be a safe relative path')
  }
  if (manifest.settingsIn !== undefined && manifest.settingsIn !== 'plugins' && manifest.settingsIn !== 'app') {
    errors.push("manifest.settingsIn must be 'plugins' or 'app'")
  }

  // The same rules the host applies when it serves the icon (validatePluginIconPath and
  // PLUGIN_ICON_MAX_BYTES in src/core/plugins/plugin-icon.ts), so an icon that passes
  // here never turns into a silent monogram after install.
  if (manifest.icon !== undefined) {
    if (!safeRelativePath(manifest.icon)) {
      errors.push('manifest.icon must be a path inside the plugin folder, for example "icon.svg"')
    } else if (/["'<>?#\0]/.test(manifest.icon)) {
      errors.push('manifest.icon contains characters a file name cannot use here')
    } else if (!manifest.icon.trim().toLowerCase().endsWith('.svg')) {
      errors.push('manifest.icon must be an .svg file')
    } else {
      try {
        const stat = await fs.stat(path.join(root, manifest.icon))
        if (stat.size > ICON_MAX_BYTES) {
          errors.push(`manifest.icon is ${Math.ceil(stat.size / 1024)} KB; an icon must be at most ${ICON_MAX_BYTES / 1024} KB`)
        }
      } catch {
        errors.push(`manifest.icon file does not exist: ${manifest.icon}`)
      }
    }
  }

  const sourceEntries = [manifest.build?.server, manifest.build?.web].filter((entry): entry is string => !!entry)
  for (const entry of sourceEntries) {
    if (!safeRelativePath(entry)) {
      errors.push(`build entry ${JSON.stringify(entry)} must be a safe relative path`)
      continue
    }
    try { await fs.access(path.join(root, entry)) }
    catch { errors.push(`build entry does not exist: ${entry}`) }
  }

  return { manifest, errors, warnings }
}

export function assertValid(result: ValidationResult): PluginManifest {
  if (!result.manifest || result.errors.length > 0) {
    throw new Error(result.errors.join('\n') || 'Plugin manifest is invalid')
  }
  return result.manifest
}
