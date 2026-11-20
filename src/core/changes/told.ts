/**
 * What a session was told about a change, so the same state read again is no news.
 *
 * changeNews compares a read with the read before it, and a read that misses a stage ("No data in
 * this read"), gives one of two blockers, or reports a review state for a moment makes a state the
 * session already knows look new on the next read: 2026-11-20, one stage blocked on two failures,
 * each read giving one, woke a session twelve times in three days, and "merged" five times. So each
 * line told is kept on the change (ChangeSnapshot.told) under what it is about, and a line already
 * kept there is dropped. An entry goes once its subject really moved on, and the same words are
 * news again after that:
 *   review lines (approved, merged, ...)  a new revision
 *   failed checks                         a new revision, or the checks green
 *   a stage failed or blocked             a new commit, or the stage running, waiting or done
 *   deployed to the last stage            a new commit
 */

import type { ChangeNews } from './cadence.js'
import type { ChangeSnapshot } from './model.js'

/** What one line is about: the review or checks of one revision, one stage of one commit. */
function subjectOf(n: ChangeNews, snap: ChangeSnapshot): string {
  const rev = snap.review?.revision ?? '?'
  const commit = snap.deploy?.commit ?? '?'
  if (n.kind === 'checks_failed') return `checks@${rev}`
  if (n.kind === 'stage_failed' || n.kind === 'stage_blocked') return `stage@${commit}:${n.stage ?? n.text}`
  if (n.kind === 'deployed') return `deployed@${commit}`
  return `review@${rev}:${n.kind}`
}

/** Whether the subject an entry is about still stands in this read. */
function stillStands(subject: string, snap: ChangeSnapshot): boolean {
  const at = subject.indexOf('@')
  const kind = subject.slice(0, at)
  const rest = subject.slice(at + 1)
  const rev = String(snap.review?.revision ?? '?')
  const commit = snap.deploy?.commit ?? '?'
  if (kind === 'checks') {
    const c = snap.review?.checks
    return rest === rev && !(c && c.failed === 0 && c.pending === 0 && c.passed > 0)
  }
  if (kind === 'stage') {
    if (!rest.startsWith(`${commit}:`)) return false
    const stage = snap.deploy?.stages?.find((s) => s.name === rest.slice(commit.length + 1))
    return !(stage && (stage.status === 'done' || stage.status === 'running' || stage.status === 'waiting'))
  }
  if (kind === 'deployed') return rest === commit
  return rest.startsWith(`${rev}:`)
}

/** The news of a read its session was not told yet. */
export function untoldNews(prev: ChangeSnapshot | undefined, next: ChangeSnapshot, news: readonly ChangeNews[]): ChangeNews[] {
  const told = prev?.told
  if (!told) return [...news]
  return news.filter((n) => !told[subjectOf(n, next)]?.includes(n.text))
}

/** What stays told after this read: the entries whose subject still stands, plus the lines just told. */
export function toldAfter(prev: ChangeSnapshot | undefined, next: ChangeSnapshot, toldNow: readonly ChangeNews[]): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {}
  for (const [subject, texts] of Object.entries(prev?.told ?? {})) {
    if (Array.isArray(texts) && stillStands(subject, next)) out[subject] = [...texts]
  }
  for (const n of toldNow) {
    const subject = subjectOf(n, next)
    const texts = out[subject] ?? (out[subject] = [])
    if (!texts.includes(n.text)) texts.push(n.text)
  }
  return Object.keys(out).length ? out : undefined
}
