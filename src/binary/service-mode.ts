/**
 * The host's service mode: `<install root>/service-mode.json`, the one file that says what the
 * launcher's `<exe> --service` starts (service-entry.ts decideServiceEntry).
 *
 *   { v: 1, home, exe, role?, walnutId? }
 *
 * `role` is 'replica' (absent) or 'leader'. `home` means, by role:
 *   replica  the Walnut this service follows (its follower spec's `spec.home`, the leader's data dir);
 *   leader   this machine's own data dir that leads (the promoted home), absolute.
 * `exe` binds the mode to one version: a version the launcher puts back, and an older binary, never
 * read it as their own. `walnutId` names the Walnut the mode belongs to, written by setServiceRole.
 *
 * Writers: `walnut daemon install|update` (nextServiceMode, on the owner leader's `--serve` /
 * `--no-serve`, else carried over to the version it stages) and the leader switch (setServiceRole).
 * Every mode write also clears the fallback marker (service-role.fallback): a new mode or a new
 * version is the next try of a role that did not get ready in time.
 *
 * Reads only node:fs and node:path: main.ts asks it before anything else is imported.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ServiceModeBusyError, withServiceModeLock } from './service-mode-lock.js'

export const SERVICE_MODE_FILE = 'service-mode.json'
/** A leader role that did not get ready in time (service-entry.ts runLeaderService): the next start runs the daemon. */
export const SERVICE_ROLE_FALLBACK_FILE = 'service-role.fallback'
export const HOST_SERVER_DIR = 'host-server'

export const SERVICE_ROLES = ['replica', 'leader'] as const
export type ServiceRole = typeof SERVICE_ROLES[number]

export interface ServiceMode {
  v: 1
  home: string
  exe: string
  /** Absent: replica. */
  role?: ServiceRole
  /** The Walnut this mode belongs to (setServiceRole writes it). */
  walnutId?: string
}

export interface ServiceRoleFallback { v: 1; role: ServiceRole; home: string; exe: string; at: number; why: string }

export interface FsLike {
  readFileSync(file: string, encoding: 'utf8'): string
  readdirSync(dir: string): string[]
  realpathSync(file: string): string
  statSync(file: string): { isDirectory(): boolean }
}

interface WriteFs extends FsLike {
  writeFileSync(file: string, text: string, opts: { mode: number }): void
  renameSync(from: string, to: string): void
  rmSync(file: string, opts: { force: true }): void
}

export function absolute(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/') && v.length <= 1024
}

export function serviceRoleOf(mode: Pick<ServiceMode, 'role'>): ServiceRole {
  return mode.role ?? 'replica'
}

/** The mode file, or why not. A role other than replica or leader is a doubt (the daemon runs). */
export function readServiceMode(stateDir: string, f: FsLike = fs): { mode: ServiceMode } | { why: string; missing?: true } {
  let text: string
  try { text = f.readFileSync(path.join(stateDir, SERVICE_MODE_FILE), 'utf8') } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { why: 'no service-mode.json', missing: true } : { why: `service-mode.json unreadable: ${(err as Error).message}` }
  }
  let raw: Partial<Record<keyof ServiceMode, unknown>> | null
  try { raw = JSON.parse(text) as Partial<Record<keyof ServiceMode, unknown>> } catch { return { why: 'service-mode.json is not JSON' } }
  if (!raw || raw.v !== 1 || typeof raw.home !== 'string' || !raw.home || !absolute(raw.exe)) return { why: 'service-mode.json is not a v1 mode with a home and an exe' }
  if (raw.role !== undefined && raw.role !== 'replica' && raw.role !== 'leader') return { why: `service-mode.json names the role ${JSON.stringify(raw.role)}, neither replica nor leader` }
  // Absent stays absent: a replica mode reads back as it was written.
  return {
    mode: {
      v: 1, home: raw.home, exe: raw.exe,
      ...(raw.role === 'leader' ? { role: 'leader' as const } : {}),
      ...(typeof raw.walnutId === 'string' && raw.walnutId ? { walnutId: raw.walnutId } : {}),
    },
  }
}

function writeWhole(file: string, text: string, f: WriteFs): void {
  const tmp = `${file}.${process.pid}.tmp`
  f.writeFileSync(tmp, text, { mode: 0o600 })
  f.renameSync(tmp, file)
}

/** Writes the mode (temp file, rename; 0600), or removes it with null. Either way the fallback marker goes. */
export function writeServiceMode(stateDir: string, mode: ServiceMode | null, f: WriteFs = fs): void {
  const file = path.join(stateDir, SERVICE_MODE_FILE)
  if (mode) writeWhole(file, JSON.stringify(mode) + '\n', f)
  else f.rmSync(file, { force: true })
  f.rmSync(path.join(stateDir, SERVICE_ROLE_FALLBACK_FILE), { force: true })
}

