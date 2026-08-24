import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { build, context, type BuildOptions, type BuildResult, type Metafile } from 'esbuild'
import { assertValid, validatePlugin, type PluginManifest } from './manifest.js'

export interface BuildPluginOptions {
  root?: string
  watch?: boolean
  minify?: boolean
  /** Fires only for a rebuild AFTER the initial build, which the returned result reports instead. */
  onRebuild?: () => void | Promise<void>
}

export interface PluginBuildResult {
  outputs: Array<{ path: string; bytes: number }>
  stop?: () => Promise<void>
}

function outputStats(root: string, metafiles: Metafile[]): Array<{ path: string; bytes: number }> {
  return metafiles.flatMap((metafile) => Object.entries(metafile.outputs).map(([file, output]) => ({
    path: path.relative(root, path.resolve(file)),
    bytes: output.bytes,
  })))
}

function nodeExternals(manifest: PluginManifest): string[] {
  return [
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
    ...(manifest.build?.external ?? []),
  ]
}

function resolveHostShim(specifier: string): string {
  const require = createRequire(import.meta.url)
  return require.resolve(`@open-walnut/plugin-api/${specifier}`)
}

function webAliases(): Record<string, string> {
  return {
    react: resolveHostShim('react'),
    'react-dom': resolveHostShim('react-dom'),
    'react-dom/client': resolveHostShim('react-dom'),
    'react/jsx-runtime': resolveHostShim('jsx-runtime'),
    'react/jsx-dev-runtime': resolveHostShim('jsx-dev-runtime'),
  }
}

interface WatchEvents {
  onStart(): void
  onEnd(success: boolean): void
}

async function runBuild(options: BuildOptions, watch: boolean, events?: WatchEvents) {
  if (!watch) return { result: await build(options) }
  let settleInitial: ((result: BuildResult) => void) | undefined
  let failInitial: ((error: unknown) => void) | undefined
  const initial = new Promise<BuildResult>((resolve, reject) => {
    settleInitial = resolve
    failInitial = reject
  })
  let sawInitial = false
  const ctx = await context({
    ...options,
    plugins: [
      ...(options.plugins ?? []),
      {
        name: 'walnut-plugin-rebuild',
        setup(pluginBuild) {
          pluginBuild.onStart(() => { events?.onStart() })
          pluginBuild.onEnd((result) => {
            const success = result.errors.length === 0
            if (!sawInitial) {
              sawInitial = true
              if (success) settleInitial?.(result)
              else failInitial?.(new Error(result.errors.map((error) => error.text).join('\n') || 'build failed'))
            }
            events?.onEnd(success)
          })
        },
      },
    ],
  })
  // No `ctx.rebuild()` here: `watch()` runs the first build itself, and doing both built twice, the second looking exactly like a save.
  try {
    await ctx.watch()
    const result = await initial
    return { result, stop: () => ctx.dispose() }
  } catch (error) {
    // A broken first build must not leave a watcher holding the event loop open.
    await ctx.dispose()
    throw error
  }
}

export async function buildPlugin(options: BuildPluginOptions = {}): Promise<PluginBuildResult> {
  const root = path.resolve(options.root ?? process.cwd())
  const manifest = assertValid(await validatePlugin(root))
  const builds: Array<Promise<{ result: BuildResult; stop?: () => Promise<void> }>> = []
  const buildKeys = [manifest.server ? 'server' : null, manifest.web ? 'web' : null]
    .filter((key): key is 'server' | 'web' => key !== null)
  const buildHealth = new Map(buildKeys.map((key) => [key, false]))
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  // The initial onEnd is what resolves each `runBuild`, so this is still false there and true for every later build.
  let initialBuildSettled = false
  const watchEvents = (key: 'server' | 'web'): WatchEvents => ({
    onStart() {
      buildHealth.set(key, false)
      if (reloadTimer) clearTimeout(reloadTimer)
    },
    onEnd(success) {
      buildHealth.set(key, success)
      if (!initialBuildSettled) return
      if (!success || !options.onRebuild || [...buildHealth.values()].some((ready) => !ready)) return
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined
        void Promise.resolve(options.onRebuild?.()).catch(() => undefined)
      }, 75)
    },
  })

  if (manifest.server) {
    const entry = path.resolve(root, manifest.build?.server ?? 'src/server.ts')
    builds.push(runBuild({
      entryPoints: [entry],
      outfile: path.resolve(root, manifest.server),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      external: nodeExternals(manifest),
      banner: { js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);' },
      metafile: true,
      minify: options.minify ?? false,
      sourcemap: options.watch ? 'inline' : false,
      logLevel: 'info',
    }, !!options.watch, watchEvents('server')))
  }

  if (manifest.web) {
    const entry = path.resolve(root, manifest.build?.web ?? 'src/web.tsx')
    builds.push(runBuild({
      entryPoints: [entry],
      outfile: path.resolve(root, manifest.web),
      bundle: true,
      splitting: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      alias: webAliases(),
      define: { 'process.env.NODE_ENV': '"production"' },
      metafile: true,
      minify: options.minify ?? !options.watch,
      sourcemap: options.watch ? 'inline' : false,
      logLevel: 'info',
    }, !!options.watch, watchEvents('web')))
  }

  // One entry failing must take the other's watcher down, or a failed `dev` hangs on a live esbuild context.
  const settled = await Promise.allSettled(builds)
  const started = settled.flatMap((entry) => (entry.status === 'fulfilled' ? [entry.value] : []))
  const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
  if (failed) {
    await Promise.all(started.map((item) => item.stop?.()))
    throw failed.reason
  }
  const results = started
  initialBuildSettled = true
  const metafiles = results.map(({ result }) => result.metafile).filter((value): value is Metafile => !!value)
  return {
    outputs: outputStats(root, metafiles),
    ...(options.watch ? { stop: async () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      await Promise.all(results.map((item) => item.stop?.()))
    } } : {}),
  }
}
