/**
 * Start hooks of the launcher's `<exe> --service` (main.ts): code that runs whenever the mode file
 * reads, in every role and also when the start will be the daemon (another version), before any
 * home is opened. The leader switch's resume lives here: it heals a crash between its records and
 * the mode (setRole), and hands the server what this one start needs (env, e.g.
 * WALNUT_LEADER_SWITCH_COMMIT). A hook reads local files only; the safety of a role is the server's
 * boot (core/leader/switch/boot.ts), never a hook's.
 *
 * One deadline for all hooks (5 s). A hook that throws, or the deadline, is logged to stderr and the
 * start goes on as the file says. A setRole that changed the mode makes the entry decide again, once.
 *
 * Reads only node:fs and node:path (through service-entry.ts and service-mode.ts) and loads each
 * hook lazily, only when a mode file reads.
 */
import { decideServiceEntry, type ServiceEntryDecision } from './service-entry.js'
import { absolute, readServiceMode, serviceRoleOf, setServiceRole, type ServiceMode, type ServiceRole } from './service-mode.js'

export interface ServiceStartContext {
  installRoot: string
  runtimeDir: string
  /** What the mode file says now. */
  mode: { role: ServiceRole; home: string; exe: string } | null
  /** How the entry means to start right now. */
  decision: 'lead' | 'serve' | 'daemon'
  setRole(next: { role: ServiceRole; home: string; walnutId: string }): { previous: ServiceMode | null; changed: boolean }
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}
export interface ServiceStartResult {
  /** Added to this one start's server env only. */
  env?: Record<string, string>
  /** Written to the entry's log. */
  note?: string
}
export type ServiceStartHook = (ctx: ServiceStartContext) => Promise<ServiceStartResult | void>

/** Lazy: each entry is loaded only when a mode file reads. The leader switch adds its loader here. */
export const SERVICE_START_HOOKS: Array<() => Promise<ServiceStartHook>> = []

export const SERVICE_START_HOOKS_DEADLINE_MS = 5_000

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Runs the hooks in order under one deadline. `env` merges what each finished hook returned (a later
 * hook wins); `changed` says a setRole changed the mode. After the deadline a hook still running is
 * no longer waited for, and its setRole is refused: the entry has decided by then.
 */
export async function runServiceStartHooks(
  ctx: ServiceStartContext,
  hooks: ReadonlyArray<() => Promise<ServiceStartHook>> = SERVICE_START_HOOKS,
  deadlineMs = SERVICE_START_HOOKS_DEADLINE_MS,
): Promise<{ env: Record<string, string>; changed: boolean; notes: string[] }> {
  const env: Record<string, string> = {}
  const notes: string[] = []
  let changed = false
  let over = false
  const own: ServiceStartContext = {
    ...ctx,
    setRole(next) {
      if (over) throw new Error('the service start hooks ran past their deadline: the entry has decided')
      const r = ctx.setRole(next)
      if (r.changed) changed = true
      return r
    },
  }
  const all = (async () => {
    for (const [i, load] of hooks.entries()) {
      if (over) return
      try {
        const out = await (await load())(own)
        if (over) return
        if (out?.note) notes.push(out.note)
        for (const [k, v] of Object.entries(out?.env ?? {})) {
          if (ENV_KEY.test(k) && typeof v === 'string') env[k] = v
          else ctx.log('warn', `service start hook ${i} returned an env entry that is not a string: ${k}`)
        }
      } catch (err) {
        ctx.log('warn', `service start hook ${i} failed; the start goes on as the mode file says`, { error: err instanceof Error ? err.message : String(err) })
      }
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), deadlineMs); timer.unref?.() })
  const ended = await Promise.race([all.then(() => 'done' as const), deadline])
  clearTimeout(timer)
  if (ended === 'late') {
    over = true
    ctx.log('warn', `the service start hooks did not finish within ${deadlineMs} ms; the start goes on as the mode file says`)
  }
  for (const note of notes) ctx.log('info', note)
  return { env, changed, notes }
}

function stderrLog(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void {
  process.stderr.write(`walnut --service: ${level === 'warn' ? 'warning: ' : ''}${msg}${data ? ` ${JSON.stringify(data)}` : ''}\n`)
}

/**
 * The decision of this `--service` start (main.ts): decide, run the hooks when a mode file reads,
 * decide again when one changed the mode, and give the hooks' env to this start's server only.
 */
export async function prepareServiceStart(env: NodeJS.ProcessEnv, execPath: string, o: {
  hooks?: ReadonlyArray<() => Promise<ServiceStartHook>>
  deadlineMs?: number
  log?: ServiceStartContext['log']
} = {}): Promise<ServiceEntryDecision> {
  const first = decideServiceEntry(env, execPath)
  const installRoot = env.WALNUT_DAEMON_STATE_DIR ?? ''
  const hooks = o.hooks ?? SERVICE_START_HOOKS
  if (!absolute(installRoot) || hooks.length === 0) return first
  const read = readServiceMode(installRoot)
  if (!('mode' in read)) return first
  const { mode } = read
  const ran = await runServiceStartHooks({
    installRoot,
    runtimeDir: env.WALNUT_DAEMON_DIR ?? '',
    mode: { role: serviceRoleOf(mode), home: mode.home, exe: mode.exe },
    decision: first.kind,
    setRole: (next) => setServiceRole(installRoot, next),
    log: o.log ?? stderrLog,
  }, hooks, o.deadlineMs)
  const d = ran.changed ? decideServiceEntry(env, execPath) : first
  if (d.kind === 'daemon' || Object.keys(ran.env).length === 0) return d
  return { ...d, serverEnv: { ...d.serverEnv, ...ran.env } }
}
