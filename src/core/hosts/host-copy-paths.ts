/**
 * The paths of a host_copy (host-copy.ts): what a path may be, which paths it never
 * touches, and what is at a path on a host, each read with one tiny `fs.readRange`
 * (`length: 1`), whose refusals tell a file, nothing, a folder and a file on the way
 * apart (ENOTFILE, ENOENT, ENOTDIR) in a reply of a few bytes, never a listing.
 *
 * Paths are checked as text on this server, so a symlink on that host is not seen;
 * these rules stop an accident, the grant is the boundary.
 */
import os from 'node:os'
import path from 'node:path'
import { HostExecError } from './host-exec.js'

const PROBE_MS = 15_000

function bad(message: string): HostExecError {
  return new HostExecError(message, 400, 'bad_request')
}

/** A path as a host's daemon takes it: absolute or under `~`, never relative (the daemon's own cwd). */
export function checkPath(p: unknown, what: 'from' | 'to'): string {
  const side = what === 'from' ? 'sending' : 'receiving'
  if (typeof p !== 'string' || !p.trim()) throw bad(`${what} is required: a file path on the ${side} host`)
  if (p.includes('\u0000')) throw bad(`${what} contains a NUL byte`)
  if (!(p === '~' || p.startsWith('~/') || p.startsWith('/'))) {
    throw bad(`${what} must be absolute or start with ~/ (write it out: no $VARIABLES, no relative path): ${p}`)
  }
  if (p.split('/').includes('..')) throw bad(`${what} has a .. in it; write the path out without one: ${p}`)
  return p
}

/** Credential stores and files, by segment (a file named `my.ssh.notes` is not one); the daemons' fs-mutate list. */
const CREDENTIAL_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', 'secrets', 'secrets-master'])
const CREDENTIAL_FILES = new Set(['auth.json', 'bridge-tokens.json'])
/** `open-walnut` right under one of these is Walnut's own runtime or state, never a repo checkout. */
const WALNUT_PARENTS = new Set(['tmp', 'T', '.cache', 'state'])

/**
 * Why host_copy never reads or writes `p`, or null: credentials (the daemons refuse to
 * change these too), and Walnut's own data and runtime (its data dir, streams, the host
 * daemon's state, a host's secrets and network keys). A task's directory
 * (`.../state/open-walnut/tasks/<task>/...`) is the one Walnut place it may use.
 */
export function protectedPath(p: string): string | null {
  const segs = p.split('/').filter(Boolean)
  if (segs.some((s) => CREDENTIAL_SEGMENTS.has(s)) || CREDENTIAL_FILES.has(segs[segs.length - 1] ?? '')) return 'credentials'
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '.open-walnut' || segs[i] === 'open-walnut-streams') return 'Walnut\'s own data'
    if (segs[i] !== 'open-walnut' || i === 0 || !WALNUT_PARENTS.has(segs[i - 1])) continue
    if (segs[i - 1] === 'state' && segs[i + 1] === 'tasks' && segs.length > i + 2) continue
    return 'Walnut\'s own data'
  }
  return null
}

export function refuseProtected(host: string, p: string): void {
  const why = protectedPath(p)
  if (why) {
    throw new HostExecError(`host_copy never reads or writes ${why}: ${host}:${p}. If this file must move, ask the user.`, 403, 'protected_path', { path: p })
  }
}

// ── macOS places a program may not read or write without the person's OK (TCC) ──

/**
 * Under a home directory: touching what is in them shows a permission dialog on that Mac's
 * screen. The same list as host_exec's (PROTECTED_IN_HOME in src/providers/host-exec-guards.ts,
 * not exported; tests/core/hosts/host-copy.test.ts fails when the two differ).
 */
export const MAC_PROTECTED_IN_HOME = [
  'Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music',
  'Library/Mail', 'Library/Messages', 'Library/Safari', 'Library/Containers', 'Library/Group Containers',
  'Library/Calendars', 'Library/Application Support/AddressBook', 'Library/Mobile Documents', 'Library/CloudStorage',
]

/** What host_copy knows of a Mac: its home when Walnut has seen it (null: only `~/...` and /Users/<name>/... are read). */
export interface MacSide { home: string | null }

