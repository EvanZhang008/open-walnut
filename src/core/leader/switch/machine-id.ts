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
import path from 'node:path'
import { machineIdFile as stableMachineIdFile } from '../../machine-id.js'

export function machineIdFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.WALNUT_MACHINE_ID_FILE || stableMachineIdFile()
}

/** Where it lives: src/core/machine-id.ts, so a reader outside the switch (the session channel's leader side) loads none of this file. */
export { permitHolderId } from '../../machine-id.js'

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
