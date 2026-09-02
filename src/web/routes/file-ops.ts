/**
 * File MUTATIONS for the session Files panel — new folder, new file, rename,
 * duplicate, delete.
 *
 *   POST /api/files/mkdir     { path, host? }
 *   POST /api/files/create    { path, host? }              → empty file
 *   POST /api/files/rename    { path, newPath, host? }
 *   POST /api/files/duplicate { path, newPath, host? }      → file or directory
 *   POST /api/files/delete    { path, host?, recursive? }
 *
 * Success is `200 { ok: true, path: <resulting absolute path> }` (delete has no
 * resulting path, so it answers `{ ok: true }`). An operation still running when
 * its deadline expires (20s for delete/duplicate anywhere, 8s for anything on a
 * remote host) answers `202 { pending: true, message }` and KEEPS GOING. Failures
 * answer `{ error, code }` with a machine-readable code
 * the UI switches on:
 * invalid(400) | forbidden(403) | not_found(404) | exists(409) |
 * is_directory(400) | unsupported(400) | no_space(507) |
 * daemon_needs_upgrade(501) | remote(502).
 *
 * Three design rules this file exists to hold:
 *
 * 1. A mutation NEVER clobbers. Every create/rename/duplicate checks the target
 *    first and answers 409 instead of overwriting, because POSIX rename and a
 *    plain write both replace an existing file silently — in a file tree that
 *    reads as "my other file vanished", with nothing to recover from.
 *
 * 2. Remote work belongs to the daemon (see CLAUDE.md "host-local work belongs
 *    to the DAEMON"). With `host` set, the whole operation is ONE RPC to that
 *    host's daemon, which re-runs the same input floor next to the files; the
 *    server never shuttles bytes or fans out per-entry calls.
 *
 * 3. A slow operation is never reported as a FAILED one. Deleting or copying a
 *    big tree can outrun any HTTP-friendly budget, and the old behaviour told the
 *    user "could not complete on the remote host" while the daemon went on to
 *    finish the delete — the worst possible answer, since the folder really is
 *    gone. Past the deadline the answer is an honest 202 `pending`.
 *
 * The input floor below is duplicated in both daemon twins on purpose: the
 * server's copy gives a fast, precise 400, and the daemon's copy means a bug or
 * a hand-crafted RPC on the trusted socket still cannot aim a recursive delete
 * at `/` or a home directory.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { assertPathAllowed, FileContentError } from './file-content.js'
import {
  FileOpError,
  STATUS_BY_CODE,
  mapErrno,
  mapRemoteError,
  type FileOpErrorCode,
} from './file-ops-errors.js'
import { createFileReader } from '../../core/session-file-reader.js'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'

export type FileOpName = 'mkdir' | 'create' | 'rename' | 'duplicate' | 'delete'

export const FILE_OP_NAMES: readonly FileOpName[] = ['mkdir', 'create', 'rename', 'duplicate', 'delete']

export type { FileOpErrorCode }

/** The slice of DaemonFileReader a mutation needs — also the test seam. */
export interface MutatingFileReader {
  renamePath(from: string, to: string): Promise<void>
  removePath(remotePath: string, recursive: boolean, timeoutMs?: number): Promise<void>
  copyPath(from: string, to: string, timeoutMs?: number): Promise<void>
  mkdirExclusive(remotePath: string): Promise<void>
  createEmptyFile(remotePath: string): Promise<void>
}

export interface FileOpDeps {
  /** Override the reader factory (tests inject a fake; production uses the daemon). */
  createReader?: (host: string) => MutatingFileReader | Promise<MutatingFileReader>
  /** Deadline before a slow op answers 202 pending (tests shorten it). */
  pendingAfterMs?: number
}

/** How long a delete/duplicate may run before the answer becomes "still
 *  working". Not a timeout: nothing is cancelled when it fires. */
const DEFAULT_PENDING_AFTER_MS = 20_000

