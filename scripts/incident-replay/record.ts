/**
 * Keep a copy of a real CLI stream, privately, for turning into a shape-only fixture later.
 * A developer test utility, not a Walnut feature. It never launches a CLI or a model: it copies a
 * stream file the daemon already wrote (`--from`), or records what is piped into it (`--stdin`,
 * with `--tee` passing it through), into ONE fixed private directory:
 *
 *   ~/.local/state/open-walnut/incident-replays/<name>.jsonl   (directory 0700, file 0600)
 *
 * Not under ~/.open-walnut: that directory can be a git data repo that syncs itself. The raw copy
 * holds the user's real words, so it must never land where git could pick it up: every directory
 * on the way (below home) is created one at a time, each refused when it (resolved) sits inside a
 * git worktree (checked before its child is created; a bare dotfiles repo with `--work-tree=$HOME`
 * has no `.git` to find), is a symlink or is not owned by this user; and the file is created with
 * O_EXCL | O_NOFOLLOW, so an existing file (or a planted symlink) is never written through or
 * overwritten.
 *
 *   bun scripts/incident-replay/record.ts --from ~/.open-walnut/tmp/streams/<sid>.jsonl --name <name>
 *   <producer> | bun scripts/incident-replay/record.ts --stdin --name <name> [--tee]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPLAY_DIR_PARTS = ['.local', 'state', 'open-walnut', 'incident-replays'] as const
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024

export interface RecordOptions {
  /** File name without `.jsonl`: lower-case letters, digits, `.`, `_`, `-`. */
  name: string
  /** Defaults to os.homedir(); tests pass a temp home. */
  home?: string
  /** Refuse (and remove the partial copy) past this size. */
  maxBytes?: number
}

export interface RecordResult { file: string; bytes: number; lines: number }

/** The fixed private directory under `home`. */
export function privateReplayDir(home: string = os.homedir()): string {
  return path.join(home, ...REPLAY_DIR_PARTS)
}

/** The nearest directory at or above `p` that holds a `.git` entry (a repo or a worktree), or null. */
export function enclosingGitWorktree(p: string): string | null {
  let dir = path.resolve(p)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function assertRealOwnDir(dir: string, create: boolean): void {
  let st: fs.Stats | undefined
  try { st = fs.lstatSync(dir) } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (!st) {
    if (!create) throw new Error(`missing directory: ${dir}`)
    fs.mkdirSync(dir, { mode: 0o700 })
    st = fs.lstatSync(dir)
  }
  if (st.isSymbolicLink()) throw new Error(`refusing a symlinked directory: ${dir}`)
  if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`directory not owned by this user: ${dir}`)
}

/**
 * Make sure the private directory exists, is a real 0700 directory of this user, and is outside
 * every git worktree; return the file path `<name>.jsonl` in it (not created yet).
 */
export function prepareDestination(name: string, home: string = os.homedir()): string {
  if (!NAME_RE.test(name)) throw new Error('name must match ' + NAME_RE.source)
  if (!path.isAbsolute(home)) throw new Error('home must be an absolute path')
  const dir = privateReplayDir(home)
  // One component at a time: each parent is checked for a git worktree before its child is
  // created, so a refused path is left exactly as it was.
  let at = home
  for (const part of REPLAY_DIR_PARTS) {
    const repo = enclosingGitWorktree(fs.realpathSync(at))
    if (repo) throw new Error(`refusing a destination inside a git worktree (${repo}): raw streams hold private text`)
    at = path.join(at, part)
    assertRealOwnDir(at, true)
  }
  const repo = enclosingGitWorktree(fs.realpathSync(dir))
  if (repo) throw new Error(`refusing a destination inside a git worktree (${repo}): raw streams hold private text`)
  fs.chmodSync(dir, 0o700)
  return path.join(dir, `${name}.jsonl`)
}

function openExclusive(file: string): number {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  try {
    return fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | (O_NOFOLLOW ?? 0), 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`refusing to overwrite: ${file}`)
    throw err
  }
}

/** Copy into `fd`, counting; on failure remove the file this call created. */
async function writeAll(file: string, chunks: AsyncIterable<Buffer | string> | Iterable<Buffer>, maxBytes: number, tee?: (b: Buffer) => void): Promise<RecordResult> {
  const fd = openExclusive(file)
  let bytes = 0
  let lines = 0
  let last = 0x0a
  try {
    fs.fchmodSync(fd, 0o600)
    for await (const chunk of chunks as AsyncIterable<Buffer | string>) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (buf.length === 0) continue
      bytes += buf.length
      if (bytes > maxBytes) throw new Error(`stream over ${maxBytes} bytes`)
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lines++
      last = buf[buf.length - 1]
      let off = 0
      while (off < buf.length) off += fs.writeSync(fd, buf, off)
      tee?.(buf)
    }
    fs.fsyncSync(fd)
  } catch (err) {
    // Remove the partial copy only if the path is still the file this call created.
    const mine = fs.fstatSync(fd)
    fs.closeSync(fd)
    try {
      const now = fs.lstatSync(file)
      if (now.ino === mine.ino && now.dev === mine.dev) fs.unlinkSync(file)
    } catch { /* already gone */ }
    throw err
  }
  fs.closeSync(fd)
  return { file, bytes, lines: lines + (bytes > 0 && last !== 0x0a ? 1 : 0) }
}

function* readChunks(src: string): Iterable<Buffer> {
  const fd = fs.openSync(src, 'r')
  try {
    const buf = Buffer.alloc(1024 * 1024)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n === 0) return
      yield Buffer.from(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** Copy an already-recorded stream file (read only) into the private directory. */
export async function recordFromFile(src: string, opts: RecordOptions): Promise<RecordResult> {
  const st = fs.statSync(src)
  if (!st.isFile()) throw new Error('source is not a regular file')
  const file = prepareDestination(opts.name, opts.home)
  return writeAll(file, readChunks(src), opts.maxBytes ?? DEFAULT_MAX_BYTES)
}

/** Record a byte stream (stdin) into the private directory; `tee` gets every chunk after it is written. */
export async function recordFromStream(input: AsyncIterable<Buffer | string>, opts: RecordOptions & { tee?: (b: Buffer) => void }): Promise<RecordResult> {
  const file = prepareDestination(opts.name, opts.home)
  return writeAll(file, input, opts.maxBytes ?? DEFAULT_MAX_BYTES, opts.tee)
}

const USAGE = 'usage: bun scripts/incident-replay/record.ts (--from <stream.jsonl> | --stdin [--tee]) --name <name>'

async function main(argv: string[]): Promise<number> {
  const val = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1] }
  const from = val('--from')
  const name = val('--name')
  const stdin = argv.includes('--stdin')
  const tee = argv.includes('--tee')
  if (!name || (!from === !stdin) || (tee && !stdin)) { console.error(USAGE); return 2 }
  try {
    const res = from
      ? await recordFromFile(from, { name })
      : await recordFromStream(process.stdin, { name, ...(tee ? { tee: (b: Buffer) => { process.stdout.write(b) } } : {}) })
    // The summary names the private file only: never its content.
    ;(tee ? console.error : console.log)(JSON.stringify({ recorded: res.file, bytes: res.bytes, lines: res.lines }))
    return 0
  } catch (err) {
    console.error(`record: ${(err as Error).message}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)))
