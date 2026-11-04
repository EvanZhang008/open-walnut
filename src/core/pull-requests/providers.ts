/**
 * Pull request providers: who can read a linked pull request's status. One interface, so a
 * GitLab merge request (or any forge) is one more entry here, not a change to the watcher.
 *
 * GitHub is read with the GitHub CLI (`gh api graphql`) on the computer Walnut's server runs on:
 * it holds the user's own GitHub sign-in (keyring, enterprise hosts, SSO), and one GraphQL call
 * reads every watched pull request at once. Without `gh`, or signed out, every read answers that
 * reason and the card says how to fix it.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { GITHUB_PR_URL_RE, PR_CHECK_ITEMS, oneLine, type PrCheck, type PrCheckStatus, type PrErrorCode, type PrRemark, type PrSnapshot } from './model.js'

export interface PrRef {
  provider: string
  /** The canonical URL (the link tag's). */
  url: string
  owner: string
  name: string
  number: number
}

/** One read: the snapshot's fields, every failed check (the snapshot keeps a capped list), and
 *  the remarks the watcher compares. */
export interface PrRead {
  snapshot: Omit<PrSnapshot, 'checkedAt' | 'watch' | 'error'>
  failed: PrCheck[]
  remarks: PrRemark[]
}

export type PrReadResult = { ok: true; read: PrRead } | { ok: false; code: PrErrorCode; message: string }

export interface PrProvider {
  id: string
  /** The pull request a URL names, or null when this provider does not know it. */
  parse(url: string): PrRef | null
  /** Read many at once: one answer per ref URL, and the signed-in account when known. */
  read(refs: readonly PrRef[]): Promise<{ viewer?: string; results: Map<string, PrReadResult> }>
}

// ── GitHub ──

const GH_FALLBACKS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh']
const GH_TIMEOUT_MS = 60_000
/** Pull requests per GraphQL call: GitHub's node limits are far above this. */
const GH_BATCH = 25

export type ExecResult = { code: number; stdout: string; stderr: string; missing?: boolean }
export type ExecFn = (file: string, args: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<ExecResult>

const realExec: ExecFn = (file, args, opts) => new Promise((resolve) => {
  execFile(file, args, { timeout: opts.timeoutMs, killSignal: 'SIGKILL', env: opts.env, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null
    if (e && e.code === 'ENOENT') { resolve({ code: 127, stdout: '', stderr: '', missing: true }); return }
    const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
  })
})

let ghFound: { path: string; at: number } | null = null
const GH_LOOKUP_MS = 10 * 60_000

/** The gh to run: WALNUT_GH_BIN (a test's stand-in), else the one on PATH, else the usual places
 *  (a server started by launchd has a short PATH). Looked up again every 10 minutes, so a gh
 *  installed while Walnut runs is found. */
export function ghBinary(now = Date.now()): string {
  const override = process.env.WALNUT_GH_BIN?.trim()
  if (override) return override
  if (ghFound && now - ghFound.at < GH_LOOKUP_MS) return ghFound.path
  let found = GH_FALLBACKS.find((p) => fs.existsSync(p)) ?? 'gh'
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && fs.existsSync(`${dir}/gh`)) { found = `${dir}/gh`; break }
  }
  ghFound = { path: found, at: now }
  return found
}

function q(text: string): string {
  return JSON.stringify(text)
}

/** Remarks read per pull request and kind: two minutes between reads rarely hold more, and every
 *  one carries its whole text, which the server parses on its one event loop. */
const REMARKS_READ = 10
/** How much of a review's words the card quotes. */
const REVIEW_QUOTE_CHARS = 200
/** The repository's own people. Anyone else can comment on a public repository. */
const INSIDE = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** The GraphQL selection for one pull request. `isRequired` takes the number, so each is spelled out. */
function prSelection(ref: PrRef): string {
  const n = ref.number
  return `repository(owner: ${q(ref.owner)}, name: ${q(ref.name)}) { pullRequest(number: ${n}) {
    number url title state isDraft mergedAt closedAt headRefName headRefOid baseRefName mergeable reviewDecision
    author { login }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: ${n}) }
      ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: ${n}) }
    } } } } } }
    comments(last: ${REMARKS_READ}) { nodes { id author { __typename login } authorAssociation body createdAt url } }
    reviews(last: ${REMARKS_READ}) { nodes { id author { __typename login } authorAssociation state body submittedAt url comments { totalCount } } }
  } }`
}

export function githubQuery(refs: readonly PrRef[]): string {
  return `query { viewer { login } ${refs.map((ref, i) => `pr${i}: ${prSelection(ref)}`).join('\n')} }`
}

