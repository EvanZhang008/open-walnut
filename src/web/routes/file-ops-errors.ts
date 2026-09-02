/**
 * The error vocabulary for file mutations, plus the ONE errno table both the
 * local and the remote mapper read.
 *
 * Split out of file-ops.ts for a reason that is not file size: the two mappers
 * used to be independent `switch` statements, one over node's `err.code` and one
 * over the `(ERRNO)` tag the daemon appends to its message, and they drifted. A
 * local ENOSPC was a clean 507 while the same failure on a remote host became a
 * generic 502 "could not complete on the remote host" — the same user action
 * reported two different things depending on which machine held the file. The
 * table below is the single source; each mapper only knows how to READ an errno
 * out of its own error shape.
 */

export type FileOpErrorCode =
  | 'invalid'
  | 'forbidden'
  | 'not_found'
  | 'exists'
  | 'is_directory'
  | 'no_space'
  | 'unsupported'
  | 'daemon_needs_upgrade'
  | 'remote'

export const STATUS_BY_CODE: Record<FileOpErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  exists: 409,
  is_directory: 400,
  no_space: 507,
  unsupported: 400,
  daemon_needs_upgrade: 501,
  remote: 502,
}

/** A refusal with a code the UI can switch on. */
export class FileOpError extends Error {
  constructor(public code: FileOpErrorCode, message: string) {
    super(message)
    this.name = 'FileOpError'
  }
}

/** What one errno means, and what to tell the person who asked. */
interface ErrnoRule {
  code: FileOpErrorCode
  /** `target` is the path the USER typed — never a daemon-side absolute path. */
  message: (target: string) => string
}

/** Every `fsp.cp` refusal is the same story: these kinds can't be copied. */
const CANNOT_COPY: ErrnoRule = {
  code: 'unsupported',
  message: (t) => `${t} can't be copied (special file or incompatible kinds)`,
}

/**
 * errno → code + message. Everything here is a condition the USER caused, so
 * none of it may become a 500: a full disk, a cross-device move, a socket in a
 * folder being copied and a read-only mount are all normal facts about a
 * filesystem, and a stack trace teaches the user nothing about any of them.
 *
 * Anything ABSENT is deliberately left to re-throw as a 500 — an unmapped errno
 * is a bug we want to see, not a 4xx we invented.
 */
export const FILE_OP_ERRNO_TABLE: Record<string, ErrnoRule> = {
  ENOENT: { code: 'not_found', message: (t) => `Not found: ${t}` },
  EEXIST: { code: 'exists', message: (t) => `Already exists: ${t}` },
  EISDIR: { code: 'is_directory', message: (t) => `${t} is a directory` },
  ERR_FS_EISDIR: { code: 'is_directory', message: (t) => `${t} is a directory` },
  ENOTEMPTY: { code: 'exists', message: (t) => `${t} is a non-empty folder` },
  EACCES: { code: 'forbidden', message: (t) => `Permission denied: ${t}` },
  EPERM: { code: 'forbidden', message: (t) => `Permission denied: ${t}` },
  EROFS: { code: 'forbidden', message: (t) => `${t} is on a read-only filesystem` },
  ENOTDIR: { code: 'invalid', message: (t) => `A parent of ${t} is not a directory` },
  ELOOP: { code: 'invalid', message: (t) => `${t} has a symlink loop` },
  ENAMETOOLONG: { code: 'invalid', message: () => 'The path is too long' },
  ENOSPC: { code: 'no_space', message: () => 'Not enough disk space' },
  EXDEV: {
    code: 'unsupported',
    message: (t) => `${t} is on a different volume — copy it there instead of moving`,
  },
  ERR_FS_CP_FIFO_PIPE: CANNOT_COPY,
  ERR_FS_CP_SOCKET: CANNOT_COPY,
  ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY: CANNOT_COPY,
  ERR_FS_CP_UNKNOWN: CANNOT_COPY,
  ERR_FS_CP_EINVAL: CANNOT_COPY,
  ERR_FS_CP_DIR_TO_NON_DIR: CANNOT_COPY,
  ERR_FS_CP_NON_DIR_TO_DIR: CANNOT_COPY,
  /** Daemon-only: its own floor/denylist refusal, not a kernel errno. */
  EDENIED: { code: 'forbidden', message: (t) => `Not permitted: ${t}` },
}

/** Node errno → our code, with a message a person can act on. */
export function mapErrno(err: unknown, target: string): FileOpError {
  if (err instanceof FileOpError) return err
  const code = (err as NodeJS.ErrnoException)?.code
  const rule = code ? FILE_OP_ERRNO_TABLE[code] : undefined
  if (!rule) throw err
  return new FileOpError(rule.code, rule.message(target))
}

/**
 * Daemon error text → our code. The daemon tags every refusal with a
 * parenthesized code (`(EEXIST)`, `(EDENIED)`, …) precisely so this mapping
 * doesn't have to guess, and so it survives the node/bun errno differences
 * described in cmdFsRm.
 *
 * The upgrade case is matched by NAME, not `instanceof`: importing
 * daemon-file-reader here would pull daemon-connection into this module's init,
 * and routes must stay cheap to load (CLAUDE.md: never block the web server).
 *
 * A recognised code answers with the table's message and NOTHING else — the
 * daemon's raw text carries that host's absolute paths, which the user never
 * typed and has no business seeing echoed back.
 */
export function mapRemoteError(err: unknown, target: string): FileOpError {
  if (err instanceof FileOpError) return err
  const msg = err instanceof Error ? err.message : String(err)
  if ((err as Error)?.name === 'DaemonNeedsUpgradeError') {
    return new FileOpError('daemon_needs_upgrade', msg)
  }
  // A daemon that predates the whole mutation family answers "unknown command:
  // fs.rm". That is the ONLY honest read of "this daemon is too old", and it is
  // the reason mutateConnection can stop guessing from an unanswered hello.
  if (/unknown command/i.test(msg)) {
    return new FileOpError(
      'daemon_needs_upgrade',
      `The Walnut daemon on that host is too old to change files. It upgrades itself the ` +
      `next time you send a message to a session on that host — try again after that.`,
    )
  }
  for (const [errno, rule] of Object.entries(FILE_OP_ERRNO_TABLE)) {
    if (msg.includes(`(${errno})`)) return new FileOpError(rule.code, rule.message(target))
  }
  // Any other cp-family code the daemon's node/bun runtime may invent.
  if (/\(ERR_FS_CP_[A-Z_]+\)/.test(msg)) {
    return new FileOpError(CANNOT_COPY.code, CANNOT_COPY.message(target))
  }
  return new FileOpError('remote', 'Could not complete on the remote host: ' + msg)
}
