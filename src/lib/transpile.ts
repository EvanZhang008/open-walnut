/**
 * Bundling plugin TypeScript at runtime (src/core/integration-loader.ts): the one
 * place that compiles code while Walnut runs (docs/plan/walnut-single-binary.md).
 *
 * On bun the bundler is built in (`Bun.build`). Until no Node build of Walnut is
 * left, a process running on Node uses esbuild. Both bundle the plugin into one
 * ES module, keep every npm package an import resolved at runtime, and let the
 * caller place the plugin's parent-relative imports (`../../core/x.js`).
 * A failure throws an Error whose lines read as esbuild's do
 * (`<file>:<line>:<column>: ERROR: <text>`), so callers read one shape.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { ON_BUN, bunGlobal } from './runtime.js'

export interface BundleRequest {
  entry: string
  outfile: string
  /** Prepended to the output. */
  banner: string
  /** Where bare package imports resolve (esbuild's nodePaths; bun resolves them at runtime). */
  nodePaths: string[]
  /** A file for a parent-relative import (`../`), or undefined to resolve it the usual way. */
  resolveParent(specifier: string, importer: string): string | undefined
}

/** Bundle `entry` into the ES module `outfile`. */
export async function bundleEsm(req: BundleRequest): Promise<void> {
  if (ON_BUN) return bundleWithBun(req)
  const { build } = await import('esbuild')
  await build({
    entryPoints: [req.entry],
    outfile: req.outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    nodePaths: req.nodePaths,
    banner: { js: req.banner },
    logLevel: 'warning',
    plugins: [{
      name: 'rebase-open-walnut-imports',
      setup(b) {
        b.onResolve({ filter: /^\.\.\// }, (args) => {
          const file = req.resolveParent(args.path, args.importer)
          return file ? { path: file } : undefined
        })
      },
    }],
  })
}

// ── bun ─────────────────────────────────────────────────────────────────────

interface BunBuildLog {
  message: string
  position?: { file: string; line: number; column: number } | null
}

interface BunBuildOutput {
  success: boolean
  logs: BunBuildLog[]
  outputs: Array<{ text(): Promise<string> }>
}

interface BunBuildPluginBuilder {
  onResolve(
    options: { filter: RegExp },
    callback: (args: { path: string; importer: string }) => { path: string } | undefined,
  ): void
}

interface BunBuildConfig {
  entrypoints: string[]
  target: 'bun'
  format: 'esm'
  packages: 'external'
  banner: string
  throw: false
  plugins: Array<{ name: string; setup(builder: BunBuildPluginBuilder): void }>
}

async function bundleWithBun(req: BundleRequest): Promise<void> {
  const result = await bunGlobal<{ build(config: BunBuildConfig): Promise<BunBuildOutput> }>().build({
    entrypoints: [req.entry],
    target: 'bun',
    format: 'esm',
    packages: 'external',
    banner: req.banner,
    throw: false,
    plugins: [{
      name: 'rebase-open-walnut-imports',
      setup(b) {
        b.onResolve({ filter: /^\.\.\// }, (args) => {
          const file = req.resolveParent(args.path, args.importer)
          return file ? { path: file } : undefined
        })
      },
    }],
  })
  if (!result.success || result.outputs.length !== 1) {
    const lines = result.logs.map((entry) => {
      const at = entry.position ? `${entry.position.file}:${entry.position.line}:${entry.position.column}: ` : ''
      return `${at}ERROR: ${entry.message}`
    })
    if (lines.length === 0) lines.push(`ERROR: the bundle has ${result.outputs.length} outputs, not 1`)
    throw new Error(`Build failed with ${lines.length} error${lines.length === 1 ? '' : 's'}:\n${lines.join('\n')}`)
  }
  await fs.mkdir(path.dirname(req.outfile), { recursive: true })
  await fs.writeFile(req.outfile, await result.outputs[0]!.text())
}