/** Timeout for the same two ops' daemon RPC. Far LONGER than the deadline above
 *  on purpose: `conn.send`'s 30s default used to reject mid-delete, and that
 *  rejection was mapped to a 502 while the daemon finished removing the tree. */
const REMOTE_SLOW_OP_TIMEOUT_MS = 10 * 60_000

/** Ops that can legitimately outlive a request: both walk an unbounded tree. */
const SLOW_OPS: ReadonlySet<FileOpName> = new Set<FileOpName>(['delete', 'duplicate'])

/** Deadline for the OTHER remote ops (mkdir/create/rename are one syscall on the
 *  host, so anything slower is the tunnel or the daemon). CLAUDE.md: every route
 *  touching a daemon answers degraded, never hangs — one pinned response starves
 *  the browser's connection pool. Past this the answer is the same honest 202. */
const REMOTE_FAST_OP_DEADLINE_MS = 8_000

const PENDING_MESSAGE =
  'Still working — this is taking longer than usual. The tree will refresh when it finishes.'

export interface FileOpInput {
  op: FileOpName
  path?: unknown
  newPath?: unknown
  host?: unknown
  recursive?: unknown
}

export type FileOpResult =
  | { status: 200; body: { ok: true; path?: string } }
  | { status: 202; body: { pending: true; message: string } }
  | { status: number; body: { error: string; code: FileOpErrorCode } }

/** Race `work` against a clock WITHOUT cancelling it. `{ done: false }` means
 *  "still running", never "failed" (header rule 3). Exported so the race is unit
 *  testable without needing a genuinely slow filesystem. */
export async function raceDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), ms)
        // Never hold the process open just to answer "still working".
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Longest a single path component may be on ext4/APFS/HFS+. */
const MAX_NAME_BYTES = 255

/**
 * The floor every mutating path must clear, mirrored from the daemon twins
 * (`fsMutateFloor`). Each clause blocks a specific way to destroy something:
 * a relative path resolves against a cwd the caller can't reason about; a
 * `.`/`..` SEGMENT lets a validated prefix escape; `/` and the home directory are
 * never legitimate targets; and requiring two segments keeps `/tmp`, `/usr`,
 * `/etc` out of reach so only something at `/a/b` depth or deeper is touchable.
 *
 * The segment-wise `..` check is the DAEMON's contract, kept here as
 * defence-in-depth for direct callers of `performFileOp`. It does NOT describe
 * what an HTTP request sees: `assertPathAllowed` runs first and rejects any `..`
 * SUBSTRING, so an ordinary name like `mod..old.ts` is already a bare 400
 * "Invalid path" and this loop never gets to allow it. Over-strict is the safe
 * direction for a destructive edge, so that stays; a test pins the 400 so
 * loosening it has to be a deliberate change rather than a side effect.
 */
export function withinMutateFloor(rawAbsolute: string): boolean {
  if (!rawAbsolute || !path.isAbsolute(rawAbsolute)) return false
  let p = rawAbsolute
  // Trailing slashes are cosmetic — strip them BEFORE comparing, or a home path
  // written with one walks straight past the homedir check.
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  const segments = p.split('/')
  for (const seg of segments) if (seg === '.' || seg === '..') return false
  if (segments.filter((s) => s.length > 0).length < 2) return false
  let home = os.homedir()
  while (home.length > 1 && home.endsWith('/')) home = home.slice(0, -1)
  return p !== '/' && p !== home
}

/** True when `child` is `parent` or lives underneath it. */
function isInside(parent: string, child: string): boolean {
  const a = path.resolve(parent)
  const b = path.resolve(child)
  return b === a || b.startsWith(a + path.sep)
}

/**
 * Walnut's own irreplaceable state. The floor above was built against `/` and the
 * home directory, but the data that genuinely cannot be recovered here sits two or
 * three levels down and sailed straight through: the task database, the session
 * registry, and the stream JSONLs that are the source of truth for conversation
 * history (deleting those loses chat history outright — there is no other copy).
 *
 * Deliberately NOT a blanket ban on everything under the data dir: notes, skills
 * and plugins live there too and editing them from the Files panel is the point.
 * Only the state files Walnut itself owns are off limits.
 */
