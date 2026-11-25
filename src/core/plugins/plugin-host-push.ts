/**
 * `walnut.hosts.push(alias, { file | bytes, to, mode? })`: a plugin puts ONE file onto a host
 * Walnut knows, through Walnut's own link to that host's daemon (no new port, no ssh of its own).
 * Made for a plugin that ships the same program to every machine (a model proxy whose binary is
 * tens of MB): `hosts.run` carries at most a 1 MB script, so it could not carry the program.
 *
 * The bytes go the way host_copy's do (core/hosts/host-copy.ts): fs.writePart parts on the
 * receiving daemon (core/transfer/daemon-transfer-client.ts writeFileInParts), resumed after a
 * gap, the size and sha256 checked by the receiver before the file is renamed into place; the
 * same path rules (never credentials, Walnut's own data, or a place macOS guards); and a failure
 * reads as host_copy's do. What differs is the gate: a plugin is full-trust code, so no task grant
 * is asked (as for `hosts.run`), and the SOURCE is only ever the plugin's own data dir
 * (`walnut.storage.dataDir`) or bytes it hands over.
 *
 *   1. the source: `file` resolved (symlinks too) inside the data dir, opened without following a
 *      last symlink and checked again once open (the same file, still inside), a regular file of
 *      at most MAX_PUSH_BYTES; or `bytes`;
 *   2. the target: `to` (absolute or ~/..., a file path) as text, then its folder as the host
 *      resolves it (the real path of its deepest existing folder, one short script that looks at
 *      nothing inside it), refused when it falls in a place above (names compared case-folded,
 *      as a Mac's disk does; the host's own hub forwards file too);
 *   3. the source hashed, then the bytes to a hidden staging name in the target's own folder,
 *      size and sha256 checked there;
 *   4. one short script: refuse a folder at the target, chmod the staging file to `mode` (0644 by
 *      default), then rename it over the target, so the file appears whole, with its mode, or not
 *      at all (a target that turned into a folder in between is caught after the rename);
 *   5. any failure removes the staging file (best effort) and leaves the target as it was.
 *
 * A host Walnut cannot reach fails at the first step that needs it (its dial, at most 15 s),
 * never waits. At most MAX_PUSHES_PER_PLUGIN pushes of one plugin at once; a push stops at its
 * `timeoutMs` (10 minutes by default, at most an hour) and when the plugin stops.
 */
import crypto from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fsp, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { HostExecError } from '../hosts/host-exec-target.js'
import type { PartSource } from '../transfer/daemon-transfer-client.js'
import { configuredPluginHost, runCheckedScript, LOCAL_HOST_ALIAS } from './plugin-hosts.js'
import { clause } from '../../utils/format.js'

export const MAX_PUSH_BYTES = 256 * 1024 * 1024
export const MAX_PUSHES_PER_PLUGIN = 2
const DEFAULT_PUSH_MS = 10 * 60_000
const MAX_PUSH_MS = 60 * 60_000
const SCRIPT_MS = 30_000
const CLEANUP_MS = 10_000
/** The final part: the receiver hashes and syncs the whole file before it answers. */
const FINAL_PART_BASE_MS = 60_000
const FINAL_PART_BYTES_PER_S = 25 * 1024 * 1024

export interface PluginPushInput {
  /** A file in the plugin's own data dir: a path relative to it, or an absolute one inside it. */
  file?: string
  /** The file's bytes, instead of `file`. */
  bytes?: Uint8Array
  /** Where it lands on the host: a file path, absolute or ~/... */
  to: string
  /** Its permission bits, 0 to 0o777 (0o755 for a program). Default 0o644. */
  mode?: number
  /** Default 10 minutes, at most an hour. */
  timeoutMs?: number
}

export interface PluginPushResult {
  /** Where it landed, as the host resolves it (its folders' real paths). */
  path: string
  bytes: number
  sha256: string
  mode: number
  /** A file was there and was replaced. */
  replaced: boolean
}

const running = new Map<string, number>()

function bad(message: string, code = 'bad_request'): HostExecError {
  return new HostExecError(`hosts.push: ${message}`, 400, code)
}

