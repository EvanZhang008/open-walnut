/**
 * Recover the CLI's latest advertised slash commands from a session's STREAM
 * file when this server process has not seen an init line for it.
 *
 * When that happens: after a server restart the reattach subscribes future-only
 * (history is never replayed into the UI), so every live session's in-memory
 * capture is gone until its CLI starts another turn. Deploys are frequent here,
 * so without this the palette fell back to the SSH directory scan for every
 * session until the user's next message.
 *
 * The CLI emits an init at the start of EVERY turn, so the newest one is close
 * to the end of the stream. Read a bounded tail through the daemon (host-local
 * file, one stat + one range read — never the whole file: a whale stream is tens
 * of MB) and take the LAST init line that carries `slash_commands`. A turn
 * longer than the window means "not found", and the caller falls back to
 * discovery — the same answer it had before this module existed.
 *
 * A stream that grew since the last look is read only from where that look
 * stopped (the end of its last whole line): the newest init is either in the
 * appended bytes or the one already known. A session mid-turn grows its
 * stream every second, so a memo keyed by size alone missed on every palette
 * open and read the 1 MB tail again, and the 4 MB one when the turn's init was
 * further back, over the host's link (2026-11-25: palette reads of 7 to 15 s
 * on a remote host after a deploy).
 *
 * The looks outlive a restart (streamLooksKept, written with the palette's caches by
 * web/routes/slash-commands-disk.ts), so the first palette after a deploy reads only what the
 * stream gained since. One read back is trusted only for the same file incarnation: it must
 * carry the daemon's epoch, equal the epoch the stat gives now, and the file must not be shorter
 * than where the look stopped; anything else reads the tail as on a first look.
 */
import { log } from '../../logging/index.js'
import type { KeptSection } from '../kept-cache-file.js'
import { daemonStreamPathCandidates } from '../session-reconcile.js'
import type { DaemonFileReader } from '../daemon-file-reader.js'

export interface RecoveredCliSlashCommands {
  /** `slash_commands` minus `terminal_slash_commands`, in the CLI's order. */
  names: string[]
  /** Stream file size the answer was read at — a cache key that changes with every turn. */
  fileSize: number
}

const TAIL_WINDOWS = [1 * 1024 * 1024, 4 * 1024 * 1024]
const MAX_WINDOW = TAIL_WINDOWS[TAIL_WINDOWS.length - 1]

/** What the last look at a session's stream found, and how far it read. */
interface StreamLook {
  path: string
  /** The file's incarnation (fs.stat epoch): a new file is read again from its tail. */
  epoch?: string
  /** Stream size at the look. */
  fileSize: number
  /** Byte offset just past the last whole line read: the next look starts here. */
  scannedTo: number
  /** The newest init's names up to `scannedTo`, or null when none was in reach. */
  names: string[] | null
}

/** Per-session memo, kept while the stream file is the same incarnation; the least recent go first past the cap. */
const memo = new Map<string, StreamLook>()
const MAX_LOOKS = 512
/** At most this many looks are written to disk, the most recent. */
const MAX_KEPT_LOOKS = 256
/** The looks a previous process kept, being read back (a recovery waits for them). */
let restoring: Promise<void> | null = null
let lookChanged: (() => void) | null = null

function remember(sessionId: string, look: StreamLook): void {
  memo.delete(sessionId)
  memo.set(sessionId, look)
  while (memo.size > MAX_LOOKS) memo.delete(memo.keys().next().value as string)
  lookChanged?.()
}

function isStreamLook(v: unknown): v is StreamLook {
  if (!v || typeof v !== 'object') return false
  const l = v as Partial<StreamLook>
  return typeof l.path === 'string' && typeof l.epoch === 'string'
    && typeof l.fileSize === 'number' && typeof l.scannedTo === 'number' && l.scannedTo >= 0 && l.scannedTo <= l.fileSize
    && (l.names === null || (Array.isArray(l.names) && l.names.every((n) => typeof n === 'string')))
}

/** The stream looks as a part of the palette's kept file (web/routes/slash-commands-disk.ts). */
export const streamLooksKept: KeptSection = {
  forDisk: () => [...memo].slice(-MAX_KEPT_LOOKS),
  restore(data) {
    const work = data.then((rows) => {
      if (!Array.isArray(rows)) return
      // Read back first in the order (older than every look this process took), then this process's.
      const mine = [...memo]
      memo.clear()
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2) continue
        const [sessionId, look] = row as [unknown, unknown]
        // A look with no epoch cannot prove it is the same file.
        if (typeof sessionId !== 'string' || !isStreamLook(look)) continue
        memo.set(sessionId, { path: look.path, epoch: look.epoch, fileSize: look.fileSize, scannedTo: look.scannedTo, names: look.names })
      }
      for (const [sessionId, look] of mine) { memo.delete(sessionId); memo.set(sessionId, look) }
      while (memo.size > MAX_LOOKS) memo.delete(memo.keys().next().value as string)
    }, () => undefined)
    const r = work.finally(() => { if (restoring === r) restoring = null })
    restoring = r
    return r
  },
  onChange(changed) { lookChanged = changed },
}

