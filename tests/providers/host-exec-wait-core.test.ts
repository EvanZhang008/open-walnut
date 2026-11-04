/**
 * wait_for on the real host core (src/providers/host-exec-core.ts): exec.read `until` waits
 * next to the job's log with the core's own matcher process; exec.run `until` refuses a wait
 * that could never hold here before anything runs, and notes what of it already holds before
 * the run starts (`beforeRun`: a stale server on the port, an old build's file); a foreground
 * run whose background children still held its output when its shell exited says they were
 * stopped (`leftBehind`).
 *
 * Also: two runs with the same id at once never both start, and `beforeRun` names the port or
 * file that held before the run, never another one.
 *
 * MACHINE SAFETY: every path is a temp dir; the listeners bind 127.0.0.1 on a free port (one a job
 * opens with this test runtime); the commands are /bin/sh builtins and sleep; every job is
 * stopped by the end.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { guardedPath } from '../setup/exec-guard.js'
import { waitRefusal } from '../../src/providers/host-exec-wait.js'
import { createHostExec, HOST_EXEC_VERSION } from '../../src/providers/host-exec-core.js'
import { testMatcherStart } from '../helpers/wait-matcher.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-wait-core-')))
const core = createHostExec({
  spawn, killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
  shell: '/bin/sh', home: root, taskDirRoot: path.join(root, 'tasks'), stateDir: path.join(root, 'state'),
  env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: root }, promptProbe: null, matcher: testMatcherStart(),
})
/** A port nothing listens on right now (one this machine just handed out and took back). */
async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

afterAll(async () => {
  for (const j of (await core.list()).jobs) if (j.running) await core.kill({ jobId: j.jobId }).catch(() => {})
  core.close()
  if (root.includes('walnut-host-exec-wait-core-')) fs.rmSync(root, { recursive: true, force: true })
})

