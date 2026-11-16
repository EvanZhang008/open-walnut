/**
 * A pop-out window of one app ("Open in new window") draws that app at once: it loads only the
 * app's own screen, never the whole console, and shows no launch logo before it.
 *
 * 2026-11-16: the pop-out imported core-apps.tsx, and with it every built-in screen (Tasks, Mail,
 * Settings, the session panel...), about 1 MB fetched and run before it drew its one app; the
 * launch logo stood in the new window for about a second in WebKit meanwhile.
 *
 * The class: any module a pop-out window runs that imports the console's full registration (or a
 * screen of another app) brings the whole console back. Every file under web/src/popout/ and every
 * module they import inside web/src/apps/ is checked, so a new one joins by itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const WEB = path.join(ROOT, 'web/src')
const read = (abs: string) => fs.readFileSync(abs, 'utf8')

function staticImports(src: string): string[] {
  // Static `import ... from 'x'` and side-effect `import 'x'`; `import type` and `import('x')` load nothing now.
  return [...src.matchAll(/^import\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]!)
}

function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(WEB, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null
  if (!base) return null
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const file = base + ext
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
  }
  return null
}

describe('a pop-out window of one app', () => {
  it('never imports the console registration of every built-in screen', () => {
    const popoutFiles = fs.readdirSync(path.join(WEB, 'popout'))
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
      .map((f) => path.join(WEB, 'popout', f))
    expect(popoutFiles.length).toBeGreaterThan(5)
    const offenders: string[] = []
    for (const file of popoutFiles) {
      for (const spec of staticImports(read(file))) {
        const target = resolve(file, spec)
        if (target && path.relative(WEB, target) === path.join('apps', 'core-apps.tsx')) offenders.push(path.relative(ROOT, file))
      }
    }
    expect(offenders, 'a pop-out registers the built-in apps with core-apps-lazy.tsx').toEqual([])
  })

  it('loads each built-in screen only on demand', () => {
    const lazyFile = path.join(WEB, 'apps/core-apps-lazy.tsx')
    const src = read(lazyFile)
    // Nothing but the list, the registry and React at module scope: a screen is an import() call.
    for (const spec of staticImports(src)) {
      const target = resolve(lazyFile, spec)
      if (!target) { expect(spec).toBe('react'); continue }
      expect(['apps/core-app-list.ts', 'apps/registry.ts']).toContain(path.relative(WEB, target))
    }
    // Every built-in app has a loader (the Record type enforces it too; this names the id).
    const ids = [...read(path.join(WEB, 'apps/core-app-list.ts')).matchAll(/\bid: '([^']+)', title:/g)].map((m) => m[1]!)
    expect(ids.length).toBeGreaterThan(5)
    for (const id of ids) expect(src, `core-apps-lazy.tsx has no loader for ${id}`).toMatch(new RegExp(`\\n  ${id}: `))
  })

  it('the list of built-in apps imports no screen', () => {
    const listFile = path.join(WEB, 'apps/core-app-list.ts')
    for (const spec of staticImports(read(listFile))) {
      const target = resolve(listFile, spec)
      expect(target && path.relative(WEB, target)).toMatch(/^apps\/(registry|icons)\.tsx?$/)
    }
  })

  it('shows no launch logo before its view', () => {
    const html = read(path.join(ROOT, 'web/index.html'))
    const script = html.slice(html.indexOf('data-testid="boot-splash"'))
    expect(script).toMatch(/location\.pathname === '\/popout'/)
    expect(script).toMatch(/splash\.removeChild\(splash\.firstElementChild\)/)
  })
})
