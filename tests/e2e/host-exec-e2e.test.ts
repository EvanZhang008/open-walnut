/**
 * host_exec through a REAL server (core/hosts/host-exec.ts, exec-grants.ts,
 * routes/host-exec-v1.ts, ops/host-exec.ts): a task's session on one host runs
 * a command on another only under the user's grant, asked for by ONE letter;
 * the answer makes the grant and tells the session; the run comes back with
 * its exit code and output, a credential-looking line hidden; the user revokes
 * it and the next call asks again. Also: no session, the caller's own host, an
 * unknown host, a session trying to grant or revoke, the per-task cap.
 *
 * Real: the server, the inbox and its answer route, the grants file, the op
 * executor, and the host side (host-exec-core.ts with a real /bin/sh). Fake:
 * only the transport to the target host, which runs the host core in-process.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { guardedPath } from '../setup/exec-guard.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-exec-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import * as daemonConnections from '../../src/providers/daemon-connection.js'
import { createHostExec } from '../../src/providers/host-exec-core.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { resetHostExecForTest } from '../../src/core/hosts/host-exec.js'
import { onLetterAnswered } from '../../src/core/hosts/exec-grants.js'
import { answerLetter } from '../../src/core/human-inbox/store.js'

let server: HttpServer
let port: number
let hostRoot: string
const SID = 'host-exec-e2e-session'
const OTHER_SID = 'host-exec-e2e-other'
let taskId = ''
let otherTaskId = ''
const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []

async function api(method: string, p: string, body?: unknown, sid?: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

async function letters(): Promise<Array<{ id: string; subject: string; type: string }>> {
  const r = await api('GET', '/api/v1/human-inbox?limit=50')
  return (r.body.letters ?? r.body.items ?? []) as Array<{ id: string; subject: string; type: string }>
}

async function until(fn: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  hostRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-host-exec-e2e-')))
  await fs.mkdir(path.join(hostRoot, 'home', 'work'), { recursive: true })
  // The target host's daemon, in-process: the real host core, a real shell.
  const core = createHostExec({
    spawn: (await import('node:child_process')).spawn,
    killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
    shell: '/bin/sh', home: path.join(hostRoot, 'home'), taskDirRoot: path.join(hostRoot, 'tasks'),
    stateDir: path.join(hostRoot, 'state'), env: { PATH: guardedPath([], '/usr/bin:/bin') },
  })
  const macbox = {
    connected: true, hostKey: 'macbox', connect: async () => {},
    hasCapability: (c: string) => c === 'host-exec-v1',
    send: async (cmd: string, params: Record<string, unknown> = {}) => {
      sent.push({ cmd, params })
      if (String(params.command ?? '').includes('LOSE_THE_HOST')) throw new Error('socket closed')
      try {
        const op = cmd.slice('exec.'.length) as 'run' | 'read' | 'kill' | 'list'
        return { ok: true, ...(await (core[op] as (p: unknown) => Promise<Record<string, unknown>>)(params)) }
      } catch (err) {
        return { ok: false, error: `${cmd} failed: ${(err as Error).message}`, code: (err as { code?: string }).code }
      }
    },
  }
  // The caller's own host answers nothing (the server reads its session's cost there on its own).
  const devbox = { connected: true, hostKey: 'devbox', connect: async () => {}, hasCapability: () => false, send: async () => ({ ok: false, error: 'unknown command' }) }
  const real = daemonConnections.getDaemonConnection
  vi.spyOn(daemonConnections, 'getDaemonConnection').mockImplementation(async (key, target) =>
    key === 'macbox' ? macbox as unknown as daemonConnections.DaemonConnection
      : key === 'devbox' ? devbox as unknown as daemonConnections.DaemonConnection : real(key, target))
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await updateConfig({ hosts: { devbox: { hostname: 'devbox.example' }, macbox: { hostname: 'macbox.example', label: 'Mac box' } } })
  const created = await api('POST', '/api/v1/tasks', { title: 'Run the iOS tests' })
  taskId = created.body.task?.id ?? created.body.id
  await createSessionRecord(SID, taskId, '', '/home/me/repo', { host: 'devbox', title: 'iOS tests', initialProcessStatus: 'stopped' } as never)
  const other = await api('POST', '/api/v1/tasks', { title: 'Another task' })
  otherTaskId = other.body.task?.id ?? other.body.id
  await createSessionRecord(OTHER_SID, otherTaskId, '', '/home/me/other', { host: 'devbox', title: 'other', initialProcessStatus: 'stopped' } as never)
}, 120_000)

afterAll(async () => {
  await stopServer()
  vi.restoreAllMocks()
  resetHostExecForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(hostRoot, { recursive: true, force: true }).catch(() => {})
})

describe('host_exec', () => {
  it('refuses a caller that is not a task session, its own host, and an unknown host', async () => {
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' })).toMatchObject({ status: 403, body: { code: 'session_only' } })
    expect(await api('POST', '/api/v1/hosts/devbox/exec', { command: 'true' }, SID)).toMatchObject({ status: 400, body: { code: 'same_host' } })
    expect(await api('POST', '/api/v1/hosts/nosuch/exec', { command: 'true' }, SID)).toMatchObject({ status: 404, body: { code: 'unknown_host' } })
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true', argv: ['true'] }, SID)).toMatchObject({ status: 400, body: { code: 'bad_request' } })
    expect(sent).toEqual([])
  })

  it('asks the user once, runs after Allow, and hides a credential-looking line', async () => {
    // Two first calls at once: one letter.
    const firsts = await Promise.all([
      api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo hi' }, SID),
      api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo hi too' }, SID),
    ])
    for (const f of firsts) expect(f).toMatchObject({ status: 403, body: { code: 'exec_grant_required' } })
    const letterId = firsts[0].body.letterId as string
    expect(letterId).toBeTruthy()
    expect(firsts[1].body.letterId).toBe(letterId)
    // A second try while the user has not answered sends no second letter.
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo again' }, SID)).toMatchObject({ status: 403, body: { code: 'exec_grant_required', letterId } })
    const asks = (await letters()).filter((l) => l.subject.includes('" use '))
    expect(asks.map((l) => l.id)).toEqual([letterId])
    expect(asks[0]).toMatchObject({ type: 'action_required', subject: 'Let "Run the iOS tests" use Mac box?' })
    expect(sent).toEqual([])

    // A session may not grant itself, nor may another task answer Allow in the user's place.
    expect(await api('POST', '/api/v1/host-exec/grants', { task_id: taskId, host: 'macbox' }, SID)).toMatchObject({ status: 403, body: { code: 'human_only' } })
    // (The inbox already refuses this answer from a task; an Allow recorded for the user by
    // any task, past that check, still makes no grant.)
    expect((await api('POST', `/api/v1/human-inbox/${letterId}/answer`, { actionId: 'allow', user_words: 'yes, let that task run its commands there' }, OTHER_SID)).status).toBe(403)
    await answerLetter(letterId, { actionId: 'allow', by: { sessionId: OTHER_SID, taskId: otherTaskId } })
    await onLetterAnswered({ letterId, actionId: 'allow' })
    expect((await api('GET', '/api/v1/host-exec/grants')).body.grants).toEqual([])
    // That letter no longer asks the user anything: the next command writes a new one.
    const again = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, SID)
    expect(again).toMatchObject({ status: 403, body: { code: 'exec_grant_required' } })
    const letter2 = again.body.letterId as string
    expect(letter2).not.toBe(letterId)

    expect((await api('POST', `/api/v1/human-inbox/${letter2}/answer`, { actionId: 'allow' })).status).toBeLessThan(300)
    await until(async () => ((await api('GET', '/api/v1/host-exec/grants')).body.grants ?? []).length === 1, 'the grant')
    const [g] = (await api('GET', '/api/v1/host-exec/grants')).body.grants
    expect(g).toMatchObject({ taskId, host: 'macbox', via: 'letter', taskTitle: 'Run the iOS tests' })

    const ran = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'pwd; echo out; exit 4', cwd: '~/work' }, SID)
    expect(ran.status).toBe(200)
    expect(ran.body).toMatchObject({ host: 'macbox', running: false, exitCode: 4, cwd: path.join(hostRoot, 'home', 'work') })
    expect(ran.body.output).toBe(`${path.join(hostRoot, 'home', 'work')}\nout\n`)
    expect(sent.filter((m) => m.cmd === 'exec.run').at(-1)!.params).toMatchObject({ taskId, caller: { task: taskId, host: 'devbox' }, command: 'pwd; echo out; exit 4', background: true })

    const secret = await api('POST', '/api/v1/hosts/macbox/exec', { command: "printf '%s%s\\n' 'before' ''; printf '%s%s\\n' '-----BEGIN RSA ' 'PRIVATE KEY-----'; echo after" }, SID)
    // A key with no END line hides everything after its BEGIN.
    expect(secret.body.output).toBe('before\n[Walnut hid this line: it looks like a credential (private-key)]\n[Walnut hid this line: it looks like a credential (private-key)]\n')
    expect(secret.body.redactedLines).toBe(2)

    // A key's body is hidden to its END line, and past the scanner's 20 findings every token still goes.
    const tokens = Array.from({ length: 25 }, () => `ghp_${randomBytes(27).toString('base64url').replace(/[-_]/g, 'x').slice(0, 36)}`)
    const body = randomBytes(48).toString('base64')
    const lines = ['-----BEGIN OPENSSH PRIVATE KEY-----', body, body, '-----END OPENSSH PRIVATE KEY-----', 'ok', ...tokens.map((t) => `token ${t}`), 'tail']
    await fs.writeFile(path.join(hostRoot, 'home', 'work', 'leaky.txt'), lines.join('\n') + '\n')
    const many = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'cat leaky.txt', cwd: '~/work' }, SID)
    expect(many.status).toBe(200)
    const out = String(many.body.output)
    expect(out).not.toContain(body)
    for (const t of tokens) expect(out).not.toContain(t)
    expect(out).toContain('\nok\n')
    expect(out).toContain('\ntail\n')
    expect(many.body.redactedLines).toBe(4 + tokens.length)

    // The op an agent calls goes the same way, with its outcome line.
    const viaOp = await executeOp('host_exec', { host: 'macbox', argv: ['printf', '%s', 'a b'] },
      { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: SID }) as { ok: boolean; result: Record<string, unknown> }
    expect(viaOp).toMatchObject({ ok: true, result: { exitCode: 0, output: 'a b' } })
    expect(String(viaOp.result.outcome)).toMatch(/^Exit 0 on macbox/)
    await until(async () => ((await api('GET', '/api/v1/host-exec/grants')).body.grants[0].runs ?? 0) >= 3, 'the run count')
  }, 60_000)

  it('a run still going after 15 s comes back running; host_exec_read waits for it; only its task reads it', async () => {
    const t0 = Date.now()
    const slow = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'sleep 17; echo done', timeout_ms: 60_000 }, SID)
    expect(Date.now() - t0).toBeLessThan(17_000)
    expect(slow).toMatchObject({ status: 200, body: { running: true, jobId: expect.stringMatching(/^hx-/) } })
    // Another task's session may not read it (it has no grant there, and the job is not its).
    expect((await api('GET', `/api/v1/hosts/macbox/exec/${slow.body.jobId}`, undefined, OTHER_SID)).status).toBe(403)
    const done = await api('GET', `/api/v1/hosts/macbox/exec/${slow.body.jobId}?wait_ms=10000`, undefined, SID)
    expect(done.body).toMatchObject({ running: false, exitCode: 0, output: 'done\n' })
    // A host lost mid-answer is the host away, never a server error.
    // The host may have started it, so the answer names the job and its slot stays taken.
    const lost = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo LOSE_THE_HOST' }, SID)
    expect(lost).toMatchObject({ status: 503, body: { code: 'host_offline', mayHaveStarted: true, jobId: expect.stringMatching(/^hx-/) } })
    expect(lost.body.error).toContain('before running it again')
    resetHostExecForTest() // (that job never reached the fake host; free its slot for the next test)
  }, 60_000)

  it('reads and stops a background job, and caps a task at two at once', async () => {
    const a = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'sleep 30', background: true }, SID)
    const b = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo one; sleep 0.3; echo two', background: true }, SID)
    expect([a.body.running, b.body.running]).toEqual([true, true])
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, SID)).toMatchObject({ status: 429, body: { code: 'busy' } })
    // The second ends with nobody reading it: at the cap the server asks the host, and there is room.
    await new Promise((r) => setTimeout(r, 1_000))
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, SID)).status).toBe(200)
    expect(sent.some((m) => m.cmd === 'exec.list')).toBe(true)
    const done = await api('GET', `/api/v1/hosts/macbox/exec/${b.body.jobId}?offset=0&wait_ms=10000`, undefined, SID)
    expect(done.body).toMatchObject({ running: false, exitCode: 0, output: 'one\ntwo\n' })
    expect((await api('POST', `/api/v1/hosts/macbox/exec/${a.body.jobId}/stop`, undefined, SID)).status).toBe(200)
    const stopped = await api('GET', `/api/v1/hosts/macbox/exec/${a.body.jobId}?wait_ms=10000`, undefined, SID)
    expect(stopped.body.running).toBe(false)
    // Both ended: the cap has room again.
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, SID)).status).toBe(200)
  }, 60_000)

  it('a revoked grant stops the task and the next call asks the user again; Deny is kept', async () => {
    const [g] = (await api('GET', '/api/v1/host-exec/grants')).body.grants
    expect(await api('DELETE', `/api/v1/host-exec/grants/${g.id}`, undefined, SID)).toMatchObject({ status: 403, body: { code: 'human_only' } })
    expect((await api('DELETE', `/api/v1/host-exec/grants/${g.id}`)).status).toBe(200)
    const again = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, SID)
    expect(again).toMatchObject({ status: 403, body: { code: 'exec_grant_required' } })
    expect((await api('POST', `/api/v1/human-inbox/${again.body.letterId}/answer`, { actionId: 'deny' })).status).toBeLessThan(300)
    await until(async () => (await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, SID)).body.code === 'exec_grant_denied', 'the denial')
    const asks = (await letters()).filter((l) => l.subject.includes('" use '))
    expect(asks).toHaveLength(3)
    // Settings lists the Deny with an Allow; the user's Allow there grants it after all.
    const listed = (await api('GET', '/api/v1/host-exec/grants')).body
    expect(listed.denied).toMatchObject([{ taskId, host: 'macbox', taskTitle: 'Run the iOS tests' }])
    expect((await api('POST', '/api/v1/host-exec/grants', { task_id: taskId, host: 'macbox' })).status).toBe(200)
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, SID)).status).toBe(200)
    expect((await api('GET', '/api/v1/host-exec/grants')).body.denied).toEqual([])
  }, 30_000)
})
