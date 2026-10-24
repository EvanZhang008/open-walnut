import { execSync, execFile as execFileCb } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCb)

/**
 * A pid's command line from Linux /proc (arguments joined by spaces), '' for a
 * pid that is gone, or null on a host without /proc (macOS asks ps). A slim
 * container image has no ps at all: asking it there called every live process
 * dead and printed "ps: not found" for each check.
 */
function procCommandLine(pid: number): string | null {
  if (!fs.existsSync('/proc/self/stat')) return null
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean).join(' ')
  } catch {
    return ''
  }
}

/**
 * Check if a process with the given PID is alive (synchronous).
 *
 * Uses `process.kill(pid, 0)` for existence check (sends no signal),
 * then optionally verifies the process command matches expectedBinary
 * via `ps` to guard against PID reuse.
 */
export function isProcessAlive(pid: number, expectedBinary?: string): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  if (!expectedBinary) return true

  const proc = procCommandLine(pid)
  if (proc !== null) return proc.includes(expectedBinary)
  try {
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return cmd.includes(expectedBinary)
  } catch {
    // ps failed — process may have exited between kill(0) and ps
    return false
  }
}

/**
 * Check if a process with the given PID is alive (async, non-blocking).
 *
 * Same logic as isProcessAlive but uses async execFile instead of execSync,
 * avoiding event loop blocking. Use this in hot paths (API handlers).
 */
export async function isProcessAliveAsync(pid: number, expectedBinary?: string): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  if (!expectedBinary) return true

  const proc = procCommandLine(pid)
  if (proc !== null) return proc.includes(expectedBinary)
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 3000,
    })
    return stdout.trim().includes(expectedBinary)
  } catch {
    return false
  }
}