/** `to` as text: absolute or ~/..., a file (no trailing slash), no .., no control characters. */
function checkTo(to: unknown): string {
  if (typeof to !== 'string' || !to.trim()) throw bad('`to` is required: a file path on the host, absolute or ~/...')
  if (/[\u0000-\u001f\u007f]/.test(to)) throw bad('`to` contains a control character')
  if (!(to.startsWith('/') || to.startsWith('~/'))) throw bad(`\`to\` must be absolute or start with ~/: ${to}`)
  if (to.split('/').includes('..')) throw bad(`\`to\` has a .. in it; write the path out without one: ${to}`)
  if (to.endsWith('/')) throw bad(`\`to\` names a folder; name the file itself: ${to}`)
  return to
}

function checkMode(mode: unknown): number {
  if (mode === undefined) return 0o644
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o777) throw bad('`mode` must be permission bits from 0 to 0o777 (no setuid, setgid or sticky bit)')
  return mode
}

/** The host's own hub forwards file is written on the host only (host-network.md): never by a push. */
const HUB_FORWARDS_FILE_RE = /(^|\/)net\/hub-forwards\.json$/i

/**
 * Refuse a target host_copy never writes (credentials, Walnut's own data, compared case-folded),
 * the host's own hub forwards file, or a place macOS guards on a Mac. `mac`: what the host said
 * it is (the resolve script), else what Walnut knows of it.
 */
async function refusePlace(alias: string, p: string, mac?: { home: string | null } | null): Promise<void> {
  const { protectedPath, macSide, macPlace } = await import('../hosts/host-copy-paths.js')
  const why = protectedPath(p, { foldCase: true })
  if (why) throw new HostExecError(`hosts.push never writes ${why}: ${alias}:${p}.`, 403, 'protected_path', { path: p })
  const { hubForwardsFileOf } = await import('../hosts/hub-ports.js')
  const forwards = hubForwardsFileOf(alias)
  if (HUB_FORWARDS_FILE_RE.test(p) || (forwards && forwards.toLowerCase() === p.toLowerCase())) {
    throw new HostExecError(`hosts.push never writes the host's own hub forwards file (${alias}:${p}); write it there with hosts.run, as the host's own user.`, 403, 'protected_path', { path: p })
  }
  const side = mac !== undefined ? mac : await macSide(alias)
  const place = side && macPlace(p, side, { foldCase: true })
  if (place) {
    throw new HostExecError(`hosts.push would write ${alias}:${p}, in ${place}, which macOS guards: it would show a permission dialog on that Mac's screen. Push to another folder.`, 409, 'may_prompt', { path: p })
  }
}

type Source = { size: number; label: string; read(offset: number, length: number): Promise<Buffer>; hash(): Promise<string>; close(): Promise<void> }