const CHECK_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

function checkStatus(node: Record<string, unknown>): PrCheckStatus {
  if (node.__typename === 'StatusContext') {
    const state = String(node.state ?? '')
    if (state === 'SUCCESS') return 'passed'
    if (CHECK_FAILED.has(state)) return 'failed'
    return 'pending'
  }
  const status = String(node.status ?? '')
  if (status !== 'COMPLETED') return 'pending'
  const conclusion = String(node.conclusion ?? '')
  if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL') return 'passed'
  if (conclusion === 'SKIPPED' || conclusion === 'STALE') return 'skipped'
  if (CHECK_FAILED.has(conclusion)) return 'failed'
  return 'passed'
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function login(v: unknown): string {
  return str((v as { login?: unknown } | null)?.login) ?? 'ghost'
}

/** A bot's remark (a preview deploy, a coverage report) is never news: it answers every push. */
function isBot(author: unknown): boolean {
  const a = author as { __typename?: unknown; login?: unknown } | null
  return a?.__typename === 'Bot' || (typeof a?.login === 'string' && a.login.endsWith('[bot]'))
}

/** A remark whose author is not the repository's own; one that does not say counts as outside. */
function outside(node: { authorAssociation?: unknown }): boolean {
  return !(typeof node.authorAssociation === 'string' && INSIDE.has(node.authorAssociation))
}

/** One pull request node of the GraphQL answer, as a read. Exported for tests. */
export function githubRead(ref: PrRef, pr: Record<string, any>): PrRead {
  const nodes: Record<string, unknown>[] = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  const checks = nodes.filter(Boolean).map((node): PrCheck => {
    const name = str(node.name) ?? str(node.context) ?? 'check'
    const url = str(node.detailsUrl) ?? str(node.targetUrl)
    return { name, status: checkStatus(node), ...(url ? { url } : {}), ...(node.isRequired === true ? { required: true } : {}) }
  })
  const count = (s: PrCheckStatus) => checks.filter((c) => c.status === s).length
  const failed = checks.filter((c) => c.status === 'failed')
  const pending = checks.filter((c) => c.status === 'pending')
  const remarks: PrRemark[] = []
  for (const c of pr.comments?.nodes ?? []) {
    if (!c?.id || isBot(c.author)) continue
    remarks.push({
      id: String(c.id), author: login(c.author), at: str(c.createdAt) ?? '', body: String(c.body ?? ''),
      ...(str(c.url) ? { url: c.url } : {}), ...(outside(c) ? { outside: true } : {}),
    })
  }
  for (const r of pr.reviews?.nodes ?? []) {
    if (!r?.id || r.state === 'PENDING' || isBot(r.author)) continue
    const inline = Number(r.comments?.totalCount ?? 0)
    remarks.push({
      id: String(r.id), author: login(r.author), at: str(r.submittedAt) ?? '', body: String(r.body ?? ''),
      review: String(r.state ?? 'COMMENTED'), ...(inline ? { inline } : {}), ...(str(r.url) ? { url: r.url } : {}),
      ...(outside(r) ? { outside: true } : {}),
    })
  }
  const author = str(pr.author?.login)
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open'
  const review = pr.reviewDecision === 'APPROVED' ? 'approved'
    : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested'
      : pr.reviewDecision === 'REVIEW_REQUIRED' ? 'review_required' : undefined
  const mergeable = pr.mergeable === 'MERGEABLE' ? 'clean' : pr.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown'
  // The card counts what someone wrote, as GitHub lists it: a review's words and each of its
  // inline comments; a review with neither (a bare approval) is already the Review line.
  const decided = review === 'changes_requested' ? 'CHANGES_REQUESTED' : review === 'approved' ? 'APPROVED' : undefined
  const by = decided ? remarks.filter((r) => r.review === decided && !r.outside).sort((a, b) => a.at.localeCompare(b.at)).at(-1) : undefined
  const quote = by ? oneLine(by.body, REVIEW_QUOTE_CHARS) : ''
  const others = remarks.filter((r) => r.author.toLowerCase() !== (author ?? '').toLowerCase() && (r.body.trim() || r.inline))
  const outsiders = others.filter((r) => r.outside).length
  return {
    snapshot: {
      provider: 'github',
      url: ref.url,
      repo: `${ref.owner}/${ref.name}`,
      number: Number(pr.number ?? ref.number),
      ...(str(pr.title) ? { title: pr.title } : {}),
      state,
      ...(pr.isDraft === true ? { draft: true } : {}),
      ...(str(pr.headRefName) ? { head: pr.headRefName } : {}),
      ...(str(pr.baseRefName) ? { base: pr.baseRefName } : {}),
      ...(str(pr.headRefOid) ? { headSha: pr.headRefOid } : {}),
      ...(author ? { author } : {}),
      checks: {
        total: checks.length,
        passed: count('passed'),
        failed: failed.length,
        pending: pending.length,
        skipped: count('skipped'),
        items: [...failed, ...pending].slice(0, PR_CHECK_ITEMS),
      },
      ...(review ? { review } : {}),
      // What they wrote with it, cut short: the card quotes it (from the repository's own people only).
      ...(by ? { reviewBy: { author: by.author, ...(by.url ? { url: by.url } : {}), ...(quote ? { body: quote } : {}) } } : {}),
      // A merged or closed pull request has no merge question left.
      ...(state === 'open' ? { mergeable } : {}),
      // The decision's own words are its quote on the Review line, not one more comment.
      remarks: others.filter((r) => !r.outside).reduce((n, r) => n + (r.body.trim() && r !== by ? 1 : 0) + (r.inline ?? 0), 0),
      ...(outsiders ? { outsideRemarks: outsiders } : {}),
      ...(str(pr.mergedAt) ? { mergedAt: pr.mergedAt } : {}),
      ...(str(pr.closedAt) ? { closedAt: pr.closedAt } : {}),
    },
    failed,
    remarks,
  }
}

/** Why a whole call failed, from what gh printed. */
function ghFailure(r: ExecResult): { code: PrErrorCode; message: string } {
  if (r.missing) return { code: 'cli-missing', message: 'gh is not installed' }
  const text = `${r.stderr}\n${r.stdout}`
  if (/gh auth login|not logged in|Bad credentials|HTTP 401|authentication/i.test(text)) {
    return { code: 'signed-out', message: firstLine(r.stderr) || 'gh is not signed in' }
  }
  return { code: 'failed', message: firstLine(r.stderr) || `gh exited ${r.code}` }
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? ''
}

export function createGithubProvider(exec: ExecFn = realExec): PrProvider {
  return {
    id: 'github',
    parse(url) {
      const m = GITHUB_PR_URL_RE.exec(url.trim())
      if (!m) return null
      return { provider: 'github', url: `https://github.com/${m[1]}/${m[2]}/pull/${Number(m[3])}`, owner: m[1]!, name: m[2]!, number: Number(m[3]) }
    },
    async read(refs) {
      const results = new Map<string, PrReadResult>()
      let viewer: string | undefined
      for (let i = 0; i < refs.length; i += GH_BATCH) {
        const batch = refs.slice(i, i + GH_BATCH)
        const r = await exec(ghBinary(), ['api', 'graphql', '-f', `query=${githubQuery(batch)}`], {
          timeoutMs: GH_TIMEOUT_MS,
          env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
        })
        let body: { data?: Record<string, any> | null; errors?: Array<{ path?: unknown[]; message?: string; type?: string }> } | null = null
        try { body = r.stdout.trim() ? JSON.parse(r.stdout) : null } catch { body = null }
        // gh exits 1 when any alias failed but still prints the rest: read what came back.
        if (!body?.data) {
          const fail = ghFailure(r)
          for (const ref of batch) results.set(ref.url, { ok: false, ...fail })
          continue
        }
        viewer = str(body.data.viewer?.login) ?? viewer
        batch.forEach((ref, j) => {
          const node = body!.data![`pr${j}`]?.pullRequest
          if (node) { results.set(ref.url, { ok: true, read: githubRead(ref, node) }); return }
          const err = (body!.errors ?? []).find((e) => Array.isArray(e.path) && e.path[0] === `pr${j}`)
          results.set(ref.url, err?.type === 'NOT_FOUND' || !err
            ? { ok: false, code: 'not-found', message: err?.message ?? 'not found' }
            : { ok: false, code: 'failed', message: err.message ?? 'failed' })
        })
      }
      return { ...(viewer ? { viewer } : {}), results }
    },
  }
}

let providers: PrProvider[] | null = null

/** Every provider Walnut knows, in the order a URL is offered to them. */
export function prProviders(): PrProvider[] {
  if (!providers) providers = [createGithubProvider()]
  return providers
}

/** For tests: swap the providers (null puts the real ones back). */
export function _setPrProvidersForTesting(next: PrProvider[] | null): void {
  providers = next
}

/** The provider and ref for a URL, or null when no provider reads it. */
export function prRefOf(url: string): { provider: PrProvider; ref: PrRef } | null {
  for (const provider of prProviders()) {
    const ref = provider.parse(url)
    if (ref) return { provider, ref }
  }
  return null
}
