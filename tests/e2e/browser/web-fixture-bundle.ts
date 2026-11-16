/**
 * How a spec bundles a piece of the web app into a page of its own with esbuild (a component on
 * a bare fixture page): resolved the way the app's own Vite build resolves it, so a module the app
 * reaches resolves here too.
 *
 * `conditions: ['production']`: a package may export a file under build conditions only (the
 * drawing editor's `@excalidraw/excalidraw/index.css` has just `development` and `production`).
 * Vite always sets one of them; esbuild sets neither unless asked, and every spec whose component
 * reached the editor (ChatInput, through the composer's Draw) failed to build (2026-11-16).
 *
 * Guard: tests/scripts/web-fixture-bundle-ratchet.test.ts (every spec that bundles web/src with
 * esbuild builds through this).
 */
import path from 'node:path'
import { build, type BuildOptions, type BuildResult } from 'esbuild'

export interface WebFixtureBundle {
  /** The fixture page's script: what it imports from web/src (`./src/...`, `@/...`) is bundled. */
  contents: string
  sourcefile: string
  /** More aliases, for a module a component imports from outside web/ (`@open-walnut/core`). */
  alias?: Record<string, string>
  define?: Record<string, string>
}

export function webFixtureBuildOptions(fixture: WebFixtureBundle): BuildOptions & { write: false } {
  return {
    stdin: { contents: fixture.contents, resolveDir: path.resolve('web'), sourcefile: fixture.sourcefile, loader: 'tsx' },
    bundle: true,
    jsx: 'automatic',
    write: false,
    loader: { '.css': 'empty' },
    format: 'iife',
    platform: 'browser',
    conditions: ['production'],
    alias: {
      react: path.resolve('web/node_modules/react'),
      'react-dom': path.resolve('web/node_modules/react-dom'),
      '@': path.resolve('web/src'),
      ...fixture.alias,
    },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', ...fixture.define },
    logLevel: 'silent',
  }
}

/** The fixture page's whole script. */
export async function bundleWebFixture(fixture: WebFixtureBundle): Promise<string> {
  const result: BuildResult<{ write: false }> = await build(webFixtureBuildOptions(fixture))
  return result.outputFiles[0]!.text
}
