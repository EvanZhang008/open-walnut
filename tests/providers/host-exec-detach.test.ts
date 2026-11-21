/**
 * A detached host_exec run and plugin script outlive the daemon that started them
 * (src/providers/detached-run.ts, host-exec-core.ts adopt, host-script-detached.ts): the daemon is
 * a real process here (tests/helpers/host-exec-core-proc.ts), SIGKILLed mid-run, and the next one
 * on the same state dir follows the run to its end: its whole output, its exit code, a stop, its
 * deadline. A rollback ends them, by the daemon (endForRollback) or by the launcher's shell script
 * (detached-registry.ts STOP_SCRIPT), which never signals a pid another process holds now.
 *
 * MACHINE SAFETY: every path is a temp dir; the commands are sh builtins, sleep and seq; every
 * signal goes to a process group this file started (checked before: pid > 1).
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { guardedPath } from '../setup/exec-guard.js'
import { createHostExec, type HostExecDeps } from '../../src/providers/host-exec-core.js'
import { STOP_SCRIPT, processStart, registerRun, registryFile } from '../../src/providers/detached-registry.js'
import { detachedChild, exitFileOf, exitOf } from '../../src/providers/detached-run.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-detach-')))
const home = path.join(root, 'home')
const taskDirRoot = path.join(root, 'tasks')
const TASK = 'detach-task-1'
const PATH = guardedPath([], '/usr/bin:/bin')
const PROC = fileURLToPath(new URL('../helpers/host-exec-core-proc.ts', import.meta.url))
fs.mkdirSync(home, { recursive: true })
const cores: Array<ReturnType<typeof createHostExec>> = []
const procs: ChildProcess[] = []
const groups = new Set<number>()

afterAll(async () => {
  for (const p of procs) { try { p.kill('SIGKILL') } catch { /* gone */ } }
  for (const c of cores) c.close()
  for (const g of groups) { if (g > 1) { try { process.kill(-g, 'SIGKILL') } catch { /* gone */ } } }
  if (root.includes('walnut-host-exec-detach-')) fs.rmSync(root, { recursive: true, force: true })
})

function core(stateDir: string, extra: Partial<HostExecDeps> = {}) {
  const c = createHostExec({
    spawn, killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
    shell: '/bin/sh', home, taskDirRoot, stateDir, env: { PATH, HOME: home }, promptProbe: null, ...extra,
  })
  cores.push(c)
  return c
}

/** A daemon in its own process: ask(op, req), and kill() it as a crash would. */
async function daemonProc(stateDir: string, extraEnv: Record<string, string> = {}) {
  const p = spawn(process.execPath, [PROC, stateDir, taskDirRoot, home], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PATH, ...extraEnv } })
  procs.push(p)
  const waiting = new Map<number, (m: { ok: boolean; value?: unknown; error?: string }) => void>()
  let ready: () => void = () => {}
  const up = new Promise<void>((r) => { ready = r })
  readline.createInterface({ input: p.stdout! }).on('line', (line) => {
    const m = JSON.parse(line) as { id?: number; ready?: boolean; ok: boolean }
    if (m.ready) return ready()
    waiting.get(m.id!)?.(m)
  })
  await up
  let n = 0
  return {
    pid: p.pid!,
    ask: <T = Record<string, unknown>>(op: string, req: unknown = {}): Promise<T> => new Promise((resolve, reject) => {
      const id = ++n
      waiting.set(id, (m) => (m.ok ? resolve(m.value as T) : reject(new Error(m.error))))
      p.stdin!.write(JSON.stringify({ id, op, req }) + '\n')
    }),
    kill: async () => { p.kill('SIGKILL'); await new Promise((r) => p.once('exit', r)) },
  }
}