/**
 * Whether `host` is a Mac, as this server knows it: this machine by its own platform, another
 * host by what its daemon last reported (its profile, else its last preflight). null: not a Mac,
 * or a host Walnut has not seen yet (host_exec's rule for these places too).
 */
export async function macSide(host: string): Promise<MacSide | null> {
  if (host === '__local__') return process.platform === 'darwin' ? { home: os.homedir() } : null
  const { readHostProfile } = await import('./host-profile.js')
  const probed = (await readHostProfile(host).catch(() => null))?.probed
  let platform: unknown = probed?.os?.platform
  if (typeof platform !== 'string' || !platform) {
    const { store } = await import('./host-readiness-store.js')
    platform = store.get(host)?.platform
  }
  if (platform !== 'darwin') return null
  return { home: typeof probed?.home === 'string' && probed.home.startsWith('/') ? probed.home.replace(/\/+$/, '') : null }
}

const inside = (rel: string, root: string) => rel === root || rel.startsWith(`${root}/`)

/** The guarded place `p` is in on a Mac (e.g. "~/Downloads", "/Volumes"), or null. */
export function macPlace(p: string, mac: MacSide): string | null {
  const norm = path.posix.normalize(p).replace(/\/+$/, '') || '/'
  if (norm === '/Volumes' || norm.startsWith('/Volumes/')) return '/Volumes'
  if (norm.split('/').some((s) => s.endsWith('.photoslibrary'))) return 'a Photos library'
  // The part under a home: ~/..., the Mac's own home, or any /Users/<name>/... (another person's home too).
  let rel: string | null = null
  if (norm === '~' || norm.startsWith('~/')) rel = norm.slice(2)
  else if (mac.home && inside(norm, mac.home)) rel = norm.slice(mac.home.length + 1)
  else {
    const m = /^\/Users\/[^/]+(?:\/(.*))?$/.exec(norm)
    if (m) rel = m[1] ?? ''
  }
  if (rel === null) return null
  const root = MAC_PROTECTED_IN_HOME.find((r) => inside(rel!, r))
  return root ? `~/${root}` : null
}

/**
 * Refuses `p` on a Mac when it is in a place macOS guards: reading or writing there puts a
 * permission dialog on that Mac's screen, and the copy would wait in it (2026-11-03: host_exec's
 * `du ~/Library/Caches` sat in one for 6 minutes on someone else's Mac).
 */
export async function refuseMacPlace(host: string, p: string, mac: MacSide | null, how: 'read' | 'write'): Promise<void> {
  const place = mac && macPlace(p, mac)
  if (!place) return
  const { hostName } = await import('./host-exec.js')
  throw new HostExecError(
    `host_copy would ${how} ${host}:${p}, in ${place}, which macOS guards: it shows a permission dialog on ${await hostName(host)}'s `
    + 'screen and the copy waits there until someone answers. Nothing was copied. Copy from or to another folder (on a Mac, your '
    + 'task directory or a build folder, never Desktop, Documents, Downloads, Pictures, Movies, Music, Mail, Messages, another '
    + "app's data or /Volumes), or ask the user first and call again with allow_prompts: true.",
    409, 'may_prompt', { prompt: `${host}:${p}` },
  )
}

/** What one probe found at a path on a host. */
export type Probe = 'file' | 'missing' | 'not_file' | 'parent_not_dir' | { error: string }

/** One `fs.readRange` of a byte, read for what is at `p` (its size when it is a file). */
export async function probe(host: string, p: string): Promise<{ at: Probe; size?: number }> {
  const { hostCommand } = await import('../transfer/daemon-transfer-client.js')
  const r = await hostCommand(host, 'fs.readRange', 'fs.readRange', { path: p, start: 0, length: 1 }, PROBE_MS)
  if (r.ok !== false) {
    const size = Number(r.fileSize)
    return Number.isSafeInteger(size) && size >= 0 ? { at: 'file', size } : { at: { error: 'no file size in the reply' } }
  }
  const msg = String(r.error ?? '').replace(/^fs\.readRange failed: /, '')
  if (/\bENOENT\b/.test(msg)) return { at: 'missing' }
  if (/\bENOTFILE\b/.test(msg)) return { at: 'not_file' }
  if (/\bENOTDIR\b/.test(msg)) return { at: 'parent_not_dir' }
  return { at: { error: msg } }
}

