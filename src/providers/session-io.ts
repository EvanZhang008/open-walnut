/**
 * SessionIO — I/O abstraction for Claude Code sessions.
 *
 * LocalIO handles the local FIFO + JSONL pattern:
 *   FIFO (named pipe) → claude stdin   (write path)
 *   claude stdout → JSONL file          (read path)
 *
 * Remote sessions use RemoteSessionManager (WebSocket via DaemonConnection)
 * instead of the legacy SSH-based RemoteIO.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { JsonlTailer } from '../core/jsonl-tailer.js'
import { SESSION_STREAMS_DIR } from '../constants.js'
import { log } from '../logging/index.js'

// ── SessionIO interface ──

export interface SessionIO {
  /**
   * Write a stream-json message to the session's stdin FIFO.
   * Returns true on success, false if the pipe is broken / unavailable.
   */
  write(message: string): Promise<boolean>

  /**
   * Write a raw JSON string to the session's stdin FIFO (no wrapping).
   * Used for control_response messages (permission-prompt-tool protocol).
   */
  writeRaw(json: string): Promise<boolean>

  /**
   * Start tailing the JSONL output file, calling onLine for each new line.
   * @param fromOffset — byte offset to start reading from (0 = replay all)
   */
  startTail(onLine: (line: string) => void, fromOffset?: number): void

  /** Stop tailing (but don't delete files). */
  stopTail(): void

  /** Flush remaining buffered data from the tailer (call when process exits). */
  flushTail(): void

  /** Current byte offset in the JSONL file (for resumption). */
  readonly tailOffset: number

  /** The JSONL output file path (for health monitoring, file renaming, etc.) */
  readonly outputFile: string

  /** Process name used for liveness checks ('claude' for local sessions). */
  readonly processName: string

  /** Whether this IO has an active write pipe (FIFO exists and is usable). */
  readonly hasPipe: boolean

  /** Current size of the output file in bytes. */
  readonly fileSize: number

  /**
   * Rename output + pipe files to use the real Claude session ID.
   * Called when the system init event arrives with the actual session_id.
   */
  renameForSession(sessionId: string): void

  /**
   * Try to recover the FIFO pipe from a previous server instance.
   * Used by attachToExisting() — if a named FIFO with the session ID exists
   * on disk, reclaim it for writing.
   */
  recoverPipe(sessionId: string): void

  /** Clean up FIFO pipe (but not the JSONL file). */
  deletePipe(): void

  /** Full cleanup — delete pipe and output files. */
  cleanup(): Promise<void>
}

// ── LocalIO ──

/**
 * Local filesystem I/O for sessions running on this machine.
 * FIFO and JSONL files live in SESSION_STREAMS_DIR.
 */
export class LocalIO implements SessionIO {
  private pipePath: string | null = null
  private tailer: JsonlTailer | null = null
  private _outputFile: string
  private _onLine: ((line: string) => void) | null = null

  readonly processName = 'claude'

  constructor(tmpId: string, outputFileOverride?: string) {
    this._outputFile = outputFileOverride ?? path.join(SESSION_STREAMS_DIR, `${tmpId}.jsonl`)
  }

  get outputFile(): string {
    return this._outputFile
  }

  get hasPipe(): boolean {
    return this.pipePath !== null
  }

  get tailOffset(): number {
    return this.tailer?.currentOffset ?? 0
  }

  get fileSize(): number {
    try { return fs.statSync(this._outputFile).size } catch { return 0 }
  }

