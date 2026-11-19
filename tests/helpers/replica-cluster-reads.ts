/**
 * Read-only looks at a replica cluster's files (tests/helpers/replica-cluster.ts) that the
 * host-local-call e2e tests share: the host daemon's journal and session streams, and the
 * stores of the Mac and the replica read on disk (never through a server).
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from '../../src/lib/sqlite.js'
import type { ReplicaCluster } from './replica-cluster.js'

/** The host daemon's journal records (every line with a seq, latest by seq). */
export function hostJournal(c: ReplicaCluster): Array<Record<string, any>> {
  const dir = path.join(c.base, 'hd', 'offline-host')
  const bySeq = new Map<number, Record<string, any>>()
  let names: string[] = []
  try { names = fs.readdirSync(dir).filter((n) => /^journal-.*\.ndjson$/.test(n)) } catch { /* none yet */ }
  for (const n of names) {
    for (const line of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) {
      try { const o = JSON.parse(line) as Record<string, any>; if (typeof o.seq === 'number') bySeq.set(o.seq, o) } catch { /* partial */ }
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** A session's stream on the host (what its CLI wrote). */
export function hostStream(c: ReplicaCluster, sid: string): Array<Record<string, any>> {
  try {
    return fs.readFileSync(path.join(c.base, 'hd', 'streams', `${sid}.jsonl`), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, any> } catch { return {} } })
  } catch { return [] }
}

function rowsOf(dir: string, sql: string, file: string, params: unknown[]): Array<Record<string, any>> {
  const db = new Database(path.join(dir, file), { readonly: true, fileMustExist: true })
  try { return db.prepare(sql).all(...params) as Array<Record<string, any>> } finally { db.close() }
}
export const macRows = (c: ReplicaCluster, sql: string, file: string, ...params: unknown[]) => rowsOf(c.macData, sql, file, params)
export const replicaRows = (c: ReplicaCluster, sql: string, file: string, ...params: unknown[]) => rowsOf(c.replicaData, sql, file, params)
export const macTasks = (c: ReplicaCluster) => macRows(c, 'SELECT id, title, project, tags, parent_task_id, pinned, payload FROM tasks', path.join('tasks', 'tasks.sqlite'))
export const macSessions = (c: ReplicaCluster) => macRows(c, 'SELECT claude_session_id, task_id, host FROM sessions', 'sessions.sqlite')

/** Whether the replica's copy holds `project`'s default host (the start is decided there). */
export function replicaKnowsDefaultHost(c: ReplicaCluster, project: string, host: string): boolean {
  const rows = replicaRows(c, 'SELECT metadata FROM task_projects WHERE name = ?', path.join('tasks', 'tasks.sqlite'), project)
  return String(rows[0]?.metadata ?? '').includes(host)
}

/** On a failure: the cluster's logs (the Mac, the replica, the host daemon) in a file that outlives it. */
export function writeClusterLogs(c: ReplicaCluster, label: string): string {
  const out = path.join('/tmp', `rcl-${label}-${Date.now()}.log`)
  let daemon = ''
  try {
    for (const n of fs.readdirSync(path.join(c.base, 'hd')).filter((n) => /^daemon-.*\.log$/.test(n))) daemon += fs.readFileSync(path.join(c.base, 'hd', n), 'utf8').slice(-40_000)
  } catch { /* gone */ }
  const l = c.logs()
  fs.writeFileSync(out, `--- mac ---\n${l.mac}\n--- replica ---\n${l.replica}\n--- host daemon ---\n${daemon}\n`)
  return out
}
