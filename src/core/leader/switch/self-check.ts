/**
 * The trial's self-check of the new leader's home (docs/reference/leader-switch.md, step 4).
 *
 * Every comparison is with the new leader's OWN copy, on its own machine (the old home may be on
 * another machine, never read by path): what the copy held is read once, right after the promotion
 * moved it into the home and before any path in it was rewritten (readCopyFacts, kept in the target
 * job's state), and the checks compare the home with that.
 *
 * Offline, before the trial server starts:
 *   - every file of the final batch is in the home at its size (the batch is everything the
 *     old leader held as leader data: one missing is a copy that cannot lead);
 *   - every database of the batch passes integrity_check, and has as many rows as the copy had
 *     (a rewrite that drops rows is caught);
 *   - no path of the old machine is left in the home but those the rule table keeps on purpose
 *     (home-paths.ts scans, home-path-rules.ts decides): one the promotion should have
 *     rewritten, or one no rule names, and the new leader would keep using the old machine's
 *     places (the trial rolls back; the paths are in the message);
 * Online, against the trial server:
 *   - it runs a program that can read the data (its version is not older than the old one's);
 *   - the newest task of the copy and one of its notes read back through the API as the copy
 *     held them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { inspectSqliteOffThread } from '../../../lib/sqlite.js'
import type { BatchFile } from '../../standby/types.js'
import type { SwitchSide } from './side.js'
import { pickReadBackNote, readBackThroughServer, type ReadBackNote } from '../../trial-start/read-back.js'
import { describeHit, judgePathHits, keptPlace, ruleCoversFile, scanHomePaths, unscannedProblems, type PathHit, type PathRoot, type PathRule, type ScanOptions } from './home-paths.js'

export interface CheckOutcome { ok: boolean; problems: string[]; detail: Record<string, unknown> }

const TASK_QUERY = 'SELECT id, title FROM tasks ORDER BY updated_at DESC LIMIT 1'

/** Old-machine paths the promotion left in the home that no rule keeps, as problems. */
export function leftoverPaths(home: string, roots: readonly PathRoot[], rules: readonly PathRule[], opts: Pick<ScanOptions, 'maxFileBytes' | 'maxDbBytes'> = {}): { problems: string[]; detail: Record<string, unknown> } {
  const scan = scanHomePaths(home, roots, { ...opts, skip: keptPlace(rules) })
  const j = judgePathHits(scan.hits, rules)
  const problems: string[] = []
  const list = (hits: PathHit[]) => `${hits.slice(0, 8).map(describeHit).join('; ')}${hits.length > 8 ? `; ... ${hits.length - 8} more` : ''}`
  if (j.notRewritten.length) problems.push(`the promotion left old paths where it rewrites them: ${list(j.notRewritten.map((x) => x.hit))}`)
  const unread = unscannedProblems(scan.skipped, rules)
  if (unread.length) problems.push(`the home holds leader data the path scan could not read, which no rule marks as a blob or as kept: ${unread.slice(0, 8).map((u) => `${u.file} (${u.why})`).join('; ')}${unread.length > 8 ? `; ... ${unread.length - 8} more` : ''}`)
  if (j.unknown.length) problems.push(`the home holds old-machine paths no rule decides about (a store the switch does not know: docs/reference/leader-switch.md, Paths): ${list(j.unknown)}`)
  const detail = { files: scan.files, bytes: scan.bytes, ms: Math.round(scan.ms), hits: scan.hits.length, kept: j.kept.length, skipped: scan.skipped }
  return { problems, detail }
}

/** What the new leader's copy held, read as it became the home (before any rewrite): the trial compares with it. */
export interface CopyFacts {
  /** Rows of each database of the batch. */
  rows: Record<string, number>
  /** The newest task (tasks.sqlite), and a note with its text: both read back through the trial server. */
  task: { id: string; title: string } | null
  note: (ReadBackNote & { content: string }) | null
  at: string
}

/** A note larger than this is not kept in the job's state (its read-back is skipped). */
const NOTE_MAX_BYTES = 256 * 1024

export async function readCopyFacts(home: string, files: readonly BatchFile[]): Promise<CopyFacts> {
  const rows: Record<string, number> = {}
  let task: CopyFacts['task'] = null
  await Promise.all(files.filter((f) => f.db).map(async (f) => {
    const r = await inspectSqliteOffThread(path.join(home, f.p), f.p === 'tasks/tasks.sqlite' ? { query: TASK_QUERY } : {})
    if (r.ok && typeof r.rows === 'number') rows[f.p] = r.rows
    if (f.p === 'tasks/tasks.sqlite' && r.row && typeof r.row.id === 'string') task = { id: r.row.id, title: String(r.row.title ?? '') }
  }))
  const picked = pickReadBackNote(files.map((f) => f.p))
  let note: CopyFacts['note'] = null
  if (picked) {
    try {
      const file = path.join(home, picked.rel)
      if (fs.statSync(file).size <= NOTE_MAX_BYTES) note = { ...picked, content: fs.readFileSync(file, 'utf8') }
    } catch { /* not there: the offline check names it */ }
  }
  return { rows, task, note, at: new Date().toISOString() }
}