/** Walnut's data dir, read per call. `OPEN_WALNUT_HOME` is the real setting
 *  (constants.ts resolves it at boot and writes the answer back into the env, so
 *  a custom data dir is protected too); `WALNUT_HOME` is the test seam that points
 *  the denylist at a temp dir without disturbing the process-wide resolution. */
function walnutDataDir(): string {
  return process.env.WALNUT_HOME || process.env.OPEN_WALNUT_HOME || path.join(os.homedir(), '.open-walnut')
}

/** Credential STORES, matched segment-wise (a file named `my.ssh.notes` is not one). */
const CREDENTIAL_DIR_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube'])

/** Credential FILES, wherever they live. */
const CREDENTIAL_BASENAMES = new Set(['auth.json', 'bridge-tokens.json'])

/**
 * The denylist for MUTATIONS. Deliberately NOT `isSecretPath` (the read
 * denylist), which refuses `config.yaml` ANYWHERE: right when the question is
 * "may I serve these bytes", wrong here, because every repo has one and a bare
 * 403 "Path not permitted" on renaming a project's own config is a dead end the
 * user can neither act on nor understand. This enumerates instead: credential
 * DIRECTORIES by segment, credential FILES by basename, a `secrets` segment, and
 * the only `config.yaml` that really holds provider credentials — Walnut's own.
 * Mirrors the daemon twins' `fsMutateDenied`, which enforces it host-side.
 */
export function isSecretForMutation(p: string): boolean {
  const resolved = path.resolve(p)
  const segments = resolved.split(path.sep)
  for (const seg of segments) {
    if (CREDENTIAL_DIR_SEGMENTS.has(seg) || seg === 'secrets') return true
  }
  if (CREDENTIAL_BASENAMES.has(path.basename(resolved))) return true
  // Walnut's OWN config only. Both spellings, and both the configured data dir
  // and the default one (a WALNUT_HOME override must not expose the default).
  for (const dir of new Set([walnutDataDir(), path.join(os.homedir(), '.open-walnut')])) {
    if (resolved === path.join(dir, 'config.yaml') || resolved === path.join(dir, 'config.yml')) {
      return true
    }
  }
  return false
}

const SECRET_REFUSAL = "Path not permitted (credentials or Walnut's own config)"

export function isProtectedStatePath(p: string): boolean {
  const dataDir = walnutDataDir()
  // Exact matches only — the data dir itself and the state files Walnut owns.
  // Deliberately not the whole tree: notes, skills and plugins live under the
  // data dir and editing those from the Files panel is the feature.
  const exact = [
    dataDir,
    path.join(dataDir, 'tasks.json'),
    path.join(dataDir, 'sessions.json'),
    path.join(dataDir, 'chat-history.json'),
  ]
  if (exact.includes(p)) return true
  // Whole trees — the runtime dirs hold nothing a person edits by hand, and the
  // stream JSONLs inside them ARE the conversation history.
  const trees = [
    '/tmp/open-walnut',
    '/tmp/open-walnut-streams',
    path.join(os.tmpdir(), 'open-walnut'),
    path.join(os.tmpdir(), 'open-walnut-streams'),
    // The CURRENT home of the stream JSONLs (moved from /tmp in 2026-08) and
    // everything else Walnut keeps under its tmp dir (daemon state, file
    // history). The legacy roots above stayed for older daemons; forgetting the
    // new one left the only copy of every conversation deletable from a tree.
    path.join(dataDir, 'tmp'),
  ]
  return trees.some((t) => isInside(t, p))
}

