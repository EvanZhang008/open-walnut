/**
 * A trigger check's host_exec through a REAL server (core/hosts/trigger-caller.ts, host-exec-target.ts
 * callerOf, routes/host-exec-v1.ts and host-copy-v1.ts, core/peers/capability-router.ts, ops/executor.ts).
 *
 * The bug (2026-11-14): a check is a shell command a host's daemon runs for no session, so its
 * `walnut tools call host_exec_read ...` reached the server as `external` and was refused 403
 * session_only, about 50 times an hour, and its trigger never fired. Now the daemon relays a check's
 * call with the trigger it ran it for (`triggerCaller`), and the call acts for that trigger's task:
 * - an armed trigger's call runs on another host for its owner task, under that task's grant, and
 *   reads back the job it started; without `triggerCaller` it is still refused (the bug's case);
 * - a paused trigger, one gone, one whose check runs on another host than the one that relayed it,
 *   and one with no task are refused, each with its own code, and nothing runs;
 * - a test a task's session asked for acts for that task while it may run, on its own host only;
 * - one box under two host aliases of one daemon is one host: either link vouches for its checks;
 * - a token nobody held, and any call with no caller at all (a person), act for no one;
 * - host_copy takes a check's call too;
 * - whose grants a check uses is the server's word (CronJob.checkActsFor): the session that wrote the
 *   check, never an ownerTaskId or target a caller names, nor a checkActsFor it sends; a new command
 *   is its writer's; a trigger made before the field existed acts for its owner, else its target.
 *
 * Real: the server, the routes, the op executor, the grants, and the target host's core with a real
 * /bin/sh. Fake: the transport to the target host and the routine store's answer for a trigger.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testMatcherStart } from '../helpers/wait-matcher.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-caller-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import * as daemonConnections from '../../src/providers/daemon-connection.js'
import { createHostExec } from '../../src/providers/host-exec-core.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { resetHostExecForTest } from '../../src/core/hosts/host-exec.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import * as routines from '../../src/core/routines/routines-core.js'
import { holdRelayTrigger, noteTestRun, _resetTriggerCallersForTesting } from '../../src/core/hosts/trigger-caller.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { setTriggerDaemonLookupForTest } from '../../src/core/routines/trigger-daemon.js'

let server: HttpServer
let port: number
let hostRoot: string
let ownerTask = ''
let targetTask = ''
const OWNER_SID = 'trigger-caller-e2e-owner'
const TARGET_SID = 'trigger-caller-e2e-target'
const sent: Array<{ cmd: string; params: Record<string, unknown>; host: string }> = []
const cores: Array<{ close: () => void }> = []

/** The routines the store holds, as getRoutine answers them. */
const jobs = new Map<string, Record<string, unknown>>()

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

/** One call as a host's daemon relays a check's `walnut tools call`: external, with what it vouches for. */
function relay(fromHost: string, name: string, args: Record<string, unknown>, triggerCaller?: unknown) {
  return handleGatewayCapability('tools.call', 'external', { name, args, ...(triggerCaller ? { triggerCaller } : {}) }, fromHost)
}

