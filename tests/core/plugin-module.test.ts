import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { preparePluginModule } from '../../src/core/plugins/plugin-module.js'
import { createPluginGeneration, resetGenerationStateForTesting } from '../../src/core/plugins/plugin-module-snapshot.js'
import type { PluginManifest } from '../../src/core/integration-types.js'

let tmp: string
let cacheRoot: string
let bundleDir: string
let bundle: ReturnType<typeof vi.fn>

beforeEach(async () => {
  // Real path, so a copied module's own __dirname compares equal to the path we handed Node.
  tmp = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'plugin-module-'))
  cacheRoot = path.join(tmp, 'cache')
  bundleDir = path.join(tmp, 'bundles')
  await fsp.mkdir(bundleDir, { recursive: true })
  bundle = vi.fn(async (_dir: string, entry: string) => {
    const outfile = path.join(bundleDir, `${randomUUID()}.mjs`)
    await fsp.writeFile(outfile, `export function activate() { return 'bundled:${path.basename(entry)}' }\n`)
    return { outfile }
  })
  resetGenerationStateForTesting()
})

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

async function writePlugin(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(tmp, 'plugins', name)
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, content)
  }
  return dir
}

function prepare(dir: string, manifest: Partial<PluginManifest> & { id: string }, replacement = false) {
  return preparePluginModule({
    dir,
    builtin: false,
    manifest: { name: manifest.id, ...manifest } as PluginManifest,
    bundle: bundle as never,
    deadline: async <T>(pending: Promise<T>) => pending,
    cacheRoot,
    replacement,
  })
}

async function generations(id: string): Promise<string[]> {
  return (await fsp.readdir(path.join(cacheRoot, id)).catch(() => [] as string[])).sort()
}

async function listTree(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir, { recursive: true }) as string[]).sort()
}

describe('preparePluginModule:precompiled CJS', () => {
  it('keeps require and __dirname working, reading assets from the generation copy', async () => {
    const dir = await writePlugin('cjs-plugin', {
      'package.json': JSON.stringify({ name: 'cjs-plugin' }),
      'asset.txt': 'ASSET-1',
      'helper.js': 'module.exports = { value: "helper-1" }\n',
      'index.cjs': [
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        'module.exports = { activate: () => ({',
        '  dir: __dirname,',
        '  asset: fs.readFileSync(path.join(__dirname, "asset.txt"), "utf8"),',
        '  required: require("./helper.js").value,',
        '}) }',
      ].join('\n'),
    })

    const module = await prepare(dir, { id: 'cjs-plugin', apiVersion: 1, server: 'index.cjs' })
    expect(module.activate).toBeTypeOf('function')
    const result = await module.activate!({}) as { dir: string; asset: string; required: string }

    expect(result.asset).toBe('ASSET-1')
    expect(result.required).toBe('helper-1')
    expect(result.dir).toBe(module.sourceRoot)
    expect(result.dir.startsWith(path.join(cacheRoot, 'cjs-plugin'))).toBe(true)
    expect(module.reloadUnsafeReason).toBeUndefined()
  })

  it('accepts a legacy default-function export', async () => {
    const dir = await writePlugin('legacy-plugin', {
      'index.js': 'module.exports = function activate() { return "legacy:" + __dirname }\n',
    })

    const module = await prepare(dir, { id: 'legacy-plugin' })
    expect(await module.activate!({})).toBe(`legacy:${module.sourceRoot}`)
  })
})

describe('preparePluginModule:precompiled ESM', () => {
  it('gives a nested helper an import.meta.url next to its own assets', async () => {
    const dir = await writePlugin('esm-plugin', {
      'package.json': JSON.stringify({ name: 'esm-plugin', type: 'module' }),
      'lib/asset.txt': 'NESTED-1',
      'lib/read.mjs': [
        'import fs from "node:fs"',
        'import path from "node:path"',
        'import { fileURLToPath } from "node:url"',
        'export function readAsset() {',
        '  const here = path.dirname(fileURLToPath(import.meta.url))',
        '  return { here, text: fs.readFileSync(path.join(here, "asset.txt"), "utf8") }',
        '}',
      ].join('\n'),
      'index.mjs': 'import { readAsset } from "./lib/read.mjs"\nexport function activate() { return readAsset() }\n',
    })

    const module = await prepare(dir, { id: 'esm-plugin', apiVersion: 1, server: 'index.mjs' })
    const result = await module.activate!({}) as { here: string; text: string }

    expect(result.text).toBe('NESTED-1')
    expect(result.here).toBe(path.join(module.sourceRoot!, 'lib'))
  })
})

