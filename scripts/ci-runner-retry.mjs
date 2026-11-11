#!/usr/bin/env bun
/**
 * Runs again a required CI leg that GitHub never gave a machine.
 *
 * 2026-11-10, CI run 42851742614: "Release rehearsal, live update (macos-26)" waited 21 minutes for
 * a macOS runner, GitHub gave up ("The job was not acquired by Runner of type hosted even after
 * multiple attempts", with a note on macOS arm64 capacity) and cancelled it with no step run, and
 * CI OK went red on a commit nothing had tested. Such a leg says nothing about the commit, so after a
 * push run on main whose CI OK failed only on legs like that, this asks GitHub to run them again
 * (the job and CI OK, which needs it), at most twice per run. A leg that ran and failed, or a red
 * report-only job, is left alone: the commit stays red and the release watch reads why.
 *
 * The Binary matrix has no gate job: every row is required (scripts/ci-gate.mjs), so a failed push
 * run there whose only bad rows never ran is run again the same way (2026-11-11, run 43036597217:
 * macos-15 waited 21 minutes for a runner and was cancelled).
 *
 *   bun scripts/ci-runner-retry.mjs <run id> <run attempt> [<workflow name>]   (GH_TOKEN, GH_REPO from the workflow)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const GATE_JOB = 'CI OK'
/** The workflows this runs again, and how each says which legs are required. */
export const WORKFLOWS = { CI: 'ci.yml', 'Binary matrix': 'every' }
/** A run's attempts this may start: the first run and two more. */
export const MAX_ATTEMPT = 3

/**
 * The names of the legs CI OK needs, as patterns, read from ci.yml: each job in its `needs`, by
 * its `name:` (a matrix expression in it matches any value) or its key, with the " (values)" GitHub
 * adds to a matrix leg whose name has no expression.
 */
export function requiredLegPatterns(ciYml) {
  const lines = ciYml.split('\n')
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  const blocks = new Map()
  let key = null
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (m) { key = m[1]; blocks.set(key, []); continue }
    if (key) blocks.get(key).push(line)
  }
  const field = (k, f) => {
    for (const l of blocks.get(k) ?? []) {
      const m = new RegExp(`^ {4}${f}:\\s*(.+?)\\s*$`).exec(l)
      if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2')
    }
    return null
  }
  const gateKey = [...blocks.keys()].find((k) => field(k, 'name') === GATE_JOB)
  const needs = field(gateKey, 'needs')
  if (!needs) throw new Error(`ci.yml: no job named ${GATE_JOB} with a needs list`)
  return needs.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean).map((k) => {
    const name = field(k, 'name') ?? k
    const parts = name.split(/\$\{\{.*?\}\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return new RegExp(`^${parts.join('.+')}( \\(.+\\))?$`)
  })
}

/** GitHub cancelled the leg before any machine ran it: no runner, no step that ran. */
export function neverRan(job) {
  return job.conclusion === 'cancelled' && !job.runner_name &&
    (job.steps ?? []).every((s) => s.conclusion !== 'success' && s.conclusion !== 'failure')
}

/**
 * What to do about one finished run, from its jobs (the latest attempt) and the required patterns:
 * `none`, `job` (run these again, one at a time is all GitHub takes: the first) or `failed` (several
 * legs never ran: run every failed or cancelled job again).
 */
export function planRetry(jobs, patterns, attempt, { gated = true } = {}) {
  if (gated) {
    const gate = jobs.find((j) => j.name === GATE_JOB)
    if (!gate || gate.conclusion !== 'failure') return { action: 'none', why: `${GATE_JOB} is ${gate?.conclusion ?? 'missing'}` }
  }
  if (attempt >= MAX_ATTEMPT) return { action: 'none', why: `attempt ${attempt} is the last this runs` }
  const required = jobs.filter((j) => j.name !== GATE_JOB && patterns.some((p) => p.test(j.name)))
  const bad = required.filter((j) => j.conclusion !== 'success' && j.conclusion !== 'skipped')
  if (!bad.length) return { action: 'none', why: 'no required leg failed' }
  const ran = bad.filter((j) => !neverRan(j))
  if (ran.length) return { action: 'none', why: `a required leg ran and did not pass: ${ran.map((j) => j.name).join(', ')}` }
  const names = bad.map((j) => j.name)
  return bad.length === 1
    ? { action: 'job', ids: [bad[0].id], names, why: 'one required leg never got a runner' }
    : { action: 'failed', names, why: 'required legs never got a runner' }
}

/** GitHub's own trouble (2026-11-11, run 43089327630: a 502 during an Actions outage ended the job). */
export const RETRYABLE = /HTTP (5\d\d|429)|Server Error|timed out|ECONNRESET|ETIMEDOUT/i

/**
 * Runs one gh call, again after GitHub's own errors (5xx, 429, a dropped connection), up to `tries`
 * times with a growing wait. Any other error is thrown at once. A rerun POST whose first answer was
 * lost may have worked, so its later refusal is taken as done.
 */
export function ghRetry(run, args, { tries = 4, waitMs = 5000, sleep = sleepSync } = {}) {
  let lost = false
  for (let i = 1; ; i++) {
    try {
      return run(args)
    } catch (err) {
      const text = `${err?.message ?? ''} ${err?.stdout ?? ''} ${err?.stderr ?? ''}`
      if (lost && args.includes('POST') && !RETRYABLE.test(text)) {
        console.log(`The rerun's first answer was lost and GitHub now refuses it (${text.trim().slice(0, 200)}): taking it as done.`)
        return ''
      }
      if (!RETRYABLE.test(text) || i >= tries) throw err
      lost = true
      console.log(`gh ${args.join(' ')}: GitHub answered an error of its own (try ${i} of ${tries}); trying again in ${(waitMs * i) / 1000} s`)
      sleep(waitMs * i)
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function gh(args) {
  return ghRetry((a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), args)
}

function main() {
  const [runId, attemptArg, workflow = 'CI'] = process.argv.slice(2)
  const attempt = Number(attemptArg)
  if (!runId || !Number.isFinite(attempt)) throw new Error('usage: ci-runner-retry.mjs <run id> <run attempt> [<workflow name>]')
  const kind = WORKFLOWS[workflow]
  if (!kind) { console.log(`Nothing to run again: ${workflow} is not a workflow this runs again.`); return }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const patterns = kind === 'every' ? [/^/] : requiredLegPatterns(fs.readFileSync(path.join(root, '.github/workflows', kind), 'utf8'))
  const jobs = JSON.parse(gh(['api', `repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`])).jobs
  const plan = planRetry(jobs, patterns, attempt, { gated: kind !== 'every' })
  if (plan.action === 'none') { console.log(`Nothing to run again: ${plan.why}.`); return }
  console.log(`::notice::${plan.why}: ${plan.names.join(', ')}. Running ${plan.action === 'job' ? 'it' : 'the failed jobs'} again.`)
  if (plan.action === 'job') gh(['api', '-X', 'POST', `repos/{owner}/{repo}/actions/jobs/${plan.ids[0]}/rerun`])
  else gh(['api', '-X', 'POST', `repos/{owner}/{repo}/actions/runs/${runId}/rerun-failed-jobs`])
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