function errorOf(r: Awaited<ReturnType<typeof relay>>): string {
  return r.ok ? '' : `${r.error.code}: ${r.error.message}`
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  hostRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-trigger-caller-e2e-')))
  await fs.mkdir(path.join(hostRoot, 'home'), { recursive: true })
  const core = createHostExec({
    spawn: (await import('node:child_process')).spawn,
    killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
    shell: '/bin/sh', home: path.join(hostRoot, 'home'), taskDirRoot: path.join(hostRoot, 'tasks'),
    stateDir: path.join(hostRoot, 'state'), env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: path.join(hostRoot, 'home') },
    promptProbe: null, matcher: testMatcherStart(),
  })
  cores.push(core)
  // The target host: a current daemon in front of the real host core.
  const macbox = {
    connected: true, hostKey: 'macbox', connect: async () => {}, taskDirRoot: path.join(hostRoot, 'tasks'),
    hasCapability: (c: string) => ['host-exec-v1', 'host-exec-v2', 'task-dir-v1', 'fs.readRange', 'host-exec-wait-v1', 'host-exec-group-v1'].includes(c),
    send: async (cmd: string, params: Record<string, unknown> = {}) => {
      sent.push({ cmd, params, host: 'macbox' })
      try {
        const op = cmd.slice('exec.'.length) as 'run' | 'read' | 'kill' | 'list'
        return { ok: true, ...(await (core[op] as (p: unknown) => Promise<Record<string, unknown>>)(params)) }
      } catch (err) {
        return { ok: false, error: `${cmd} failed: ${(err as Error).message}`, code: (err as { code?: string }).code }
      }
    },
  }
  // The checks' own host: answers nothing (no command of this file runs there).
  const devbox = { connected: true, hostKey: 'devbox', connect: async () => {}, hasCapability: () => false, send: async () => ({ ok: false, error: 'unknown command' }) }
  const fakes: Record<string, unknown> = { macbox, devbox, otherbox: devbox }
  const real = daemonConnections.getDaemonConnection
  vi.spyOn(daemonConnections, 'getDaemonConnection').mockImplementation(async (key, target) =>
    Object.hasOwn(fakes, key) ? fakes[key] as daemonConnections.DaemonConnection : real(key, target))
  const realGetRoutine = routines.getRoutine
  vi.spyOn(routines, 'getRoutine').mockImplementation(async (id: string) => {
    const job = jobs.get(id)
    return job ? { job } : realGetRoutine(id)
  })
  // The checks' host daemon, as trigger saves see it: it takes any trigger set.
  setTriggerDaemonLookupForTest(async (host) => (host === 'devbox' ? {
    hostKey: 'devbox', connected: true, hasCapability: () => true,
    send: async () => ({ ok: true, applied: true, changed: true, count: 1 }),
  } as never : null))
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  // Registered hosts: a task on one of them uses another with no letter (host-exec-grant.ts).
  await updateConfig({ hosts: { devbox: { hostname: 'devbox.example' }, otherbox: { hostname: 'otherbox.example' }, macbox: { hostname: 'macbox.example', label: 'Mac box' } } } as never)
  ownerTask = (await api('POST', '/api/v1/tasks', { title: 'Watch the iOS run' })).body.task.id
  targetTask = (await api('POST', '/api/v1/tasks', { title: 'Hear about it' })).body.task.id
  await createSessionRecord(OWNER_SID, ownerTask, '', '/home/me/watch', { host: 'devbox', title: 'watch', initialProcessStatus: 'stopped' } as never)
  await createSessionRecord(TARGET_SID, targetTask, '', '/home/me/hear', { host: 'devbox', title: 'hear', initialProcessStatus: 'stopped' } as never)
  const check = { run: 'sh check.sh', host: 'devbox', timeoutSeconds: 30 }
  const executor = { type: 'session', config: { target: targetTask, prompt: 'x' } }
  jobs.set('trg-armed', { id: 'trg-armed', enabled: true, check, executor, ownerTaskId: targetTask, checkActsFor: ownerTask })
  // Saved before checkActsFor (no field): its owner, else the task it delivers into.
  jobs.set('trg-legacy-owner', { id: 'trg-legacy-owner', enabled: true, check, executor, ownerTaskId: ownerTask })
  jobs.set('trg-delivers', { id: 'trg-delivers', enabled: true, check, executor })
  // The server decided no task (''): an owner or target a caller wrote is no grant.
  jobs.set('trg-forged-owner', { id: 'trg-forged-owner', enabled: true, check, executor, ownerTaskId: ownerTask, checkActsFor: '' })
  jobs.set('trg-paused', { id: 'trg-paused', enabled: false, check, executor, checkActsFor: ownerTask })
  jobs.set('trg-clock', { id: 'trg-clock', enabled: true, executor, checkActsFor: ownerTask })
  jobs.set('trg-no-task', { id: 'trg-no-task', enabled: true, check, executor: { type: 'router', config: {} } })
  jobs.set('trg-gone-task', { id: 'trg-gone-task', enabled: true, check, executor, checkActsFor: 'no-such-task' })
}, 120_000)