/** The plugin's file, opened: resolved inside its data dir, the same file once open, a regular file of at most MAX_PUSH_BYTES. */
async function openSource(dataDir: string, file: string): Promise<Source> {
  if (!file || file.includes('\u0000')) throw bad('`file` is required: a file in the plugin\'s data dir')
  if (file.split(/[\\/]/).includes('..')) throw bad(`\`file\` has a .. in it; name a file inside the plugin's data dir: ${file}`, 'outside_data_dir')
  let root: string
  try {
    root = await fsp.realpath(dataDir)
  } catch {
    throw new HostExecError(`hosts.push: no file ${file} (the plugin's data dir is empty).`, 404, 'source_missing')
  }
  const inside = (p: string) => p.startsWith(root + path.sep)
  const outside = (how = '') => new HostExecError(`hosts.push sends only a file inside the plugin's own data dir (walnut.storage.dataDir); ${file} is not one${how}.`, 403, 'outside_data_dir')
  const asked = path.isAbsolute(file) ? file : path.join(dataDir, file)
  let real: string
  try {
    real = await fsp.realpath(asked)
  } catch {
    throw new HostExecError(`hosts.push: no file ${file} in the plugin's data dir.`, 404, 'source_missing')
  }
  if (!inside(real)) throw outside(real !== path.resolve(asked) ? ' (a link leads out of it)' : '')
  let fh: FileHandle
  try {
    fh = await fsp.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch (err) {
    throw new HostExecError(`hosts.push could not open ${file}: ${(err as Error).message}`, 403, 'outside_data_dir')
  }
  try {
    const st = await fh.stat()
    // A folder on the way swapped for a link between the look and the open: the open file is not
    // the one looked at, or no longer inside (Linux names an open file's real path in /proc).
    const now = await fsp.stat(real).catch(() => null)
    if (!now || now.dev !== st.dev || now.ino !== st.ino || !inside(await fsp.realpath(real).catch(() => ''))) throw outside(' (it moved while it was opened)')
    const viaFd = await fsp.realpath(`/proc/self/fd/${fh.fd}`).catch(() => null)
    if (viaFd !== null && !inside(viaFd)) throw outside(' (a link leads out of it)')
    if (!st.isFile()) throw new HostExecError(`hosts.push sends one regular file; ${file} is not one (tar a folder first).`, 400, 'not_a_file')
    if (st.size > MAX_PUSH_BYTES) throw new HostExecError(`hosts.push sends at most ${MAX_PUSH_BYTES} bytes (256 MB); ${file} is ${st.size}.`, 413, 'too_large')
    const size = st.size
    const read = async (offset: number, length: number): Promise<Buffer> => {
      const out = Buffer.alloc(length)
      let got = 0
      while (got < length) {
        const { bytesRead } = await fh.read(out, got, length - got, offset + got)
        if (bytesRead === 0) break
        got += bytesRead
      }
      return out.subarray(0, got)
    }
    return {
      size, label: real, read,
      async hash() {
        const h = crypto.createHash('sha256')
        for (let at = 0; at < size;) {
          const chunk = await read(at, Math.min(1024 * 1024, size - at))
          if (chunk.length === 0) break
          h.update(chunk)
          at += chunk.length
        }
        return h.digest('hex')
      },
      close: () => fh.close(),
    }
  } catch (err) {
    await fh.close().catch(() => {})
    throw err
  }
}

function bytesSource(bytes: Uint8Array): Source {
  if (bytes.byteLength > MAX_PUSH_BYTES) throw new HostExecError(`hosts.push sends at most ${MAX_PUSH_BYTES} bytes (256 MB); these are ${bytes.byteLength}.`, 413, 'too_large')
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    size: buf.length, label: '(bytes)',
    read: async (offset, length) => buf.subarray(offset, offset + length),
    hash: async () => crypto.createHash('sha256').update(buf).digest('hex'),
    close: async () => {},
  }
}

// Where `to` lands as the host resolves it: `~` expanded there, the deepest folder that exists
// read with `pwd -P` (its links resolved), the folders still missing kept as written. Looks at
// nothing inside that folder (a guarded one on a Mac would show a permission dialog), so what is
// at the target is FINISH_SCRIPT's to find. Prints `uname -s`, $HOME, then the target's path.
const RESOLVE_SCRIPT = `t=$1
case $t in
  "~/"*) t=$HOME/\${t#"~/"} ;;
esac
case $t in /*) ;; *) echo "walnut: not an absolute path: $t" >&2; exit 2 ;; esac
base=\${t##*/}
dir=\${t%/*}
[ -n "$dir" ] || dir=/
rest=
while [ ! -d "$dir" ]; do
  if [ -e "$dir" ] || [ -L "$dir" ]; then echo "walnut: a part of the path is a file, not a folder: $dir" >&2; exit 3; fi
  rest=/\${dir##*/}$rest
  dir=\${dir%/*}
  [ -n "$dir" ] || dir=/
done
real=$(cd "$dir" 2>/dev/null && pwd -P) || { echo "walnut: cannot read the folder $dir" >&2; exit 4; }
[ "$real" = / ] && real=
printf '%s\\n%s\\n%s\\n' "$(uname -s 2>/dev/null)" "$HOME" "$real$rest/$base"
`