/**
 * Re-attach `basename` to the REAL, symlink-resolved parent directory.
 *
 * Without this the whole floor is decorative. Every check above reads the path as
 * a STRING, but the kernel resolves it as a chain of directories, so a symlinked
 * ancestor launders any target past all of them: `/tmp/link/.ssh` is three
 * segments deep, contains no `..`, is not `/`, is not the home directory, and does
 * not string-match the secret denylist — yet if `link` points at the home
 * directory, `rm -r` on it takes out the real `~/.ssh`. Same trick reaches the
 * task database and anything else the denylist names.
 *
 * The parent is resolved, never the path itself: a symlink must be renamed or
 * deleted as the LINK, not followed to its target (see execLocal's lstat note).
 * This is the ordering `cmdFsReadBounded` in the daemon already uses for reads —
 * realpath BEFORE the denylist — and it is now the same for writes.
 */
async function realizeForFloor(p: string): Promise<string> {
  const dir = path.dirname(p)
  try {
    return path.join(await fsp.realpath(dir), path.basename(p))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new FileOpError('not_found', `Not found: ${dir}`)
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FileOpError('forbidden', `Permission denied: ${dir}`)
    }
    throw err
  }
}

/**
 * The floor, applied to what the kernel will ACTUALLY touch. Runs for local
 * operations only — the server cannot resolve symlinks on another machine, so the
 * remote side of this check lives in the daemon twins' `fsMutateFloor`, next to
 * the files.
 */
async function enforceFloorOnRealPaths(prepared: PreparedOp): Promise<void> {
  const targets = prepared.newPath ? [prepared.filePath, prepared.newPath] : [prepared.filePath]
  for (const p of targets) {
    const real = await realizeForFloor(p)
    if (real === p) continue  // no symlinked ancestor; already checked in prepare()
    if (isSecretForMutation(real)) throw new FileOpError('forbidden', SECRET_REFUSAL)
    if (isProtectedStatePath(real)) throw new FileOpError('forbidden', 'Path not permitted')
    if (!withinMutateFloor(real)) {
      throw new FileOpError('invalid', `Refusing to change ${p}: it resolves to ${real}`)
    }
  }
}

/** Map a FileContentError from the shared sandbox onto our code vocabulary. */
function fromSandboxError(err: FileContentError): FileOpError {
  return new FileOpError(err.statusCode === 403 ? 'forbidden' : 'invalid', err.message)
}

/** Validated, normalized request — what both execution paths consume. */
interface PreparedOp {
  op: FileOpName
  filePath: string
  newPath?: string
  host?: string
  recursive: boolean
}

function prepare(input: FileOpInput): PreparedOp {
  if (!FILE_OP_NAMES.includes(input.op)) {
    throw new FileOpError('invalid', `Unknown file operation: ${String(input.op)}`)
  }
  const needsTarget = input.op === 'rename' || input.op === 'duplicate'
  const host = typeof input.host === 'string' && input.host.length > 0 ? input.host : undefined

  // Cloud mode refuses EVERYTHING, remote included. assertPathAllowed already
  // blocks local writes there; a remote mutation would execute on the trusted
  // exec host, but the cloud box is a PUBLIC relay and handing a paired device
  // "delete any file on the Mac" has no user-facing purpose worth that blast
  // radius. The Mac (and any self-hosted primary) is where this belongs.
  if (CLOUD_MODE) {
    throw new FileOpError('forbidden', 'Changing files is not available in cloud mode')
  }

  // NUL anywhere makes every fs call throw ERR_INVALID_ARG_VALUE, and it is the
  // classic truncation trick — reject before anything looks at the string.
  for (const raw of [input.path, input.newPath]) {
    if (typeof raw === 'string' && raw.includes('\0')) {
      throw new FileOpError('invalid', 'Invalid path')
    }
  }

  let filePath: string
  let newPath: string | undefined
  try {
    filePath = assertPathAllowed(input.path, host, 'write').filePath
    if (needsTarget) newPath = assertPathAllowed(input.newPath, host, 'write').filePath
  } catch (err) {
    if (err instanceof FileContentError) throw fromSandboxError(err)
    throw err
  }

  for (const p of newPath ? [filePath, newPath] : [filePath]) {
    if (isSecretForMutation(p)) throw new FileOpError('forbidden', SECRET_REFUSAL)
    if (isProtectedStatePath(p)) throw new FileOpError('forbidden', 'Path not permitted')
    if (!withinMutateFloor(p)) {
      throw new FileOpError(
        'invalid',
        `Refusing to change ${p}: a path must be absolute, at least two levels deep, ` +
        'free of "." / ".." segments, and not your home directory',
      )
    }
  }

  if (newPath) {
    const base = path.basename(newPath)
    if (!base) throw new FileOpError('invalid', 'The new name is empty')
    if (Buffer.byteLength(base, 'utf-8') > MAX_NAME_BYTES) {
      throw new FileOpError('invalid', `The new name is too long (max ${MAX_NAME_BYTES} bytes)`)
    }
    // Copying/moving a directory into itself builds an infinite tree (or, for a
    // rename, quietly loses the source). Cheap to check, unbounded to recover.
    if (isInside(filePath, newPath)) {
      throw new FileOpError('invalid', 'The destination is inside the path being moved or copied')
    }
  }

  return { op: input.op, filePath, newPath, host, recursive: input.recursive === true }
}

