/**
 * Bundling plugin TypeScript at runtime (src/core/integration-loader.ts): the one
 * place that compiles code while Walnut runs (docs/plan/walnut-single-binary.md).
 *
 * Walnut runs only on bun, whose bundler is built in (`Bun.build`): no esbuild,
 * which the compiled file does not carry. It bundles the plugin into one ES
 * module, keeps every npm package an import resolved at runtime, and lets the
 * caller place the plugin's parent-relative imports (`../../core/x.js`).
 * A failure throws an Error whose lines read
 * `<file>:<line>:<column>: ERROR: <text>` (the shape esbuild printed, which
 * callers and plugin authors read).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { ON_BUN, bunGlobal } from './runtime.js'

export interface BundleRequest {
  entry: string
  outfile: string
  /** Prepended to the output. */
  banner: string
  /** A file for a parent-relative import (`../`), or undefined to resolve it the usual way. */
  resolveParent(specifier: string, importer: string): string | undefined
}


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

/** Bundle `entry` into the ES module `outfile`. Throws on a runtime without Bun.build (Node). */
export async function bundleEsm(req: BundleRequest): Promise<void> {
  if (!ON_BUN) throw new Error(`bundling a plugin needs bun's bundler, and this process runs on Node ${process.version}`)
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
