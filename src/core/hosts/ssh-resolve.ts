/**
 * What ssh itself resolves for a name (`ssh -G <name>`): the HostName, Port and User a dial of
 * that name would use, with every rule of the person's ~/.ssh/config applied (Match, Include,
 * wildcards, first value wins). Remote Hosts' Add host shows it in the Port and User fields
 * when they are empty (2026-11-10 review: Add host "demo-devbox-c" showed port 22 while the
 * config said 3461, so the refusal that followed read as a mystery).
 *
 * Only shown, never written into the row: a field the person leaves empty keeps following
 * ~/.ssh/config, so fixing the port there and pressing Retry works.
 *
 * `ssh -G` reads config only, it never connects. It runs as a child process with a deadline
 * (never on the event loop), and the answer is kept for a few seconds per name.
 */
import { execFile } from 'node:child_process'
import os from 'node:os'

export interface SshResolved {
  name: string
  hostname: string
  port: number
  user: string
  /** ~/.ssh/config changed something for this name (a HostName, a Port or a User of its own). */
  fromConfig: boolean
}

/** A name `ssh -G` may be asked about: never an option (no leading '-'), no user@, no spaces. */
export function isResolvableName(name: string): boolean {
  return /^[A-Za-z0-9_:][A-Za-z0-9_.:-]{0,252}$/.test(name) && !name.includes('..')
}

/** The three fields of `ssh -G` output (lowercase `key value` lines). */
export function parseSshG(name: string, stdout: string, localUser: string): SshResolved | null {
  const got = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const m = /^(hostname|port|user)\s+(\S+)/.exec(line.trim())
    if (m && !got.has(m[1])) got.set(m[1], m[2])
  }
  const hostname = got.get('hostname')
  const port = Number.parseInt(got.get('port') ?? '', 10)
  if (!hostname || !Number.isFinite(port)) return null
  const user = got.get('user') ?? localUser
  const fromConfig = hostname.toLowerCase() !== name.toLowerCase() || port !== 22 || user !== localUser
  return { name, hostname, port, user, fromConfig }
}

export type SshGRun = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>

const defaultRun: SshGRun = (args, timeoutMs) => new Promise((resolve) => {
  execFile('ssh', args, { timeout: timeoutMs, maxBuffer: 512 * 1024 }, (err, stdout) => {
    resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: String(stdout ?? '') })
  })
})

const KEEP_MS = 5_000
const DEADLINE_MS = 3_000
const kept = new Map<string, { at: number; answer: Promise<SshResolved | null> }>()

/** Resolve `name` the way ssh would dial it. Null when ssh is not there, refuses, or the name is not one. */
export function resolveSshName(name: string, deps: { run?: SshGRun; now?: () => number; localUser?: string } = {}): Promise<SshResolved | null> {
  if (!isResolvableName(name)) return Promise.resolve(null)
  const now = (deps.now ?? Date.now)()
  const hit = kept.get(name)
  if (hit && now - hit.at < KEEP_MS && !deps.run) return hit.answer
  const localUser = deps.localUser ?? safeLocalUser()
  const answer = (deps.run ?? defaultRun)(['-G', name], DEADLINE_MS)
    .then((r) => (r.code === 0 ? parseSshG(name, r.stdout, localUser) : null))
    .catch(() => null)
  if (!deps.run) {
    kept.set(name, { at: now, answer })
    if (kept.size > 200) kept.delete(kept.keys().next().value as string)
  }
  return answer
}

function safeLocalUser(): string {
  try { return os.userInfo().username } catch { return process.env.USER ?? '' }
}
