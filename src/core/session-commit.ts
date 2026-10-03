/**
 * Session commit, the server half: commit / push / open a PR for ONE session's
 * changes from the Changed tab.
 *
 * The work is host-local and lives in the session host's daemon
 * (git-commit-core.ts, capability 'git-commit-v1'): it reads the repo, splits
 * the files into hunks, attributes each hunk to this session or someone else
 * (git-attribution-core.ts), and builds the commit in a private index. The
 * server only relays:
 *
 *   plan     one RPC with a deadline; the browser gets the repos and hunks.
 *   jobs     a commit/push/PR is a job: the route answers at once with the job,
 *            this module starts it on the daemon and polls it, and every change
 *            reaches the browser as a `git-commit:job` WS event (plus GET for the
 *            job, which answers from memory and never touches the daemon). Hooks
 *            can run for minutes, so nothing pins a browser connection.
 *   suggest  a short commit message from Walnut's fast model, for the diff the
 *            user selected and the session's title.
 */

import { log } from '../logging/index.js'

export const GIT_COMMIT_CAPABILITY = 'git-commit-v1'
const PLAN_RPC_MS = 90_000
const START_RPC_MS = 30_000
const POLL_RPC_MS = 10_000
const POLL_INTERVAL_MS = 700
/** A job whose daemon has not answered a poll for this long is given up on. */
const LOST_AFTER_MS = 15 * 60_000
const JOB_TTL_MS = 60 * 60_000
const SUGGEST_DIFF_MAX = 20_000

export class SessionCommitError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
  }
}

export type CommitAction = 'commit' | 'push' | 'pr'

export interface ServerCommitJob {
  id: string
  sessionId: string
  action: CommitAction
  /** The session's host (null = this machine). */
  host: string | null
  repoRoot: string
  state: 'running' | 'succeeded' | 'failed'
  step: string
  output: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

interface Conn {
  hasCapability(cap: string): boolean
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

interface SessionInfo { cwd?: string; host?: string; title?: string; taskId?: string; outputFile?: string }

export interface SessionCommitDeps {
  sessionById(sessionId: string): Promise<SessionInfo | null>
  /** A connected daemon for the host that speaks git-commit-v1. Throws SessionCommitError. */
  connection(host: string | undefined): Promise<Conn>
  /** Repo roots the session touched, computed server-side (daemons without changes-v1). */
  repoRootsFor(sessionId: string, info: SessionInfo): Promise<string[]>
  publish(job: ServerCommitJob): void
  now(): number
  sleep(ms: number): Promise<void>
  taskTitle(taskId: string): Promise<string | null>
  askModel(system: string, prompt: string): Promise<string | null>
}

const jobs = new Map<string, ServerCommitJob>()

function hostDisplay(host: string | undefined): string {
  return host && host !== '__local__' ? host : 'this Mac'
}

const realDeps: SessionCommitDeps = {
  async sessionById(sessionId) {
    const { getSessionByClaudeId } = await import('./session-tracker.js')
    const r = await getSessionByClaudeId(sessionId)
    return r ? { cwd: r.cwd, host: r.host, title: r.title, taskId: r.taskId, outputFile: r.outputFile } : null
  },
  async connection(host) {
    const dc = await import('../providers/daemon-connection.js')
    const key = host ?? '__local__'
    const pick = () => (dc.listConnectedDaemonsByHost().get(key) ?? [])
    let conns: Array<{ hasCapability(cap: string): boolean }> = pick()
    if (conns.length === 0) {
      // Nobody dialed this host yet: dial it, with a deadline (the route's own
      // deadline sits above this one).
      // The local daemon needs no SSH target (getDaemonConnection's __local__ branch).
      let target: { hostname: string; user?: string; port?: number } | null = null
      if (key === '__local__') {
        target = { hostname: '__local__' }
      } else {
        const { getConfig } = await import('./config-manager.js')
        const hostDef = (await getConfig()).hosts?.[key]
        const hostname = hostDef?.hostname ?? ((hostDef as Record<string, unknown> | undefined)?.ssh as string | undefined)
        if (hostDef && hostname) target = { hostname, user: hostDef.user, port: hostDef.port }
      }
      if (target) {
        let timer: NodeJS.Timeout | undefined
        const dial = dc.getDaemonConnection(key, target)
        dial.catch(() => { /* the pool caches the failure */ })
        try {
          const conn = await Promise.race([
            dial,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dial timeout')), 20_000) }),
          ])
          conns = pick()
          if (conns.length === 0 && conn.connected) conns = [conn]
        } catch { /* reported below */ } finally { clearTimeout(timer) }
      }
    }
    if (conns.length === 0) throw new SessionCommitError(`Walnut is not connected to ${hostDisplay(host)} right now.`, 503, 'host-offline')
    const able = conns.find((c) => c.hasCapability(GIT_COMMIT_CAPABILITY))
    if (!able) throw new SessionCommitError(`The Walnut daemon on ${hostDisplay(host)} needs an update before it can commit.`, 409, 'daemon-upgrade')
    return able as unknown as Conn
  },
  async repoRootsFor(sessionId, info) {
    const { computeSessionChanges } = await import('./session-changes.js')
    const res = await computeSessionChanges(sessionId, info.cwd, info.host, info.outputFile)
    return res.groups.map((g) => g.repoRoot)
  },
  publish(job) {
    void import('./event-bus.js').then(({ bus }) => {
      // Not in the 'session:' family on purpose: hook dispatch listens there.
      bus.emit('git-commit:job', { sessionId: job.sessionId, job }, ['web-ui'])
    })
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async taskTitle(taskId) {
    try {
      const { getTask } = await import('./task-manager.js')
      return (await getTask(taskId))?.title ?? null
    } catch { return null }
  },
  async askModel(system, prompt) {
    const { sendMessage } = await import('../model/model.js')
    const { getConfig } = await import('./config-manager.js')
    const { fastModelFor } = await import('./cheap-model.js')
    const { titleBudgetMs } = await import('./session-title-backend.js')
    const config = await getConfig()
    const model = fastModelFor(config)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), await titleBudgetMs(config))
    try {
      const result = await sendMessage({
        system,
        messages: [{ role: 'user', content: prompt }],
        config: { maxTokens: 400, ...(model ? { model } : {}) },
        signal: controller.signal,
      })
      if (result.aborted) return null
      return (result.content ?? [])
        .map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : ''))
        .join('')
        .trim() || null
    } finally {
      clearTimeout(timer)
    }
  },
}

