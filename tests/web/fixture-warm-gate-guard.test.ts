/**
 * A browser fixture is ready only once its SPA is compiled (tests/e2e/browser/fixture-warm.ts).
 *
 * The fixture's Vite compiles the SPA's ~2,000 modules on the first page load after a boot, so
 * the first spec in each worker waited 20 s and more on the boot splash (2026-11-08:
 * tests/e2e/browser/session-header-title-row.spec.ts failed its first test in every worker and
 * passed on the retry). The guard fails on a browser fixture server that starts a Vite without
 * the warm gate, unless it is listed in NOT_GATED with its reason. That list only shrinks.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { compileGraph } from '../e2e/browser/fixture-warm'

const REPO = path.resolve(import.meta.dirname, '../..')
const BROWSER_DIR = path.join(REPO, 'tests/e2e/browser')

/** Side fixtures a single spec starts with its own boot budget; gate each when it is next touched. */
const NOT_GATED: Record<string, string> = {
  'cloud-host-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'link-capture-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'mail-app-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'plugin-connection-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'plugin-mic-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'plugin-restart-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'plugin-secret-form-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'plugin-store-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'replica-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'session-commit-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'status-items-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
  'time-app-server.ts': 'a side fixture its own spec starts, with its own boot budget; its first load not measured yet',
}

const STARTS_VITE = /createViteServer\s*\(/
const GATED = (text: string) => /holdUntilWarm\s*\(/.test(text) && /\.warm\s*\(\s*viteServer\s*\)/.test(text)

describe('a browser fixture is ready only once its SPA is compiled', () => {
  it('every fixture server that starts a Vite holds requests until the SPA is compiled', () => {
    const missing: string[] = []
    const stale: string[] = []
    for (const name of fs.readdirSync(BROWSER_DIR).filter((f) => f.endsWith('.ts')).sort()) {
      const text = fs.readFileSync(path.join(BROWSER_DIR, name), 'utf8')
      if (!STARTS_VITE.test(text)) continue
      if (GATED(text)) { if (NOT_GATED[name]) stale.push(name); continue }
      if (!NOT_GATED[name]) missing.push(name)
    }
    for (const name of Object.keys(NOT_GATED)) {
      if (!fs.existsSync(path.join(BROWSER_DIR, name))) stale.push(name)
    }
    expect(missing, 'start the Vite with holdUntilWarm() from fixture-warm.ts and await warm(viteServer) before the ready line').toEqual([])
    expect(stale, 'these NOT_GATED entries are gated or gone now: remove them').toEqual([])
  })

  it('the shared fixture is gated', () => {
    expect(GATED(fs.readFileSync(path.join(BROWSER_DIR, 'test-server.ts'), 'utf8'))).toBe(true)
  })

  it('the compile walk follows dynamic imports, which Vite does not compile ahead', async () => {
    // main imports shell only through import(); shell imports page statically.
    type Mod = { url: string; transformResult: object | null; importedModules: Set<Mod> }
    const mods = new Map<string, Mod>()
    const mod = (url: string): Mod => {
      let m = mods.get(url)
      if (!m) { m = { url, transformResult: null, importedModules: new Set() }; mods.set(url, m) }
      return m
    }
    const graph: Record<string, { imports: string[]; staticOnes: string[] }> = {
      '/src/main.tsx': { imports: ['/src/shell.tsx'], staticOnes: [] },
      '/src/shell.tsx': { imports: ['/src/page.tsx'], staticOnes: ['/src/page.tsx'] },
      '/src/page.tsx': { imports: [], staticOnes: [] },
    }
    const asked: string[] = []
    const transform = (url: string) => {
      const m = mod(url)
      if (m.transformResult) return
      m.transformResult = {}
      for (const dep of graph[url].imports) m.importedModules.add(mod(dep))
      for (const dep of graph[url].staticOnes) transform(dep)
    }
    const server = {
      warmupRequest: async (url: string) => { asked.push(url); transform(url) },
      waitForRequestsIdle: async () => {},
      environments: { client: { moduleGraph: { urlToModuleMap: mods } } },
    }
    const n = await compileGraph(server as never, '/src/main.tsx', Date.now() + 5_000)
    expect(asked).toEqual(['/src/main.tsx', '/src/shell.tsx'])
    expect(n).toBe(2)
    expect([...mods.values()].every((m) => m.transformResult)).toBe(true)
  })
})
