#!/usr/bin/env bun
/**
 * Who turned CI red: for each job failing on main's newest CI run, the run where that job last
 * passed, the first run after it where it failed, the commits in between, and the failure lines
 * GitHub annotated. A red main used to show only as GitHub's mail and a red X; for eight days
 * (2026-10-30 to 11-08) every run failed and no commit's author was told.
 *
 *   bun scripts/ci-red-range.mjs [--run <id>] [--repo <owner/name>] [--json <file>] [--owners <file>]
 *
 * A range of a red main is often dozens of commits (CI on main runs every hour or two), so each
 * job's failing test files are read from its log, and a commit that changed one of them, or a
 * module one imports directly, is marked a suspect and listed first.
 *
 * --owners <file>: JSON { "<commit subject>": "<owner>" }; each commit in a range is named with
 * its owner when its subject is listed (a land queue knows which task landed which subject; the
 * hashes on GitHub differ from the ones landed, the subjects do not).
 * Needs `gh` signed in. Read-only: it only reads the Actions API.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const WORKFLOW = 'ci.yml'
const MAX_RUNS = 300
// Jobs that only sum up the others: their red says nothing of its own.
const SUMMARY_JOBS = new Set(['CI OK'])

function ghText(apiPath) {
  const r = spawnSync('gh', ['api', apiPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`gh api ${apiPath}: ${(r.stderr || '').trim()}`)
  return r.stdout
}
const gh = (apiPath) => JSON.parse(ghText(apiPath))

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

// A job missing from this many runs in a row did not exist before them (a new or renamed job,
// e2e 1/4 becoming e2e 1/6): the walk stops there instead of reading every run left.
export const ABSENT_RUNS_END = 10

/**
 * For one job name, walking back from the newest run: the newest run where it passed, and the
 * oldest failing run after that one (the run that turned it red). Runs where it was cancelled,
 * skipped or absent are stepped over; `isNew` when the job had no run before the reds.
 */
export function redRange(runs, conclusionOf) {
  let firstRed = null
  let absent = 0
  for (const run of runs) {
    const c = conclusionOf(run)
    if (c === 'success') return { lastGreen: run, firstRed }
    if (c === 'failure') firstRed = run
    absent = c == null ? absent + 1 : 0
    if (absent >= ABSENT_RUNS_END) return { lastGreen: null, firstRed, isNew: true }
  }
  return { lastGreen: null, firstRed }
}

const TEST_FILE = /((?:tests|web\/src|packages)\/[\w./@-]+\.(?:test|spec)\.[cm]?[jt]sx?)/
/** The test files a job's log reports failing: vitest's FAIL lines and Playwright's ✘ lines. */
export function failingTestsOf(log) {
  const out = new Set()
  for (const line of log.split('\n')) {
    if (!/\bFAIL\b|✘|\[(?:chromium|webkit)[^\]]*\].*›/.test(line) || /✓|passed/.test(line)) continue
    const m = line.match(TEST_FILE)
    if (m) out.add(m[1])
  }
  return [...out].sort()
}

const stem = (p) => p.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '')
/** The repo paths (without extension) a test file imports or mocks by a relative path. */
export function importStemsOf(testPath, content) {
  const out = new Set()
  for (const m of content.matchAll(/(?:from\s+|import\s*\(\s*|vi\.mock\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    out.add(stem(path.posix.normalize(path.posix.join(path.posix.dirname(testPath), m[1]))))
  }
  return out
}

/** Why a commit's files make it a suspect for a failing test, or null. */
export function suspectReason(files, testPath, stems) {
  for (const f of files) {
    if (f === testPath) return `changed ${f}`
    if (stems.has(stem(f))) return `changed ${f}, which ${path.posix.basename(testPath)} imports`
  }
  return null
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
    const { lastGreen, firstRed, isNew } = redRange(older, (run) => jobsOf(repo, run.id).find((j) => j.name === job.name)?.conclusion ?? null)
    let commits = []
    let failingTests = []
    try { failingTests = failingTestsOf(ghText(`repos/${repo}/actions/jobs/${job.id}/logs`)) } catch { /* log expired or unreadable */ }
    if (lastGreen && firstRed) {
      const cmp = gh(`repos/${repo}/compare/${lastGreen.head_sha}...${firstRed.head_sha}`)
      const tests = failingTests.map((t) => {
        let content = ''
        try { content = Buffer.from(gh(`repos/${repo}/contents/${t}?ref=${firstRed.head_sha}`).content ?? '', 'base64').toString('utf8') } catch { /* deleted since */ }
        return { t, stems: importStemsOf(t, content) }
      })
      commits = (cmp.commits ?? []).map((c) => {
        const subject = c.commit.message.split('\n')[0]
        let suspect = null
        if (tests.length) {
          const files = (gh(`repos/${repo}/commits/${c.sha}`).files ?? []).map((f) => f.filename)
          for (const { t, stems } of tests) suspect ??= suspectReason(files, t, stems)
        }
        return { sha: c.sha.slice(0, 9), subject, owner: owners[subject] ?? null, suspect }
      })
      commits.sort((a, b) => Number(Boolean(b.suspect)) - Number(Boolean(a.suspect)))
    }
    report.jobs.push({
      job: job.name,
      failingTests,
      failures: annotations(repo, job.id),
      lastGreen: lastGreen && { id: lastGreen.id, sha: lastGreen.head_sha.slice(0, 9), at: lastGreen.created_at },
      firstRed: firstRed && { id: firstRed.id, sha: firstRed.head_sha.slice(0, 9), at: firstRed.created_at },
      isNew: Boolean(isNew),
      commits,
    })
  }
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(report, null, 2))
  console.log(`CI run ${target.id} on main (${target.head_sha.slice(0, 9)}, ${target.created_at}): ${failed.length} failing job(s)`)
  for (const j of report.jobs) {
    console.log(`\n${j.job}: ${j.firstRed ? `red since run ${j.firstRed.id} (${j.firstRed.at})` : 'red'}${j.lastGreen ? `, last green run ${j.lastGreen.id} (${j.lastGreen.at})` : j.isNew ? ', a new job, never green yet' : `, never green in the last ${MAX_RUNS} runs`}`)
    for (const t of j.failingTests.slice(0, 10)) console.log(`  failing: ${t}`)
    for (const f of j.failures.slice(0, 5)) console.log(`  failure: ${f}`)
    for (const c of j.commits) console.log(`  ${c.suspect ? 'SUSPECT ' : ''}${c.sha} ${c.subject}${c.owner ? `  [${c.owner}]` : ''}${c.suspect ? `  (${c.suspect})` : ''}`)
  }
}

if (import.meta.main) main()