async function until<T>(f: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await f()
    if (ok(v) || Date.now() - t0 > ms) return v
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** The wrapper's pid of a detached run, from the audit's `spawned` line. */
const wrapperPid = async (stateDir: string, jobId: string): Promise<number> => {
  const line = await until(() => fs.readFileSync(path.join(stateDir, 'host-exec-audit.jsonl'), 'utf8').split('\n').find((l) => l.includes('"spawned"') && l.includes(jobId)), (v) => !!v, 5_000)
  return JSON.parse(line!).pid as number
}
const detachReq = (jobId: string, command: string, extra: Record<string, unknown> = {}) => ({ jobId, taskId: TASK, command, background: true, endGroup: true, detach: true, ...extra })
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true } catch { return false } }

describe('a detached host_exec run across daemon restarts', () => {
  it('keeps every line and its exit code across two daemon kills, and the next daemon follows it', async () => {
    const stateDir = path.join(root, 's1')
    const a = await daemonProc(stateDir)
    const started = await a.ask<{ jobId: string; running: boolean; detached?: boolean; pid?: number }>('run', detachReq('hx-detach-long-01', 'i=1; while [ $i -le 40 ]; do echo line-$i; i=$((i+1)); sleep 0.1; done; exit 7'))
    expect(started.running).toBe(true)
    expect(started.detached).toBe(true)
    // A detached run holds no update; a run with pipes does.
    expect(await a.ask('counts')).toMatchObject({ running: 1, holding: 0, detached: 1 })
    // Killed mid-run, once some lines are out.
    await until(() => a.ask<{ output: string }>('read', { jobId: 'hx-detach-long-01', taskId: TASK }), (j) => j.output.includes('line-5\n'), 10_000)
    await a.kill()
    const b = await daemonProc(stateDir)
    expect((await b.ask<{ running: boolean }>('read', { jobId: 'hx-detach-long-01', taskId: TASK })).running).toBe(true)
    await b.kill()
    const c = core(stateDir)
    const end = await until(() => c.read({ jobId: 'hx-detach-long-01', taskId: TASK, wait: 5_000 }), (j) => !j.running)
    expect(end.exitCode).toBe(7)
    expect(end.signal).toBeNull()
    expect(end.daemonEnded).toBeUndefined()
    const lines = end.output.trim().split('\n')
    expect(lines).toEqual(Array.from({ length: 40 }, (_, i) => `line-${i + 1}`))
    // One end line, written by the daemon that saw the end.
    const audit = fs.readFileSync(path.join(stateDir, 'host-exec-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(audit.filter((l) => l.jobId === 'hx-detach-long-01' && l.event === 'end')).toHaveLength(1)
    expect(audit.filter((l) => l.jobId === 'hx-detach-long-01' && l.event === 'adopted').length).toBeGreaterThanOrEqual(2)
    // The exit file stays while the job is kept: a second daemon following it reads the same status.
    expect(fs.readFileSync(end.logFile.replace(/\.log$/, '.exit'), 'utf8').trim()).toBe('7')
  }, 60_000)

  it('a read right after a handover (the next daemon started while the last still ran) answers it running, never ended', async () => {
    const stateDir = path.join(root, 's8')
    const a = await daemonProc(stateDir)
    await a.ask('run', detachReq('hx-overlap-01', 'sleep 3; exit 4'))
    const started = { pid: await wrapperPid(stateDir, 'hx-overlap-01') }
    groups.add(started.pid)
    const b = core(stateDir)
    await a.kill()
    // At once: no 2 s look of the adopt timer has run yet.
    const first = await b.read({ jobId: 'hx-overlap-01', taskId: TASK })
    expect(first).toMatchObject({ running: true })
    expect(first.daemonEnded).toBeUndefined()
    expect((await b.list({ taskId: TASK })).jobs.find((j) => j.jobId === 'hx-overlap-01')).toMatchObject({ running: true })
    const end = await until(() => b.read({ jobId: 'hx-overlap-01', taskId: TASK, wait: 3_000 }), (j) => !j.running, 15_000)
    expect(end).toMatchObject({ running: false, exitCode: 4 })
    expect(end.daemonEnded).toBeUndefined()
  }, 30_000)

  it('ps with no answer at adoption: the run reads running and is adopted on a later look, never ended as killed', async () => {
    const stateDir = path.join(root, 's9')
    const a = await daemonProc(stateDir)
    await a.ask('run', detachReq('hx-ps-null-01', 'sleep 4; exit 6'))
    const started = { pid: await wrapperPid(stateDir, 'hx-ps-null-01') }
    groups.add(started.pid)
    await until(() => fs.readFileSync(path.join(stateDir, 'host-exec-audit.jsonl'), 'utf8').includes('"listed"'), (v) => v, 5_000)
    await a.kill()
    let psAnswers = false
    const b = core(stateDir, { processStart: async (pid) => (psAnswers ? processStart(pid) : null) })
    const during = await b.read({ jobId: 'hx-ps-null-01', taskId: TASK })
    expect(during.running).toBe(true)
    expect(during.daemonEnded).toBeUndefined()
    expect(groupAlive(started.pid)).toBe(true)
    psAnswers = true
    const end = await until(() => b.read({ jobId: 'hx-ps-null-01', taskId: TASK, wait: 3_000 }), (j) => !j.running, 20_000)
    expect(end).toMatchObject({ running: false, exitCode: 6, signal: null })
    const audit = fs.readFileSync(path.join(stateDir, 'host-exec-audit.jsonl'), 'utf8')
    expect(audit).toContain('"adopt-deferred"')
  }, 40_000)

  it('a run whose start was never recorded (its daemon died first) is followed but never signalled', async () => {
    const stateDir = path.join(root, 's10')
    const a = await daemonProc(stateDir, { HOST_EXEC_PROC_NO_PS: '1' })
    await a.ask('run', detachReq('hx-no-start-01', 'sleep 3; exit 5'))
    const started = { pid: await wrapperPid(stateDir, 'hx-no-start-01') }
    groups.add(started.pid)
    await new Promise((r) => setTimeout(r, 300))
    await a.kill()
    const b = core(stateDir)
    // Its reads say a stop cannot reach it (2026-11-21 review R2-3).
    expect(await b.read({ jobId: 'hx-no-start-01', taskId: TASK })).toMatchObject({ running: true, unsignalled: true })
    await b.kill({ jobId: 'hx-no-start-01', taskId: TASK })
    // Its pid may be another program's by now: the stop sends nothing, and the run ends by itself.
    await new Promise((r) => setTimeout(r, 500))
    expect(groupAlive(started.pid)).toBe(true)
    const end = await until(() => b.read({ jobId: 'hx-no-start-01', taskId: TASK, wait: 3_000 }), (j) => !j.running, 15_000)
    expect(end).toMatchObject({ running: false, exitCode: 5 })
    expect(fs.readFileSync(path.join(stateDir, 'host-exec-audit.jsonl'), 'utf8')).toContain('"unverified":true')
  }, 30_000)

  it('a slow ps at adoption never slows a read of another job, nor fails one (2026-11-21 review R2-1, R2-5)', async () => {
    const stateDir = path.join(root, 's11')
    const a = await daemonProc(stateDir)
    await a.ask('run', detachReq('hx-slow-ps-01', 'sleep 6; exit 3'))
    const started = { pid: await wrapperPid(stateDir, 'hx-slow-ps-01') }
    groups.add(started.pid)
    await until(() => fs.readFileSync(path.join(stateDir, 'host-exec-audit.jsonl'), 'utf8').includes('"listed"'), (v) => v, 5_000)
    await a.kill()
    // ps takes 3 s and has no answer, every time.
    const b = core(stateDir, { processStart: async () => { await new Promise((r) => setTimeout(r, 3_000)); return null } })
    await b.run({ jobId: 'hx-slow-other-01', taskId: TASK, command: 'echo hi', background: true })
    // Its first adoption has found no start and is left for the timer.
    await until(() => fs.readFileSync(path.join(stateDir, 'host-exec-audit.jsonl'), 'utf8').includes('"adopt-deferred"'), (v) => v, 10_000)
    const times: number[] = []
    for (let i = 0; i < 3; i++) { const t0 = Date.now(); await b.read({ jobId: 'hx-slow-other-01', taskId: TASK }); times.push(Date.now() - t0) }
    expect(Math.max(...times)).toBeLessThan(1_000)
    // The run itself still reads running, never ended, and a stop cannot reach it yet.
    const during = await b.read({ jobId: 'hx-slow-ps-01', taskId: TASK })
    expect(during).toMatchObject({ running: true, unsignalled: true })
    expect(during.daemonEnded).toBeUndefined()

    // An adoption that throws is said in the audit, never an unhandled rejection.
    const stateDir2 = path.join(root, 's12')
    const a2 = await daemonProc(stateDir2)
    await a2.ask('run', detachReq('hx-ps-throws-01', 'sleep 2'))
    groups.add(await wrapperPid(stateDir2, 'hx-ps-throws-01'))
    await until(() => fs.readFileSync(path.join(stateDir2, 'host-exec-audit.jsonl'), 'utf8').includes('"listed"'), (v) => v, 5_000)
    await a2.kill()
    const c = core(stateDir2, { processStart: async () => { throw new Error('ps blew up') } })
    expect((await c.read({ jobId: 'hx-ps-throws-01', taskId: TASK })).running).toBe(true)
    await until(() => fs.readFileSync(path.join(stateDir2, 'host-exec-audit.jsonl'), 'utf8').includes('"adopt-failed"'), (v) => v, 5_000)
  }, 40_000)

  it('the exit file of a run that ended before a restart goes once the run is forgotten (2026-11-21 review R2-8)', async () => {
    const stateDir = path.join(root, 's13')
    const a = await daemonProc(stateDir)
    await a.ask('run', detachReq('hx-exit-file-01', 'exit 2', { timeoutMs: 5_000 }))
    const ended = await until(() => a.ask<{ running: boolean; logFile: string }>('read', { jobId: 'hx-exit-file-01', taskId: TASK, wait: 2_000 }), (j) => !j.running, 10_000)
    const exitFile = exitFileOf(ended.logFile)
    expect(fs.existsSync(exitFile)).toBe(true)
    await a.kill()
    // The next daemon, past the hour a finished run is kept: the file is removed.
    const later = core(stateDir, { now: () => Date.now() + 2 * 60 * 60_000 })
    later.list({ taskId: TASK })
    await until(() => fs.existsSync(exitFile), (v) => !v, 5_000)
    expect(fs.existsSync(exitFile)).toBe(false)
  }, 30_000)

  it('is stopped by host_exec_stop after a restart, and its deadline still holds', async () => {
    const stateDir = path.join(root, 's2')
    const a = await daemonProc(stateDir)
    await a.ask('run', detachReq('hx-detach-stop-01', 'sleep 60'))
    const timed = await a.ask<{ pid?: number }>('run', detachReq('hx-detach-time-01', 'sleep 60', { timeoutMs: 2_500 }))
    void timed
    await new Promise((r) => setTimeout(r, 300))
    await a.kill()
    const b = core(stateDir)
    const before = await b.read({ jobId: 'hx-detach-stop-01', taskId: TASK })
    expect(before.running).toBe(true)
    await b.kill({ jobId: 'hx-detach-stop-01', taskId: TASK })
    const stopped = await until(() => b.read({ jobId: 'hx-detach-stop-01', taskId: TASK, wait: 2_000 }), (j) => !j.running, 10_000)
    expect(stopped).toMatchObject({ running: false, killed: true, signal: 'SIGTERM', exitCode: null })
    const timedOut = await until(() => b.read({ jobId: 'hx-detach-time-01', taskId: TASK, wait: 2_000 }), (j) => !j.running, 10_000)
    expect(timedOut).toMatchObject({ running: false, timedOut: true, signal: 'SIGTERM' })
    expect(timedOut.ms).toBeLessThan(6_000)
  }, 40_000)

  it('a command that exits 143 itself keeps its exit code; one a stop ended reads as the signal', () => {
    expect(exitOf(143, false)).toEqual({ code: 143, signal: null })
    expect(exitOf(143, true)).toEqual({ code: null, signal: 'SIGTERM' })
    expect(exitOf(0, true)).toEqual({ code: 0, signal: null })
  })

  it('a run let go unsignalled ends with no signal, never as SIGKILL (2026-11-21 review R2-3)', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'letgo-'))
    const child = detachedChild({ exitFile: path.join(dir, 'x.exit'), wrapperAlive: () => false, killedBy: () => null, signalled: () => false, pollMs: 20 })
    const end = await new Promise<[number | null, string | null]>((resolve) => child.once('exit', (code, signal) => resolve([code, signal])))
    expect(end).toEqual([null, null])
    const killed = detachedChild({ exitFile: path.join(dir, 'y.exit'), wrapperAlive: () => false, signalled: () => false, pollMs: 20 })
    expect(await new Promise((resolve) => killed.once('exit', (_c, signal) => resolve(signal)))).toBe('SIGKILL')
  })

  it('a request without detach (an older server) runs with pipes, as before, and holds an update', async () => {
    const c = core(path.join(root, 's3'))
    const r = await c.run({ jobId: 'hx-pipe-01', taskId: TASK, command: 'sleep 1; echo done', background: true, endGroup: true })
    expect(r.detached).toBeUndefined()
    expect(c.holding()).toBe(1)
    expect(c.detachedRunning()).toBe(0)
    const end = await until(() => c.read({ jobId: 'hx-pipe-01', taskId: TASK, wait: 3_000 }), (j) => !j.running)
    expect(end.output).toBe('done\n')
  }, 20_000)

  it('a rollback ends a detached run and says so, and a forced update does not', async () => {
    const stateDir = path.join(root, 's4')
    const c = core(stateDir)
    await c.run(detachReq('hx-roll-01', 'sleep 60'))
    // A forced update ends the runs with pipes only: the next daemon follows a detached one.
    expect(c.endForUpdate('forced')).toBe(0)
    expect((await c.read({ jobId: 'hx-roll-01', taskId: TASK })).running).toBe(true)
    // Listed for the launcher (async: ps names its start).
    await until(() => fs.existsSync(registryFile(c.registryDir, 'host-exec', 'hx-roll-01')), (v) => v, 5_000)
    expect(c.endForRollback()).toBe(1)
    const end = await until(() => c.read({ jobId: 'hx-roll-01', taskId: TASK, wait: 2_000 }), (j) => !j.running, 10_000)
    expect(end).toMatchObject({ running: false, daemonEnded: true, endedBy: 'rollback', killed: false })
    expect(fs.readFileSync(end.logFile, 'utf8')).toContain('rollback')
    await until(() => fs.existsSync(registryFile(c.registryDir, 'host-exec', 'hx-roll-01')), (v) => !v, 5_000)
    // A daemon that reads the audit later (the older one put back) reads it ended, and why.
    const later = core(stateDir)
    expect(await later.read({ jobId: 'hx-roll-01', taskId: TASK })).toMatchObject({ running: false, endedBy: 'rollback' })
  }, 30_000)
})