describe('preparePluginModule:reload isolation', () => {
  it('picks up a changed relative module while the old generation keeps the old one', async () => {
    const dir = await writePlugin('relative-plugin', {
      'package.json': JSON.stringify({ name: 'relative-plugin' }),
      'helper.js': 'module.exports = { value: "v1" }\n',
      'index.cjs': 'module.exports = { activate: () => require("./helper.js").value }\n',
    })

    const first = await prepare(dir, { id: 'relative-plugin', apiVersion: 1, server: 'index.cjs' })
    expect(await first.activate!({})).toBe('v1')

    await fsp.writeFile(path.join(dir, 'helper.js'), 'module.exports = { value: "v2" }\n')
    const second = await prepare(dir, { id: 'relative-plugin', apiVersion: 1, server: 'index.cjs' })

    expect(await second.activate!({})).toBe('v2')
    expect(await first.activate!({})).toBe('v1')
    expect(second.sourceRoot).not.toBe(first.sourceRoot)
    expect(await generations('relative-plugin')).toHaveLength(2)
  })

  it('picks up a new version of a bare npm dependency inside the plugin', async () => {
    const dir = await writePlugin('dep-plugin', {
      'package.json': JSON.stringify({ name: 'dep-plugin', dependencies: { dep: '1.0.0' } }),
      'node_modules/dep/package.json': JSON.stringify({ name: 'dep', main: 'index.js' }),
      'node_modules/dep/index.js': 'module.exports = { version: "v1" }\n',
      'index.cjs': 'module.exports = { activate: () => require("dep").version }\n',
    })

    const first = await prepare(dir, { id: 'dep-plugin', apiVersion: 1, server: 'index.cjs' })
    expect(await first.activate!({})).toBe('v1')
    expect(first.reloadUnsafeReason).toBeUndefined()

    await fsp.writeFile(path.join(dir, 'node_modules/dep/index.js'), 'module.exports = { version: "v2" }\n')
    const second = await prepare(dir, { id: 'dep-plugin', apiVersion: 1, server: 'index.cjs' })

    expect(await second.activate!({})).toBe('v2')
    expect(await first.activate!({})).toBe('v1')
  })

  it('rejects a nested file changing during the copy', async () => {
    const dir = await writePlugin('changing-plugin', {
      'index.cjs': 'module.exports = { activate() {} }',
      'lib/helper.cjs': 'module.exports = 1',
    })
    const original = fsp.copyFile.bind(fsp)
    const copy = vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      await original(from, to, mode)
      if (String(from).endsWith('helper.cjs')) await fsp.writeFile(String(from), 'module.exports = 200')
    })
    try {
      await expect(createPluginGeneration({ id: 'changing-plugin', dir, entryRelative: 'index.cjs', cacheRoot }))
        .rejects.toThrow('plugin source changed while it was being copied')
    } finally { copy.mockRestore() }
  })

  it('keeps a timed-out evaluation isolated until it really settles', async () => {
    const dir = await writePlugin('slow-evaluation', {
      'asset.txt': 'still available',
      'index.mjs': [
        'import fs from "node:fs/promises"',
        'await new Promise(resolve => { globalThis.__releaseModule = resolve })',
        'globalThis.__moduleAsset = await fs.readFile(new URL("./asset.txt", import.meta.url), "utf8")',
        'export function activate() {}',
      ].join('\n'),
    })
    try {
      await expect(preparePluginModule({
        dir, builtin: false, manifest: { id: 'slow-evaluation', name: 'Slow', apiVersion: 1, server: 'index.mjs' },
        bundle: bundle as never, cacheRoot,
        deadline: async pending => {
          await vi.waitFor(() => expect((globalThis as any).__releaseModule).toBeTypeOf('function'))
          void pending.catch(() => {})
          throw Object.assign(new Error('evaluation timed out'), { name: 'PluginCodeTimeoutError' })
        },
      })).rejects.toThrow('evaluation timed out')
      await expect(prepare(dir, { id: 'slow-evaluation', apiVersion: 1, server: 'index.mjs' }))
        .rejects.toThrow('module evaluation is still running')
      ;(globalThis as any).__releaseModule()
      await vi.waitFor(() => expect((globalThis as any).__moduleAsset).toBe('still available'))
    } finally {
      ;(globalThis as any).__releaseModule?.()
      delete (globalThis as any).__releaseModule
      delete (globalThis as any).__moduleAsset
    }
  })

  it('reads the old assets from an old generation after the source is rewritten', async () => {
    const dir = await writePlugin('asset-plugin', {
      'package.json': JSON.stringify({ name: 'asset-plugin' }),
      'asset.txt': 'OLD',
      'index.cjs': [
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        'module.exports = { activate: () => () => fs.readFileSync(path.join(__dirname, "asset.txt"), "utf8") }',
      ].join('\n'),
    })

    const first = await prepare(dir, { id: 'asset-plugin', apiVersion: 1, server: 'index.cjs' })
    const readOld = await first.activate!({}) as () => string
    await fsp.writeFile(path.join(dir, 'asset.txt'), 'NEW')
    const second = await prepare(dir, { id: 'asset-plugin', apiVersion: 1, server: 'index.cjs' })
    const readNew = await second.activate!({}) as () => string

    expect(readOld()).toBe('OLD')
    expect(readNew()).toBe('NEW')
  })
})

