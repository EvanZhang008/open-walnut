import fs from 'node:fs/promises'
import path from 'node:path'

export interface PluginBuildConfig {
  server?: string
  web?: string
  external?: string[]
}

/** The host's closed set (src/core/plugins/plugin-category.ts); it drops any other value. */
export const PLUGIN_CATEGORIES = ['communication', 'tasks', 'time', 'developer', 'other'] as const
export type PluginCategory = typeof PLUGIN_CATEGORIES[number]

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
  /** The Apps page group the plugin is listed under; omitted = derived from what it does. */
  category?: PluginCategory
  /** File areas beyond plugin-data: `files` (synced text, in git) and `tmp` (scratch with a TTL). */
  storage?: { files?: boolean | { maxBytes?: number }; tmp?: boolean | { ttlHours?: number } }
  /** Where the tasks the plugin's agents run in show: `everywhere` (default) or only in its own view. */
  taskVisibility?: 'everywhere' | 'plugin'
  /** Work that keeps running on one machine: `{ "<name>": { "every": "5m" } }` or `{ "<name>": { "kind": "long-running" } }`. */
  jobs?: Record<string, { every?: string; kind?: 'every' | 'long-running' }>
}

export interface ValidationResult {
  manifest?: PluginManifest
  errors: string[]
  warnings: string[]
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** The host refuses a larger icon (413) and draws the monogram instead. */
const ICON_MAX_BYTES = 64 * 1024
/** The host clamps to these (src/core/plugins/plugin-file-area.ts). */
const SYNCED_AREA_MAX_BYTES = 20 * 1024 * 1024
const TMP_MAX_TTL_HOURS = 30 * 24
/** The host's job rules (src/core/plugin-jobs/manifest.ts): it drops a job that breaks one. */
const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const MAX_JOBS = 16
const JOB_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function jobErrors(manifest: PluginManifest): string[] {
  const errors: string[] = []
  const jobs = manifest.jobs as unknown
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return ['manifest.jobs must be an object of job names']
  if (!manifest.server) errors.push('manifest.jobs needs a "server" entry: the jobs are exported from it')
  if (Object.keys(jobs).length > MAX_JOBS) errors.push(`manifest.jobs holds at most ${MAX_JOBS} jobs`)
  for (const [name, value] of Object.entries(jobs as Record<string, unknown>)) {
    if (!JOB_NAME.test(name)) { errors.push(`manifest.jobs.${name}: a job name is 1 to 40 lowercase letters, digits or dashes`); continue }
    const job = value as { every?: unknown; kind?: unknown } | null
    if (!job || typeof job !== 'object' || Array.isArray(job)) { errors.push(`manifest.jobs.${name} must be an object`); continue }
    if (job.kind === 'long-running') {
      if (job.every !== undefined) errors.push(`manifest.jobs.${name}: a long-running job has no "every"`)
      continue
    }
    if (job.kind !== undefined && job.kind !== 'every') { errors.push(`manifest.jobs.${name}.kind must be "long-running", or leave it out and give "every"`); continue }
    const m = typeof job.every === 'string' ? /^\s*(\d{1,6})\s*([smhd])\s*$/.exec(job.every) : null
    const ms = m ? Number(m[1]) * JOB_UNIT_MS[m[2]!]! : null
    if (ms === null) errors.push(`manifest.jobs.${name}.every must be like "30s", "5m", "1h" or "1d"`)
    else if (ms < 60_000 || ms > 7 * 86_400_000) errors.push(`manifest.jobs.${name}.every must be between 1m and 7d`)
  }
  return errors
}

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
  if (manifest.taskVisibility !== undefined && manifest.taskVisibility !== 'everywhere' && manifest.taskVisibility !== 'plugin') {
    errors.push("manifest.taskVisibility must be 'everywhere' or 'plugin'")
  }
  if (manifest.jobs !== undefined) errors.push(...jobErrors(manifest))
  if (manifest.category !== undefined && !(PLUGIN_CATEGORIES as readonly unknown[]).includes(manifest.category)) {
    errors.push(`manifest.category must be one of ${PLUGIN_CATEGORIES.map((c) => `'${c}'`).join(', ')}`)
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

  // The host drops a bad area with a warning; here it is an error, so the author fixes it before shipping.
  if (manifest.storage !== undefined) {
    const storage = manifest.storage as Record<string, unknown> | null
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
      errors.push('manifest.storage must be an object like { "files": true, "tmp": true }')
    } else {
      for (const key of Object.keys(storage)) {
        if (key !== 'files' && key !== 'tmp') errors.push(`manifest.storage.${key} is not an area; use "files" or "tmp"`)
      }
      const area = (key: 'files' | 'tmp', field: 'maxBytes' | 'ttlHours', max: number) => {
        const value = storage[key]
        if (value === undefined || typeof value === 'boolean') return
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          errors.push(`manifest.storage.${key} must be true or an object`)
          return
        }
        const n = (value as Record<string, unknown>)[field]
        if (n === undefined) return
        if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) errors.push(`manifest.storage.${key}.${field} must be a positive number`)
        else if (n > max) warnings.push(`manifest.storage.${key}.${field} is above ${max}; Walnut uses ${max}`)
      }
      area('files', 'maxBytes', SYNCED_AREA_MAX_BYTES)
      area('tmp', 'ttlHours', TMP_MAX_TTL_HOURS)
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