let deps: SessionCommitDeps = realDeps

/** Test-only: swap the session store, daemon pool and model for fakes. */
export function __setSessionCommitDepsForTesting(next: Partial<SessionCommitDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps
  if (!next) jobs.clear()
}

async function sessionOrThrow(sessionId: string): Promise<SessionInfo> {
  const info = await deps.sessionById(sessionId)
  if (!info) throw new SessionCommitError('Session not found', 404, 'not-found')
  return info
}

function rpcError(res: Record<string, unknown>, fallback: string): string {
  const raw = typeof res.error === 'string' ? res.error : fallback
  // The daemon prefixes its command name; the user does not need it.
  return raw.replace(/^git\.commit(Plan|Start) failed: /, '')
}

/** The commit view's data for one session: every repo it touched, files and hunks. */
export async function getSessionCommitPlan(sessionId: string): Promise<Record<string, unknown>> {
  const info = await sessionOrThrow(sessionId)
  const conn = await deps.connection(info.host)
  // A daemon that cannot read the session's ops (no changes-v1) still lists the
  // repos the server found, unattributed.
  const repoRoots = conn.hasCapability('changes-v1') ? [] : await deps.repoRootsFor(sessionId, info).catch(() => [])
  const res = await conn.send('git.commitPlan', {
    sid: sessionId, ...(info.cwd ? { cwd: info.cwd } : {}), repoRoots,
  }, PLAN_RPC_MS)
  if (!res.ok) throw new SessionCommitError(rpcError(res, 'Could not read the repositories'), 502, 'plan-failed')
  return { sessionId, host: info.host ?? null, attributed: res.attributed === true, repos: Array.isArray(res.repos) ? res.repos : [] }
}

function prune(): void {
  const cutoff = deps.now() - JOB_TTL_MS
  for (const [id, j] of jobs) if (j.state !== 'running' && (j.finishedAt ?? 0) < cutoff) jobs.delete(id)
}

function finish(job: ServerCommitJob, patch: Partial<ServerCommitJob>): void {
  Object.assign(job, patch)
  job.finishedAt = deps.now()
  job.updatedAt = job.finishedAt
  deps.publish({ ...job })
}

