/**
 * The host side of the cron boot backend (daemon-service-cron.ts): which
 * processes are ours, read from /proc, and the detached start of the supervisor.
 * Identity is never a pid file alone: the daemon counts only when its running
 * executable is one of this install root's staged versions, the supervisor only
 * when its command line runs this install root's boot script.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { DAEMON_BOOT_PID_NAME, DAEMON_BOOT_SCRIPT_NAME, DAEMON_BOOT_STOP_NAME } from './daemon-service-boot-script.js'
import { DAEMON_ARTIFACT_VERSIONS_DIR } from './daemon-service-artifact.js'
import type { CronServiceDeps } from './daemon-service-cron.js'

type HostDeps = Pick<CronServiceDeps, 'spawnDetached' | 'serviceDaemon' | 'supervisor' | 'signal' | 'waitGone' | 'setStop'>

async function readPid(file: string): Promise<number | null> {
  const pid = Number((await fs.readFile(file, 'utf8').catch(() => '')).trim())
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null
}

/** Alive and not a zombie (an exited child this process has not reaped yet still answers kill 0). */
async function running(pid: number): Promise<boolean> {
  try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false }
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null)
  if (stat === null) return true
  const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
  return state !== 'Z' && state !== 'X'
}

export function createCronServiceHost(opts: { home: string; stateDir: string; runtimeDir: string }): HostDeps {
  const script = path.join(opts.stateDir, DAEMON_BOOT_SCRIPT_NAME)
  const versions = path.join(opts.stateDir, DAEMON_ARTIFACT_VERSIONS_DIR)
  return {
    async spawnDetached(program, args) {
      // cron's own environment: the script exports everything the daemon needs, so nothing of this shell leaks in.
      const child = spawn(program, args, {
        cwd: opts.home,
        detached: true,
        stdio: 'ignore',
        env: { HOME: opts.home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: process.env.LANG ?? 'C' },
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', reject)
      })
      child.unref()
    },
    async serviceDaemon() {
      const pid = await readPid(path.join(opts.runtimeDir, 'daemon.pid'))
      if (!pid || !(await running(pid))) return null
      const executable = await fs.realpath(`/proc/${pid}/exe`).catch(() => null)
      const root = await fs.realpath(versions).catch(() => null)
      if (!executable || !root || !executable.startsWith(root + path.sep)) return null
      // Report the path as the install root names it, the way the boot script and the stager write it.
      return { pid, executable: path.join(versions, path.relative(root, executable)) }
    },
    async supervisor() {
      const pid = await readPid(path.join(opts.stateDir, DAEMON_BOOT_PID_NAME))
      if (!pid || !(await running(pid))) return null
      const argv = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0')
      return argv.includes(script) ? pid : null
    },
    async signal(pid, signal) {
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`refusing to signal pid ${pid}`)
      try { process.kill(pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    },
    async waitGone(pid, timeoutMs) {
      // Monotonic, as every deadline of a service change (2026-11-04 review: a host that sleeps mid-wait).
      const deadline = performance.now() + timeoutMs
      while (await running(pid)) {
        if (performance.now() >= deadline) return false
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return true
    },
    async setStop(on) {
      const file = path.join(opts.stateDir, DAEMON_BOOT_STOP_NAME)
      if (on) await fs.writeFile(file, 'stop\n', { mode: 0o600 })
      else await fs.rm(file, { force: true })
    },
  }
}
