#!/usr/bin/env node
/**
 * Did CI pass on a commit? The one question both release channels ask before
 * anything reaches npm, because every npm install updates itself on restart:
 * a red build published once is a red build installed everywhere.
 *
 * "Passed" means the CI workflow's `CI OK` gate job succeeded on a push run for
 * that commit (the job that aggregates build, test, onboarding and remote-host;
 * report-only jobs do not count). Read through `gh api`, so it works the same in
 * GitHub Actions (GH_TOKEN + GH_REPO) and on a machine where `gh` is signed in.
 *
 *   node scripts/ci-gate.mjs commit <rev>      green | pending | red | none, exit 0 only on green
 *   node scripts/ci-gate.mjs release <rev>     the gate for a release tag: a commit that only
 *                                              touches the release files is judged by its parent
 *   node scripts/ci-gate.mjs last-green [branch]  the newest commit on the branch CI passed (empty if none)
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CI_WORKFLOW = 'ci.yml'
export const GATE_JOB = 'CI OK'
/** What `npm run release` changes; a commit touching only these carries its parent's CI result. */
export const RELEASE_FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md']

/**
 * The verdict for one commit from its CI runs (newest first or not; sorted here)
 * and a lookup of each run's jobs.
 */
export function verdictOf(runs, jobsOf) {
  const sorted = [...(runs ?? [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  const run = sorted[0]
  if (!run) return { verdict: 'none', url: null }
  const url = run.html_url ?? null
  if (run.status !== 'completed') return { verdict: 'pending', url }
  const gate = (jobsOf(run.id) ?? []).find((j) => j.name === GATE_JOB)
  const conclusion = gate ? gate.conclusion : run.conclusion
  if (conclusion === 'success') return { verdict: 'green', url }
  return { verdict: conclusion === 'cancelled' ? 'cancelled' : 'red', url }
}

/** Which commit a release tag is judged by: its parent when it only rolls the release files. */
export function releaseGateRev(changedFiles) {
  const onlyRelease = changedFiles.length > 0 && changedFiles.every((f) => RELEASE_FILES.includes(f))
  return onlyRelease ? 'parent' : 'self'
}

/** The newest green commit among completed push runs on a branch (runs newest first). */
export function pickLastGreen(runs, jobsOf) {
  const sorted = [...(runs ?? [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  const seen = new Set()
  for (const run of sorted) {
    if (seen.has(run.head_sha)) continue
    seen.add(run.head_sha)
    if (run.status !== 'completed' || run.conclusion === 'cancelled') continue
    if (verdictOf([run], jobsOf).verdict === 'green') return run.head_sha
  }
  return null
}

function gh(endpoint) {
  const out = execFileSync('gh', ['api', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  return JSON.parse(out)
}

const jobsOf = (runId) => gh(`repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`).jobs

/** Ask GitHub about one commit. Throws when `gh` is missing, signed out or the API fails. */
export function commitVerdict(sha) {
  const runs = gh(`repos/{owner}/{repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&event=push&per_page=20`).workflow_runs
  return verdictOf(runs, jobsOf)
}

export function lastGreen(branch = 'main') {
  const runs = gh(`repos/{owner}/{repo}/actions/workflows/${CI_WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=30`).workflow_runs
  return pickLastGreen(runs, jobsOf)
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function main() {
  const [mode, arg] = process.argv.slice(2)
  if (mode === 'last-green') {
    const sha = lastGreen(arg || 'main')
    if (sha) process.stdout.write(`${sha}\n`)
    return
  }
  if (mode !== 'commit' && mode !== 'release') {
    process.stderr.write('usage: ci-gate.mjs commit <rev> | release <rev> | last-green [branch]\n')
    process.exit(2)
  }
  let sha = git('rev-parse', `${arg || 'HEAD'}^{commit}`)
  if (mode === 'release') {
    const changed = git('diff', '--name-only', `${sha}^`, sha).split('\n').filter(Boolean)
    if (releaseGateRev(changed) === 'parent') {
      process.stderr.write(`release commit ${sha.slice(0, 8)} only changes ${changed.join(', ')}; judging its parent\n`)
      sha = git('rev-parse', `${sha}^`)
    }
  }
  const { verdict, url } = commitVerdict(sha)
  process.stdout.write(`${verdict}\n`)
  process.stderr.write(`CI on ${sha.slice(0, 8)}: ${verdict}${url ? ` (${url})` : ''}\n`)
  if (verdict !== 'green') process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
