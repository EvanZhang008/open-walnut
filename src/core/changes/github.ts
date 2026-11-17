/**
 * Walnut's own change provider: GitHub pull requests (`pr:`) and commits (`commit:`), read with the
 * same gh as the pull request watch (pull-requests/providers.ts: the user's sign-in, WALNUT_GH_BIN
 * for a test's stand-in).
 *
 *   review  from the pull request watch's snapshot when the task has one (Task.pr_status, so no
 *           second GraphQL read), else from one `repos/{o}/{r}/pulls/{n}` read.
 *   deploy  for a merged pull request's merge commit, or a commit link's commit: its GitHub
 *           deployments, one stage per environment from each one's latest status; with none, one
 *           `CI` stage from the commit's check runs. Done when every stage is.
 */

import { linkLabel } from '../link-tags.js'
import { GITHUB_PR_URL_RE, oneLine, type PrSnapshot } from '../pull-requests/model.js'
import { ghBinary, ghEnv, ghFailure, realGhExec, type ExecFn } from '../pull-requests/providers.js'
import { MAX_CHANGE_STAGES, type ChangeDeploy, type ChangeErrorCode, type ChangeLink, type ChangeReview, type ChangeSnapshot, type ChangeStage, type ChangeStageDetail, type ChangeStageStatus } from './model.js'
import { listChangeProviders, registerChangeProvider, type ChangeProviderSpec, type ChangeReadResult } from './registry.js'

export const GITHUB_CHANGE_PROVIDER_ID = 'github'
const GITHUB_COMMIT_URL_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})$/i
const GH_CALL_MS = 30_000
/** Check runs counted as still to come this long after a merge, before "no checks" settles it. */
const CHECKS_GRACE_MS = 15 * 60_000
const CACHE_MAX = 500
/** Environments read per commit, the newest first: each costs one status call. */
const MAX_ENVIRONMENTS = 10

/** The core watcher hands a GitHub link the pull request watch's snapshot of it, when the task has one. */
export type GithubChangeLink = ChangeLink & { prev?: ChangeSnapshot; pr?: PrSnapshot }

type Ref = { owner: string; repo: string } & ({ kind: 'pr'; number: number } | { kind: 'commit'; sha: string })

function refOf(url: string): Ref | null {
  const pr = GITHUB_PR_URL_RE.exec(url)
  if (pr) return { kind: 'pr', owner: pr[1]!, repo: pr[2]!, number: Number(pr[3]) }
  const c = GITHUB_COMMIT_URL_RE.exec(url)
  return c ? { kind: 'commit', owner: c[1]!, repo: c[2]!, sha: c[3]!.toLowerCase() } : null
}

