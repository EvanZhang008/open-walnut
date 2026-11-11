/**
 * Every artifact download in every workflow has its own step limit, under its job's.
 *
 * 2026-11-07 (release run 42357669879): actions/download-artifact hung for the whole
 * 30 minutes of the macos-26-intel row of the binary matrix, the job hit its limit, and
 * the 0.6.28 promotion was cancelled with every other row green. A download with no
 * step limit of its own can only end at the job's. Enumerated from the workflow files,
 * so a new download step is checked too.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const DIR = path.resolve(__dirname, '../../.github/workflows')
type Step = { uses?: string; run?: string; 'timeout-minutes'?: number }
type Job = { 'timeout-minutes'?: number; steps?: Step[] }
const MAX_STEP_MINUTES = 10

const downloads = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).flatMap((file) => {
  const jobs = (parseYaml(fs.readFileSync(path.join(DIR, file), 'utf8')) as { jobs?: Record<string, Job> }).jobs ?? {}
  return Object.entries(jobs).flatMap(([name, job]) =>
    (job.steps ?? []).map((step, i) => ({ where: `${file} ${name} step ${i + 1}`, step, job }))
      // The binary matrix's own fetch (FETCH_ARTIFACT, curl through the REST API) is a download too.
      .filter(({ step }) => step.uses?.startsWith('actions/download-artifact@') || /\$FETCH_ARTIFACT"? fetch /.test(step.run ?? '')))
})

describe('every artifact download ends on its own limit, not the job limit', () => {
  it('finds the downloads', () => {
    expect(downloads.length).toBeGreaterThanOrEqual(20)
    expect(downloads.filter((d) => d.step.run?.includes('FETCH_ARTIFACT')).length).toBeGreaterThanOrEqual(6)
  })

  it.each(downloads.map((d) => [d.where, d] as const))('%s has a step limit', (_where, { step, job }) => {
    const limit = step['timeout-minutes']
    expect(limit).toBeGreaterThan(0)
    expect(limit).toBeLessThanOrEqual(MAX_STEP_MINUTES)
    if (job['timeout-minutes']) expect(limit!).toBeLessThan(job['timeout-minutes'])
  })
})