describe('the stop script a launcher runs before a rollback ends listed work (STOP_SCRIPT, run here by hand)', () => {
  it('stops a listed run whose daemon crashed, records why, and leaves a reused pid alone', async () => {
    const stateDir = path.join(root, 's5')
    const a = await daemonProc(stateDir)
    await a.ask('run', detachReq('hx-stop-script-01', 'sleep 60'))
    const regDir = path.join(stateDir, 'detached')
    const file = registryFile(regDir, 'host-exec', 'hx-stop-script-01')
    await until(() => fs.existsSync(file), (v) => v, 5_000)
    const pid = Number(/^pid=(\d+)$/m.exec(fs.readFileSync(file, 'utf8'))![1])
    groups.add(pid)
    await a.kill()
    expect(groupAlive(pid)).toBe(true)

    // An entry whose pid another process holds now (its start differs): never signalled.
    const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore', env: { PATH } })
    groups.add(other.pid!)
    const otherStart = await processStart(other.pid!)
    expect(otherStart).toBeTruthy()
    await registerRun(regDir, { kind: 'host-exec', id: 'hx-reused-01', pid: other.pid!, pgid: other.pid!, lstart: 'Mon Jan  1 00:00:00 2001', note: 'x', noteFile: path.join(root, 'never.log') })

    const scriptFile = path.join(root, 'stop-detached.sh')
    fs.writeFileSync(scriptFile, STOP_SCRIPT, { mode: 0o700 })
    const r = spawnSync('/bin/sh', [scriptFile, regDir], { encoding: 'utf8', env: { PATH }, timeout: 20_000 })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`stopped host-exec hx-stop-script-01 ${pid}`)
    expect(r.stdout).toContain('gone host-exec hx-reused-01')
    await until(() => groupAlive(pid), (v) => !v, 5_000)
    expect(groupAlive(pid)).toBe(false)
    expect(groupAlive(other.pid!)).toBe(true)
    expect(fs.existsSync(path.join(root, 'never.log'))).toBe(false)
    expect(fs.readdirSync(regDir).filter((f) => f.endsWith('.run'))).toEqual([])
    // The audit says a rollback stopped it: a daemon of either version reads it ended.
    const later = core(stateDir)
    const end = await later.read({ jobId: 'hx-stop-script-01', taskId: TASK })
    expect(end).toMatchObject({ running: false, daemonEnded: true, endedBy: 'rollback' })
    expect(fs.readFileSync(end.logFile, 'utf8')).toContain('rollback')
    other.kill('SIGKILL')
  }, 40_000)
})