// The staged, checked file takes its mode, then is renamed over the target in its own folder: the
// target is the old file or the whole new one with its mode, never a part. A folder at the target
// is refused (exit 3); one that appeared just before the rename got the file inside it, which is
// taken back out and refused the same way. Prints `replaced` when a file (or a link) was there.
const FINISH_SCRIPT = `s=$1; t=$2; m=$3
if [ -d "$t" ]; then rm -f "$s"; echo "walnut: $t is a folder; name the file itself" >&2; exit 3; fi
was=
if [ -e "$t" ] || [ -L "$t" ]; then was=replaced; fi
chmod "$m" "$s" || { rm -f "$s"; echo "walnut: chmod $m failed" >&2; exit 4; }
mv -f "$s" "$t" || { rm -f "$s"; echo "walnut: could not move the file into place" >&2; exit 5; }
if [ -d "$t" ]; then rm -f "$t/\${s##*/}"; echo "walnut: $t is a folder; name the file itself" >&2; exit 3; fi
printf '%s\\n' "$was"
`

const CLEANUP_SCRIPT = 'rm -f "$1" "$1.walnut-part"\n'

async function script(host: Awaited<ReturnType<typeof configuredPluginHost>>, body: string, args: string[], timeoutMs = SCRIPT_MS) {
  return runCheckedScript(host, { script: body, args, timeoutMs, maxOutputBytes: 64 * 1024 })
}

/** What Walnut knows a host runs, when it is Windows: its scripts are sh, so a push cannot run there. */
async function refuseWindows(host: Awaited<ReturnType<typeof configuredPluginHost>>): Promise<void> {
  if (host.local) {
    if (process.platform === 'win32') throw new HostExecError('hosts.push runs sh scripts; this machine is Windows.', 409, 'unsupported_platform')
    return
  }
  const { getPluginHost } = await import('./plugin-hosts.js')
  const known = await getPluginHost(host.alias).catch(() => null)
  if (known?.platform?.os === 'windows') throw new HostExecError(`hosts.push runs sh scripts; ${host.alias} is Windows (a WSL host works).`, 409, 'unsupported_platform')
}

