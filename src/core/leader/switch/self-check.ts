/**
 * The trial's self-check of the new leader's home (docs/reference/leader-switch.md, step 4).
 *
 * Offline, before the trial server starts:
 *   - every file of the final batch is in the home at its size (the batch is everything the
 *     old leader held as leader data: one missing is a copy that cannot lead);
 *   - every database of the batch passes integrity_check, and has as many rows as the old
 *     home's (read-only; the old leader is stopped);
 *   - config.yaml (its leader_switch section aside, which names both homes) names no path in
 *     the old home: the new leader would keep reading and writing the old machine's folder;
 * Online, against the trial server:
 *   - it runs a program that can read the data (its version is not older than the old one's);
 *   - the newest task of the old home and one of its notes read back through the API as they
 *     are in the old home.
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { inspectSqliteOffThread } from '../../../lib/sqlite.js'
import type { BatchFile } from '../../standby/types.js'
import type { SwitchSide } from './side.js'
import { pickReadBackNote, readBackThroughServer, type ReadBackNote } from '../../trial-start/read-back.js'

export interface CheckOutcome { ok: boolean; problems: string[]; detail: Record<string, unknown> }

const REWRITTEN = new Set(['cache/applied-ops.sqlite', 'config.yaml'])

const TASK_QUERY = 'SELECT id, title FROM tasks ORDER BY updated_at DESC LIMIT 1'

/** Settings in config.yaml that name a path in the old home (leader_switch, which names both homes, aside). */
export function configPathsInto(home: string, oldHome: string): string[] {
  let cfg: unknown
  try { cfg = YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')) } catch { return [] }
  const root = path.resolve(oldHome)
  const hits: string[] = []
  const walk = (v: unknown, at: string) => {
    if (typeof v === 'string') { if (v === root || v.startsWith(`${root}${path.sep}`)) hits.push(at); return }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`)); return }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!(at === '' && k === 'leader_switch')) walk(x, at ? `${at}.${k}` : k)
  }
  walk(cfg, '')
  return hits
}

export async function offlineCheck(o: { sourceHome: string; home: string; files: BatchFile[]; sizesAndRows?: boolean }): Promise<CheckOutcome & { task: { id: string; title: string } | null; note: ReadBackNote | null }> {
  const problems: string[] = []
  const exact = o.sizesAndRows !== false
  let missing = 0
  const intoOld = configPathsInto(o.home, o.sourceHome)
  if (intoOld.length) problems.push(`config.yaml names the old home's folder (${intoOld.slice(0, 5).join(', ')}): the new leader would keep using the old machine's files`)
  for (const f of o.files) {
    let size = -1
    // The promotion rewrote these two for the new home (promote.ts): present is enough.
    if (REWRITTEN.has(f.p)) { if (!fs.existsSync(path.join(o.home, f.p))) problems.push(`${f.p}: missing`); continue }
    try { size = fs.statSync(path.join(o.home, f.p)).size } catch { /* missing */ }
    if (size < 0 || (exact && size !== f.size)) {
      missing++
      if (missing <= 5) problems.push(`${f.p}: ${size < 0 ? 'missing' : `size ${size}, the batch has ${f.size}`}`)
    }
  }
  if (missing > 5) problems.push(`... ${missing - 5} more files missing or of another size`)
  const dbs = o.files.filter((f) => f.db).map((f) => f.p).sort()
  const counts: Record<string, { copy?: number; source?: number }> = {}
  let task: { id: string; title: string } | null = null
  await Promise.all(dbs.map(async (rel) => {
    const [copy, source] = await Promise.all([
      inspectSqliteOffThread(path.join(o.home, rel), rel === 'tasks/tasks.sqlite' ? { query: TASK_QUERY } : {}),
      inspectSqliteOffThread(path.join(o.sourceHome, rel), rel === 'tasks/tasks.sqlite' ? { query: TASK_QUERY } : {}),
    ])
    counts[rel] = { copy: copy.rows, source: source.rows }
    if (!copy.ok) problems.push(`${rel}: ${copy.detail ?? 'integrity check failed'} in the new home`)
    else if (exact && source.ok && !REWRITTEN.has(rel) && copy.rows !== source.rows) problems.push(`${rel}: ${copy.rows} rows in the new home, ${source.rows} in the old one`)
    if (rel === 'tasks/tasks.sqlite' && source.row && typeof source.row.id === 'string') task = { id: source.row.id, title: String(source.row.title ?? '') }
  }))
  const note = pickReadBackNote(o.files.map((f) => f.p))
  return { ok: problems.length === 0, problems, detail: { files: o.files.length, databases: counts }, task, note }
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

export async function onlineCheck(o: { side: SwitchSide; sourceHome: string; sourceVersion: string; task: { id: string; title: string } | null; note: ReadBackNote | null }): Promise<CheckOutcome> {
  const problems: string[] = []
  const detail: Record<string, unknown> = {}
  const st = await o.side.api('GET', '/api/leader/status').catch((err) => ({ status: 0, json: { error: String(err) } }))
  const s = st.json as { version?: string; permit?: { state?: string; mayAct?: boolean } } | null
  detail.status = s
  if (st.status !== 200 || !s?.version) problems.push(`the trial server's leader status did not answer (${st.status})`)
  else if (olderVersion(s.version, o.sourceVersion)) problems.push(`the trial server runs ${s.version}, older than ${o.sourceVersion} that wrote the data`)
  if (s?.permit?.mayAct) problems.push('the trial server says it may act: a trial must keep every outward door closed')
  // The newest task and a note of the old home, through the trial server (shared with the restore drill).
  const note = o.note ? { ...o.note, content: fs.readFileSync(path.join(o.sourceHome, o.note.rel), 'utf8') } : null
  const back = await readBackThroughServer((m, p) => o.side.api(m, p), { task: o.task, note })
  problems.push(...back.problems)
  if (o.task) detail.task = o.task.id
  if (o.note) detail.note = o.note.rel
  return { ok: problems.length === 0, problems, detail }
}
