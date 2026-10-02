/**
 * The real session daemon (the JS twin from getDaemonSource) for server e2e tests,
 * with a `claude` that runs the mock CLI.
 *
 * Use it when a test asserts what the daemon decides (reap exit codes, snapshots,
 * the stopped/idle projection): the in-process MockDaemon pushes no snapshots, so a
 * server on it falls back to the legacy health monitor.
 *
 * Hermetic by construction: an isolated WALNUT_DAEMON_DIR, HOME = the given test
 * home (its ~/.local/bin/claude is the shim), PATH=/usr/bin:/bin and SHELL=/bin/sh,
 * so neither the daemon's claude lookup nor its login-shell preamble can reach the
 * machine's real claude or rc files. The parent-pid watchdog ends it if the test
 * process dies.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

export interface DaemonTwin {
  port: number
  url: string
  proc: ChildProcess
  stop(): Promise<void>
}

const TOOLCHAIN_VARS = ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_STREAMS_DIR']

export async function startDaemonTwin(opts: {
  home: string
  mockCli: string
  env?: Record<string, string>
}): Promise<DaemonTwin> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-daemon-twin-'))
  const runDir = path.join(dir, 'run')
  const script = path.join(dir, 'daemon.cjs')
  await fs.writeFile(script, getDaemonSource(), { mode: 0o755 })
  const bin = path.join(opts.home, '.local', 'bin')
  await fs.mkdir(bin, { recursive: true })
  await fs.writeFile(path.join(bin, 'claude'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(opts.mockCli)} "$@"\n`, { mode: 0o755 })

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: opts.home,
    WALNUT_HOME_OVERRIDE: opts.home,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    WALNUT_DAEMON_DIR: runDir,
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
    ...opts.env,
  }
  for (const k of TOOLCHAIN_VARS) delete env[k]

  const proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'pipe', 'ignore'] })
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error('daemon twin did not print its port within 30s')), 30_000)
    proc.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const m = out.match(/^(\d+)$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)) }
    })
    proc.once('error', (e) => { clearTimeout(timer); reject(e) })
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`daemon twin exited early (code ${code})`)) })
  })

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    proc,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        // An isolated-dir daemon reaps its CLI groups on a clean exit, and that
        // ladder can take several seconds, so SIGKILL is only the backstop.
        const exited = new Promise<void>((resolve) => {
          const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* already gone */ } resolve() }, 15_000)
          proc.once('exit', () => { clearTimeout(t); resolve() })
        })
        proc.kill('SIGTERM')
        await exited
      }
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      await fs.rm(`${runDir}-streams`, { recursive: true, force: true }).catch(() => {})
    },
  }
}
