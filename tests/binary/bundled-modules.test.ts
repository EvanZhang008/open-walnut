/**
 * The compiled file's table of dist files it carries as bundled modules
 * (src/binary/bundled-modules.ts), its lookup (src/lib/single-file.ts), and the
 * compiled entry's command routing (src/binary/main.ts), pinned against the
 * code they mirror so they cannot drift.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUNDLED_MODULES } from '../../src/binary/bundled-modules.js'
import { bundledModule, setSingleFile, singleFile } from '../../src/lib/single-file.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__WALNUT_SINGLE_FILE__
})

describe('bundled module table', () => {
  it('points every row at a module that exists in src', () => {
    const table = read('src/binary/bundled-modules.ts')
    for (const key of Object.keys(BUNDLED_MODULES)) {
      const row = table.split('\n').find((l) => l.includes(`'${key}'`))
      const spec = row?.match(/import\('(\.\.\/[^']+)'\)/)?.[1]
      expect(spec, `row ${key} has a literal import`).toBeTruthy()
      const ts = path.join(ROOT, 'src/binary', spec!).replace(/\.js$/, '.ts')
      expect(fs.existsSync(ts), `${key} -> ${ts}`).toBe(true)
    }
  })

  it('has a row for every built-in action the registry scans', () => {
    const actions = fs.readdirSync(path.join(ROOT, 'src/actions'))
      .filter((f) => f.endsWith('.ts') && !['types.ts', 'registry.ts', 'index.ts'].includes(f))
    expect(actions.length).toBeGreaterThan(0)
    for (const f of actions) expect(BUNDLED_MODULES[`dist/actions/${f.replace(/\.ts$/, '.js')}`], f).toBeTypeOf('function')
  })

  it('has a row for every tsup entry that is a separate program', () => {
    const tsup = read('tsup.config.ts')
    for (const entry of ['src/hooks/on-stop.ts', 'src/hooks/on-compact.ts', 'src/workers/git-compaction-worker.ts', 'src/lib/hybrid-search/embed-worker.ts']) {
      expect(tsup).toContain(`'${entry}'`)
      const key = entry.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')
      expect(BUNDLED_MODULES[key], key).toBeTypeOf('function')
    }
  })
})

describe('bundledModule()', () => {
  it('is null outside the compiled file', () => {
    expect(singleFile()).toBeNull()
    expect(bundledModule('/any/dist/actions/screenshot-track.js')).toBeNull()
  })

  it('maps an absolute path inside the runtime root to its loader, and nothing else', () => {
    const loader = async () => ({ ok: true })
    setSingleFile({ root: '/rt/0.1.0-abc', daemonVersion: 'walnut-daemon-x', modules: { 'dist/actions/a.js': loader } })
    expect(bundledModule('/rt/0.1.0-abc/dist/actions/a.js')).toBe(loader)
    expect(bundledModule('/rt/0.1.0-abc/dist/actions/b.js')).toBeNull()
    expect(bundledModule('/elsewhere/dist/actions/a.js')).toBeNull()
  })
})

describe('compiled entry routing', () => {
  const setOf = (src: string, marker: RegExp): string[] => {
    const m = src.match(marker)
    expect(m, String(marker)).toBeTruthy()
    return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
  }

  it('routes the same data commands to cli-fast as the npm launcher', () => {
    const main = setOf(read('src/binary/main.ts'), /const LITE = new Set\(\[([^\]]+)\]\)/)
    const cliFast = setOf(read('src/cli-fast.ts'), /export const LITE_COMMANDS = new Set\(\[([^\]]+)\]\)/)
    const bin = setOf(read('bin/open-walnut.js'), /const LITE = new Set\(\[([^\]]+)\]\)/)
    expect(main).toEqual(cliFast)
    expect(main).toEqual(bin)
  })

  it('imports the runtime root before anything else', () => {
    const firstImport = read('src/binary/main.ts').split('\n').find((l) => l.startsWith('import '))
    expect(firstImport).toBe("import { runtimeRoot } from './runtime-root.js'")
  })
})