/** Put one file onto a host for a plugin (see the file comment). */
export async function pushToPluginHost(pluginId: string, dataDir: string, alias: string, input: PluginPushInput, stop?: AbortSignal): Promise<PluginPushResult> {
  const i = (input ?? {}) as Partial<PluginPushInput>
  const hasFile = i.file !== undefined
  const hasBytes = i.bytes !== undefined
  if (hasFile === hasBytes) throw bad('give exactly one of `file` (in the plugin\'s data dir) or `bytes`')
  if (hasFile && typeof i.file !== 'string') throw bad('`file` must be a path in the plugin\'s data dir')
  if (hasBytes && !(i.bytes instanceof Uint8Array)) throw bad('`bytes` must be a Uint8Array')
  const to = checkTo(i.to)
  const mode = checkMode(i.mode)
  const timeoutMs = Math.max(1_000, Math.min(MAX_PUSH_MS, typeof i.timeoutMs === 'number' && Number.isFinite(i.timeoutMs) ? i.timeoutMs : DEFAULT_PUSH_MS))
  const host = await configuredPluginHost(alias).catch((err: Error) => { throw new HostExecError(err.message, 404, 'unknown_host') })
  // As text first: a refused target costs no dial and no read.
  await refusePlace(alias, to)
  if ((running.get(pluginId) ?? 0) >= MAX_PUSHES_PER_PLUGIN) {
    throw new HostExecError(`hosts.push: this plugin already pushes ${MAX_PUSHES_PER_PLUGIN} files; wait for one.`, 429, 'busy')
  }
  running.set(pluginId, (running.get(pluginId) ?? 0) + 1)
  const t0 = Date.now()
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new HostExecError(`hosts.push stopped at its ${Math.round(timeoutMs / 1000)} s deadline; nothing was written at ${alias}:${to}.`, 504, 'push_deadline')), timeoutMs)
  timer.unref?.()
  const signal = stop ? AbortSignal.any([stop, deadline.signal]) : deadline.signal
  let source: Source | null = null
  let staging: string | null = null
  let final = to
  let sent = 0
  try {
    await refuseWindows(host)
    source = hasFile ? await openSource(dataDir, i.file as string) : bytesSource(i.bytes as Uint8Array)
    const resolved = await script(host, RESOLVE_SCRIPT, [to])
    if (resolved.code !== 0) {
      throw new HostExecError(`hosts.push could not place ${alias}:${to}: ${resolved.stderr.replace(/^walnut: /, '').trim() || `exit ${String(resolved.code)}`}. Nothing was written.`, 409, 'target_unusable', { path: to })
    }
    const [system, home, where] = resolved.stdout.split('\n')
    if (!where || !where.startsWith('/')) {
      throw new HostExecError(`hosts.push could not tell where ${alias}:${to} is. Nothing was written.`, 502, 'target_unknown', { path: to })
    }
    final = where
    // As the host resolves it, and as the host says it is (a Mac Walnut never profiled included).
    const mac = system === 'Darwin' ? { home: home && home.startsWith('/') ? home.replace(/\/+$/, '') : null } : null
    await refusePlace(alias, final, system ? mac : undefined)
    signal.throwIfAborted()
    const sha256 = await source.hash()
    staging = `${path.posix.dirname(final)}/.walnut-push-${crypto.randomBytes(6).toString('hex')}`
    const { writeFileInParts } = await import('../transfer/daemon-transfer-client.js')
    const parts: PartSource = { size: source.size, sha256, read: (o, n) => source!.read(o, n) }
    const reply = await writeFileInParts(alias, staging, parts, {
      signal,
      finalPartTimeoutMs: FINAL_PART_BASE_MS + Math.ceil(source.size / FINAL_PART_BYTES_PER_S) * 1000,
      onProgress: (p) => { sent = p.sent },
    })
    if (reply.sha256 && reply.sha256 !== sha256) {
      throw new HostExecError(`What ${alias} received does not match what was sent (sha256). Nothing was written at ${alias}:${final}.`, 502, 'checksum_mismatch')
    }
    signal.throwIfAborted()
    const done = await script(host, FINISH_SCRIPT, [staging, final, mode.toString(8).padStart(3, '0')])
    if (done.code !== 0) {
      staging = null // the script removed it
      const why = done.stderr.replace(/^walnut: /, '').trim() || `exit ${String(done.code)}`
      if (done.code === 3) throw new HostExecError(`hosts.push: ${alias}:${final} is a folder; name the file itself in \`to\`. Nothing was written.`, 409, 'is_directory', { path: final })
      throw new HostExecError(`hosts.push could not put the file in place at ${alias}:${final}: ${clause(why)}. The file there is as it was.`, 409, 'target_unusable', { path: final })
    }
    staging = null
    log.session.info('plugin push', { pluginId, host: alias, to: final, bytes: source.size, mode: mode.toString(8), ms: Date.now() - t0 })
    return { path: final, bytes: source.size, sha256, mode, replaced: done.stdout.trim() === 'replaced' }
  } catch (err) {
    const failure = err instanceof HostExecError ? err
      : stop?.aborted ? new HostExecError(`hosts.push stopped with the plugin; nothing was written at ${alias}:${final}.`, 409, 'push_stopped')
      : await (await import('../hosts/host-copy.js')).copyFailure(err, {
      fromHost: LOCAL_HOST_ALIAS, toHost: alias, from: source?.label ?? '(plugin data)', to: final, sent, total: source?.size ?? null, dialog: undefined,
    }).catch(() => new HostExecError(`hosts.push failed: ${err instanceof Error ? err.message : String(err)}`, 502, 'push_failed'))
    if (staging) {
      const left = staging
      // Best effort and bounded: a host that went away keeps the hidden staging file, named here.
      await script(host, CLEANUP_SCRIPT, [left], CLEANUP_MS).then((r) => {
        if (r.code !== 0) failure.data = { ...failure.data, partialLeft: left }
      }, () => { failure.data = { ...failure.data, partialLeft: left } })
    }
    log.session.warn('plugin push failed', { pluginId, host: alias, to: final, sent, code: failure.code, error: failure.message })
    throw failure
  } finally {
    clearTimeout(timer)
    await source?.close().catch(() => {})
    const n = (running.get(pluginId) ?? 1) - 1
    if (n > 0) running.set(pluginId, n)
    else running.delete(pluginId)
  }
}
