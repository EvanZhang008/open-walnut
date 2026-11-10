import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// `playwright install --with-deps` runs apt, whose mirror can stall with no output (run
// 42763058265: a browser leg sat 58 minutes in apt-get update until the job's limit cancelled
// it, before one spec ran) or crawl. Every such install in a workflow goes through
// scripts/ci/install-browsers.sh, which bounds apt's connections and the install itself.
const ROOT = path.resolve(__dirname, '../..')
const DIR = path.join(ROOT, '.github/workflows')
const SCRIPT = 'scripts/ci/install-browsers.sh'

export function directInstalls(name: string, yml: string): string[] {
  return yml.split('\n').flatMap((line, i) =>
    /playwright install --with-deps/.test(line) ? [`${name}:${i + 1}: ${line.trim()}`] : [])
}

describe('workflows bound the browser install', () => {
  it('no workflow runs playwright install --with-deps itself', () => {
    const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))
    const found = files.flatMap((f) => directInstalls(f, fs.readFileSync(path.join(DIR, f), 'utf8')))
    expect(found).toEqual([])
    const users = files.filter((f) => fs.readFileSync(path.join(DIR, f), 'utf8').includes(SCRIPT))
    expect(users, 'the workflows that install browsers with their system packages').toEqual(
      expect.arrayContaining(['ci.yml', 'push-gate.yml']))
  })

  it('the script bounds apt and each try, and waits out a killed apt-get', () => {
    const s = fs.readFileSync(path.join(ROOT, SCRIPT), 'utf8')
    expect(s).toMatch(/Acquire::https?::Timeout/)
    expect(s).toMatch(/Acquire::Retries/)
    expect(s).toMatch(/timeout \d+ bun x playwright install --with-deps "\$@"/)
    expect(s).toMatch(/fuser \/var\/lib\/dpkg\/lock-frontend/)
  })

  it('the scan catches a direct install', () => {
    expect(directInstalls('x.yml', '      - run: bun x playwright install --with-deps chromium')).toHaveLength(1)
    expect(directInstalls('x.yml', '        run: bash scripts/ci/install-browsers.sh chromium webkit')).toEqual([])
  })
})
