/**
 * What a session was told about a change, so the same state read again is no news.
 *
 * changeNews compares a read with the read before it, and a read that misses a stage ("No data in
 * this read"), gives one of two blockers, or reports a review state for a moment makes a state the
 * session already knows look new on the next read: 2026-11-20, one stage blocked on two failures,
 * each read giving one, woke a session twelve times in three days, and "merged" five times. So each
 * line told is kept on the change (ChangeSnapshot.told) under what it is about, and a line already
 * kept there is dropped. An entry goes once a read shows its subject really moved on (a read that
 * leaves the stage or the commit out shows nothing), and the same words are news again after that:
 *   review lines (approved, merged, ...)  a new revision
 *   failed checks                         a new revision, or the checks green
 *   a stage failed or blocked             a new commit, or the stage running or done
 *   deployed to the last stage            a new commit
 */

import type { ChangeNews } from './cadence.js'
import type { ChangeSnapshot } from './model.js'

/** What one line is about: the review or checks of one revision, one stage of one commit. Written
 *  `<kind>@<revision or commit>:<name>`, `?` for a revision or commit the read did not give. */
function subjectOf(n: ChangeNews, snap: ChangeSnapshot): string {
  const rev = snap.review?.revision ?? '?'
  const commit = snap.deploy?.commit ?? '?'
  if (n.kind === 'checks_failed') return `checks@${rev}:`
  if (n.kind === 'stage_failed' || n.kind === 'stage_blocked') return `stage@${commit}:${n.stage ?? n.text}`
  if (n.kind === 'deployed') return `deployed@${commit}:`
  return `review@${rev}:${n.kind}`
}

function parts(subject: string): { kind: string; at: string; name: string } {
  const a = subject.indexOf('@')
  const c = subject.indexOf(':', a)
  // `checks@3` without its colon: the first build of this record wrote those for a while.
  if (c < 0) return { kind: subject.slice(0, a), at: subject.slice(a + 1), name: '' }
  return { kind: subject.slice(0, a), at: subject.slice(a + 1, c), name: subject.slice(c + 1) }
}

/** A revision or commit an entry was told under still holds: a read that names none says nothing. */
function sameOrUnknown(a: string, b: string | number | undefined): boolean {
  return b === undefined || a === '?' || String(b) === '?' || a === String(b)
}

/** Two subjects are the same one, a revision or commit left out by either read aside. */
function sameSubject(a: string, b: string): boolean {
  const x = parts(a)
  const y = parts(b)
  return x.kind === y.kind && x.name === y.name && sameOrUnknown(x.at, y.at)
}

/**
 * Whether the subject an entry is about still stands in this read. Only a read that shows it moved
 * on drops it: one that leaves a stage, the revision or the commit out (a partial read) keeps it.
 */
function stillStands(subject: string, snap: ChangeSnapshot): boolean {
  const { kind, at, name } = parts(subject)
  if (kind === 'checks') {
    const c = snap.review?.checks
    return sameOrUnknown(at, snap.review?.revision) && !(c && c.failed === 0 && c.pending === 0 && c.passed > 0)
  }
  if (kind === 'stage') {
    if (!sameOrUnknown(at, snap.deploy?.commit)) return false
    const stage = snap.deploy?.stages?.find((st) => st.name === name)
    return !(stage && (stage.status === 'done' || stage.status === 'running'))
  }
  if (kind === 'deployed') return sameOrUnknown(at, snap.deploy?.commit)
  return sameOrUnknown(at, snap.review?.revision)
}

/** The news of a read its session was not told yet. */
export function untoldNews(prev: ChangeSnapshot | undefined, next: ChangeSnapshot, news: readonly ChangeNews[]): ChangeNews[] {
  const told = Object.entries(prev?.told ?? {})
  if (!told.length) return [...news]
  return news.filter((n) => {
    const subject = subjectOf(n, next)
    return !told.some(([s, texts]) => Array.isArray(texts) && texts.includes(n.text) && sameSubject(s, subject))
  })
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
