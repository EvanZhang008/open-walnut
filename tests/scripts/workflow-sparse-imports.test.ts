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

const REPO = path.join(import.meta.dirname, '..', '..')
const DIR = path.join(REPO, '.github', 'workflows')

interface Step { uses?: string; run?: string; with?: Record<string, unknown> }
interface Job { steps?: Step[] }

/** The repo files a script imports by a relative path, followed through those files. */
function localImports(rel: string, seen = new Set<string>()): Set<string> {
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8')
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|^\s*\.\s+(scripts\/\S+\.sh)/gm)) {
    const spec = m[1] ?? m[2]
    const dep = spec ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) : m[3]!
    if (seen.has(dep) || !fs.existsSync(path.join(REPO, dep))) continue
    seen.add(dep)
    localImports(dep, seen)
  }
  return seen
}

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