/** Local (this-host) execution over node's fs. lstat everywhere, never stat: a
 *  symlink must be renamed/deleted as the LINK, never followed to its target. */
async function execLocal(prepared: PreparedOp): Promise<{ path?: string }> {
  const { op, filePath, newPath, recursive } = prepared
  let blame = filePath
  try {
    switch (op) {
      case 'mkdir':
        // recursive:false so an existing directory is an EEXIST the user sees,
        // and a missing parent is a 404 rather than a surprise tree.
        await fsp.mkdir(filePath, { recursive: false })
        return { path: filePath }
      case 'create':
        // 'wx' = create-or-fail. Never truncate a file that is already there.
        await fsp.writeFile(filePath, '', { flag: 'wx' })
        return { path: filePath }
      case 'rename': {
        await fsp.lstat(filePath)
        blame = newPath!
        // KNOWN, ACCEPTED RACE: a concurrent writer can create `newPath` between
        // this check and the rename, which would then replace it. Node exposes no
        // portable atomic no-replace rename (no RENAME_NOREPLACE/renameat2
        // binding, and the link+unlink emulation has per-platform symlink
        // semantics — a worse failure than the one it fixes). The window is
        // microseconds and needs a writer aiming at the same new name. `create`
        // and `mkdir` have NO such window: 'wx' and non-recursive mkdir are
        // atomic, and the kernel itself raises EEXIST.
        await assertAbsent(newPath!)
        await fsp.rename(filePath, newPath!)
        return { path: newPath! }
      }
      case 'duplicate': {
        await fsp.lstat(filePath)
        blame = newPath!
        await assertAbsent(newPath!)
        await fsp.cp(filePath, newPath!, { recursive: true, errorOnExist: true, force: false })
        return { path: newPath! }
      }
      case 'delete': {
        const st = await fsp.lstat(filePath)
        if (st.isDirectory() && !recursive) {
          throw new FileOpError(
            'is_directory',
            `${filePath} is a folder — deleting it removes everything inside`,
          )
        }
        await fsp.rm(filePath, { recursive, force: false })
        return {}
      }
    }
  } catch (err) {
    throw mapErrno(err, blame)
  }
}

/** 409 when something already occupies `target` (lstat: a dangling symlink counts). */
async function assertAbsent(target: string): Promise<void> {
  try {
    await fsp.lstat(target)
  } catch {
    return
  }
  throw new FileOpError('exists', `Already exists: ${target}`)
}

