/**
 * The daemon is a runtime a process creates (createDaemonRuntime in daemon-standalone.ts),
 * not a script that owns the process. Two runtimes in one process, each in its own dir,
 * each running a session: they do not see each other's sessions, stopping one leaves the
 * other serving, the process's cwd, umask, env and handlers are as they were, the children
 * still start with umask 077, and once both stop nothing of them keeps the process alive.
 *
 * The text check holds the rule for the runtime's body: nothing in it touches the whole
 * process (exit, cwd, umask, argv, env, signal or crash handlers, stdin), and every child
 * process starts through the runtime's wrapper (daemon-child-spawn.ts).
 *
 * MACHINE SAFETY: everything lives in a temp root; the sessions run a mock CLI (a shell
 * script that prints three lines and exits); the runtimes are stopped by the script itself.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const FIXTURE = path.resolve(__dirname, 'fixtures/daemon-two-runtimes.ts')
const BUN = process.versions.bun ? process.execPath : null
const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

describe.skipIf(!BUN)('two daemon runtimes in one process', () => {
  it('stay apart, leave the process as they found it, and end with stop()', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-two-runtimes-'))
    roots.push(root)
    const startedAt = Date.now()
    const { stdout, code } = await new Promise<{ stdout: string; code: number | null }>((resolve) => {
      // The fixture never calls process.exit: it ends only once the runtimes left nothing behind.
      const child = execFile(BUN!, [FIXTURE, root], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, out) => {
        resolve({ stdout: String(out), code: error ? (typeof error.code === 'number' ? error.code : null) : 0 })
      })
      child.stdin?.end()
    })
    expect(code).toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(45_000)
    const out = JSON.parse(stdout.trim().split('\n').pop()!)

    // Each runtime is its own daemon: its dir, its port, its instance id, the process's pid.
    expect(out.ports.map((p: { kind: string }) => p.kind)).toEqual(['started', 'started'])
    expect(out.ports[0].port).not.toBe(out.ports[1].port)
    expect(out.helloDirs).toEqual([path.join(root, 'a', 'daemon'), path.join(root, 'b', 'daemon')])
    expect(out.instanceIds[0]).not.toBe(out.instanceIds[1])
    expect(out.pidFiles).toEqual([out.selfPid, out.selfPid])

    // The same sid in both: each runtime's session is its own, started with umask 077 and its env.
    expect(out.start_a).toEqual({ ok: true })
    expect(out.start_b).toEqual({ ok: true })
    expect(out.probes.a).toEqual([{ umask: '0077', marker: 'a' }])
    expect(out.probes.b).toEqual([{ umask: '0077', marker: 'b' }])

    // start() runs once.
    expect(out.startAgain).toBe(true)

    // A start() that stopped short of serving (it yielded to a live daemon named in daemon.pid)
    // released the dir's lock on stop(): the next runtime of that dir started there.
    expect(out.cStart).toEqual({ kind: 'existing', port: String(out.ports[1].port) })
    expect(out.cStop).toBe(0)
    expect(out.c2Start).toBe('started')
    expect(out.c2Stop).toBe(0)
    expect(out.cExits).toEqual([])

    // One stopped, the other still answers; neither asked the process to exit. The stopped one's
    // client heard its close once and its later request is turned away, never left waiting.
    expect(out.ownCloseTold).toBe(0)
    expect(out.stopA).toBe(0)
    expect(out.afterStopA).toEqual({
      aPortFile: false, bHello: path.join(root, 'b', 'daemon'),
      aClosedByDaemon: 1, aRequestAfterStop: { ok: false, error: 'client closed' },
    })
    expect(out.stopB).toBe(0)
    expect(out.bClosedByDaemon).toBe(1)
    expect(out.exitCalls).toEqual([null, null])

    // The process is as it was: cwd, umask, env, and no handler of theirs left.
    expect(out.after).toEqual(out.before)
  }, 90_000)
})

/** The runtime's body: from the factory's head to the process entry, comments removed. */
function runtimeBody(): string[] {
  const text = fs.readFileSync(STANDALONE, 'utf8')
  const start = text.indexOf('export async function createDaemonRuntime(')
  const end = text.indexOf('// ── The daemon as a program of its own')
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end).split('\n')
    .map((line, i) => ({ line, n: i }))
    .filter(({ line }) => { const s = line.trim(); return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) })
    .map(({ line }) => line.replace(/\s\/\/ .*$/, ''))
}

describe('the runtime touches nothing of the whole process', () => {
  const rules: Array<[string, RegExp]> = [
    ['process.exit', /\bprocess\.exit\(/],
    ['process.chdir', /\bprocess\.chdir\(/],
    ['process.argv', /\bprocess\.argv\b/],
    ['process.on/once', /\bprocess\.(on|once|prependListener|addListener)\(/],
    ['process.stdin', /\bprocess\.stdin\b/],
    ['a SIGKILL of itself', /process\.kill\(process\.pid/],
    // DAEMON_VERSION is a build constant (bun build --define), read above the factory.
    ['process.env', /\bprocess\.env\b/],
  ]
  it.each(rules)('no %s in createDaemonRuntime', (_name, re) => {
    const hits = runtimeBody().filter((line) => re.test(line))
    expect(hits).toEqual([])
  })

  it('sets the umask only around a fork, in the child wrapper it creates', () => {
    const hits = runtimeBody().filter((line) => /\bprocess\.umask\(/.test(line))
    // The one line that hands process.umask to createDaemonChildSpawn (with the raw functions).
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('spawn: rawSpawn')
  })

  it('starts every child through the wrapper (cwd, env and umask 077 filled in)', () => {
    const body = runtimeBody()
    const raw = body.filter((line) => /\b(rawSpawn|rawExecFile|rawExecFileSync|rawExecSync)\b|\bBun\.spawn(Sync)?\(/.test(line))
    // Only the line that hands the raw functions to createDaemonChildSpawn.
    expect(raw).toHaveLength(1)
    expect(raw[0]).toContain('spawn: rawSpawn, execFile: rawExecFile, execFileSync: rawExecFileSync, execSync: rawExecSync')
    expect(body.join('\n')).not.toMatch(/require\(['"](node:)?child_process['"]\)/)
  })
})

describe('a crash is reported from where the daemon always began to report it', () => {
  const text = fs.readFileSync(STANDALONE, 'utf8')
  it('hands its reporter over only once the log and the exit breadcrumb it writes exist', () => {
    const handOver = text.indexOf('options.onCrashReporter?.(daemonCrash)')
    expect(handOver).toBeGreaterThan(0)
    for (const name of ['const DAEMON_INSTANCE_ID', 'const LOG_FILE', 'const EXIT_BREADCRUMB_FILE', 'function daemonCrash(']) {
      expect(text.indexOf(name), name).toBeGreaterThan(0)
      expect(text.indexOf(name), name).toBeLessThan(handOver)
    }
  })
  it('the process entry registers its crash handlers when the reporter arrives, so an earlier crash prints its stack', () => {
    const entry = text.slice(text.indexOf('export async function runDaemonProcess('))
    const hook = entry.slice(entry.indexOf('const onCrashReporter = '), entry.indexOf('createDaemonRuntime('))
    expect(hook).toContain("process.on('uncaughtException'")
    expect(hook).toContain("process.on('unhandledRejection'")
    expect(entry.match(/process\.on\('uncaughtException'/g)).toHaveLength(1)
  })
})
