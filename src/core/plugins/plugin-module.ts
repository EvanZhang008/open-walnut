import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { PluginManifest } from '../integration-types.js'
import {
  createPluginGeneration,
  disposePluginGeneration,
  probePluginTree,
  pruneOrphanGenerations,
} from './plugin-module-snapshot.js'

export interface PluginModuleFunctions {
  activate: ((api: any) => unknown | Promise<unknown>) | null
  deactivate: (() => void | Promise<void>) | null
  /** Present for generation-backed loads: removes THIS generation's copy, nothing else. */
  dispose?: () => Promise<void>
  /** Set when a hot swap cannot fully replace the old code. The load itself is fine; a REPLACEMENT is not. */
  reloadUnsafeReason?: string
  /** The copy this module was imported from, so sibling files (web entry, manifest) can be read from the same tree. */
  sourceRoot?: string
}

function functionsFrom(mod: Record<string, any>, unified: boolean): PluginModuleFunctions {
  if (!unified) return { activate: typeof mod.default === 'function' ? mod.default : null, deactivate: null }
  return {
    activate: typeof mod.activate === 'function'
      ? mod.activate
      : typeof mod.default?.activate === 'function' ? mod.default.activate.bind(mod.default) : null,
    deactivate: typeof mod.deactivate === 'function'
      ? mod.deactivate
      : typeof mod.default?.deactivate === 'function' ? mod.default.deactivate.bind(mod.default) : null,
  }
}

interface LoadOptions {
  dir: string
  builtin: boolean
  manifest: PluginManifest
  bundle(dir: string, entry: string): Promise<{ outfile?: string; error?: string }>
  deadline<T>(pending: Promise<T>, id: string, phase: string): Promise<T>
  cacheRoot?: string
  replacement?: boolean
}

type Loaded = {
  mod: Record<string, any>
  dispose?: () => Promise<void>
  reloadUnsafeReason?: string
  sourceRoot?: string
}

const pendingEvaluations = new Set<string>()

async function evaluate(options: LoadOptions, file: string, cacheBust: boolean): Promise<Record<string, any>> {
  const url = pathToFileURL(file).href + (cacheBust ? `?v=${randomUUID()}` : '')
  const key = path.resolve(options.dir)
  pendingEvaluations.add(key)
  const work = import(url)
  void work.then(() => pendingEvaluations.delete(key), () => pendingEvaluations.delete(key))
  return options.deadline(work, options.manifest.id, 'module evaluation')
}

/** A .ts plugin is bundled onto Walnut's source tree; the bundle is one throwaway file. */
async function loadBundled(options: LoadOptions, entry: string): Promise<Loaded> {
  const result = await options.bundle(options.dir, entry)
  if (!result.outfile) throw new Error(`could not be bundled: ${result.error}`)
  try {
    return { mod: await evaluate(options, result.outfile, true) }
  } finally {
    await fs.unlink(result.outfile).catch(() => undefined)
  }
}

async function loadPrecompiled(options: LoadOptions, entry: string): Promise<Loaded> {
  const { dir, manifest, cacheRoot } = options
  const relative = path.relative(dir, entry)
  if (!relative || relative.startsWith('..')) throw new Error('entry point is outside the plugin directory')
  const probe = await probePluginTree(dir)
  if (probe.native.length || probe.external.length) {
    const reason = probe.native.length
      ? `native addon ${path.basename(probe.native[0])} is loaded in place and cannot be replaced in a running process`
      : `link ${probe.external[0]} leaves the plugin directory, so this load cannot be copied into a replaceable generation`
    if (options.replacement) throw new Error(`Plugin "${manifest.id}" requires a process restart: ${reason}`)
    return { mod: await evaluate(options, entry, false), reloadUnsafeReason: reason }
  }
  await pruneOrphanGenerations(manifest.id, cacheRoot)
  const generation = await createPluginGeneration({ id: manifest.id, dir, entryRelative: relative, cacheRoot })
  try {
    if (generation.unsafeReason) {
      await disposePluginGeneration(generation)
      if (options.replacement) throw new Error(`Plugin "${manifest.id}" requires a process restart: ${generation.unsafeReason}`)
      return { mod: await evaluate(options, entry, false), reloadUnsafeReason: generation.unsafeReason }
    }
    return {
      mod: await evaluate(options, generation.entry, false),
      dispose: () => disposePluginGeneration(generation),
      reloadUnsafeReason: generation.unsafeReason,
      sourceRoot: generation.root,
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'PluginCodeTimeoutError')) await disposePluginGeneration(generation)
    throw error
  }
}

export async function preparePluginModule(options: LoadOptions): Promise<PluginModuleFunctions> {
  const { dir, builtin, manifest } = options
  if (pendingEvaluations.has(path.resolve(dir))) throw new Error(`Plugin "${manifest.id}" module evaluation is still running`)
  const unified = manifest.apiVersion === 1
  const candidates = unified
    ? manifest.server
      ? [manifest.server, ...(builtin && manifest.server.endsWith('.js') ? [manifest.server.replace(/\.js$/, '.ts')] : [])]
      : []
    : ['index.ts', 'plugin.ts', 'index.js', 'plugin.js', 'index.mjs']
  if (candidates.length === 0) return { activate: null, deactivate: null }
  const errors: string[] = []
  for (const filename of candidates) {
    const entry = path.join(dir, filename)
    if (!await fs.stat(entry).then(stat => stat.isFile()).catch(() => false)) continue
    let loaded: Loaded | undefined
    try {
      // A builtin is Walnut's own code: host updates arrive with a restart, not a reload.
      loaded = builtin
        ? { mod: await evaluate(options, entry, false) }
        : entry.endsWith('.ts')
          ? await loadBundled(options, entry)
          : await loadPrecompiled(options, entry)
      const functions = functionsFrom(loaded.mod, unified)
      if (!functions.activate) throw new Error('module has no activation export')
      return {
        ...functions,
        dispose: loaded.dispose,
        reloadUnsafeReason: loaded.reloadUnsafeReason,
        sourceRoot: loaded.sourceRoot,
      }
    } catch (error) {
      await loaded?.dispose?.()
      if (error instanceof Error && error.name === 'PluginCodeTimeoutError') throw error
      errors.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Plugin "${manifest.id}" has no valid entry point${errors.length ? `: ${errors.join('; ')}` : ''}`)
}
