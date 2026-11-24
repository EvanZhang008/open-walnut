/**
 * Every job of one workflow run, page by page: GitHub lists at most 100 a page. CI's run holds
 * about 80 since it calls the binary matrix (2026-11-24), so a reader of the first page alone
 * would lose CI OK or a matrix row, and judge the run without it, the day the run passes 100.
 * Read by scripts/ci-gate.mjs, scripts/ci-runner-retry.mjs and scripts/lib/release-in-flight.mjs.
 *
 * `page(n)` answers `jobsPage(runId, n)` (GitHub's `actions/runs/<id>/jobs`) as parsed JSON.
 */
export const JOBS_PER_PAGE = 100
/** A bound, so an answer that never runs short cannot loop: ten pages are 1000 jobs. */
const MAX_PAGES = 10

export const jobsPage = (runId, n) => `repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=${JOBS_PER_PAGE}&page=${n}`

export function allJobs(page) {
  const jobs = []
  for (let n = 1; n <= MAX_PAGES; n++) {
    const { jobs: got = [], total_count: total } = page(n) ?? {}
    jobs.push(...got)
    if (got.length < JOBS_PER_PAGE || (Number.isFinite(total) && jobs.length >= total)) break
  }
  return jobs
}
