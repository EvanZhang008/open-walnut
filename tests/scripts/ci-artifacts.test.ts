/**
 * Every artifact a CI run uploads is public: anyone signed in to GitHub can
 * download it, and the leak audit (leak-audit.yml) scans each run's logs and
 * artifacts after it ends. A new artifact is a new thing to leak, so ci.yml may
 * upload only the ones named here, each small and of known content. 2026-10-31:
 * the iOS job's 130 MB result bundle (build logs, the runner's environment)
 * failed the audit on its first run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const ROOT = path.resolve(__dirname, '../..')
type Step = { uses?: string; with?: { name?: string } }
const doc = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }

/** Artifact name (matrix part as written) -> what it holds. */
const VETTED: Record<string, string> = {
  'known-failures-e2e-${{ matrix.shard }}': 'the e2e shard\'s failing test names',
  'onboarding-start-log-${{ matrix.os }}': 'the fresh-machine server log',
  'remote-host-logs': 'the remote host leg\'s daemon and server logs',
  'rehearsal-logs-${{ matrix.os }}': 'the release rehearsal logs',
  'field-logs-${{ matrix.os }}': 'the field update logs',
  'archive-logs-${{ matrix.target }}': 'the archive build logs',
  'browser-report-${{ matrix.shard }}': 'the Playwright JSON report the browser baseline reads',
}

describe('the artifacts ci.yml uploads', () => {
  it('are only the vetted ones', () => {
    const uploaded = Object.entries(doc.jobs).flatMap(([job, j]) =>
      (j.steps ?? []).filter((s) => s.uses?.startsWith('actions/upload-artifact')).map((s) => `${job}: ${s.with?.name ?? '(no name)'}`))
    const unvetted = uploaded.filter((u) => !(u.split(': ')[1]! in VETTED))
    expect(unvetted, 'a new artifact is public: vet what it holds and add it here').toEqual([])
    expect(Object.keys(VETTED).filter((name) => !uploaded.some((u) => u.endsWith(`: ${name}`))), 'no longer uploaded: take it off').toEqual([])
  })
})