describe('exec.read and exec.run until on the host core', () => {
  it('a file under $WALNUT_TASK_DIR where this host has none for the task is refused: the run runs nothing, the read does not wait', async () => {
    expect(waitRefusal({ file: '$WALNUT_TASK_DIR/ready' }, null)).toMatch(/WALNUT_TASK_DIR is unset here/)
    expect(waitRefusal({ file: '${WALNUT_TASK_DIR}/ready' }, null)).not.toBeNull()
    expect(waitRefusal({ file: '$WALNUT_TASK_DIR/ready' }, '/t/task-1')).toBeNull()
    expect(waitRefusal({ file: 'out/ready', output: 'x' }, null)).toBeNull()
    await expect(core.run({ jobId: 'hx-wait-core-nodir', command: 'echo never', background: true, until: { file: '$WALNUT_TASK_DIR/ready' } }))
      .rejects.toMatchObject({ code: 'task_dir_unset', message: expect.stringContaining('nothing ran') })
    expect((await core.list()).jobs.map((j) => j.jobId)).not.toContain('hx-wait-core-nodir')
    const bg = await core.run({ jobId: 'hx-wait-core-nodir2', command: 'sleep 20', background: true })
    expect(bg.taskDir).toBeNull()
    const t0 = Date.now()
    await expect(core.read({ jobId: bg.jobId, wait: 10_000, until: { file: '${WALNUT_TASK_DIR}/ready' } })).rejects.toMatchObject({ code: 'task_dir_unset' })
    expect(Date.now() - t0).toBeLessThan(2_000)
    await expect(core.run({ jobId: 'hx-wait-core-bad', command: 'echo never', background: true, until: { output: '(a|a)*$' } })).rejects.toMatchObject({ code: 'bad_request' })
    expect((await core.list()).jobs.map((j) => j.jobId)).not.toContain('hx-wait-core-bad')
    await core.kill({ jobId: bg.jobId })
  })

  it('is version 3 or later (4: exec.run endGroup), answers a match with waitedFor, refuses a bad until, and goes on from scanFrom', async () => {
    expect(HOST_EXEC_VERSION).toBe(4)
    expect(core.version).toBe(4)
    const bg = await core.run({ jobId: 'hx-wait-core-0001', taskId: 't-1', command: 'sleep 0.5; echo "ready on 1"; sleep 20', background: true })
    expect(bg.running).toBe(true)
    const t0 = Date.now()
    const r = await core.read({ jobId: bg.jobId, taskId: 't-1', wait: 10_000, until: { output: 'READY on \\d', flags: 'i' } })
    expect(r).toMatchObject({ running: true, waitedFor: { matched: 'output', match: 'ready on 1', scanned: 'ready on 1\n'.length } })
    expect(Date.now() - t0).toBeLessThan(5_000)
    await expect(core.read({ jobId: bg.jobId, taskId: 't-1', until: { output: '(' } })).rejects.toMatchObject({ code: 'bad_request' })
    expect((await core.read({ jobId: bg.jobId, taskId: 't-1' })).waitedFor).toBeUndefined()
    const past = await core.read({ jobId: bg.jobId, taskId: 't-1', wait: 300, until: { output: 'ready on' }, scanFrom: r.waitedFor!.scanned })
    expect(past.waitedFor).toMatchObject({ matched: null })
    await core.kill({ jobId: bg.jobId })
  })

  it('a job that ended before the match answers null with its exit, and its own last line still counts', async () => {
    const quick = await core.run({ jobId: 'hx-wait-core-0002', taskId: 't-1', command: 'echo starting; exit 3', background: true })
    expect(await core.read({ jobId: quick.jobId, wait: 10_000, until: { output: 'ready' } })).toMatchObject({ running: false, exitCode: 3, waitedFor: { matched: null } })
    const last = await core.run({ jobId: 'hx-wait-core-0003', taskId: 't-1', command: 'sleep 0.3; printf done; exit 0', background: true })
    expect(await core.read({ jobId: last.jobId, wait: 10_000, until: { output: '^done$' } })).toMatchObject({ waitedFor: { matched: 'output', match: 'done' } })
  })

  it('a port already listening before the run started is `beforeRun`; one the run opens is not', async () => {
    // 2026-11-04 real-use review: a stale server on 18080 answered "accepted a connection after 0.0 s",
    // and the agent's own server then died on EADDRINUSE.
    const server = net.createServer((s) => s.destroy())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as net.AddressInfo).port
    try {
      const run = await core.run({ jobId: 'hx-wait-core-0004', taskId: 't-1', command: 'sleep 20', background: true, until: { port } })
      expect(await core.read({ jobId: run.jobId, taskId: 't-1', wait: 5_000, until: { port } })).toMatchObject({ waitedFor: { matched: 'port', beforeRun: true } })
      await core.kill({ jobId: run.jobId })
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
    // A file the run makes itself: matched, not beforeRun.
    const made = await core.run({ jobId: 'hx-wait-core-0005', taskId: 't-1', command: 'sleep 0.3; : > made.txt; sleep 20', cwd: root, background: true, until: { file: 'made.txt' } })
    const w = await core.read({ jobId: made.jobId, taskId: 't-1', wait: 5_000, until: { file: 'made.txt' } })
    expect(w.waitedFor).toMatchObject({ matched: 'file', match: path.join(root, 'made.txt') })
    expect(w.waitedFor!.beforeRun).toBeUndefined()
    await core.kill({ jobId: made.jobId })
  })

  it('two runs with the same job id at once: one starts, the other is refused job_exists, and the host holds the one that runs', async () => {
    // 2026-11-04 review: both passed the id check before either was recorded (the look a wait_for
    // takes before the run sits between them), both spawned, and the first vanished from the job
    // table: no stop reached it and running() did not count it. The server relies on this refusal.
    const port = await freePort()
    // Each shell that starts writes one line here.
    const marks = path.join(root, 'twice.marks')
    const call = { jobId: 'hx-wait-core-twice', taskId: 't-1', command: `echo started >> '${marks}'; sleep 20`, background: true, until: { port } }
    // The second is refused at once, and the read the server then makes of that id (sameJob) waits
    // for the first to be recorded instead of answering unknown_job (review of this change: the
    // server took that for "another run's id", and a retry would have run the command again).
    const [first, second, readNow] = await Promise.allSettled([core.run(call), core.run(call), core.read({ jobId: call.jobId, taskId: 't-1' })])
    const settled = [first, second]
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as { code?: string }).code)).toEqual(['job_exists'])
    expect(readNow).toMatchObject({ status: 'fulfilled', value: { jobId: call.jobId, running: true } })
    expect((await core.list()).jobs.filter((j) => j.jobId === call.jobId && j.running)).toHaveLength(1)
    // One shell started: once it wrote its line, a second one would have had time to write too.
    for (const t0 = Date.now(); !fs.existsSync(marks) && Date.now() - t0 < 10_000;) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 500))
    expect(fs.readFileSync(marks, 'utf8')).toBe('started\n')
    await core.kill({ jobId: call.jobId })
    expect(await core.read({ jobId: call.jobId, wait: 10_000 })).toMatchObject({ running: false, killed: true })
    // Once that run is recorded, the same id is still refused.
    await expect(core.run(call)).rejects.toMatchObject({ code: 'job_exists' })
  }, 20_000)

  it('beforeRun names the port or the file that held before the run, never another one a later read waits for', async () => {
    // 2026-11-04 review: a run that waited on a port already taken marked every later port or file
    // wait on that job beforeRun, "may not be this job's server", for a port the job itself opened.
    const taken = net.createServer((s) => s.destroy())
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', () => r()))
    const held = (taken.address() as net.AddressInfo).port
    const own = await freePort()
    try {
      const js = `require("net").createServer().listen(${own}, "127.0.0.1"); setTimeout(() => {}, 20000)`
      const run = await core.run({ jobId: 'hx-wait-core-0008', taskId: 't-1', command: `sleep 0.3; '${process.execPath}' -e '${js}'`, background: true, until: { port: held } })
      const mine = await core.read({ jobId: run.jobId, taskId: 't-1', wait: 10_000, until: { port: own } })
      expect(mine.waitedFor).toMatchObject({ matched: 'port' })
      expect(mine.waitedFor!.beforeRun).toBeUndefined()
      expect((await core.read({ jobId: run.jobId, taskId: 't-1', wait: 5_000, until: { port: held } })).waitedFor).toMatchObject({ matched: 'port', beforeRun: true })
      await core.kill({ jobId: run.jobId })
    } finally {
      await new Promise<void>((r) => taken.close(() => r()))
    }
    // The same for files: the one that existed before, by its path.
    fs.writeFileSync(path.join(root, 'old.txt'), '')
    fs.rmSync(path.join(root, 'new.txt'), { force: true })
    const f = await core.run({ jobId: 'hx-wait-core-0009', taskId: 't-1', command: 'sleep 0.3; : > new.txt; sleep 20', cwd: root, background: true, until: { file: 'old.txt' } })
    const made = await core.read({ jobId: f.jobId, taskId: 't-1', wait: 5_000, until: { file: 'new.txt' } })
    expect(made.waitedFor).toMatchObject({ matched: 'file', match: path.join(root, 'new.txt') })
    expect(made.waitedFor!.beforeRun).toBeUndefined()
    expect((await core.read({ jobId: f.jobId, taskId: 't-1', wait: 5_000, until: { file: path.join(root, 'old.txt') } })).waitedFor).toMatchObject({ matched: 'file', beforeRun: true })
    await core.kill({ jobId: f.jobId })
  }, 30_000)

  it('a foreground run whose `&` children still held its output when the shell exited says they were stopped', async () => {
    // 2026-11-04 real-use review: `(sleep 5; echo x > file) & echo started` answered "exited 0 before the file appeared", with no word of why.
    const r = await core.run({ jobId: 'hx-wait-core-0006', taskId: 't-1', command: '(sleep 30; echo late) & echo started', cwd: root, endGroup: true })
    expect(r).toMatchObject({ running: false, exitCode: 0, leftBehind: true })
    expect(r.output).toContain('started')
    const plain = await core.run({ jobId: 'hx-wait-core-0007', taskId: 't-1', command: 'echo plain', cwd: root, endGroup: true })
    expect(plain.leftBehind).toBe(false)
    expect(plain.leftCommands).toBeUndefined()
  }, 15_000)

  it('an `&` child that sends its output elsewhere is stopped too when the shell exits, and the answer names it', async () => {
    // 2026-11-04 usability review: `python3 -m http.server ... > srv.log 2>&1 &` kept serving after the
    // job exited 0, in the job's own process group, where host_exec_list and host_exec_stop never reach.
    const r = await core.run({ jobId: 'hx-wait-core-0010', taskId: 't-1', command: 'sleep 61 > /dev/null 2>&1 & echo "child $!"', cwd: root, endGroup: true })
    const pid = Number(/child (\d+)/.exec(r.output)?.[1])
    expect(pid).toBeGreaterThan(1)
    try {
      expect(r).toMatchObject({ running: false, exitCode: 0, leftBehind: true, leftCommands: ['sleep 61'] })
      const t0 = Date.now()
      while (alive(pid) && Date.now() - t0 < 5_000) await new Promise((res) => setTimeout(res, 100))
      expect(alive(pid)).toBe(false)
    } finally {
      if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 20_000)

  it('a prompt already in the log is matched by a wait of 0 ms with partial: its quiet time counts from when it was written', async () => {
    // 2026-11-04 review (partial-zero): each read builds a new line splitter, whose quiet clock
    // started at its first look, so `Password: ` sitting there for seconds was not tested by a short wait.
    await core.run({ jobId: 'hx-wait-core-pw', taskId: 't-1', command: "printf 'Password: '; sleep 30", cwd: root, background: true })
    await new Promise((r) => setTimeout(r, 1_500))
    for (const wait of [0, 150]) {
      const r = await core.read({ jobId: 'hx-wait-core-pw', taskId: 't-1', wait, until: { output: '^Password: $', partial: true } })
      expect(r.waitedFor).toMatchObject({ matched: 'output', match: 'Password: ', unfinished: true })
    }
    await core.kill({ jobId: 'hx-wait-core-pw' })
  }, 20_000)

  it('a partial match comes back with its line in the output; a read without one keeps to whole lines', async () => {
    // 2026-11-04 usability review: a partial match on the prompt answered output "hi\n", as if the prompt was never seen.
    await core.run({ jobId: 'hx-wait-core-pw2', taskId: 't-1', command: "printf 'hi\\nPassword: '; sleep 30", cwd: root, background: true })
    const r = await core.read({ jobId: 'hx-wait-core-pw2', taskId: 't-1', wait: 5_000, until: { output: '^Password', partial: true } })
    expect(r).toMatchObject({ output: 'hi\nPassword: ', nextOffset: 13, waitedFor: { matched: 'output', match: 'Password: ', unfinished: true, scanned: 13 } })
    expect(await core.read({ jobId: 'hx-wait-core-pw2', taskId: 't-1' })).toMatchObject({ output: 'hi\n', nextOffset: 3 })
    await core.kill({ jobId: 'hx-wait-core-pw2' })
  }, 20_000)

  it('an offset past the log\'s end reads, and waits, from its end: scanned never says more than the log holds', async () => {
    // 2026-11-04 usability review: offset 999999 on a 5-byte log answered scanned 999999, and on a
    // running job such a wait would never see a line.
    await core.run({ jobId: 'hx-wait-core-past', taskId: 't-1', command: 'echo hi; sleep 1; echo LATE; sleep 20', cwd: root, background: true })
    await new Promise((r) => setTimeout(r, 300))
    const r = await core.read({ jobId: 'hx-wait-core-past', taskId: 't-1', offset: 999_999, wait: 5_000, until: { output: 'LATE' } })
    expect(r).toMatchObject({ offset: 3, waitedFor: { matched: 'output', match: 'LATE' } })
    const ended = await core.run({ jobId: 'hx-wait-core-past2', taskId: 't-1', command: 'echo four', cwd: root })
    const past = await core.read({ jobId: ended.jobId, taskId: 't-1', offset: 999_999, until: { output: 'x' } })
    expect(past).toMatchObject({ offset: 5, nextOffset: 5, waitedFor: { matched: null, scanned: 5 } })
    await core.kill({ jobId: 'hx-wait-core-past' })
  }, 20_000)

  it('at most 4 waits run on one job at once: a fifth is refused busy, and one may start once another ended', async () => {
    // 2026-11-04 review: every wait reads the log and asks the matcher on its own, with no limit per job.
    await core.run({ jobId: 'hx-wait-core-cap', taskId: 't-1', command: 'sleep 20', cwd: root, background: true })
    const waits = Array.from({ length: 4 }, () => core.read({ jobId: 'hx-wait-core-cap', taskId: 't-1', wait: 2_000, until: { output: 'never' } }))
    await new Promise((r) => setTimeout(r, 200))
    await expect(core.read({ jobId: 'hx-wait-core-cap', taskId: 't-1', wait: 2_000, until: { output: 'never' } })).rejects.toMatchObject({ code: 'busy', message: expect.stringContaining('4 waits on job hx-wait-core-cap already run') })
    // A read with no wait_for is no wait.
    expect(await core.read({ jobId: 'hx-wait-core-cap', taskId: 't-1' })).toMatchObject({ running: true })
    for (const w of await Promise.all(waits)) expect(w.waitedFor).toMatchObject({ matched: null })
    expect((await core.read({ jobId: 'hx-wait-core-cap', taskId: 't-1', wait: 0, until: { output: 'never' } })).waitedFor).toMatchObject({ matched: null })
    await core.kill({ jobId: 'hx-wait-core-cap' })
  }, 20_000)

  it('a run again under an id the host no longer holds gets a log of its own: its wait never matches the run before', async () => {
    // 2026-11-04 review: the rerun appended to the old log and the server tests from 0, so after the
    // daemon dropped the old job (an hour on, or a restart) a wait matched the previous run's line at once.
    let clock = Date.now()
    const timed = createHostExec({
      spawn, killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
      shell: '/bin/sh', home: root, taskDirRoot: path.join(root, 'tasks'), stateDir: path.join(root, 'state'),
      env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: root }, promptProbe: null, matcher: testMatcherStart(), now: () => clock,
    })
    try {
      const first = await timed.run({ jobId: 'hx-wait-core-rerun', taskId: 't-1', command: 'echo first-run ready', cwd: root })
      expect(first).toMatchObject({ exitCode: 0, output: 'first-run ready\n' })
      clock += 2 * 60 * 60_000 // past the hour a finished job is kept
      const again = await timed.run({ jobId: 'hx-wait-core-rerun', taskId: 't-1', command: 'sleep 1; echo second', cwd: root, background: true, until: { output: 'ready' } })
      expect(again.logFile).not.toBe(first.logFile)
      const r = await timed.read({ jobId: 'hx-wait-core-rerun', taskId: 't-1', wait: 5_000, until: { output: 'ready' }, scanFrom: 0 })
      expect(r).toMatchObject({ running: false, output: 'second\n', waitedFor: { matched: null } })
      expect(fs.readFileSync(first.logFile, 'utf8')).toBe('first-run ready\n')
    } finally {
      timed.close()
    }
  }, 20_000)
})

/** Whether a process still runs (a zombie waiting for its reaper does not). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}
