/**
 * The files a session's CLI is started on (startSessionProcess in daemon-standalone.ts): its stdin
 * FIFO, its output stream (the jsonl the tailer reads) and its stderr log, opened as the three
 * descriptors the CLI inherits. Every step is asynchronous: inside a server's own process
 * (experiment in_process_daemon) a slow disk holds this one start, never every other session.
 *
 * The rules each step keeps (they were the daemon's inline code, unchanged):
 *   - the FIFO is made anew (`mkfifo -m 600`) and opened O_RDWR, so an open never waits for a
 *     reader; then made write-only for everyone else (lockFifo, LIVE_FIFO_MODE in daemon-core.ts);
 *   - a fresh start unlinks and recreates the stream (a NEW inode, so a new stream epoch), never
 *     truncates it in place;
 *   - the stream is opened O_APPEND: the daemon appends its own marker lines to it as well;
 *   - a resume touches the stream, so health checks see a fresh mtime;
 *   - the stream and the stderr log are 0600 (STREAM_FILE_MODE) whatever the process's umask
 *     (inside a server's process it is the server's, usually 022): every open that can create one
 *     passes the mode, and a fresh start sets it on both (the stream was just made anew, a
 *     stderr log left by an older run may be wider).
 * A step that fails gives back what the steps before it opened.
 */
import type fsType from 'node:fs'
import { promisify } from 'node:util'

type Fs = typeof fsType
type ExecFile = (file: string, args: string[], options: { timeout: number }, callback: (error: Error | null) => void) => unknown

export interface SpawnFilesDeps {
  fs: Fs
  execFile: ExecFile
  /** Makes the FIFO write-only for every reader but the CLI's descriptor; false when it could not. */
  lockFifo(pipePath: string): boolean
  /** A fresh start's stream has no fold checkpoint any more. */
  discardCheckpoint(jsonlPath: string): void
  warn(msg: string, data: Record<string, unknown>): void
}

export interface SpawnFilesRequest {
  sid: string
  pipePath: string
  jsonlPath: string
  stderrPath: string
  resume: boolean
  /** Throws when the start was overtaken meanwhile (a stop, a newer request). */
  checkCurrent(): void
}

export interface SessionSpawnFiles {
  pipeFd: number
  outputFd: number
  stderrFd: number
  /** The stream's size when the CLI starts writing (where this process's output begins). */
  cronStartOffset: number
  stderrStartOffset: number
  /** Closes the three descriptors (the CLI holds its own copies once spawned). */
  closeAll(): void
}

export const MKFIFO_TIMEOUT_MS = 10_000
/** The stream's and the stderr log's mode. */
export const STREAM_FILE_MODE = 0o600

export async function prepareSpawnFiles(deps: SpawnFilesDeps, req: SpawnFilesRequest): Promise<SessionSpawnFiles> {
  const { fs } = deps
  const openWithMode = promisify(fs.open) as (file: string, flags: string | number, mode: number) => Promise<number>
  // A file this creates is private from its first byte, whatever the umask.
  const open = (file: string, flags: string | number) => openWithMode(file, flags, STREAM_FILE_MODE)
  const fchmod = promisify(fs.fchmod) as (fd: number, mode: number) => Promise<void>
  const fstat = promisify(fs.fstat) as (fd: number) => Promise<{ size: number }>
  const opened: number[] = []
  const closeOpened = () => { for (const fd of opened.splice(0)) { try { fs.closeSync(fd) } catch { /* already closed */ } } }

  await fs.promises.unlink(req.pipePath).catch(() => {})
  try {
    await new Promise<void>((resolve, reject) => {
      deps.execFile('mkfifo', ['-m', '600', req.pipePath], { timeout: MKFIFO_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    throw new Error('mkfifo failed: ' + (err instanceof Error ? err.message : String(err)))
  }
  req.checkCurrent()

  try {
    const pipeFd = await open(req.pipePath, fs.constants.O_RDWR)
    opened.push(pipeFd)
    if (!deps.lockFifo(req.pipePath)) deps.warn('spawn: could not make the stdin FIFO write-only', { sid: req.sid })
    if (!req.resume) {
      await fs.promises.unlink(req.jsonlPath).catch(() => {})
      deps.discardCheckpoint(req.jsonlPath)
      await fs.promises.writeFile(req.jsonlPath, '').catch(() => {})
    }
    const outputFd = await open(req.jsonlPath, 'a')
    opened.push(outputFd)
    const cronStartOffset = (await fstat(outputFd)).size
    const stderrFd = await open(req.stderrPath, req.resume ? 'a' : 'w')
    opened.push(stderrFd)
    if (!req.resume) {
      for (const fd of [outputFd, stderrFd]) {
        await fchmod(fd, STREAM_FILE_MODE).catch((err: unknown) => deps.warn('spawn: could not make a stream file private', { sid: req.sid, error: String(err) }))
      }
    }
    const stderrStartOffset = (await fstat(stderrFd)).size
    if (req.resume) {
      const now = new Date()
      await fs.promises.utimes(req.jsonlPath, now, now).catch(() => {})
    }
    return { pipeFd, outputFd, stderrFd, cronStartOffset, stderrStartOffset, closeAll: closeOpened }
  } catch (err) {
    closeOpened()
    throw err
  }
}