/** Test seam: forget every look (a new process). */
export function _resetStreamLooksForTesting(): void {
  memo.clear()
  restoring = null
  lookChanged = null
}

/** Pure: the last init line in `content` that advertises commands, or null. */
export function lastInitSlashCommands(content: string): string[] | null {
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"subtype":"init"') || !line.includes('"slash_commands"')) continue
    try {
      const parsed = JSON.parse(line) as { type?: string; subtype?: string; slash_commands?: unknown; terminal_slash_commands?: unknown }
      if (parsed.type !== 'system' || parsed.subtype !== 'init' || !Array.isArray(parsed.slash_commands)) continue
      const terminal = new Set(Array.isArray(parsed.terminal_slash_commands) ? parsed.terminal_slash_commands : [])
      return parsed.slash_commands.filter((n): n is string => typeof n === 'string' && n.length > 0 && !terminal.has(n))
    } catch {
      // torn or foreign line — keep scanning backwards
    }
  }
  return null
}

/** [start, EOF) read once: the newest init in its whole lines, and where they end. */
async function readWholeLines(
  reader: DaemonFileReader, streamPath: string, start: number, sessionId: string, host: string,
): Promise<{ names: string[] | null; scannedTo: number } | null> {
  let buf: Buffer
  try {
    const res = await reader.readFileRangeBuffer(streamPath, start)
    if (res === null) return null
    buf = res.buf
  } catch (err) {
    log.session.debug('cli-slash-commands: stream tail read failed', {
      sessionId, host, error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  // Only whole lines count: a line still being written is read whole next time.
  // A read that starts mid-line (a tail window) tears its first line, which the
  // backwards scan skips.
  const end = buf.lastIndexOf(0x0a) + 1
  return { names: lastInitSlashCommands(buf.toString('utf-8', 0, end)), scannedTo: start + end }
}

export async function recoverCliSlashCommandsFromStream(
  sessionId: string,
  host: string | null | undefined,
): Promise<RecoveredCliSlashCommands | null> {
  const { DaemonFileReader } = await import('../daemon-file-reader.js')
  const hostName = host ?? '__local__'
  const reader = new DaemonFileReader(hostName)
  if (restoring) await restoring
  const prev = memo.get(sessionId)

  let streamPath = ''
  let size = -1
  let epoch: string | undefined
  const candidates = daemonStreamPathCandidates(sessionId, host)
  // The file found last time is asked first (each stat is a round trip).
  const ordered = prev && candidates.includes(prev.path) ? [prev.path, ...candidates.filter((c) => c !== prev.path)] : candidates
  for (const candidate of ordered) {
    try {
      const st = await reader.stat(candidate)
      if (st === null) continue
      streamPath = candidate
      size = st.size
      epoch = st.epoch
      break
    } catch (err) {
      log.session.debug('cli-slash-commands: stream stat failed', {
        sessionId, host: hostName, candidate,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (size <= 0) return null

  const answer = (look: StreamLook): RecoveredCliSlashCommands | null =>
    look.names ? { names: look.names, fileSize: look.fileSize } : null
  const keep = (look: StreamLook): RecoveredCliSlashCommands | null => {
    remember(sessionId, look)
    return answer(look)
  }

  const same = prev !== undefined && prev.path === streamPath && prev.epoch === epoch && size >= prev.scannedTo
  if (same && size === prev.fileSize) return answer(prev)
  if (same && size - prev.scannedTo <= MAX_WINDOW) {
    // Only what was appended since the last look.
    const delta = await readWholeLines(reader, streamPath, prev.scannedTo, sessionId, hostName)
    if (delta === null) return answer(prev)
    return keep({ ...prev, fileSize: size, scannedTo: delta.scannedTo, names: delta.names ?? prev.names })
  }

  // First look, a new file, or one that grew past the widest window: the tail.
  let look: StreamLook | null = null
  for (const window of TAIL_WINDOWS) {
    const start = Math.max(0, size - window)
    const read = await readWholeLines(reader, streamPath, start, sessionId, hostName)
    if (read === null) return null
    look = { path: streamPath, epoch, fileSize: size, scannedTo: read.scannedTo, names: read.names }
    if (read.names || start === 0) break
  }
  if (!look) return null
  // Nothing in reach of a file that grew past the window: the names known
  // before still stand rather than none.
  if (!look.names && same) look.names = prev.names
  return keep(look)
}
