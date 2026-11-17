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
 * Vite's `?raw` import (a file's text as the default export: the Board's frame scripts in
 * TaskBoardPane.tsx) loads as text too; esbuild alone has no such suffix, and every spec whose
 * component reached the Board failed to build ("No matching export ... for import default",
 * 2026-11-16). `VITE_IMPORT_SUFFIXES` lists the suffixes handled here.
 *
 * Guard: tests/scripts/web-fixture-bundle-ratchet.test.ts (every spec that bundles web/src with
 * esbuild builds through this).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { build, type BuildOptions, type BuildResult, type Plugin } from 'esbuild'

/** The Vite import suffixes (`./file?raw`) a fixture build understands, as the app's build does. */
export const VITE_IMPORT_SUFFIXES = ['raw'] as const

const WEB_SRC = path.resolve('web/src')

/** `import text from './x.js?raw'`: the file's text as its default export. */
const viteRaw: Plugin = {
  name: 'vite-raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => {
      const spec = args.path.slice(0, -'?raw'.length)
      const file = spec.startsWith('@/') ? path.join(WEB_SRC, spec.slice(2)) : path.resolve(args.resolveDir, spec)
      return { path: file, namespace: 'vite-raw' }
    })
    b.onLoad({ filter: /.*/, namespace: 'vite-raw' }, async (args) => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' }))
  },
}

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
    plugins: [viteRaw],
    logLevel: 'silent',
  }
}

/** The fixture page's whole script. */
export async function bundleWebFixture(fixture: WebFixtureBundle): Promise<string> {
  const result: BuildResult<{ write: false }> = await build(webFixtureBuildOptions(fixture))
  return result.outputFiles[0]!.text
}
