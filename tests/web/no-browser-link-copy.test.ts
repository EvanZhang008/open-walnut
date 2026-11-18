/**
 * No screen says "browser link" (2026-11-18, the user: "browser link is very confusing"). The
 * tunnel's tab wears the tunnel's name (cloud/tunnel-name.ts), and an address a replica
 * server has is that server's, listed in "Your Walnut runs on" atop Phones & Cloud, not a way of its own.
 * This fails when any web source puts the words back in code (comments are free to name the
 * history); the one search keyword, which no one reads, is the only exception.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../web/src')
/** Search words a person types, never shown: "browser link" still finds the tunnel's tab. */
const ALLOWED = new Set(['components/settings/core-settings-registry.tsx'])

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return files(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

/** The code with its comments blanked out (a `//` inside a string such as a URL ends the scan of that line). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('no "browser link" on screen', () => {
  it('no web source says it outside comments', () => {
    const hits: string[] = []
    for (const file of files(ROOT)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      if (ALLOWED.has(rel)) continue
      code(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
        if (/browser[ -]link/i.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('the one exception is a search keyword, not a label', () => {
    const registry = fs.readFileSync(path.join(ROOT, 'components/settings/core-settings-registry.tsx'), 'utf8')
    const lines = code(registry).split('\n').filter((l) => /browser link/i.test(l))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(/keywords: \[/)
  })
})
