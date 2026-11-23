/**
 * What a version can be as a host's one Walnut service (src/binary/service-mode.ts roles), said by
 * the version itself, never by a version number someone hard-codes:
 *   - hello `serviceRoles`: the roles this running program can take (the compiled Walnut file only:
 *     its `--service` reads the mode file; a plain daemon binary has no service roles);
 *   - `<exe> __daemon --service-roles`: the same, printed (`replica leader`); an older file does not
 *     know the flag (usage, exit 1) and so takes none;
 *   - the launcher's `goodRoles` in hello: what the version the launcher goes back to can take, read
 *     by running that file once per path. The leader switch reads both before it makes a machine lead.
 *
 * Starts nothing itself: the caller hands in how a file runs (the daemon runtime's own execFile,
 * tests/providers/daemon-runtime-child-process-ratchet.test.ts).
 */
import { SERVICE_ROLES, type ServiceRole } from '../binary/service-mode.js'

export const SERVICE_ROLES_FLAG = '--service-roles'
const ASK_TIMEOUT_MS = 30_000

/** The roles this program can take: the compiled Walnut file can take every one, any other build none. */
export function programServiceRoles(compiled: boolean): ServiceRole[] {
  return compiled ? [...SERVICE_ROLES] : []
}

/** The known roles in `value` (hello's list, or the words `__daemon --service-roles` printed). */
export function serviceRolesFrom(value: unknown): ServiceRole[] {
  const words = Array.isArray(value) ? value : typeof value === 'string' ? value.trim().split(/\s+/) : []
  return SERVICE_ROLES.filter((role) => words.includes(role))
}

export type ExecFileLike = (
  file: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string | Buffer) => void,
) => unknown

/**
 * What `<exe> __daemon <flag>` answered: `said` its last line (exit 0); `refused` it ran and exited
 * non-zero (an older file prints its usage and exits 1: a real answer); `failed` it gave no answer
 * (it could not start, or it was killed at the timeout), to be asked again later.
 */
export type DaemonFileAnswer = { kind: 'said'; line: string } | { kind: 'refused' } | { kind: 'failed'; why: string }

export function daemonFileAnswer(exe: string, flag: string, execFile: ExecFileLike, o: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<DaemonFileAnswer> {
  return new Promise((resolve) => {
    try {
      execFile(exe, ['__daemon', flag], { timeout: o.timeoutMs ?? ASK_TIMEOUT_MS, ...(o.env ? { env: o.env } : {}) }, (error, stdout) => {
        if (!error) { resolve({ kind: 'said', line: String(stdout ?? '').trim().split('\n').pop()?.trim() ?? '' }); return }
        const e = error as Error & { code?: unknown; killed?: boolean; signal?: unknown }
        // A number is its exit code; a string (ENOENT, EAGAIN) or a kill (the timeout) is no answer.
        resolve(typeof e.code === 'number' && !e.killed && !e.signal ? { kind: 'refused' } : { kind: 'failed', why: e.message })
      })
    } catch (err) { resolve({ kind: 'failed', why: err instanceof Error ? err.message : String(err) }) }
  })
}

/** The last line `<exe> __daemon <flag>` printed, or null when it gave none (an older file, a timeout). */
export async function daemonFileSays(exe: string, flag: string, execFile: ExecFileLike, o: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string | null> {
  const answer = await daemonFileAnswer(exe, flag, execFile, o)
  return answer.kind === 'said' ? answer.line : null
}

/** How long a file that gave no answer waits before it is asked again. */
export const ROLES_RETRY_MS = 60_000

/**
 * The roles of a version file, asked once per path and kept once it answered (a version dir's file
 * never changes): undefined until then. A file that gave no answer is asked again ROLES_RETRY_MS
 * later by itself (a stable link sends no new hello to ask again). `known` hears each path whose
 * roles became known (the daemon tells its servers).
 */
export function createServiceRolesReader(execFile: ExecFileLike, o: {
  env?: NodeJS.ProcessEnv; known?: (exe: string) => void; now?: () => number
  later?: (fn: () => void, ms: number) => void
} = {}): (exe: string) => ServiceRole[] | undefined {
  const known = new Map<string, ServiceRole[]>()
  const asking = new Set<string>()
  const retryAt = new Map<string, number>()
  const now = o.now ?? Date.now
  const later = o.later ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.() })
  const rolesOf = (exe: string): ServiceRole[] | undefined => {
    if (!exe.startsWith('/')) return undefined
    const roles = known.get(exe)
    if (roles || asking.has(exe) || (retryAt.get(exe) ?? 0) > now()) return roles
    asking.add(exe)
    void daemonFileAnswer(exe, SERVICE_ROLES_FLAG, execFile, o.env ? { env: o.env } : {}).then((answer) => {
      asking.delete(exe)
      if (answer.kind === 'failed') {
        retryAt.set(exe, now() + ROLES_RETRY_MS)
        later(() => { rolesOf(exe) }, ROLES_RETRY_MS)
        return
      }
      known.set(exe, answer.kind === 'said' ? serviceRolesFrom(answer.line) : [])
      try { o.known?.(exe) } catch { /* the next hello carries it anyway */ }
    })
    return undefined
  }
  return rolesOf
}

/** The launcher's facts with what its good version can take, once that is known. */
export function withGoodRoles<T extends { good: string }>(facts: T | null, rolesOf: (exe: string) => ServiceRole[] | undefined): (T & { goodRoles?: ServiceRole[] }) | null {
  if (!facts?.good) return facts
  const goodRoles = rolesOf(facts.good)
  return goodRoles ? { ...facts, goodRoles } : facts
}
