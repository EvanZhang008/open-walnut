/**
 * A plugin's job bundle inlines every package its server module imports
 * (bundlePluginForJobs, selfContained). A plugin installed outside any node_modules
 * tree imports packages Walnut carries (express) that its server load gets from
 * Walnut at run time; its job bundle must find them in that same tree, or the job
 * never runs (2026-11-08: an installed plugin's long-running job read "its newest
 * code could not be prepared: Could not resolve express").
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundlePluginForJobs } from '../../src/core/integration-loader.js'
import { bundleEsm } from '../../src/lib/transpile.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** A plugin dir under the OS temp dir: no node_modules anywhere above it. */
function pluginDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-bundle-pkg-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }
  return dir
}

const ENTRY = [
  "import { Router } from 'express'",
  "import { readFileSync } from 'node:fs'",
  "import os from 'os'",
  'export const jobs = { worker: async () => [typeof Router, typeof readFileSync, typeof os.tmpdir].join(",") }',
].join('\n')

describe('plugin job bundles find the packages Walnut carries', () => {
  it('inlines a package the plugin does not install, from Walnut\'s own tree, and the bundle runs', async () => {
    const dir = pluginDir({ 'index.ts': ENTRY })
    const out = path.join(dir, 'out', 'job.mjs')
    const result = await bundlePluginForJobs(dir, path.join(dir, 'index.ts'), out)
    expect(result.error).toBeUndefined()
    const text = fs.readFileSync(out, 'utf8')
    expect(text).not.toMatch(/from ["']express["']/)
    const mod = await import(out) as { jobs: { worker(): Promise<string> } }
    expect(await mod.jobs.worker()).toBe('function,function,function')
  })

  it('prefers the plugin\'s own copy of a package', async () => {
    const dir = pluginDir({
      'index.ts': "import { mark } from 'express'\nexport const jobs = { worker: async () => mark }",
      'node_modules/express/package.json': JSON.stringify({ name: 'express', version: '0.0.0-own', main: 'index.js' }),
      'node_modules/express/index.js': "exports.mark = 'own copy'",
    })
    const out = path.join(dir, 'out', 'job.mjs')
    expect((await bundlePluginForJobs(dir, path.join(dir, 'index.ts'), out)).error).toBeUndefined()
    const mod = await import(out) as { jobs: { worker(): Promise<string> } }
    expect(await mod.jobs.worker()).toBe('own copy')
  })

  it('still names a package found in neither place', async () => {
    const dir = pluginDir({ 'index.ts': "import x from 'no-such-package-walnut-test'\nexport const jobs = { worker: async () => x }" })
    const result = await bundlePluginForJobs(dir, path.join(dir, 'index.ts'), path.join(dir, 'out', 'job.mjs'))
    expect(result.error).toMatch(/no-such-package-walnut-test/)
  })
})

/** A stand-in for Walnut's own tree: packages only it carries, each a different shape. */
function walnutTree(): string {
  return pluginDir({
    'node_modules/@acme/scoped/package.json': JSON.stringify({ name: '@acme/scoped', main: 'main.js' }),
    'node_modules/@acme/scoped/main.js': "exports.v = 'scoped'",
    'node_modules/@acme/scoped/extra.js': "exports.v = 'scoped subpath'",
    'node_modules/cond/package.json': JSON.stringify({
      name: 'cond',
      exports: {
        '.': { bun: './bun.js', node: './node.js', default: './default.js' },
        './feature/*': { node: './features/*.js' },
        './hidden': null,
      },
    }),
    'node_modules/cond/bun.js': "export const v = 'bun entry'",
    'node_modules/cond/node.js': "export const v = 'node entry'",
    'node_modules/cond/default.js': "export const v = 'default entry'",
    'node_modules/cond/features/x.js': "export const v = 'feature x'",
  })
}

async function bundleWith(root: string, entry: string): Promise<{ out: string; error?: string }> {
  const dir = pluginDir({ 'index.ts': entry })
  const out = path.join(dir, 'out', 'job.mjs')
  try {
    await bundleEsm({ entry: path.join(dir, 'index.ts'), outfile: out, banner: '', resolveParent: () => undefined, selfContained: true, fallbackPackageRoot: root })
    return { out }
  } catch (err) { return { out, error: String(err) } }
}

describe('the fallback resolves a package the way the job bundle (node, import) would', () => {
  it('finds scoped packages, their subpaths, and the node entry of a conditional export', async () => {
    const root = walnutTree()
    const { out, error } = await bundleWith(root, [
      "import { v as a } from '@acme/scoped'",
      "import { v as b } from '@acme/scoped/extra.js'",
      "import { v as c } from 'cond'",
      "import { v as d } from 'cond/feature/x'",
      'export const values = [a, b, c, d]',
    ].join('\n'))
    expect(error).toBeUndefined()
    const mod = await import(out) as { values: string[] }
    expect(mod.values).toEqual(['scoped', 'scoped subpath', 'node entry', 'feature x'])
  })

  it('refuses a subpath the package does not export', async () => {
    const { error } = await bundleWith(walnutTree(), "import { v } from 'cond/hidden'\nexport const x = v")
    expect(error).toMatch(/cond\/hidden/)
  })

  it('leaves a selfContained bundle with no fallback root as it was', async () => {
    const { error } = await bundleWith('', "import { v } from 'cond'\nexport const x = v")
    expect(error).toMatch(/Could not resolve: "cond"/)
  })
})
