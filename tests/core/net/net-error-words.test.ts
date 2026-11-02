/**
 * The host network's errors name the machine Walnut runs on as "this machine" or "this Walnut",
 * never "this Mac": a Linux or Windows (WSL) Walnut leads a host network too (d0c2b58f3, 2026-11-02,
 * the Windows join job read "This Mac's Walnut daemon has no host network yet"). One message
 * was missed by that change, so every error built in these files is read here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = path.resolve(__dirname, '../../..')
const FILES = [
  ...fs.readdirSync(path.join(repo, 'src/core/net')).filter((f) => f.endsWith('.ts')).map((f) => `src/core/net/${f}`),
  'src/core/hosts/net-link.ts',
]

/** The text of every `new <X>Error(...)` call, up to its closing parenthesis. */
function errorCalls(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/new \w*Error\(/g)) {
    let depth = 0
    let end = m.index! + m[0].length - 1
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++
      else if (src[end] === ')' && --depth === 0) break
    }
    out.push(src.slice(m.index!, end + 1))
  }
  return out
}

describe('host network errors', () => {
  it('reads the net files', () => {
    expect(FILES).toContain('src/core/net/net-store.ts')
    expect(FILES.length).toBeGreaterThan(5)
  })

  it('never call the machine Walnut runs on "this Mac"', () => {
    const offenders = FILES.flatMap((rel) => errorCalls(fs.readFileSync(path.join(repo, rel), 'utf8'))
      .filter((call) => /\bthis Mac\b/i.test(call))
      .map((call) => `${rel}: ${call.replace(/\s+/g, ' ').slice(0, 160)}`))
    expect(offenders, 'say "this machine" or "this Walnut": a Linux or Windows Walnut leads a host network too').toEqual([])
  })
})
