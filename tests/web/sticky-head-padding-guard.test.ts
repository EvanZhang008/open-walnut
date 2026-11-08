/**
 * A sticky head that cancels its scroller's top padding with a negative
 * margin-top must stick at the same offset, or the scrolled rows show through a
 * strip above it (2026-11-08: the Files tree showed a row's top above its head,
 * WebKit and Chromium alike, 4px). Every stylesheet rule with position: sticky,
 * a top and a negative margin-top is checked.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '../../web/src')

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name)
    return e.isDirectory() ? cssFiles(file) : e.name.endsWith('.css') ? [file] : []
  })
}

describe('sticky heads over a padded scroller', () => {
  it('stick at the negative margin they use to cancel the padding', () => {
    const found: string[] = []
    const wrong: string[] = []
    for (const file of cssFiles(root)) {
      const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2]
        if (!/position:\s*sticky/.test(body)) continue
        const margin = /(?:^|;|\s)margin-top:\s*(-[\d.]+px)/.exec(body)?.[1]
        const top = /(?:^|;|\s)top:\s*([^;]+)/.exec(body)?.[1]?.trim()
        if (!margin || !top) continue
        const where = `${path.relative(root, file)} ${m[1].trim()}`
        found.push(where)
        if (top !== margin) wrong.push(`${where}: top ${top}, margin-top ${margin}`)
      }
    }
    expect(found.length).toBeGreaterThan(0)
    expect(wrong).toEqual([])
  })
})