/** Copy a daemon job snapshot into the server job; publish only when it changed. */
function apply(job: ServerCommitJob, snap: Record<string, unknown>): void {
  const before = JSON.stringify([job.state, job.step, job.output, job.result, job.error])
  if (typeof snap.step === 'string') job.step = snap.step
  if (typeof snap.output === 'string') job.output = snap.output
  if (snap.result && typeof snap.result === 'object') job.result = snap.result as Record<string, unknown>
  if (snap.error && typeof snap.error === 'object') job.error = snap.error as ServerCommitJob['error']
  if (snap.state === 'succeeded' || snap.state === 'failed') {
    job.state = snap.state
    job.finishedAt = deps.now()
  }
  if (JSON.stringify([job.state, job.step, job.output, job.result, job.error]) !== before) {
    job.updatedAt = deps.now()
    deps.publish({ ...job })
  }
}

async function runJob(job: ServerCommitJob, info: SessionInfo, payload: Record<string, unknown>): Promise<void> {
  let conn: Conn
  let daemonJobId = ''
  try {
    conn = await deps.connection(info.host)
    const res = await conn.send('git.commitStart', payload, START_RPC_MS)
    if (!res.ok) {
      finish(job, { state: 'failed', error: { code: typeof res.code === 'string' ? res.code : 'start-failed', message: rpcError(res, 'Could not start') } })
      return
    }
    const snap = (res.job ?? {}) as Record<string, unknown>
    daemonJobId = typeof snap.id === 'string' ? snap.id : ''
    apply(job, snap)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    finish(job, { state: 'failed', error: { code: err instanceof SessionCommitError ? err.code : 'start-failed', message } })
    return
  }
  let lastAnswer = deps.now()
  while (job.state === 'running') {
    await deps.sleep(POLL_INTERVAL_MS)
    try {
      conn = await deps.connection(info.host)
      const res = await conn.send('git.commitJob', { jobId: daemonJobId }, POLL_RPC_MS)
      if (!res.ok) throw new Error(rpcError(res, 'poll failed'))
      if (!res.job) {
        finish(job, { state: 'failed', error: { code: 'lost', message: `The Walnut daemon on ${hostDisplay(info.host)} restarted while this ran. Check the repository before trying again: the ${job.action} may or may not have happened.` } })
        break
      }
      lastAnswer = deps.now()
      apply(job, res.job as Record<string, unknown>)
    } catch (err) {
      if (deps.now() - lastAnswer > LOST_AFTER_MS) {
        finish(job, { state: 'failed', error: { code: 'lost', message: `Lost contact with ${hostDisplay(info.host)} for ${Math.round(LOST_AFTER_MS / 60_000)} minutes. Check the repository before trying again.` } })
        break
      }
      log.session.debug('session-commit: job poll failed, retrying', {
        sessionId: job.sessionId, jobId: job.id, error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  log.session.info('session-commit: job finished', {
    sessionId: job.sessionId, jobId: job.id, action: job.action, repoRoot: job.repoRoot, state: job.state,
    code: job.error?.code, sha: typeof job.result?.sha === 'string' ? job.result.sha : undefined,
  })
  prune()
}

/** What the daemon job needs for each action; anything else in the body is dropped. */
function payloadFor(action: CommitAction, body: Record<string, unknown>, repoRoot: string): Record<string, unknown> {
  const base = { action, repoRoot, ...(typeof body.branch === 'string' ? { branch: body.branch } : {}) }
  if (action === 'commit') {
    return { ...base, message: body.message, selections: body.selections, expectedHead: typeof body.expectedHead === 'string' ? body.expectedHead : null }
  }
  if (action === 'push') return { ...base, setUpstream: body.setUpstream === true }
  return { ...base, title: body.title, body: typeof body.body === 'string' ? body.body : '', ...(typeof body.base === 'string' ? { base: body.base } : {}) }
}

/** Start a commit/push/PR job and answer at once; progress arrives as events. */
export async function startSessionCommitJob(sessionId: string, body: Record<string, unknown>): Promise<ServerCommitJob> {
  const action = body.action
  if (action !== 'commit' && action !== 'push' && action !== 'pr') throw new SessionCommitError('Unknown action', 400, 'bad-request')
  const repoRoot = typeof body.repoRoot === 'string' ? body.repoRoot : ''
  if (!repoRoot) throw new SessionCommitError('repoRoot is required', 400, 'bad-request')
  if (action === 'commit') {
    if (typeof body.message !== 'string' || !body.message.trim()) throw new SessionCommitError('Write a commit message first.', 400, 'empty-message')
    if (!Array.isArray(body.selections) || body.selections.length === 0) throw new SessionCommitError('Nothing selected.', 400, 'nothing-selected')
  }
  if (action === 'pr' && (typeof body.title !== 'string' || !body.title.trim())) throw new SessionCommitError('A pull request needs a title.', 400, 'bad-request')
  const info = await sessionOrThrow(sessionId)
  for (const j of jobs.values()) {
    if (j.state === 'running' && j.repoRoot === repoRoot && j.host === (info.host ?? null)) throw new SessionCommitError('Another commit or push is running in this repository.', 409, 'busy')
  }
  const t = deps.now()
  const job: ServerCommitJob = {
    id: 'scj-' + t.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    sessionId, action, host: info.host ?? null, repoRoot, state: 'running', step: 'starting', output: '', startedAt: t, updatedAt: t,
  }
  jobs.set(job.id, job)
  log.session.info('session-commit: job started', { sessionId, jobId: job.id, action, repoRoot, host: info.host ?? '__local__' })
  void runJob(job, info, payloadFor(action, body, repoRoot)).catch((err) => {
    finish(job, { state: 'failed', error: { code: 'failed', message: err instanceof Error ? err.message : String(err) } })
  })
  return { ...job }
}

/** A job's last known state, from memory (never a daemon call). */
export function getSessionCommitJob(sessionId: string, jobId: string): ServerCommitJob | null {
  const j = jobs.get(jobId)
  return j && j.sessionId === sessionId ? { ...j } : null
}

/** The running or recent jobs of one session (a reopened commit view picks them up). */
export function listSessionCommitJobs(sessionId: string): ServerCommitJob[] {
  return [...jobs.values()].filter((j) => j.sessionId === sessionId).map((j) => ({ ...j }))
}

/** Clean a model's answer into a commit message: no fences, no quotes, a short subject. */
export function cleanSuggestedMessage(answer: string): string | null {
  let text = String(answer || '').trim()
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').trim()
  text = text.replace(/^(commit message|message)\s*:\s*/i, '').trim()
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim()
  if (!text) return null
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''))
  const subject = lines[0].replace(/^[#*\s]+/, '').replace(/^["'`]+|["'`]+$/g, '').trim()
  if (!subject) return null
  const body = lines.slice(1).join('\n').replace(/^\n+/, '').trim()
  return body ? `${subject}\n\n${body.split('\n').slice(0, 12).join('\n')}` : subject
}

/** A short commit message for the selected diff, from Walnut's fast model. */
export async function suggestSessionCommitMessage(sessionId: string, body: Record<string, unknown>): Promise<{ message: string }> {
  const info = await sessionOrThrow(sessionId)
  const diff = typeof body.diff === 'string' ? body.diff : ''
  if (!diff.trim()) throw new SessionCommitError('Select some changes first.', 400, 'nothing-selected')
  const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === 'string').slice(0, 40) : []
  const taskTitle = info.taskId ? await deps.taskTitle(info.taskId) : null
  const clipped = diff.length > SUGGEST_DIFF_MAX ? diff.slice(0, SUGGEST_DIFF_MAX) + '\n[diff truncated]' : diff
  const prompt = [
    'Write a git commit message for the change below.',
    'First line: a summary under 72 characters, imperative mood ("Add", "Fix", "Rename"), no trailing period.',
    'Only if the change needs more explanation: a blank line, then at most 3 short lines on why.',
    'No markdown, no quotes, no prefixes like "feat:" unless the history uses them. Reply with ONLY the message.',
    ...(taskTitle ? [`Task: ${taskTitle}`] : []),
    ...(info.title ? [`Session: ${info.title}`] : []),
    ...(files.length ? [`Files: ${files.join(', ')}`] : []),
    'Diff:',
    clipped,
  ].join('\n')
  let answer: string | null = null
  try {
    answer = await deps.askModel('You write short, specific git commit messages. Reply with only the message.', prompt)
  } catch (err) {
    log.session.warn('session-commit: suggest failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
  }
  const message = answer ? cleanSuggestedMessage(answer) : null
  if (!message) throw new SessionCommitError('Walnut could not draft a message right now. Write one, or try again.', 503, 'suggest-failed')
  return { message }
}
