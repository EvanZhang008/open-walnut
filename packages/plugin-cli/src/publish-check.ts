import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildPlugin } from './build.js'
import { assertValid, validatePlugin } from './manifest.js'

interface PackedFile {
  path: string
}

interface PackRecord {
  files?: PackedFile[]
}

export interface PublishCheckResult {
  id: string
  outputs: string[]
  packedFiles: string[]
  warnings: string[]
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '')
}

function npmPackFiles(root: string): Promise<string[]> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolve, reject) => {
    execFile(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim().slice(0, 4000)
        reject(new Error(`npm pack --dry-run failed${detail ? `: ${detail}` : ''}`))
        return
      }
      try {
        const raw = String(stdout)
        const start = raw.indexOf('[')
        const end = raw.lastIndexOf(']')
        if (start < 0 || end < start) throw new Error('npm pack did not return JSON')
        const records = JSON.parse(raw.slice(start, end + 1)) as PackRecord[]
        if (!Array.isArray(records) || records.length !== 1 || !Array.isArray(records[0]?.files)) {
          throw new Error('npm pack returned an unexpected file list')
        }
        resolve(records[0].files.map((file) => normalize(file.path)))
      } catch (parseError) {
        reject(parseError)
      }
    })
  })
}

function forbiddenPackedFile(file: string): boolean {
  const base = path.posix.basename(file).toLowerCase()
  return file.split('/').includes('node_modules')
    || base === '.env'
    || base.startsWith('.env.')
    || base === '.npmrc'
    || base === 'credentials.json'
    || base === 'secrets.json'
    || /\.(?:map|pem|key|p12|pfx)$/i.test(base)
}

function npmAlwaysIgnores(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === '.ds_store'
    || name.startsWith('._')
    || lower.endsWith('.swp')
    || lower.startsWith('.git')
    || lower.endsWith('.orig')
    || lower === 'npm-debug.log'
}

async function localFilesUnder(root: string, relative: string): Promise<string[]> {
  const normalized = normalize(relative)
  const absolute = path.join(root, normalized)
  let entries: Dirent[]
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (npmAlwaysIgnores(entry.name)) continue
    const child = path.posix.join(normalized, entry.name)
    if (entry.isDirectory()) files.push(...await localFilesUnder(root, child))
    else if (entry.isFile()) files.push(child)
  }
  return files
}

export async function publishCheck(root = process.cwd()): Promise<PublishCheckResult> {
  const validation = await validatePlugin(root)
  const manifest = assertValid(validation)
  let packageJson: Record<string, unknown>
  try {
    packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`publish-check requires a readable package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (packageJson.private === true) throw new Error('publish-check cannot publish a package with private: true')
  if (typeof packageJson.name !== 'string' || !packageJson.name.trim()) {
    throw new Error('publish-check requires package.json.name')
  }
  if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    throw new Error('publish-check requires package.json.version')
  }
  if (manifest.version !== packageJson.version) {
    throw new Error(`manifest.json version must match package.json version (${String(manifest.version)} != ${packageJson.version})`)
  }
  const build = await buildPlugin({ root, minify: true })
  const packedFiles = await npmPackFiles(root)
  const packed = new Set(packedFiles)
  const webviewEntry = manifest.webview?.entry ? normalize(manifest.webview.entry) : undefined
  const webviewDir = webviewEntry ? path.posix.dirname(webviewEntry) : undefined
  const webviewFiles = webviewEntry
    ? [
        webviewEntry,
        ...(webviewDir && webviewDir !== '.' ? await localFilesUnder(root, webviewDir) : []),
      ]
    : []
  const required = new Set([
    'manifest.json',
    ...build.outputs.map((output) => normalize(output.path)),
    ...webviewFiles,
    ...await localFilesUnder(root, 'skills'),
  ])
  // Sorted, because `readdir` order is filesystem-dependent and would report the same break differently per machine.
  const missing = [...required].filter((file) => !packed.has(file)).sort()
  if (missing.length > 0) {
    throw new Error(`npm package is missing required Plugin files: ${missing.join(', ')}`)
  }

  const forbidden = packedFiles.filter(forbiddenPackedFile)
  if (forbidden.length > 0) {
    throw new Error(`npm package contains forbidden files: ${forbidden.join(', ')}`)
  }

  return {
    id: manifest.id,
    outputs: build.outputs.map((output) => normalize(output.path)),
    packedFiles,
    warnings: validation.warnings,
  }
}