  /**
   * Create a named FIFO and spawn the local claude process.
   * Returns { pipeFd, outputFd, stderrFd } for the caller to wire into spawn().
   *
   * @param append — when true, open the output file in append mode instead of truncating.
   *   Used for session resumes to preserve previous turns' JSONL data.
   */
  createFiles(append = false): { pipePath: string; pipeFd: number; outputFd: number; stderrFd: number } {
    fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })

    const tmpId = path.basename(this._outputFile, '.jsonl')
    const pipeTmpPath = path.join(SESSION_STREAMS_DIR, `${tmpId}.pipe`)

    // Clean up stale FIFO
    try { fs.unlinkSync(pipeTmpPath) } catch { /* doesn't exist */ }
    execFileSync('mkfifo', [pipeTmpPath])

    // Open FIFO with O_RDWR so the child holds both ends (prevents EOF
    // when all external writers close — the child is its own writer).
    const pipeFd = fs.openSync(pipeTmpPath, fs.constants.O_RDWR)
    this.pipePath = pipeTmpPath

    const outputFd = fs.openSync(this._outputFile, append ? 'a' : 'w')
    const stderrFd = fs.openSync(this._outputFile + '.err', append ? 'a' : 'w')

    // Touch the output file so health monitor sees a fresh mtime on resume.
    // Opening in append mode doesn't update mtime — the health monitor would
    // see the old mtime from the previous turn and kill the just-spawned process.
    if (append) {
      const now = new Date()
      try { fs.utimesSync(this._outputFile, now, now) } catch (e) {
        log.session.warn('failed to touch output file mtime on resume', { file: this._outputFile, error: String(e) })
      }
    }

    log.session.debug('LocalIO: files created', {
      pipePath: pipeTmpPath,
      outputFile: this._outputFile,
      append,
    })

    return { pipePath: pipeTmpPath, pipeFd, outputFd, stderrFd }
  }

  /**
   * Write the initial message to the FIFO and close the parent's fd.
   * Must be called immediately after spawn() with the pipeFd.
   *
   * For large messages (e.g. plan execution ~50KB), a synchronous writeSync
   * on the parent's O_RDWR fd would deadlock the event loop because the macOS
   * pipe buffer is only 16KB and the child hasn't started reading yet.
   * Instead, we close the parent's fd first, then write via a NEW fd opened
   * with O_NONBLOCK + async retry, identical to the regular write() path.
   */
  async writeInitialMessage(pipeFd: number, message: string): Promise<void> {
    // Close the parent's O_RDWR fd — the child inherited its own copy via spawn stdio.
    // This must happen before we open a new O_WRONLY fd (FIFO semantics: writer blocks
    // on O_WRONLY open if no reader exists; the child's inherited fd IS the reader).
    fs.closeSync(pipeFd)

    if (!this.pipePath) {
      log.session.warn('LocalIO: writeInitialMessage skipped — no pipePath after close')
      return
    }

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    })
    const buf = Buffer.from(payload + '\n')

    try {
      // O_NONBLOCK prevents event-loop deadlock when payload > pipe buffer (16KB on macOS).
      // O_WRONLY is correct here — the child process is the reader.
      const fd = fs.openSync(this.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      try {
        let offset = 0
        const deadline = Date.now() + 30_000 // 30s generous deadline for large plans
        while (offset < buf.length) {
          try {
            const written = fs.writeSync(fd, buf, offset)
            if (written === 0) break
            offset += written
          } catch (err: any) {
            if (err.code === 'EAGAIN' && Date.now() < deadline) {
              // Pipe buffer full — child hasn't drained yet. Yield to event loop.
              await new Promise(r => setTimeout(r, 10))
              continue
            }
            throw err
          }
        }
        if (offset < buf.length) {
          log.session.warn('LocalIO: writeInitialMessage incomplete', {
            written: offset, total: buf.length, pipePath: this.pipePath,
          })
        } else {
          log.session.debug('LocalIO: initial message written to FIFO', {
            messageLength: message.length, payloadBytes: buf.length,
          })
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err
        ? (err as { code: string }).code : undefined
      log.session.error('LocalIO: writeInitialMessage failed', {
        pipePath: this.pipePath, error: err instanceof Error ? err.message : String(err), code,
      })
    }
  }

  async write(message: string): Promise<boolean> {
    if (!this.pipePath) {
      log.session.debug('LocalIO write skipped: no pipe', { messageLength: message.length })
      return false
    }
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    })
    const buf = Buffer.from(payload + '\n')
    try {
      const fd = fs.openSync(this.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      try {
        let offset = 0
        const deadline = Date.now() + 10_000
        while (offset < buf.length) {
          try {
            const written = fs.writeSync(fd, buf, offset)
            if (written === 0) break  // no progress
            offset += written
          } catch (err: any) {
            if (err.code === 'EAGAIN' && Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 50))
              continue
            }
            throw err
          }
        }
        if (offset < buf.length) {
          log.session.warn('LocalIO write: incomplete after timeout', {
            pipePath: this.pipePath, written: offset, total: buf.length,
          })
          return false
        }
      } finally {
        fs.closeSync(fd)
      }
      log.session.debug('LocalIO write ok', { pipePath: this.pipePath, messageLength: message.length })
      return true
    } catch (err) {
      // ENXIO = no reader, EAGAIN = pipe buffer full, EPIPE = broken pipe
      const code = err && typeof err === 'object' && 'code' in err
        ? (err as { code: string }).code : undefined
      if (code === 'ENXIO' || code === 'EAGAIN') {
        log.session.debug('LocalIO write: pipe not ready', { pipePath: this.pipePath, code })
      } else {
        log.session.warn('LocalIO write failed — pipe broken, clearing', {
          pipePath: this.pipePath,
          messageLength: message.length,
          error: err instanceof Error ? err.message : String(err),
          code,
        })
        this.pipePath = null
      }
      return false
    }
  }

  /**
   * Write raw JSON to the FIFO without wrapping in { type: 'user', message }.
   * Used for control_response messages (--permission-prompt-tool stdio protocol).
   */
  async writeRaw(json: string): Promise<boolean> {
    if (!this.pipePath) {
      log.session.debug('LocalIO writeRaw skipped: no pipe', { jsonLength: json.length })
      return false
    }
    const buf = Buffer.from(json + '\n')
    try {
      // O_NONBLOCK prevents event-loop deadlock: without it, opening a FIFO with O_WRONLY
      // blocks until a reader is attached. If Claude Code isn't draining the pipe, Node.js hangs.
      const fd = fs.openSync(this.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      try {
        let offset = 0
        const deadline = Date.now() + 10_000
        while (offset < buf.length) {
          try {
            const written = fs.writeSync(fd, buf, offset)
            if (written === 0) break
            offset += written
          } catch (err: any) {
            if (err.code === 'EAGAIN' && Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 50))
              continue
            }
            throw err
          }
        }
        if (offset < buf.length) {
          log.session.warn('LocalIO writeRaw: incomplete after timeout', {
            pipePath: this.pipePath, written: offset, total: buf.length,
          })
          return false
        }
      } finally {
        fs.closeSync(fd)
      }
      log.session.debug('LocalIO writeRaw ok', { pipePath: this.pipePath, jsonLength: json.length })
      return true
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err
        ? (err as { code: string }).code : undefined
      if (code === 'ENXIO' || code === 'EAGAIN') {
        log.session.debug('LocalIO writeRaw: pipe not ready', { pipePath: this.pipePath, code })
      } else {
        log.session.warn('LocalIO writeRaw failed — pipe broken, clearing', {
          pipePath: this.pipePath, jsonLength: json.length,
          error: err instanceof Error ? err.message : String(err), code,
        })
        this.pipePath = null
      }
      return false
    }
  }

  startTail(onLine: (line: string) => void, fromOffset?: number): void {
    this._onLine = onLine
    this.tailer = new JsonlTailer(this._outputFile, onLine)
    this.tailer.start(fromOffset)
  }

  stopTail(): void {
    if (this.tailer) {
      this.tailer.stop()
      this.tailer = null
    }
  }

  flushTail(): void {
    if (this.tailer) {
      this.tailer.flush()
    }
  }

  renameForSession(sessionId: string): void {
    // Rename JSONL output file
    const oldOutput = this._outputFile
    if (!oldOutput.includes(sessionId)) {
      const newPath = path.join(path.dirname(oldOutput), `${sessionId}.jsonl`)
      try {
        fs.renameSync(oldOutput, newPath)
        try { fs.renameSync(oldOutput + '.err', newPath + '.err') } catch { /* ignore */ }
        this._outputFile = newPath

        // Restart tailer on the new file path (preserving offset)
        if (this.tailer && this._onLine) {
          const offset = this.tailer.currentOffset
          this.tailer.stop()
          this.tailer = new JsonlTailer(newPath, this._onLine)
          this.tailer.start(offset)
        }

        log.session.debug('LocalIO: renamed output file', { from: oldOutput, to: newPath })
      } catch (err) {
        log.session.debug('LocalIO: failed to rename output file', {
          from: oldOutput, to: newPath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Rename FIFO pipe
    if (this.pipePath && !this.pipePath.includes(sessionId)) {
      const newPipePath = path.join(SESSION_STREAMS_DIR, `${sessionId}.pipe`)
      try {
        try { fs.unlinkSync(newPipePath) } catch { /* doesn't exist */ }
        fs.renameSync(this.pipePath, newPipePath)
        this.pipePath = newPipePath
        log.session.debug('LocalIO: renamed FIFO', { to: newPipePath })
      } catch {
        // Rename failed — keep using the temp name
      }
    }
  }

  recoverPipe(sessionId: string): void {
    // Use the outputFile's directory (not SESSION_STREAMS_DIR) — after server restart
    // the constant may point to a different dir than where the session was created.
    const streamsDir = path.dirname(this._outputFile)
    const candidatePipe = path.join(streamsDir, `${sessionId}.pipe`)
    try {
      const stat = fs.statSync(candidatePipe)
      if (stat.isFIFO()) {
        this.pipePath = candidatePipe
        log.session.debug('LocalIO: recovered FIFO pipe', { pipePath: candidatePipe, sessionId })
      } else {
        log.session.debug('LocalIO: candidate pipe is not a FIFO', { pipePath: candidatePipe, sessionId })
      }
    } catch {
      log.session.debug('LocalIO: no FIFO found for recovery', { pipePath: candidatePipe, sessionId })
    }
  }

  deletePipe(): void {
    if (this.pipePath) {
      log.session.debug('LocalIO: deleting FIFO', { pipePath: this.pipePath })
      try { fs.unlinkSync(this.pipePath) } catch { /* doesn't exist */ }
      this.pipePath = null
    }
  }

  async cleanup(): Promise<void> {
    this.deletePipe()
    try { await fsp.unlink(this._outputFile) } catch { /* ignore */ }
    try { await fsp.unlink(this._outputFile + '.err') } catch { /* ignore */ }
  }
}

// ── SSH target + remote shell helpers ──

/** SSH connection target resolved from config.hosts */
export interface SshTarget {
  hostname: string
  user?: string
  port?: number
  /** Optional shell snippet run before claude (e.g. nvm/fnm/volta setup). */
  shell_setup?: string
}

/**
 * Shell-quote a string for safe embedding in a remote sh command.
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Base PATH setup + node auto-discovery for remote SSH commands.
 *
 * Non-interactive SSH doesn't load shell profiles, so node version managers
 * (nvm, fnm, volta, asdf) aren't activated. This preamble auto-detects them.
 *
 * Guard: if `node` is already in PATH, the entire if-block is skipped (zero overhead).
 * Order: nvm (most popular) > fnm > volta > asdf/mise.
 */
export const REMOTE_BASE_PATH = [
  // Source RC files FIRST, then add our paths — RC files may hard-reset PATH
  // (e.g. zsh `export PATH=; path=(...)`) which would clobber earlier prepends.
  //
  // Source the user's shell RC file to get their full environment (nvm, pyenv,
  // conda, rbenv, etc.) — just like their interactive terminal/tmux session.
  //
  // Why: `$SHELL -lc` only sources .zprofile/.profile, NOT .bashrc/.zshrc.
  // Most tools (nvm, pyenv, conda) are configured in .bashrc/.zshrc.
  // Explicitly sourcing the RC file fills this gap.
  //
  // Why not `-i` flag? Interactive mode causes plugins (oh-my-zsh, iTerm2,
  // p10k) to write escape codes to STDOUT, corrupting our JSONL stream.
  //
  // Match RC file to $SHELL: zsh sources .zshrc, bash sources .bashrc.
  // Redirect >/dev/null 2>&1: suppress all output from interactive plugins
  // while preserving PATH/env changes (process-level, not stdout-level).
  //
  // Note: some RC files have interactive guards ([[ $- != *i* ]] && return)
  // that skip setup in non-interactive mode. The fallback chain below handles
  // that case. RC sourcing still helps for pyenv, conda, and other tools
  // that don't guard on interactivity.
  'case "$SHELL" in'
    + ' */zsh) [ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc" >/dev/null 2>&1 ;;'
    + ' */bash) [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 ;;'
    + ' esac',
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
  // Fallback auto-discovery if the RC file didn't provide a WORKING node.
  //
  // IMPORTANT: use `node -v` (execute), NOT `command -v node` (exists on PATH).
  // On old hosts (e.g. AL2 with glibc 2.26), the node binary may be present
  // but link against newer glibc and crash on startup. An existence check would
  // pass and skip the fallback loop; the caller then `nohup node ...` dies with
  // "GLIBC_2.27 not found" — exactly what bricked clouddev on 2026-05-05.
  //
  // The nvm loop below walks ALL installed node versions (newest first, then
  // older — older nvm versions tend to be statically linked against older glibc
  // so they work on old hosts). `nvm use` + `node -v` confirms both install
  // correctness AND runtime compatibility before we accept that version.
  //
  // Tries nvm > fnm > volta > asdf. All stdout suppressed to avoid JSONL pollution.
  // Use `||` instead of `if !` — zsh non-interactive mode has issues with `if ! cmd`.
  // Ends with `true` to ensure exit code 0 for downstream `&&` chains.
  'node -v >/dev/null 2>&1 || {'
    + ' if [ -s "$HOME/.nvm/nvm.sh" ]; then'
    + '   . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1;'
    + '   node -v >/dev/null 2>&1 || {'
    + '     for v in $(ls -1r "$NVM_DIR/versions/node/" 2>/dev/null); do'
    + '       nvm use --delete-prefix "$v" >/dev/null 2>&1 && node -v >/dev/null 2>&1 && break;'
    + '     done; };'
    + ' elif [ -x "$HOME/.fnm/fnm" ]; then eval "$("$HOME/.fnm/fnm" env)" >/dev/null 2>&1;'
    + ' elif [ -d "$HOME/.volta" ]; then export PATH="$HOME/.volta/bin:$PATH";'
    + ' elif [ -s "$HOME/.asdf/asdf.sh" ]; then . "$HOME/.asdf/asdf.sh" >/dev/null 2>&1;'
    + ' fi;'
    + ' true; }',
].join('; ')

/**
 * Build the full remote preamble: base PATH + optional user shell_setup + env vars.
 *
 * Non-interactive SSH doesn't source .bashrc/.zshrc, so tools like nvm/fnm/volta
 * aren't in PATH. The `shell_setup` config field lets users add custom env setup:
 *
 *   hosts:
 *     mydev:
 *       hostname: dev.example.com
 *       shell_setup: 'source $HOME/.nvm/nvm.sh 2>/dev/null'
 *
 * @param shellSetup — optional shell snippet from config.hosts[].shell_setup
 */
export function buildRemotePreamble(shellSetup?: string): string {
  const parts = [REMOTE_BASE_PATH]
  if (shellSetup) {
    // User's shell_setup runs after base PATH; `|| true` ensures exit 0
    // so downstream && chains are not short-circuited when setup fails.
    // IMPORTANT: Use { ...; } (group command) NOT (...) (subshell).
    // Tools like nvm/fnm modify PATH — subshell changes are lost on exit.
    parts.push(`{ ${shellSetup}; } 2>/dev/null || true`)
  }
  return parts.join('; ')
}

/**
 * Wrap a remote command to run inside the user's login shell.
 *
 * Uses `$SHELL -lc` (login + command). This sources `.zprofile`/`.profile`
 * but NOT `.bashrc`/`.zshrc` (those require interactive mode).
 *
 * We intentionally do NOT use `-i` (interactive) because:
 *   - SSH stdout is our data channel (JSONL stream from remote claude)
 *   - Interactive plugins (iTerm2 shell integration, oh-my-zsh, p10k)
 *     emit escape codes to stdout, corrupting the JSONL stream
 *   - This is an architecture conflict, not a fixable side effect
 *
 * Instead, node/tools are found via:
 *   1. REMOTE_BASE_PATH auto-discovery (nvm > fnm > volta > asdf)
 *   2. User's `shell_setup` config for edge cases
 */
export function wrapInLoginShell(cmd: string, shellSetup?: string): string {
  const parts: string[] = []
  if (shellSetup) {
    // IMPORTANT: Use { ...; } (group command) NOT (...) (subshell).
    // Tools like nvm/fnm modify PATH — subshell changes are lost on exit.
    parts.push(`{ ${shellSetup}; } 2>/dev/null || true`)
  }
  parts.push(cmd)
  const inner = parts.join('; ')
  return `$SHELL -lc ${shellQuote(inner)}`
}

/**
 * Create the appropriate SessionIO implementation.
 * After the transport migration, this always returns LocalIO.
 */
export function createSessionIO(
  tmpId: string,
  _host?: string,
  _sshTarget?: SshTarget,
  outputFileOverride?: string,
): SessionIO {
  return new LocalIO(tmpId, outputFileOverride)
}

// ── Image path detection and transfer ──

/** Image extensions we recognize. */
const IMG_EXT = 'png|jpg|jpeg|gif|webp|bmp|tiff'

/**
 * Unquoted path regex — no spaces allowed (safe default for free text).
 * Matches: /some/path/image.png
 */
const UNQUOTED_IMAGE_RE = new RegExp(`(\\/[\\w./_-]+\\.(?:${IMG_EXT}))\\b`, 'gi')

/**
 * Quoted/backtick path regex — allows spaces in paths.
 * Matches: `/path with spaces/image.png` or "/path with spaces/image.png"
 * or '/path with spaces/image.png'
 * The path must start with / and end with an image extension.
 */
const QUOTED_IMAGE_RE = new RegExp(
  `[\`"'](\\/[\\w./ _-]+\\.(?:${IMG_EXT}))[\`"']`,
  'gi',
)

/**
 * Relative image filename regex — matches bare filenames like `screenshot.png`
 * or relative paths like `subdir/img.png` (NOT starting with /).
 * Boundaries include backtick (Claude Code wraps filenames in backticks).
 */
const RELATIVE_IMAGE_RE = new RegExp(
  `(?:^|[\\s"'\`=:(])` +                           // boundary before
  `((?:[\\w][\\w.-]*/)*[\\w][\\w.-]*\\.(?:${IMG_EXT}))` + // capture: filename
  `(?=[\\s"'\`),;\\]}]|$)`,                         // boundary after (lookahead)
  'gi',
)

/** Options for the image path finders. */
export interface FindImagePathOpts {
  /**
   * Drop matches that touch the very start or end of the text. Used for
   * STREAMING DELTAS: a path split across two deltas ("…/docs/we" |
   * "ekly-trend.png…") makes the fragment at the chunk edge look like a
   * complete standalone path/filename, and rewriting it permanently corrupts
   * the text (observed: "…/week" + "/tmp/open-walnut/images/remote/<sid>/ly-trend.png").
   * Edge matches are left untouched — the turn-end full-text rewrite and the
   * history-replay rewrite (which see complete text) handle them correctly.
   */
  excludeEdges?: boolean
}

/**
 * Find absolute image paths in text, handling both spaced and non-spaced paths.
 *
 * Two-pass detection:
 *   1. Quoted/backtick paths (can contain spaces): `/path with spaces/img.png`
 *   2. Unquoted paths (no spaces, safe default): /path/img.png
 *
 * Returns deduplicated list of paths (without surrounding quotes).
 */
export function findImagePaths(text: string, opts?: FindImagePathOpts): string[] {
  const found = new Set<string>()
  const excludeEdges = opts?.excludeEdges === true

  // Pass 1: paths inside backticks, double quotes, or single quotes (may have spaces)
  let m: RegExpExecArray | null
  QUOTED_IMAGE_RE.lastIndex = 0
  while ((m = QUOTED_IMAGE_RE.exec(text)) !== null) {
    // The match includes both quotes — quote-enclosed paths are complete by
    // construction, but a match flush against the text edges can still be a
    // split-in-half quoted span, so treat whole-match edges as unsafe too.
    if (excludeEdges && (m.index === 0 || m.index + m[0].length === text.length)) continue
    found.add(m[1])
  }

  // Pass 2: unquoted paths (no spaces)
  UNQUOTED_IMAGE_RE.lastIndex = 0
  while ((m = UNQUOTED_IMAGE_RE.exec(text)) !== null) {
    const start = m.index + m[0].indexOf(m[1])
    if (excludeEdges && (start === 0 || start + m[1].length === text.length)) continue
    found.add(m[1])
  }

  return [...found]
}

/**
 * Find relative image filenames in text (e.g. `screenshot.png`, `subdir/img.jpg`).
 * Only returns names that do NOT start with `/` (absolute paths handled separately).
 */
export function findRelativeImageNames(text: string, opts?: FindImagePathOpts): string[] {
  const found = new Set<string>()
  const excludeEdges = opts?.excludeEdges === true
  let m: RegExpExecArray | null
  RELATIVE_IMAGE_RE.lastIndex = 0
  while ((m = RELATIVE_IMAGE_RE.exec(text)) !== null) {
    const p = m[1]
    if (p.startsWith('/')) continue
    // m[0] includes the consumed boundary char (or nothing when anchored at ^).
    const start = m.index + (m[0].length - p.length)
    if (excludeEdges && (start === 0 || start + p.length === text.length)) continue
    found.add(p)
  }
  return [...found]
}

/**
 * Find local image file paths referenced in a text string.
 * Returns deduplicated list of paths that actually exist on the local filesystem.
 */
export function findLocalImagePaths(text: string): string[] {
  return findImagePaths(text).filter((p) => {
    try { return fs.statSync(p).isFile() } catch { return false }
  })
}

// ── Remote image path detection ──

/**
 * Find remote image file paths referenced in a text string.
 * Unlike findLocalImagePaths(), skips the local fs.statSync check
 * (we can't stat remote files). Returns deduplicated path list.
 */
export function findRemoteImagePaths(text: string): string[] {
  return findImagePaths(text)
}

