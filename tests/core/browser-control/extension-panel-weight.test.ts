/**
 * The side panel's script stays light (review R3-7: a warm open took about a second, and three
 * quarters of sidepanel.js was the public suffix list, pulled in through a host name the key popover
 * draws). Every module the side panel page imports, followed from sidepanel.ts, reaches neither
 * url-match.ts nor tldts: the background answers what needs the list (a site's logins, its name).
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '../../../packages/browser-extension/src')
const HEAVY = [/url-match/, /^tldts/]

/** The modules a file imports for its code (not `import type`), relative ones as paths. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const out: string[] = []
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) out.push(m[1])
  return out
}

function reach(entry: string): Map<string, string> {
  const seen = new Map<string, string>()
  const walk = (file: string, via: string) => {
    if (seen.has(file)) return
    seen.set(file, via)
    for (const spec of importsOf(file)) {
      if (!spec.startsWith('.')) { seen.set(`pkg:${spec}`, file); continue }
      const p = join(dirname(file), spec)
      walk(p.endsWith('.ts') ? p : `${p}.ts`, file)
    }
  }
  walk(join(SRC, entry), '')
  return seen
}

describe('the side panel page', () => {
  it('imports nothing that carries the public suffix list', () => {
    const graph = reach('sidepanel.ts')
    expect(graph.size).toBeGreaterThan(5)
    const heavy = [...graph].filter(([f]) => HEAVY.some((r) => r.test(f.replace(/^pkg:/, '').split('/').pop()!) || r.test(f.replace(/^pkg:/, ''))))
    expect(heavy.map(([f, via]) => `${f} (imported by ${via})`)).toEqual([])
  })
})
