/**
 * A browser spec that bundles a piece of web/src into a fixture page resolves it the way the
 * app's Vite build does (tests/e2e/browser/web-fixture-bundle.ts).
 *
 * 2026-11-16: composer-input-state.spec.ts bundled ChatInput with esbuild's defaults; through the
 * composer's Draw it reached the drawing editor's `@excalidraw/excalidraw/index.css`, a package
 * export with only `development` and `production` conditions, and its 4 tests failed to build.
 * The class: any spec that calls esbuild itself. A new one fails here until it builds through the
 * shared options.
 */
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { VITE_IMPORT_SUFFIXES, webFixtureBuildOptions } from '../e2e/browser/web-fixture-bundle'

const ROOT = path.resolve(__dirname, '../..')
const BROWSER = path.join(ROOT, 'tests/e2e/browser')

describe('specs that bundle web/src into a fixture page', () => {
  it('build through web-fixture-bundle.ts, never with esbuild directly', () => {
    const direct = fs.readdirSync(BROWSER)
      .filter((f) => /\.tsx?$/.test(f) && f !== 'web-fixture-bundle.ts')
      .filter((f) => /from ['"]esbuild['"]|require\(['"]esbuild['"]\)/.test(fs.readFileSync(path.join(BROWSER, f), 'utf8')))
    expect(direct, 'bundle a fixture page with bundleWebFixture (tests/e2e/browser/web-fixture-bundle.ts)').toEqual([])
  })

  it("resolve a package's build-condition exports, as the app's build does", async () => {
    const options = webFixtureBuildOptions({ contents: "import '@excalidraw/excalidraw/index.css';", sourcefile: 'condition-probe.tsx' })
    expect(options.conditions).toEqual(['production'])
    const result = await build({ ...options, metafile: true })
    expect(Object.keys(result.metafile!.inputs).some((f) => f.includes('excalidraw/dist/prod/index.css'))).toBe(true)
  }, 30_000)

  it("load a Vite `?raw` import as the file's text, as the app's build does", async () => {
    const options = webFixtureBuildOptions({
      contents: "import text from './src/components/board/board-items.frame.js?raw'; import viaAlias from '@/components/board/board-items.frame.js?raw'; (globalThis as any).out = [text, viaAlias];",
      sourcefile: 'raw-probe.tsx',
    })
    const result = await build(options)
    const frame = fs.readFileSync(path.join(ROOT, 'web/src/components/board/board-items.frame.js'), 'utf8')
    // A long name from the frame script: it is in the bundle only as the text the import gave.
    const marker = frame.match(/[A-Za-z_]{14,}/)![0]
    expect(result.outputFiles[0]!.text).toContain(marker)
    expect(result.outputFiles[0]!.text).not.toMatch(/No matching export/)
  }, 30_000)

  it('handle every Vite import suffix web/src uses', () => {
    const used = execFileSync('git', ['grep', '-hoE', "from ['\"][^'\"]*\\?[a-z]+['\"]", '--', 'web/src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean).map((l) => l.replace(/^.*\?([a-z]+)['"]$/, '$1'))
    expect(used.length).toBeGreaterThan(0)
    expect([...new Set(used)].filter((s) => !(VITE_IMPORT_SUFFIXES as readonly string[]).includes(s)), 'teach tests/e2e/browser/web-fixture-bundle.ts this suffix').toEqual([])
  })
})
