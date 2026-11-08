#!/usr/bin/env bun
/**
 * Who turned CI red: for each job failing on main's newest CI run, the run where that job last
 * passed, the first run after it where it failed, the commits in between, and the failure lines
 * GitHub annotated. A red main used to show only as GitHub's mail and a red X; for eight days
 * (2026-10-30 to 11-08) every run failed and no commit's author was told.
 *
 *   bun scripts/ci-red-range.mjs [--run <id>] [--repo <owner/name>] [--json <file>] [--owners <file>]
 *
 * --owners <file>: JSON { "<commit subject>": "<owner>" }; each commit in a range is named with
 * its owner when its subject is listed (a land queue knows which task landed which subject; the
 * hashes on GitHub differ from the ones landed, the subjects do not).
 * Needs `gh` signed in. Read-only: it only reads the Actions API.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const WORKFLOW = 'ci.yml'
const MAX_RUNS = 300
// Jobs that only sum up the others: their red says nothing of its own.
const SUMMARY_JOBS = new Set(['CI OK'])

function gh(path) {
  const r = spawnSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`gh api ${path}: ${(r.stderr || '').trim()}`)
  return JSON.parse(r.stdout)
}

function repoName() {
  const r = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('gh repo view failed: pass --repo <owner/name>')
  return r.stdout.trim()
}

/** Completed CI runs on main, newest first: the commits main had, not pull requests. */
function mainRuns(repo) {
  const out = []
  for (let page = 1; out.length < MAX_RUNS; page++) {
    const r = gh(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?branch=main&status=completed&per_page=100&page=${page}`)
    const rs = (r.workflow_runs ?? []).filter((x) => x.event !== 'pull_request')
    out.push(...rs)
    if ((r.workflow_runs ?? []).length < 100) break
  }
  return out.slice(0, MAX_RUNS)
}

const jobsCache = new Map()
function jobsOf(repo, runId) {
  if (!jobsCache.has(runId)) {
    const jobs = []
    for (let page = 1; ; page++) {
      const r = gh(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`)
      jobs.push(...(r.jobs ?? []))
      if ((r.jobs ?? []).length < 100) break
    }
    jobsCache.set(runId, jobs)
  }
  return jobsCache.get(runId)
}

/**
 * For one job name, walking back from the newest run: the newest run where it passed, and the
 * oldest failing run after that one (the run that turned it red). Runs where it was cancelled,
 * skipped or absent are stepped over.
 */
export function redRange(runs, conclusionOf) {
  let firstRed = null
  for (const run of runs) {
    const c = conclusionOf(run)
    if (c === 'success') return { lastGreen: run, firstRed }
    if (c === 'failure') firstRed = run
  }
  return { lastGreen: null, firstRed }
}

function annotations(repo, jobId) {
  try {
    return gh(`repos/${repo}/check-runs/${jobId}/annotations?per_page=50`)
      .filter((a) => a.annotation_level === 'failure')
      .map((a) => `${a.path && a.path !== '.github' ? a.path + ': ' : ''}${(a.title ? a.title + ': ' : '') + (a.message || '').split('\n')[0]}`.slice(0, 300))
  } catch { return [] }
}

function main() {
  const argv = process.argv.slice(2)
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
  const repo = opt('--repo') ?? repoName()
  const owners = opt('--owners') ? JSON.parse(fs.readFileSync(opt('--owners'), 'utf8')) : {}
  const runs = mainRuns(repo)
  const target = opt('--run') ? runs.find((r) => String(r.id) === opt('--run')) : runs[0]
  if (!target) throw new Error('no completed CI run on main')
  const failed = jobsOf(repo, target.id).filter((j) => j.conclusion === 'failure' && !SUMMARY_JOBS.has(j.name))
  const older = runs.slice(runs.indexOf(target))
  const report = { repo, run: { id: target.id, sha: target.head_sha, at: target.created_at, conclusion: target.conclusion }, jobs: [] }
  for (const job of failed) {
    const { lastGreen, firstRed } = redRange(older, (run) => jobsOf(repo, run.id).find((j) => j.name === job.name)?.conclusion ?? null)
    let commits = []
    if (lastGreen && firstRed) {
      const cmp = gh(`repos/${repo}/compare/${lastGreen.head_sha}...${firstRed.head_sha}`)
      commits = (cmp.commits ?? []).map((c) => {
        const subject = c.commit.message.split('\n')[0]
        return { sha: c.sha.slice(0, 9), subject, owner: owners[subject] ?? null }
      })
    }
    report.jobs.push({
      job: job.name,
      failures: annotations(repo, job.id),
      lastGreen: lastGreen && { id: lastGreen.id, sha: lastGreen.head_sha.slice(0, 9), at: lastGreen.created_at },
      firstRed: firstRed && { id: firstRed.id, sha: firstRed.head_sha.slice(0, 9), at: firstRed.created_at },
      commits,
    })
  }
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(report, null, 2))
  console.log(`CI run ${target.id} on main (${target.head_sha.slice(0, 9)}, ${target.created_at}): ${failed.length} failing job(s)`)
  for (const j of report.jobs) {
    console.log(`\n${j.job}: ${j.firstRed ? `red since run ${j.firstRed.id} (${j.firstRed.at})` : 'red'}${j.lastGreen ? `, last green run ${j.lastGreen.id} (${j.lastGreen.at})` : `, never green in the last ${MAX_RUNS} runs`}`)
    for (const f of j.failures.slice(0, 5)) console.log(`  failure: ${f}`)
    for (const c of j.commits) console.log(`  ${c.sha} ${c.subject}${c.owner ? `  [${c.owner}]` : ''}`)
  }
}

if (import.meta.main) main()
