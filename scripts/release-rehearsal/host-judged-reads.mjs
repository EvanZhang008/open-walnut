/**
 * What the host-judged rollback scenarios (host-judged-rollback.mjs, host-judged-old-host.mjs) read
 * and do through whichever leader serves the Mac's port, and on the host's files: the leader's
 * frozen API (/api/v1, which an older release answers the same) and the session's stream on the host.
 */
import fs from 'node:fs'
import path from 'node:path'
import { HOST_KEY, waitFor } from '../../tests/helpers/replica-cluster.ts'
import { hostStream } from '../../tests/helpers/replica-cluster-reads.ts'
import { clusterDirs } from './host-judged-leaders.mjs'

/** The reads every scenario makes of the leader on the Mac's port (whichever build serves it). */
export function leaderReads(h) {
  const api = (method, p, body) => h.c.mac(method, p, body)
  const history = async (sid) => {
    const r = await api('GET', `/api/v1/sessions/${sid}/history?tail=500`)
    return Array.isArray(r.json?.messages) ? r.json.messages : []
  }
  /** How many assistant messages of `sid`'s history hold `needle`. */
  const answers = async (sid, needle) => (await history(sid)).filter((m) => m.role === 'assistant' && typeof m.text === 'string' && m.text.includes(needle)).length
  const waitAnswer = (sid, needle, ms = 120_000) => waitFor(async () => (await answers(sid, needle)) > 0, ms, `"${needle}" in ${sid}'s history`, 500)
  const session = async (sid) => { const r = await api('GET', `/api/sessions/${sid}`); return r.status === 200 ? (r.json?.session ?? r.json) : { status: r.status } }
  const task = async (id) => { const r = await api('GET', `/api/tasks/${id}`); return r.status === 200 ? (r.json?.task ?? r.json) : { status: r.status } }
  const send = (sid, text) => api('POST', '/api/v1/messages', { to: sid, text })
  return { api, history, answers, waitAnswer, session, task, send }
}

/** A task on the host and its first message; resolves the task id and the session id. */
export async function startOn(h, title, message) {
  const t = await h.c.mac('POST', '/api/tasks', { title, project: 'Acme' })
  if (t.status !== 201) throw new Error(`POST /api/tasks answered ${t.status} ${JSON.stringify(t.json).slice(0, 300)}`)
  const cwd = clusterDirs(h).hostCwd
  const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd, mode: 'bypass', message })
  if (st.status !== 202) throw new Error(`start answered ${st.status} ${JSON.stringify(st.json).slice(0, 300)}`)
  return { taskId: t.json.task.id, sid: st.json.sessionId }
}

/** The stream of `sid` on the host, counted: turns started, lines delivered, results, and results holding each needle. */
export function streamCounts(h, sid, needles = []) {
  const lines = hostStream(h.c, sid)
  const results = lines.filter((l) => l.type === 'result')
  return {
    // A turn the CLI started (the mock says running at each one), and a line the daemon wrote into it.
    turns: lines.filter((l) => l.type === 'system' && l.subtype === 'session_state_changed' && l.state === 'running').length,
    delivered: lines.filter((l) => l.type === 'user' && l.subtype === 'walnut-injected').length,
    results: results.length,
    ...Object.fromEntries(needles.map((n) => [n, results.filter((l) => String(l.result).includes(n)).length])),
  }
}

/** The fields of a task and a session row that must read the same across a leader change. */
export const taskView = (t) => ({ id: t.id, title: t.title, project: t.project, phase: t.phase, status: t.status, session_ids: t.session_ids ?? t.sessionIds ?? null })
export const sessionView = (s) => ({ id: s.claudeSessionId ?? s.id, taskId: s.taskId ?? s.task_id, host: s.host ?? null, title: s.title ?? null, judge: s.judge ?? null })

/** Error lines of a leader's console log (its JSON log lines at level error, and stack heads). */
export function errorLines(text) {
  return text.split('\n').filter((l) => /"level":"(error|fatal)"|\bFATAL\b|Unhandled|uncaught/i.test(l)).map((l) => l.slice(0, 400)).slice(-40)
}

/** Every log file under a cluster's base (a few levels down, each at most 16 MB) copied to `dest`, its path flattened. */
export function keepLogs(base, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const walk = (dir, depth) => {
    let names = []
    try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const n of names) {
      const p = path.join(dir, n.name)
      if (n.isDirectory()) { if (depth > 0 && n.name !== 'node_modules' && n.name !== 'prefix') walk(p, depth - 1); continue }
      if (!n.isFile() || !/\.(log|jsonl)$/.test(n.name)) continue
      try { if (fs.statSync(p).size <= 16 << 20) fs.copyFileSync(p, path.join(dest, path.relative(base, p).split(path.sep).join('__'))) } catch { /* went */ }
    }
  }
  walk(base, 5)
  return dest
}