/**
 * Remote execution: ONE daemon RPC per operation, all checks host-side.
 *
 * `slowTimeoutMs` is threaded into the two unbounded ops so the RPC outlives the
 * pending deadline (see REMOTE_SLOW_OP_TIMEOUT_MS).
 */
async function execRemote(
  prepared: PreparedOp,
  deps?: FileOpDeps,
  slowTimeoutMs?: number,
): Promise<{ path?: string }> {
  const { op, filePath, newPath, host, recursive } = prepared
  let blame = filePath
  try {
    const reader = deps?.createReader
      ? await deps.createReader(host!)
      : ((await createFileReader(host!)) as unknown as MutatingFileReader)
    switch (op) {
      case 'mkdir':
        await reader.mkdirExclusive(filePath)
        return { path: filePath }
      case 'create':
        await reader.createEmptyFile(filePath)
        return { path: filePath }
      case 'rename':
        blame = newPath!
        await reader.renamePath(filePath, newPath!)
        return { path: newPath! }
      case 'duplicate':
        blame = newPath!
        await reader.copyPath(filePath, newPath!, slowTimeoutMs)
        return { path: newPath! }
      case 'delete':
        await reader.removePath(filePath, recursive, slowTimeoutMs)
        return {}
    }
  } catch (err) {
    throw mapRemoteError(err, blame)
  }
}

/**
 * The whole operation, minus HTTP. Returns `{ status, body }` for every case the
 * contract names; only a genuinely unexpected failure (an errno absent from the
 * shared table, i.e. a bug) is re-thrown, so the express error handler reports a
 * 500 rather than this module inventing a success or a fake 4xx.
 */
export async function performFileOp(input: FileOpInput, deps?: FileOpDeps): Promise<FileOpResult> {
  try {
    const prepared = prepare(input)
    // The string floor above is not enough on its own: re-check against the paths
    // the kernel will actually reach. Local only — the remote half of this runs in
    // the daemon, which is the only side that can resolve that host's symlinks.
    if (!prepared.host) await enforceFloorOnRealPaths(prepared)
    const context = {
      op: prepared.op,
      path: prepared.filePath,
      newPath: prepared.newPath,
      host: prepared.host,
    }
    const slow = SLOW_OPS.has(prepared.op)
    const work = prepared.host
      ? execRemote(prepared, deps, slow ? REMOTE_SLOW_OP_TIMEOUT_MS : undefined)
      : execLocal(prepared)

    let outcome: { path?: string }
    if (slow || prepared.host) {
      const budget = slow ? (deps?.pendingAfterMs ?? DEFAULT_PENDING_AFTER_MS) : REMOTE_FAST_OP_DEADLINE_MS
      const verdict = await raceDeadline(work, budget)
      if (!verdict.done) {
        // The operation is STILL RUNNING and must be left alone. All we owe is a
        // terminal log line for whoever reads the logs afterwards, since the HTTP
        // response has already committed to "we don't know yet".
        work.then(
          () => log.web.info('file op finished after answering pending', context),
          (err) => log.web.warn('file op finished late with error', {
            ...context,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
        log.web.info('file op still running — answered pending', context)
        return { status: 202, body: { pending: true, message: PENDING_MESSAGE } }
      }
      outcome = verdict.value
    } else {
      outcome = await work
    }
    log.web.info('file op', context)
    return {
      status: 200,
      body: { ok: true, ...(outcome.path !== undefined ? { path: outcome.path } : {}) },
    }
  } catch (err) {
    if (err instanceof FileOpError) {
      return { status: STATUS_BY_CODE[err.code], body: { error: err.message, code: err.code } }
    }
    throw err
  }
}

export const fileOpsRouter = Router()

for (const op of FILE_OP_NAMES) {
  fileOpsRouter.post(`/${op}`, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const result = await performFileOp({
        op,
        path: body.path,
        newPath: body.newPath,
        host: body.host,
        recursive: body.recursive,
      })
      res.status(result.status).json(result.body)
    } catch (err) {
      next(err)
    }
  })
}
