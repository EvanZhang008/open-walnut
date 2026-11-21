/**
 * A plugin runs its program inside Walnut (core/sessions/plugin-run.ts), end to end, through the callers
 * the leader really sees: its job's `walnut.ops.call` online (the host daemon's anonymous caller
 * `external`, with the host it came from and no word of the plugin: daemon-connection.ts drops the job's
 * identity) creates a task with the `walnut:plugin-run` tag; its first turn ends and the task reads
 * Waiting on the program, not unread. The job's send and start keep it its run, as do a job's call on
 * its host's own replica (the plugin named, peers/capability-router.ts) and the server half's own call
 * (callPluginOp); `walnut.tasks.create` with the tag makes one too. Nobody else can create one, and an
 * unknown sid, a script naming itself, another task's session and a person each make a run a regular task.
 *
 * What's real: the server, the op executor and its self-calls, the plugin runtime, the task store,
 * the status sync, the session runner and the phase machine. Mocked: the daemon (MockDaemon, in this
 * process) and the Claude CLI (mock-claude.mjs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-program-run-job-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { executeOp } from '../../src/ops/index.js'
import { LOCAL_ORIGIN, hostOrigin } from '../../src/lib/caller-origin.js'
import { getTask } from '../../src/core/task-manager.js'
import { callPluginOp } from '../../src/core/plugins/server-api.js'
import { PLUGIN_RUN_TAG, type Task } from '../../src/core/types.js'
import { PROGRAM_RUN_WAIT } from '../../src/core/user-status.js'
import { PROGRAM_RUN_SESSION_REFUSAL } from '../../src/core/sessions/plugin-run.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const PLUGIN = 'acme'
/** A job's walnut.ops.call as the leader receives it online: the host daemon's anonymous caller. */
const JOB = { callerSid: 'external', callerHost: 'devbox', origin: hostOrigin('devbox') }
/** The same call on its host's own replica, which hears the job's identity (peers/capability-router.ts). */
const JOB_ON_REPLICA = { origin: LOCAL_ORIGIN, callerSid: 'plugin-job:0f1e2d3c4b5a', callerPluginId: PLUGIN, callerPluginJob: 'triage' }

/** A plugin whose server half makes a task through walnut.tasks.create. */
const PLUGIN_SERVER = `
export function activate(walnut) {
  walnut.registry.op({
    name: 'file', title: 'file', description: 'Program run probe: file a run', readonly: false, remote: 'deny',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
    handler: async (args) => walnut.tasks.create({ title: args.title, tags: args.tags }),
  })
}
`

let server: Server
let daemon: MockDaemon
let base = ''

async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${p}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as Record<string, any> }
}