class GhError extends Error {
  constructor(readonly code: ChangeErrorCode, message: string) { super(message) }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** The review part from the pull request watch's snapshot. */
export function reviewOfPrSnapshot(pr: PrSnapshot): ChangeReview {
  const state = pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft'
    : pr.review === 'approved' ? 'approved' : pr.review === 'changes_requested' ? 'changes_requested' : 'open'
  return {
    state,
    checks: { passed: pr.checks.passed, failed: pr.checks.failed, pending: pr.checks.pending },
    ...(state === 'open' && pr.review === 'review_required' ? { waitingOn: 'review required' } : {}),
  }
}

function deployStatus(state: unknown): ChangeStageStatus {
  switch (state) {
    case 'success': case 'inactive': return 'done'
    case 'in_progress': case 'queued': case 'pending': return 'running'
    case 'failure': case 'error': return 'failed'
    default: return 'pending'
  }
}

const RUN_FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'])

function runStatus(run: Record<string, unknown>): ChangeStageStatus {
  if (run.status !== 'completed') return 'running'
  return RUN_FAILED.has(String(run.conclusion ?? '')) ? 'failed' : 'done'
}

export function createGithubChangeProvider(exec: ExecFn = realGhExec, now: () => number = Date.now): ChangeProviderSpec {
  /** A pull request's merge commit, and a short commit's full hash: neither changes once known. */
  const shas = new Map<string, string>()
  const remember = (key: string, sha: string) => {
    if (shas.size >= CACHE_MAX) shas.delete(shas.keys().next().value!)
    shas.set(key, sha)
  }

  async function gh(path: string, signal: AbortSignal): Promise<any> {
    if (signal.aborted) throw new GhError('unreachable', 'timed out')
    const r = await exec(ghBinary(), ['api', path], { timeoutMs: GH_CALL_MS, env: ghEnv(), signal })
    if (r.code === 0) {
      try { return JSON.parse(r.stdout) } catch { throw new GhError('failed', `gh api ${path}: not JSON`) }
    }
    if (/HTTP 404|Not Found/i.test(`${r.stderr}\n${r.stdout}`)) throw new GhError('not-found', 'not found on GitHub')
    const fail = ghFailure(r)
    throw new GhError(fail.code === 'signed-out' ? 'signed-out' : 'failed', fail.message)
  }

  /** The commit a link's deploy follows, with what the pull request said (null: not merged yet). */
  async function commitOf(ref: Ref, url: string, signal: AbortSignal): Promise<string | null> {
    if (ref.kind === 'commit') {
      if (ref.sha.length === 40) return ref.sha
      const known = shas.get(url)
      if (known) return known
      const full = str((await gh(`repos/${ref.owner}/${ref.repo}/commits/${ref.sha}`, signal))?.sha)
      if (full) remember(url, full)
      return full ?? ref.sha
    }
    const known = shas.get(url)
    if (known) return known
    const pr = await gh(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, signal)
    const sha = pr?.merged === true ? str(pr.merge_commit_sha) : undefined
    if (sha) remember(url, sha)
    return sha ?? null
  }

  async function readDeploy(ref: Ref, sha: string, mergedAt: string | undefined, signal: AbortSignal): Promise<ChangeDeploy> {
    const base = `repos/${ref.owner}/${ref.repo}`
    const list: Array<Record<string, any>> = await gh(`${base}/deployments?sha=${sha}&per_page=100`, signal)
    const commit = sha.slice(0, 7)
    if (Array.isArray(list) && list.length) {
      // GitHub lists the newest first: the newest per environment, at most MAX_ENVIRONMENTS of the
      // most recently deployed, shown in the order they began.
      const newest = new Map<string, Record<string, any>>()
      for (const d of list) { const env = str(d.environment) ?? 'deployment'; if (!newest.has(env)) newest.set(env, d) }
      const ordered = [...newest.entries()].slice(0, Math.min(MAX_ENVIRONMENTS, MAX_CHANGE_STAGES)).reverse()
      const stages: ChangeStage[] = []
      for (const [env, d] of ordered) {
        const statuses = await gh(`${base}/deployments/${d.id}/statuses?per_page=1`, signal)
        const s = Array.isArray(statuses) ? statuses[0] : undefined
        const note = s?.description ? oneLine(String(s.description), 120) : ''
        stages.push({
          name: env, status: deployStatus(s?.state),
          ...(str(s?.created_at) ? { at: s.created_at } : {}),
          ...(note ? { note } : {}),
          ...(d.production_environment === true || /prod/i.test(env) ? { prod: true } : {}),
        })
      }
      return finish({ pipeline: 'GitHub deployments', url: `https://github.com/${ref.owner}/${ref.repo}/deployments`, commit, stages })
    }
    const runs: Array<Record<string, unknown>> = (await gh(`${base}/commits/${sha}/check-runs?per_page=100`, signal))?.check_runs ?? []
    const counts = { done: 0, failed: 0, running: 0 }
    for (const run of runs) counts[runStatus(run) as 'done' | 'failed' | 'running']++
    const merged = mergedAt ? Date.parse(mergedAt) : NaN
    const early = runs.length === 0 && Number.isFinite(merged) && now() - merged < CHECKS_GRACE_MS
    const status: ChangeStageStatus = counts.failed ? 'failed' : counts.running || early ? 'running' : 'done'
    const note = runs.length === 0 ? (early ? 'No checks yet' : 'No checks')
      : [`${counts.done} passed`, counts.failed ? `${counts.failed} failed` : '', counts.running ? `${counts.running} running` : ''].filter(Boolean).join(', ')
    return finish({ pipeline: 'GitHub checks', url: `https://github.com/${ref.owner}/${ref.repo}/commit/${sha}`, commit, stages: [{ name: 'CI', status, note }] })
  }

  async function readOne(link: GithubChangeLink, signal: AbortSignal): Promise<ChangeReadResult> {
    const ref = refOf(link.url)
    if (!ref) return { ok: false, code: 'not-found', message: 'not a GitHub pull request or commit' }
    const label = linkLabel(link.url)
    try {
      if (ref.kind === 'commit') {
        const sha = (await commitOf(ref, link.url, signal))!
        return { ok: true, snapshot: { label, deploy: await readDeploy(ref, sha, undefined, signal) } }
      }
      let review: ChangeReview
      let title: string | undefined
      let mergedAt: string | undefined
      const pr = link.pr
      if (pr?.checkedAt && !pr.error) {
        review = reviewOfPrSnapshot(pr)
        title = pr.title
        mergedAt = pr.mergedAt
      } else {
        const rest = await gh(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, signal)
        const merged = rest?.merged === true
        if (merged && str(rest.merge_commit_sha)) remember(link.url, rest.merge_commit_sha)
        review = { state: merged ? 'merged' : rest?.state === 'closed' ? 'closed' : rest?.draft === true ? 'draft' : 'open' }
        title = str(rest?.title)
        mergedAt = str(rest?.merged_at)
      }
      const sha = review.state === 'merged' ? await commitOf(ref, link.url, signal) : null
      const deploy = sha ? await readDeploy(ref, sha, mergedAt, signal) : undefined
      return { ok: true, snapshot: { label, ...(title ? { title } : {}), review, ...(deploy ? { deploy } : {}) } }
    } catch (err) {
      if (err instanceof GhError) return { ok: false, code: err.code, message: err.message }
      return { ok: false, code: 'failed', message: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    id: GITHUB_CHANGE_PROVIDER_ID,
    handles: (link) => refOf(link.url) !== null,
    async read(links, ctx) {
      const out = new Map<string, ChangeReadResult>()
      // One link at a time: each is a few small calls, and gh is one process per call.
      for (const link of links as ReadonlyArray<GithubChangeLink>) {
        if (ctx.signal.aborted) break
        out.set(link.url, await readOne(link, ctx.signal))
      }
      return out
    },
    async stageDetail(link, stage, ctx): Promise<ChangeStageDetail | null> {
      const ref = refOf(link.url)
      if (!ref) return null
      const sha = await commitOf(ref, link.url, ctx.signal)
      if (!sha) return null
      const base = `repos/${ref.owner}/${ref.repo}`
      if (stage === 'CI') {
        const runs: Array<Record<string, unknown>> = (await gh(`${base}/commits/${sha}/check-runs?per_page=100`, ctx.signal))?.check_runs ?? []
        return {
          stage,
          steps: runs.map((run) => ({ name: str(run.name) ?? 'check', status: runStatus(run), ...(str(run.html_url) ? { url: run.html_url as string } : {}) })),
          blockers: [],
          url: `https://github.com/${ref.owner}/${ref.repo}/commit/${sha}`,
        }
      }
      const list = await gh(`${base}/deployments?sha=${sha}&environment=${encodeURIComponent(stage)}&per_page=1`, ctx.signal)
      const d = Array.isArray(list) ? list[0] : undefined
      if (!d) return null
      const statuses: Array<Record<string, any>> = await gh(`${base}/deployments/${d.id}/statuses?per_page=10`, ctx.signal)
      return {
        stage,
        steps: (Array.isArray(statuses) ? statuses : []).reverse().map((s) => ({
          name: str(s.description) ? oneLine(s.description, 120) : String(s.state ?? 'status'),
          status: deployStatus(s.state),
          ...(str(s.created_at) ? { note: s.created_at } : {}),
          ...(str(s.log_url) ?? str(s.target_url) ? { url: (str(s.log_url) ?? str(s.target_url))! } : {}),
        })),
        blockers: [],
        url: `https://github.com/${ref.owner}/${ref.repo}/deployments`,
      }
    },
  }
}

function finish(d: Omit<ChangeDeploy, 'done' | 'last' | 'next'>): ChangeDeploy {
  const last = [...d.stages].reverse().find((s) => s.status === 'done')?.name
  const next = d.stages.find((s) => s.status !== 'done')?.name
  return { ...d, ...(last ? { last } : {}), ...(next ? { next } : {}), done: d.stages.length > 0 && d.stages.every((s) => s.status === 'done') }
}

/** Register Walnut's own providers once (owner `core`); again after a test cleared the registry. */
export function ensureCoreChangeProviders(): void {
  if (listChangeProviders().some((p) => p.owner === 'core' && p.id === GITHUB_CHANGE_PROVIDER_ID)) return
  registerChangeProvider('core', createGithubChangeProvider())
}