export async function offlineCheck(o: {
  /** What the copy held (readCopyFacts). */
  facts: CopyFacts
  home: string
  files: BatchFile[]
  sizesAndRows?: boolean
  /** The roots the promotion moved (promote.ts moveRoots) and the rule table it used. */
  roots: readonly PathRoot[]
  rules: readonly PathRule[]
  /** Files a step of the promotion of its own changed (session-hosts.ts): there, too, a size and a row count may move. */
  changed?: readonly string[]
}): Promise<CheckOutcome> {
  const exact = o.sizesAndRows !== false
  let missing = 0
  const paths = leftoverPaths(o.home, o.roots, o.rules)
  const problems: string[] = [...paths.problems]
  // The promotion may have rewritten these (a size changes; a custom rewrite may drop rows).
  const changed = new Set(o.changed ?? [])
  const rewritable = (rel: string) => changed.has(rel) || o.rules.some((r) => r.rule === 'rewrite' && ruleCoversFile(r, rel))
  const rowsChange = (rel: string) => changed.has(rel) || o.rules.some((r) => r.rule === 'rewrite' && r.apply && ruleCoversFile(r, rel))
  for (const f of o.files) {
    let size = -1
    if (rewritable(f.p)) { if (!fs.existsSync(path.join(o.home, f.p))) problems.push(`${f.p}: missing`); continue }
    try { size = fs.statSync(path.join(o.home, f.p)).size } catch { /* missing */ }
    if (size < 0 || (exact && size !== f.size)) {
      missing++
      if (missing <= 5) problems.push(`${f.p}: ${size < 0 ? 'missing' : `size ${size}, the batch has ${f.size}`}`)
    }
  }
  if (missing > 5) problems.push(`... ${missing - 5} more files missing or of another size`)
  const dbs = o.files.filter((f) => f.db).map((f) => f.p).sort()
  const counts: Record<string, { home?: number; copy?: number }> = {}
  await Promise.all(dbs.map(async (rel) => {
    const r = await inspectSqliteOffThread(path.join(o.home, rel))
    const had = o.facts.rows[rel]
    counts[rel] = { home: r.rows, copy: had }
    if (!r.ok) problems.push(`${rel}: ${r.detail ?? 'integrity check failed'} in the new home`)
    else if (exact && had !== undefined && !rowsChange(rel) && r.rows !== had) problems.push(`${rel}: ${r.rows} rows in the new home, ${had} in the copy it was made from`)
  }))
  return { ok: problems.length === 0, problems, detail: { files: o.files.length, databases: counts, paths: paths.detail } }
}

function versionTuple(v: string): number[] {
  return (v.match(/\d+/g) ?? []).slice(0, 3).map(Number)
}

/** a < b by major.minor.patch. */
export function olderVersion(a: string, b: string): boolean {
  const x = versionTuple(a)
  const y = versionTuple(b)
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  }
  return false
}

export async function onlineCheck(o: { side: SwitchSide; sourceVersion: string; facts: Pick<CopyFacts, 'task' | 'note'> }): Promise<CheckOutcome> {
  const problems: string[] = []
  const detail: Record<string, unknown> = {}
  const st = await o.side.api('GET', '/api/leader/status').catch((err) => ({ status: 0, json: { error: String(err) } }))
  const s = st.json as { version?: string; permit?: { state?: string; mayAct?: boolean } } | null
  detail.status = s
  if (st.status !== 200 || !s?.version) problems.push(`the trial server's leader status did not answer (${st.status})`)
  else if (olderVersion(s.version, o.sourceVersion)) problems.push(`the trial server runs ${s.version}, older than ${o.sourceVersion} that wrote the data`)
  if (s?.permit?.mayAct) problems.push('the trial server says it may act: a trial must keep every outward door closed')
  // The newest task and a note the copy held, through the trial server (shared with the restore drill).
  const back = await readBackThroughServer((m, p) => o.side.api(m, p), { task: o.facts.task, note: o.facts.note })
  problems.push(...back.problems)
  if (o.facts.task) detail.task = o.facts.task.id
  if (o.facts.note) detail.note = o.facts.note.rel
  return { ok: problems.length === 0, problems, detail }
}