describe('preparePluginModule:what it never touches', () => {
  it('adds no file to the plugin source directory', async () => {
    const dir = await writePlugin('clean-plugin', {
      'package.json': JSON.stringify({ name: 'clean-plugin' }),
      'index.cjs': 'module.exports = { activate: () => "ok" }\n',
    })
    const before = await listTree(dir)

    await prepare(dir, { id: 'clean-plugin', apiVersion: 1, server: 'index.cjs' })

    expect(await listTree(dir)).toEqual(before)
  })

  it('excludes .git and .plugin-cache from the copy', async () => {
    const dir = await writePlugin('excluded-plugin', {
      'package.json': JSON.stringify({ name: 'excluded-plugin' }),
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.plugin-cache/old.mjs': 'export default 1\n',
      'index.cjs': 'module.exports = { activate: () => "ok" }\n',
    })

    const module = await prepare(dir, { id: 'excluded-plugin', apiVersion: 1, server: 'index.cjs' })
    const copied = await listTree(module.sourceRoot!)

    expect(copied.some(entry => entry.startsWith('.git'))).toBe(false)
    expect(copied.some(entry => entry.startsWith('.plugin-cache'))).toBe(false)
    expect(copied).toContain('index.cjs')
  })

  it('still bundles a .ts plugin and leaves no generation behind', async () => {
    const dir = await writePlugin('ts-plugin', {
      'index.ts': 'export function activate(): string { return "unused" }\n',
    })

    const module = await prepare(dir, { id: 'ts-plugin', apiVersion: 1, server: 'index.ts' })

    expect(bundle).toHaveBeenCalledTimes(1)
    expect(bundle.mock.calls[0][1]).toBe(path.join(dir, 'index.ts'))
    expect(await module.activate!({})).toBe('bundled:index.ts')
    expect(module.sourceRoot).toBeUndefined()
    expect(module.dispose).toBeUndefined()
    expect(await generations('ts-plugin')).toEqual([])
    expect(await fsp.readdir(bundleDir)).toEqual([])
  })

  it('disposes only its own generation', async () => {
    const dir = await writePlugin('dispose-plugin', {
      'package.json': JSON.stringify({ name: 'dispose-plugin' }),
      'index.cjs': 'module.exports = { activate: () => "ok" }\n',
    })

    const first = await prepare(dir, { id: 'dispose-plugin', apiVersion: 1, server: 'index.cjs' })
    const second = await prepare(dir, { id: 'dispose-plugin', apiVersion: 1, server: 'index.cjs' })
    expect(await generations('dispose-plugin')).toHaveLength(2)

    await second.dispose!()

    expect(await fsp.stat(second.sourceRoot!).catch(() => null)).toBeNull()
    expect(await fsp.stat(first.sourceRoot!).then(stat => stat.isDirectory())).toBe(true)
    expect(await listTree(dir)).toContain('index.cjs')
  })
})

describe('preparePluginModule:trees that cannot be copied', () => {
  it('loads a native-addon plugin in place and says a reload cannot replace it', async () => {
    const dir = await writePlugin('native-plugin', {
      'package.json': JSON.stringify({ name: 'native-plugin' }),
      'node_modules/dep/build/Release/dep.node': 'not a real addon',
      'index.cjs': 'module.exports = { activate: () => __dirname }\n',
    })

    const module = await prepare(dir, { id: 'native-plugin', apiVersion: 1, server: 'index.cjs' })

    expect(await module.activate!({})).toBe(dir)
    expect(module.sourceRoot).toBeUndefined()
    expect(module.dispose).toBeUndefined()
    expect(module.reloadUnsafeReason).toMatch(/native addon dep\.node/)
    expect(await generations('native-plugin')).toEqual([])
  })

  it('rejects a newly unsafe replacement before evaluating it', async () => {
    const dir = await writePlugin('unsafe-update', {
      'index.cjs': 'throw new Error("must not evaluate")',
      'addon.node': 'not a real addon',
    })
    await expect(prepare(dir, { id: 'unsafe-update', apiVersion: 1, server: 'index.cjs' }, true))
      .rejects.toThrow(/requires a process restart/)
  })

  it('loads in place when a link leaves the plugin directory', async () => {
    const outside = path.join(tmp, 'outside-dep')
    await fsp.mkdir(outside, { recursive: true })
    await fsp.writeFile(path.join(outside, 'index.js'), 'module.exports = { version: "outside" }\n')
    const dir = await writePlugin('linked-plugin', {
      'package.json': JSON.stringify({ name: 'linked-plugin' }),
      'index.cjs': 'module.exports = { activate: () => __dirname }\n',
    })
    await fsp.mkdir(path.join(dir, 'node_modules'), { recursive: true })
    await fsp.symlink(outside, path.join(dir, 'node_modules', 'linked'))

    const module = await prepare(dir, { id: 'linked-plugin', apiVersion: 1, server: 'index.cjs' })

    expect(await module.activate!({})).toBe(dir)
    expect(module.reloadUnsafeReason).toMatch(/leaves the plugin directory/)
    expect(await generations('linked-plugin')).toEqual([])
  })
})
