/**
 * The leader switch's start hook of the host's one Walnut service (src/binary/service-start-hooks.ts
 * SERVICE_START_HOOKS): it runs in `<exe> --service` before any home opens, under the hooks' shared
 * 5 s, and reads local files only (node:fs, node:path, node:os: nothing else loads on that path).
 *
 *   - A kill between a switch job's record of the role it wants and the mode write (service-role.ts
 *     applyServiceRole: records first, mode second) is healed here: the job's state is still at its role
 *     step (the target's `role`, the source's `hand-off`), the record says a role not yet marked set,
 *     and the mode file says another, so the hook asks for the record's role again (setRole is idempotent).
 *     A job past its role step, or a role it marked set, is left alone: a mode changed since is a person's.
 *   - It gives no start the right to commit: a launcher's start on a home a switch is making waits
 *     (promotion-wait.ts), and the commit start is the switch's own.
 *
 * It finds the switch's record through this machine's pointer (`leader-switch-pointer.json`, beside
 * the machine id, outside every home), which each job writes before its role step. The mode is never
 * the truth of who leads: the server's boot reads the witnesses (boot.ts); a hook only says it sooner.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServiceStartContext, ServiceStartResult } from '../../../binary/service-start-hooks.js'

/** This machine's pointer file: beside its machine id (switch/machine-id.ts machineIdFile, without its imports). */
export function switchPointerFile(env: NodeJS.ProcessEnv = process.env): string {
  const idFile = env.WALNUT_MACHINE_ID_FILE || path.join(os.homedir(), '.local', 'state', 'open-walnut', 'machine-id')
  return path.join(path.dirname(idFile), 'leader-switch-pointer.json')
}

export interface SwitchPointer { switchId: string; side: 'source' | 'target'; stateFile: string; at: string }

export function readSwitchPointer(env: NodeJS.ProcessEnv = process.env): SwitchPointer | null {
  try {
    const p = JSON.parse(fs.readFileSync(switchPointerFile(env), 'utf8')) as Partial<SwitchPointer>
    return typeof p.switchId === 'string' && (p.side === 'source' || p.side === 'target') && typeof p.stateFile === 'string' ? p as SwitchPointer : null
  } catch { return null }
}

/** What a job recorded of the role it wants (flow.ts RoleStep, the fields this hook reads). */
interface RecordedRole { role?: unknown; home?: unknown; walnutId?: unknown; set?: unknown }

/** The hook itself; `env` for tests (the pointer's place). */
export async function leaderSwitchStartHook(ctx: ServiceStartContext, env: NodeJS.ProcessEnv = process.env): Promise<ServiceStartResult> {
  const ptr = readSwitchPointer(env)
  if (!ptr) return {}
  let st: { step?: string; serviceRole?: RecordedRole } | null = null
  try { st = JSON.parse(fs.readFileSync(ptr.stateFile, 'utf8')) } catch { return { note: `leader switch ${ptr.switchId}: its record ${ptr.stateFile} cannot be read` } }
  const out: ServiceStartResult = {}
  if (st?.step !== (ptr.side === 'target' ? 'role' : 'hand-off')) return out
  const want = st?.serviceRole
  if (!want || (want.role !== 'leader' && want.role !== 'replica') || typeof want.home !== 'string' || typeof want.walnutId !== 'string' || !want.walnutId) return out
  // Marked set: the job saw the mode written. A mode changed since (by a person, `walnut daemon update`) is theirs.
  if (want.set === true) return out
  if (ctx.mode && ctx.mode.role === want.role && ctx.mode.home === want.home) return out
  // setRole throws its ServiceRoleError (another Walnut's service, no follower spec, busy): the start goes on
  // as the file says, and the next start (or the job's --resume) asks again.
  const r = ctx.setRole({ role: want.role, home: want.home, walnutId: want.walnutId })
  return { ...out, note: `leader switch ${ptr.switchId}: the service role follows the switch record (${want.role} on ${want.home}${r.changed ? '' : ', already so'})` }
}
