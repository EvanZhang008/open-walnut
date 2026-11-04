/**
 * Pull request status on a task: the shapes the watcher stores (Task.pr_status) and the words the
 * web draws from them. Browser-safe: no imports beyond types.
 *
 * A task's linked pull requests are its `pr:` link tags (link-tags.ts) that a provider recognises
 * (GitHub today, see providers.ts). The watcher (pr-watch.ts) reads each one's state, checks,
 * review and mergeability, keeps a compact snapshot here, wakes the task's session on news that
 * needs it (a check failed, a review or comment from someone else, a conflict), and completes the
 * task when its pull request merges.
 */

import { linkUrlOfTag } from '../link-tags.js'

export type PrState = 'open' | 'merged' | 'closed'
export type PrCheckStatus = 'passed' | 'failed' | 'pending' | 'skipped'
export type PrReview = 'approved' | 'changes_requested' | 'review_required'
export type PrMergeable = 'clean' | 'conflicting' | 'unknown'

/** One check that is not green (failed or still running): the snapshot keeps only these by name. */
export interface PrCheck {
  name: string
  status: PrCheckStatus
  url?: string
  /** A required check (branch protection). */
  required?: boolean
}

export interface PrChecks {
  total: number
  passed: number
  failed: number
  pending: number
  skipped: number
  /** The failed ones first, then the pending ones, at most PR_CHECK_ITEMS. */
  items: PrCheck[]
}

/** A comment or review by someone, as the watcher compares them (never stored whole). */
export interface PrRemark {
  id: string
  author: string
  /** ISO time it was written (an edit later is not news). */
  at: string
  body: string
  url?: string
  /** A review's verdict ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'); none for a plain comment. */
  review?: string
  /** Inline comments a review carries. */
  inline?: number
  /** Written by someone who is not an owner, member or collaborator of the repository: on a public
   *  repository anyone can comment, so such a remark is never news and its words never reach a
   *  session. */
  outside?: boolean
}

/** What the watcher remembers between reads, so only news wakes the session. */
export interface PrWatchState {
  headSha?: string
  /** Failed check names already told for this head. */
  failedChecks: string[]
  /** Remarks up to this time were seen; ones at exactly this time are told apart by id. */
  remarksThrough: string
  remarkIds: string[]
  /** A conflict already told for this head. */
  conflicting: boolean
  /** Wakes in a row that carried only comments (a bot loop guard). */
  commentWakes: number
  lastWakeAt?: string
  /** Why the last wake happened, in short words. */
  lastWake?: string
  /** Seen going from open to merged (a pull request linked after it merged never completes a task). */
  mergeSeen?: boolean
  /** The task was completed because this pull request merged. */
  completedAt?: string
  /** It merged but the task was kept open, and why (shown in the card). */
  heldOpen?: string
}

/** One pull request's snapshot on a task (Task.pr_status, keyed by its canonical URL). */
export interface PrSnapshot {
  provider: string
  url: string
  /** `owner/name`. */
  repo: string
  number: number
  title?: string
  state: PrState
  draft?: boolean
  head?: string
  base?: string
  headSha?: string
  author?: string
  /** Opened by the signed-in account (the one Walnut reads with). Only such a pull request wakes
   *  the task's session or completes the task; another person's is shown, nothing more. */
  mine?: boolean
  checks: PrChecks
  review?: PrReview
  mergeable?: PrMergeable
  /** Who gave the review the decision rests on (the latest request for changes, or approval, by
   *  the repository's own people), and where it is. */
  reviewBy?: { author: string; url?: string; body?: string }
  /** Comments and reviews by the repository's own people other than its author (bots left out). */
  remarks?: number
  /** Comments and reviews by people outside the repository: shown, never news. */
  outsideRemarks?: number
  mergedAt?: string
  closedAt?: string
  /** When the provider last answered for it (ISO). */
  checkedAt: string
  /** The last read failed: the rest is what the read before it found. */
  error?: { code: PrErrorCode; message: string }
  watch?: PrWatchState
}

export type PrErrorCode = 'cli-missing' | 'signed-out' | 'not-found' | 'failed'

export const PR_CHECK_ITEMS = 20

/** A GitHub pull request URL in the canonical form a link tag holds (owner, repo, number). */
export const GITHUB_PR_URL_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/i

/** The pull request URLs among a task's link tags that Walnut can watch, in tag order. The server's
 *  providers (providers.ts) read the same set; this is the browser's copy of the test. */
export function watchablePrUrls(tags: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const tag of tags ?? []) {
    const url = linkUrlOfTag(tag)
    const m = url ? GITHUB_PR_URL_RE.exec(url) : null
    if (!m) continue
    const canonical = `https://github.com/${m[1]}/${m[2]}/pull/${Number(m[3])}`
    if (!out.includes(canonical)) out.push(canonical)
  }
  return out
}

