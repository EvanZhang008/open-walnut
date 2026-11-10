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
 *   bun scripts/ci-runner-retry.mjs <run id> <run attempt>   (GH_TOKEN, GH_REPO from the workflow)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const GATE_JOB = 'CI OK'
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
export function planRetry(jobs, patterns, attempt) {
  const gate = jobs.find((j) => j.name === GATE_JOB)
  if (!gate || gate.conclusion !== 'failure') return { action: 'none', why: `${GATE_JOB} is ${gate?.conclusion ?? 'missing'}` }
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

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function main() {
  const [runId, attemptArg] = process.argv.slice(2)
  const attempt = Number(attemptArg)
  if (!runId || !Number.isFinite(attempt)) throw new Error('usage: ci-runner-retry.mjs <run id> <run attempt>')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const patterns = requiredLegPatterns(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'))
  const jobs = JSON.parse(gh(['api', `repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`])).jobs
  const plan = planRetry(jobs, patterns, attempt)
  if (plan.action === 'none') { console.log(`Nothing to run again: ${plan.why}.`); return }
  console.log(`::notice::${plan.why}: ${plan.names.join(', ')}. Running ${plan.action === 'job' ? 'it' : 'the failed jobs'} again.`)
  if (plan.action === 'job') gh(['api', '-X', 'POST', `repos/{owner}/{repo}/actions/jobs/${plan.ids[0]}/rerun`])
  else gh(['api', '-X', 'POST', `repos/{owner}/{repo}/actions/runs/${runId}/rerun-failed-jobs`])
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
