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
 */
import { log } from '../../logging/index.js'
import { daemonStreamPathCandidates } from '../session-reconcile.js'

export interface RecoveredCliSlashCommands {
  /** `slash_commands` minus `terminal_slash_commands`, in the CLI's order. */
  names: string[]
  /** Stream file size the answer was read at — a cache key that changes with every turn. */
  fileSize: number
}

const TAIL_WINDOWS = [1 * 1024 * 1024, 4 * 1024 * 1024]

/** Per-session memo, valid while the stream file has not grown (same fileSize). */
const memo = new Map<string, RecoveredCliSlashCommands>()

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

export async function recoverCliSlashCommandsFromStream(
  sessionId: string,
  host: string | null | undefined,
): Promise<RecoveredCliSlashCommands | null> {
  const { DaemonFileReader } = await import('../daemon-file-reader.js')
  const reader = new DaemonFileReader(host ?? '__local__')

  let streamPath = ''
  let size = -1
  for (const candidate of daemonStreamPathCandidates(sessionId, host)) {
    try {
      const st = await reader.stat(candidate)
      if (st === null) continue
      streamPath = candidate
      size = st.size
      break
    } catch (err) {
      log.session.debug('cli-slash-commands: stream stat failed', {
        sessionId, host: host ?? '__local__', candidate,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (size <= 0) return null

  const cached = memo.get(sessionId)
  if (cached && cached.fileSize === size) return cached

  for (const window of TAIL_WINDOWS) {
    const start = Math.max(0, size - window)
    let content: string
    try {
      const res = await reader.readFileRange(streamPath, start)
      if (res === null) return null
      content = res.content
    } catch (err) {
      log.session.debug('cli-slash-commands: stream tail read failed', {
        sessionId, host: host ?? '__local__',
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
    // A tail window starts mid-line; the backwards scan tolerates the torn
    // first line (JSON.parse fails on it, and it is skipped).
    const names = lastInitSlashCommands(content)
    if (names) {
      const out = { names, fileSize: size }
      memo.set(sessionId, out)
      return out
    }
    if (start === 0) break
  }
  return null
}