describe('a detached plugin script across a daemon restart', () => {
  it('answers the same run when asked again after the restart: whole stdout, its code, run once', async () => {
    const stateDir = path.join(root, 's6')
    const counter = path.join(root, 'script-runs.txt')
    const a = await daemonProc(stateDir)
    const req = { scriptId: 'hs-detach-script-01', detach: true, script: `echo run >> '${counter}'; i=1; while [ $i -le 20 ]; do echo out-$i; i=$((i+1)); sleep 0.1; done; echo err-1 >&2; exit 5`, args: [], timeoutMs: 30_000 }
    const first = a.ask('script', req).catch((e) => e)
    expect(await until(() => a.ask<{ detachedScripts: number }>('counts'), (c) => c.detachedScripts === 1, 5_000)).toMatchObject({ scripts: 0, detachedScripts: 1 })
    await new Promise((r) => setTimeout(r, 700))
    await a.kill()
    void first
    const b = await daemonProc(stateDir)
    const result = await b.ask<{ code: number; stdout: string; stderr: string; timedOut: boolean }>('script', req)
    expect(result.code).toBe(5)
    expect(result.stdout.trim().split('\n')).toEqual(Array.from({ length: 20 }, (_, i) => `out-${i + 1}`))
    expect(result.stderr).toContain('err-1')
    // Asked once more: the kept result, never a second run.
    expect(await b.ask('script', req)).toEqual(result)
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\n')
    await b.kill()
  }, 40_000)

  it('a script without detach (an older server) runs with pipes and holds an update', async () => {
    const c = core(path.join(root, 's7'))
    const run = c.script({ script: 'sleep 1; echo hi', args: [] })
    expect(c.scripts()).toBe(1)
    expect(c.detachedScripts()).toBe(0)
    expect(await run).toMatchObject({ code: 0, stdout: 'hi\n' })
  }, 20_000)
})
