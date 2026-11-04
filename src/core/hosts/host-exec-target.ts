/**
 * Who asks a host_exec-family call and where it goes (host-exec.ts): the caller's task session,
 * the host it names (a selector picks one, a found ~/.ssh/config twin of a joined machine is that
 * machine, never the caller's own host), the host's name in an answer, and the error every one of
 * these calls refuses with. Kept apart from host-exec.ts, which re-exports all of it.
 */
import { log } from '../../logging/index.js'

const LOCAL = '__local__'

export class HostExecError extends Error {
  constructor(message: string, public status: number, public code: string, public data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HostExecError'
  }
}

export interface Caller { sid: string; taskId: string; taskTitle: string; host: string }

export function normHost(h: string | undefined | null): string {
  return !h || h === 'local' ? LOCAL : h
}

export async function callerOf(sid: string | undefined): Promise<Caller> {
  const { resolveCaller } = await import('../sessions/session-send-core.js')
  const c = await resolveCaller(sid)
  if (c.kind !== 'session' || !c.record.taskId) {
    throw new HostExecError('host_exec runs for a task\'s session; a person runs commands in their own terminal', 403, 'session_only')
  }
  const { getTask } = await import('../task-manager.js')
  const task = await getTask(c.record.taskId).catch(() => undefined)
  return { sid: c.record.claudeSessionId, taskId: c.record.taskId, taskTitle: task?.title ?? c.record.taskId, host: normHost(c.record.host) }
}

/**
 * The joined row of the machine whose found ~/.ssh/config row `alias` is, or null:
 * one machine, and the joined row is the one that works (joined-twins.ts).
 */
export async function sameMachineAs(alias: string): Promise<string | null> {
  const name = alias.trim()
  if (!name || normHost(name) === LOCAL) return null
  const [{ getConfig }, { joinedAliasOf }] = await Promise.all([import('../config-manager.js'), import('./joined-twins.js')])
  const config = await getConfig()
  const to = joinedAliasOf(config.hosts ?? {}, config.net)(name)
  return to && to !== name ? to : null
}

/** What an answer for a call on a found twin says (`refused`: nothing ran there), or null for any other host. */
export async function sameMachineNote(alias: string, refused = false): Promise<string | null> {
  const to = await sameMachineAs(alias).catch(() => null)
  if (!to) return null
  const name = await hostName(to)
  return `${alias.trim()} is the same machine as ${name === to ? to : `${name} (host ${to})`}, which joined over the host network; `
    + `${refused ? `this answer is ${to}'s` : `Walnut used ${to}`}. Name ${to} from now on.`
}

export async function targetHost(raw: string, caller: Caller, sameHostHint = 'run the command with your own Bash tool'): Promise<string> {
  const { parseHostSelector, pickHost, HostSelectorError } = await import('./host-select.js')
  let host: string
  try {
    const tags = parseHostSelector(raw)
    host = normHost(tags ? (await pickHost(tags)).host : raw.trim())
  } catch (err) {
    if (err instanceof HostSelectorError) throw new HostExecError(err.message, err.code === 'bad_selector' ? 400 : 409, err.code)
    throw err
  }
  // A selector already picks the joined row (pickHost); a named found twin goes there too.
  const joined = await sameMachineAs(host)
  if (joined) {
    log.session.info('host exec: a found twin is its joined machine', { asked: host, host: joined, taskId: caller.taskId })
    host = joined
  }
  if (host === caller.host) {
    throw new HostExecError(`This session already runs on ${host === LOCAL ? 'this Mac' : host}: ${sameHostHint}`, 400, 'same_host')
  }
  if (host !== LOCAL) {
    const { getConfig } = await import('../config-manager.js')
    const hosts = (await getConfig()).hosts ?? {}
    if (!Object.hasOwn(hosts, host)) throw new HostExecError(`Unknown host: ${host} (host_list names them)`, 404, 'unknown_host')
  }
  return host
}

export async function hostName(host: string): Promise<string> {
  // The server's own machine: a Mac for most, a Linux box for a server run there (2026-11-04 review).
  if (host === LOCAL) return process.platform === 'darwin' ? 'the Mac' : 'the Walnut server\'s machine'
  const { hostDisplayNameFor } = await import('./host-display-name.js')
  return hostDisplayNameFor(host)
}
