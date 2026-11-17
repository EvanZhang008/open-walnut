/**
 * Walnut's GitHub change provider (src/core/changes/github.ts) against a stand-in gh (the exec
 * seam): an open pull request (from the pull request watch's snapshot with no call, else one REST
 * read), a merged one with deployments (one stage per environment), a merged one with only check
 * runs (one CI stage, its runs as the stage's steps), a commit link, and gh's failures.
 */
import { describe, it, expect } from 'vitest'
import { createGithubChangeProvider, type GithubChangeLink } from '../../../src/core/changes/github.js'
import type { ExecFn } from '../../../src/core/pull-requests/providers.js'
import type { PrSnapshot } from '../../../src/core/pull-requests/model.js'

const PR = 'https://github.com/acme/app/pull/12'
const SHA = 'a'.repeat(40)
const COMMIT = `https://github.com/acme/app/commit/${SHA}`
const T0 = Date.parse('2026-11-17T10:00:00Z')

/** A gh that answers `gh api <path>` from a table; a function value can fail like gh does. */
function standIn(table: Record<string, unknown | (() => { code: number; stderr: string })>) {
  const calls: string[] = []
  const exec: ExecFn = async (_file, args) => {
    const path = args[1]!
    calls.push(path)
    const hit = table[path]
    if (hit === undefined) return { code: 1, stdout: '', stderr: `gh: Not Found (HTTP 404) for ${path}` }
    if (typeof hit === 'function') return { stdout: '', ...(hit as () => { code: number; stderr: string })() }
    return { code: 0, stdout: JSON.stringify(hit), stderr: '' }
  }
  return { exec, calls }
}

async function readOne(exec: ExecFn, link: GithubChangeLink) {
  const provider = createGithubChangeProvider(exec, () => T0)
  return (await provider.read([link], { signal: new AbortController().signal })).get(link.url)!
}

const prSnap = (extra: Partial<PrSnapshot>): PrSnapshot => ({
  provider: 'github', url: PR, repo: 'acme/app', number: 12, title: 'Fix login', state: 'open',
  checks: { total: 4, passed: 3, failed: 1, pending: 0, skipped: 0, items: [] }, checkedAt: '2026-11-17T09:59:00Z', ...extra,
} as PrSnapshot)

const deployments = `repos/acme/app/deployments?sha=${SHA}&per_page=100`
const checkRuns = `repos/acme/app/commits/${SHA}/check-runs?per_page=100`

