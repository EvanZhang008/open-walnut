/**
 * A plugin job's `walnut.ops` calls while the Mac is away, end to end, every piece a real
 * process (tests/helpers/replica-cluster.ts with a plugin): the Mac server with its daemon,
 * the host daemon twin, the replica that daemon starts (`host-local-calls`), and the plugin's
 * job, which the Mac bundles and places on the host (`plugin_jobs.acme-sync.run_on: devbox`,
 * WALNUT_PLUGIN_JOBS_IN_TEST=1) and the host daemon runs as its own `walnut plugin-job`.
 *
 *   the Mac sleeps (SIGSTOP); the JOB, told by a file in its own state dir, calls:
 *     task_create with a start   journaled with the job as its actor, its session started on
 *                                the host (the project's default host) as the task's own
 *     task_update tags           journaled, the job as actor
 *     task_send to that task     delivered to its session on the host
 *   the plugin keeps its tasks to its own view (`taskVisibility: "plugin"`): the replica, which
 *   loads no manifest, has the Mac's word for it (its spec's settings), so the task is absent
 *   from the replica's board list and there for the job's own task_get
 *   the Mac wakes: it holds that task (an outside caller's create: no parent, kept to the
 *   plugin) and its session exactly once, with the tags; asleep and awake again, nothing changes.
 *
 * Twins: as tests/e2e/replica-cluster-e2e.test.ts (REPLICA_CLUSTER_TWINS picks).
 */
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, startReplicaCluster, waitFor, WINDOWS, type ReplicaCluster, type Twin } from '../helpers/replica-cluster.js'
import { hostJournal, hostStream, macSessions, macTasks, replicaKnowsDefaultHost, writeClusterLogs } from '../helpers/replica-cluster-reads.js'

const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? (BUN ? 'source,standalone' : 'source')).split(',').map((t) => t.trim()).filter((t): t is Twin => t === 'source' || t === 'standalone')
const TITLE = 'Import the venue rows'
const JOB = { kind: 'plugin-job', plugin: 'acme-sync', job: 'worker' }

/**
 * The plugin: no server half to speak of, and one long-running job that runs the op named
 * in `<state dir>/cmd-<n>.json` and writes its answer to `res-<n>.json`, one after another.
 */
const SERVER = `
import fs from 'node:fs'
import path from 'node:path'
export function activate() {}
export const jobs = {
  async worker(walnut, signal) {
    const dir = JSON.parse(process.env.WALNUT_PLUGIN_JOB).stateDir
    fs.writeFileSync(path.join(dir, 'job-ready.json'), JSON.stringify({ pid: process.pid, dir }))
    let n = 1
    while (!signal.aborted) {
      const file = path.join(dir, 'cmd-' + n + '.json')
      if (!fs.existsSync(file)) { await new Promise((r) => setTimeout(r, 100)); continue }
      const c = JSON.parse(fs.readFileSync(file, 'utf8'))
      let out
      try { out = { ok: true, result: await walnut.ops.call(c.name, c.args) } } catch (e) { out = { ok: false, code: e.code, message: e.message } }
      fs.writeFileSync(path.join(dir, 'res-' + n + '.json'), JSON.stringify(out))
      n++
    }
  },
}
`
const PLUGIN = {
  id: 'acme-sync',
  runOn: 'devbox',
  files: {
    'manifest.json': JSON.stringify({ id: 'acme-sync', name: 'Acme sync', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs', taskVisibility: 'plugin', jobs: { worker: { kind: 'long-running' } } }),
    'dist/server.mjs': SERVER,
  },
}

/** The job's state dir on the host, once its run said it is ready. */
function jobDir(c: ReplicaCluster): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { return null }
    if (names.includes('job-ready.json')) return dir
    if (depth <= 0) return null
    for (const n of names) {
      const full = path.join(dir, n)
      try { if (!fs.statSync(full).isDirectory()) continue } catch { continue }
      const hit = walk(full, depth - 1)
      if (hit) return hit
    }
    return null
  }
  return walk(path.join(c.base, 'hd'), 6)
}

let callN = 0
/** One op the job runs, and its answer. */
async function jobCall(dir: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const n = ++callN
  fs.writeFileSync(path.join(dir, `cmd-${n}.json.tmp`), JSON.stringify({ name, args }))
  fs.renameSync(path.join(dir, `cmd-${n}.json.tmp`), path.join(dir, `cmd-${n}.json`))
  const res = path.join(dir, `res-${n}.json`)
  await waitFor(() => (fs.existsSync(res) ? true : null), 120_000, `the job's answer to ${name}`)
  return JSON.parse(fs.readFileSync(res, 'utf8')) as Record<string, any>
}

