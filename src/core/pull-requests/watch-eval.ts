/**
 * What changed on a pull request since the watcher last read it, and the words its session gets.
 * Pure: pr-watch.ts reads, this judges, pr-watch.ts writes and wakes.
 *
 * News that wakes the session: a check that failed on the current head (each name once per head),
 * a comment or review by one of the repository's own people (owner, member, collaborator) other
 * than the pull request's author or the signed-in account, and a conflict with the base branch
 * (once per head). Anyone can comment on a public repository, so a remark from outside is never
 * news and its words never reach the session (the read already left bots out). A new push clears what was told, so a check
 * that fails again on the new head is news again. The first read only records where things stand:
 * linking a pull request whose checks already failed wakes nothing (whoever linked it is in the
 * conversation already). Remarks are followed by a time cursor plus the ids read at that exact
 * time, since a forge stamps them to the second.
 */

import type { PrCheck, PrRemark, PrSnapshot, PrWatchState } from './model.js'
import { oneLine } from './model.js'

/** Wakes in a row that carried only comments before the watcher stops waking for comments
 *  (a bot answering the agent answering the bot). A check, a conflict or a push resets it. */
export const PR_COMMENT_WAKE_LIMIT = 10
const LISTED = 10
const SNIPPET = 200

export type PrWatchChange =
  | { kind: 'checks-failed'; failed: PrCheck[] }
  | { kind: 'remarks'; remarks: PrRemark[] }
  | { kind: 'conflicting' }

export interface PrWatchReport {
  changes: PrWatchChange[]
  next: PrWatchState
  /** Comment-only wakes reached the limit with this one: say so, and stop waking for comments. */
  exhausted: boolean
  /** Comment news held back because the limit was reached earlier. */
  muted: boolean
}

const EPOCH = '1970-01-01T00:00:00.000Z'

function remarkMatters(r: PrRemark): boolean {
  if (r.outside) return false
  // An approval with nothing written asks nothing of the agent; every other remark may.
  if (r.review === 'APPROVED' && !r.body.trim()) return false
  if (r.review === 'PENDING' || r.review === 'DISMISSED') return false
  return !!(r.body.trim() || r.inline || r.review === 'CHANGES_REQUESTED')
}

function ms(iso: string): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

export function evaluatePrWatch(
  prev: PrWatchState | undefined,
  pr: Pick<PrSnapshot, 'headSha' | 'mergeable' | 'author'> & { checks: Pick<PrSnapshot['checks'], 'total'>; failed: readonly PrCheck[] },
  remarks: readonly PrRemark[],
  opts: { viewer?: string } = {},
): PrWatchReport {
  const own = new Set([pr.author, opts.viewer].filter((x): x is string => !!x).map((x) => x.toLowerCase()))
  const others = remarks.filter((r) => !own.has(r.author.toLowerCase()))
  const failedNow = pr.failed

  if (!prev) {
    const latest = others.reduce((m, r) => (ms(r.at) > ms(m) ? r.at : m), EPOCH)
    return {
      changes: [],
      next: {
        ...(pr.headSha ? { headSha: pr.headSha } : {}),
        failedChecks: failedNow.map((c) => c.name),
        remarksThrough: latest,
        remarkIds: others.filter((r) => r.at === latest).map((r) => r.id),
        conflicting: pr.mergeable === 'conflicting',
        commentWakes: 0,
      },
      exhausted: false,
      muted: false,
    }
  }

  const changes: PrWatchChange[] = []
  const headSha = pr.headSha ?? prev.headSha
  const headMoved = !!pr.headSha && !!prev.headSha && pr.headSha !== prev.headSha

  // A read that lists no checks at all may be a host still registering them after a push: what
  // was told for this head stays told.
  let failedChecks = headMoved ? [] : prev.failedChecks
  if (pr.checks.total > 0 || headMoved) {
    const fresh = failedNow.filter((c) => !failedChecks.includes(c.name))
    if (fresh.length) changes.push({ kind: 'checks-failed', failed: fresh })
    failedChecks = failedNow.map((c) => c.name)
  }

  const through = ms(prev.remarksThrough)
  const fresh = others.filter((r) => {
    const at = ms(r.at)
    return (at > through || (at === through && !prev.remarkIds.includes(r.id))) && remarkMatters(r)
  })
  // The cursor moves over every remark read, told or not, so a quiet approval is never news later.
  const seen = others.filter((r) => ms(r.at) > through || (ms(r.at) === through && !prev.remarkIds.includes(r.id)))
  const latest = seen.reduce((m, r) => Math.max(m, ms(r.at)), through)
  const atLatest = seen.filter((r) => ms(r.at) === latest)
  const remarksThrough = latest === through ? prev.remarksThrough : atLatest[0]!.at
  const remarkIds = [...(latest === through ? prev.remarkIds : []), ...atLatest.map((r) => r.id)]

  const toldConflict = !headMoved && prev.conflicting
  if (pr.mergeable === 'conflicting' && !toldConflict) changes.push({ kind: 'conflicting' })
  // 'unknown' is the host still computing after a push: only a clean answer clears a conflict.
  const conflicting = pr.mergeable === 'unknown' || pr.mergeable === undefined ? toldConflict : pr.mergeable === 'conflicting'

  let muted = false
  let commentWakes = headMoved || changes.length > 0 ? 0 : prev.commentWakes
  if (fresh.length) {
    if (changes.length === 0 && commentWakes >= PR_COMMENT_WAKE_LIMIT) muted = true
    else changes.push({ kind: 'remarks', remarks: fresh })
  }
  const commentsOnly = changes.length > 0 && changes.every((c) => c.kind === 'remarks')
  if (commentsOnly) commentWakes += 1

  return {
    changes,
    next: {
      ...prev,
      ...(headSha ? { headSha } : {}),
      failedChecks,
      remarksThrough,
      remarkIds,
      conflicting,
      commentWakes,
    },
    exhausted: commentsOnly && commentWakes >= PR_COMMENT_WAKE_LIMIT,
    muted,
  }
}

