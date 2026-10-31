/**
 * Every route that writes one of the user's preferences keeps a test run's write in the run's
 * own copy (src/core/test-run-prefs.ts). 2026-10-31: the user's synced ui-prefs said the task
 * panel was hidden, so every fresh browser opened on an empty Home; a browser under automation
 * on the user's Walnut sends `x-walnut-test-run`, and these routes wrote for real.
 *
 * The routes are read from the source: every express `<router>.put/post/patch/delete` and every
 * plugin `walnut.http.route(...)`, with the path its router is mounted at in server.ts (a router
 * by name, imported or made by a factory). A write whose full path names a preference (pref,
 * favorite, ordering, layout, separator) must be in GATED below, and its handler must call the
 * named gate, which must reach testRunPrefsWrite. Not preferences, so not here: Settings
 * (`PUT /api/config` and the other settings saves are the user's configuration, and a whole
 * config round trip carries the favorites and order as they are stored), and a favorite that
 * follows a note or project the request really moved or deleted (notes-v2 pruneFavoriteNotes,
 * task-manager's rename): the vault and the project changed for real, so their favorites do.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'src')
const PREF_PATH = /pref|favorit|ordering|layout|separator/i

/** "METHOD /full/path" -> the call in its handler that keeps a test run's write apart. */
const GATED: Record<string, { file: string; gate: string }> = {
  'PUT /api/ui-prefs/': { file: 'src/web/routes/ui-prefs.ts', gate: 'testRunPrefsWrite' },
  'POST /api/favorites/projects/:name': { file: 'src/web/routes/favorites.ts', gate: 'editFavorites' },
  'DELETE /api/favorites/projects/:name': { file: 'src/web/routes/favorites.ts', gate: 'editFavorites' },
  'POST /api/favorites/notes': { file: 'src/web/routes/favorites.ts', gate: 'editFavorites' },
  'DELETE /api/favorites/notes': { file: 'src/web/routes/favorites.ts', gate: 'editFavorites' },
  'POST /api/v1/favorites/projects/:name': { file: 'src/web/routes/projects-v1.ts', gate: 'editFavorites' },
  'DELETE /api/v1/favorites/projects/:name': { file: 'src/web/routes/projects-v1.ts', gate: 'editFavorites' },
  'POST /api/v1/favorites/notes': { file: 'src/web/routes/search-memory-v1.ts', gate: 'editFavorites' },
  'DELETE /api/v1/favorites/notes': { file: 'src/web/routes/search-memory-v1.ts', gate: 'editFavorites' },
  'PUT /api/ordering/separators': { file: 'src/web/routes/ordering.ts', gate: 'writeOrdering' },
  'PUT /api/ordering/projects': { file: 'src/web/routes/ordering.ts', gate: 'writeOrdering' },
  'PUT /api/v1/ordering/projects': { file: 'src/web/routes/projects-v1.ts', gate: 'writeOrdering' },
  'PUT /api/plugins/mail/groups/pref': { file: 'src/integrations/mail/routes-sort-rules.ts', gate: 'testRunPrefsWrite' },
  'POST /api/push/preferences': { file: 'src/web/routes/push.ts', gate: 'setDevicePushPreferences' },
}

