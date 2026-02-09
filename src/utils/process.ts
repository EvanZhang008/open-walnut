import { execSync } from 'node:child_process'

/**
 * Check if a process with the given PID is alive.
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

  try {
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8', timeout: 3000 }).trim()
    return cmd.includes(expectedBinary)
  } catch {
    // ps failed — process may have exited between kill(0) and ps
    return false
  }
}
