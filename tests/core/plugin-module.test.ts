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
      'package.json': JSON.stringify({ name: 'native-plugin', dependencies: { dep: '*' } }),
      'node_modules/dep/package.json': JSON.stringify({ name: 'dep' }),
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

  it('copies and hot reloads a plugin whose only addons belong to dev or undeclared packages', async () => {
    const dir = await writePlugin('dev-native', {
      'package.json': JSON.stringify({
        name: 'dev-native',
        dependencies: { dep: '*' },
        devDependencies: { vitest: '*', '@rollup/rollup-darwin-arm64': '*' },
      }),
      'node_modules/dep/package.json': JSON.stringify({ name: 'dep', main: 'index.js' }),
      'node_modules/dep/index.js': 'module.exports = { version: "v1" }\n',
      'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', optionalDependencies: { fsevents: '*' } }),
      'node_modules/@rollup/rollup-darwin-arm64/package.json': JSON.stringify({ name: '@rollup/rollup-darwin-arm64' }),
      'node_modules/@rollup/rollup-darwin-arm64/rollup.darwin-arm64.node': 'not a real addon',
      // Declared by no runtime field anywhere, the way a hoisted transitive dev package lands.
      'node_modules/fsevents/package.json': JSON.stringify({ name: 'fsevents' }),
      'node_modules/fsevents/fsevents.node': 'not a real addon',
      'index.cjs': 'module.exports = { activate: () => require("dep").version }\n',
    })

    const first = await prepare(dir, { id: 'dev-native', apiVersion: 1, server: 'index.cjs' })
    expect(first.reloadUnsafeReason).toBeUndefined()
    expect(first.sourceRoot?.startsWith(path.join(cacheRoot, 'dev-native'))).toBe(true)
    expect(first.dispose).toBeTypeOf('function')
    expect(await first.activate!({})).toBe('v1')
    // The copy is still the whole tree, dev packages included.
    expect(await listTree(first.sourceRoot!)).toContain(path.join('node_modules', 'fsevents', 'fsevents.node'))

    await fsp.writeFile(path.join(dir, 'node_modules/dep/index.js'), 'module.exports = { version: "v2" }\n')
    const second = await prepare(dir, { id: 'dev-native', apiVersion: 1, server: 'index.cjs' }, true)

    expect(second.reloadUnsafeReason).toBeUndefined()
    expect(second.sourceRoot).not.toBe(first.sourceRoot)
    expect(await second.activate!({})).toBe('v2')
    expect(await first.activate!({})).toBe('v1')
    expect(await generations('dev-native')).toHaveLength(2)
  })

  it('refuses to replace a plugin whose runtime dependency pulls in an addon transitively', async () => {
    const dir = await writePlugin('transitive-native', {
      'package.json': JSON.stringify({ name: 'transitive-native', dependencies: { a: '*' }, devDependencies: { b: '*' } }),
      'node_modules/a/package.json': JSON.stringify({ name: 'a', dependencies: { b: '*' } }),
      'node_modules/b/package.json': JSON.stringify({ name: 'b' }),
      'node_modules/b/x.node': 'not a real addon',
      'index.cjs': 'module.exports = { activate: () => __dirname }\n',
    })
    const manifest = { id: 'transitive-native', apiVersion: 1 as const, server: 'index.cjs' }

    const first = await prepare(dir, manifest)
    expect(first.reloadUnsafeReason).toMatch(/native addon x\.node/)
    expect(first.sourceRoot).toBeUndefined()

    await expect(prepare(dir, manifest, true)).rejects.toThrow(/requires a process restart: native addon x\.node/)
    expect(await generations('transitive-native')).toEqual([])
  })

  it('resolves a nested copy of a dependency before the hoisted one, as Node does', async () => {
    const dir = await writePlugin('nested-native', {
      'package.json': JSON.stringify({ name: 'nested-native', dependencies: { a: '*' } }),
      'node_modules/a/package.json': JSON.stringify({ name: 'a', dependencies: { b: '*' } }),
      'node_modules/a/node_modules/b/package.json': JSON.stringify({ name: 'b', version: '2.0.0' }),
      'node_modules/a/node_modules/b/x.node': 'not a real addon',
      // The hoisted b has no addon, and is not the one `a` loads.
      'node_modules/b/package.json': JSON.stringify({ name: 'b', version: '1.0.0' }),
      'index.cjs': 'module.exports = { activate: () => __dirname }\n',
    })

    await expect(prepare(dir, { id: 'nested-native', apiVersion: 1, server: 'index.cjs' }, true))
      .rejects.toThrow(/requires a process restart: native addon x\.node/)
  })

  it('counts addons of optional and peer dependencies, scoped names included', async () => {
    const optional = await writePlugin('optional-native', {
      'package.json': JSON.stringify({ name: 'optional-native', optionalDependencies: { '@scope/opt': '*' } }),
      'node_modules/@scope/opt/package.json': JSON.stringify({ name: '@scope/opt' }),
      'node_modules/@scope/opt/opt.node': 'not a real addon',
      'index.cjs': 'module.exports = { activate: () => __dirname }\n',
    })
    const peer = await writePlugin('peer-native', {
      'package.json': JSON.stringify({ name: 'peer-native', peerDependencies: { peer: '*' } }),
      'node_modules/peer/package.json': JSON.stringify({ name: 'peer' }),
      'node_modules/peer/lib/peer.node': 'not a real addon',
      'index.cjs': 'module.exports = { activate: () => __dirname }\n',
    })

    expect((await prepare(optional, { id: 'optional-native', apiVersion: 1, server: 'index.cjs' })).reloadUnsafeReason)
      .toMatch(/native addon opt\.node/)
    expect((await prepare(peer, { id: 'peer-native', apiVersion: 1, server: 'index.cjs' })).reloadUnsafeReason)
      .toMatch(/native addon peer\.node/)
  })

  it('follows a link inside the tree to the real package (pnpm layout)', async () => {
    const dir = await writePlugin('pnpm-native', {
      'package.json': JSON.stringify({ name: 'pnpm-native', dependencies: { a: '*' } }),
      'node_modules/.pnpm/a@1.0.0/node_modules/a/package.json': JSON.stringify({ name: 'a', dependencies: { b: '*' } }),
      'node_modules/.pnpm/b@1.0.0/node_modules/b/package.json': JSON.stringify({ name: 'b' }),
      'node_modules/.pnpm/b@1.0.0/node_modules/b/b.node': 'not a real addon',
      'node_modules/.pnpm/dev@1.0.0/node_modules/dev/package.json': JSON.stringify({ name: 'dev' }),
      'node_modules/.pnpm/dev@1.0.0/node_modules/dev/dev.node': 'not a real addon',
      'index.cjs': 'module.exports = { activate: () => __dirname }\n',
    })
    await fsp.symlink(path.join('.pnpm', 'a@1.0.0', 'node_modules', 'a'), path.join(dir, 'node_modules', 'a'))
    await fsp.symlink(path.join('..', '..', 'b@1.0.0', 'node_modules', 'b'), path.join(dir, 'node_modules/.pnpm/a@1.0.0/node_modules/b'))

    const module = await prepare(dir, { id: 'pnpm-native', apiVersion: 1, server: 'index.cjs' })

    expect(module.reloadUnsafeReason).toMatch(/native addon b\.node/)
  })

  it('stays conservative when the root package.json is missing or unreadable', async () => {
    const missing = await writePlugin('no-manifest-native', {
      'node_modules/dev-only/package.json': JSON.stringify({ name: 'dev-only' }),
      'node_modules/dev-only/dev.node': 'not a real addon',
      'index.cjs': 'module.exports = { activate: () => __dirname }\n',
    })
    const broken = await writePlugin('broken-manifest-native', {
      'package.json': '{ "name": "broken-manifest-native", ',
      'node_modules/dev-only/package.json': JSON.stringify({ name: 'dev-only' }),
      'node_modules/dev-only/dev.node': 'not a real addon',
      'index.cjs': 'module.exports = { activate: () => __dirname }\n',
    })

    for (const [dir, id] of [[missing, 'no-manifest-native'], [broken, 'broken-manifest-native']]) {
      const module = await prepare(dir, { id, apiVersion: 1, server: 'index.cjs' })
      expect(module.reloadUnsafeReason).toMatch(/native addon dev\.node/)
      expect(module.sourceRoot).toBeUndefined()
      await expect(prepare(dir, { id, apiVersion: 1, server: 'index.cjs' }, true)).rejects.toThrow(/requires a process restart/)
    }
  })

  it('still counts the plugin\'s own addon outside node_modules', async () => {
    const dir = await writePlugin('own-native', {
      'package.json': JSON.stringify({ name: 'own-native', devDependencies: { vitest: '*' } }),
      'addon.node': 'not a real addon',
      'index.cjs': 'module.exports = { activate: () => __dirname }\n',
    })

    const module = await prepare(dir, { id: 'own-native', apiVersion: 1, server: 'index.cjs' })

    expect(module.reloadUnsafeReason).toMatch(/native addon addon\.node/)
    await expect(prepare(dir, { id: 'own-native', apiVersion: 1, server: 'index.cjs' }, true)).rejects.toThrow(/requires a process restart/)
  })

  it('rejects a newly unsafe replacement before evaluating it', async () => {
    const dir = await writePlugin('unsafe-update', {
      'index.cjs': 'throw new Error("must not evaluate")',
      'addon.node': 'not a real addon',
    })
    await expect(prepare(dir, { id: 'unsafe-update', apiVersion: 1, server: 'index.cjs' }, true))
      .rejects.toThrow(/requires a process restart/)
  })

  it('loads in place when a runtime dependency links out of the plugin directory', async () => {
    const outside = path.join(tmp, 'outside-dep')
    await fsp.mkdir(outside, { recursive: true })
    await fsp.writeFile(path.join(outside, 'index.js'), 'module.exports = { version: "outside" }\n')
    const dir = await writePlugin('linked-plugin', {
      'package.json': JSON.stringify({ name: 'linked-plugin', dependencies: { linked: 'file:../../outside-dep' } }),
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

/** A package outside the plugin directory, the way a `file:` install of a checkout's package looks. */
async function outsidePackage(name: string, files: Record<string, string> = {}): Promise<string> {
  const dir = path.join(tmp, 'checkout', name)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
  await fsp.writeFile(path.join(dir, 'index.js'), 'module.exports = { from: "outside" }\n')
  for (const [relative, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, relative)), { recursive: true })
    await fsp.writeFile(path.join(dir, relative), content)
  }
  return dir
}

async function link(target: string, at: string): Promise<void> {
  await fsp.mkdir(path.dirname(at), { recursive: true })
  await fsp.symlink(target, at)
}

describe('preparePluginModule: links out of the plugin directory', () => {
  // The "Build a plugin" fallback while the author packages are not on npm: both devDependencies
  // are `file:` links into a Walnut checkout, and npm adds a `.bin` shim through one of them.
  async function fallbackScaffold(name: string, server: string, extraPackage: Record<string, unknown> = {}): Promise<string> {
    const api = await outsidePackage('plugin-api')
    const cli = await outsidePackage('plugin-cli', { 'dist/cli.js': '#!/usr/bin/env node\n' })
    const dir = await writePlugin(name, {
      'package.json': JSON.stringify({
        name,
        type: 'module',
        devDependencies: { '@open-walnut/plugin-api': 'file:../../checkout/plugin-api', '@open-walnut/plugin-cli': 'file:../../checkout/plugin-cli', typescript: '*' },
        ...extraPackage,
      }),
      'node_modules/typescript/package.json': JSON.stringify({ name: 'typescript' }),
      'dist/server.mjs': server,
    })
    await link(api, path.join(dir, 'node_modules/@open-walnut/plugin-api'))
    await link(cli, path.join(dir, 'node_modules/@open-walnut/plugin-cli'))
    await link('../@open-walnut/plugin-cli/dist/cli.js', path.join(dir, 'node_modules/.bin/walnut-plugin'))
    return dir
  }

  it('replaces a plugin whose only outbound links are dev tooling, on every save', async () => {
    const dir = await fallbackScaffold('fallback-plugin', 'export function activate() { return "v1" }\n')
    const manifest = { id: 'fallback-plugin', apiVersion: 1 as const, server: 'dist/server.mjs' }

    const first = await prepare(dir, manifest)
    expect(first.reloadUnsafeReason).toBeUndefined()
    expect(first.sourceRoot?.startsWith(path.join(cacheRoot, 'fallback-plugin'))).toBe(true)
    expect(await first.activate!({})).toBe('v1')
    // Left out of the copy, never followed: nothing of the checkout lands in Walnut's cache.
    const copied = await listTree(first.sourceRoot!)
    expect(copied).not.toContain(path.join('node_modules', '.bin', 'walnut-plugin'))
    expect(copied).not.toContain(path.join('node_modules', '@open-walnut', 'plugin-api'))
    expect(copied).not.toContain(path.join('node_modules', '@open-walnut', 'plugin-cli'))
    expect(copied).toContain(path.join('node_modules', 'typescript', 'package.json'))

    for (const version of ['v2', 'v3']) {
      await fsp.writeFile(path.join(dir, 'dist/server.mjs'), `export function activate() { return "${version}" }\n`)
      const next = await prepare(dir, manifest, true)
      expect(next.reloadUnsafeReason).toBeUndefined()
      expect(await next.activate!({})).toBe(version)
    }
    expect(await first.activate!({})).toBe('v1')
  })

  it('still loads in place when the plugin\'s own folder links out', async () => {
    const outside = await outsidePackage('shared-assets')
    const dir = await writePlugin('own-link', {
      'package.json': JSON.stringify({ name: 'own-link' }),
      'index.cjs': 'module.exports = { activate: () => "own" }\n',
    })
    await link(outside, path.join(dir, 'assets'))

    const module = await prepare(dir, { id: 'own-link', apiVersion: 1, server: 'index.cjs' })
    expect(module.reloadUnsafeReason).toMatch(/link assets leaves the plugin directory/)
    await expect(prepare(dir, { id: 'own-link', apiVersion: 1, server: 'index.cjs' }, true))
      .rejects.toThrow(/requires a process restart/)
    expect(await generations('own-link')).toEqual([])
  })

  it('counts a link a transitive runtime package resolves through', async () => {
    const outside = await outsidePackage('deep')
    const dir = await writePlugin('transitive-link', {
      'package.json': JSON.stringify({ name: 'transitive-link', dependencies: { mid: '1.0.0' } }),
      'node_modules/mid/package.json': JSON.stringify({ name: 'mid', dependencies: { deep: '1.0.0' } }),
      'node_modules/mid/index.js': 'module.exports = 1\n',
      'index.cjs': 'module.exports = { activate: () => "t" }\n',
    })
    await link(outside, path.join(dir, 'node_modules/mid/node_modules/deep'))

    const module = await prepare(dir, { id: 'transitive-link', apiVersion: 1, server: 'index.cjs' })
    expect(module.reloadUnsafeReason).toMatch(/node_modules\/mid\/node_modules\/deep leaves the plugin directory/)
  })

  it('counts a link inside a runtime package', async () => {
    const outside = await outsidePackage('data')
    const dir = await writePlugin('inside-runtime', {
      'package.json': JSON.stringify({ name: 'inside-runtime', optionalDependencies: { dep: '1.0.0' } }),
      'node_modules/dep/package.json': JSON.stringify({ name: 'dep' }),
      'index.cjs': 'module.exports = { activate: () => "i" }\n',
    })
    await link(outside, path.join(dir, 'node_modules/dep/data'))

    const module = await prepare(dir, { id: 'inside-runtime', apiVersion: 1, server: 'index.cjs' })
    expect(module.reloadUnsafeReason).toMatch(/node_modules\/dep\/data leaves the plugin directory/)
  })

  it('counts every outbound link when the plugin has no readable manifest', async () => {
    const outside = await outsidePackage('anything')
    const dir = await writePlugin('no-manifest', {
      'index.cjs': 'module.exports = { activate: () => "n" }\n',
    })
    await link(outside, path.join(dir, 'node_modules/anything'))

    const module = await prepare(dir, { id: 'no-manifest', apiVersion: 1, server: 'index.cjs' })
    expect(module.reloadUnsafeReason).toMatch(/node_modules\/anything leaves the plugin directory/)
  })

  it('a .bin shim does not hide the runtime package it points through', async () => {
    const outside = await outsidePackage('tool', { 'bin.js': '' })
    const dir = await writePlugin('bin-runtime', {
      'package.json': JSON.stringify({ name: 'bin-runtime', peerDependencies: { tool: '*' } }),
      'index.cjs': 'module.exports = { activate: () => "b" }\n',
    })
    await link(outside, path.join(dir, 'node_modules/tool'))
    await link('../tool/bin.js', path.join(dir, 'node_modules/.bin/tool'))

    const module = await prepare(dir, { id: 'bin-runtime', apiVersion: 1, server: 'index.cjs' })
    expect(module.reloadUnsafeReason).toMatch(/node_modules\/tool leaves the plugin directory/)
  })

  it('loads in place when runtime code imports a devDependency that links out', async () => {
    // A package used at runtime but listed under devDependencies: the copy cannot resolve it.
    const dir = await fallbackScaffold(
      'misdeclared',
      'import { createRequire } from "node:module"\nconst api = createRequire(import.meta.url)("@open-walnut/plugin-api")\nexport function activate() { return api.from }\n',
    )
    const manifest = { id: 'misdeclared', apiVersion: 1 as const, server: 'dist/server.mjs' }

    const module = await prepare(dir, manifest)
    expect(await module.activate!({})).toBe('outside')
    expect(module.reloadUnsafeReason).toMatch(/runtime code imports @open-walnut\/plugin-api, a devDependency that links out/)
    expect(await generations('misdeclared')).toEqual([])
    await expect(prepare(dir, manifest, true)).rejects.toThrow(/requires a process restart: runtime code imports @open-walnut\/plugin-api/)
    expect(await generations('misdeclared')).toEqual([])
  })

  it('the plugin\'s own missing file stays its own error, never a restart request', async () => {
    const dir = await fallbackScaffold('missing-chunk', 'import "./chunk.mjs"\nexport function activate() {}\n')
    const manifest = { id: 'missing-chunk', apiVersion: 1 as const, server: 'dist/server.mjs' }
    await expect(prepare(dir, manifest)).rejects.toThrow(/chunk\.mjs/)
    await expect(prepare(dir, manifest, true)).rejects.not.toThrow(/requires a process restart/)
    // An undeclared package that is not one of the skipped links is not ours to explain either.
    await fsp.writeFile(path.join(dir, 'dist/server.mjs'), 'import "left-pad"\nexport function activate() {}\n')
    await expect(prepare(dir, manifest, true)).rejects.toThrow(/left-pad/)
    await expect(prepare(dir, manifest, true)).rejects.not.toThrow(/requires a process restart/)
    expect(await generations('missing-chunk')).toEqual([])
  })

  it('counts an undeclared package linked out inside a runtime package\'s node_modules', async () => {
    const outside = await outsidePackage('phantom')
    const dir = await writePlugin('phantom-dep', {
      'package.json': JSON.stringify({ name: 'phantom-dep', dependencies: { host: '1.0.0' } }),
      'node_modules/host/package.json': JSON.stringify({ name: 'host' }),
      'index.cjs': 'module.exports = { activate: () => "p" }\n',
    })
    await link(outside, path.join(dir, 'node_modules/host/node_modules/phantom'))

    const module = await prepare(dir, { id: 'phantom-dep', apiVersion: 1, server: 'index.cjs' })
    expect(module.reloadUnsafeReason).toMatch(/node_modules\/host\/node_modules\/phantom leaves the plugin directory/)
  })

  it('a runtime error in the copy is still an error, not a fall back to in-place', async () => {
    const dir = await fallbackScaffold('broken', 'throw new Error("boom")\n')
    await expect(prepare(dir, { id: 'broken', apiVersion: 1, server: 'dist/server.mjs' })).rejects.toThrow(/boom/)
    expect(await generations('broken')).toEqual([])
  })
})
