import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// `playwright install --with-deps` runs apt, which can hang with no output on a runner: run
// 42763058265's Report (browser 2/16) sat 58 minutes in it until the job's limit cancelled it,
// before one spec ran. Every such install in a workflow is bounded by `timeout` and tried again.
const ROOT = path.resolve(__dirname, '../..')
const DIR = path.join(ROOT, '.github/workflows')

export function unboundedInstalls(name: string, yml: string): string[] {
  return yml.split('\n').flatMap((line, i) =>
    /playwright install --with-deps/.test(line) && !/\btimeout \d+ /.test(line)
      ? [`${name}:${i + 1}: ${line.trim()}`]
      : [])
}

describe('workflows bound the browser install', () => {
  it('every playwright install --with-deps runs under timeout', () => {
    const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))
    const found = files.flatMap((f) => unboundedInstalls(f, fs.readFileSync(path.join(DIR, f), 'utf8')))
    expect(found).toEqual([])
  })

  it('the scan catches a bare install', () => {
    expect(unboundedInstalls('x.yml', '      - run: bun x playwright install --with-deps chromium')).toHaveLength(1)
    expect(unboundedInstalls('x.yml', '            timeout 480 bun x playwright install --with-deps chromium && exit 0')).toEqual([])
  })
})