/** Each gate, where it is defined: its body must call testRunPrefsWrite. */
const GATE_HOMES: Record<string, string> = {
  editFavorites: 'src/web/routes/favorites.ts',
  writeOrdering: 'src/web/routes/ordering.ts',
  setDevicePushPreferences: 'src/core/push/registry.ts',
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * Router name -> the paths server.ts mounts it at: `app.use('/api/x', xRouter)`,
 * `(await import('./routes/x.js')).xRouter` and `createXRouter(...)` alike.
 */
function mounts(): Map<string, string[]> {
  const server = fs.readFileSync(path.join(SRC, 'web/server.ts'), 'utf8')
  const m = new Map<string, string[]>()
  for (const [, at, expr] of server.matchAll(/app\.use\(\s*['"]([^'"]+)['"]\s*,\s*([^\n]+)/g)) {
    const name = /\b(\w+Router)\b(?!\s*\.)|\b(create\w+)\s*\(/.exec(expr)
    const id = name?.[1] ?? name?.[2]
    if (id) m.set(id, [...(m.get(id) ?? []), at])
  }
  return m
}

/** The plugin id of a bundled integration directory (routes mount at /api/plugins/<id>). */
function pluginId(file: string): string | null {
  const dir = /src\/integrations\/([^/]+)\//.exec(file)?.[1]
  if (!dir) return null
  const manifest = path.join(SRC, 'integrations', dir, 'manifest.json')
  if (fs.existsSync(manifest)) return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { id?: string }).id ?? dir
  return dir
}

interface Route { key: string; file: string; body: string }

function writeRoutes(): Route[] {
  const mounted = mounts()
  const routes: Route[] = []
  for (const abs of sourceFiles(SRC)) {
    const text = fs.readFileSync(abs, 'utf8')
    const file = path.relative(ROOT, abs)
    // A factory mounted in server.ts: every router it builds in this file takes its paths.
    const factoryAt = [...text.matchAll(/export (?:async )?function (create\w+)/g)].flatMap((m) => mounted.get(m[1]) ?? [])
    const found: Array<{ index: number; key: string }> = []
    for (const m of text.matchAll(/\b(\w+)\.(put|post|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)) {
      const at = mounted.get(m[1]) ?? (/^(router|r|\w+Router)$/.test(m[1]) ? factoryAt : [])
      const where = at.length ? at : PREF_PATH.test(m[3]) && /Router$|^router$/.test(m[1]) ? ['?'] : []
      for (const a of where) found.push({ index: m.index!, key: `${m[2].toUpperCase()} ${(a + m[3]).replace(/\/\/+/g, '/')}` })
    }
    for (const m of text.matchAll(/\.http\.route\(\s*['"](put|post|patch|delete)['"]\s*,\s*['"`]([^'"`]+)['"`]/g)) {
      found.push({ index: m.index!, key: `${m[1].toUpperCase()} /api/plugins/${pluginId(file) ?? '?'}${m[2]}` })
    }
    found.sort((a, b) => a.index - b.index)
    // A handler's body is the text up to the next route declaration of the file.
    const starts = [...text.matchAll(/\b\w+\.(get|put|post|patch|delete|use)\(\s*['"`]|\.http\.route\(/g)].map((m) => m.index!)
    for (const r of found) {
      const end = starts.find((s) => s > r.index) ?? text.length
      routes.push({ key: r.key, file, body: text.slice(r.index, end) })
    }
  }
  return routes
}

/** The text of function `name` in `file`, up to the next top-level declaration. */
function functionBody(file: string, name: string): string {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const at = text.search(new RegExp(`^(export )?(async )?function ${name}\\b`, 'm'))
  expect(at, `${name} is defined in ${file}`).toBeGreaterThanOrEqual(0)
  const next = text.slice(at + 1).search(/\n(export |async |function |const |\w+Router\.)/)
  return text.slice(at, next < 0 ? undefined : at + 1 + next)
}

describe('test-run prefs gate', () => {
  const routes = writeRoutes()
  const prefWrites = routes.filter((r) => PREF_PATH.test(r.key.split(' ')[1]))

  it('finds the routes it guards (the scan still reads the source)', () => {
    expect(routes.length).toBeGreaterThan(100)
    const keys = new Set(routes.map((r) => r.key))
    // A router by name, one mounted through an import, and one a factory builds.
    for (const k of ['PUT /api/ordering/projects', 'POST /api/keep-awake/poll', 'PUT /api/skills/:dirName']) expect(keys).toContain(k)
    expect(prefWrites.map((r) => r.key)).toEqual(expect.arrayContaining(Object.keys(GATED)))
  })

  it('every preference write route is listed, in the file it lives in', () => {
    const unlisted = prefWrites.filter((r) => GATED[r.key]?.file !== r.file).map((r) => `${r.key} (${r.file})`)
    expect(unlisted, 'a new preference write route: keep a test run\'s write in its copy (src/core/test-run-prefs.ts), then list it in GATED').toEqual([])
  })

  it('every listed handler goes through its gate', () => {
    const ungated = prefWrites.filter((r) => GATED[r.key] && !r.body.includes(GATED[r.key].gate)).map((r) => `${r.key} lacks ${GATED[r.key].gate}`)
    expect(ungated).toEqual([])
  })

  it('every gate keeps a test run\'s write in the run\'s copy', () => {
    for (const [gate, file] of Object.entries(GATE_HOMES)) {
      expect(functionBody(file, gate), `${gate} calls testRunPrefsWrite`).toContain('testRunPrefsWrite')
    }
  })
})
