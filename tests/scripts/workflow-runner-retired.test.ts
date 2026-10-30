/**
 * No workflow asks for a hosted runner image GitHub has retired.
 *
 * A retired image fails every job on it, and during the weeks before, GitHub
 * fails them on purpose in scheduled brownouts (2026-10-30: the binary matrix's
 * macos-14 row, "a scheduled macOS 14 runner image brownout", retired
 * 2026-11-02, https://github.com/actions/runner-images/issues/13518). When
 * GitHub announces the next retirement, add the label here with its date and
 * move the rows off it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WORKFLOWS = path.resolve(import.meta.dirname, '../../.github/workflows')

/** Hosted runner labels that are gone, with when GitHub retired them. */
const RETIRED: Record<string, string> = {
  'macos-12': 'before 2026',
  'macos-13': 'before 2026-10',
  'macos-14': '2026-11-02',
  'ubuntu-20.04': 'before 2026',
}

describe('workflow runner images', () => {
  it('none is retired', () => {
    const hits: string[] = []
    for (const name of fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
      fs.readFileSync(path.join(WORKFLOWS, name), 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/(^|\s)#.*$/, '')
        for (const label of Object.keys(RETIRED)) {
          // `ubuntu:20.04` is a container image, not a runner: only the dashed label counts.
          if (new RegExp(`(^|[\\s,\\[:'"])${label.replace('.', '\\.')}($|[\\s,\\]'"}])`).test(code)) {
            hits.push(`${name}:${i + 1}: ${label} (retired ${RETIRED[label]})`)
          }
        }
      })
    }
    expect(hits, 'move these rows to a runner image GitHub still has').toEqual([])
  })

  it('the check sees a runner label and leaves a container image alone', () => {
    const re = (label: string) => new RegExp(`(^|[\\s,\\[:'"])${label.replace('.', '\\.')}($|[\\s,\\]'"}])`)
    expect(re('macos-14').test('          - { runner: macos-14, file: walnut-darwin-arm64 }')).toBe(true)
    expect(re('macos-14').test('    runs-on: macos-14')).toBe(true)
    expect(re('ubuntu-20.04').test('        os: [ubuntu-20.04, macos-26]')).toBe(true)
    expect(re('ubuntu-20.04').test("          - { image: 'ubuntu:20.04', file: walnut-linux-x64 }")).toBe(false)
    expect(re('macos-14').test('    runs-on: macos-14-large')).toBe(false)
  })
})