afterAll(async () => {
  for (const c of cores) c.close()
  setTriggerDaemonLookupForTest(null)
  await stopServer()
  vi.restoreAllMocks()
  resetHostExecForTest()
  _resetTriggerCallersForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(hostRoot, { recursive: true, force: true }).catch(() => {})
})

describe('a trigger check\'s host_exec', () => {
  it('was refused as "not a session" with nothing to say whose check it is (the bug)', async () => {
    const r = await relay('devbox', 'host_exec', { host: 'macbox', command: 'echo hi' })
    expect(errorOf(r)).toContain('session_only')
    expect(sent).toEqual([])
  })

  it('runs for its owner task, and reads back the job it started', async () => {
    const r = await relay('devbox', 'host_exec', { host: 'macbox', command: 'echo from-the-check' }, { kind: 'armed', id: 'trg-armed' })
    expect(errorOf(r)).toBe('')
    const out = (r as { result: Record<string, unknown> }).result
    expect(out).toMatchObject({ exitCode: 0, running: false })
    expect(String(out.output)).toContain('from-the-check')
    const run = sent.find((s) => s.cmd === 'exec.run')!
    expect(run.params.taskId).toBe(ownerTask)
    // The next run of the check reads the job: it is its task's.
    const read = await relay('devbox', 'host_exec_read', { host: 'macbox', job_id: String(out.jobId) }, { kind: 'armed', id: 'trg-armed' })
    expect(errorOf(read)).toBe('')
    expect((read as { result: Record<string, unknown> }).result).toMatchObject({ running: false, exitCode: 0 })
    // No caller at all: still refused, even right after.
    expect(errorOf(await relay('devbox', 'host_exec_read', { host: 'macbox', job_id: String(out.jobId) }))).toContain('session_only')
  })

  it('a trigger made before checkActsFor acts for its owner, else the task it delivers into', async () => {
    expect(errorOf(await relay('devbox', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'armed', id: 'trg-legacy-owner' }))).toBe('')
    expect(sent.filter((s) => s.cmd === 'exec.run').at(-1)!.params.taskId).toBe(ownerTask)
    expect(errorOf(await relay('devbox', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'armed', id: 'trg-delivers' }))).toBe('')
    expect(sent.filter((s) => s.cmd === 'exec.run').at(-1)!.params.taskId).toBe(targetTask)
  })

  it('refuses a paused trigger, one gone, one with no check, one with no task, and one relayed by another host', async () => {
    const before = sent.length
    const cases: Array<[string, string, string]> = [
      ['devbox', 'trg-paused', 'trigger_off'],
      ['devbox', 'trg-clock', 'trigger_off'],
      ['devbox', 'trg-nowhere', 'trigger_gone'],
      ['devbox', 'trg-no-task', 'trigger_no_task'],
      ['devbox', 'trg-forged-owner', 'trigger_no_task'],
      ['devbox', 'trg-gone-task', 'trigger_no_task'],
      // Only the daemon of the check's own host vouches for it.
      ['otherbox', 'trg-armed', 'trigger_wrong_host'],
    ]
    for (const [from, id, code] of cases) {
      expect(errorOf(await relay(from, 'host_exec', { host: 'macbox', command: 'echo never' }, { kind: 'armed', id })), `${id} from ${from}`).toContain(code)
    }
    expect(sent.slice(before).filter((s) => s.cmd === 'exec.run')).toEqual([])
  })

  it('a test a task\'s session asked for acts for that task, on its own host only', async () => {
    const id = noteTestRun(ownerTask, 'devbox', 30)!
    expect(id).toMatch(/^tt-/)
    const ok = await relay('devbox', 'host_exec', { host: 'macbox', command: 'echo tested' }, { kind: 'test', id })
    expect(errorOf(ok)).toBe('')
    expect(sent.filter((s) => s.cmd === 'exec.run').at(-1)!.params.taskId).toBe(ownerTask)
    expect(errorOf(await relay('otherbox', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'test', id }))).toContain('trigger_test_over')
    expect(errorOf(await relay('devbox', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'test', id: 'tt-neverminted00' }))).toContain('trigger_test_over')
    // A malformed one is no trigger at all: the call stays "not a session".
    expect(errorOf(await relay('devbox', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'test', id: 'not-a-test' }))).toContain('session_only')
  })

  it('one box under two host aliases: a check of either alias is vouched for over either link', async () => {
    // 2026-11-19: clouddev and newdev are one daemon, which relays a check's call over either
    // link; a check armed on clouddev called in over newdev and was refused trigger_wrong_host.
    // The two links' hellos name one daemon process (daemon-connection.ts oneDaemon); otherbox's another.
    const link = (host: string, liveInstanceId: string) => ({ host, connected: true, liveInstanceId }) as unknown as daemonConnections.DaemonConnection
    daemonConnections.setPooledConnectionForTest('devbox', link('devbox', 'd-one'))
    daemonConnections.setPooledConnectionForTest('devbox-net', link('devbox-net', 'd-one'))
    daemonConnections.setPooledConnectionForTest('otherbox', link('otherbox', 'd-two'))
    try {
      expect(errorOf(await relay('devbox-net', 'host_exec', { host: 'macbox', command: 'echo over-the-other-link' }, { kind: 'armed', id: 'trg-armed' }))).toBe('')
      expect(sent.filter((s) => s.cmd === 'exec.run').at(-1)!.params.taskId).toBe(ownerTask)
      // A test of the check, started under one alias, relayed over the other, both ways.
      const viaNet = noteTestRun(ownerTask, 'devbox-net', 30)!
      expect(errorOf(await relay('devbox', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'test', id: viaNet }))).toBe('')
      const viaSsh = noteTestRun(ownerTask, 'devbox', 30)!
      expect(errorOf(await relay('devbox-net', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'test', id: viaSsh }))).toBe('')
      // The caller is on the check's own host, whichever link relayed it.
      const { triggerCallerInScope, withTriggerCaller } = await import('../../src/core/hosts/trigger-caller.js')
      const token = holdRelayTrigger({ kind: 'armed', id: 'trg-armed' }, 'devbox-net')
      expect((await withTriggerCaller(token, () => triggerCallerInScope()))?.host).toBe('devbox')
      // Another daemon is still another host, and so is a link with no daemon confirmed on it.
      expect(errorOf(await relay('otherbox', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'armed', id: 'trg-armed' }))).toContain('trigger_wrong_host')
      daemonConnections.setPooledConnectionForTest('devbox-net', link('devbox-net', null as never))
      expect(errorOf(await relay('devbox-net', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'armed', id: 'trg-armed' }))).toContain('trigger_wrong_host')
      daemonConnections.setPooledConnectionForTest('devbox-net', link('devbox-net', 'd-one'))
      expect(errorOf(await relay('otherbox', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'test', id: viaSsh }))).toContain('trigger_test_over')
    } finally {
      for (const h of ['devbox', 'devbox-net', 'otherbox']) daemonConnections.setPooledConnectionForTest(h, null)
    }
  })

  it('a token this server never held, or one with no caller behind it, acts for no one', async () => {
    const forged = 'ab'.repeat(24)
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, { 'x-walnut-caller-sid': 'external', 'x-walnut-caller-trigger': forged }))
      .toMatchObject({ status: 403, body: { code: 'session_only' } })
    // A real token, but a person's request (no caller id): never a check's.
    const held = holdRelayTrigger({ kind: 'armed', id: 'trg-armed' }, 'devbox')!
    expect(await api('POST', '/api/v1/hosts/macbox/exec', { command: 'true' }, { 'x-walnut-caller-trigger': held }))
      .toMatchObject({ status: 403, body: { code: 'session_only' } })
  })

  it('host_copy takes a check\'s call too', async () => {
    const without = await relay('devbox', 'host_copy', { from: '/tmp/a', to: '/tmp/b', from_host: 'devbox', to_host: 'macbox' })
    expect(errorOf(without)).toContain('session_only')
    const withTrigger = await relay('devbox', 'host_copy', { from: '/tmp/a', to: '/tmp/b', from_host: 'devbox', to_host: 'macbox' }, { kind: 'armed', id: 'trg-armed' })
    // It gets past who-is-asking; what happens next (the fake hosts copy nothing) is not this test's.
    expect(errorOf(withTrigger)).not.toContain('session_only')
  })

  it('whose grants a check uses is the server\'s word, not the request\'s', async () => {
    const asSession = (sid: string) => ({ 'x-walnut-caller-sid': sid, 'x-walnut-origin': 'host:devbox' })
    const lastRunTask = () => sent.filter((s) => s.cmd === 'exec.run').at(-1)!.params.taskId
    // The target task's session writes a check that names the owner task everywhere it can.
    const made = await api('POST', '/api/v1/routines', {
      name: 'Borrow', schedule: { kind: 'every', everyMs: 60_000 },
      check: { run: 'sh borrow.sh', host: 'devbox' },
      executor: { type: 'session', config: { target: ownerTask, prompt: 'x' } },
      ownerTaskId: ownerTask, checkActsFor: ownerTask,
    }, asSession(TARGET_SID))
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.job.id as string
    expect(made.body.job.checkActsFor).toBe(targetTask)
    expect(errorOf(await relay('devbox', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'armed', id }))).toBe('')
    expect(lastRunTask()).toBe(targetTask)
    // Another session changes the owner and sends a checkActsFor: neither moves it.
    const owned = await api('PATCH', `/api/v1/routines/${id}`, { ownerTaskId: ownerTask, checkActsFor: ownerTask }, asSession(OWNER_SID))
    expect(owned.status, JSON.stringify(owned.body)).toBe(200)
    expect(owned.body.job.checkActsFor).toBe(targetTask)
    // A new command is its writer's check.
    const rewritten = await api('PATCH', `/api/v1/routines/${id}`, { check: { run: 'sh mine.sh', host: 'devbox' } }, asSession(OWNER_SID))
    expect(rewritten.status, JSON.stringify(rewritten.body)).toBe(200)
    expect(rewritten.body.job.checkActsFor).toBe(ownerTask)
    // trigger_create: the calling session's task, whatever task it delivers into.
    const armed = await api('POST', '/api/v1/routines/trigger', {
      run: 'sh watch.sh', every: '5m', name: 'Watch', description: 'Watch a job', prompt: 'x', host: 'devbox', session: ownerTask,
    }, asSession(TARGET_SID))
    expect(armed.status, JSON.stringify(armed.body)).toBeLessThan(300)
    expect(armed.body.job.checkActsFor).toBe(targetTask)
    // A program on another host with no session: the server stores "no task", whatever the body names.
    const stranger = await api('POST', '/api/v1/routines', {
      name: 'Stranger', schedule: { kind: 'every', everyMs: 60_000 }, check: { run: 'sh s.sh', host: 'devbox' },
      executor: { type: 'session', config: { target: ownerTask, prompt: 'x' } }, ownerTaskId: ownerTask,
    }, { 'x-walnut-origin': 'host:devbox' })
    expect(stranger.status, JSON.stringify(stranger.body)).toBe(201)
    expect(stranger.body.job.checkActsFor).toBe('')
    expect(errorOf(await relay('devbox', 'host_exec', { host: 'macbox', command: 'true' }, { kind: 'armed', id: stranger.body.job.id }))).toContain('trigger_no_task')
  })
})