/** A remark's text on one line, at most SNIPPET characters. */
function snippet(body: string): string {
  return oneLine(body, SNIPPET)
}

function listed<T>(items: readonly T[], line: (item: T) => string): string[] {
  const out = items.slice(0, LISTED).map(line)
  if (items.length > LISTED) out.push(`  - and ${items.length - LISTED} more`)
  return out
}

/** The short reason a wake happened ("checks failed, changes requested"). A review's verdict is
 *  named, so a change asked for never reads as plain comments. */
export function prWakeSummary(changes: readonly PrWatchChange[]): string {
  return changes.map((c) => {
    if (c.kind === 'checks-failed') return 'checks failed'
    if (c.kind === 'conflicting') return 'merge conflict'
    if (c.remarks.some((r) => r.review === 'CHANGES_REQUESTED')) return 'changes requested'
    if (c.remarks.some((r) => r.review === 'APPROVED')) return 'approved with a note'
    return c.remarks.length === 1 ? 'a new comment' : 'new comments'
  }).join(', ')
}

/** The body of the message the session gets (pr-watch.ts wraps it in a walnut-message). */
export function prWakeBody(pr: Pick<PrSnapshot, 'number' | 'url' | 'base' | 'headSha' | 'title'>, report: Pick<PrWatchReport, 'changes' | 'exhausted'>): string {
  const commit = pr.headSha ? ` (commit ${pr.headSha.slice(0, 7)})` : ''
  const lines: string[] = [`Pull request #${pr.number}${pr.title ? ` "${pr.title}"` : ''}, linked to this task, changed: ${pr.url}`]
  for (const change of report.changes) {
    if (change.kind === 'checks-failed') {
      lines.push(`- ${change.failed.length === 1 ? 'A check' : `${change.failed.length} checks`} failed${commit}:`)
      lines.push(...listed(change.failed, (c) => `  - ${c.name}${c.url ? `: ${c.url}` : ''}`))
    } else if (change.kind === 'conflicting') {
      lines.push(`- It can no longer merge cleanly into ${pr.base || 'its base branch'}: the branch has conflicts.`)
    } else {
      lines.push(`- ${change.remarks.length === 1 ? 'A new comment or review' : `${change.remarks.length} new comments or reviews`}:`)
      lines.push(...listed(change.remarks, (r) => {
        const verdict = r.review && r.review !== 'COMMENTED' ? `, ${r.review.toLowerCase().replace(/_/g, ' ')}` : ''
        const inline = r.inline ? `, ${r.inline} inline ${r.inline === 1 ? 'comment' : 'comments'}` : ''
        const text = snippet(r.body)
        return `  - ${r.author}${verdict}${inline}${text ? `: ${text}` : ''}${r.url ? ` (${r.url})` : ''}`
      }))
    }
  }
  lines.push('')
  lines.push(report.exhausted
    ? `This was the ${PR_COMMENT_WAKE_LIMIT}th update in a row with only comments, so comments alone no longer wake this task; a failed check, a conflict or a new push still does.`
    : 'Handle what this task needs from the items above, then end your turn. Walnut keeps watching this pull request on its own (no trigger needed) and writes again when something else changes; when it merges, the task is completed unless the user switched that off.')
  return lines.join('\n')
}
