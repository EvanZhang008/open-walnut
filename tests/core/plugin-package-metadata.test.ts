/**
 * Publishing contract for the two npm packages (`@open-walnut/plugin-api`,
 * `@open-walnut/plugin-cli`).
 *
 * Two layers, because they fail differently:
 *   1. package.json invariants — always run. A missing `publishConfig.access`
 *      or a lingering `private: true` only shows up as a failed release.
 *   2. what npm would actually pack — needs a built `dist`, so it is skipped on
 *      a clean checkout. This is the layer that catches an `exports` target that
 *      the `files` allowlist quietly leaves out of the tarball.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const ROOT_LICENSE = fs.readFileSync(path.join(REPO_ROOT, 'LICENSE'), 'utf8')
const REPO_URL = 'https://github.com/EvanZhang008/open-walnut'
const webRequire = createRequire(path.join(REPO_ROOT, 'web', 'package.json'))

const PACKAGES = [
  { name: '@open-walnut/plugin-api', dir: 'packages/plugin-api' },
  { name: '@open-walnut/plugin-cli', dir: 'packages/plugin-cli' },
] as const

type PackageJson = Record<string, any>

function packageDir(dir: string): string {
  return path.join(REPO_ROOT, dir)
}

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(packageDir(dir), 'package.json'), 'utf8')) as PackageJson
}

function isBuilt(dir: string): boolean {
  return fs.existsSync(path.join(packageDir(dir), 'dist', 'index.js'))
}

function namedConstExports(file: string): string[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
  return [...source.matchAll(/^export const ([A-Za-z_$][\w$]*)/gm)]
    .map((match) => match[1])
    .sort()
}

/** Every `./…` file an exports map points at, whatever the condition. */
function exportTargets(exportsMap: unknown): string[] {
  const targets = new Set<string>()
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) targets.add(value.slice(2))
      return
    }
    if (value && typeof value === 'object') for (const nested of Object.values(value)) walk(nested)
  }
  walk(exportsMap)
  return [...targets]
}

const packCache = new Map<string, string[]>()

/** The file list npm would put in the tarball, straight from npm itself. */
function packedFiles(dir: string): string[] {
  const cached = packCache.get(dir)
  if (cached) return cached
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageDir(dir),
    encoding: 'utf8',
    timeout: 90_000,
  })
  if (result.status !== 0) {
    throw new Error(`npm pack failed in ${dir}: ${result.stderr || result.error?.message || 'unknown error'}`)
  }
  const start = result.stdout.indexOf('[')
  const end = result.stdout.lastIndexOf(']')
  const parsed = JSON.parse(result.stdout.slice(start, end + 1)) as Array<{ files: Array<{ path: string }> }>
  const files = parsed[0].files.map((file) => file.path)
  packCache.set(dir, files)
  return files
}

describe.each(PACKAGES)('$name publishing contract', ({ name, dir }) => {
  const pkg = readPackageJson(dir)
  const built = isBuilt(dir)

  it('is publishable to the public registry', () => {
    expect(pkg.name).toBe(name)
    expect(pkg.private).toBeUndefined()
    expect(pkg.publishConfig).toEqual({ access: 'public' })
    expect(pkg.license).toBe('MIT')
    expect(pkg.type).toBe('module')
    expect(pkg.engines.node).toBe('>=22')
    expect(pkg.description).toMatch(/\S/)
  })

  it('tells a registry visitor where the project lives', () => {
    expect(pkg.homepage.startsWith(REPO_URL)).toBe(true)
    expect(pkg.repository).toEqual({
      type: 'git',
      url: `git+${REPO_URL}.git`,
      directory: dir,
    })
    expect(pkg.bugs.url).toBe(`${REPO_URL}/issues`)
    expect(pkg.keywords).toContain('open-walnut')
    expect(pkg.keywords.length).toBeGreaterThanOrEqual(4)
  })

  it('allowlists the files a consumer needs and nothing that expands', () => {
    expect(pkg.files).toContain('dist')
    expect(pkg.files).toContain('!dist/**/*.map')
    expect(pkg.files).toContain('README.md')
    expect(pkg.files).toContain('LICENSE')

    // An allowlist entry that matches nothing is dead weight that reads like a
    // promise (`templates` outlived the directory it named).
    for (const entry of pkg.files as string[]) {
      if (entry.startsWith('!') || entry.includes('*')) continue
      if (entry === 'dist' && !built) continue
      expect(fs.existsSync(path.join(packageDir(dir), entry)), `files entry ${entry} does not exist`).toBe(true)
    }
  })

  it('ships its own README and the project license', () => {
    expect(fs.readFileSync(path.join(packageDir(dir), 'README.md'), 'utf8')).toContain(`# ${name}`)
    expect(fs.readFileSync(path.join(packageDir(dir), 'LICENSE'), 'utf8')).toBe(ROOT_LICENSE)
  })

  it('resolves for both type-checkers and ESM loaders, and never for require', () => {
    expect(pkg.main).toBe('./dist/index.js')
    expect(pkg.types).toBe('./dist/index.d.ts')
    expect(pkg.exports['./package.json']).toBe('./package.json')

    for (const [subpath, entry] of Object.entries(pkg.exports as Record<string, unknown>)) {
      if (subpath === './package.json') continue
      expect(entry, `${subpath} must declare conditions`).toBeTypeOf('object')
      const conditions = entry as Record<string, string>
      expect(Object.keys(conditions).sort()).toEqual(['default', 'import', 'types'])
      expect(conditions.types).toMatch(/\.d\.ts$/)
      expect(conditions.default).toBe(conditions.import)
      // ESM-only package: a `require` condition would hand CJS callers a file
      // Node then refuses to load.
      expect(conditions).not.toHaveProperty('require')
    }
  })

  it.skipIf(!built)('builds without source maps', () => {
    const maps = fs.readdirSync(path.join(packageDir(dir), 'dist')).filter((file) => file.endsWith('.map'))
    expect(maps).toEqual([])
  })

  describe.skipIf(!built)('npm pack --dry-run', () => {
    const files = built ? packedFiles(dir) : []

    it('carries the metadata files and no source maps', () => {
      expect(files).toContain('package.json')
      expect(files).toContain('README.md')
      expect(files).toContain('LICENSE')
      expect(files.filter((file) => file.endsWith('.map'))).toEqual([])
    })

    it('carries every file the exports map points at', () => {
      const missing = exportTargets(pkg.exports).filter(
        (target) => target !== 'package.json' && !files.includes(target),
      )
      expect(missing).toEqual([])
    })

    it('leaves sources and build config out of the tarball', () => {
      const leaked = files.filter(
        (file) => file.startsWith('src/') || (file.endsWith('.ts') && !file.endsWith('.d.ts')),
      )
      expect(leaked).toEqual([])
      expect(files).not.toContain('tsconfig.json')
      expect(files).not.toContain('tsup.config.ts')
    })
  })
})

