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
 * And (2026-11-03, from a session on a user's Mac): the found ~/.ssh/config row of a joined
 * machine runs on the joined row and every answer says so; a command that can show a password
 * dialog on a Mac, or read a place macOS guards, is refused without allow_prompts, and a run the
 * host stopped at a dialog says so; the line runs in bash with WALNUT_TASK_DIR set, on a current
 * daemon and, shaped by the server, on an older one (zsh as its login shell); a run the caller
 * named (job_id) is read after its answer was lost and never runs twice; a relayed call answers
 * inside its deadline; a read from an offset is not "truncated"; host_exec_list lists a task's jobs.
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
import { ANSWER_RETURN_MS, resetHostExecForTest } from '../../src/core/hosts/host-exec.js'
import { onLetterAnswered, recordAsk, settleOwnHostAsks } from '../../src/core/hosts/exec-grants.js'
import { isOwnHost } from '../../src/core/hosts/host-exec.js'
import { answerLetter, getLetter, sendLetter, settleLetter } from '../../src/core/human-inbox/store.js'
import * as sendCore from '../../src/core/sessions/session-send-core.js'
import { commandLine } from '../../src/providers/host-exec-core.js'
import { updateHostProfile } from '../../src/core/hosts/host-profile.js'
import { getConfig } from '../../src/core/config-manager.js'
import { spawn as spawnChild } from 'node:child_process'
import { existsSync } from 'node:fs'

let server: HttpServer
let port: number
let hostRoot: string
const SID = 'host-exec-e2e-session'
const OTHER_SID = 'host-exec-e2e-other'
const OWN_SID = 'host-exec-e2e-own'
const OLD_SID = 'host-exec-e2e-old-ask'
let taskId = ''
let oldShellRun: (line: string) => Promise<Record<string, unknown>> = async () => ({})
let otherTaskId = ''
let ownTaskId = ''
let oldTaskId = ''
const told: Array<{ taskId?: string; text: string }> = []
const sent: Array<{ cmd: string; params: Record<string, unknown>; host?: string }> = []
/** Hosts whose exec.list fails, as a host that went away does. */
const awayHosts = new Set<string>()
/** The jobs the older daemon below ran (it lists them with no task). */
const oldJobs: Array<{ host: string; jobId: string; at: number }> = []
/** The login shell of the older daemon below: zsh, as on a Mac, where this machine has it. */
const OLD_LOGIN_SHELL = ['/bin/zsh', '/usr/bin/zsh'].find((f) => existsSync(f)) ?? '/bin/sh'

async function api(method: string, p: string, body?: unknown, sid?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}), ...headers },
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
    // HOME too: with none, the login shell reads the real account's ~/.profile.
    stateDir: path.join(hostRoot, 'state'), env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: path.join(hostRoot, 'home') },
    // Never the real ps and log, even where this suite runs on a Mac.
    promptProbe: null,
  })
  // A current daemon (host-exec-v2) in front of a real host core.
  const currentHost = (hostKey: string, hostCore = core) => ({
    connected: true, hostKey, connect: async () => {}, taskDirRoot: path.join(hostRoot, 'tasks'),
    hasCapability: (c: string) => c === 'host-exec-v1' || c === 'host-exec-v2' || c === 'task-dir-v1',
    send: async (cmd: string, params: Record<string, unknown> = {}) => {
      sent.push({ cmd, params, host: hostKey })
      if (String(params.command ?? '').includes('LOSE_THE_HOST')) throw new Error('socket closed')
      if (cmd === 'exec.list' && awayHosts.has(hostKey)) throw new Error('socket closed')
      try {
        const op = cmd.slice('exec.'.length) as 'run' | 'read' | 'kill' | 'list'
        return { ok: true, ...(await (hostCore[op] as (p: unknown) => Promise<Record<string, unknown>>)(params)) }
      } catch (err) {
        return { ok: false, error: `${cmd} failed: ${(err as Error).message}`, code: (err as { code?: string }).code }
      }
    },
  })
  const macbox = currentHost('macbox')
  // A daemon older than host-exec-v2: the line in its login shell as it is, no WALNUT_TASK_DIR
  // (host-exec-core.ts before v2), and the task directory it makes for a task's logs.
  const olderHost = (hostKey: string, taskDirRoot: string | null) => ({
    connected: true, hostKey, connect: async () => {}, taskDirRoot,
    hasCapability: (c: string) => c === 'host-exec-v1' || (c === 'task-dir-v1' && taskDirRoot !== null),
    send: async (cmd: string, params: Record<string, unknown> = {}) => {
      sent.push({ cmd, params, host: hostKey })
      if (cmd === 'taskdir.ensure') return { ok: true, path: path.join(taskDirRoot!, String(params.taskId)) }
      // Its list names no task and no command; it holds another Walnut's job too.
      if (cmd === 'exec.list') {
        const mine = oldJobs.filter((j) => j.host === hostKey).map((j) => ({ jobId: j.jobId, running: false, exitCode: 0, signal: null, timedOut: false, killed: false, startedAt: j.at, ms: 1, cwd: '/h', logFile: `/h/${j.jobId}.log`, outputBytes: 1 }))
        return { ok: true, jobs: [...mine, { jobId: 'hx-another-walnut-0001', running: true, exitCode: null, startedAt: Date.now(), ms: 5, cwd: '/h', logFile: '/h/x.log', outputBytes: 0 }] }
      }
      if (cmd !== 'exec.run') return { ok: false, error: `${cmd} failed: not in this fake`, code: 'unknown_job' }
      const line = commandLine(params)
      if (typeof line !== 'string') return { ok: false, error: `exec.run failed: ${line.error}`, code: line.code }
      if (taskDirRoot) await fs.mkdir(path.join(taskDirRoot, String(params.taskId), 'host-exec'), { recursive: true })
      oldJobs.push({ host: hostKey, jobId: String(params.jobId), at: Date.now() })
      return { ok: true, ...(await oldRun(line)) }
    },
  })
  async function oldRun(line: string): Promise<Record<string, unknown>> {
    const home = path.join(hostRoot, 'home')
    const env = { PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, ZDOTDIR: home }
    return new Promise((resolve) => {
      const c = spawnChild(OLD_LOGIN_SHELL, ['-l', '-c', line], { cwd: home, env })
      let out = ''
      c.stdout.on('data', (d) => { out += d })
      c.stderr.on('data', (d) => { out += d })
      c.on('close', (code) => resolve({ running: false, exitCode: code, signal: null, timedOut: false, ms: 1, cwd: home, output: out, truncated: false, outputBytes: out.length }))
    })
  }
  oldShellRun = oldRun
  // The callers' own hosts answer nothing (the server reads a session's cost there on its own).
  // strangerbox is not in Settings (a host the user removed, or never added); neither is a found
  // twin's own row ever reached (its joined row is).
  const devbox = { connected: true, hostKey: 'devbox', connect: async () => {}, hasCapability: () => false, send: async () => ({ ok: false, error: 'unknown command' }) }
  // A Mac whose prompt watch finds every idle job at a SecurityAgent dialog (no ps, no log).
  const tccHome = path.join(hostRoot, 'tcc-home')
  await fs.mkdir(tccHome, { recursive: true })
  const tccCore = createHostExec({
    spawn: (await import('node:child_process')).spawn,
    killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
    shell: '/bin/sh', home: tccHome, taskDirRoot: path.join(hostRoot, 'tasks'), stateDir: path.join(hostRoot, 'tcc-state'),
    env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: tccHome },
    platform: 'darwin', promptCheckMs: 200,
    // Each watched group holds an idle `security` (a keychain call) while SecurityAgent is up.
    promptProbe: { snapshot: async (pgids) => ({ processes: pgids.map((pgid) => ({ pid: 99_999, pgid, cpuMs: 0, comm: '/usr/bin/security' })), securityAgentStartedAt: Date.now() }), tccPrompts: async () => [] },
  })
  const fakes: Record<string, unknown> = {
    macbox, devbox, strangerbox: devbox, 'Studio-MacBook': currentHost('Studio-MacBook'), 'studio-mac': devbox,
    oldmac: olderHost('oldmac', path.join(hostRoot, 'old-tasks')), 'oldmac-nodir': olderHost('oldmac-nodir', null),
    tccmac: currentHost('tccmac', tccCore),
  }
  const real = daemonConnections.getDaemonConnection
  vi.spyOn(daemonConnections, 'getDaemonConnection').mockImplementation(async (key, target) =>
    Object.hasOwn(fakes, key) ? fakes[key] as daemonConnections.DaemonConnection : real(key, target))
  // What a session is told; never a real delivery into a CLI.
  vi.spyOn(sendCore, 'deliverToSession').mockImplementation((async (_record: unknown, opts: { taskId?: string; enqueueText: string }) => {
    told.push({ taskId: opts.taskId, text: opts.enqueueText })
    return { ok: true }
  }) as never)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await updateConfig({
    hosts: {
      devbox: { hostname: 'devbox.example' }, macbox: { hostname: 'macbox.example', label: 'Mac box' },
      // One machine twice: found in ~/.ssh/config, and joined over the host network.
      'studio-mac': { hostname: 'Studio-MacBook.local', user: 'sam', discovered: true },
      'Studio-MacBook': { hostname: 'Studio-MacBook.walnut-net.invalid', label: 'Studio-MacBook', transport: 'net', endpoint: 'a'.repeat(64) },
      oldmac: { hostname: 'oldmac.example' }, 'oldmac-nodir': { hostname: 'oldmac-nodir.example' },
      tccmac: { hostname: 'tccmac.example' },
    } as never,
    net: { enabled: true },
  } as never)
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

  it('a run still going after about 12 s comes back running; host_exec_read waits for it; only its task reads it', async () => {
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

  it('reads and stops a background job; at the cap of four a call waits for a slot, then is refused', async () => {
    const a = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'sleep 30', background: true }, SID)
    const b = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo one; sleep 0.3; echo two', background: true }, SID)
    const c = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'sleep 30', background: true }, SID)
    const d = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'sleep 30', background: true }, SID)
    expect([a, b, c, d].map((r) => r.body.running)).toEqual([true, true, true, true])
    // b ends with nobody reading it: the waiting call asks the host, finds the room and runs.
    const lists = sent.filter((m) => m.cmd === 'exec.list').length
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, SID)).status).toBe(200)
    expect(sent.filter((m) => m.cmd === 'exec.list').length).toBeGreaterThan(lists)
    const done = await api('GET', `/api/v1/hosts/macbox/exec/${b.body.jobId}?offset=0&wait_ms=10000`, undefined, SID)
    expect(done.body).toMatchObject({ running: false, exitCode: 0, output: 'one\ntwo\n' })
    // Four still run: a fifth waits for a slot (a relayed caller: half of what its answer time
    // leaves), then is refused with how long it waited.
    const e = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'sleep 30', background: true }, SID)
    expect(e.body.running).toBe(true)
    const t0 = Date.now()
    const full = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, SID)
    expect(full).toMatchObject({ status: 429, body: { code: 'busy' } })
    expect(full.body.error).toMatch(/already runs 4 commands on other hosts \(waited \d+ s for one to end\)/)
    expect(Date.now() - t0).toBeGreaterThan(2_000)
    // A stop while a call waits: it takes the freed slot and runs.
    const waiting = api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo got-a-slot' }, SID)
    await new Promise((r) => setTimeout(r, 500))
    for (const job of [a, c, d, e]) expect((await api('POST', `/api/v1/hosts/macbox/exec/${job.body.jobId}/stop`, undefined, SID)).status).toBe(200)
    expect(await waiting).toMatchObject({ status: 200, body: { exitCode: 0, output: 'got-a-slot\n' } })
    for (const job of [a, c, d, e]) {
      expect((await api('GET', `/api/v1/hosts/macbox/exec/${job.body.jobId}?wait_ms=10000`, undefined, SID)).body.running).toBe(false)
    }
    // All ended: the cap has room again.
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, SID)).status).toBe(200)
  }, 90_000)

  it('twelve calls at once all run, queued: the host never runs more than four of the task at a time', async () => {
    // 2026-11-04: the count and the slot were apart by a dial, so a burst passed the cap together,
    // and the calls that lost the race were refused instead of waiting.
    const marks = path.join(hostRoot, 'burst.log')
    await fs.rm(marks, { force: true })
    const line = `echo "s $(date +%s%N)" >> ${marks}; sleep 0.4; echo "e $(date +%s%N)" >> ${marks}`
    const all = await Promise.all(Array.from({ length: 12 }, () => api('POST', '/api/v1/hosts/macbox/exec', { command: line }, SID)))
    expect(all.map((r) => r.status)).toEqual(Array(12).fill(200))
    expect(all.every((r) => r.body.exitCode === 0)).toBe(true)
    const events = (await fs.readFile(marks, 'utf8')).trim().split('\n').map((l) => l.split(' ')).map(([k, t]) => ({ k, t: BigInt(t) }))
    expect(events.filter((x) => x.k === 's')).toHaveLength(12)
    events.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.k === 'e' ? -1 : 1))
    let now = 0
    let most = 0
    for (const x of events) { now += x.k === 's' ? 1 : -1; most = Math.max(most, now) }
    expect(most).toBeLessThanOrEqual(4)
    expect(most).toBeGreaterThan(1)
  }, 90_000)

  it('strict stops at the first failing command, a pipe included, and names it; without it the line runs on', async () => {
    const line = 'echo start\ntrue | false | cat\necho never'
    const plain = await api('POST', '/api/v1/hosts/macbox/exec', { command: line }, SID)
    expect(plain.body).toMatchObject({ exitCode: 0, output: 'start\nnever\n' })
    expect(plain.body.failedStep).toBeUndefined()
    const strict = await api('POST', '/api/v1/hosts/macbox/exec', { command: line, strict: true }, SID)
    expect(strict.body).toMatchObject({ exitCode: 1, failedStep: { exitCode: 1, command: 'cat', pipeStatus: [0, 1, 0], line: 2, text: 'true | false | cat' } })
    expect(strict.body.output).not.toContain('never')
    // A function's failure names the command inside it; the op's outcome says where it stopped.
    const viaOp = await executeOp('host_exec', { host: 'macbox', command: 'check() { grep -q zzz-not-there /dev/null; }\ncheck\necho never', strict: true },
      { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: SID }) as { ok: boolean; result: Record<string, unknown> }
    expect(viaOp.result).toMatchObject({ exitCode: 1, failedStep: { command: 'grep -q zzz-not-there /dev/null', line: 1 } })
    expect(String(viaOp.result.outcome)).toContain('It stopped at `grep -q zzz-not-there /dev/null` on line 1, which exited 1.')
    // A pipe that failed in its middle is named by its line and member, not by its last command.
    const piped = await executeOp('host_exec', { host: 'macbox', command: line, strict: true },
      { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: SID }) as { ok: boolean; result: Record<string, unknown> }
    expect(String(piped.result.outcome)).toContain("It stopped on line 2 (`true | false | cat`): command 2 of its pipe of 3 exited 1 (the pipe's commands exited 0, 1, 0 in order).")
    // argv runs one program: strict changes nothing there.
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { argv: ['sh', '-c', 'false; echo after'], strict: true }, SID)).body).toMatchObject({ exitCode: 0, output: 'after\n' })
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

  it('a found ~/.ssh/config twin of a joined machine runs on the joined row, and every answer says so', async () => {
    const twinNote = expect.stringContaining('studio-mac is the same machine as Studio-MacBook')
    const ran = await api('POST', '/api/v1/hosts/studio-mac/exec', { command: 'echo twin' }, OWN_SID)
    expect(ran).toMatchObject({ status: 200, body: { host: 'Studio-MacBook', exitCode: 0, output: 'twin\n', note: twinNote } })
    expect(sent.filter((m) => m.cmd === 'exec.run').at(-1)!.host).toBe('Studio-MacBook')
    // Its grant is the joined machine's: one machine, one grant.
    expect(((await api('GET', '/api/v1/host-exec/grants')).body.grants as any[]).some((g) => g.taskId === ownTaskId && g.host === 'Studio-MacBook')).toBe(true)
    // Reading and stopping a job by the found alias reach the same job.
    const bg = await api('POST', '/api/v1/hosts/studio-mac/exec', { command: 'sleep 30', background: true }, OWN_SID)
    expect(bg).toMatchObject({ status: 200, body: { running: true, note: twinNote } })
    expect(await api('POST', `/api/v1/hosts/studio-mac/exec/${bg.body.jobId}/stop`, undefined, OWN_SID)).toMatchObject({ status: 200, body: { stopping: true, note: twinNote } })
    expect(await api('GET', `/api/v1/hosts/studio-mac/exec/${bg.body.jobId}?wait_ms=10000`, undefined, OWN_SID)).toMatchObject({ status: 200, body: { running: false, note: twinNote } })
    // A refusal says it too, and so does a sibling op on the same alias (no MCP on that daemon).
    expect(await api('POST', '/api/v1/hosts/studio-mac/exec', { command: 'security show-keychain-info' }, OWN_SID)).toMatchObject({ status: 409, body: { code: 'may_prompt', note: twinNote } })
    expect(await api('GET', '/api/v1/hosts/studio-mac/mcp', undefined, OWN_SID)).toMatchObject({ status: 409, body: { code: 'daemon_upgrade', error: expect.stringContaining('Studio-MacBook'), note: twinNote } })
    // The op an agent calls reads it in its outcome.
    const viaOp = await executeOp('host_exec', { host: 'studio-mac', command: 'echo op' },
      { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: OWN_SID }) as { ok: boolean; result: Record<string, unknown> }
    expect(viaOp).toMatchObject({ ok: true, result: { host: 'Studio-MacBook', output: 'op\n' } })
    expect(String(viaOp.result.outcome)).toContain('studio-mac is the same machine as Studio-MacBook')
    // Any other host is itself, with no note.
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, OWN_SID)).body.note).toBeUndefined()
  }, 30_000)

  it('a command that can show a password dialog on a Mac runs only with allow_prompts', async () => {
    const runs = () => sent.filter((m) => m.cmd === 'exec.run').length
    const before = runs()
    // macbox: a system Walnut has not seen yet counts as a Mac.
    for (const command of ['security find-generic-password -s svc -w', 'X=$(/usr/bin/security show-keychain-info)', 'sudo security unlock-keychain']) {
      const r = await api('POST', '/api/v1/hosts/macbox/exec', { command }, OWN_SID)
      expect(r).toMatchObject({ status: 409, body: { code: 'may_prompt', error: expect.stringContaining("password dialog on Mac box's screen") } })
      expect(r.body.error).toContain('allow_prompts')
    }
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { argv: ['/usr/bin/security', 'dump-keychain'] }, OWN_SID)).body.code).toBe('may_prompt')
    expect(runs()).toBe(before)
    // An unrelated word is not a run.
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo --security-group describe-security-groups' }, OWN_SID)).status).toBe(200)
    // The user agreed: it runs (this test host has no `security`, so it exits 127).
    const agreed = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'security find-generic-password -s svc', allow_prompts: true }, OWN_SID)
    expect(agreed).toMatchObject({ status: 200, body: { exitCode: 127 } })
    // The op takes the flag too.
    const viaOp = await executeOp('host_exec', { host: 'macbox', command: 'security show-keychain-info', allow_prompts: true },
      { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: OWN_SID }) as { ok: boolean; result: Record<string, unknown> }
    expect(viaOp).toMatchObject({ ok: true, result: { exitCode: 127 } })
    // A host Walnut knows is Linux shows no such dialog; one it knows is a Mac does.
    const facts = (platform: string) => ({ os: { platform, release: '1' }, arch: 'arm64', cpus: 8, memBytes: 1, home: '/h', proxyEnv: {}, cloud: null, internet: null, tools: {}, uptimeSec: 1, probedAt: new Date().toISOString() })
    await updateHostProfile('macbox', (p) => { p.probed = facts('linux') as never })
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'security find-generic-password -s svc' }, OWN_SID)).status).toBe(200)
    await updateHostProfile('macbox', (p) => { p.probed = facts('darwin') as never })
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'security find-generic-password -s svc' }, OWN_SID)).body.code).toBe('may_prompt')
  }, 30_000)

  it('the line runs in bash with WALNUT_TASK_DIR set to the task\'s directory on that host', async () => {
    const taskDir = path.join(hostRoot, 'tasks', ownTaskId)
    const r = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo ===; echo hi > "$WALNUT_TASK_DIR/x.txt"; cat "$WALNUT_TASK_DIR/x.txt"; echo "$WALNUT_TASK_DIR"' }, OWN_SID)
    expect(r).toMatchObject({ status: 200, body: { exitCode: 0, output: `===\nhi\n${taskDir}\n`, shell: 'bash', loginShell: 'sh', taskDir } })
    expect(await fs.readFile(path.join(taskDir, 'x.txt'), 'utf8')).toBe('hi\n')
    expect(sent.filter((m) => m.cmd === 'exec.run').at(-1)!.params).toMatchObject({ home: WALNUT_HOME })
    const viaOp = await executeOp('host_exec', { host: 'macbox', command: 'true' },
      { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: OWN_SID }) as { ok: boolean; result: Record<string, unknown> }
    expect(String(viaOp.result.outcome)).toMatch(/^Exit 0 on macbox in .* \(bash\) after/)
  }, 30_000)

  it('an older daemon gets the line shaped by the server: bash after its login shell, WALNUT_TASK_DIR set', async () => {
    const line = 'echo ===; printf "%s\\n" "$WALNUT_TASK_DIR"; [ -n "$BASH_VERSION" ] && echo bash'
    // What that daemon does with the line as it is, in zsh where this machine has it.
    if (OLD_LOGIN_SHELL.endsWith('zsh')) expect(String((await oldShellRun(line)).output)).toContain('== not found')
    const taskDir = path.join(hostRoot, 'old-tasks', ownTaskId)
    const r = await api('POST', '/api/v1/hosts/oldmac/exec', { command: line }, OWN_SID)
    expect(r).toMatchObject({ status: 200, body: { exitCode: 0, output: `===\n${taskDir}\nbash\n`, shell: 'bash', taskDir } })
    const run = sent.filter((m) => m.cmd === 'exec.run').at(-1)!
    expect(run).toMatchObject({ host: 'oldmac', params: { argv: ['/bin/sh', '-c', expect.any(String), 'sh', line, taskDir] } })
    expect(run.params.command).toBeUndefined()
    // Its directory gets its marker, naming this Walnut.
    expect(sent.find((m) => m.host === 'oldmac' && m.cmd === 'taskdir.ensure')?.params).toEqual({ taskId: ownTaskId, home: WALNUT_HOME })
    // argv goes the same way.
    const argv = await api('POST', '/api/v1/hosts/oldmac/exec', { argv: ['printf', '%s|', '===', 'a b'] }, OWN_SID)
    expect(argv).toMatchObject({ status: 200, body: { exitCode: 0, output: '===|a b|' } })
    // With no task directory there, a line that reads it is refused rather than writing to /.
    const before = sent.filter((m) => m.cmd === 'exec.run').length
    expect(await api('POST', '/api/v1/hosts/oldmac-nodir/exec', { command: 'echo hi > "$WALNUT_TASK_DIR/x.txt"' }, OWN_SID)).toMatchObject({ status: 409, body: { code: 'task_dir_unset' } })
    expect(sent.filter((m) => m.cmd === 'exec.run').length).toBe(before)
    // A line too long for that daemon's argv runs as it is, and the answer says no shell was chosen.
    const long = await api('POST', '/api/v1/hosts/oldmac/exec', { command: `echo ${'x'.repeat(9000)} >/dev/null; echo long` }, OWN_SID)
    expect(long).toMatchObject({ status: 200, body: { output: 'long\n', shell: null, taskDir: null } })
    expect(await api('POST', '/api/v1/hosts/oldmac/exec', { command: `echo ${'x'.repeat(9000)} > "$WALNUT_TASK_DIR/x"` }, OWN_SID)).toMatchObject({ status: 409, body: { code: 'task_dir_unset', taskDir } })
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

  const asOwn = () => ({ apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: OWN_SID })
  const execRuns = () => sent.filter((m) => m.cmd === 'exec.run')
  const probed = (platform: string, home: string) => ({ os: { platform, release: '1' }, arch: 'arm64', cpus: 8, memBytes: 1, home, proxyEnv: {}, cloud: null, internet: null, tools: {}, uptimeSec: 1, probedAt: new Date().toISOString() })

  it('a run the caller named is read after its answer was lost, and the same name never runs twice', async () => {
    const jobId = 'hx-e2e-lost-answer-0001'
    // The caller stops waiting (its gateway gave up at 20 s): the answer never reaches it.
    const gone = new AbortController()
    const call = fetch(`http://127.0.0.1:${port}/api/v1/hosts/macbox/exec`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': OWN_SID },
      body: JSON.stringify({ command: 'sleep 1; echo lost-and-found', job_id: jobId }), signal: gone.signal,
    }).catch((err: Error) => err)
    await until(async () => execRuns().some((m) => m.params.jobId === jobId), 'the run on the host')
    gone.abort()
    expect(await call).toBeInstanceOf(Error)
    // The caller still has the id it chose: the run reads by it.
    const read = await api('GET', `/api/v1/hosts/macbox/exec/${jobId}?wait_ms=10000`, undefined, OWN_SID)
    expect(read).toMatchObject({ status: 200, body: { jobId, running: false, exitCode: 0, output: 'lost-and-found\n' } })
    // The same id again (a retry after the lost answer): that run, never a second one.
    const again = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo second', job_id: jobId }, OWN_SID)
    expect(again).toMatchObject({ status: 200, body: { jobId, sameJob: true, output: 'lost-and-found\n' } })
    const viaOp = await executeOp('host_exec', { host: 'macbox', command: 'echo second', job_id: jobId }, asOwn()) as { ok: boolean; result: Record<string, unknown> }
    expect(viaOp).toMatchObject({ ok: true, result: { sameJob: true, output: 'lost-and-found\n' } })
    expect(String(viaOp.result.outcome)).toContain('it did not run again')
    // Another task may not take it; a malformed id is refused before anything runs.
    const other = await taskOnDevbox('Takes another task\'s id')
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true', job_id: jobId }, other.sid)).toMatchObject({ status: 409, body: { code: 'job_id_taken' } })
    const before = execRuns().length
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true', job_id: 'job one' }, OWN_SID)).toMatchObject({ status: 400, body: { code: 'bad_request' } })
    expect(execRuns().length).toBe(before)
    // A host that no longer holds the job (an older host here, which reads none): it never runs again.
    const goneId = 'hx-e2e-forgotten-0001'
    expect(await api('POST', '/api/v1/hosts/oldmac/exec', { command: 'echo first', job_id: goneId }, OWN_SID)).toMatchObject({ status: 200, body: { output: 'first\n' } })
    const gone2 = await api('POST', '/api/v1/hosts/oldmac/exec', { command: 'echo first', job_id: goneId }, OWN_SID)
    expect(gone2).toMatchObject({ status: 409, body: { code: 'job_gone', jobId: goneId } })
    expect(gone2.body.error).toContain('Leave job_id out')
    expect(execRuns().filter((m) => m.params.jobId === goneId)).toHaveLength(1)
    // While it still runs, the same id from the same task waits on that run too.
    const live = 'hx-e2e-same-live-0001'
    const first = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'sleep 0.8; echo once', background: true, job_id: live }, OWN_SID)
    expect(first).toMatchObject({ status: 200, body: { running: true, jobId: live } })
    const second = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'sleep 0.8; echo once', job_id: live }, OWN_SID)
    expect(second).toMatchObject({ status: 200, body: { jobId: live, sameJob: true, running: false, output: 'once\n' } })
    expect(execRuns().filter((m) => m.params.jobId === live)).toHaveLength(1)
  }, 30_000)

  it('a relayed call answers inside its caller\'s deadline, and starts nothing it could not answer for', async () => {
    // A relay that reached this server just now; its host's gateway gives up 14 s from here.
    const t0 = Date.now()
    const held = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'sleep 20; echo late', timeout_ms: 60_000 }, OWN_SID, { 'x-walnut-answer-by': String(t0 + 14_000) })
    const took = Date.now() - t0
    expect(held).toMatchObject({ status: 200, body: { running: true, jobId: expect.stringMatching(/^hx-/) } })
    // The hold ends ANSWER_RETURN_MS before that deadline, leaving the answer time to get back.
    expect(took).toBeGreaterThan(14_000 - ANSWER_RETURN_MS - 1_500)
    expect(took).toBeLessThan(14_000 - ANSWER_RETURN_MS + 1_500)
    // A read holds by the same deadline, whatever wait_ms asked.
    const t1 = Date.now()
    const read = await api('GET', `/api/v1/hosts/macbox/exec/${held.body.jobId}?wait_ms=60000`, undefined, OWN_SID, { 'x-walnut-answer-by': String(t1 + 12_000) })
    expect(read).toMatchObject({ status: 200, body: { running: true } })
    expect(Date.now() - t1).toBeLessThan(12_000 - ANSWER_RETURN_MS + 1_500)
    expect((await api('POST', `/api/v1/hosts/macbox/exec/${held.body.jobId}/stop`, undefined, OWN_SID)).status).toBe(200)
    // Too little left to answer: nothing starts, and it says so at once.
    const before = execRuns().length
    const t2 = Date.now()
    const late = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo never' }, OWN_SID, { 'x-walnut-answer-by': String(t2 + 11_000) })
    expect(late).toMatchObject({ status: 503, body: { code: 'host_offline' } })
    expect(late.body.error).toContain('nothing ran')
    expect(Date.now() - t2).toBeLessThan(3_000)
    expect(execRuns().length).toBe(before)
  }, 60_000)

  it('a read from an offset says truncated only when the start is missing, and more when the rest is', async () => {
    const big = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'yes walnut-output-line | head -c 300000' }, OWN_SID)
    expect(big).toMatchObject({ status: 200, body: { exitCode: 0, truncated: true, outputBytes: 300_000 } })
    const jobId = big.body.jobId as string
    const head = await api('GET', `/api/v1/hosts/macbox/exec/${jobId}?offset=0`, undefined, OWN_SID)
    expect(head.body).toMatchObject({ offset: 0, truncated: false, more: true })
    expect(head.body.nextOffset).toBeLessThan(300_000)
    const rest = await api('GET', `/api/v1/hosts/macbox/exec/${jobId}?offset=${head.body.nextOffset}`, undefined, OWN_SID)
    expect(rest.body).toMatchObject({ truncated: false, nextOffset: 300_000 })
    expect(rest.body.more).toBeUndefined()
    expect(String(head.body.output).length + String(rest.body.output).length).toBe(300_000)
    // At the very end (2026-11-03: this said truncated, and sent the reader back to offset 0).
    const end = await executeOp('host_exec_read', { host: 'macbox', job_id: jobId, offset: 300_000 }, asOwn()) as { ok: boolean; result: Record<string, unknown> }
    expect(end.result).toMatchObject({ output: '', truncated: false, offset: 300_000, nextOffset: 300_000 })
    expect(String(end.result.outcome)).not.toContain('offset 0')
    const page = await executeOp('host_exec_read', { host: 'macbox', job_id: jobId, offset: 0 }, asOwn()) as { ok: boolean; result: Record<string, unknown> }
    expect(String(page.result.outcome)).toContain(`More output follows: host_exec_read with offset ${String(head.body.nextOffset)}.`)
    // With no offset it is the tail, and the start is missing.
    const tail = await executeOp('host_exec_read', { host: 'macbox', job_id: jobId }, asOwn()) as { ok: boolean; result: Record<string, unknown> }
    expect(tail.result).toMatchObject({ truncated: true })
    expect(String(tail.result.outcome)).toContain('(host_exec_read with offset 0)')
  }, 30_000)

  it('host_exec_list lists a task\'s own jobs on a host, from an older host too, and what Walnut started when the host is away', async () => {
    const t = await taskOnDevbox('Lists its own jobs')
    const asT = { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: t.sid }
    const done = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'echo listed' }, t.sid)
    await new Promise((r) => setTimeout(r, 5))
    const bg = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'sleep 30', background: true }, t.sid)
    const listed = await executeOp('host_exec_list', { host: 'macbox' }, asT) as { ok: boolean; result: { jobs: any[]; outcome: string } }
    expect(listed.ok).toBe(true)
    expect(listed.result.jobs.map((j) => j.jobId)).toEqual([bg.body.jobId, done.body.jobId])
    expect(listed.result.jobs[0]).toMatchObject({ state: 'running', running: true, command: 'sleep 30', exitCode: null })
    expect(listed.result.jobs[1]).toMatchObject({ state: 'exited', running: false, command: 'echo listed', exitCode: 0, logFile: expect.stringContaining(`${t.task}/host-exec/`) })
    expect(Date.parse(listed.result.jobs[1].startedAt)).toBeGreaterThan(0)
    expect(listed.result.outcome).toMatch(/^2 job\(s\) of this task on macbox, 1 running\./)
    // Another task's list has none of them; a task with no grant there lists nothing.
    const own = await api('GET', '/api/v1/hosts/macbox/exec', undefined, OWN_SID)
    expect(own.status).toBe(200)
    expect(own.body.jobs.length).toBeGreaterThan(0)
    // (This fake's macbox and Studio-MacBook share one host core, so either host's runs count.)
    const ownRuns = new Set(execRuns().filter((m) => m.params.taskId === ownTaskId).map((m) => m.params.jobId))
    for (const j of own.body.jobs) expect(ownRuns.has(j.jobId)).toBe(true)
    expect((await api('GET', '/api/v1/hosts/macbox/exec', undefined, OTHER_SID)).status).toBe(403)
    // The host away: the runs Walnut started there, their state unknown.
    awayHosts.add('macbox')
    const away = await executeOp('host_exec_list', { host: 'macbox' }, asT) as { ok: boolean; result: Record<string, any> }
    awayHosts.delete('macbox')
    expect(away.result).toMatchObject({ hostAway: expect.any(String), jobs: [{ jobId: bg.body.jobId, state: 'unknown', running: null }, { jobId: done.body.jobId, state: 'unknown' }] })
    expect(String(away.result.outcome)).toContain('The host did not answer')
    expect((await api('POST', `/api/v1/hosts/macbox/exec/${bg.body.jobId}/stop`, undefined, t.sid)).status).toBe(200)
    // An older host names no task: only this task's runs Walnut started there are listed.
    const old = await api('GET', '/api/v1/hosts/oldmac/exec', undefined, OWN_SID)
    const oldRuns = execRuns().filter((m) => m.host === 'oldmac' && m.params.taskId === ownTaskId).map((m) => String(m.params.jobId))
    expect(oldRuns.length).toBeGreaterThan(0)
    expect(old.body.jobs.map((j: any) => j.jobId).sort()).toEqual([...oldRuns].sort())
    expect(old.body.jobs.every((j: any) => j.state === 'exited' && typeof j.command === 'string')).toBe(true)
    expect(old.body.jobs.some((j: any) => j.jobId === 'hx-another-walnut-0001')).toBe(false)
  }, 30_000)

  it('on a Mac, a read of a place macOS guards is refused without allow_prompts, and a run stopped at a dialog says so', async () => {
    const home = path.join(hostRoot, 'home')
    await updateHostProfile('macbox', (p) => { p.probed = probed('darwin', home) as never })
    const before = execRuns().length
    const walk = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'du -sh ~' }, OWN_SID)
    expect(walk).toMatchObject({ status: 409, body: { code: 'may_prompt', error: expect.stringContaining("permission dialog on Mac box's screen") } })
    expect(walk.body.error).toContain('allow_prompts')
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'cat ~/Documents/plan.txt' }, OWN_SID)).body.code).toBe('may_prompt')
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'du -sh .', cwd: '~' }, OWN_SID)).body.code).toBe('may_prompt')
    expect(execRuns().length).toBe(before)
    // Its own folder runs; so does the walk once the user agreed, and the host is told so.
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'du -sh ~/work >/dev/null; echo ok' }, OWN_SID)).body).toMatchObject({ output: 'ok\n' })
    expect((await api('POST', '/api/v1/hosts/macbox/exec', { command: 'du -sh . >/dev/null; echo ok', cwd: '~/work' }, OWN_SID)).body).toMatchObject({ output: 'ok\n' })
    expect(execRuns().at(-1)!.params.allowPrompts).toBeUndefined()
    const agreed = await api('POST', '/api/v1/hosts/macbox/exec', { command: 'du -sh ~ >/dev/null; echo ok', allow_prompts: true }, OWN_SID)
    expect(agreed).toMatchObject({ status: 200, body: { output: 'ok\n' } })
    expect(execRuns().at(-1)!.params).toMatchObject({ allowPrompts: true })
    // A host whose system Walnut has not seen refuses a guarded read itself, in its own words.
    const self = await api('POST', '/api/v1/hosts/tccmac/exec', { command: 'du -sh ~' }, OWN_SID)
    expect(self).toMatchObject({ status: 409, body: { code: 'may_prompt', error: expect.stringContaining('this Mac') } })
    // A run the host found idle at a dialog: stopped, and the answer says which dialog.
    const blocked = await executeOp('host_exec', { host: 'tccmac', command: 'echo waiting; sleep 30' }, asOwn()) as { ok: boolean; result: Record<string, unknown> }
    expect(blocked).toMatchObject({ ok: true, result: { running: false, blocked: { reason: 'password_prompt', service: 'SecurityAgent' }, output: 'waiting\n' } })
    expect(String(blocked.result.outcome)).toMatch(/^Stopped on tccmac .* it was waiting on a dialog\. It sat idle at a password dialog/)
    expect(String(blocked.result.outcome)).toContain('allow_prompts:true')
    const listed = await api('GET', '/api/v1/hosts/tccmac/exec', undefined, OWN_SID)
    expect(listed.body.jobs[0]).toMatchObject({ jobId: blocked.result.jobId, state: 'blocked', blocked: { reason: 'password_prompt' } })
  }, 30_000)
})
