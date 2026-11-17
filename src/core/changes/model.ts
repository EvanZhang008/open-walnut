/**
 * Changes: what a task changed (a pull request, a code review, a commit) and how far it got, as one
 * shape every service fills. Browser-safe: no imports beyond types and the link-tag helpers.
 *
 * A change is one of the task's change link tags (`pr:`, `mr:`, `cr:`, `commit:`) that a change
 * provider recognises (registry.ts: Walnut's GitHub one, or a plugin's through
 * `walnut.registry.changeProvider`). Its snapshot (Task.change_status, keyed by the link's URL) has
 * two parts:
 *   review  the code review's state: draft, open, approved, changes asked, merged, closed;
 *   deploy  the pipeline the merged commit goes through, one row per stage: done, running, waiting
 *           (a bake, a time window, an approval), blocked, failed, or not reached yet.
 * The watcher (watch.ts) reads each change when it is due (`nextAt`, set from what it waits on), and
 * the web draws the pill and the card from this shape alone: it knows no service.
 */

import { linkUrlOfTag } from '../link-tags.js'
import { parseTag } from '../tag-model.js'

/** One change link as a task holds it: its tag key and canonical URL. */
export interface ChangeLink {
  key: string
  url: string
}

/** The tag keys a change link is held under. */
export const CHANGE_LINK_KEYS: readonly string[] = ['pr', 'mr', 'cr', 'commit', 'code-review', 'change']

/** A task's change links, in tag order, once each by URL. Whether a provider reads one is the
 *  registry's call (changeProviderFor), not this list's. */
export function taskChangeLinks(tags: readonly string[] | undefined): ChangeLink[] {
  const out: ChangeLink[] = []
  const seen = new Set<string>()
  for (const tag of tags ?? []) {
    const key = parseTag(tag)?.key
    if (!key || !CHANGE_LINK_KEYS.includes(key)) continue
    const url = linkUrlOfTag(tag)
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({ key, url })
  }
  return out
}

export type ChangeReviewState = 'draft' | 'open' | 'approved' | 'changes_requested' | 'merged' | 'closed'

export interface ChangeReview {
  state: ChangeReviewState
  /** The revision under review (1 for the first), when the service counts them. */
  revision?: number
  /** Approvals given and needed (needed absent when unknown). */
  approvals?: { got: number; need?: number }
  /** Who approved, by their handle, at most a few. */
  approvedBy?: string[]
  /** Automated checks on the review. */
  checks?: { passed: number; failed: number; pending: number }
  /** One short line on what holds it ("team approval needs 1"), when something does. */
  waitingOn?: string
}

/** Why a stage is not moving, in one of the kinds every service maps its own words onto. */
export type ChangeBlockerKind = 'bake' | 'window' | 'approval' | 'alarm' | 'failure' | 'hold'

export interface ChangeBlocker {
  kind: ChangeBlockerKind
  /** In the service's words, one line ("Bake Time: 6 hours 59 minutes left"). */
  text: string
  /** ISO time it ends by itself (a bake's end, a window's opening), when known. */
  until?: string
}

export type ChangeStageStatus = 'done' | 'running' | 'waiting' | 'blocked' | 'failed' | 'pending'

export interface ChangeStage {
  /** The stage's name in the pipeline (`prod-w1`, `production`). */
  name: string
  /** Where it deploys (`prod-icn-c01`, an environment), when it says more than the name. */
  target?: string
  status: ChangeStageStatus
  /** ISO time it got there (deployed), when known. */
  at?: string
  /** One short line ("approval running", "Integration Test: 6 passed"). */
  note?: string
  blocker?: ChangeBlocker
  /** A production stage (the card can fold the others). */
  prod?: boolean
}

export interface ChangeDeploy {
  /** The pipeline's (or deployment system's) name. */
  pipeline: string
  /** Where a person follows it (a tracking page). */
  url?: string
  /** The commit it tracks (a provider may store the whole hash; the card shows its first 7). */
  commit?: string
  /** Every stage in pipeline order, at most MAX_CHANGE_STAGES. */
  stages: ChangeStage[]
  /** The last stage it reached and the next one. */
  last?: string
  next?: string
  /** It reached the end: nothing more to follow. */
  done: boolean
}

