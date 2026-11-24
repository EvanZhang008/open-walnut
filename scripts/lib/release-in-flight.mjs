/**
 * An older Release run still on its way to publishing what this run would publish, or null.
 * Every CI run that ends on main starts a Release run (release.yml), and a build, its matrix
 * and the publish take half an hour on a free queue and hours on a long one, so a newer run
 * planned the same release while the first was still on its way and built it all again
 * (2026-11-18, the stable: run 44352216275 planned 0.6.35 while 44349409517 published it;
 * 2026-11-23, the nightly once its pick moved to Linux and answered at once). Only an OLDER
 * run counts, so two runs never wait for each other; when that run fails, the next one plans
 * again. A run one of whose legs already failed can never publish, though it stays in
 * progress while its other legs wait for a runner, so it does not count.
 *
 * `shape.build` matches the build job's name, `shape.needs` the legs the publish needs.
 */
import { allJobs, jobsPage } from './run-jobs.mjs'

export const BROKEN = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure'])

export function releaseInFlight(runs, jobsOf, selfRunId, shape) {
  for (const run of runs) {
    if (run.status === 'completed' || !(Number(run.id) < Number(selfRunId))) continue
    const jobs = jobsOf(run.id)
    const build = jobs.find((j) => shape.build.test(j.name ?? ''))
    if (!build || (build.status === 'completed' && build.conclusion !== 'success')) continue
    if (jobs.some((j) => shape.needs.test(j.name ?? '') && BROKEN.has(j.conclusion))) continue
    return run.html_url ?? String(run.id)
  }
  return null
}

/** The Release runs not yet finished, newest first as GitHub lists them, through `gh`. */
export function releaseRunsInFlight(gh) {
  return ['in_progress', 'queued'].flatMap((status) =>
    gh(`repos/{owner}/{repo}/actions/workflows/release.yml/runs?status=${status}&per_page=20`).workflow_runs ?? [])
}

/** `releaseInFlight` asked of GitHub for this workflow run; null outside one (a person trying it). */
export function releaseInFlightNow(gh, shape, selfRunId = process.env.GITHUB_RUN_ID) {
  if (!selfRunId) return null
  return releaseInFlight(releaseRunsInFlight(gh), (id) => allJobs((n) => gh(jobsPage(id, n))), selfRunId, shape)
}