describe('@open-walnut/plugin-api publishing contract', () => {
  const pkg = readPackageJson('packages/plugin-api')

  it('exports every documented entry point', () => {
    expect(Object.keys(pkg.exports)).toEqual([
      '.',
      './server',
      './web',
      './testing',
      './react',
      './react-dom',
      './jsx-runtime',
      './jsx-dev-runtime',
      './package.json',
    ])
  })

  it('treats React as an optional peer but ships its types', () => {
    expect(pkg.peerDependencies.react).toBe('>=19')
    expect(pkg.peerDependenciesMeta.react.optional).toBe(true)
    // The root `.d.ts` re-exports the web contracts, which reference React
    // types. A server-only consumer installs no React, so the TYPES have to be a
    // real dependency or its `tsc` cannot resolve the root entry at all.
    expect(pkg.dependencies['@types/react']).toMatch(/^\^19/)
    expect(pkg.dependencies.react).toBeUndefined()
    expect(pkg.devDependencies?.['@types/react']).toBeUndefined()
  })

  it('mirrors every public named export from the host React runtimes', () => {
    const publicNames = (runtime: Record<string, unknown>): string[] => Object.keys(runtime)
      .filter((name) => name !== 'default' && name !== 'module.exports' && !name.startsWith('__'))
      .sort()
    expect(namedConstExports('packages/plugin-api/src/react.ts')).toEqual(
      publicNames(webRequire('react') as Record<string, unknown>),
    )
    expect(namedConstExports('packages/plugin-api/src/react-dom.ts')).toEqual(
      publicNames({
        ...(webRequire('react-dom') as Record<string, unknown>),
        ...(webRequire('react-dom/client') as Record<string, unknown>),
      }),
    )
  })
})

describe('@open-walnut/plugin-cli publishing contract', () => {
  const dir = 'packages/plugin-cli'
  const pkg = readPackageJson(dir)
  const built = isBuilt(dir)

  it('depends on the API package by caret range', () => {
    const api = readPackageJson('packages/plugin-api')
    // 0.x caret ranges do not cross a minor bump, so this pin has to move with
    // the API package; asserting the exact range keeps the two releases honest.
    expect(pkg.dependencies['@open-walnut/plugin-api']).toBe(`^${api.version}`)
    expect(pkg.walnut.engineFloor).toMatch(/^>=\d+\.\d+\.\d+$/)
  })

  it('exposes the bin and no stale template allowlist', () => {
    expect(pkg.bin).toEqual({ 'walnut-plugin': './dist/cli.js' })
    expect(pkg.files).not.toContain('templates')
    expect(fs.existsSync(path.join(packageDir(dir), 'templates'))).toBe(false)
  })

  it.skipIf(!built)('puts the shebang in the bin only', () => {
    const distDir = path.join(packageDir(dir), 'dist')
    expect(fs.readFileSync(path.join(distDir, 'cli.js'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
    // A shebang at the top of the library entry would ride into every consumer
    // that imports the package.
    expect(fs.readFileSync(path.join(distDir, 'index.js'), 'utf8').startsWith('#!')).toBe(false)
    expect(fs.existsSync(path.join(distDir, 'index.d.ts'))).toBe(true)
  })

  it.skipIf(!built)('packs the bin', () => {
    expect(packedFiles(dir)).toContain('dist/cli.js')
  })
})
