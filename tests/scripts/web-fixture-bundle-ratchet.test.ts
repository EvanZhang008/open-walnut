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
import { webFixtureBuildOptions } from '../e2e/browser/web-fixture-bundle'

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
})
