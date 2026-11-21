/**
 * The channel between the daemon and an ACP worker that outlives the daemon ('acp-survive-v1',
 * acpStart `survive`): requests go into a named pipe the worker holds open itself (read and
 * write, so it never reads an end of file when the daemon goes), and the worker's answers and
 * journal notices are appended to a file. A daemon that starts after a restart adopts the worker
 * (acp-daemon.ts startupRepair: its pid and start time from the pid file) and reads the file on
 * from the position the last one had reached (`<sid>.acp-out.pos`); request ids never repeat
 * across daemon lives (`firstRpcId`), so an answer to an earlier daemon's request is told apart
 * and never taken for one of this daemon's. Files per session, beside its journal:
 *   <sid>.acp-in       the named pipe (0600)
 *   <sid>.acp-out      the worker's stdout: one JSON line per answer or notice
 *   <sid>.acp-err      the worker's stderr
 *   <sid>.acp-out.pos  how far the daemon has read the out file (written now and then, async)
 *
 * The worker's side is acp-worker/worker.ts runWorkerMain (`--fifo`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { ChildProcessUse } from './daemon-child-spawn.js'
import { StringDecoder } from 'node:string_decoder'

export interface SurvivePaths { fifo: string; out: string; err: string; pos: string }

export function survivePaths(streamsDir: string, sid: string): SurvivePaths {
  const base = path.join(streamsDir, sid)
  return { fifo: `${base}.acp-in`, out: `${base}.acp-out`, err: `${base}.acp-err`, pos: `${base}.acp-out.pos` }
}

/** The first request id of a daemon life: above every id an earlier life could have used (1000 a ms). */
export function firstRpcId(now = Date.now()): number {
  return now * 1000
}

/**
 * A fresh pipe and empty out and err files for a new worker: the fds its spawn takes (closed by the
 * caller once it started), and this daemon's own end of the pipe (`inFd`, for openSurviveChannel),
 * opened here before the worker can make the pipe write-only. The pipe is 0600 until the worker holds
 * its end; the worker then makes it 0200, as every session's stdin pipe is (daemon startup's
 * ensureOwnerOnlyStorage does the same), so nothing else can read its requests.
 */
export async function prepareSurviveFiles(p: SurvivePaths, use: ChildProcessUse<'execFile'> = {}): Promise<{ outFd: number; errFd: number; inFd: number; close: () => Promise<void> }> {
  for (const f of [p.fifo, p.pos]) { try { await fs.promises.unlink(f) } catch { /* none */ } }
  await new Promise<void>((resolve, reject) => {
    (use.execFile ?? execFile)('mkfifo', ['-m', '600', p.fifo], { timeout: 5_000 }, (err) => (err ? reject(new Error(`mkfifo failed: ${err.message}`)) : resolve()))
  })
  // Read-write so the open never waits for a reader; this side never reads from it. A plain fd
  // (one open, on a worker's start only): openSurviveChannel owns and closes it.
  const inFd = fs.openSync(p.fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK)
  try {
    const out = await fs.promises.open(p.out, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND, 0o600)
    const err = await fs.promises.open(p.err, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND, 0o600)
    return { outFd: out.fd, errFd: err.fd, inFd, close: async () => { await Promise.all([out.close(), err.close()]).catch(() => {}) } }
  } catch (e) {
    try { fs.closeSync(inFd) } catch { /* closed */ }
    throw e
  }
}

export async function removeSurviveFiles(p: SurvivePaths): Promise<void> {
  for (const f of [p.fifo, p.out, p.err, p.pos]) { try { await fs.promises.unlink(f) } catch { /* gone */ } }
}

export async function readSavedPos(p: SurvivePaths): Promise<number> {
  try {
    const n = Number((await fs.promises.readFile(p.pos, 'utf8')).trim())
    return Number.isInteger(n) && n >= 0 ? n : 0
  } catch { return 0 }
}

export interface SurviveChannel {
  /** Queue one request line; `done` gets an error when it could not be written. */
  write(line: string, done?: (err?: Error) => void): void
  /** Read what the out file has now (the worker exited: its last lines). */
  drain(): Promise<void>
  close(): void
  /** How far the out file was read. */
  pos(): number
}