describe.each(TWINS)('a plugin job\'s walnut calls on its host while the Mac is away (%s twin)', (twin) => {
  let c: ReplicaCluster
  let token = ''
  let hostCwd = ''
  let dir = ''
  let taskId = ''
  let startedSid = ''
  let createOp = ''

  const keepLogs = () => onTestFailed(() => {
    if (c) process.stdout.write(`replica-cluster-plugin-job-e2e: logs at ${writeClusterLogs(c, `plugin-job-${twin}`)}\n`)
  })

  beforeAll(async () => {
    callN = 0
    c = await startReplicaCluster({ twin, plugin: PLUGIN })
    process.stdout.write(`replica-cluster-plugin-job-e2e: ${twin} cluster at ${c.base}\n`)
    hostCwd = fs.realpathSync(path.join(c.base, 'hh', 'work'))
    token = await c.pairDevice('marina-phone')
    const meta = await c.mac('PUT', `/api/v1/projects/${encodeURIComponent('Acme')}/metadata`, { default_host: 'devbox', default_cwd: hostCwd })
    expect(meta.status, JSON.stringify(meta.json)).toBeLessThan(300)
    await waitFor(() => (replicaKnowsDefaultHost(c, 'Acme', 'devbox') ? true : null), 120_000, 'the replica\'s copy to hold the project\'s default host')
    // The Mac bundled the job and placed it on the host, whose daemon runs it.
    dir = await waitFor(() => jobDir(c), 180_000, 'the plugin job to run on the host').catch(async (e: Error) => {
      const jobs = await c.mac('GET', '/api/plugin-runtime/acme-sync/jobs').catch((x: Error) => ({ status: 0, json: x.message }))
      const plugins = await c.mac('GET', '/api/plugin-runtime').catch((x: Error) => ({ status: 0, json: x.message }))
      e.message += ` (jobs: ${JSON.stringify(jobs.json).slice(0, 1500)}; plugins: ${JSON.stringify(plugins.json).slice(0, 1500)}; logs at ${writeClusterLogs(c, `plugin-job-${twin}-boot`)})`
      throw e
    })
    // While the Mac answers, the job's call goes to it.
    const online = await jobCall(dir, 'task_list', { limit: 1 })
    expect(online.ok, JSON.stringify(online)).toBe(true)
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('while the Mac sleeps: the job makes a task that starts on the host, tags it and sends it a message', async () => {
    keepLogs()
    const slept = c.sleepMac()
    await c.waitAway(token)
    const quietAt = slept.after + WINDOWS.quietMs + 1_000
    if (Date.now() < quietAt) await new Promise((r) => setTimeout(r, quietAt - Date.now()))

    const created = await jobCall(dir, 'task_create', { title: TITLE, project: 'Acme', message: 'import the rows' })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    taskId = String(created.result.id ?? created.result.task?.id ?? '')
    expect(taskId).not.toBe('')
    const make = hostJournal(c).filter((r) => r.kind === 'task-create' && r.taskId === taskId)
    expect(make).toHaveLength(1)
    expect(make[0]!.actor).toEqual(JOB)
    createOp = String(make[0]!.opId)
    const start = await waitFor(() => hostJournal(c).find((r) => r.kind === 'session' && r.taskId === taskId), 60_000, 'the task\'s session record')
    expect(start).toMatchObject({ run: 'task', host: 'devbox', cwd: hostCwd, actor: JOB })
    startedSid = String(start.sid)
    await waitFor(() => hostStream(c, startedSid).some((l) => l.type === 'result'), 120_000, 'the started session to answer')

    const tagged = await jobCall(dir, 'task_update', { id: taskId, tags: ['source:acme'] })
    expect(tagged.ok, JSON.stringify(tagged)).toBe(true)
    const fields = hostJournal(c).find((r) => r.kind === 'task-fields' && r.taskId === taskId)
    expect(fields?.actor).toEqual(JOB)

    const sent = await jobCall(dir, 'task_send', { to: taskId, text: 'rows are in', expect_reply: false })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await waitFor(() => hostStream(c, startedSid).some((l) => l.type === 'result' && String(l.result).includes('rows are in')), 120_000, 'the message to reach the started session')

    // Kept to the plugin's view: not on the replica's board, there for the job's own read.
    const board = await c.replica('GET', '/api/tasks', { token })
    expect(board.status, board.text.slice(0, 500)).toBe(200)
    const listed = ((board.json.tasks ?? board.json) as Array<{ id: string }>).map((t) => t.id)
    expect(listed).not.toContain(taskId)
    const own = await jobCall(dir, 'task_get', { id: taskId })
    expect(own.ok, JSON.stringify(own)).toBe(true)
    expect(JSON.stringify(own.result)).toContain(taskId)
    expect(JSON.stringify(own.result)).toContain('"plugin_only":"acme-sync"')
  }, 420_000)

  it('the Mac wakes: it holds that task and its session exactly once; a second drain changes nothing', async () => {
    keepLogs()
    c.wakeMac()
    await c.waitBack(token)
    let seen = ''
    const once = () => {
      const tasks = macTasks(c).filter((t) => t.title === TITLE)
      const sessions = macSessions(c).filter((s) => s.claude_session_id === startedSid || s.task_id === taskId)
      seen = JSON.stringify({ tasks: tasks.map((t) => ({ ...t, payload: undefined })), sessions })
      return tasks.length === 1 && sessions.length === 1 && String(tasks[0]!.tags ?? '').includes('source:acme') ? { tasks, sessions } : null
    }
    const first = await waitFor(once, 180_000, 'the Mac to hold the task and its session').catch((e: Error) => { e.message += ` (the Mac holds ${seen})`; throw e })
    expect(first.tasks[0]!.id).toBe(taskId)
    // An outside caller's create, as the same job's call online: no caller parent.
    expect(first.tasks[0]!.parent_task_id ?? '').toBe('')
    expect(first.sessions[0]).toMatchObject({ claude_session_id: startedSid, task_id: taskId, host: 'devbox' })
    // Made by the journal's create, the job's (its op id), never by a second create; kept to the plugin.
    expect(createOp).not.toBe('')
    expect(String(first.tasks[0]!.payload ?? '')).toContain(createOp)
    expect(String(first.tasks[0]!.payload ?? '')).toContain('"plugin_only":"acme-sync"')
    c.sleepMac()
    await c.waitAway(token)
    c.wakeMac()
    await c.waitBack(token)
    await new Promise((r) => setTimeout(r, 5_000))
    expect(macTasks(c).filter((t) => t.title === TITLE)).toHaveLength(1)
    expect(macSessions(c).filter((s) => s.task_id === taskId)).toHaveLength(1)
  }, 600_000)
})
