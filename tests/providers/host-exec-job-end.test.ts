/**
 * How a host_exec job ends once its shell exited by itself (src/providers/host-exec-core.ts,
 * host-exec-group.ts), from the 2026-11-04 code review (repros bg-amp, group-race):
 *
 *   - while what the shell left in its group is being stopped, the job still reads running, but
 *     says its shell has exited (`shellExited`), with no deadline: a background `server &` whose
 *     port listened read "keeps running" until the server was stopped 2 s later;
 *   - a deadline or a stop in that window is no timeout and no stop of the run: it ended by itself,
 *     and what it left is stopped at once and named (a deadline there answered "stopped at its
 *     deadline (exit 0)" and never named the `&` child);
 *   - a process outside the job's group (setsid) that holds its output is cut off, not stopped,
 *     and says so (`outputCut`), never `leftBehind`;
 *   - an ordinary `cmd &` that keeps the job's output is in its group: it is stopped and named,
 *     never told as outside it, and what it prints as it stops is kept (code review 6, item 1);
 *   - all of that only when the server asks (`endGroup`): a run from a server older than
 *     host-exec-group-v1 ends as before, its redirected `&` child running on, and a child that
 *     still holds its output stopped 2 s after the shell (code review 6, item 2).
 *
 * MACHINE SAFETY: every path is a temp dir; the one listener binds 127.0.0.1 on a free port; the
 * commands are sh builtins, sleep and setsid; the setsid'd sleep and the legacy run's child are
 * found by their own unique argument or pid and killed by pid at the end.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { guardedPath } from '../setup/exec-guard.js'
import { createHostExec } from '../../src/providers/host-exec-core.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-job-end-')))
const core = createHostExec({
  spawn, killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
  shell: '/bin/sh', home: root, taskDirRoot: null, stateDir: path.join(root, 'state'),
  env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: root }, promptProbe: null,
})
afterAll(async () => {
  for (const j of (await core.list()).jobs) if (j.running) await core.kill({ jobId: j.jobId }).catch(() => {})
  core.close()
  if (root.includes('walnut-host-exec-job-end-')) fs.rmSync(root, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** Read the job until `ok` holds of it (or 10 s passed). */