async function until<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await probe()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    v = await probe()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 600)}`)
  return v
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const dir = path.join(WALNUT_HOME, 'plugins', PLUGIN)
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: PLUGIN, name: 'Acme Tickets', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs',
  }))
  await fs.writeFile(path.join(dir, 'dist', 'server.mjs'), PLUGIN_SERVER)
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 90_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

/** A run the job creates, after its first turn ended: read, Waiting on the program. */
async function jobRun(title: string): Promise<Task> {
  const created = await executeOp('task_create', { title, message: `Triage ${title} and draft a reply`, tags: [PLUGIN_RUN_TAG], cwd: '/tmp' }, { ...JOB, apiBase: base })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const result = (created as { result: Record<string, any> }).result
  const id = String(result.id ?? result.task?.id)
  expect((await getTask(id)).tags).toContain(PLUGIN_RUN_TAG)
  // The status sync derives it a moment after the phase moves: wait for the derived one.
  const ended = await until(`${title}: the first turn end`, () => getTask(id),
    (t) => t.phase === 'NEED_ACTION' && t.user_status?.waitingOn === PROGRAM_RUN_WAIT)
  expect(ended.unread).toBe(false)
  expect(ended.user_status).toMatchObject({ state: 'waiting', kind: 'outside', waitingOn: PROGRAM_RUN_WAIT })
  return ended
}

/** The next turn end after `after`, still the program's run (read, Waiting on the program). */
async function nextProgramTurnEnd(what: string, after: Task): Promise<Task> {
  const t = await until(what, () => getTask(after.id),
    (t) => (t.phase_changed_at ?? '') > (after.phase_changed_at ?? '') && t.phase === 'NEED_ACTION' && t.user_status?.waitingOn === PROGRAM_RUN_WAIT)
  expect(t.tags).toContain(PLUGIN_RUN_TAG)
  expect(t.unread).toBe(false)
  return t
}

describe("a plugin runs its program in Walnut", () => {
  it("only the plugin's own calls make and keep its run; anyone else's message makes it a regular task", async () => {
    // 1. The job's create, as its op call reaches the server.
    const ended = await jobRun('Ticket 42')
    const taskId = ended.id
    const sid = String(ended.session_id ?? ended.session_ids?.at(-1))
    expect(sid).toBeTruthy()

    // 2. Nobody but a program's own call creates a run: a session, a person, an unknown sid, a script
    // naming itself (by the route and by the op); a session's tag write cannot take the marker off.
    const script = { 'x-walnut-caller-kind': 'automation', 'x-walnut-sender': 'nightly-report' }
    for (const headers of [{ 'x-walnut-caller-sid': sid }, {}, { 'x-walnut-caller-sid': 'caller-not-tracked' }, script] as Array<Record<string, string>>) {
      const forged = await req('POST', '/api/v1/tasks', { title: 'Forged run', tags: [PLUGIN_RUN_TAG] }, headers)
      expect(forged.status, JSON.stringify(headers)).toBe(400)
      expect(JSON.stringify(forged.json)).toContain(PROGRAM_RUN_SESSION_REFUSAL.slice(0, 40))
    }
    const viaOp = await executeOp('task_create', { title: 'Forged by op', tags: [PLUGIN_RUN_TAG], record_only: true }, { origin: LOCAL_ORIGIN, apiBase: base, callerSid: sid })
    expect(viaOp.ok).toBe(false)
    const untag = await executeOp('task_update', { id: taskId, tags: ['sev:1'] }, { origin: LOCAL_ORIGIN, apiBase: base, callerSid: sid })
    expect(untag.ok, JSON.stringify(untag)).toBe(true)
    expect((await getTask(taskId)).tags).toContain(PLUGIN_RUN_TAG)

    // 3. The job's own follow-up and its own start of the next step keep it the program's run.
    const follow = await executeOp('task_send', { to: taskId, text: 'The customer replied: still broken', expect_reply: false }, { ...JOB, apiBase: base })
    expect(follow.ok, JSON.stringify(follow)).toBe(true)
    const again = await nextProgramTurnEnd('the follow-up turn end', ended)
    const restart = await executeOp('task_start', { id: taskId, message: 'Draft the second reply' }, { ...JOB, apiBase: base })
    expect(restart.ok, JSON.stringify(restart)).toBe(true)
    const third = await nextProgramTurnEnd('the started turn end', again)

    // 4. The same job on its host's own replica (its plugin named) and the plugin's server half keep it too.
    const fromReplica = await executeOp('task_send', { to: taskId, text: 'The customer sent logs', expect_reply: false }, { ...JOB_ON_REPLICA, apiBase: base })
    expect(fromReplica.ok, JSON.stringify(fromReplica)).toBe(true)
    const fourth0 = await nextProgramTurnEnd('the replica call\'s turn end', third)
    const fromServer = await callPluginOp(PLUGIN, 'task_send', { to: taskId, text: 'Escalated by the plugin', expect_reply: false }, LOCAL_ORIGIN)
    expect(fromServer.ok, JSON.stringify(fromServer)).toBe(true)
    const fourth = await nextProgramTurnEnd('the server half\'s turn end', fourth0)

    // 5. walnut.tasks.create with the tag files a run, and so does the job's create on its host's replica.
    const filed = await until('the plugin\'s op', () => req('POST', `/api/plugin-runtime/${PLUGIN}/ops/${PLUGIN}_file`, { title: 'Ticket 44', tags: [PLUGIN_RUN_TAG] }), (r) => r.json?.ok === true)
    expect((await getTask(String(filed.json.result.id))).tags).toContain(PLUGIN_RUN_TAG)
    const onReplica = await executeOp('task_create', { title: 'Ticket 46', tags: [PLUGIN_RUN_TAG], record_only: true }, { ...JOB_ON_REPLICA, apiBase: base })
    expect(onReplica.ok, JSON.stringify(onReplica)).toBe(true)
    const onReplicaResult = (onReplica as { result: Record<string, any> }).result
    expect((await getTask(String(onReplicaResult.id ?? onReplicaResult.task?.id))).tags).toContain(PLUGIN_RUN_TAG)

    // 6. A caller that is no program adopts: an unknown sid, and a script on the Mac that names itself.
    const second = await jobRun('Ticket 43')
    const unknown = await executeOp('task_send', { to: second.id, text: 'Looked at it by hand', expect_reply: false }, { origin: LOCAL_ORIGIN, apiBase: base, callerSid: 'caller-not-tracked' })
    expect(unknown.ok, JSON.stringify(unknown)).toBe(true)
    await until('the unknown sid\'s adoption', () => getTask(second.id), (t) => !(t.tags ?? []).includes(PLUGIN_RUN_TAG))
    const fifth = await jobRun('Ticket 47')
    const scripted = await req('POST', '/api/v1/messages', { to: fifth.id, text: 'Nightly report: still open', expect_reply: false, wake: true }, script)
    expect(scripted.status, JSON.stringify(scripted.json)).toBeLessThan(300)
    await until('the script\'s adoption', () => getTask(fifth.id), (t) => !(t.tags ?? []).includes(PLUGIN_RUN_TAG))

    // 7. Another task's message (a session's task_send) adopts a third run.
    const third2 = await jobRun('Ticket 45')
    const peer = await executeOp('task_send', { to: third2.id, text: 'Ticket 45 duplicates 42: close it', expect_reply: false }, { origin: LOCAL_ORIGIN, apiBase: base, callerSid: sid })
    expect(peer.ok, JSON.stringify(peer)).toBe(true)
    await until('the peer\'s adoption', () => getTask(third2.id), (t) => !(t.tags ?? []).includes(PLUGIN_RUN_TAG))

    // 8. A person's message: a regular task, whose next turn end is the user's to read.
    const person = await req('POST', `/api/v1/sessions/${sid}/messages`, { text: 'I will take this one from here' })
    expect(person.status, JSON.stringify(person.json)).toBeLessThan(300)
    const adopted = await until('the person\'s turn end', () => getTask(taskId),
      (t) => !(t.tags ?? []).includes(PLUGIN_RUN_TAG) && (t.phase_changed_at ?? '') > (fourth.phase_changed_at ?? '')
        && t.phase === 'NEED_ACTION' && t.unread === true && t.user_status?.state === 'read')
    expect(adopted.user_status).toMatchObject({ state: 'read', toRead: 'turn' })
  }, 240_000)
})
