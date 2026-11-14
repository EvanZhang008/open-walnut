/**
 * A job with a sparse checkout has only the files it names, so every script it runs must
 * bring its own local imports along in that list (2026-11-13: ci-runner-retry.mjs and
 * ci-gate.mjs began sharing scripts/lib/gh-transient.mjs, and a sparse checkout that named
 * only the script would have failed at its first import). Enumerated from the source: every
 * workflow job with a sparse checkout, every repo script its steps run, and that script's
 * relative imports, followed through the files they import.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { localImports } from '../helpers/script-imports.js'

const REPO = path.join(import.meta.dirname, '..', '..')
const DIR = path.join(REPO, '.github', 'workflows')

interface Step { uses?: string; run?: string; with?: Record<string, unknown> }
interface Job { steps?: Step[] }

const jobs = fs.readdirSync(DIR).filter((f) => f.endsWith('.yml')).flatMap((file) => {
  const wf = parseYaml(fs.readFileSync(path.join(DIR, file), 'utf8')) as { jobs?: Record<string, Job> }
  return Object.entries(wf.jobs ?? {}).flatMap(([name, job]) => {
    const co = (job.steps ?? []).find((s) => s.uses?.startsWith('actions/checkout@'))
    const sparse = co?.with?.['sparse-checkout']
    if (!sparse) return []
    const listed = String(sparse).split('\n').map((l) => l.trim()).filter(Boolean)
    const runs = (job.steps ?? []).map((s) => s.run ?? '').join('\n')
    const scripts = [...new Set([...runs.matchAll(/\b(scripts\/[\w./-]+\.(?:mjs|js|ts|sh))\b/g)].map((m) => m[1]!))]
      .filter((f) => fs.existsSync(path.join(REPO, f)))
    return [{ id: `${file} ${name}`, listed, scripts }]
  })
})

describe('a sparse checkout carries what its scripts import', () => {
  it('finds the sparse checkouts and the scripts they run', () => {
    expect(jobs.length).toBeGreaterThanOrEqual(3)
    expect(jobs.some((j) => j.scripts.includes('scripts/ci-runner-retry.mjs'))).toBe(true)
  })

  it('the shared gh matcher is reached from ci-runner-retry.mjs (the reader follows imports)', () => {
    expect([...localImports('scripts/ci-runner-retry.mjs')]).toContain('scripts/lib/gh-transient.mjs')
  })

  it.each(jobs.map((j) => [j.id, j] as const))('%s', (_id, { listed, scripts }) => {
    const covered = (f: string) => listed.some((l) => l === f || (l.endsWith('/') ? f.startsWith(l) : f.startsWith(`${l}/`)))
    const missing = scripts.flatMap((s) => [s, ...localImports(s)]).filter((f) => !covered(f))
    expect([...new Set(missing)], 'add these to the job\'s sparse-checkout list').toEqual([])
  })
})

// A test that copies repo scripts into a sandbox has the same need: every such copy goes
// through withLocalImports, so a new import of a copied script comes along by itself.
describe('a test that copies repo scripts into a sandbox copies their imports too', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)])
  const copiers = walk(path.join(REPO, 'tests')).filter((f) => /\.test\.ts$/.test(f))
    .map((f) => ({ rel: path.relative(REPO, f), text: fs.readFileSync(f, 'utf8') }))
    .filter(({ text }) => /copyFileSync\(\s*path\.join\(\s*(REPO|ROOT|REPO_ROOT|repoRoot|root)\s*,\s*'scripts'/.test(text))

  it('finds them', () => {
    expect(copiers.map((c) => c.rel)).toEqual(expect.arrayContaining(['tests/scripts/release-script-e2e.test.ts', 'tests/scripts/release-promote-steps.test.ts']))
  })

  it.each(copiers.map((c) => [c.rel, c] as const))('%s', (_rel, { text }) => {
    expect(text, 'copy the list through withLocalImports from tests/helpers/script-imports.ts').toContain('withLocalImports(')
  })
})

