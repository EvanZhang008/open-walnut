/**
 * The fixture's Vite serves the SPA in dev mode, so the first page load after a boot compiles
 * the module graph on demand: about 2,000 modules, 22 s and more on a Linux runner
 * (2026-11-08: tests/e2e/browser/session-header-title-row.spec.ts failed its first test in every
 * worker, the page still on the boot splash when its 20 s wait ran out, and passed on the retry
 * once the modules were compiled). Whichever spec ran first in a worker paid for the compile.
 *
 * So the fixture is ready only once the graph is compiled: until then every request answers 503,
 * which Playwright's webServer readiness probe reads as "not up yet" (it waits for a status under
 * 404), and the compile runs before any spec opens a page. The app's shell and its pages load
 * through dynamic import(), which Vite does not compile ahead on its own, so the walk follows
 * every import the graph records, dynamic ones included. A compile that does not settle within
 * WARM_CAP_MS opens the gate anyway and says so: a slow first page is better than no run.
 */
import type { Plugin, ViteDevServer } from 'vite'

/** The SPA's entry; everything it reaches, statically or through import(), is compiled. */
export const SPA_ENTRY = '/src/main.tsx'
export const WARM_CAP_MS = 45_000
/** A walk that keeps finding modules past this is not the SPA's graph any more. */
const MAX_MODULES = 8_000

export interface WarmGate {
  plugin: Plugin
  warm(server: ViteDevServer): Promise<void>
  isWarm(): boolean
}

/** Compile `entry` and every module it reaches. Returns how many modules were asked for. */
export async function compileGraph(server: ViteDevServer, entry: string, deadline: number): Promise<number> {
  const asked = new Set<string>()
  let frontier = [entry]
  while (frontier.length > 0 && Date.now() < deadline && asked.size < MAX_MODULES) {
    for (const url of frontier) asked.add(url)
    await Promise.all(frontier.map((url) => server.warmupRequest(url)))
    // The static imports of what was just compiled, which Vite compiles ahead by itself.
    await server.waitForRequestsIdle()
    const next = new Set<string>()
    for (const mod of server.environments.client.moduleGraph.urlToModuleMap.values()) {
      for (const dep of mod.importedModules) {
        if (!dep.transformResult && !asked.has(dep.url)) next.add(dep.url)
      }
    }
    frontier = [...next]
  }
  return asked.size
}

export function holdUntilWarm(): WarmGate {
  let warmed = false
  const plugin: Plugin = {
    name: 'walnut-fixture-warm-gate',
    // Runs before Vite's own middlewares (the /api proxy included).
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        if (warmed) { next(); return }
        res.statusCode = 503
        res.setHeader('retry-after', '1')
        res.end('fixture warming: compiling the SPA')
      })
    },
  }
  async function warm(server: ViteDevServer): Promise<void> {
    const started = Date.now()
    let capped = false
    const cap = new Promise<void>((resolve) => { setTimeout(() => { capped = true; resolve() }, WARM_CAP_MS).unref?.() })
    let walked = 0
    const compile = compileGraph(server, SPA_ENTRY, started + WARM_CAP_MS)
      .then((n) => { walked = n })
      .catch((error: unknown) => {
        console.warn(`[fixture-warm] compiling the SPA failed, opening anyway: ${String((error as Error)?.message ?? error)}`)
      })
    await Promise.race([compile, cap])
    warmed = true
    const ms = Date.now() - started
    console.log(capped
      ? `[fixture-warm] the SPA compile ran past ${WARM_CAP_MS} ms; opening the fixture with it still going`
      : `[fixture-warm] SPA compiled in ${ms} ms (${walked} modules asked for, ${server.environments.client.moduleGraph.urlToModuleMap.size} in the graph)`)
  }
  return { plugin, warm, isWarm: () => warmed }
}
