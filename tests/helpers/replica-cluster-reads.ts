/**
 * What the host-local-call e2e tests of a replica cluster (tests/helpers/replica-cluster.ts)
 * share: read-only looks at its files (the host daemon's journal, log and session streams, the
 * stores of the Mac and the replica read on disk, never through a server, a session CLI's env),
 * and a session's `walnut` call by either door it has on the host (the daemon's gateway socket,
 * the host call entry its daemon gave it).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { onTestFailed } from 'vitest'
import Database from '../../src/lib/sqlite.js'
import type { ReplicaCluster } from './replica-cluster.js'
import { createHostCallClient, type HostCallOutcome } from '../../src/providers/host-call-client-core.js'

/** A gateway answer: `{ok, result}` or `{ok:false, error}`. */
export type GatewayAnswer = Record<string, any>

/** The request line a session's CLI sends for one tool call (wn-cli.ts). */
function callLine(sid: string, name: string, args: Record<string, unknown>, callId?: string): Record<string, unknown> {
  return { v: 1, op: 'tools.call', sid, args: { name, args, ...(callId ? { callId } : {}) } }
}

/** One `walnut` call on the host daemon's gateway socket, as a session's CLI sends it (the old door). */
export function gatewayCall(c: ReplicaCluster, sid: string, name: string, args: Record<string, unknown>, callId?: string): Promise<GatewayAnswer> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(c.base, 'hd', 'agent-gateway.sock'))
    let buf = ''
    sock.on('connect', () => sock.write(JSON.stringify(callLine(sid, name, args, callId)) + '\n'))
    sock.on('data', (d) => {
      buf += d.toString()
      if (buf.includes('\n')) { sock.destroy(); resolve(JSON.parse(buf.slice(0, buf.indexOf('\n')))) }
    })
    sock.on('error', reject)
  })
}

/** The entry env a session's CLI was given (every WALNUT_CALL_* variable: its address and its token). */
export function callEnvOf(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('WALNUT_CALL_')))
}

/** Whether the client a session's `walnut` uses (host-call-client-core.ts) takes `callEnv` as an entry. */
export function entryGiven(callEnv: Record<string, string>): boolean {
  return createHostCallClient({ http, env: callEnv }).entry() !== null
}

/**
 * The same line through the host call entry (the new door), by the client a session's `walnut`
 * uses (host-call-client-core.ts), with the entry env its daemon gave the session (callEnvOf):
 * the entry's answer, or why it did not take the line.
 */
export function entryCall(callEnv: Record<string, string>, sid: string, name: string, args: Record<string, unknown>, callId?: string, timeoutMs = 90_000): Promise<HostCallOutcome> {
  return createHostCallClient({ http, env: callEnv }).post(callLine(sid, name, args, callId), timeoutMs)
}

/** The host daemon's log lines (JSON, in order), every file of it. */
export function hostDaemonLog(c: ReplicaCluster): Array<Record<string, any>> {
  const dir = path.join(c.base, 'hd')
  let names: string[] = []
  try { names = fs.readdirSync(dir).filter((n) => /^daemon-.*\.log$/.test(n)).sort() } catch { return [] }
  const out: Array<Record<string, any>> = []
  for (const n of names) {
    for (const line of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) {
      if (!line) continue
      try { out.push(JSON.parse(line) as Record<string, any>) } catch { /* partial */ }
    }
  }
  return out
}

/** Lines of the host daemon's log written since `from` (ms). */
export const logSince = (c: ReplicaCluster, from: number) => hostDaemonLog(c).filter((l) => Date.parse(String(l.ts)) >= from)

/**
 * The env of the mock CLI running session `sid` (its command line names the cluster's copy of the
 * mock and the sid), read from /proc: null when no such process runs, or where /proc is not there.
 */
export function sessionCliEnv(c: ReplicaCluster, sid: string): Record<string, string> | null {
  let ps = ''
  try { ps = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 << 20 }) } catch { return null }
  const mock = path.join(c.base, 'bin', 'mock-claude.cjs')
  const row = ps.split('\n').map((l) => l.trim()).find((l) => l.includes(` ${mock} `) && new RegExp(`--(session-id|resume) ${sid}(\\s|$)`).test(l))
  if (!row) return null
  const pid = Number(row.slice(0, row.indexOf(' ')))
  let raw = ''
  try { raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8') } catch { return null }
  const env: Record<string, string> = {}
  for (const kv of raw.split('\0')) { const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1) }
  return env
}

/** On a failure: the cluster's logs in a file that outlives it, its path printed. */
export function keepLogsOnFailure(c: () => ReplicaCluster | undefined, label: string): void {
  onTestFailed(() => {
    const cl = c()
    if (cl) process.stdout.write(`replica-cluster: ${label} logs at ${writeClusterLogs(cl, label)}\n`)
  })
}

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

/** How many messages holding `text` were delivered into `sid` on the host (the daemon's marker of each delivered line). */
export const deliveries = (c: ReplicaCluster, sid: string, text: string) => hostStream(c, sid).filter((l) => l.type === 'user' && l.subtype === 'walnut-injected' && JSON.stringify(l.message ?? '').includes(text)).length
export const delivered = (c: ReplicaCluster, sid: string, text: string) => deliveries(c, sid, text) > 0
/** How many turns of `sid` answered `text` (the mock echoes the words it got). */
export const turnsWith = (c: ReplicaCluster, sid: string, text: string) => hostStream(c, sid).filter((l) => l.type === 'result' && String(l.result).includes(text)).length
/** The outermost user rows under `v` whose text holds `needle` (a transcript's messages holding it). */
export function userRowsWith(v: unknown, needle: string): number {
  if (Array.isArray(v)) return v.reduce((n, x) => n + userRowsWith(x, needle), 0)
  if (!v || typeof v !== 'object') return 0
  const o = v as Record<string, unknown>
  if ((o.role === 'user' || o.type === 'user') && JSON.stringify(o).includes(needle)) return 1
  return Object.values(o).reduce<number>((n, x) => n + userRowsWith(x, needle), 0)
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

/**
 * On a failure: the cluster's logs (the Mac, the replica, the host daemon) in a file that outlives
 * it, under REPLICA_CLUSTER_LOG_DIR when set (a container's own /tmp goes with it), else /tmp.
 */
export function writeClusterLogs(c: ReplicaCluster, label: string): string {
  const dir = process.env.REPLICA_CLUSTER_LOG_DIR || '/tmp'
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `rcl-${label}-${Date.now()}.log`)
  let daemon = ''
  try {
    for (const n of fs.readdirSync(path.join(c.base, 'hd')).filter((n) => /^daemon-.*\.log$/.test(n))) daemon += fs.readFileSync(path.join(c.base, 'hd', n), 'utf8').slice(-400_000)
  } catch { /* gone */ }
  // REPLICA_CLUSTER_LOG_WHOLE=1: the replica's whole server log, not its tail.
  const l = c.logs(process.env.REPLICA_CLUSTER_LOG_WHOLE === '1' ? { whole: true } : undefined)
  fs.writeFileSync(out, `--- mac ---\n${l.mac}\n--- replica ---\n${l.replica}\n--- host daemon ---\n${daemon}\n`)
  return out
}
