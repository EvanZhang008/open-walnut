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
  build?: PluginBuildConfig
}

export interface ValidationResult {
  manifest?: PluginManifest
  errors: string[]
  warnings: string[]
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

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
