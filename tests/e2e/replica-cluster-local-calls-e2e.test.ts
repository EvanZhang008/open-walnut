/**
 * A host's own `walnut` calls while the Mac is away, end to end, every piece a real process
 * (tests/helpers/replica-cluster.ts): the Mac server with its daemon, the host daemon twin,
 * and the replica that daemon starts, which gets the `host-local-calls` capability from the
 * Mac's host server manager (the daemon says `follower-gateway-v1`).
 *
 *   a session on the host calls `walnut` over the daemon's gateway socket, as its CLI does,
 *   while the Mac sleeps (SIGSTOP): the daemon finds no leader and hands each call to the
 *   replica, which runs the Mac's own task logic on its copies:
 *     task_create with a start  the task is journaled, and its session starts on the host
 *                               (its project's default host), from the Mac's plain-session
 *                               template, journaled as the task's own session (`run: 'task'`)
 *     task_update tags          journaled
 *     task_send to that task    sent right after the create: delivered to its new session
 *   the Mac wakes: it holds that task and that session exactly once, with the tags; a second
 *   drain (the Mac asleep and awake again) changes nothing.
 *
 * The plugin-job caller takes the same replica path with the job as the actor; its daemon
 * side (a job's call handed over with no fallback) is pinned in
 * tests/providers/follower-gateway-core.test.ts and tests/providers/offline-host-local-calls.test.ts.
 *
 * Twins: as tests/e2e/replica-cluster-e2e.test.ts (REPLICA_CLUSTER_TWINS picks).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, startReplicaCluster, waitFor, WINDOWS, type ReplicaCluster, type Twin } from '../helpers/replica-cluster.js'
import { gatewayCall, hostJournal as journal, hostStream, keepLogsOnFailure, macSessions, macTasks, replicaKnowsDefaultHost } from '../helpers/replica-cluster-reads.js'

const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? (BUN ? 'source,standalone' : 'source')).split(',').map((t) => t.trim()).filter((t): t is Twin => t === 'source' || t === 'standalone')
const TITLE = 'Sync the venue list on the host'

describe.each(TWINS)('a host\'s own walnut calls while the Mac is away (%s twin)', (twin) => {
  let c: ReplicaCluster
  let token = ''
  let hostCwd = ''
  let callerSid = ''
  let taskId = ''
  let startedSid = ''

  beforeAll(async () => {
    c = await startReplicaCluster({ twin })
    process.stdout.write(`replica-cluster-local-calls-e2e: ${twin} cluster at ${c.base}\n`)
    hostCwd = fs.realpathSync(path.join(c.base, 'hh', 'work'))
    token = await c.pairDevice('marina-phone')
    // The project's sessions run on the host, in its work folder.
    const meta = await c.mac('PUT', `/api/v1/projects/${encodeURIComponent('Acme')}/metadata`, { default_host: 'devbox', default_cwd: hostCwd })
    expect(meta.status, JSON.stringify(meta.json)).toBeLessThan(300)
    // The calling session: a task's session on the host.
    const made = await c.mac('POST', '/api/tasks', { title: 'Host caller', project: 'Acme' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    const st = await c.mac('POST', `/api/v1/tasks/${made.json.task.id}/start`, { host: 'devbox', cwd: hostCwd, mode: 'default', message: 'hello host' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    callerSid = st.json.sessionId as string
    await waitFor(() => hostStream(c, callerSid).some((l) => l.type === 'result' && String(l.result).includes('hello host')), 120_000, 'the caller session to answer')
    await waitFor(() => ((c.stores().sessions as { hashes?: Record<string, string> } | null)?.hashes ?? {})[callerSid] ? true : null, 120_000, 'the copies to hold the caller session')
    // The replica says it answers local calls (its capability, from the manager's env).
    await waitFor(async () => {
      const cfg = await c.replica('GET', '/api/config', { token })
      return cfg.status === 200 ? true : null
    }, 60_000, 'the replica to answer')
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('while the Mac sleeps: a task made and started on the host, its tags changed, and a message delivered to its session', async () => {
    keepLogsOnFailure(() => c, `local-calls-${twin}`)
    // The project's defaults are in the replica's copy (where the start is decided) before the Mac
    // sleeps: read on disk, since the replica forwards a read to the Mac while it answers.
    await waitFor(() => (replicaKnowsDefaultHost(c, 'Acme', 'devbox') ? true : null), 60_000, 'the replica\'s copy to hold the project\'s default host')
    const slept = c.sleepMac()
    await c.waitAway(token)
    // The replica calls the Mac away after one failed forward (4 s), the daemon's gateway after
    // its trusted-client beats; the daemon takes the replica's writes only once the Mac has been
    // quiet for its whole window (LEADER_QUIET_MS). Before that, a call handed over comes back
    // (needs_leader) to the daemon's own away answer, as it does today.
    const quietAt = slept.after + WINDOWS.quietMs + 1_000
    if (Date.now() < quietAt) await new Promise((r) => setTimeout(r, quietAt - Date.now()))

    const created = await gatewayCall(c, callerSid, 'task_create', { title: TITLE, project: 'Acme', message: 'start on the host' })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    taskId = String(created.result.id ?? created.result.task?.id ?? '')
    expect(taskId).not.toBe('')
    // At once, with no wait for the copy: the replica shows the session it started (noteStarted),
    // so the message finds it on this host instead of answering that it needs the Mac.
    const sent = await gatewayCall(c, callerSid, 'task_send', { to: taskId, text: 'sent right after the start', expect_reply: false })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    const start = await waitFor(() => journal(c).find((r) => r.kind === 'session' && r.taskId === taskId), 60_000, 'the task\'s session record')
    expect(start).toMatchObject({ run: 'task', host: 'devbox', cwd: hostCwd })
    startedSid = String(start.sid)
    expect(journal(c).filter((r) => r.kind === 'task-create' && r.taskId === taskId)).toHaveLength(1)
    expect(journal(c).find((r) => r.kind === 'task-create' && r.taskId === taskId)?.actor).toEqual({ kind: 'session', sid: callerSid })
    // Only one session for the task: the message went to the one the start made.
    expect(journal(c).filter((r) => r.kind === 'session' && r.taskId === taskId)).toHaveLength(1)

    const tagged = await gatewayCall(c, callerSid, 'task_update', { id: taskId, tags: ['team:acme'] })
    expect(tagged.ok, JSON.stringify(tagged)).toBe(true)
    expect(journal(c).some((r) => r.kind === 'task-fields' && r.taskId === taskId && JSON.stringify(r.fields ?? {}).includes('team:acme'))).toBe(true)
    await waitFor(() => hostStream(c, startedSid).some((l) => l.type === 'result' && String(l.result).includes('sent right after the start')), 120_000, 'the message to reach the started session')
  }, 420_000)

  it('the Mac wakes: it holds that task and its session exactly once; a second drain changes nothing', async () => {
    keepLogsOnFailure(() => c, `local-calls-${twin}`)
    c.wakeMac()
    await c.waitBack(token)
    let seen = ''
    const once = async () => {
      const tasks = macTasks(c).filter((t) => t.title === TITLE)
      const sessions = macSessions(c).filter((s) => s.claude_session_id === startedSid || s.task_id === taskId)
      seen = JSON.stringify({ tasks, sessions, startedSid })
      return tasks.length === 1 && sessions.filter((s) => s.claude_session_id === startedSid).length === 1 && String(tasks[0]!.tags ?? '').includes('team:acme') ? { tasks, sessions } : null
    }
    const first = await waitFor(once, 180_000, 'the Mac to hold the task and its session').catch((e: Error) => { e.message += ` (the Mac holds ${seen})`; throw e })
    expect(first.tasks[0]!.id).toBe(taskId)
    expect(first.sessions[0]).toMatchObject({ task_id: taskId, host: 'devbox' })
    // Asleep and awake again: the Mac drains on its reconnect, and nothing changes.
    c.sleepMac()
    await c.waitAway(token)
    c.wakeMac()
    await c.waitBack(token)
    await new Promise((r) => setTimeout(r, 5_000))
    expect(macTasks(c).filter((t) => t.title === TITLE)).toHaveLength(1)
    expect(macSessions(c).filter((s) => s.claude_session_id === startedSid)).toHaveLength(1)
    expect(macSessions(c).filter((s) => s.task_id === taskId)).toHaveLength(1)
  }, 600_000)
})
