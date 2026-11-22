/**
 * Which machine this process runs on, as the write permission's holder id.
 *
 * Stand-in for `readMachineId()` of src/core/machine-id.ts, which another task is adding
 * (file `~/.local/state/open-walnut/machine-id`): when it lands, this function becomes that
 * import. It only READS the file; it never makes an id, so no second machine identity exists.
 *
 * `WALNUT_MACHINE_ID_FILE` names another file. It is for running two "machines" on one
 * computer (the one-machine rehearsal and its tests); nothing in production sets it.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

export function machineIdFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.WALNUT_MACHINE_ID_FILE || path.join(os.homedir(), '.local', 'state', 'open-walnut', 'machine-id')
}

/** This machine's id, or null when the file is missing or does not hold one. */
export function permitHolderId(env: NodeJS.ProcessEnv = process.env): string | null {
  let text: string
  try {
    text = fs.readFileSync(machineIdFile(env), 'utf8').trim()
  } catch {
    return null
  }
  return ID_RE.test(text) ? text : null
}

/**
 * The instance lock of this machine's leader process (permit/instance-lock.ts): one server per
 * machine id may hold the write permission. Beside the machine-id file, so the one-machine
 * rehearsal's two "machines" each have their own.
 */
export function leaderInstanceLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(machineIdFile(env)), 'leader-instance', 'lock')
}

/**
 * Where the standby of a handed-over home (handed-over.ts) says it runs: pid and port, for the
 * switch's side (side.ts) that stops it before a leader starts on that home. Beside the instance
 * lock, never in the home itself: the handed-over home stays byte for byte as it was.
 */
export function standbyServerFile(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16)
  return path.join(path.dirname(machineIdFile(env)), 'leader-instance', `standby-${key}.json`)
}
