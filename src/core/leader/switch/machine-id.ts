/**
 * Which machine this process runs on, as the write permission's holder id: the machine's one
 * stable id (src/core/machine-id.ts, `~/.local/state/open-walnut/machine-id`, the id the daemons
 * send in their hello), so a machine has one identity.
 *
 * `WALNUT_MACHINE_ID_FILE` names another file, read as it is and never made or rewritten. It is
 * for running two "machines" on one computer (the one-machine rehearsal and its tests, whose ids
 * are readable names, not the 32-hex form the stable id has); nothing in production sets it.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { machineIdFile as stableMachineIdFile, readMachineIdSync } from '../../machine-id.js'

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

export function machineIdFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.WALNUT_MACHINE_ID_FILE || stableMachineIdFile()
}

/**
 * This machine's id, or null when it cannot be had: the named file missing or not holding one,
 * or the stable id neither readable nor makeable. Sync: read at boot (the stable id is read from
 * disk once per process, made once per machine).
 */
export function permitHolderId(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.WALNUT_MACHINE_ID_FILE) {
    let text: string
    try {
      text = fs.readFileSync(env.WALNUT_MACHINE_ID_FILE, 'utf8').trim()
    } catch {
      return null
    }
    return ID_RE.test(text) ? text : null
  }
  try {
    return readMachineIdSync()
  } catch {
    return null
  }
}

/**
 * Where this machine keeps the records of the witnesses it serves for other machines' write
 * permission (witness-route.ts): `<root>/<walnut id>/<witness id>/permit-record.json`. Beside the
 * machine-id file, outside every data home: a witness's record belongs to the machine, and a
 * copy of a data home never carries it.
 */
export function witnessRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(machineIdFile(env)), 'leader-witness')
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
