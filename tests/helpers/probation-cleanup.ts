/**
 * Ends the update probations a test case started. Each probation records its own pid
 * (`probation.pid` in its install root's update-before, daemon-update-probation.ts), so a case
 * ends that pid, and only while it still runs that root's probation script: never a search of
 * the process table (tests/scripts/no-pattern-kill-ratchet.test.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { PROBATION_SCRIPT_NAME, PROBATION_STARTING_NAME, SNAPSHOT_DIR } from '../../src/providers/daemon-update-probation.js'

const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function endRecordedProbations(installRoots: string[]): void {
  for (const root of installRoots) {
    const dir = path.join(root, SNAPSHOT_DIR)
    const file = path.join(dir, 'probation.pid')
    // One still starting writes its pid in a moment.
    const until = Date.now() + 3_000
    while (!fs.existsSync(file) && fs.existsSync(path.join(dir, PROBATION_STARTING_NAME)) && Date.now() < until) nap(50)
    let pid = 0
    try { pid = Number(fs.readFileSync(file, 'utf8').trim()) } catch { continue }
    if (!Number.isInteger(pid) || pid <= 1) continue
    const args = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? ''
    if (args.includes(path.join(root, PROBATION_SCRIPT_NAME))) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
}
