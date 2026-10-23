/**
 * The compiled Walnut file (`bun build --compile`, scripts/build-binary.mjs).
 *
 * Its entry (src/binary/main.ts) unpacks the files Walnut reads from disk (the
 * web app, src/data, plugin manifests, daemon sidecars) into a runtime directory
 * laid out like an installed package (`<root>/package.json`, `<root>/dist/...`)
 * and records it here before any other module loads. The build also points
 * `import.meta.url` of every bundled module at `<root>/dist/cli.js`, so the
 * resolvers that walk up from the bundle find that tree unchanged.
 *
 * Every other build (tsup, running from source) leaves this unset.
 */
import path from 'node:path'

export type ModuleLoader = () => Promise<Record<string, unknown>>

export interface SingleFile {
  /** The unpacked package root: `<data home>/local/runtime/<version>-<hash>`. */
  root: string
  /** The session daemon version compiled into the file (`walnut __daemon`). */
  daemonVersion: string
  /** Dist files carried as bundled modules, by path relative to `root` (src/binary/bundled-modules.ts). */
  modules: Readonly<Record<string, ModuleLoader>>
}

const GLOBAL_KEY = '__WALNUT_SINGLE_FILE__'

/** The compiled file's runtime facts, or null when this process is not the compiled file. */
export function singleFile(): SingleFile | null {
  return ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as SingleFile | undefined) ?? null
}

/** Called once by the compiled entry, before any other module is evaluated. */
export function setSingleFile(info: SingleFile): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = info
}

/**
 * The bundled module standing for `file` (an absolute path into the runtime
 * tree), or null: always null outside the compiled file, so a caller writes
 * `await (bundledModule(file)?.() ?? import(file))`.
 */
export function bundledModule(file: string): ModuleLoader | null {
  const info = singleFile()
  if (!info) return null
  const rel = path.relative(info.root, file).split(path.sep).join('/')
  return info.modules[rel] ?? null
}