const POLL_MS = 200
const SAVE_MS = 1_000
const WRITE_RETRY_MS = 5
const WRITE_GIVE_UP_MS = 30_000

/**
 * Opens the channel of a worker: the pipe for requests (a request waits in the pipe until the worker
 * reads it), and the out
 * file followed from `from`. `adopted`: a daemon took the worker over, so a request the last one
 * may have left half written is ended first (one bare newline: the worker answers it as a line it
 * cannot read, id -1, and the next request starts clean).
 */
export function openSurviveChannel(p: SurvivePaths, o: { from: number; adopted: boolean; fd?: number; onLine: (line: string) => void; log: (level: string, msg: string, data?: Record<string, unknown>) => void }): SurviveChannel {
  // A new worker's end was opened before it started (prepareSurviveFiles); an adopted one's pipe is
  // write-only by now (0200), and the worker holds its read end, so this end opens write-only at once
  // (ENXIO: no reader, the worker is gone).
  const fd = o.fd ?? fs.openSync(p.fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
  let closed = false
  let at = o.from
  let carry = ''
  let decoder = new StringDecoder('utf8')
  let reading = false
  let again = false
  let savedAt = at
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    if (saveTimer || closed) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (at === savedAt) return
      const v = at
      void fs.promises.writeFile(p.pos, String(v), { mode: 0o600 }).then(() => { savedAt = v }, () => {})
    }, SAVE_MS)
    saveTimer.unref?.()
  }
  const read = async (): Promise<void> => {
    if (reading) { again = true; return }
    reading = true
    try {
      do {
        again = false
        let fh: fs.promises.FileHandle | null = null
        try {
          fh = await fs.promises.open(p.out, 'r')
          const size = (await fh.stat()).size
          if (size < at) { at = 0; carry = ''; decoder = new StringDecoder('utf8') } // a new worker truncated it
          while (at < size) {
            const len = Math.min(size - at, 1 << 20)
            const buf = Buffer.alloc(len)
            const { bytesRead } = await fh.read(buf, 0, len, at)
            if (bytesRead <= 0) break
            at += bytesRead
            const lines = (carry + decoder.write(buf.subarray(0, bytesRead))).split('\n')
            carry = lines.pop() ?? ''
            for (const line of lines) if (line.trim()) { try { o.onLine(line) } catch (err) { o.log('warn', 'acp: survive line handler failed', { error: String(err) }) } }
          }
        } catch { /* gone: the worker is being reaped */ } finally { await fh?.close().catch(() => {}) }
        save()
      } while (again && !closed)
    } finally { reading = false }
  }
  let watcher: fs.FSWatcher | null = null
  try { watcher = fs.watch(p.out, () => { void read() }); watcher.on('error', () => {}) } catch { /* the poll reads it */ }
  const poll = setInterval(() => { void read() }, POLL_MS)
  poll.unref?.()
  void read()

  // One writer, in order: a request longer than the pipe holds goes in pieces, none interleaved.
  let queue: Promise<void> = Promise.resolve()
  const writeAll = async (buf: Buffer): Promise<void> => {
    let off = 0
    const until = Date.now() + WRITE_GIVE_UP_MS
    while (off < buf.length) {
      if (closed) throw new Error('the worker channel is closed')
      try {
        const n = fs.writeSync(fd, buf, off, buf.length - off)
        off += n
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') throw err
        if (Date.now() > until) throw new Error('the worker has not read its requests for 30 s')
        await new Promise((r) => setTimeout(r, WRITE_RETRY_MS))
      }
    }
  }
  const write = (line: string, done?: (err?: Error) => void) => {
    const buf = Buffer.from(line.endsWith('\n') ? line : line + '\n')
    queue = queue.then(() => writeAll(buf)).then(() => done?.(), (err: Error) => done?.(err))
  }
  if (o.adopted) write('\n')
  return {
    write,
    drain: () => read(),
    pos: () => at,
    close: () => {
      if (closed) return
      closed = true
      clearInterval(poll)
      watcher?.close()
      if (saveTimer) clearTimeout(saveTimer)
      try { fs.closeSync(fd) } catch { /* closed */ }
    },
  }
}