describe('github change provider', () => {
  it('handles GitHub pull requests and commits only', () => {
    const p = createGithubChangeProvider(standIn({}).exec)
    expect(p.handles({ key: 'pr', url: PR })).toBe(true)
    expect(p.handles({ key: 'commit', url: COMMIT })).toBe(true)
    expect(p.handles({ key: 'issue', url: 'https://github.com/acme/app/issues/3' })).toBe(false)
    expect(p.handles({ key: 'cr', url: 'https://review.acme.dev/r/1001' })).toBe(false)
  })

  it('an open pull request the pull request watch follows: its review from that snapshot, no gh call', async () => {
    const gh = standIn({})
    const r = await readOne(gh.exec, { key: 'pr', url: PR, pr: prSnap({ review: 'approved' }) })
    expect(gh.calls).toEqual([])
    expect(r).toEqual({ ok: true, snapshot: { label: 'app#12', title: 'Fix login', review: { state: 'approved', checks: { passed: 3, failed: 1, pending: 0 } } } })
  })

  it('an open pull request with no snapshot: one REST read', async () => {
    const gh = standIn({ 'repos/acme/app/pulls/12': { state: 'open', draft: true, merged: false, title: 'Fix login' } })
    const r = await readOne(gh.exec, { key: 'pr', url: PR })
    expect(gh.calls).toEqual(['repos/acme/app/pulls/12'])
    expect(r).toEqual({ ok: true, snapshot: { label: 'app#12', title: 'Fix login', review: { state: 'draft' } } })
  })

  it('a merged pull request with deployments: one stage per environment from its latest status', async () => {
    const table: Record<string, unknown> = {
      'repos/acme/app/pulls/12': { state: 'closed', merged: true, merge_commit_sha: SHA, merged_at: '2026-11-17T09:00:00Z', title: 'Fix login' },
      // Newest first, as GitHub lists them: an older staging deploy is superseded by the newer one.
      [deployments]: [
        { id: 3, environment: 'production', production_environment: true },
        { id: 2, environment: 'staging' },
        { id: 1, environment: 'staging' },
      ],
      'repos/acme/app/deployments/2/statuses?per_page=1': [{ state: 'success', created_at: '2026-11-17T09:10:00Z' }],
      'repos/acme/app/deployments/3/statuses?per_page=1': [{ state: 'in_progress', description: 'Rolling out', created_at: '2026-11-17T09:20:00Z' }],
    }
    const gh = standIn(table)
    const r = await readOne(gh.exec, { key: 'pr', url: PR, pr: prSnap({ state: 'merged', mergedAt: '2026-11-17T09:00:00Z' }) })
    expect(r.ok && r.snapshot.review?.state).toBe('merged')
    expect(r.ok && r.snapshot.deploy).toEqual({
      pipeline: 'GitHub deployments', url: 'https://github.com/acme/app/deployments', commit: SHA.slice(0, 7),
      stages: [
        { name: 'staging', status: 'done', at: '2026-11-17T09:10:00Z' },
        { name: 'production', status: 'running', at: '2026-11-17T09:20:00Z', note: 'Rolling out', prod: true },
      ],
      last: 'staging', next: 'production', done: false,
    })

    table['repos/acme/app/deployments/3/statuses?per_page=1'] = [{ state: 'success', created_at: '2026-11-17T09:40:00Z' }]
    const after = await readOne(standIn(table).exec, { key: 'pr', url: PR })
    expect(after.ok && after.snapshot.deploy?.done).toBe(true)

    table['repos/acme/app/deployments/3/statuses?per_page=1'] = [{ state: 'failure' }]
    const failed = await readOne(standIn(table).exec, { key: 'pr', url: PR })
    expect(failed.ok && failed.snapshot.deploy?.stages[1]?.status).toBe('failed')
  })

  it('reads at most 10 environments, the most recently deployed, one status call each', async () => {
    const envs = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, environment: `region-${i}` }))
    const table: Record<string, unknown> = { [deployments]: envs }
    for (const d of envs) table[`repos/acme/app/deployments/${d.id}/statuses?per_page=1`] = [{ state: 'success' }]
    const gh = standIn(table)
    const r = await readOne(gh.exec, { key: 'commit', url: COMMIT })
    // Newest first from GitHub: region-0..9 are kept, shown oldest first.
    expect(r.ok && r.snapshot.deploy?.stages.map((s) => s.name)).toEqual(Array.from({ length: 10 }, (_, i) => `region-${9 - i}`))
    expect(gh.calls.filter((c) => c.includes('/statuses')).length).toBe(10)
  })

  it('a merged pull request with only check runs: one CI stage, and its runs as the stage\'s steps', async () => {
    const table: Record<string, unknown> = {
      'repos/acme/app/pulls/12': { state: 'closed', merged: true, merge_commit_sha: SHA, merged_at: '2026-11-17T08:00:00Z' },
      [deployments]: [],
      [checkRuns]: { check_runs: [
        { name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/app/runs/1' },
        { name: 'lint', status: 'in_progress', conclusion: null },
      ] },
    }
    const provider = createGithubChangeProvider(standIn(table).exec, () => T0)
    const signal = new AbortController().signal
    const r = (await provider.read([{ key: 'pr', url: PR }], { signal })).get(PR)!
    expect(r.ok && r.snapshot.deploy).toMatchObject({ pipeline: 'GitHub checks', stages: [{ name: 'CI', status: 'running', note: '1 passed, 1 running' }], done: false })

    const detail = await provider.stageDetail!({ key: 'pr', url: PR }, 'CI', { signal })
    expect(detail).toEqual({
      stage: 'CI',
      steps: [{ name: 'test', status: 'done', url: 'https://github.com/acme/app/runs/1' }, { name: 'lint', status: 'running' }],
      blockers: [],
      url: COMMIT,
    })

    ;(table[checkRuns] as { check_runs: Array<Record<string, unknown>> }).check_runs[1] = { name: 'lint', status: 'completed', conclusion: 'failure' }
    const red = await readOne(standIn(table).exec, { key: 'pr', url: PR })
    expect(red.ok && red.snapshot.deploy?.stages[0]).toMatchObject({ status: 'failed', note: '1 passed, 1 failed' })

    ;(table[checkRuns] as { check_runs: Array<Record<string, unknown>> }).check_runs[1] = { name: 'lint', status: 'completed', conclusion: 'skipped' }
    const green = await readOne(standIn(table).exec, { key: 'pr', url: PR })
    expect(green.ok && green.snapshot.deploy).toMatchObject({ stages: [{ status: 'done' }], done: true })
  })

  it('no checks yet just after the merge is still running; long after, nothing is left to follow', async () => {
    const table = { [deployments]: [], [checkRuns]: { check_runs: [] } }
    const early = await readOne(standIn(table).exec, { key: 'pr', url: PR, pr: prSnap({ state: 'merged', mergedAt: new Date(T0 - 60_000).toISOString() }) })
    // The merge commit comes from one REST read when only the snapshot says merged.
    expect(early).toEqual({ ok: false, code: 'not-found', message: 'not found on GitHub' })
    const withSha = { ...table, 'repos/acme/app/pulls/12': { merged: true, merge_commit_sha: SHA } }
    const soon = await readOne(standIn(withSha).exec, { key: 'pr', url: PR, pr: prSnap({ state: 'merged', mergedAt: new Date(T0 - 60_000).toISOString() }) })
    expect(soon.ok && soon.snapshot.deploy?.stages[0]).toMatchObject({ status: 'running', note: 'No checks yet' })
    const late = await readOne(standIn(withSha).exec, { key: 'pr', url: PR, pr: prSnap({ state: 'merged', mergedAt: new Date(T0 - 3_600_000).toISOString() }) })
    expect(late.ok && late.snapshot.deploy).toMatchObject({ stages: [{ status: 'done', note: 'No checks' }], done: true })
  })

  it('a commit link follows its own commit, and a short hash is read once for the full one', async () => {
    const gh = standIn({
      'repos/acme/app/commits/aaaaaaa': { sha: SHA },
      [deployments]: [],
      [checkRuns]: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] },
    })
    const r = await readOne(gh.exec, { key: 'commit', url: 'https://github.com/acme/app/commit/aaaaaaa' })
    expect(r).toEqual({ ok: true, snapshot: { label: 'app@aaaaaaa', deploy: expect.objectContaining({ commit: 'aaaaaaa', done: true }) } })
    expect(gh.calls[0]).toBe('repos/acme/app/commits/aaaaaaa')
  })

  it('says why a read failed: signed out, not found', async () => {
    const out = standIn({ 'repos/acme/app/pulls/12': () => ({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }) })
    expect(await readOne(out.exec, { key: 'pr', url: PR })).toMatchObject({ ok: false, code: 'signed-out' })
    expect(await readOne(standIn({}).exec, { key: 'pr', url: PR })).toMatchObject({ ok: false, code: 'not-found' })
  })
})
