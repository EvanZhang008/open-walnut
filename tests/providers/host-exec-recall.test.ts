/**
 * A host_exec job outlives the daemon that ran it (src/providers/host-exec-recall.ts).
 * 2026-11-16: a task's test run on a dev box ended, the daemon was updated, and every read of
 * the finished run answered 404 `unknown_job` for half an hour, though its log and its audit end
 * line were on disk. Here one core runs jobs and a second core on the same state dir (the new
 * daemon) answers for them.
 *
 * The class guard: the job a new daemon reads back must answer exactly as the one that ran it
 * did, field for field, so a field added to JobView that the audit does not carry fails here.
 *
 * MACHINE SAFETY: every path is a temp dir; the commands are sh builtins (echo, exit) only.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { guardedPath } from '../setup/exec-guard.js'
import { testMatcherStart } from '../helpers/wait-matcher.js'
import { createHostExec, type HostExecDeps } from '../../src/providers/host-exec-core.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-recall-')))
const stateDir = path.join(root, 'state')
const taskDirRoot = path.join(root, 'tasks')
const auditFile = path.join(stateDir, 'host-exec-audit.jsonl')
const TASK = 'recall-task-1'
const cores: Array<ReturnType<typeof createHostExec>> = []

function daemon(extra: Partial<HostExecDeps> = {}) {
  const core = createHostExec({
    spawn, killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
    shell: '/bin/sh', home: root, taskDirRoot, stateDir,
    env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: root }, promptProbe: null, matcher: testMatcherStart(), ...extra,
  })
  cores.push(core)
  return core
}

afterAll(async () => {
  for (const c of cores) {
    for (const j of (await c.list()).jobs) if (j.running) await c.kill({ jobId: j.jobId }).catch(() => {})
    c.close()
  }
  if (root.includes('walnut-host-exec-recall-')) fs.rmSync(root, { recursive: true, force: true })
})

async function ended(core: ReturnType<typeof createHostExec>, jobId: string) {
  const t0 = Date.now()
  for (;;) {
    const j = await core.read({ jobId, taskId: TASK })
    if (!j.running || Date.now() - t0 > 10_000) return j
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Audit lines as an older or a lost daemon left them (a string goes in as it is: a torn line). */
function appendAudit(lines: Array<Record<string, unknown> | string>): void {
  fs.mkdirSync(stateDir, { recursive: true })
  fs.appendFileSync(auditFile, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
}

describe('a job read back after a daemon swap', () => {
  it('answers a finished run exactly as the daemon that ran it did', async () => {
    const before = daemon()
    await before.run({ jobId: 'hx-recall-done-01', taskId: TASK, command: 'echo APPLIED; echo PW_DONE; exit 3', background: true })
    const old = await ended(before, 'hx-recall-done-01')
    expect(old.exitCode).toBe(3)

    const after = daemon()
    const now = await after.read({ jobId: 'hx-recall-done-01', taskId: TASK })
    // Field for field: a JobView field the audit forgets is a regression of this class.
    expect(now).toEqual(old)
    expect(now.output).toContain('PW_DONE')

    // A wait_for over its output holds at once (the 2026-11-16 caller waited on PW_DONE).
    const waited = await after.read({ jobId: 'hx-recall-done-01', taskId: TASK, until: { output: 'PW_DONE' }, wait: 2_000 })
    expect(waited.waitedFor?.matched).toBe('output')

    // Its task lists it; another task neither lists nor reads it.
    expect((await after.list({ taskId: TASK })).jobs.map((j) => j.jobId)).toContain('hx-recall-done-01')
    expect((await after.list({ taskId: 'someone-else' })).jobs.map((j) => j.jobId)).not.toContain('hx-recall-done-01')
    await expect(after.read({ jobId: 'hx-recall-done-01', taskId: 'someone-else' })).rejects.toMatchObject({ code: 'unknown_job' })

    // The same id again never runs a second time; a stop changes nothing; it never counts as running.
    await expect(after.run({ jobId: 'hx-recall-done-01', taskId: TASK, command: 'echo again', background: true })).rejects.toMatchObject({ code: 'job_exists' })
    expect((await after.kill({ jobId: 'hx-recall-done-01', taskId: TASK })).exitCode).toBe(3)
    expect(after.running()).toBe(0)
  })

  it('answers a resumable run (exec.run resumable) field for field too: it still says resumable', async () => {
    const before = daemon()
    await before.run({ jobId: 'hx-recall-resumable-01', taskId: TASK, command: 'echo waited; exit 0', background: true, resumable: true })
    const old = await ended(before, 'hx-recall-resumable-01')
    expect(old).toMatchObject({ running: false, exitCode: 0, resumable: true })
    expect(await daemon().read({ jobId: 'hx-recall-resumable-01', taskId: TASK })).toEqual(old)
  })

  it('answers a run that hit its deadline, and one host_exec_stop ended, field for field too', async () => {
    const before = daemon()
    await before.run({ jobId: 'hx-recall-deadline-01', taskId: TASK, command: 'echo started; sleep 30', background: true, timeoutMs: 300 })
    await before.run({ jobId: 'hx-recall-stopped-01', taskId: TASK, command: 'echo started; sleep 30', background: true })
    await before.kill({ jobId: 'hx-recall-stopped-01', taskId: TASK })
    const deadline = await ended(before, 'hx-recall-deadline-01')
    const stopped = await ended(before, 'hx-recall-stopped-01')
    expect(deadline.timedOut).toBe(true)
    expect(stopped.killed).toBe(true)
    const after = daemon()
    expect(await after.read({ jobId: 'hx-recall-deadline-01', taskId: TASK })).toEqual(deadline)
    expect(await after.read({ jobId: 'hx-recall-stopped-01', taskId: TASK })).toEqual(stopped)
  })

  it('leaves a run whose daemon still lives to that daemon, and tells a forced update from host_exec_stop', async () => {
    const t = Date.now()
    appendAudit([
      { at: new Date(t).toISOString(), event: 'start', jobId: 'hx-recall-alive-01', taskId: TASK, daemonPid: 424242, cwd: root, command: 'x', logFile: path.join(root, 'alive.log') },
      { at: new Date(t).toISOString(), event: 'start', jobId: 'hx-recall-update-01', taskId: TASK, daemonPid: 434343, cwd: root, command: 'x', logFile: path.join(root, 'update.log') },
      { at: new Date(t + 5).toISOString(), event: 'ended-by-update', jobId: 'hx-recall-update-01', taskId: TASK },
      { at: new Date(t + 9).toISOString(), event: 'end', jobId: 'hx-recall-update-01', exitCode: null, signal: 'SIGTERM', timedOut: false, killed: true, ms: 9, bytes: 0 },
    ])
    const alive = new Set([424242])
    const after = daemon({ pidAlive: (pid) => alive.has(pid) })
    await expect(after.read({ jobId: 'hx-recall-alive-01', taskId: TASK })).rejects.toMatchObject({ code: 'unknown_job' })
    alive.clear()
    expect(await after.read({ jobId: 'hx-recall-alive-01', taskId: TASK })).toMatchObject({ running: false, daemonEnded: true })
    expect(await after.read({ jobId: 'hx-recall-update-01', taskId: TASK })).toMatchObject({ running: false, killed: false, signal: 'SIGTERM', daemonEnded: true })
  })

  it('reads a run its daemon never saw end as ended with that daemon, and never holds an update', async () => {
    const dir = path.join(taskDirRoot, TASK, 'host-exec')
    fs.mkdirSync(dir, { recursive: true })
    const logFile = path.join(dir, 'hx-recall-lost-01.log')
    fs.writeFileSync(logFile, 'half way\n')
    appendAudit([{ at: new Date().toISOString(), event: 'start', jobId: 'hx-recall-lost-01', task: TASK, host: 'x', taskId: TASK, cwd: root, command: 'sleep 600', background: true, timeoutMs: 7_200_000, shell: 'bash', logFile, taskDir: path.join(taskDirRoot, TASK) }])
    const after = daemon()
    const j = await after.read({ jobId: 'hx-recall-lost-01', taskId: TASK })
    expect(j).toMatchObject({ running: false, exitCode: null, daemonEnded: true, output: 'half way\n' })
    expect(after.running()).toBe(0)
    expect(after.active()).toEqual([])
  })

  it('reads an audit line written before the start line named its task and log', async () => {
    const dir = path.join(taskDirRoot, TASK, 'host-exec')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'hx-recall-old-01.log'), 'PW_DONE\n')
    const at = Date.now() - 5_000
    appendAudit([
      { at: new Date(at).toISOString(), event: 'start', jobId: 'hx-recall-old-01', task: TASK, host: '__local__', cwd: root, command: 'x', background: true, timeoutMs: 7_200_000, shell: 'bash' },
      '{"at":"torn',
      { at: new Date(at + 1_000).toISOString(), event: 'end', jobId: 'hx-recall-old-01', task: TASK, host: '__local__', exitCode: 0, signal: null, timedOut: false, killed: false, ms: 1_000, bytes: 8 },
    ])
    const j = await daemon().read({ jobId: 'hx-recall-old-01', taskId: TASK })
    expect(j).toMatchObject({ running: false, exitCode: 0, ms: 1_000, taskId: TASK, output: 'PW_DONE\n' })
    expect(j.daemonEnded).toBeUndefined()
  })

  it('keeps a finished run an hour, as the daemon that ran it would, and skips a run that never started', async () => {
    const t = Date.now()
    appendAudit([
      { at: new Date(t).toISOString(), event: 'start', jobId: 'hx-recall-aged-01', taskId: TASK, cwd: root, command: 'x', logFile: path.join(root, 'none.log') },
      { at: new Date(t + 10).toISOString(), event: 'end', jobId: 'hx-recall-aged-01', exitCode: 0, ms: 10, bytes: 0 },
      { at: new Date(t).toISOString(), event: 'start', jobId: 'hx-recall-nospawn-01', taskId: TASK, cwd: root, command: 'x' },
      { at: new Date(t).toISOString(), event: 'end', jobId: 'hx-recall-nospawn-01', error: 'spawn ENOENT' },
    ])
    expect((await daemon().read({ jobId: 'hx-recall-aged-01', taskId: TASK })).exitCode).toBe(0)
    const later = daemon({ now: () => t + 61 * 60_000 })
    await expect(later.read({ jobId: 'hx-recall-aged-01', taskId: TASK })).rejects.toMatchObject({ code: 'unknown_job' })
    await expect(daemon().read({ jobId: 'hx-recall-nospawn-01', taskId: TASK })).rejects.toMatchObject({ code: 'unknown_job' })
  })

  it('sees what the old daemon writes after the new one first looked, a line written in two parts included', async () => {
    const after = daemon()
    await after.list()
    const before = daemon()
    await before.run({ jobId: 'hx-recall-late-01', taskId: TASK, command: 'echo late', background: true })
    // While the old daemon runs it, its start line alone is there: the new daemon reads it as its own
    // read would after a crash, never as running here.
    expect(after.running()).toBe(0)
    const old = await ended(before, 'hx-recall-late-01')
    expect(await after.read({ jobId: 'hx-recall-late-01', taskId: TASK })).toEqual(old)

    const t = Date.now()
    const line = JSON.stringify({ at: new Date(t).toISOString(), event: 'start', jobId: 'hx-recall-torn-01', taskId: TASK, cwd: root, command: 'x', logFile: path.join(root, 'torn.log') })
    fs.appendFileSync(auditFile, line.slice(0, 40))
    await expect(after.read({ jobId: 'hx-recall-torn-01', taskId: TASK })).rejects.toMatchObject({ code: 'unknown_job' })
    fs.appendFileSync(auditFile, line.slice(40) + '\n' + JSON.stringify({ at: new Date(t + 5).toISOString(), event: 'end', jobId: 'hx-recall-torn-01', exitCode: 7, ms: 5, bytes: 0 }) + '\n')
    expect((await after.read({ jobId: 'hx-recall-torn-01', taskId: TASK })).exitCode).toBe(7)
  })
})