export type ChangeErrorCode = 'signed-out' | 'not-found' | 'unreachable' | 'failed'

export interface ChangeSnapshot {
  /** The provider that read it (`github`, `<plugin id>:<id>`). */
  provider: string
  url: string
  /** What the pill reads (`CR-1001`, `app#12`, `app@1a2b3c4`). */
  label: string
  title?: string
  review?: ChangeReview
  deploy?: ChangeDeploy
  /** When the provider last answered (ISO). */
  checkedAt: string
  /** When the watcher reads it next (ISO); absent once it no longer changes. */
  nextAt?: string
  /** When the watcher first read it (ISO): one followed longer than 21 days is read no more. */
  followedSince?: string
  /** The last read failed: the rest is what the read before it found. */
  error?: { code: ChangeErrorCode; message: string }
}

/** What one stage holds when the card opens it: its steps and what blocks it, read live. */
export interface ChangeStageDetail {
  stage: string
  steps: Array<{ name: string; status: ChangeStageStatus; note?: string; url?: string }>
  blockers: ChangeBlocker[]
  /** A page with the whole stage. */
  url?: string
}

export const MAX_CHANGE_STAGES = 60

/** The tone a change pill takes, the same five colours everywhere. */
export type ChangeTone = 'done' | 'running' | 'waiting' | 'blocked' | 'closed' | 'unknown'

/** What a change pill reads after its label: a tone and a few words. Order: a failure or block
 *  first, then a finished state, then what runs. */
export function changePillState(snap: Pick<ChangeSnapshot, 'review' | 'deploy' | 'error' | 'checkedAt'> | undefined): { tone: ChangeTone; text: string } {
  if (!snap || (!snap.checkedAt && snap.error)) return { tone: 'unknown', text: snap?.error?.code === 'signed-out' ? 'Sign-in needed' : 'No status' }
  const review = snap.review
  const deploy = snap.deploy
  const stuck = deploy?.stages.find((s) => s.status === 'failed' || s.status === 'blocked')
  if (stuck) return { tone: 'blocked', text: `${stuck.name} ${stuck.status === 'failed' ? 'failed' : 'blocked'}` }
  if (review?.state === 'closed') return { tone: 'closed', text: 'Closed' }
  if (deploy?.done) return { tone: 'done', text: 'Deployed' }
  if (deploy) {
    const waiting = deploy.stages.find((s) => s.status === 'waiting')
    if (waiting) return { tone: 'waiting', text: `${waiting.name} ${waiting.blocker?.kind === 'bake' ? 'baking' : 'waiting'}` }
    const running = deploy.stages.find((s) => s.status === 'running')
    if (running) return { tone: 'running', text: `${running.name} deploying` }
    if (deploy.last) return { tone: 'running', text: `at ${deploy.last}` }
    return { tone: 'running', text: 'Merged, not deployed yet' }
  }
  if (review) {
    if (review.state === 'merged') return { tone: 'done', text: 'Merged' }
    if (review.checks?.failed) return { tone: 'blocked', text: 'Checks failed' }
    if (review.state === 'changes_requested') return { tone: 'blocked', text: 'Changes requested' }
    if (review.state === 'approved') return { tone: 'done', text: 'Approved' }
    if (review.state === 'draft') return { tone: 'waiting', text: 'Draft' }
    const a = review.approvals
    // In review waits on a person, the reviewers: the same tone as any wait on someone.
    return { tone: 'waiting', text: a?.need ? `In review ${a.got}/${a.need}` : 'In review' }
  }
  return { tone: 'unknown', text: 'No status' }
}

/** A change no read can move any more: closed, or deployed to the end. */
export function changeSettled(snap: Pick<ChangeSnapshot, 'review' | 'deploy'>): boolean {
  return snap.review?.state === 'closed' || snap.deploy?.done === true
}
