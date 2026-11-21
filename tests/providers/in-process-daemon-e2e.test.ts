/**
 * The session daemon runtime inside the server's own process (experiment `in_process_daemon`,
 * in-process-daemon.ts), end to end: the server's RemoteSessionManager drives a session through
 * the in-process link (IN_PROCESS_DAEMON_URL), the runtime spawns a fake CLI and tails its output.
 *   1. Two rounds of one session: no daemon.port and no daemon.pid (a stale one is removed), so no
 *      stopper can signal the server; every output line reaches onOutput already parsed, and the
 *      only child of the process is the fake CLI.
 *   2. Every line of the session's output is parsed at most once in the whole process.
 *   3. stop() gives the dir's lock back and reaps the isolated dir's CLI.
 *   4. With the keep switch a session is adopted by the next runtime: in process again, the
 *      daemon as a program of its own on the same dir, and in process once more; a last stop
 *      without the switch reaps it.
 *
 * The work runs in a bun child (tests/providers/fixtures/in-process-daemon-session.ts) that
 * prints one JSON line; this file asserts it.
 *
 * MACHINE SAFETY: everything lives in a temp root (HOME, OPEN_WALNUT_HOME, WALNUT_DAEMON_DIR);
 * the fixture signals only the pids it or its runtime spawned.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIXTURE = path.resolve(__dirname, 'fixtures/in-process-daemon-session.ts')
const BUN = process.versions.bun ? process.execPath : null
// Toolchain dirs a login-shell preamble could reach, and overrides that would move the daemon's files.
const DROPPED_ENV = ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_STREAMS_DIR', 'WALNUT_DAEMON_KEEP_SESSIONS', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_PARENT_PID']
const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

describe.skipIf(!BUN)('the session daemon in the server process', () => {
  it('runs a session, parses each line once, reaps on stop, and is adopted across restarts and the switch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inproc-daemon-'))
    roots.push(root)
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const dir = path.join(root, 'd')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      WALNUT_HOME_OVERRIDE: home,
      // Not under HOME/.open-walnut: constants.ts reads that path as production and moves away from it.
      OPEN_WALNUT_HOME: path.join(root, 'walnut-home'),
      WALNUT_DAEMON_DIR: dir,
      WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
      WALNUT_IN_PROCESS_DAEMON: '1',
      // Every frame either way is frozen and checked to be plain JSON (daemon-in-process-client.ts).
      WALNUT_IN_PROCESS_FRAME_CHECK: '1',
      SHELL: '/bin/sh',
      PATH: '/usr/bin:/bin',
    }
    for (const k of DROPPED_ENV) delete env[k]

    const startedAt = Date.now()
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const child = execFile(BUN!, [FIXTURE, root], { env, timeout: 80_000, maxBuffer: 16 * 1024 * 1024 }, (error, out, err) => {
        resolve({ stdout: String(out), stderr: String(err), code: error ? (typeof error.code === 'number' ? error.code : null) : 0 })
      })
      child.stdin?.end()
    })
    const elapsed = Date.now() - startedAt
    expect(code, stderr.slice(-2000)).toBe(0)
    const out = JSON.parse(stdout.trim().split('\n').pop()!)
    expect(out.error, out.error).toBeUndefined()
    expect(out.leftoverClis).toEqual([])
    // The server side's data and runtime dirs are the temp root's.
    expect(out.walnutHome).toBe(path.join(root, 'walnut-home'))
    expect(out.logDir).toBe(dir)
    expect(elapsed).toBeLessThan(75_000)

    // 1. In process: no WebSocket door, both rounds answered in order, each line handed over parsed.
    expect(out.s1.started).toEqual({ kind: 'started', dir })
    // Neither daemon.port nor daemon.pid (a stale one was removed): no stopper can signal the server's pid.
    expect(out.s1.portFile).toBe(false)
    expect(out.s1.pidFile).toBe(false)
    expect(out.s1.results).toEqual(['answer one', 'answer two'])
    expect(out.s1.secondWritten).toBe(true)
    expect(out.s1.everyOutputParsed).toBe(true)
    // The CLI is this process's child, and the only one: no daemon program runs beside it.
    expect(out.s1.cliParent).toBe(out.selfPid)
    expect(out.s1.children).toEqual([{ isCli: true, cmd: expect.stringContaining('fake-cli.sh') }])
    expect(out.s1.transientOthers.filter((c: string) => /daemon|bun|node/.test(c))).toEqual([])

    // 2. Parse once: daemon side and server side together.
    expect(out.s2.lines).toBeGreaterThanOrEqual(5) // init + two (assistant, result) pairs
    expect(out.s2.max).toBeLessThanOrEqual(1)

    // 3. Stop reaps the isolated dir's CLI and gives the lock back.
    expect(out.s3.stopCode).toBe(0)
    expect(out.s3.cliGone).toBe(true)
    expect(out.s3.againKind).toBe('started')
    expect(out.s3.stopAgain).toBe(0)
    expect(out.s3.portFile).toBe(false)

    // 4. Adopted: in process → in process → the program → in process; the last stop reaps.
    const s4 = out.s4
    expect(s4.startKeep).toBe('started')
    expect(s4.first).toBe('answer k1')
    expect(s4.stopKeep1).toBe(0)
    expect(s4.cliAliveAfterStop1).toBe(true)
    expect(s4.restartKind).toBe('started')
    expect(s4.afterRestart).toMatchObject({ alive: true, hasState: true, written: true, result: 'answer k2' })
    expect(s4.stopKeep2).toBe(0)
    expect(s4.cliAliveAfterStop2).toBe(true)
    expect(s4.programPortFile).toBe(true)
    expect(s4.programPidFile).toBe(s4.programPid)
    expect(s4.onProgram).toMatchObject({ alive: true, hasState: true, written: true, result: 'answer k3' })
    expect(s4.programExit).toBe(0)
    expect(s4.cliAliveAfterProgram).toBe(true)
    expect(s4.backKind).toBe('started')
    expect(s4.backFiles).toEqual({ port: false, pid: false })
    expect(s4.backInProcess).toMatchObject({ alive: true, hasState: true, written: true, result: 'answer k4' })
    expect(s4.finalStop).toBe(0)
    expect(s4.cliGoneAtEnd).toBe(true)
    // The same CLI answered every round, whichever runtime held it.
    expect([s4.afterRestart.pid, s4.onProgram.pid, s4.backInProcess.pid]).toEqual([s4.cliPid, s4.cliPid, s4.cliPid])

    // Frames are shared objects: none was what JSON would change, and none was written to once handed over.
    const runtimeLogs = fs.readdirSync(dir).filter((f) => /^daemon-.*\.log$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    expect(runtimeLogs).not.toContain('in-process frame is not plain JSON')
    expect(runtimeLogs).not.toMatch(/Attempted to assign to readonly|Cannot assign to read only|object is not extensible/)
  }, 90_000)
})
