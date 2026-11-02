/**
 * host_exec through a REAL server (core/hosts/host-exec.ts, exec-grants.ts,
 * routes/host-exec-v1.ts, ops/host-exec.ts): a task's session on one host runs
 * a command on another only under the user's grant, asked for by ONE letter;
 * the answer makes the grant and tells the session; the run comes back with
 * its exit code and output, a credential-looking line hidden; the user revokes
 * it and the next call asks again. That letter goes only to a task on a host the user did
 * not register (strangerbox); a task on a registered host (devbox) uses another with no
 * letter, under a grant that is counted and revoked the same way, and a letter written for
 * one before this rule is settled for the user. Each host's hard stop refuses every task.
 * Also: no session, the caller's own host, an unknown host, a session trying to grant or
 * revoke, the per-task cap.
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
import { onLetterAnswered, recordAsk, settleOwnHostAsks } from '../../src/core/hosts/exec-grants.js'
import { isOwnHost } from '../../src/core/hosts/host-exec.js'
import { answerLetter, getLetter, sendLetter, settleLetter } from '../../src/core/human-inbox/store.js'
import * as sendCore from '../../src/core/sessions/session-send-core.js'

let server: HttpServer
let port: number
let hostRoot: string
const SID = 'host-exec-e2e-session'
const OTHER_SID = 'host-exec-e2e-other'
const OWN_SID = 'host-exec-e2e-own'
const OLD_SID = 'host-exec-e2e-old-ask'
let taskId = ''
let otherTaskId = ''
let ownTaskId = ''
let oldTaskId = ''
const told: Array<{ taskId?: string; text: string }> = []
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
  // The callers' own hosts answer nothing (the server reads a session's cost there on its own).
  // strangerbox is not in Settings (a host the user removed, or never added).
  const devbox = { connected: true, hostKey: 'devbox', connect: async () => {}, hasCapability: () => false, send: async () => ({ ok: false, error: 'unknown command' }) }
  const real = daemonConnections.getDaemonConnection
  vi.spyOn(daemonConnections, 'getDaemonConnection').mockImplementation(async (key, target) =>
    key === 'macbox' ? macbox as unknown as daemonConnections.DaemonConnection
      : key === 'devbox' || key === 'strangerbox' ? devbox as unknown as daemonConnections.DaemonConnection : real(key, target))
  // What a session is told; never a real delivery into a CLI.
  vi.spyOn(sendCore, 'deliverToSession').mockImplementation((async (_record: unknown, opts: { taskId?: string; enqueueText: string }) => {
    told.push({ taskId: opts.taskId, text: opts.enqueueText })
    return { ok: true }
  }) as never)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await updateConfig({ hosts: { devbox: { hostname: 'devbox.example' }, macbox: { hostname: 'macbox.example', label: 'Mac box' } } })
  const created = await api('POST', '/api/v1/tasks', { title: 'Run the iOS tests' })
  taskId = created.body.task?.id ?? created.body.id
  await createSessionRecord(SID, taskId, '', '/home/me/repo', { host: 'strangerbox', title: 'iOS tests', initialProcessStatus: 'stopped' } as never)
  const other = await api('POST', '/api/v1/tasks', { title: 'Another task' })
  otherTaskId = other.body.task?.id ?? other.body.id
  await createSessionRecord(OTHER_SID, otherTaskId, '', '/home/me/other', { host: 'strangerbox', title: 'other', initialProcessStatus: 'stopped' } as never)
  const own = await api('POST', '/api/v1/tasks', { title: 'Build on the devbox' })
  ownTaskId = own.body.task?.id ?? own.body.id
  await createSessionRecord(OWN_SID, ownTaskId, '', '/home/me/build', { host: 'devbox', title: 'build', initialProcessStatus: 'stopped' } as never)
  const old = await api('POST', '/api/v1/tasks', { title: 'Asked before the rule' })
  oldTaskId = old.body.task?.id ?? old.body.id
  await createSessionRecord(OLD_SID, oldTaskId, '', '/home/me/old', { host: 'devbox', title: 'old', initialProcessStatus: 'stopped' } as never)
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
    expect(await api('POST', '/api/v1/hosts/strangerbox/exec', { command: 'true' }, SID)).toMatchObject({ status: 400, body: { code: 'same_host' } })
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
    // Marked with its kind, host and task, so the letter sweep finds it without the ask record.
    expect((await getLetter(letterId))?.createdByOp).toMatch(new RegExp(`^host-exec-ask:macbox:${taskId}:`))
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
    await until(async () => told.some((t) => t.taskId === taskId && t.text.includes('outcome="host-exec-granted"')), 'the session told')

    const ran = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'pwd; echo out; exit 4', cwd: '~/work' }, SID)
    expect(ran.status).toBe(200)
    expect(ran.body).toMatchObject({ host: 'macbox', running: false, exitCode: 4, cwd: path.join(hostRoot, 'home', 'work') })
    expect(ran.body.output).toBe(`${path.join(hostRoot, 'home', 'work')}\nout\n`)
    expect(sent.filter((m) => m.cmd === 'exec.run').at(-1)!.params).toMatchObject({ taskId, caller: { task: taskId, host: 'strangerbox' }, command: 'pwd; echo out; exit 4', background: true })

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

  async function oldStyleAsk(task: string, sid: string, title: string): Promise<string> {
    const letter = await sendLetter({
      subject: `Let "${title}" use Mac box?`, type: 'action_required', markdown: 'asked before the rule',
      actions: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
      taskRefs: [task], sender: { sessionId: 'external', host: 'local' },
    } as never)
    // The shape an older Walnut wrote: no fromHost, so the session's host decides.
    await recordAsk({ taskId: task, host: 'macbox', letterId: letter.id, askedAt: Date.now(), sid, state: 'pending' })
    return letter.id
  }

  it('a task on a registered host uses another with no letter; its grant is counted, and a revoke or a Deny still stands', async () => {
    const asksBefore = (await letters()).filter((l) => l.subject.includes('" use ')).length
    const ran = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo own' }, OWN_SID)
    expect(ran).toMatchObject({ status: 200, body: { exitCode: 0, output: 'own\n' } })
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo twice' }, OWN_SID)).status).toBe(200)
    expect((await letters()).filter((l) => l.subject.includes('" use ')).length).toBe(asksBefore)
    await until(async () => ((await api('GET', '/api/v1/host-exec/grants')).body.grants as any[])
      .some((g) => g.taskId === ownTaskId && g.via === 'own-host' && g.runs >= 2 && g.lastCommand === 'echo twice'), 'the counted own-host grant')
    const own = ((await api('GET', '/api/v1/host-exec/grants')).body.grants as any[]).find((g) => g.taskId === ownTaskId)
    // The user revokes it in Settings: that task asks by letter from then on.
    expect((await api('DELETE', `/api/v1/host-exec/grants/${own.id}`)).status).toBe(200)
    const asked = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, OWN_SID)
    expect(asked).toMatchObject({ status: 403, body: { code: 'exec_grant_required' } })
    expect((await letters()).find((l) => l.id === asked.body.letterId)).toMatchObject({ subject: 'Let "Build on the devbox" use Mac box?' })
    expect((await api('POST', `/api/v1/human-inbox/${asked.body.letterId}/answer`, { actionId: 'deny' })).status).toBeLessThan(300)
    await until(async () => (await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, OWN_SID)).body.code === 'exec_grant_denied', 'the Deny kept')
    expect((await api('POST', '/api/v1/host-exec/grants', { task_id: ownTaskId, host: 'macbox' })).status).toBe(200)
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, OWN_SID)).status).toBe(200)
  }, 30_000)

  it('the hard stop closes a host to every task, granted or not, and only a person sets it', async () => {
    expect(await api('PUT', '/api/v1/host-exec/hosts/macbox', { closed: true }, OWN_SID)).toMatchObject({ status: 403, body: { code: 'human_only' } })
    expect(await api('PUT', '/api/v1/host-exec/hosts/nosuch', { closed: true })).toMatchObject({ status: 404, body: { code: 'unknown_host' } })
    expect(await api('PUT', '/api/v1/host-exec/hosts/macbox', { closed: 'yes' })).toMatchObject({ status: 400, body: { code: 'bad_request' } })
    expect(await api('PUT', '/api/v1/host-exec/hosts/macbox', { closed: true })).toMatchObject({ status: 200, body: { closedHosts: ['macbox'] } })
    expect(await api('PUT', '/api/v1/host-exec/hosts/__local__', { closed: true })).toMatchObject({ status: 200, body: { closedHosts: ['__local__', 'macbox'] } })
    const runsBefore = sent.filter((m) => m.cmd === 'exec.run').length
    for (const sid of [OWN_SID, SID]) {
      expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, sid)).toMatchObject({ status: 403, body: { code: 'exec_host_closed' } })
    }
    expect(sent.filter((m) => m.cmd === 'exec.run').length).toBe(runsBefore)
    expect((await api('GET', '/api/v1/host-exec/grants')).body.closedHosts).toEqual(['__local__', 'macbox'])
    await api('PUT', '/api/v1/host-exec/hosts/__local__', { closed: false })
    expect(await api('PUT', '/api/v1/host-exec/hosts/macbox', { closed: false })).toMatchObject({ status: 200, body: { closedHosts: [] } })
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, OWN_SID)).status).toBe(200)
  }, 30_000)

  it('a letter written for a task on a registered host before the rule is settled for the user and the task told; others still ask', async () => {
    // A task on a host the user did not register still waits on its letter.
    const stranger = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, OTHER_SID)
    expect(stranger).toMatchObject({ status: 403, body: { code: 'exec_grant_required' } })
    const oldLetter = await oldStyleAsk(oldTaskId, OLD_SID, 'Asked before the rule')
    // One a lead already settled for the user: still granted and its task told; its record stays the lead's.
    const led = await api('POST', '/api/v1/tasks', { title: 'Settled by its lead' })
    const ledTask = led.body.task?.id ?? led.body.id
    await createSessionRecord('host-exec-e2e-led', ledTask, '', '/home/me/led', { host: 'devbox', title: 'led', initialProcessStatus: 'stopped' } as never)
    const ledLetter = await oldStyleAsk(ledTask, 'host-exec-e2e-led', 'Settled by its lead')
    await settleLetter(ledLetter, { reason: 'the lead closed it for the user' })
    told.length = 0
    expect(await settleOwnHostAsks(isOwnHost)).toBe(2)
    expect((await getLetter(ledLetter))?.settled).toMatchObject({ reason: 'the lead closed it for the user' })
    expect(told.map((t) => t.taskId).sort()).toEqual([ledTask, oldTaskId].sort())
    told.splice(0, told.length, ...told.filter((t) => t.taskId === oldTaskId))
    expect((await getLetter(oldLetter))?.settled).toMatchObject({ reason: expect.stringContaining('your own hosts') })
    expect((await getLetter(stranger.body.letterId))?.settled).toBeUndefined()
    expect(((await api('GET', '/api/v1/host-exec/grants')).body.grants as any[]).find((g) => g.taskId === oldTaskId)).toMatchObject({ host: 'macbox', via: 'own-host' })
    expect(told).toEqual([{ taskId: oldTaskId, text: expect.stringContaining('outcome="host-exec-granted"') }])
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, OLD_SID)).status).toBe(200)
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, OTHER_SID)).toMatchObject({ status: 403, body: { code: 'exec_grant_required', letterId: stranger.body.letterId } })

    // One that calls again before the boot pass: its own call settles the letter, and it is not told (it has its answer).
    const late = await api('POST', '/api/v1/tasks', { title: 'Calls again first' })
    const lateTask = late.body.task?.id ?? late.body.id
    await createSessionRecord('host-exec-e2e-late', lateTask, '', '/home/me/late', { host: 'devbox', title: 'late', initialProcessStatus: 'stopped' } as never)
    const lateLetter = await oldStyleAsk(lateTask, 'host-exec-e2e-late', 'Calls again first')
    told.length = 0
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, 'host-exec-e2e-late')).status).toBe(200)
    expect((await getLetter(lateLetter))?.settled).toBeTruthy()
    // The boot pass coming after it finds nothing pending: no second notice into a session mid-call.
    expect(await settleOwnHostAsks(isOwnHost)).toBe(0)
    expect(told).toEqual([])
  }, 30_000)

  async function taskOnDevbox(title: string): Promise<{ task: string; sid: string }> {
    const r = await api('POST', '/api/v1/tasks', { title })
    const task = r.body.task?.id ?? r.body.id
    const sid = `host-exec-e2e-${task}`
    await createSessionRecord(sid, task, '', '/home/me/x', { host: 'devbox', title, initialProcessStatus: 'stopped' } as never)
    return { task, sid }
  }

  it('the user\'s own answer on an old letter wins, however it reaches Walnut', async () => {
    // A Deny Walnut missed (the ask was recorded after the answer's event): the Deny stands, no grant.
    const a = await taskOnDevbox('Denied while away')
    const aLetter = await oldStyleAsk(a.task, a.sid, 'Denied while away')
    await answerLetter(aLetter, { actionId: 'deny' })
    await recordAsk({ taskId: a.task, host: 'macbox', letterId: aLetter, askedAt: Date.now(), sid: a.sid, state: 'pending' })
    told.length = 0
    expect(await settleOwnHostAsks(isOwnHost)).toBe(0)
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, a.sid)).toMatchObject({ status: 403, body: { code: 'exec_grant_denied' } })
    expect(((await api('GET', '/api/v1/host-exec/grants')).body.grants as any[]).some((g) => g.taskId === a.task)).toBe(false)

    // The same, met first by the task's own call.
    const b = await taskOnDevbox('Denied, then called')
    const bLetter = await oldStyleAsk(b.task, b.sid, 'Denied, then called')
    await answerLetter(bLetter, { actionId: 'deny' })
    await recordAsk({ taskId: b.task, host: 'macbox', letterId: bLetter, askedAt: Date.now(), sid: b.sid, state: 'pending' })
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, b.sid)).toMatchObject({ status: 403, body: { code: 'exec_grant_denied' } })

    // An old ask whose session is gone, met by the task's new session: settled, granted, no letter left open.
    const c = await taskOnDevbox('Session replaced')
    const cLetter = await oldStyleAsk(c.task, 'a-session-long-gone', 'Session replaced')
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, c.sid)).status).toBe(200)
    expect((await getLetter(cLetter))?.settled).toBeTruthy()

    // A Deny that lands after its ask became an own-host grant revokes that grant.
    const d = await taskOnDevbox('Denied after the grant')
    const dLetter = await oldStyleAsk(d.task, d.sid, 'Denied after the grant')
    expect(await settleOwnHostAsks(isOwnHost)).toBe(1)
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, d.sid)).status).toBe(200)
    // (A settled letter still takes the user's answer.)
    await answerLetter(dLetter, { actionId: 'deny' })
    await onLetterAnswered({ letterId: dLetter, actionId: 'deny' })
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, d.sid)).toMatchObject({ status: 403, body: { code: 'exec_grant_denied' } })
  }, 30_000)

  it('the hard stop survives an older Walnut rewriting the grants file', async () => {
    expect((await api('PUT', '/api/v1/host-exec/hosts/macbox', { closed: true })).status).toBe(200)
    const file = path.join(WALNUT_HOME, 'host-exec-grants.json')
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(raw.closedHosts).toBeUndefined()
    // What an older version writes back: only the fields it knows.
    await fs.writeFile(file, JSON.stringify({ grants: raw.grants, asks: raw.asks }))
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, OWN_SID)).toMatchObject({ status: 403, body: { code: 'exec_host_closed' } })
    expect((await api('PUT', '/api/v1/host-exec/hosts/macbox', { closed: false })).status).toBe(200)
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, OWN_SID)).status).toBe(200)
  }, 30_000)
})