/**
 * The mode the version just staged runs with, written before the switch starts it: it names that
 * version, so a version the launcher puts back runs as the daemon. Only the Walnut whose home the
 * file names may change it, and a leading machine's role only the leader switch changes
 * (setServiceRole); any other update (no flag, an older leader, another Walnut) carries the mode,
 * role and Walnut included, over to the new version. A note when refused.
 */
export function nextServiceMode(current: ServiceMode | null, ask: { home: string; on: boolean } | undefined, exe: string): { mode: ServiceMode | null; note?: string } {
  if (current && ask && serviceRoleOf(current) === 'leader') {
    return { mode: { ...current, exe }, note: 'service_leads: only the leader switch changes a leading machine\'s role; the mode stays as it is' }
  }
  if (current && ask && ask.home !== current.home) {
    return { mode: { ...current, exe }, note: `not_service_owner: the service here follows ${current.home}; the mode stays as it is` }
  }
  if (ask) return { mode: ask.on ? (current ? { ...current, exe } : { v: 1, home: ask.home, exe }) : null }
  return { mode: current ? { ...current, exe } : null }
}

export interface FollowerSpecFile { file: string; saved: { spec?: Record<string, unknown>; token?: unknown; fallback?: unknown } }

/** The follower specs (`<install root>/host-server/server-<key>.json`) that `match`, or why none can be read. */
function followerSpecs(stateDir: string, match: (spec: Record<string, unknown>) => boolean, f: FsLike): FollowerSpecFile[] | { why: string } {
  const dir = path.join(stateDir, HOST_SERVER_DIR)
  let names: string[]
  try { names = f.readdirSync(dir) } catch { return { why: `no follower spec dir ${dir}` } }
  const found: FollowerSpecFile[] = []
  for (const name of names) {
    if (!/^server-[A-Za-z0-9_-]+\.json$/.test(name)) continue
    const file = path.join(dir, name)
    try {
      const saved = JSON.parse(f.readFileSync(file, 'utf8')) as FollowerSpecFile['saved']
      if (saved?.spec && match(saved.spec)) found.push({ file, saved })
    } catch { /* another Walnut's, or broken: not this one's */ }
  }
  return found
}

/** The follower specs whose spec.home is `home`. */
export function followerSpecsFor(stateDir: string, home: string, f: FsLike = fs): FollowerSpecFile[] | { why: string } {
  return followerSpecs(stateDir, (spec) => spec.home === home, f)
}

/** The follower specs of Walnut `walnutId`, whatever home they follow (none when the dir does not read). */
export function followerSpecsOfWalnut(stateDir: string, walnutId: string, f: FsLike = fs): FollowerSpecFile[] {
  const found = followerSpecs(stateDir, (spec) => specWalnutIdOf(spec) === walnutId, f)
  return Array.isArray(found) ? found : []
}

/** The Walnut a follower spec is for: its top-level walnutId, as host-server-core.ts validates it. */
function specWalnutIdOf(spec: Record<string, unknown>): string | null {
  const id = spec.walnutId
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null
}

function specWalnutId(s: FollowerSpecFile): string | null {
  return s.saved.spec ? specWalnutIdOf(s.saved.spec) : null
}

export type ServiceRoleErrorCode = 'not_service_owner' | 'no_follower_spec' | 'no_leader_home' | 'no_launcher' | 'bad_request' | 'mode_busy'

export class ServiceRoleError extends Error {
  constructor(readonly code: ServiceRoleErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ServiceRoleError'
  }
}

/** The launcher's current version (`<install root>/launcher/state`, `current=`), or null. */
function launcherCurrent(stateDir: string, f: FsLike): string | null {
  let text = ''
  try { text = f.readFileSync(path.join(stateDir, 'launcher', 'state'), 'utf8') } catch { return null }
  const line = text.split('\n').find((l) => l.startsWith('current='))
  const exe = line?.slice('current='.length) ?? ''
  return absolute(exe) ? exe : null
}

/** The Walnut the current mode belongs to, when it can be told: a leader mode's walnutId, a replica's follower spec. */
function ownerOf(stateDir: string, mode: ServiceMode, f: FsLike): string | null {
  if (mode.walnutId) return mode.walnutId
  if (serviceRoleOf(mode) === 'leader') return null
  const specs = followerSpecsFor(stateDir, mode.home, f)
  return Array.isArray(specs) && specs.length === 1 ? specWalnutId(specs[0]!) : null
}