/** `p` without its trailing slashes (`/` stays `/`). */
export function trimSlashes(p: string): string {
  const t = p.replace(/\/+$/, '')
  return t || '/'
}

/** A shell word for the tar hint: plain words as they are, a leading ~/ kept outside the quotes. */
function shellWord(s: string): string {
  if (/^[\w@%+=:,./~-]+$/.test(s)) return s
  const home = s.startsWith('~/') ? '~/' : ''
  return home + `'${s.slice(home.length).replace(/'/g, `'\\''`)}'`
}

function folderRefusal(host: string, p: string, own: boolean): HostExecError {
  const parent = path.posix.dirname(p)
  const name = path.posix.basename(p) || 'folder'
  const tar = `tar -czf "$WALNUT_TASK_DIR/${name.replace(/["$`\\]/g, '_')}.tgz" -C ${shellWord(parent)} ${shellWord(name)}`
  const how = own ? 'with your own Bash' : `with host_exec on ${host} (its answer names that task directory as taskDir)`
  return new HostExecError(`${host}:${p} is a folder; host_copy copies one file. Pack it first, ${how}: ${tar}, then copy the .tgz.`, 400, 'is_directory')
}

/** The source's size; refuses a missing file, a folder (with how to pack it) and anything not a regular file. */
export async function sourceSize(host: string, from: string, own: boolean): Promise<number> {
  const p = trimSlashes(from)
  const { at, size } = await probe(host, p)
  if (at === 'file') return size!
  if (at === 'missing') throw new HostExecError(`No file at ${host}:${from}.`, 404, 'source_missing')
  if (at === 'parent_not_dir') throw new HostExecError(`No file at ${host}:${from} (a part of that path is a file, not a folder).`, 404, 'source_missing')
  if (at === 'not_file') {
    // `dir/.` is a folder too; under a pipe, socket or device it is ENOTDIR.
    if ((await probe(host, p === '/' ? '/.' : `${p}/.`)).at === 'not_file') throw folderRefusal(host, p, own)
    throw new HostExecError(`${host}:${from} is not a regular file (a pipe, socket or device); host_copy copies one regular file.`, 400, 'not_a_file')
  }
  throw new HostExecError(`${host} could not read ${from}: ${at.error}`, 502, 'read_failed')
}

export type TargetPlan = { path: string; replaced: boolean }

/**
 * Where the file lands for `to` on the receiving host: `to` itself, or `to/<name>`
 * when `to` ends in `/` or is a folder. Refuses a folder where the file would land,
 * `to/` naming a file, a path under a file, and a place it could not read.
 * `look` is the probe (injected for tests).
 */
export async function planTarget(host: string, to: string, name: string, look: (p: string) => Promise<Probe>): Promise<TargetPlan> {
  const slash = to.endsWith('/')
  const base = trimSlashes(to)
  const inside = `${base === '/' ? '' : base}/${name}`
  const refuse = (msg: string, code: string, p: string) => new HostExecError(msg, 409, code, { path: p })
  const unknown = (p: string, error: string) => refuse(`Walnut could not tell what is at ${host}:${p} (${error}); nothing was copied. Name another path.`, 'target_unknown', p)
  const at = await look(base)
  if (at === 'file') {
    if (slash) throw refuse(`${host}:${base} is a file, not a folder; drop the trailing / to replace it, or name another folder.`, 'target_not_dir', base)
    return { path: to, replaced: true }
  }
  if (at === 'missing') return { path: slash ? inside : to, replaced: false }
  if (at === 'parent_not_dir') throw refuse(`A part of ${host}:${base} is a file, not a folder; name a path whose folders are folders.`, 'target_not_dir', base)
  if (at !== 'not_file') throw unknown(base, at.error)
  // A folder (or a pipe, socket or device, which the next probe tells apart).
  const there = await look(inside)
  if (there === 'file') return { path: inside, replaced: true }
  if (there === 'missing') return { path: inside, replaced: false }
  if (there === 'not_file') throw refuse(`${host}:${inside} is a folder; name the file's own path in \`to\`.`, 'target_is_directory', inside)
  if (there === 'parent_not_dir') throw refuse(`${host}:${base} is not a folder (a pipe, socket or device); name another path.`, 'target_not_dir', base)
  throw unknown(inside, there.error)
}