/** The tone a pill takes: what the user should read first. */
export type PrTone = 'merged' | 'closed' | 'failed' | 'conflict' | 'changes' | 'pending' | 'passed' | 'draft' | 'open' | 'unknown'

/** What a pill shows: its tone, its words, and `short`, the one word it folds to in a tight
 *  column (row-pill-fit.css draws `data-short`; every other pill folds to a letter, this one keeps
 *  a word, since the state is the point). Order: a finished state, then what blocks, then what runs. */
export function prPillState(pr: Pick<PrSnapshot, 'state' | 'draft' | 'checks' | 'review' | 'mergeable' | 'error' | 'checkedAt'>): { tone: PrTone; label: string; short: string } {
  if (pr.state === 'merged') return { tone: 'merged', label: 'Merged', short: 'Merged' }
  if (pr.state === 'closed') return { tone: 'closed', label: 'Closed', short: 'Closed' }
  if (!pr.checkedAt && pr.error) return { tone: 'unknown', label: 'No status', short: 'PR' }
  if (pr.checks.failed > 0) {
    // A failure reads first; a conflict or a change asked for rides along, so the row says both.
    const also = pr.mergeable === 'conflicting' ? ', conflict' : pr.review === 'changes_requested' ? ', changes requested' : ''
    return { tone: 'failed', label: `${pr.checks.failed === 1 ? '1 check failed' : `${pr.checks.failed} checks failed`}${also}`, short: 'Failed' }
  }
  if (pr.mergeable === 'conflicting') return { tone: 'conflict', label: 'Conflict', short: 'Conflict' }
  if (pr.review === 'changes_requested') return { tone: 'changes', label: 'Changes requested', short: 'Changes' }
  // A draft is not up for review yet: that is what it says, while its checks run too.
  if (pr.draft) return { tone: 'draft', label: pr.checks.pending > 0 ? 'Draft, checks running' : 'Draft', short: 'Draft' }
  if (pr.checks.pending > 0) return { tone: 'pending', label: 'Checks running', short: 'Running' }
  if (pr.review === 'approved') return { tone: 'passed', label: 'Approved', short: 'Approved' }
  if (pr.checks.total > 0) return { tone: 'passed', label: 'Checks passed', short: 'Passed' }
  return { tone: 'open', label: 'Open', short: 'Open' }
}

/** The pull request a task's pill speaks for when it has several: the one that needs a look first. */
export function leadPr(prs: readonly PrSnapshot[]): PrSnapshot | undefined {
  const rank: Record<PrTone, number> = {
    // Merged before closed: of a task's finished pull requests, the one that merged is the news.
    failed: 0, conflict: 1, changes: 2, pending: 3, open: 4, draft: 5, passed: 6, unknown: 7, merged: 8, closed: 9,
  }
  let best: PrSnapshot | undefined
  let bestRank = Number.POSITIVE_INFINITY
  for (const pr of prs) {
    const r = rank[prPillState(pr).tone]
    if (r < bestRank) { best = pr; bestRank = r }
  }
  return best
}

/** The task's snapshots in tag order (the order the user sees its links in). */
export function taskPrSnapshots(task: { pr_status?: Record<string, PrSnapshot> | undefined }): PrSnapshot[] {
  return Object.values(task.pr_status ?? {})
}

/** The check counts in words, for a card line: "3 passed, 1 failed, 2 running". */
export function prChecksLine(checks: PrChecks): string {
  if (checks.total === 0) return 'No checks reported'
  const parts: string[] = []
  if (checks.failed) parts.push(`${checks.failed} failed`)
  if (checks.pending) parts.push(`${checks.pending} running`)
  if (checks.passed) parts.push(`${checks.passed} passed`)
  if (checks.skipped) parts.push(`${checks.skipped} skipped`)
  return parts.join(', ')
}

export const PR_REVIEW_WORDS: Record<PrReview, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  review_required: 'Review required',
}

export const PR_ERROR_WORDS: Record<PrErrorCode, string> = {
  'cli-missing': 'The GitHub CLI (gh) is not installed on the computer Walnut runs on.',
  'signed-out': 'The GitHub CLI (gh) is not signed in on the computer Walnut runs on.',
  'not-found': 'GitHub does not know this pull request, or this account cannot see it.',
  failed: 'GitHub did not answer the last read.',
}

/** Someone's words on one line, at most `max` characters (cut on a whole character), without
 *  the hidden HTML comments GitHub templates leave in. */
export function oneLine(body: string, max: number): string {
  const text = body.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}
