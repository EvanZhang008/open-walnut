/**
 * When a change is read next, and what in a new read is news for the task's session. Pure: the
 * watcher (watch.ts) calls these with the snapshots and the clock.
 *
 *   cadence  a review in progress every 10 minutes; a deploy (running, failed or blocked) every 15;
 *            a stage that only waits on a blocker with an end time (a bake, a window) at that end
 *            plus a minute, at most 6 hours out; a failed read 15 minutes; a provider's own
 *            `nextInMs` wins. A settled change (closed, deployed to the end) and one followed for
 *            more than 21 days are read no more.
 *   news     the review approved, changes asked, merged or closed; its checks newly failed; a stage
 *            newly failed or blocked (a bake or a time window is not news: it ends by itself); the
 *            deploy reaching its end.
 */

import { changeSettled, type ChangeSnapshot, type ChangeStage } from './model.js'

const MIN = 60_000
export const CHANGE_REVIEW_EVERY_MS = 10 * MIN
export const CHANGE_DEPLOY_EVERY_MS = 15 * MIN
export const CHANGE_ERROR_EVERY_MS = 15 * MIN
/** After a blocker's end, how long before the read that sees it gone. */
const AFTER_UNTIL_MS = MIN
const UNTIL_CAP_MS = 6 * 60 * MIN
export const CHANGE_FOLLOW_MAX_MS = 21 * 24 * 60 * MIN
/** Never sooner than the watcher's own look. */
const MIN_NEXT_MS = 30_000
/** The furthest out any read is planned. */
export const CHANGE_MAX_NEXT_MS = 24 * 60 * MIN

/** When to read a change next (ms), or undefined when it is read no more. */
export function nextReadAt(
  snap: Pick<ChangeSnapshot, 'review' | 'deploy' | 'error' | 'followedSince'>,
  now: number,
  providerNextInMs?: number,
): number | undefined {
  if (changeSettled(snap)) return undefined
  const since = snap.followedSince ? Date.parse(snap.followedSince) : NaN
  if (Number.isFinite(since) && now - since > CHANGE_FOLLOW_MAX_MS) return undefined
  if (snap.error) return now + CHANGE_ERROR_EVERY_MS
  if (typeof providerNextInMs === 'number' && Number.isFinite(providerNextInMs) && providerNextInMs > 0) {
    return now + Math.min(Math.max(providerNextInMs, MIN_NEXT_MS), CHANGE_MAX_NEXT_MS)
  }
  const deploy = snap.deploy
  if (deploy) {
    // The soonest of what moves: a stage on a clock wakes at its end, anything else every 15 minutes.
    let at = Infinity
    let moving = false
    for (const stage of deploy.stages) {
      if (stage.status === 'done' || stage.status === 'pending') continue
      const until = stage.status === 'waiting' && stage.blocker?.until ? Date.parse(stage.blocker.until) : NaN
      if (Number.isFinite(until)) at = Math.min(at, Math.max(until + AFTER_UNTIL_MS, now + MIN_NEXT_MS), now + UNTIL_CAP_MS)
      else moving = true
    }
    if (moving || at === Infinity) at = Math.min(at, now + CHANGE_DEPLOY_EVERY_MS)
    return at
  }
  if (snap.review?.state === 'merged') return now + CHANGE_DEPLOY_EVERY_MS
  return now + CHANGE_REVIEW_EVERY_MS
}

export type ChangeNewsKind = 'approved' | 'changes_requested' | 'merged' | 'closed' | 'checks_failed' | 'stage_failed' | 'stage_blocked' | 'deployed'

export interface ChangeNews {
  kind: ChangeNewsKind
  /** One short line, without the URL. */
  text: string
  /** The stage a stage line is about. */
  stage?: string
}

/** A blocker that ends by itself: waiting on it asks nothing of the session. */
function waitsByItself(stage: ChangeStage): boolean {
  return stage.blocker?.kind === 'bake' || stage.blocker?.kind === 'window'
}

function stuckKind(stage: ChangeStage | undefined): 'stage_failed' | 'stage_blocked' | undefined {
  if (!stage) return undefined
  if (stage.status === 'failed') return 'stage_failed'
  if (stage.status === 'blocked' && !waitsByItself(stage)) return 'stage_blocked'
  return undefined
}

/** What the session hears about a read. The first read of a change is no news (the session linked
 *  it), and `skipReview` leaves the review to another watcher (a pull request the pull request
 *  watcher already follows). */
export function changeNews(prev: ChangeSnapshot | undefined, next: ChangeSnapshot, opts: { skipReview?: boolean } = {}): ChangeNews[] {
  if (!prev?.checkedAt || next.error) return []
  const out: ChangeNews[] = []
  const was = prev.review
  const now = next.review
  if (now && !opts.skipReview) {
    if (now.state !== was?.state) {
      if (now.state === 'approved') out.push({ kind: 'approved', text: 'approved' })
      else if (now.state === 'changes_requested') out.push({ kind: 'changes_requested', text: 'changes requested' })
      else if (now.state === 'merged') out.push({ kind: 'merged', text: 'merged' })
      else if (now.state === 'closed') out.push({ kind: 'closed', text: 'closed without merging' })
    }
    if ((now.checks?.failed ?? 0) > 0 && !((was?.checks?.failed ?? 0) > 0)) {
      out.push({ kind: 'checks_failed', text: `${now.checks!.failed} check${now.checks!.failed === 1 ? '' : 's'} failed` })
    }
  }
  const before = new Map((prev.deploy?.stages ?? []).map((s) => [s.name, s]))
  for (const stage of next.deploy?.stages ?? []) {
    const kind = stuckKind(stage)
    if (!kind) continue
    const old = before.get(stage.name)
    if (stuckKind(old) === kind && old?.blocker?.text === stage.blocker?.text) continue
    const why = stage.blocker?.text ?? stage.note
    out.push({ kind, stage: stage.name, text: `${stage.name} ${kind === 'stage_failed' ? 'failed' : 'blocked'}${why ? ` (${why})` : ''}` })
  }
  if (next.deploy?.done && !prev.deploy?.done) out.push({ kind: 'deployed', text: 'deployed to the last stage' })
  return out
}

/** The wake's lines for one change: what happened, its URL, and a word on its link place once it settled. */
export function changeWakeLines(next: ChangeSnapshot, news: readonly ChangeNews[], settledNow: boolean): string {
  const head = `${next.label} ${news.map((n) => n.text).join(', ')}: ${next.url}`
  return settledNow
    ? `${head}\nNothing more to follow on it: its link may give its place to another (a task holds at most 3 links; your LINKS list decides).`
    : head
}
