/**
 * Every GitHub read of the leak audit retries (scripts/lib/gh-retry.sh). 2026-11-07, Leak audit
 * run 42419194376: one HTTP 500 on a release asset of 0.6.28 ended the audit, because its curl
 * reads retried and its gh reads did not. Each gh call is found from the workflow's own text,
 * so a new one that does not retry fails here.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const REPO = path.join(import.meta.dirname, '..', '..')
const HELPER = path.join(REPO, 'scripts/lib/gh-retry.sh')
type Step = { uses?: string; run?: string; with?: Record<string, unknown> }
const jobs = (parseYaml(fs.readFileSync(path.join(REPO, '.github/workflows/leak-audit.yml'), 'utf8')) as { jobs: Record<string, { steps?: Step[] }> }).jobs

/** Runs gh_retry on a command that fails until its `okFrom`-th try. */
function run(okFrom: number, tries = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-retry-'))
  const cmd = `n=$(( $(cat "${dir}/n" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/n"; [ $n -ge ${okFrom} ]`
  const r = spawnSync('sh', ['-c', `. "${HELPER}"; gh_retry sh -c '${cmd}'`], {
    encoding: 'utf8', env: { ...process.env, GH_RETRY_TRIES: String(tries), GH_RETRY_SECS: '0' },
  })
  const calls = Number(fs.readFileSync(path.join(dir, 'n'), 'utf8'))
  fs.rmSync(dir, { recursive: true, force: true })
  return { code: r.status, calls, err: r.stderr }
}

describe('gh_retry', () => {
  it('returns at once on success, and after the try that works', () => {
    expect(run(1)).toMatchObject({ code: 0, calls: 1 })
    expect(run(3)).toMatchObject({ code: 0, calls: 3 })
  })

  it('gives up after its tries with the command failure, saying so', () => {
    const r = run(99, 3)
    expect(r.code).not.toBe(0)
    expect(r.calls).toBe(3)
    expect(r.err).toContain('gh_retry: gave up after 3 tries')
  })
})

describe('leak-audit.yml reads GitHub through gh_retry', () => {
  const steps = Object.entries(jobs).flatMap(([job, j]) => (j.steps ?? []).map((s) => ({ job, s })))
  const ghLines = steps.flatMap(({ job, s }) => (s.run ?? '').split('\n')
    .filter((l) => /(^|[\s;|&(])gh (api|release|run)\b/.test(l.replace(/'[^']*'/g, (q) => (q.includes('gh ') ? ' gh api ' : ''))))
    .map((l) => ({ job, s, l: l.trim() })))

  it('finds the gh reads', () => {
    expect(ghLines.length).toBeGreaterThanOrEqual(6)
  })

  it.each(ghLines.map((g) => [g.l, g] as const))('%s', (_l, { job, s, l }) => {
    expect(l.startsWith('gh_retry ')).toBe(true)
    expect(s.run).toContain('. scripts/lib/gh-retry.sh')
    // the job's checkout carries the helper (a sparse checkout names it)
    const co = jobs[job]!.steps!.find((x) => x.uses?.startsWith('actions/checkout@'))!
    const sparse = co.with?.['sparse-checkout']
    if (sparse) expect(String(sparse)).toContain('scripts/lib/gh-retry.sh')
  })

  it('a rerun download overwrites what the failed try left', () => {
    for (const { l } of ghLines.filter((g) => g.l.includes('gh release download'))) expect(l).toContain('--clobber')
  })
})