async function until(jobId: string, ok: (j: Awaited<ReturnType<typeof core.read>>) => boolean) {
  const t0 = Date.now()
  for (;;) {
    const j = await core.read({ jobId })
    if (ok(j) || Date.now() - t0 > 10_000) return j
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('a job whose shell exited by itself', () => {
  it('a background `server &` reads shellExited while the server is stopped, with no deadline, and its end names the server', async () => {
    const port = await freePort()
    const server = `${process.execPath} -e "require('net').createServer(()=>{}).listen(${port},'127.0.0.1'); setInterval(() => {}, 1000)"`
    await core.run({ jobId: 'hx-job-end-0001', command: `${server} >/dev/null 2>&1 &`, background: true, cwd: root, endGroup: true })
    const r = await core.read({ jobId: 'hx-job-end-0001', wait: 8_000, until: { port } })
    expect(r).toMatchObject({ running: true, shellExited: true, waitedFor: { matched: 'port' } })
    expect(r.deadlineInMs).toBeUndefined()
    const end = await core.read({ jobId: 'hx-job-end-0001', wait: 15_000 })
    expect(end).toMatchObject({ running: false, exitCode: 0, timedOut: false, killed: false, leftBehind: true })
    expect(end.leftCommands?.join(' ')).toContain('createServer')
    expect(end.shellExited).toBeUndefined()
  }, 30_000)

  it('a deadline right after its shell exited is no timeout: the exit stands, and the `&` child is stopped and named', async () => {
    const r = await core.run({ jobId: 'hx-job-end-0002', command: 'sleep 1; sleep 30 >/dev/null 2>&1 &', timeoutMs: 1_500, cwd: root, endGroup: true })
    expect(r).toMatchObject({ running: false, exitCode: 0, timedOut: false, killed: false, leftBehind: true, leftCommands: ['sleep 30'] })
  }, 20_000)

  it('a stop right after its shell exited stops what it left at once, and the run reads as exited, not stopped', async () => {
    await core.run({ jobId: 'hx-job-end-0003', command: 'sleep 0.2; sleep 31 >/dev/null 2>&1 &', background: true, cwd: root, endGroup: true })
    expect(await until('hx-job-end-0003', (j) => j.shellExited === true)).toMatchObject({ running: true, shellExited: true })
    const t0 = Date.now()
    await core.kill({ jobId: 'hx-job-end-0003' })
    const end = await core.read({ jobId: 'hx-job-end-0003', wait: 10_000 })
    expect(end).toMatchObject({ running: false, exitCode: 0, timedOut: false, killed: false, leftBehind: true, leftCommands: ['sleep 31'] })
    // At once: not after the 2 s the group otherwise gets.
    expect(Date.now() - t0).toBeLessThan(1_500)
  }, 20_000)

  it.runIf(fs.existsSync('/usr/bin/setsid'))('a process outside its group that holds its output is cut off and still runs: outputCut, not leftBehind', async () => {
    const mark = `${70 + (process.pid % 20)}.${(process.pid % 997) + 1}`
    // The shell records the pid it started; it is signalled only while it is still that `sleep`.
    const pidFile = path.join(root, 'hx-job-end-0004.pid')
    const recorded = () => { try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) } catch { return 0 } }
    const isOurSleep = (pid: number) => { try { return pid > 1 && fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim() === `sleep ${mark}` } catch { return false } }
    try {
      const r = await core.run({ jobId: 'hx-job-end-0004', command: `setsid sleep ${mark} & echo $! > '${pidFile}'`, timeoutMs: 10_000, cwd: root, endGroup: true })
      expect(r).toMatchObject({ running: false, exitCode: 0, leftBehind: false, outputCut: true })
      expect(r.leftCommands).toBeUndefined()
      expect(isOurSleep(recorded())).toBe(true)
    } finally {
      const pid = recorded()
      if (isOurSleep(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 20_000)

  it('an ordinary `cmd &` that keeps its output is stopped and named, never told as outside its group, and what it prints as it stops is kept', async () => {
    // Code review 6, item 1: `echo hi; sleep 37.123 &` answered leftBehind with outputCut, and the
    // answer said a process outside the group still ran; the pipes were cut before its SIGTERM.
    const sleep = `${30 + (process.pid % 20)}.${(process.pid % 997) + 1}`
    const r = await core.run({ jobId: 'hx-job-end-0005', command: `echo hi; sleep ${sleep} &`, timeoutMs: 15_000, cwd: root, endGroup: true })
    expect(r).toMatchObject({ running: false, exitCode: 0, leftBehind: true, leftCommands: [`sleep ${sleep}`] })
    expect(r.outputCut).toBeUndefined()
    const last = await core.run({ jobId: 'hx-job-end-0006', command: `echo hi; sh -c "trap 'echo stopping; exit 0' TERM; sleep 32 & wait" &`, timeoutMs: 15_000, cwd: root, endGroup: true })
    expect(last).toMatchObject({ running: false, exitCode: 0, leftBehind: true })
    expect(last.outputCut).toBeUndefined()
    expect(last.output).toContain('stopping')
  }, 30_000)
})

describe('a run from a server that does not ask to end its group (older than host-exec-group-v1)', () => {
  /** Whether a process still runs (a zombie waiting for its reaper does not). */
  const alive = (pid: number) => {
    try { process.kill(pid, 0) } catch { return false }
    try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
  }

  it('ends with its shell, and its `&` child that sent its output elsewhere keeps running, as before', async () => {
    const r = await core.run({ jobId: 'hx-job-end-0007', command: 'sleep 63 >/dev/null 2>&1 & echo "child $!"', timeoutMs: 15_000, cwd: root })
    const pid = Number(/child (\d+)/.exec(r.output)?.[1])
    expect(pid).toBeGreaterThan(1)
    try {
      expect(r).toMatchObject({ running: false, exitCode: 0, leftBehind: false })
      expect(r.ms).toBeLessThan(1_500)
      await new Promise((res) => setTimeout(res, 2_500))
      expect(alive(pid)).toBe(true)
    } finally {
      if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 20_000)

  it('a child that still holds its output is stopped 2 s after the shell, as before', async () => {
    const r = await core.run({ jobId: 'hx-job-end-0008', command: 'sleep 64 & echo "child $!"', timeoutMs: 15_000, cwd: root })
    const pid = Number(/child (\d+)/.exec(r.output)?.[1])
    try {
      expect(r).toMatchObject({ running: false, exitCode: 0, leftBehind: true })
      expect(r.outputCut).toBeUndefined()
      const t0 = Date.now()
      while (alive(pid) && Date.now() - t0 < 5_000) await new Promise((res) => setTimeout(res, 100))
      expect(alive(pid)).toBe(false)
    } finally {
      if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 20_000)
})
