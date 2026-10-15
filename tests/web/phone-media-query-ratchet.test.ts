/**
 * The phone layout has one query (spec 4.1, C85): PHONE_LAYOUT_QUERY in
 * web/src/hooks/usePhoneLayout.ts and its CSS twins. A twin that kept the old
 * `(max-width: 768px)` alone would leave a phone held sideways (844 to 932 px
 * wide) half phone, half desktop. And `@media (hover: none)` rules sit outside
 * any width query, so a touch iPad (desktop columns) also gets them.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PHONE_LAYOUT_QUERY } from '../../web/src/hooks/usePhoneLayout'

const ROOT = join(__dirname, '..', '..')
const WEB_SRC = join(ROOT, 'web', 'src')

function cssFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...cssFiles(p))
    else if (name.endsWith('.css')) out.push(p)
  }
  return out
}

interface MediaBlock { prelude: string; line: number; enclosing: string[] }

/** Every @media prelude with the preludes of the @media blocks around it. */
export function mediaBlocks(css: string): MediaBlock[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const blocks: MediaBlock[] = []
  const stack: (string | null)[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '@' && text.startsWith('@media', i)) {
      const open = text.indexOf('{', i)
      if (open === -1) break
      const prelude = text.slice(i + 6, open).replace(/\s+/g, ' ').trim()
      const line = text.slice(0, i).split('\n').length
      blocks.push({ prelude, line, enclosing: stack.filter((s): s is string => s !== null) })
      stack.push(prelude)
      i = open + 1
      continue
    }
    if (ch === '{') stack.push(null)
    else if (ch === '}') stack.pop()
    i += 1
  }
  return blocks
}

const WIDTH = /\((?:max|min)-width:/
const files = cssFiles(WEB_SRC)

describe('phone media query twins', () => {
  it('the hook carries the landscape clause', () => {
    expect(PHONE_LAYOUT_QUERY).toBe('(max-width: 768px), (pointer: coarse) and (max-height: 500px)')
  })

  it('the parser sees nested blocks and ignores comments', () => {
    const b = mediaBlocks('/* @media (max-width: 768px) { */ @media (min-width: 1px) { a{} @media (hover: none) { b{} } }')
    expect(b.map((x) => x.prelude)).toEqual(['(min-width: 1px)', '(hover: none)'])
    expect(b[1].enclosing).toEqual(['(min-width: 1px)'])
  })

  it('no CSS file keeps a phone query without the landscape clause', () => {
    const bad: string[] = []
    for (const f of files) {
      for (const b of mediaBlocks(readFileSync(f, 'utf8'))) {
        if (b.prelude.includes('(max-width: 768px)') && !b.prelude.includes('(max-height: 500px)')) {
          bad.push(`${relative(ROOT, f)}:${b.line} @media ${b.prelude}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('every twin is the hook query, or its touch form', () => {
    const allowed = new Set([
      PHONE_LAYOUT_QUERY,
      '(max-width: 768px) and (pointer: coarse), (pointer: coarse) and (max-height: 500px)',
    ])
    const bad: string[] = []
    for (const f of files) {
      for (const b of mediaBlocks(readFileSync(f, 'utf8'))) {
        if (b.prelude.includes('(max-width: 768px)') && !allowed.has(b.prelude)) {
          bad.push(`${relative(ROOT, f)}:${b.line} @media ${b.prelude}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('(hover: none) rules are never inside a width query', () => {
    const bad: string[] = []
    for (const f of files) {
      for (const b of mediaBlocks(readFileSync(f, 'utf8'))) {
        if (!b.prelude.includes('hover: none')) continue
        if (WIDTH.test(b.prelude) || b.enclosing.some((e) => WIDTH.test(e))) {
          bad.push(`${relative(ROOT, f)}:${b.line} @media ${b.prelude}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})