/**
 * The one writer of a machine's service role (the leader switch: at commit on the new leader, at
 * hand-over on the old one). Same role and home: nothing written. Ownership is by Walnut, never by
 * path: a mode of another Walnut is refused. A replica role needs exactly one follower spec for
 * `home`, a leader role an existing data dir. It writes the file only (atomic, 0600, the fallback
 * marker cleared) and never signals or restarts anything. Throws ServiceRoleError (`mode_busy`: an
 * update holds the mode this moment; try again).
 */
export function setServiceRole(installRoot: string, next: { role: ServiceRole; home: string; walnutId: string }, f: WriteFs = fs): { previous: ServiceMode | null; changed: boolean } {
  if (!absolute(installRoot)) throw new ServiceRoleError('bad_request', 'the install root is not an absolute path')
  if (next.role !== 'replica' && next.role !== 'leader') throw new ServiceRoleError('bad_request', `no role ${JSON.stringify(next.role)}`)
  if (typeof next.walnutId !== 'string' || !next.walnutId) throw new ServiceRoleError('bad_request', 'no walnutId')
  // One read-decide-write at a time with `walnut daemon update` (service-mode-lock.ts); never a wait here.
  try {
    return withServiceModeLock(installRoot, () => setServiceRoleHeld(installRoot, next, f))
  } catch (err) {
    if (err instanceof ServiceModeBusyError) throw new ServiceRoleError('mode_busy', err.message)
    throw err
  }
}

function setServiceRoleHeld(installRoot: string, next: { role: ServiceRole; home: string; walnutId: string }, f: WriteFs): { previous: ServiceMode | null; changed: boolean } {
  const read = readServiceMode(installRoot, f)
  const previous = 'mode' in read ? read.mode : null
  const owner = previous ? ownerOf(installRoot, previous, f) : null
  if (owner && owner !== next.walnutId) throw new ServiceRoleError('not_service_owner', `the service here is Walnut ${owner}'s, not ${next.walnutId}'s`)
  if (previous && serviceRoleOf(previous) === next.role && previous.home === next.home) return { previous, changed: false }
  if (next.role === 'replica') {
    const specs = followerSpecsFor(installRoot, next.home, f)
    if (!Array.isArray(specs) || specs.length !== 1) {
      throw new ServiceRoleError('no_follower_spec', Array.isArray(specs) && specs.length ? `${specs.length} follower specs name ${next.home}` : `no follower spec for ${next.home}`)
    }
    const id = specWalnutId(specs[0]!)
    if (id && id !== next.walnutId) throw new ServiceRoleError('not_service_owner', `the follower spec for ${next.home} is Walnut ${id}'s, not ${next.walnutId}'s`)
  } else {
    let dir = false
    try { dir = absolute(next.home) && f.statSync(next.home).isDirectory() } catch { /* missing */ }
    if (!dir) throw new ServiceRoleError('no_leader_home', `${next.home} is not an existing absolute directory`)
  }
  const exe = previous?.exe ?? launcherCurrent(installRoot, f)
  if (!exe) throw new ServiceRoleError('no_launcher', 'no mode and no launcher state names the version to run')
  const mode: ServiceMode = { v: 1, home: next.home, exe, ...(next.role === 'leader' ? { role: 'leader' as const } : {}), walnutId: next.walnutId }
  writeServiceMode(installRoot, mode, f)
  return { previous, changed: true }
}

/** The fallback marker, or null when there is none (or it does not read). */
export function readServiceRoleFallback(stateDir: string, f: FsLike = fs): ServiceRoleFallback | null {
  try {
    const raw = JSON.parse(f.readFileSync(path.join(stateDir, SERVICE_ROLE_FALLBACK_FILE), 'utf8')) as Partial<ServiceRoleFallback>
    if (raw?.v !== 1 || (raw.role !== 'leader' && raw.role !== 'replica') || typeof raw.home !== 'string' || typeof raw.exe !== 'string') return null
    return { v: 1, role: raw.role, home: raw.home, exe: raw.exe, at: typeof raw.at === 'number' ? raw.at : 0, why: typeof raw.why === 'string' ? raw.why : '' }
  } catch { return null }
}

/** Marks that `mode`'s role did not get ready in time; the mode file itself is never changed by it. */
export function writeServiceRoleFallback(stateDir: string, marker: Omit<ServiceRoleFallback, 'v'>, f: WriteFs = fs): void {
  writeWhole(path.join(stateDir, SERVICE_ROLE_FALLBACK_FILE), JSON.stringify({ v: 1, ...marker }) + '\n', f)
}
