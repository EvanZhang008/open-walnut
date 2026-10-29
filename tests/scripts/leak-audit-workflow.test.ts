/**
 * .github/workflows/leak-audit.yml scans what Walnut publishes outside git
 * (scripts/leak-scan/README.md). Pins what a later edit could silently undo: a workflow
 * whose logs nobody scans (a new one, or a renamed one the trigger list still names by
 * its old name), a scan that prints the matched text into a public log, a scan without
 * the secret rules, and a site deploy that uploads without scanning.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'

const REPO = path.join(import.meta.dirname, '..', '..')
const DIR = path.join(REPO, '.github', 'workflows')

interface Step { uses?: string; run?: string; if?: string; name?: string; env?: Record<string, string> }
interface Job { if?: string; steps?: Step[] }
interface Workflow { name?: string; on?: Record<string, unknown>; jobs: Record<string, Job> }
const read = (file: string) => parseYaml(fs.readFileSync(path.join(DIR, file), 'utf8')) as Workflow
const audit = read('leak-audit.yml')

describe('leak-audit.yml', () => {
  it('scans the logs of every other workflow, by its current name', () => {
    const names = fs.readdirSync(DIR).filter((f) => f.endsWith('.yml') && f !== 'leak-audit.yml').map((f) => read(f).name)
    const listed = (audit.on!.workflow_run as { workflows: string[] }).workflows
    expect([...listed].sort()).toEqual([...names].sort())
  })

  it('runs on finished runs, releases, a daily schedule and by hand', () => {
    expect(Object.keys(audit.on!).sort()).toEqual(['release', 'schedule', 'workflow_dispatch', 'workflow_run'])
  })

  const steps = Object.entries(audit.jobs).flatMap(([job, j]) => (j.steps ?? []).map((s) => ({ job, ...s } as Step & { job: string; env?: Record<string, string>; 'continue-on-error'?: unknown })))
  const scanSteps = steps.filter((s) => (s.run ?? '').includes('leak-scan.mjs'))

  it('every scan reads the secret rules and redacts its output; text anyone writes gets a bare count', () => {
    const lines = scanSteps.flatMap((s) => (s.run ?? '').split('\n').filter((l) => l.includes('leak-scan.mjs')).map((l) => ({ job: s.job, l })))
    expect(lines.length).toBeGreaterThanOrEqual(6)
    for (const { job, l } of lines) {
      expect(l).toContain('--rules-env LEAK_SCAN_RULES')
      expect(l).toMatch(/--redact|--count-only/)
      if (job === 'run-logs' || l.includes('talk')) expect(l).toContain('--count-only')
      expect(l).not.toMatch(/\|\|\s*true/)
    }
    for (const s of scanSteps) expect(s['continue-on-error'], s.name).toBeUndefined()
  })

  it('hands the secret only to the scan steps', () => {
    expect(JSON.stringify((audit as unknown as { env?: unknown }).env ?? {})).not.toContain('LEAK_SCAN_RULES')
    for (const j of Object.values(audit.jobs)) expect(JSON.stringify((j as { env?: unknown }).env ?? {})).not.toContain('secrets.')
    for (const s of steps) {
      const usesSecret = JSON.stringify(s.env ?? {}).includes('secrets.LEAK_SCAN_RULES')
      const scans = (s.run ?? '').includes('leak-scan.mjs') || (s.run ?? '').includes('LEAK_SCAN_RULES')
      expect(usesSecret, s.name).toBe(scans)
    }
  })

  it('scans release assets after the release workflows, since their GITHUB_TOKEN publish starts no release event', () => {
    const cond = audit.jobs['release-assets']!.if ?? ''
    const names = fs.readdirSync(DIR).filter((f) => f.endsWith('.yml')).map((f) => read(f).name)
    for (const n of ['Release', 'Release archives', 'Mac app', 'Components', 'Speech runtime']) {
      expect(cond).toContain(`"${n}"`)
      expect(names).toContain(n)
    }
    expect(cond).toContain("github.event_name == 'schedule'")
  })

  it('runs only in the upstream repository, where the secret exists', () => {
    for (const [name, job] of Object.entries(audit.jobs)) expect(job.if, name).toContain("github.repository == 'EvanZhang008/open-walnut'")
  })
})

describe('site-deploy.sh', () => {
  const script = fs.readFileSync(path.join(REPO, 'scripts', 'site-deploy.sh'), 'utf8')

  it('scans the archived site before the upload, and the upload is the scanned copy', () => {
    const scan = script.indexOf('leak-scan.mjs')
    const deploy = script.indexOf('pages deploy')
    expect(scan).toBeGreaterThan(-1)
    expect(deploy).toBeGreaterThan(scan)
    expect(script).toMatch(/git archive "\$sha" site \| tar -x -C "\$work"/)
    expect(script).toMatch(/cd "\$work" && npx -y wrangler@4 pages deploy site/)
  })

  it('refuses without rules, before it needs any credential', () => {
    const r = spawnSync('bash', [path.join(REPO, 'scripts', 'site-deploy.sh')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', WALNUT_LEAK_RULES: '' },
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no leak-scan rules/)
  })
})
